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
      nodes: [{ id: 'employee', type: 'employee', label: 'Missing', config: { employeeId: 'missing', instruction: 'do', outputMode: 'text' }, position: { x: 0, y: 0 } }],
      edges: [],
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
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining('content-reviewer') }))
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
    expect(generated.workflow.nodes[0]).toMatchObject({ type: 'input', label: '输入' })
    expect(generated.workflow.nodes.at(-1)).toMatchObject({ type: 'output', label: '最终输出' })
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

  it('waits for every connected upstream node and passes named values into a multi-input join', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-multi-input-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-multi-input', name: 'Multi input', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'brief', type: 'input', label: '需求', config: { name: 'brief' }, position: { x: 0, y: 0 } },
        { id: 'research', type: 'input', label: '调研', config: { name: 'research' }, position: { x: 0, y: 80 } },
        { id: 'join', type: 'transform', label: '汇聚', config: { template: 'identity' }, position: { x: 240, y: 40 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 480, y: 40 } },
      ],
      edges: [
        { id: 'brief-join', source: 'brief', target: 'join' },
        { id: 'research-join', source: 'research', target: 'join' },
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
