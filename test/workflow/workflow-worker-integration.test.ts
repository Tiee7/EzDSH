import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRunService, type WorkflowRunServiceOptions } from '../../src/main/workflow/workflow-run-service.js'
import type { WorkflowNode, WorkflowRunRecord, WorkflowValue } from '../../src/shared/workflow.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowConnectorService } from '../../src/main/workflow/workflow-connector-service.js'

afterEach(() => vi.unstubAllGlobals())

async function eventually<T>(read: () => T | undefined, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read()
    if (value !== undefined && predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true in time')
}

async function liveChildFixture(options: { wait?: boolean; childNode?: WorkflowNode; afterChild?: WorkflowNode; lightweightClient?: WorkflowRunServiceOptions['lightweightClient']; legacyPolling?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-live-child-'))
  const workflowStore = new WorkflowStore(directory)
  const createWorkflow = (id: string, nodes: WorkflowNode[]) => workflowStore.create({
    id, name: id, description: '',
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      ...nodes,
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
    ],
    edges: ['input', ...nodes.map((node) => node.id), 'output'].slice(1).map((target, index) => ({ id: `edge-${index}`, source: index === 0 ? 'input' : nodes[index - 1]!.id, target })),
  })
  const child = await createWorkflow('live-child', [options.childNode ?? { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'prepend', text: 'child: ' }, position: { x: 200, y: 0 } }])
  const parent = await createWorkflow('live-parent', [
    { id: 'sub', type: 'sub-workflow', label: 'Child', config: { workflowId: child.id, waitForCompletion: options.wait ?? true }, position: { x: 200, y: 0 } },
    ...(options.afterChild === undefined ? [] : [options.afterChild]),
  ])
  const service: WorkflowRunService = new WorkflowRunService({
    workflowStore, runStore: new WorkflowRunStore(directory), workflowRoot: directory,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
    resolveEmployee: () => undefined,
    lightweightClient: options.lightweightClient,
    // Reproduce Main's old queue-and-poll wiring with a bounded test deadline.
    ...(options.legacyPolling ? { executeSubWorkflow: async (id: string, input: WorkflowValue, wait: boolean) => {
      const run = await service.start(id, input)
      if (!wait) return { runId: run.id }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = service.get(run.id)!
        if (current.status === 'completed') return current.output ?? null
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`child remained ${service.get(run.id)?.status} behind parent`)
    } } : {}),
  })
  return { service, workflowStore, parent, child, createWorkflow }
}

