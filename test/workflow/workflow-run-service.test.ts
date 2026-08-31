import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { EmployeeCreateInput, EmployeeSnapshot } from '../../src/shared/employees.js'
import { validateWorkflow, type WorkflowDefinition, type WorkflowNode, type WorkflowOutputMode } from '../../src/shared/workflow.js'

function graph(): WorkflowDefinition {
  return {
    schemaVersion: 2, id: 'workflow-branch', name: 'Branch', description: '', revision: 1, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: { name: 'task' }, position: { x: 0, y: 0 } },
      { id: 'check', type: 'condition', label: 'Check', config: { operator: 'equals', value: 'yes' }, position: { x: 200, y: 0 } },
      { id: 'yes', type: 'transform', label: 'Yes', config: { template: 'prepend', text: 'accepted: ' }, position: { x: 400, y: -80 } },
      { id: 'no', type: 'transform', label: 'No', config: { template: 'prepend', text: 'rejected: ' }, position: { x: 400, y: 80 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 620, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'check' },
      { id: 'e2', source: 'check', target: 'yes', sourcePort: 'true' },
      { id: 'e3', source: 'check', target: 'no', sourcePort: 'false' },
      { id: 'e4', source: 'yes', target: 'output' },
      { id: 'e5', source: 'no', target: 'output' },
    ],
  }
}

function reviewer(enabled = true): EmployeeSnapshot {
  return {
    schemaVersion: 2,
    version: 1,
    id: 'content-reviewer',
    name: '内容审核员',
    role: '审核专员',
    description: '',
    businessBoundary: '只审核内容，不负责发布',
    systemPrompt: '检查事实',
    operatingGuidelines: ['逐项检查'],
    qualityStandards: ['事实有依据'],
    capabilities: ['research'],
    skillIds: [],
    enabled,
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

async function createNodeService(options: {
  node: WorkflowNode
  responses?: string[]
  resolveEmployee?: (id: string) => EmployeeSnapshot | undefined
}): Promise<{
  service: WorkflowRunService
  workflowId: string
  sendPrompt: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  mcpCall: ReturnType<typeof vi.fn>
  archiveSession: ReturnType<typeof vi.fn>
  selectSessionModel: ReturnType<typeof vi.fn>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-node-'))
  const workflowStore = new WorkflowStore(dir)
  const input: WorkflowNode = { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }
  const output: WorkflowNode = { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } }
  const workflow = await workflowStore.create({
    id: `workflow-${options.node.id}`,
    name: options.node.label,
    description: '',
    nodes: [input, options.node, output],
    edges: [
      { id: 'edge-input', source: input.id, target: options.node.id },
      { id: 'edge-output', source: options.node.id, target: output.id },
    ],
  })
  const responses = [...(options.responses ?? ['完成'])]
  const sendPrompt = vi.fn(async () => ({ text: responses.shift() ?? '' }))
  const createSession = vi.fn(async () => ({ sessionId: 'session-node' }))
  const complete = vi.fn(async () => responses.shift() ?? '')
  const mcpCall = vi.fn(async () => 'mcp-complete')
  const archiveSession = vi.fn(async () => undefined)
  const selectSessionModel = vi.fn(async () => ({ selected: { provider: 'openai-codex', model: 'gpt-5.6-luna' } }))
  const service = new WorkflowRunService({
    workflowStore,
    runStore: new WorkflowRunStore(dir),
    workspaceRoot: dir,
    createClient: () => ({
      createSession,
      sendPrompt,
      archiveSession,
      selectSessionModel,
    }),
    resolveEmployee: options.resolveEmployee ?? (() => undefined),
    lightweightClient: { complete },
    mcpClient: { call: mcpCall },
  })
  return { service, workflowId: workflow.id, sendPrompt, createSession, complete, mcpCall, archiveSession, selectSessionModel }
}

async function eventually(service: WorkflowRunService, runId: string): Promise<NonNullable<ReturnType<WorkflowRunService['get']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = service.get(runId)
    if (record !== undefined && ['completed', 'failed', 'cancelled', 'paused', 'waiting-approval'].includes(record.status)) return record as NonNullable<ReturnType<WorkflowRunService['get']>>
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('run did not finish in time')
}

