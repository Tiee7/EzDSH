import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { EmployeeCreateInput, EmployeeSnapshot } from '../../src/shared/employees.js'
import { validateWorkflow, type WorkflowDefinition, type WorkflowNode, type WorkflowOutputMode, type WorkflowRunRecord } from '../../src/shared/workflow.js'

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
  executeSubWorkflow?: (workflowId: string, input: any, waitForCompletion: boolean) => Promise<any>
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
    workflowRoot: dir,
    createClient: () => ({
      createSession,
      sendPrompt,
      archiveSession,
      selectSessionModel,
    }),
    resolveEmployee: options.resolveEmployee ?? (() => undefined),
    lightweightClient: { complete },
    mcpClient: { call: mcpCall },
    executeSubWorkflow: options.executeSubWorkflow,
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

  it('enforces an AI task output schema before completing', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: {
        id: 'ai-schema', type: 'ai-task', label: 'Structured AI',
        config: {
          instruction: '提取标题', mode: 'single', skillIds: [], outputMode: 'json',
          outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        }, position: { x: 200, y: 0 },
      },
      responses: ['{"wrong":true}', '{"title":"正确"}'],
    })

    const result = await eventually(service, (await service.start(workflowId, '输入')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '正确' })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('rejects additional properties when an AI output schema is strict', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'ai-strict-schema', type: 'ai-task', label: 'Strict AI', config: { instruction: '输出标题', mode: 'single', skillIds: [], outputMode: 'json', outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }, position: { x: 200, y: 0 } },
      responses: ['{"title":"对","extra":true}', '{"title":"修复"}'],
    })
    const result = await eventually(service, (await service.start(workflowId, '输入')).id)
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '修复' })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('runs a standalone structured extract node with schema retries', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'extract', type: 'structured-extract', label: 'Extract', config: { schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, maxRetries: 2 }, position: { x: 200, y: 0 } },
      responses: ['{"title":3}', '{"title":"标题"}'],
    })
    const result = await eventually(service, (await service.start(workflowId, '原文')).id)
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '标题' })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('runs a selected sub-workflow and returns its output', async () => {
    const executeSubWorkflow = vi.fn(async (workflowId: string, input: unknown, waitForCompletion: boolean) => ({ workflowId, input, waitForCompletion, result: 'child-output' }))
    const { service, workflowId } = await createNodeService({
      node: { id: 'sub', type: 'sub-workflow', label: 'Sub workflow', config: { workflowId: 'child-workflow', waitForCompletion: true }, position: { x: 200, y: 0 } },
      executeSubWorkflow,
    })
    const result = await eventually(service, (await service.start(workflowId, 'hello')).id)
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ workflowId: 'child-workflow', input: 'hello', waitForCompletion: true, result: 'child-output' })
    expect(executeSubWorkflow).toHaveBeenCalledWith('child-workflow', 'hello', true, undefined, { allowShellFile: false, allowCode: false })
  })

  it('builds objects, filters lists, and merges inputs deterministically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-data-nodes-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-data-nodes', name: 'Data nodes', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'object', type: 'object-builder', label: 'Object', config: { fields: { title: '{{value}}', items: '{{value}}', nested: { ok: true } } }, position: { x: 200, y: 0 } },
        { id: 'list', type: 'list-operator', label: 'List', config: { operation: 'filter', path: 'ok', value: true }, position: { x: 400, y: 0 }, inputBindings: [{ id: 'items', name: 'items', sourceNodeId: 'object', sourcePath: 'items', required: true }] },
        { id: 'merge', type: 'merge', label: 'Merge', config: { operation: 'append' }, position: { x: 600, y: 0 }, inputBindings: [
          { id: 'left', name: 'left', sourceNodeId: 'object', required: true },
          { id: 'right', name: 'right', sourceNodeId: 'list', required: true },
        ] },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 800, y: 0 } },
      ],
      edges: [
        { id: 'a', source: 'input', target: 'object' },
        { id: 'b', source: 'object', target: 'list' },
        { id: 'c', source: 'list', target: 'merge' },
        { id: 'd', source: 'object', target: 'merge' },
        { id: 'e', source: 'merge', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, [{ ok: true }, { ok: false }])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual([
      { title: [{ ok: true }, { ok: false }], items: [{ ok: true }, { ok: false }], nested: { ok: true } },
      { ok: true },
    ])
  })

  it('supports list projection, grouping, and numeric aggregation', async () => {
    const { service, workflowId } = await createNodeService({
      node: { id: 'list-full', type: 'list-operator', label: 'List full', config: { operation: 'aggregate', aggregateMode: 'sum', aggregatePath: 'amount' }, position: { x: 200, y: 0 } },
    })
    const result = await eventually(service, (await service.start(workflowId, [{ amount: 2 }, { amount: 3 }])).id)
    expect(result.status).toBe('completed')
    expect(result.output).toBe(5)
  })

  it('supports directory listing and file metadata operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-file-'))
    await mkdir(join(dir, 'docs'))
    await writeFile(join(dir, 'docs', 'note.txt'), 'hello', 'utf8')
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-file-ops', name: 'File operations', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'file', type: 'file', label: 'File', config: { operation: 'list', path: 'docs', recursive: true }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'file' }, { id: 'b', source: 'file', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, null, { allowShellFile: true })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual([
      { path: 'docs', type: 'directory', size: 0 },
      { path: 'docs/note.txt', type: 'file', size: 5 },
    ])
  })

  it('uses the dedicated workflow root for file nodes instead of state storage', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-state-'))
    const workflowDir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-root-'))
    const workflowStore = new WorkflowStore(stateDir)
    const workflow = await workflowStore.create({
      id: 'workflow-file-root', name: 'File root', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'file', type: 'file', label: 'File', config: { operation: 'write', path: 'result.txt', content: 'from workflow root' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'file' }, { id: 'b', source: 'file', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(stateDir), workflowRoot: workflowDir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, null, { allowShellFile: true })).id)

    expect(result.status).toBe('completed')
    await expect(readFile(join(workflowDir, 'result.txt'), 'utf8')).resolves.toBe('from workflow root')
    await expect(readFile(join(stateDir, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for a sleep node duration and forwards its input unchanged', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'sleep', type: 'sleep', label: 'Sleep', config: { durationMs: 20 }, position: { x: 200, y: 0 } },
    })
    const startedAt = Date.now()

    const result = await eventually(service, (await service.start(workflowId, 'wake')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('wake')
    expect(result.nodeStates.find((state) => state.nodeId === 'sleep')?.elapsedMs).toBeGreaterThanOrEqual(15)
    expect(complete).not.toHaveBeenCalled()
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15)
  })

  it('samples a new random sleep duration on every execution', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999999)
    try {
      const { service, workflowId } = await createNodeService({
        node: { id: 'sleep-random', type: 'sleep', label: 'Random sleep', config: { durationMs: 0, mode: 'random', minDurationMs: 0, maxDurationMs: 1 } as never, position: { x: 200, y: 0 } },
      })

      await eventually(service, (await service.start(workflowId, 'first')).id)
      await eventually(service, (await service.start(workflowId, 'second')).id)

      expect(random).toHaveBeenCalledTimes(2)
    } finally {
      random.mockRestore()
    }
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

  it('passes each loop item through the body node and forwards collected results to the next edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-loop-body-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-loop-body', name: 'Loop body', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10 }, position: { x: 240, y: 0 } },
        { id: 'body', type: 'transform', label: 'Body', config: { template: 'append', text: '!' }, position: { x: 240, y: 180 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 520, y: 0 } },
      ],
      edges: [
        { id: 'input-loop', source: 'input', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'body', sourcePort: 'loop-body' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, ['A', 'B'])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['A!', 'B!'])
  })

  it('binds each loop item to the body node so deterministic templates can use item fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-loop-body-binding-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-loop-body-binding', name: 'Loop body binding', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10 }, position: { x: 240, y: 0 } },
        {
          id: 'body', type: 'transform', label: 'Body', config: { template: 'text', text: '姓名：{{name}}' }, position: { x: 240, y: 180 },
          inputBindings: [{ id: 'item-name', name: 'name', sourceNodeId: 'loop', sourcePath: 'name', required: true }],
        },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 520, y: 0 } },
      ],
      edges: [
        { id: 'input-loop', source: 'input', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'body', sourcePort: 'loop-body' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, [{ name: '甲' }, { name: '乙' }])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['姓名：甲', '姓名：乙'])
  })

  it('runs a linear loop body chain before collecting the terminal body result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-loop-chain-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-loop-chain', name: 'Loop chain', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10 }, position: { x: 240, y: 0 } },
        { id: 'sleep', type: 'sleep', label: 'Sleep', config: { durationMs: 20 }, position: { x: 240, y: 180 } },
        { id: 'format', type: 'transform', label: 'String', config: { template: 'text', text: '当前是第{{value}}个' }, position: { x: 520, y: 180 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 760, y: 0 } },
      ],
      edges: [
        { id: 'input-loop', source: 'input', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'sleep', sourcePort: 'loop-body' },
        { id: 'sleep-format', source: 'sleep', target: 'format' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    let formatCompletedOnce = false
    let observedSecondIteration: WorkflowRunRecord | undefined
    const stopWatching = service.watch((record) => {
      const sleep = record.nodeStates.find((state) => state.nodeId === 'sleep')
      const format = record.nodeStates.find((state) => state.nodeId === 'format')
      if (format?.status === 'completed') formatCompletedOnce = true
      if (formatCompletedOnce && sleep?.status === 'running' && format?.status === 'pending') observedSecondIteration = record
    })
    const result = await eventually(service, (await service.start(workflow.id, [1, 2])).id)
    stopWatching()

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['当前是第1个', '当前是第2个'])
    expect(observedSecondIteration).toBeDefined()
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
      workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore, workflowRoot: dir,
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

  it('loads workflow documentation at generation time without truncating the generation context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-docs-'))
    const complete = vi.fn(async () => JSON.stringify({
      name: '文档读取测试', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 200, y: 0 } },
      ], edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    }))
    let loads = 0
    const documentation = `${'规则 '.repeat(30_005)}文档尾部仍然必须被读取`
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      loadWorkflowAiDocumentation: async () => {
        loads += 1
        return documentation
      },
      lightweightClient: { complete },
    })

    expect(loads).toBe(0)
    await service.generate({ prompt: '生成一个简单工作流' })

    expect(loads).toBe(1)
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('文档尾部仍然必须被读取')
  })

  it('prefilters a large employee catalog and sends full profiles only for selected employees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-employee-selection-'))
    const employees = Array.from({ length: 13 }, (_, index) => ({ ...reviewer(), id: `employee-${index}`, name: `员工${index}` }))
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ employeeIds: ['employee-7'], reason: '匹配研究职责', missingRoles: [] }))
      .mockResolvedValueOnce(JSON.stringify({
        name: '员工筛选工作流', description: '', nodes: [
          { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
          { id: 'employee-node', type: 'employee', label: '员工7', config: { employeeId: 'employee-7', instruction: '完成研究', outputMode: 'text' }, position: { x: 200, y: 0 } },
          { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 400, y: 0 } },
        ], edges: [
          { id: 'input-employee', source: 'input', target: 'employee-node' },
          { id: 'employee-output', source: 'employee-node', target: 'output' },
        ],
      }))
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: (id) => employees.find((employee) => employee.id === id),
      listEmployees: () => employees,
      lightweightClient: { complete },
    })

    await service.generate({ prompt: '生成一个研究工作流' })

    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('employee-0')
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('employee-12')
    expect(complete.mock.calls[1]?.[0]?.systemPrompt).toContain('employee-7')
    expect(complete.mock.calls[1]?.[0]?.systemPrompt).toContain('检查事实')
    expect(complete.mock.calls[1]?.[0]?.systemPrompt).not.toContain('员工0')
  })

  it('modifies an existing workflow with a dedicated prompt and reports deleted nodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-modify-'))
    const current = { ...graph(), generationPrompt: '生成一个条件分支工作流' }
    const modified = {
      ...current,
      nodes: current.nodes.filter((node) => node.id !== 'no'),
      edges: current.edges.filter((edge) => edge.source !== 'no' && edge.target !== 'no'),
    }
    const complete = vi.fn(async () => JSON.stringify(modified))
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      workflowAiDocumentation: '# Workflow rules\n\nKeep the graph acyclic.',
      lightweightClient: { complete },
    })

    const result = await service.modify({ workflow: current, prompt: '删除拒绝分支，保留通过分支。', model: { providerId: 'provider-a', modelId: 'model-a' } })

    expect(result.workflow.nodes.some((node) => node.id === 'no')).toBe(false)
    expect(result.workflow.generationPrompt).toBe('生成一个条件分支工作流')
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
      workflowRoot: dir,
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
      workflowStore, runStore, workflowRoot: dir,
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
      workflowStore, runStore, workflowRoot: dir,
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
      workflowStore, runStore, workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore, workflowRoot: dir,
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

  it('executes only the matching switch branch and falls back to default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-switch-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-switch', name: 'Switch', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'route', type: 'switch', label: 'Route', config: { cases: [{ id: 'urgent', label: 'Urgent', value: 'urgent' }, { id: 'normal', label: 'Normal', value: 'normal' }] }, position: { x: 220, y: 0 } },
        { id: 'urgent', type: 'transform', label: 'Urgent', config: { template: 'prepend', text: 'urgent: ' }, position: { x: 440, y: -100 } },
        { id: 'normal', type: 'transform', label: 'Normal', config: { template: 'prepend', text: 'normal: ' }, position: { x: 440, y: 0 } },
        { id: 'fallback', type: 'transform', label: 'Fallback', config: { template: 'prepend', text: 'fallback: ' }, position: { x: 440, y: 100 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 680, y: 0 } },
      ],
      edges: [
        { id: 'input-route', source: 'input', target: 'route' },
        { id: 'route-urgent', source: 'route', target: 'urgent', sourcePort: 'switch:urgent' },
        { id: 'route-normal', source: 'route', target: 'normal', sourcePort: 'switch:normal' },
        { id: 'route-default', source: 'route', target: 'fallback', sourcePort: 'default' },
        { id: 'urgent-output', source: 'urgent', target: 'output' },
        { id: 'normal-output', source: 'normal', target: 'output' },
        { id: 'fallback-output', source: 'fallback', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const normal = await eventually(service, (await service.start(workflow.id, 'normal')).id)
    expect(normal.status).toBe('completed')
    expect(normal.output).toBe('normal: normal')
    expect(normal.nodeStates.find((state) => state.nodeId === 'urgent')?.status).toBe('skipped')
    expect(normal.nodeStates.find((state) => state.nodeId === 'fallback')?.status).toBe('skipped')

    const fallback = await eventually(service, (await service.start(workflow.id, 'other')).id)
    expect(fallback.status).toBe('completed')
    expect(fallback.output).toBe('fallback: other')
    expect(fallback.nodeStates.find((state) => state.nodeId === 'urgent')?.status).toBe('skipped')
    expect(fallback.nodeStates.find((state) => state.nodeId === 'normal')?.status).toBe('skipped')
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
    const activeService = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
    await activeService.initialize()
    await runStore.save({ id: 'run-active', workflowId: 'workflow-branch', workflowRevision: 1, status: 'running', input: null, nodeStates: [], events: [], allowShellFile: false })

    await expect(activeService.remove('run-active')).rejects.toThrow('不能删除')
  })

  it('deletes a workflow only after confirming it has no active run records', async () => {
    const { service, workflowId } = await createNodeService({ node: { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'identity' }, position: { x: 200, y: 0 } } })
    const completed = await eventually(service, (await service.start(workflowId, 'delete with workflow')).id)

    expect(await service.removeForWorkflow(workflowId)).toBe(1)
    expect(service.get(completed.id)).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-active-delete-workflow-'))
    const workflowStore = new WorkflowStore(dir)
    await workflowStore.create(graph())
    const runStore = new WorkflowRunStore(dir)
    const activeService = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
    await activeService.initialize()
    await runStore.save({ id: 'run-active-workflow', workflowId: 'workflow-branch', workflowRevision: 1, status: 'running', input: null, nodeStates: [], events: [], allowShellFile: false })

    await expect(activeService.removeForWorkflow('workflow-branch')).rejects.toThrow('运行中的记录')
    expect(runStore.get('run-active-workflow')).toBeDefined()
  })

  it('replaces text and interpolates bound variables in the transform node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-transform-replace-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-transform-replace', name: 'Transform replace', description: '',
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'text' }, { name: 'replacement' }] }, position: { x: 0, y: 0 } },
        {
          id: 'replace', type: 'transform', label: '替换', config: { template: 'replace', find: 'world', replacement: '{{replacement}}' } as never,
          position: { x: 240, y: 0 }, inputBindings: [
            { id: 'text-input', name: 'text', sourceNodeId: 'start', sourcePath: 'text', required: true },
            { id: 'replacement-input', name: 'replacement', sourceNodeId: 'start', sourcePath: 'replacement', required: true },
          ],
        },
        { id: 'output', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'replace', required: true }] },
      ],
      edges: [{ id: 'start-replace', source: 'start', target: 'replace' }, { id: 'replace-output', source: 'replace', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { text: 'hello world', replacement: 'there' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('hello there')
  })

  it('renders a new text from bound variables with the transform text template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-transform-text-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-transform-text', name: 'Transform text', description: '',
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'diagnosis' }, { name: 'patient' }] }, position: { x: 0, y: 0 } },
        {
          id: 'rewrite', type: 'transform', label: '重写诊断', config: { template: 'text', text: '患者：{{patient}}。新的诊断：{{diagnosis}}' } as never,
          position: { x: 240, y: 0 }, inputBindings: [
            { id: 'diagnosis-input', name: 'diagnosis', sourceNodeId: 'start', sourcePath: 'diagnosis', required: true },
            { id: 'patient-input', name: 'patient', sourceNodeId: 'start', sourcePath: 'patient', required: true },
          ],
        },
        { id: 'output', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'rewrite', required: true }] },
      ],
      edges: [{ id: 'start-rewrite', source: 'start', target: 'rewrite' }, { id: 'rewrite-output', source: 'rewrite', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { diagnosis: '原诊断', patient: '张三' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('患者：张三。新的诊断：原诊断')
  })

  it('merges multiple bound text values with a text-merge node template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-text-merge-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-text-merge', name: 'Text merge', description: '',
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'title' }, { name: 'body' }] }, position: { x: 0, y: 0 } },
        {
          id: 'merge', type: 'text-merge' as never, label: '文本合并', config: { template: '标题：{{title}}\\n正文：{{body}}' } as never,
          position: { x: 240, y: 0 }, inputBindings: [
            { id: 'title-input', name: 'title', sourceNodeId: 'start', sourcePath: 'title', required: true },
            { id: 'body-input', name: 'body', sourceNodeId: 'start', sourcePath: 'body', required: true },
          ],
        } as never,
        { id: 'output', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'merge', required: true }] },
      ],
      edges: [{ id: 'start-merge', source: 'start', target: 'merge' }, { id: 'merge-output', source: 'merge', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { title: '标题', body: '正文' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('标题：标题\\n正文：正文')
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
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

  it('runs explicit compensation actions in reverse order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-'))
    const workflowStore = new WorkflowStore(dir)
    const undo = await workflowStore.create({
      id: 'workflow-undo', name: 'Undo', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } },
      ], edges: [{ id: 'undo-edge', source: 'input', target: 'output' }],
    })
    const main = await workflowStore.create({
      id: 'workflow-compensated', name: 'Compensated', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        {
          id: 'effect', type: 'mcp', label: 'Effect', config: { tool: 'publish', arguments: {} }, position: { x: 200, y: 0 },
          compensation: { type: 'workflow', workflowId: undo.id, input: { undoValue: '{{value}}' } },
        },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'main-a', source: 'input', target: 'effect' }, { id: 'main-b', source: 'effect', target: 'output' }],
    })
    const executeSubWorkflow = vi.fn(async () => 'undone')
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      mcpClient: { call: async () => 'published' },
      executeSubWorkflow,
    })

    const run = await service.start(main.id, 'order-42')
    const completed = await eventually(service, run.id)
    expect(completed.status).toBe('completed')
    const compensated = await service.compensate(run.id)

    expect(executeSubWorkflow).toHaveBeenCalledWith(undo.id, { undoValue: 'published' }, true, undefined, expect.any(Object))
    expect(compensated.compensationStack).toMatchObject([{ sourceNodeId: 'effect', status: 'completed' }])
  })
})