describe('unpublished child workflows in the single Worker', () => {
  it('completes a synchronous child before releasing the parent lease', async () => {
    const { service, parent, child } = await liveChildFixture({ legacyPolling: true })
    const observations: Array<{ parent: string | undefined; leased: boolean }> = []
    const unwatch = service.watch((record) => {
      if (record.workflowId === child.id && record.status === 'running') {
        const owner = service.list(parent.id)[0]
        observations.push({ parent: owner?.status, leased: owner?.queue?.lease !== undefined })
      }
    })
    try {
      const started = await service.start(parent.id, 'hello')
      const settled = await eventually(() => service.get(started.id), (run) => ['completed', 'failed', 'paused'].includes(run.status))
      expect(settled.status, settled.nodeStates.find((state) => state.nodeId === 'sub')?.error).toBe('completed')
      expect(settled.output).toBe('child: hello')
      expect(service.list(child.id)).toHaveLength(1)
      expect(observations).toContainEqual({ parent: 'running', leased: true })
    } finally { unwatch(); await service.stop() }
  })

  it('returns an asynchronous child run id while the child stays queued behind its parent', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service, parent, child } = await liveChildFixture({
      wait: false,
      afterChild: { id: 'hold', type: 'ai-task', label: 'Hold parent', config: { instruction: 'hold', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: 0 } },
      lightweightClient: { complete: async () => { await gate; return 'parent done' } },
    })
    try {
      const started = await service.start(parent.id, 'hello')
      const held = await eventually(() => service.get(started.id), (run) => run.nodeStates.some((state) => state.nodeId === 'hold' && state.status === 'running'))
      const queued = service.list(child.id)[0]!
      expect(queued.status).toBe('queued')
      expect(queued.queue?.lease).toBeUndefined()
      expect(held.nodeStates.find((state) => state.nodeId === 'sub')?.output).toEqual({ runId: queued.id })
      release()
      expect((await eventually(() => service.get(queued.id), (run) => run.status === 'completed')).output).toBe('child: hello')
    } finally { release(); await service.stop() }
  })

  it('pauses a cancelled synchronous child effect as unknown and permits node reconciliation', async () => {
    let childSignal: AbortSignal | undefined
    const { service, parent, child } = await liveChildFixture({
      childNode: { id: 'ai', type: 'ai-task', label: 'Await cancellation', config: { instruction: 'wait', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } },
      lightweightClient: { complete: async (request) => {
        childSignal = request.signal
        return new Promise<string>((_resolve, reject) => {
          if (request.signal?.aborted) reject(new Error('child aborted'))
          else request.signal?.addEventListener('abort', () => reject(new Error('child aborted')), { once: true })
        })
      } },
    })
    try {
      const started = await service.start(parent.id, 'hello')
      await eventually(() => childSignal, () => true)
      await service.cancel(started.id)
      expect(childSignal?.aborted).toBe(true)
      expect((await eventually(() => service.list(child.id)[0], (run) => run.status === 'cancelled')).status).toBe('cancelled')
      const paused = await eventually(() => service.get(started.id), (run) => run.status === 'paused')
      expect(paused.nodeStates.find((state) => state.nodeId === 'sub')).toMatchObject({ status: 'pending', effectState: 'unknown' })
      const resumed = await service.reconcileEffect(started.id, { nodeId: 'sub', outcome: 'not-dispatched', note: 'child was cancelled before completion' })
      expect(['queued', 'running']).toContain(resumed.status)
      expect(resumed.events.some((event) => event.type === 'node-effect-reconciled-not-dispatched')).toBe(true)
    } finally { await service.stop() }
  })

  it('waits for the same inline child to become due and complete its scheduled retry', async () => {
    let attempts = 0
    const { service, parent, child } = await liveChildFixture({
      childNode: { id: 'ai', type: 'ai-task', label: 'Retry child', config: { instruction: 'retry', mode: 'single', skillIds: [], outputMode: 'text' }, retryPolicy: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterRatio: 0 }, position: { x: 200, y: 0 } },
      lightweightClient: { complete: async () => { attempts += 1; if (attempts === 1) throw new Error('temporary provider failure'); return 'retried child' } },
    })
    try {
      const started = await service.start(parent.id, 'hello')
      const retry = await eventually(() => service.list(child.id)[0], (run) => run.events.some((event) => event.type === 'node-retry'))
      expect(retry.status).toBe('queued')
      expect(retry.queue?.availableAt).toBe(retry.nodeStates.find((state) => state.nodeId === 'ai')?.nextAttemptAt)
      const settled = await eventually(() => service.get(started.id), (run) => ['completed', 'failed', 'paused'].includes(run.status))
      expect(settled.status).toBe('completed')
      expect(settled.output).toBe('retried child')
      expect(service.list(child.id)).toHaveLength(1)
      expect(service.get(retry.id)?.status).toBe('completed')
      expect(attempts).toBe(2)
    } finally { await service.stop() }
  })

  it('cancels a queued inline child but pauses the dispatched parent sub-workflow effect for review', async () => {
    let attempts = 0
    const { service, parent, child } = await liveChildFixture({
      childNode: { id: 'ai', type: 'ai-task', label: 'Delayed retry', config: { instruction: 'retry', mode: 'single', skillIds: [], outputMode: 'text' }, retryPolicy: { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0 }, position: { x: 200, y: 0 } },
      lightweightClient: { complete: async () => { attempts += 1; throw new Error('temporary provider failure') } },
    })
    try {
      const started = await service.start(parent.id, 'hello')
      const retry = await eventually(() => service.list(child.id)[0], (run) => run.status === 'queued' && run.events.some((event) => event.type === 'node-retry'))
      await service.cancel(started.id)
      const cancelled = await eventually(() => service.get(retry.id), (run) => run.status === 'cancelled')
      expect(cancelled.status).toBe('cancelled')
      const paused = await eventually(() => service.get(started.id), (run) => run.status === 'paused')
      expect(paused.nodeStates.find((state) => state.nodeId === 'sub')).toMatchObject({ status: 'pending', effectState: 'unknown' })
      expect(attempts).toBe(1)
    } finally { await service.stop() }
  })

  it('keeps parentless synchronous retries exclusively under the Worker with exactly two attempts', async () => {
    let attempts = 0
    const leased: boolean[] = []
    const { service, child, createWorkflow } = await liveChildFixture({
      childNode: { id: 'ai', type: 'ai-task', label: 'Compensation retry', config: { instruction: 'retry', mode: 'single', skillIds: [], outputMode: 'text' }, retryPolicy: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 50, jitterRatio: 0 }, position: { x: 200, y: 0 } },
      lightweightClient: { complete: async () => {
        attempts += 1
        leased.push(service.list(child.id)[0]?.queue?.lease !== undefined)
        if (attempts === 1) throw new Error('temporary provider failure')
        await new Promise((resolve) => setTimeout(resolve, 60))
        return 'compensated'
      } },
    })
    const unrelated = await createWorkflow('unrelated', [])
    try {
      const output = service.executeSubWorkflow(child.id, 'hello', true).then((value) => ({ value }), (error: unknown) => ({ error }))
      await eventually(() => service.list(child.id)[0], (run) => run.status === 'queued' && run.events.some((event) => event.type === 'node-retry'))
      // Wake the real Worker while the child is due for retry. The public
      // compensation entry must never compete with it using inline execution.
      await service.start(unrelated.id, null)
      expect(await output).toEqual({ value: 'compensated' })
      expect(attempts).toBe(2)
      expect(leased).toEqual([true, true])
      expect(service.list(child.id)).toHaveLength(1)
    } finally { await service.stop() }
  })

  it('ends the parent wait promptly when the inline child is cancelled directly during retry delay', async () => {
    let attempts = 0
    const { service, parent, child } = await liveChildFixture({
      childNode: { id: 'ai', type: 'ai-task', label: 'Delayed retry', config: { instruction: 'retry', mode: 'single', skillIds: [], outputMode: 'text' }, retryPolicy: { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0 }, position: { x: 200, y: 0 } },
      lightweightClient: { complete: async () => { attempts += 1; throw new Error('temporary provider failure') } },
    })
    try {
      const started = await service.start(parent.id, 'hello')
      const retry = await eventually(() => service.list(child.id)[0], (run) => run.status === 'queued' && run.events.some((event) => event.type === 'node-retry'))
      await service.cancel(retry.id)
      await eventually(() => service.get(started.id), (run) => ['paused', 'failed', 'cancelled'].includes(run.status))
      expect(service.get(retry.id)?.status).toBe('cancelled')
      expect(service.get(retry.id)?.events.filter((event) => event.type === 'run-started')).toHaveLength(1)
      expect(attempts).toBe(1)
    } finally { await service.stop() }
  })

  it('releases lineage after a failed child finishes', async () => {
    const { service, child } = await liveChildFixture({
      childNode: { id: 'ai', type: 'ai-task', label: 'Failure', config: { instruction: 'fail', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } },
      lightweightClient: { complete: async () => { throw new Error('permanent failure') } },
    })
    const lineages = (service as unknown as { liveLineages: Map<string, readonly string[]> }).liveLineages
    try {
      await service.executeSubWorkflow(child.id, null, false)
      const failed = await eventually(() => service.list(child.id)[0], (run) => run.status === 'failed')
      await eventually(() => lineages.has(failed.id), (present) => !present)
    } finally { await service.stop() }
  })

  it('keeps queued async lineage until execution or cancellation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service, parent, child } = await liveChildFixture({
      wait: false,
      afterChild: { id: 'hold', type: 'ai-task', label: 'Hold parent', config: { instruction: 'hold', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: 0 } },
      lightweightClient: { complete: async () => { await gate; return 'done' } },
    })
    const lineages = (service as unknown as { liveLineages: Map<string, readonly string[]> }).liveLineages
    try {
      const started = await service.start(parent.id, null)
      await eventually(() => service.get(started.id), (run) => run.nodeStates.some((state) => state.nodeId === 'hold' && state.status === 'running'))
      const queued = service.list(child.id)[0]!
      expect(lineages.has(queued.id)).toBe(true)
      await service.cancel(queued.id)
      expect(lineages.has(queued.id)).toBe(false)
    } finally { release(); await service.stop() }
  })

  it.each([false, true])('rejects recursive lineage before creating the repeated run (indirect: %s)', async (indirect) => {
    const { service, parent, child, workflowStore } = await liveChildFixture()
    const recursive = indirect ? child : parent
    const repeatedId = parent.id
    recursive.nodes = recursive.nodes.map((node) => node.id === (indirect ? 'transform' : 'sub')
      ? { id: node.id, type: 'sub-workflow', label: 'Recursive child', config: { workflowId: repeatedId, waitForCompletion: true }, position: node.position }
      : node)
    await workflowStore.update(recursive.id, recursive)
    try {
      const started = await service.start(parent.id, 'hello')
      await eventually(() => service.get(started.id), (run) => ['failed', 'paused'].includes(run.status))
      const rejected = service.list(recursive.id)[0]!
      expect(rejected?.nodeStates.find((state) => state.nodeId === (indirect ? 'transform' : 'sub'))?.error ?? service.get(started.id)?.nodeStates.find((state) => state.nodeId === 'sub')?.error).toMatch(/递归|recursive/iu)
      expect(service.list(parent.id)).toHaveLength(1)
      expect(service.list(child.id)).toHaveLength(indirect ? 1 : 0)
    } finally { await service.stop() }
  })

  it('persists async ancestry so A to B still rejects B to A after restart without replaying A effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-live-child-restart-lineage-'))
    const workflowStore = new WorkflowStore(directory)
    const child = await workflowStore.create({
      id: 'lineage-b', name: 'B', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'back-to-a', type: 'sub-workflow', label: 'Back to A', config: { workflowId: 'lineage-a', waitForCompletion: true }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'b1', source: 'input', target: 'back-to-a' }, { id: 'b2', source: 'back-to-a', target: 'output' }],
    })
    const parent = await workflowStore.create({
      id: 'lineage-a', name: 'A', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write-a', type: 'mcp', label: 'Write A', config: { tool: 'write-a', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'to-b', type: 'sub-workflow', label: 'To B', config: { workflowId: child.id, waitForCompletion: false }, position: { x: 400, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [{ id: 'a1', source: 'input', target: 'write-a' }, { id: 'a2', source: 'write-a', target: 'to-b' }, { id: 'a3', source: 'to-b', target: 'output' }],
    })
    let effects = 0
    const createService = () => new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(directory), workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      mcpClient: { call: async () => { effects += 1; return 'written' } },
    })
    const first = createService()
    let queuedChild!: (record: WorkflowRunRecord) => void
    const childCreated = new Promise<WorkflowRunRecord>((resolve) => { queuedChild = resolve })
    let stopping: Promise<void> | undefined
    const unwatch = first.watch((record) => {
      if (record.workflowId === child.id && record.events.some((event) => event.type === 'run-created')) {
        queuedChild(record)
        stopping ??= first.stop()
      }
    })
    try {
      await first.start(parent.id, 'payload')
      const queued = await childCreated
      await stopping
      expect(effects).toBe(1)
      expect(queued).toMatchObject({ status: 'queued', parentRunId: expect.any(String), workflowAncestry: [parent.id] })
    } finally {
      unwatch()
      await first.stop()
    }

    const restarted = createService()
    try {
      await restarted.initialize()
      const failedChild = await eventually(() => restarted.list(child.id)[0], (run) => run.status === 'failed')
      expect(failedChild.error).toMatch(/递归|recursive/iu)
      expect(restarted.list(parent.id)).toHaveLength(1)
      expect(effects).toBe(1)
    } finally { await restarted.stop() }
  })

  it('rebuilds a legacy queued child ancestry before execution and blocks its preceding side effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-live-child-legacy-lineage-'))
    const workflowStore = new WorkflowStore(directory)
    const runStore = new WorkflowRunStore(directory)
    const parent = await workflowStore.create({ id: 'legacy-lineage-a', name: 'A', description: '', nodes: [{ id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }, { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } }], edges: [{ id: 'a', source: 'input', target: 'output' }] })
    const child = await workflowStore.create({
      id: 'legacy-lineage-b', name: 'B', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write-before-recursion', type: 'mcp', label: 'Must not write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'back-to-a', type: 'sub-workflow', label: 'Back to A', config: { workflowId: parent.id, waitForCompletion: true }, position: { x: 400, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'write-before-recursion' }, { id: 'b', source: 'write-before-recursion', target: 'back-to-a' }, { id: 'c', source: 'back-to-a', target: 'output' }],
    })
    await runStore.enqueue({ id: 'legacy-parent-run', workflowId: parent.id, workflowRevision: parent.revision, status: 'completed', input: null, output: null, allowShellFile: false, nodeStates: [], events: [] })
    await runStore.enqueue({
      id: 'legacy-child-run', workflowId: child.id, workflowRevision: child.revision, parentRunId: 'legacy-parent-run', status: 'queued', input: null, allowShellFile: false,
      nodeStates: child.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [],
    })
    let childEffects = 0
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(directory), workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined, mcpClient: { call: async () => { childEffects += 1; return 'written' } },
    })
    try {
      await service.initialize()
      const stopped = await eventually(() => service.get('legacy-child-run'), (run) => run.status === 'failed' || run.status === 'paused')
      expect(stopped.workflowAncestry).toEqual([parent.id])
      expect(stopped.error).toMatch(/递归|recursive/iu)
      expect(childEffects).toBe(0)
    } finally { await service.stop() }
  })

  it('pauses a legacy queued child when its parent chain cannot be reconstructed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-live-child-missing-lineage-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'orphan-child', name: 'Orphan child', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write', type: 'mcp', label: 'Must not write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const runStore = new WorkflowRunStore(directory)
    await runStore.enqueue({ id: 'orphan-run', workflowId: workflow.id, workflowRevision: workflow.revision, parentRunId: 'missing-parent', status: 'queued', input: null, allowShellFile: false, nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [] })
    let effects = 0
    const service = new WorkflowRunService({ workflowStore, runStore: new WorkflowRunStore(directory), workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      mcpClient: { call: async () => { effects += 1; return 'written' } },
    })
    try {
      await service.initialize()
      expect(service.get('orphan-run')).toMatchObject({ status: 'paused', parentRunId: 'missing-parent', error: expect.stringMatching(/父级链路|递归/u) })
      expect(effects).toBe(0)
    } finally { await service.stop() }
  })
})