describe('workflow run service', () => {
  it('treats a numeric input string as equal to the same configured number', async () => {
    const { service, workflowId } = await createNodeService({
      node: { id: 'condition', type: 'condition', label: 'Condition', config: { operator: 'equals', value: 3 }, position: { x: 200, y: 0 } },
    })

    const result = await eventually(service, (await service.start(workflowId, '3')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe(true)
  })

  it('compares numeric input strings with a configured numeric string', async () => {
    const { service, workflowId } = await createNodeService({
      node: { id: 'condition', type: 'condition', label: 'Condition', config: { operator: 'greater-than', value: '3' }, position: { x: 200, y: 0 } },
    })

    const result = await eventually(service, (await service.start(workflowId, '4')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe(true)
  })

  it('executes every parallel instruction and preserves instruction order', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'parallel', type: 'parallel', label: 'Parallel', config: { instructions: ['分析第一项', '分析第二项'] }, position: { x: 200, y: 0 } },
      responses: ['第一项结果', '第二项结果'],
    })

    const result = await eventually(service, (await service.start(workflowId, '输入')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['第一项结果', '第二项结果'])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]?.[0]?.prompt).toContain('分析第一项')
    expect(complete.mock.calls[1]?.[0]?.prompt).toContain('分析第二项')
  })

  it('loops over array items sequentially and respects the iteration cap', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'loop', type: 'loop', label: 'Loop', config: { instruction: '处理当前项', maxIterations: 2 }, position: { x: 200, y: 0 } },
      responses: ['A 结果', 'B 结果'],
    })

    const result = await eventually(service, (await service.start(workflowId, ['A', 'B', 'C'])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['A 结果', 'B 结果'])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]?.[0]?.prompt).toContain('当前循环项："A"')
    expect(complete.mock.calls[1]?.[0]?.prompt).toContain('当前循环项："B"')
  })

  it('uses custom text from the fixed end node as the final output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-custom-output-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-custom-output',
      name: 'Custom output',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { name: 'task' }, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: '结束', config: { contentMode: 'text', text: '流程处理完成' }, position: { x: 240, y: 0 } },
      ],
      edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { task: '输入内容' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('流程处理完成')
  })

  it('interpolates multiple end-node input variables into a custom output template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-output-template-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-output-template',
      name: 'Output template',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { fields: [{ name: 'title' }, { name: 'body' }] }, position: { x: 0, y: 0 } },
        {
          id: 'output',
          type: 'output',
          label: '结束',
          config: { contentMode: 'text', text: '标题：{{title}}\n内容：{{body}}' },
          position: { x: 240, y: 0 },
          inputBindings: [
            { id: 'title-input', name: 'title', sourceNodeId: 'input', sourcePath: 'title', required: true },
            { id: 'body-input', name: 'body', sourceNodeId: 'input', sourcePath: 'body', required: true },
          ],
        },
      ],
      edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { title: '标题', body: '正文' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('标题：标题\n内容：正文')
  })

  it('can reuse a prior node result string in the end-node template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-output-result-template-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-output-result-template',
      name: 'Output result template',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { name: 'task' }, position: { x: 0, y: 0 } },
        { id: 'process', type: 'ai-task', label: '智能处理', config: { instruction: '处理 {{task}}', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 240, y: 0 }, inputBindings: [{ id: 'task-input', name: 'task', sourceNodeId: 'input', required: true }] },
        { id: 'output', type: 'output', label: '结束', config: { contentMode: 'text', text: '再次处理：{{result}}' }, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result-input', name: 'result', sourceNodeId: 'process', required: true }] },
      ],
      edges: [{ id: 'input-process', source: 'input', target: 'process' }, { id: 'process-output', source: 'process', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => 'AI 环节结果' },
    })

    const result = await eventually(service, (await service.start(workflow.id, { task: '原始输入' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('再次处理：AI 环节结果')
  })

  it('forwards multiple explicitly bound variables from the end node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-output-forward-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-output-forward',
      name: 'Output forwarding',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { fields: [{ name: 'title' }, { name: 'body' }] }, position: { x: 0, y: 0 } },
        {
          id: 'output',
          type: 'output',
          label: '结束',
          config: { contentMode: 'variable' },
          position: { x: 240, y: 0 },
          inputBindings: [
            { id: 'title-input', name: 'title', sourceNodeId: 'input', sourcePath: 'title', required: true },
            { id: 'body-input', name: 'body', sourceNodeId: 'input', sourcePath: 'body', required: true },
          ],
        },
      ],
      edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { title: '标题', body: '正文' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '标题', body: '正文' })
  })

  it('executes an employee node with the resolved professional profile', async () => {
    const { service, workflowId, sendPrompt, archiveSession } = await createNodeService({
      node: {
        id: 'employee',
        type: 'employee',
        label: '审核员',
        config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'json' },
        position: { x: 200, y: 0 },
      },
      responses: ['{"decision":"approve","issues":[]}'],
      resolveEmployee: () => reviewer(),
    })

    const result = await eventually(service, (await service.start(workflowId, { script: '内容' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ decision: 'approve', issues: [] })
    expect(result.nodeStates.find((state) => state.nodeId === 'employee')?.input).toEqual({ script: '内容' })
    expect(sendPrompt).toHaveBeenCalledWith('session-node', expect.stringContaining('只审核内容'))
    expect(sendPrompt).toHaveBeenCalledWith('session-node', expect.stringContaining('事实有依据'))
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledWith('session-node'))
  })

  it('applies the selected workflow model to Runtime-backed employee sessions', async () => {
    const { service, workflowId, selectSessionModel } = await createNodeService({
      node: {
        id: 'employee',
        type: 'employee',
        label: '审核员',
        config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'text' },
        position: { x: 200, y: 0 },
      },
      resolveEmployee: () => reviewer(),
    })

    const selection = { providerId: 'openai-codex', modelId: 'gpt-5.6-luna' }
    const result = await eventually(service, (await service.start(workflowId, '内容', { model: selection })).id)

    expect(result.status).toBe('completed')
    expect(selectSessionModel).toHaveBeenCalledWith('session-node', {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
    })
  })

  it('reuses one isolated employee Session only within its workflow run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-employee-session-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-two-employees', name: 'Two employee steps', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'review-one', type: 'employee', label: '审核一', config: { employeeId: 'content-reviewer', instruction: '审核一次', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'review-two', type: 'employee', label: '审核二', config: { employeeId: 'content-reviewer', instruction: '再次审核', outputMode: 'text' }, position: { x: 400, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: 'a', source: 'input', target: 'review-one' }, { id: 'b', source: 'review-one', target: 'review-two' }, { id: 'c', source: 'review-two', target: 'output' },
      ],
    })
    const createSession = vi.fn(async () => ({ sessionId: 'employee-run-session' }))
    const sendPrompt = vi.fn(async () => ({ text: '完成' }))
    const archiveSession = vi.fn(async () => undefined)
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession, sendPrompt, archiveSession }),
      resolveEmployee: () => reviewer(),
      lightweightClient: { complete: async () => 'unused' },
      mcpClient: { call: async () => 'unused' },
    })

    const result = await eventually(service, (await service.start(workflow.id, '脚本')).id)

    expect(result.status).toBe('completed')
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(sendPrompt).toHaveBeenNthCalledWith(1, 'employee-run-session', expect.any(String))
    expect(sendPrompt).toHaveBeenNthCalledWith(2, 'employee-run-session', expect.any(String))
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1))
  })

  it('repairs invalid JSON output with the lightweight path and creates no DSH Session', async () => {
    const outputMode: WorkflowOutputMode = 'json'
    const { service, workflowId, sendPrompt, createSession, complete } = await createNodeService({
      node: {
        id: 'ai-task',
        type: 'ai-task',
        label: '结构化处理',
        config: { instruction: '整理条目', mode: 'single', skillIds: [], outputMode },
        position: { x: 200, y: 0 },
      },
      responses: ['not json', '{"items":[]}'],
    })

    const result = await eventually(service, (await service.start(workflowId, {})).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ items: [] })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(createSession).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('calls MCP with structured arguments and creates no DSH Session', async () => {
    const { service, workflowId, createSession, sendPrompt, mcpCall } = await createNodeService({
      node: {
        id: 'mcp', type: 'mcp', label: '日历',
        config: { tool: 'calendar::create_event', arguments: { title: '{{value}}', task: '{{input}}' } },
        position: { x: 200, y: 0 },
      },
    })

    const result = await eventually(service, (await service.start(workflowId, { topic: '发布' })).id)

    expect(result.status).toBe('completed')
    expect(mcpCall).toHaveBeenCalledWith('calendar::create_event', { title: { topic: '发布' }, task: { topic: '发布' } })
    expect(createSession).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('assigns longer retained history to failed and debug runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-retention-policy-'))
    const workflowStore = new WorkflowStore(dir)
    const completedWorkflow = await workflowStore.create({
      id: 'workflow-retention-completed', name: 'Completed', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'output' }],
    })
    const failedWorkflow = await workflowStore.create({
      id: 'workflow-retention-failed', name: 'Failed', description: '',
      nodes: [
        { id: 'failed-input', type: 'input', label: '开始', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee', type: 'employee', label: 'Missing', config: { employeeId: 'missing', instruction: 'do', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'failed-output', type: 'output', label: '结束', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'failed-input-employee', source: 'failed-input', target: 'employee' },
        { id: 'failed-employee-output', source: 'employee', target: 'failed-output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => 'unused' },
      mcpClient: { call: async () => 'unused' },
    })
    const completed = await eventually(service, (await service.start(completedWorkflow.id, 'ok')).id)
    const debug = await eventually(service, (await service.start(completedWorkflow.id, 'ok', { debug: true })).id)
    const failed = await eventually(service, (await service.start(failedWorkflow.id, 'ok')).id)

    const retainedDays = (record: typeof completed): number => Math.round((new Date(record.retentionExpiresAt ?? '').getTime() - new Date(record.completedAt ?? '').getTime()) / (24 * 60 * 60 * 1_000))
    expect(retainedDays(completed)).toBe(14)
    expect(retainedDays(debug)).toBe(30)
    expect(retainedDays(failed)).toBe(30)
  })

  it('fails clearly when an employee is missing or disabled', async () => {
    const node: WorkflowNode = {
      id: 'employee',
      type: 'employee',
      label: '审核员',
      config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'text' },
      position: { x: 200, y: 0 },
    }
    const missing = await createNodeService({ node })
    const missingResult = await eventually(missing.service, (await missing.service.start(missing.workflowId, {})).id)
    expect(missingResult.status).toBe('failed')
    expect(missingResult.error).toContain('content-reviewer')

    const disabled = await createNodeService({ node, resolveEmployee: () => reviewer(false) })
    const disabledResult = await eventually(disabled.service, (await disabled.service.start(disabled.workflowId, {})).id)
    expect(disabledResult.status).toBe('failed')
    expect(disabledResult.error).toContain('content-reviewer')
  })

  it('includes existing employees in AI workflow generation context and returns an editable draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '生成工作流', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee-node', type: 'employee', label: '内容审核员', config: { employeeId: 'content-reviewer', instruction: '', outputMode: 'text' }, position: { x: 200, y: 0 } },
      ], edges: [],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => reviewer(),
      listEmployees: () => [reviewer()],
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '生成内容审核流程' })

    expect(generated.workflow.nodes.some((node) => node.type === 'employee' && node.config.employeeId === 'content-reviewer')).toBe(true)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('content-reviewer'),
    }))
    const generationPrompt = complete.mock.calls[0]?.[0]?.systemPrompt as string
    expect(generationPrompt).toContain('inputBindings')
    expect(generationPrompt).toContain('多输入默认是 AND')
    expect(generationPrompt).toContain('员工是可复用的专业岗位')
  })

  it('modifies an existing workflow with a dedicated prompt and reports deleted nodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-modify-'))
    const current = graph()
    const modified = {
      ...current,
      nodes: current.nodes.filter((node) => node.id !== 'no'),
      edges: current.edges.filter((edge) => edge.source !== 'no' && edge.target !== 'no'),
    }
    const complete = vi.fn(async () => JSON.stringify(modified))
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      workflowAiDocumentation: '# Workflow rules\n\nKeep the graph acyclic.',
      lightweightClient: { complete },
    })

    const result = await service.modify({ workflow: current, prompt: '删除拒绝分支，保留通过分支。', model: { providerId: 'provider-a', modelId: 'model-a' } })

    expect(result.workflow.nodes.some((node) => node.id === 'no')).toBe(false)
    expect(result.removedNodes).toEqual([{ id: 'no', label: 'No' }])
    expect(result.changes.some((change) => change.type === 'removed' && change.targetId === 'no')).toBe(true)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: { providerId: 'provider-a', modelId: 'model-a' }, systemPrompt: expect.stringContaining('Workflow rules') }))
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('删除节点是高风险修改')
  })

  it('accepts a runtime-generated workflow with multiple declared input variables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-runtime-shape-'))
    const workflowStore = new WorkflowStore(dir)
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ employees: [] }))
      .mockResolvedValueOnce(JSON.stringify({
        schemaVersion: 2,
        id: 'short-video-topic-planning',
        name: '短视频选题策划工作流',
        description: '根据账号定位和目标受众生成短视频选题。',
        revision: 1,
        enabled: true,
        nodes: [
          { id: 'input-1', type: 'input', label: '启动输入', config: { fields: [{ name: 'account_position', required: true }, { name: 'target_audience', required: true }] }, position: { x: 80, y: 180 }, inputBindings: [], outputVariables: [{ name: 'account_position' }, { name: 'target_audience' }] },
          { id: 'planner-1', type: 'ai-task', label: '生成候选选题', config: { instruction: '根据 {{account_position}} 和 {{target_audience}} 生成选题。', mode: 'single', skillIds: [], outputMode: 'json' }, position: { x: 360, y: 180 }, inputBindings: [
            { id: 'bind-position', name: 'account_position', sourceNodeId: 'input-1', sourcePath: 'account_position', required: true },
            { id: 'bind-audience', name: 'target_audience', sourceNodeId: 'input-1', sourcePath: 'target_audience', required: true },
          ], outputVariables: [{ name: 'topics' }] },
          { id: 'output-1', type: 'output', label: '输出选题', config: { outputMode: 'json' }, position: { x: 640, y: 180 }, inputBindings: [{ id: 'bind-topics', name: 'topics', sourceNodeId: 'planner-1', sourcePath: 'topics', required: true }] },
        ],
        edges: [
          { id: 'edge-input-planner', source: 'input-1', target: 'planner-1' },
          { id: 'edge-planner-output', source: 'planner-1', target: 'output-1' },
        ],
      }))
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      createEmployee: async () => { throw new Error('should not create an employee') },
      lightweightClient: { complete },
    })

    await expect(service.generate({ prompt: '生成一个短视频选题的工作流。', name: '生成一个短视频选题的工作流。' })).resolves.toMatchObject({
      workflow: { nodes: expect.arrayContaining([expect.objectContaining({ id: 'planner-1', type: 'ai-task' })]) },
      createdEmployees: [],
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('plans and creates missing employees before generating the workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-employees-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const createEmployee = vi.fn(async (input: EmployeeCreateInput) => ({
      schemaVersion: 2,
      version: 1,
      id: `employee-${input.name}`,
      name: input.name,
      role: input.role,
      description: input.description,
      businessBoundary: input.businessBoundary,
      systemPrompt: input.systemPrompt,
      operatingGuidelines: input.operatingGuidelines,
      qualityStandards: input.qualityStandards,
      capabilities: input.capabilities,
      skillIds: input.skillIds,
      enabled: true,
      builtIn: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ employees: [{ name: '财务分析师', role: '分析师', systemPrompt: '分析财务数据并给出建议', capabilities: ['research'] }] }))
      .mockResolvedValueOnce(JSON.stringify({
        name: '分析工作流', description: '', nodes: [
          { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
          { id: 'employee-node', type: 'employee', label: '财务分析师', config: { employeeId: 'employee-财务分析师', instruction: '分析财报', outputMode: 'text' }, position: { x: 200, y: 0 } },
        ], edges: [],
      }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      createEmployee,
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '为上市公司生成财务分析工作流' })

    expect(createEmployee).toHaveBeenCalledTimes(1)
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ name: '财务分析师', role: '分析师' }))
    expect(generated.createdEmployees).toHaveLength(1)
    expect(generated.createdEmployees[0]?.id).toBe('employee-财务分析师')
    expect(generated.workflow.nodes.some((node) => node.type === 'employee' && node.config.employeeId === 'employee-财务分析师')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('keeps generating the workflow when employee creation is not wired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-no-create-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '简单工作流', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'ai-task', type: 'ai-task', label: '处理', config: { instruction: '总结输入', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 400, y: 0 } },
      ], edges: [],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '简单总结任务' })

    expect(generated.createdEmployees).toHaveLength(0)
    expect(generated.workflow.nodes.some((node) => node.type === 'ai-task')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('repairs an incomplete AI graph into a valid, connected, laid-out draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-repair-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '公司分析', description: '', nodes: [
        { id: 'identify-company', type: 'employee', label: '识别企业', config: { employeeId: '', instruction: '', outputMode: 'text' }, position: { x: 0, y: 0 } },
        { id: 'status-condition', type: 'condition', label: '是否上市', config: { operator: 'is-public' }, position: { x: 0, y: 0 } },
        { id: 'public-analysis', type: 'employee', label: '上市公司财务分析', config: { employeeId: 'made-up-analyst', instruction: '', outputMode: 'text' }, position: { x: 0, y: 0 } },
      ], edges: [],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '分析一家企业' })

    expect(validateWorkflow(generated.workflow)).toEqual({ valid: true, issues: [] })
    expect(generated.workflow.nodes[0]).toMatchObject({ type: 'input', label: '开始' })
    expect(generated.workflow.nodes.at(-1)).toMatchObject({ type: 'output', label: '结束', config: { contentMode: 'variable' } })
    expect(generated.workflow.nodes.filter((node) => node.type === 'employee')).toHaveLength(0)
    expect(generated.workflow.nodes.find((node) => node.id === 'status-condition')).toMatchObject({ config: { operator: 'truthy' } })
    expect(generated.workflow.edges).toHaveLength(generated.workflow.nodes.length - 1)
    expect(new Set(generated.workflow.nodes.map((node) => `${node.position.x},${node.position.y}`)).size).toBe(generated.workflow.nodes.length)
  })

  it('adds explicit true and false ports to AI-generated condition exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-condition-ports-'))
    const workflowStore = new WorkflowStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '企业分析', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'listed', type: 'condition', label: '是否上市', config: { operator: 'truthy' }, position: { x: 200, y: 0 } },
        { id: 'public', type: 'ai-task', label: '上市分析', config: { instruction: '分析上市公司', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: -80 } },
        { id: 'private', type: 'ai-task', label: '未上市分析', config: { instruction: '分析未上市公司', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: 80 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: 'input-listed', source: 'input', target: 'listed' },
        { id: 'listed-public', source: 'listed', target: 'public' },
        { id: 'listed-private', source: 'listed', target: 'private' },
        { id: 'public-output', source: 'public', target: 'output' },
        { id: 'private-output', source: 'private', target: 'output' },
      ],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '为企业生成分析流程' })

    expect(generated.workflow.edges.filter((edge) => edge.source === 'listed').map((edge) => edge.sourcePort)).toEqual(['true', 'false'])
  })

  it('executes a condition branch and checkpoints each node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-run-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create(graph())
    const runStore = new WorkflowRunStore(dir)
    const service = new WorkflowRunService({
      workflowStore, runStore, workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    await service.initialize()
    const initial = await service.start(workflow.id, 'yes')
    const result = await eventually(service, initial.id)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('accepted: true')
    expect(result.nodeStates.find((state) => state.nodeId === 'no')?.status).toBe('skipped')
    expect(result.nodeStates.every((state) => typeof state.elapsedMs === 'number')).toBe(true)
    expect(result.events.some((event) => event.type === 'node-completed')).toBe(true)
  })

  it('deletes completed run history and rejects active run deletion', async () => {
    const { service, workflowId } = await createNodeService({ node: { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'identity' }, position: { x: 200, y: 0 } } })
    const completed = await eventually(service, (await service.start(workflowId, 'delete me')).id)

    await service.remove(completed.id)
    expect(service.get(completed.id)).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-active-delete-'))
    const workflowStore = new WorkflowStore(dir)
    await workflowStore.create(graph())
    const runStore = new WorkflowRunStore(dir)
    const activeService = new WorkflowRunService({ workflowStore, runStore, workspaceRoot: dir, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
    await activeService.initialize()
    await runStore.save({ id: 'run-active', workflowId: 'workflow-branch', workflowRevision: 1, status: 'running', input: null, nodeStates: [], events: [], allowShellFile: false })

    await expect(activeService.remove('run-active')).rejects.toThrow('不能删除')
  })

  it('treats legacy condition exits without a port as one exclusive true/false pair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-legacy-condition-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(),
      id: 'workflow-legacy-condition',
      edges: graph().edges.map((edge) => edge.source === 'check' ? { ...edge, sourcePort: undefined } : edge),
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, 'yes')).id)

    expect(result.status).toBe('completed')
    expect(result.nodeStates.find((state) => state.nodeId === 'yes')?.status).toBe('completed')
    expect(result.nodeStates.find((state) => state.nodeId === 'no')?.status).toBe('skipped')
  })

  it('runs independent ready branches concurrently and waits for their join', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-concurrent-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-concurrent', name: 'Concurrent', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'research', type: 'ai-task', label: 'Research', config: { instruction: 'research', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 240, y: -80 } },
        { id: 'risk', type: 'ai-task', label: 'Risk', config: { instruction: 'risk', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 240, y: 80 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: 'input-research', source: 'input', target: 'research' },
        { id: 'input-risk', source: 'input', target: 'risk' },
        { id: 'research-output', source: 'research', target: 'output', targetPort: 'research' },
        { id: 'risk-output', source: 'risk', target: 'output', targetPort: 'risk' },
      ],
    })
    let activeCalls = 0
    let maxActiveCalls = 0
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: {
        complete: async ({ prompt }) => {
          activeCalls += 1
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
          await new Promise((resolve) => setTimeout(resolve, 25))
          activeCalls -= 1
          return prompt.includes('research') ? 'research-result' : 'risk-result'
        },
      },
    })

    const result = await eventually(service, (await service.start(workflow.id, 'brief')).id)

    expect(result.status).toBe('completed')
    expect(maxActiveCalls).toBe(2)
    expect(result.output).toEqual({ research: 'research-result', risk: 'risk-result' })
  })

  it('passes named values from structured start input into a multi-input join', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-multi-input-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-multi-input', name: 'Multi input', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'brief', label: '需求', required: true }, { name: 'research', label: '调研', required: true }] }, position: { x: 0, y: 0 } },
        { id: 'join', type: 'transform', label: '汇聚', config: { template: 'identity' }, position: { x: 240, y: 40 }, inputBindings: [
          { id: 'brief-input', name: 'brief', sourceNodeId: 'start', sourcePath: 'brief', required: true },
          { id: 'research-input', name: 'research', sourceNodeId: 'start', sourcePath: 'research', required: true },
        ] },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 480, y: 40 } },
      ],
      edges: [
        { id: 'start-join', source: 'start', target: 'join' },
        { id: 'join-output', source: 'join', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { brief: '内容需求', research: '调研结论' })).id)

    expect(result.status).toBe('completed')
    expect(result.nodeStates.find((state) => state.nodeId === 'join')?.input).toEqual({ brief: '内容需求', research: '调研结论' })
    expect(result.output).toEqual({ brief: '内容需求', research: '调研结论' })
  })

  it('binds named variables from selected node outputs and interpolates only those variables into a prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-variable-bindings-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-variable-bindings', name: 'Variable bindings', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'topic', type: 'input', label: '主题', config: { name: 'topic' }, position: { x: 0, y: 0 } },
        { id: 'research', type: 'ai-task', label: '调研', config: { instruction: '研究 {{topic}}', mode: 'single', skillIds: [], outputMode: 'json' }, position: { x: 220, y: -70 }, inputBindings: [{ id: 'topic-input', name: 'topic', sourceNodeId: 'topic', required: true }], outputVariables: [{ name: 'summary' }, { name: 'sources' }] },
        { id: 'outline', type: 'ai-task', label: '提纲', config: { instruction: '为 {{topic}} 制作提纲', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 220, y: 70 }, inputBindings: [{ id: 'topic-input', name: 'topic', sourceNodeId: 'topic', required: true }] },
        { id: 'writer', type: 'ai-task', label: '写作', config: { instruction: '主题：{{topic}}\n调研：{{research}}\n提纲：{{outline}}\n忽略：{{notSelected}}', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 480, y: 0 }, inputBindings: [
          { id: 'topic-input', name: 'topic', sourceNodeId: 'topic', required: true },
          { id: 'research-input', name: 'research', sourceNodeId: 'research', sourcePath: 'summary', required: true },
          { id: 'outline-input', name: 'outline', sourceNodeId: 'outline', required: true },
        ] },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 720, y: 0 }, inputBindings: [{ id: 'result-input', name: 'result', sourceNodeId: 'writer', required: true }] },
      ],
      edges: [
        { id: 'topic-research', source: 'topic', target: 'research' },
        { id: 'topic-outline', source: 'topic', target: 'outline' },
        { id: 'research-writer', source: 'research', target: 'writer' },
        { id: 'outline-writer', source: 'outline', target: 'writer' },
        { id: 'writer-output', source: 'writer', target: 'output' },
      ],
    } as unknown as WorkflowDefinition)
    const complete = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes('节点名称：调研')) return '{"summary":"可验证的调研结论","sources":["资料 A"]}'
      if (prompt.includes('节点名称：提纲')) return '三段式提纲'
      if (prompt.includes('节点名称：写作')) return '完整文稿'
      return ''
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const result = await eventually(service, (await service.start(workflow.id, { topic: '火箭发布' })).id)
    const writerPrompt = complete.mock.calls.map(([request]) => request.prompt as string).find((prompt) => prompt.includes('节点名称：写作'))

    expect(result.status).toBe('completed')
    expect(result.output).toBe('完整文稿')
    expect(result.nodeStates.find((state) => state.nodeId === 'writer')?.input).toEqual({ topic: '火箭发布', research: '可验证的调研结论', outline: '三段式提纲' })
    expect(writerPrompt).toContain('主题：火箭发布')
    expect(writerPrompt).toContain('调研：可验证的调研结论')
    expect(writerPrompt).toContain('提纲：三段式提纲')
    expect(writerPrompt).toContain('忽略：{{notSelected}}')
  })

  it('treats an explicit variable source as a dependency even without a visual edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-variable-dependency-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-variable-dependency', name: 'Variable dependency', description: '',
      nodes: [
        { id: 'input', type: 'input', label: '主题', config: { name: 'topic' }, position: { x: 0, y: 0 } },
        { id: 'writer', type: 'ai-task', label: '写作', config: { instruction: '围绕 {{topic}} 写作', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 300, y: 0 }, inputBindings: [{ id: 'topic', name: 'topic', sourceNodeId: 'input', required: true }] },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 600, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'writer', required: true }] },
      ],
      // The edge controls only the final display path. `input → writer` comes from the binding above.
      edges: [{ id: 'writer-output', source: 'writer', target: 'output' }],
    })
    const complete = vi.fn(async ({ prompt }: { prompt: string }) => prompt.includes('节点名称：写作') ? '成文结果' : '')
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const result = await eventually(service, (await service.start(workflow.id, { topic: '显式依赖' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('成文结果')
    expect(result.nodeStates.find((state) => state.nodeId === 'writer')?.input).toEqual({ topic: '显式依赖' })
  })

  it('requires explicit authorization for Shell and File nodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-security-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(), id: 'workflow-shell', name: 'Shell',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'shell', type: 'shell', label: 'Shell', config: { command: 'echo', args: ['{{value}}'] }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'shell' }, { id: 'b', source: 'shell', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    const initial = await service.start(workflow.id, 'hello')
    const result = await eventually(service, initial.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('显式授权')
    const authorized = await service.start(workflow.id, 'hello', { allowShellFile: true })
    expect((await eventually(service, authorized.id)).status).toBe('completed')
  })

  it('pauses for approval and continues after approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-approval-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(), id: 'workflow-approval', name: 'Approval',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'approval', type: 'approval', label: 'Approve', config: { message: 'Confirm' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'approval' }, { id: 'b', source: 'approval', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    const initial = await service.start(workflow.id, 'hello')
    const waiting = await eventually(service, initial.id)
    expect(waiting.status).toBe('waiting-approval')
    expect(waiting.waitingApprovalNodeId).toBe('approval')
    await service.approve(initial.id, true)
    expect((await eventually(service, initial.id)).status).toBe('completed')
  })
})
