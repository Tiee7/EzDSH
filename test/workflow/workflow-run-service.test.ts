import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { EmployeeSnapshot } from '../../src/shared/employees.js'
import type { WorkflowDefinition, WorkflowNode, WorkflowOutputMode } from '../../src/shared/workflow.js'

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
  const service = new WorkflowRunService({
    workflowStore,
    runStore: new WorkflowRunStore(dir),
    workspaceRoot: dir,
    createClient: () => ({
      createSession,
      sendPrompt,
      archiveSession,
    }),
    resolveEmployee: options.resolveEmployee ?? (() => undefined),
    lightweightClient: { complete },
    mcpClient: { call: mcpCall },
  })
  return { service, workflowId: workflow.id, sendPrompt, createSession, complete, mcpCall, archiveSession }
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
    expect(sendPrompt).toHaveBeenCalledWith('session-node', expect.stringContaining('只审核内容'))
    expect(sendPrompt).toHaveBeenCalledWith('session-node', expect.stringContaining('事实有依据'))
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledWith('session-node'))
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
    expect(result.events.some((event) => event.type === 'node-completed')).toBe(true)
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