describe('workflow durable worker integration', () => {
  it('returns a queued record with durable queue metadata before the Worker completes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-transform',
      name: 'Worker transform',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'prepend', text: 'done: ' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'input-transform', source: 'input', target: 'transform' },
        { id: 'transform-output', source: 'transform', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const initial = await service.start(workflow.id, 'hello', { idempotencyKey: 'transform-42' })

    expect(initial.status).toBe('queued')
    expect(initial.queue).toMatchObject({ enqueuedAt: expect.any(String), availableAt: expect.any(String) })
    const completed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed')
    expect(completed.output).toBe('done: hello')
    expect(completed.queue?.lease).toBeUndefined()
    await service.stop()
  })

  it('executes a managed connector only when the saved policy grants it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-connector',
      name: 'Worker connector',
      description: '',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'http', type: 'http', label: 'Fetch', config: { method: 'GET', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'input-http', source: 'input', target: 'http' },
        { id: 'http-output', source: 'http', target: 'output' },
      ],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const initial = await service.start(workflow.id, { topic: 'hello' }, { connectorGrants: [{ connectorId: 'api', operations: ['read'] }] })
    const completed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed' || record.status === 'failed')
    expect(completed.status).toBe('completed')
    expect(completed.output).toEqual({ status: 200, ok: true, headers: { 'content-type': 'application/json' }, body: { ok: true } })
    await service.stop()
  })

  it('records a policy denial as a failed node without inventing an uncertain effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-connector-denied',
      name: 'Denied connector',
      description: '',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'http', type: 'http', label: 'Write', config: { method: 'POST', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'input-http', source: 'input', target: 'http' }, { id: 'http-output', source: 'http', target: 'output' }],
    })
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const initial = await service.start(workflow.id, null)
    const failed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed' || record.status === 'failed' || record.status === 'paused')
    expect(failed.status).toBe('failed')
    const httpState = failed.nodeStates.find((state) => state.nodeId === 'http')
    expect(httpState?.status).toBe('failed')
    expect(httpState?.effectState).toBeUndefined()
    await service.stop()
  })

  it('requires an explicit one-run grant for a managed connector even when policy allows it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-connector-grant', name: 'Grant required', description: '',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'http', type: 'http', label: 'Fetch', config: { method: 'GET', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'input-http', source: 'input', target: 'http' }, { id: 'http-output', source: 'http', target: 'output' }],
    })
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const initial = await service.start(workflow.id, null)
    const failed = await eventually(() => service.get(initial.id), (record) => record.status === 'failed' || record.status === 'paused')
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/本次运行未授予|未授予/u)
    await service.stop()
  })

  it('persists a deterministic retry as queued work instead of sleeping inside the Worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-retry', name: 'Retry', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-task', label: 'AI', config: { instruction: 'answer', mode: 'single', skillIds: [], outputMode: 'text' }, retryPolicy: { maxAttempts: 2, baseDelayMs: 40, maxDelayMs: 40, jitterRatio: 0 }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'input-ai', source: 'input', target: 'ai' }, { id: 'ai-output', source: 'ai', target: 'output' }],
    })
    let attempts = 0
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: vi.fn(async () => { attempts += 1; if (attempts === 1) throw new Error('temporary provider failure'); return 'done' }) },
    })
    const initial = await service.start(workflow.id, null)
    const retryQueued = await eventually(() => service.get(initial.id), (record) => record.events.some((event) => event.type === 'node-retry'))
    expect(retryQueued.status).toBe('queued')
    expect(retryQueued.nodeStates.find((state) => state.nodeId === 'ai')).toMatchObject({ status: 'pending', attempt: 1, nextAttemptAt: expect.any(String) })
    const completed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed' || record.status === 'failed')
    expect(completed.status).toBe('completed')
    expect(completed.output).toBe('done')
    expect(attempts).toBe(2)
    await service.stop()
  })
})
