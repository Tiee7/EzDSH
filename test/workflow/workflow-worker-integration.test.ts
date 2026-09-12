import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRunService, type WorkflowRunServiceOptions } from '../../src/main/workflow/workflow-run-service.js'
import type { WorkflowNode, WorkflowRunRecord, WorkflowValue } from '../../src/shared/workflow.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowRunWorker } from '../../src/main/workflow/workflow-run-worker.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowConnectorService } from '../../src/main/workflow/workflow-connector-service.js'
import { computeWorkflowReleaseSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import type { WorkflowRelease } from '../../src/shared/workflow-operations.js'

afterEach(() => vi.unstubAllGlobals())

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function eventually<T>(read: () => T | undefined, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read()
    if (value !== undefined && predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true in time')
}

async function liveChildFixture(options: { queueCapacity?: number; wait?: boolean; childNode?: WorkflowNode; afterChild?: WorkflowNode; lightweightClient?: WorkflowRunServiceOptions['lightweightClient']; legacyPolling?: boolean } = {}) {
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
    workflowStore, runStore: new WorkflowRunStore(directory, options.queueCapacity === undefined ? undefined : { global: options.queueCapacity, perEnvironment: options.queueCapacity }), workflowRoot: directory,
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
      queueCapacity: 2,
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
    const child = await workflowStore.create({
      id: 'legacy-lineage-b', name: 'B', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write-before-recursion', type: 'mcp', label: 'Must not write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'back-to-a', type: 'sub-workflow', label: 'Back to A', config: { workflowId: 'legacy-lineage-a', waitForCompletion: true }, position: { x: 400, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'write-before-recursion' }, { id: 'b', source: 'write-before-recursion', target: 'back-to-a' }, { id: 'c', source: 'back-to-a', target: 'output' }],
    })
    const parent = await workflowStore.create({
      id: 'legacy-lineage-a', name: 'A', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'to-b', type: 'sub-workflow', label: 'To B', config: { workflowId: child.id, waitForCompletion: false }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'to-b' }, { id: 'b', source: 'to-b', target: 'output' }],
    })
    // Exact pre-lineage schema: neither parentRunId nor workflowAncestry was
    // persisted. The completed async parent output is the durable provenance.
    await runStore.enqueue({
      id: 'legacy-parent-run', workflowId: parent.id, workflowRevision: parent.revision, status: 'completed', input: null, output: { runId: 'legacy-child-run' }, allowShellFile: false,
      nodeStates: [{ nodeId: 'to-b', status: 'completed', output: { runId: 'legacy-child-run' } }], events: [],
    })
    await runStore.enqueue({
      id: 'legacy-child-run', workflowId: child.id, workflowRevision: child.revision, status: 'queued', input: null, allowShellFile: false,
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
      expect(stopped.parentRunId).toBe('legacy-parent-run')
      expect(stopped.error).toMatch(/递归|recursive/iu)
      expect(childEffects).toBe(0)
    } finally { await service.stop() }
  })

  it('keeps a genuine legacy top-level queued run executable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-live-child-legacy-top-level-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'legacy-top-level', name: 'Top level', description: '',
      nodes: [{ id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }, { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } }],
      edges: [{ id: 'a', source: 'input', target: 'output' }],
    })
    const runStore = new WorkflowRunStore(directory)
    await runStore.enqueue({ id: 'legacy-top-run', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'queued', input: 'safe', allowShellFile: false, nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [] })
    const service = new WorkflowRunService({ workflowStore, runStore: new WorkflowRunStore(directory), workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    try {
      await service.initialize()
      expect((await eventually(() => service.get('legacy-top-run'), (run) => run.status === 'completed')).output).toBe('safe')
    } finally { await service.stop() }
  })

  it('pauses a provenance-linked legacy child when the immutable parent node cannot verify the relationship', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-live-child-legacy-unverified-'))
    const workflowStore = new WorkflowStore(directory)
    const parent = await workflowStore.create({
      id: 'legacy-unverified-parent', name: 'Parent', description: '',
      nodes: [{ id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }, { id: 'not-a-child', type: 'transform', label: 'Transform', config: { template: 'identity' }, position: { x: 200, y: 0 } }, { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } }],
      edges: [{ id: 'a', source: 'input', target: 'not-a-child' }, { id: 'b', source: 'not-a-child', target: 'output' }],
    })
    const child = await workflowStore.create({
      id: 'legacy-unverified-child', name: 'Child', description: '',
      nodes: [{ id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }, { id: 'write', type: 'mcp', label: 'Must not write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } }, { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } }],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const runStore = new WorkflowRunStore(directory)
    await runStore.enqueue({ id: 'legacy-unverified-parent-run', workflowId: parent.id, workflowRevision: parent.revision, status: 'completed', input: null, allowShellFile: false, nodeStates: [{ nodeId: 'not-a-child', status: 'completed', output: { runId: 'legacy-unverified-child-run' } }], events: [] })
    await runStore.enqueue({ id: 'legacy-unverified-child-run', workflowId: child.id, workflowRevision: child.revision, status: 'queued', input: null, allowShellFile: false, nodeStates: child.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [] })
    let effects = 0
    const service = new WorkflowRunService({ workflowStore, runStore: new WorkflowRunStore(directory), workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      mcpClient: { call: async () => { effects += 1; return 'written' } },
    })
    try {
      await service.initialize()
      expect(service.get('legacy-unverified-child-run')).toMatchObject({ status: 'paused', error: expect.stringMatching(/父级链路|递归/u) })
      expect(effects).toBe(0)
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

describe('workflow service lifecycle', () => {
  async function createLifecycleFixture(id = 'workflow-lifecycle') {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-lifecycle-'))
    const authoringStore = new WorkflowStore(directory)
    const workflow = await authoringStore.create({
      id, name: 'Lifecycle', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'identity' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'transform' }, { id: 'b', source: 'transform', target: 'output' }],
    })
    const workflowStore = new WorkflowStore(directory)
    const runStore = new WorkflowRunStore(directory)
    const createService = (store = runStore) => new WorkflowRunService({
      workflowStore, runStore: store, workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    return { directory, workflow, workflowStore, runStore, createService, service: createService() }
  }

  it('maps service and Worker lifecycle into a durable read-only operations snapshot', async () => {
    const fixture = await createLifecycleFixture('workflow-operations-snapshot')
    const initializeEntered = deferred<void>()
    const allowInitialize = deferred<void>()
    const originalInitialize = fixture.workflowStore.initialize.bind(fixture.workflowStore)
    vi.spyOn(fixture.workflowStore, 'initialize').mockImplementation(async () => {
      initializeEntered.resolve()
      await allowInitialize.promise
      await originalInitialize()
    })

    expect(fixture.service.operationsSnapshot()).toEqual({
      lifecycle: 'new',
      worker: { state: 'stopped', consecutiveClaimFailures: 0, activeRunCount: 0 },
    })

    const initializing = fixture.service.initialize()
    await initializeEntered.promise
    expect(fixture.service.operationsSnapshot()).toEqual({
      lifecycle: 'initializing',
      worker: { state: 'stopped', consecutiveClaimFailures: 0, activeRunCount: 0 },
    })

    allowInitialize.resolve()
    await initializing
    const accepting = await eventually(
      () => fixture.service.operationsSnapshot(),
      (snapshot) => snapshot.lifecycle === 'accepting' && snapshot.worker.state === 'ready',
    )
    expect(accepting.worker.lastPollAttemptAt).toEqual(expect.any(String))
    expect(accepting.worker.lastPollSucceededAt).toEqual(expect.any(String))
    const isolated = accepting as { lifecycle: string; worker: { state: string } }
    isolated.lifecycle = 'corrupted'
    isolated.worker.state = 'corrupted'
    expect(fixture.service.operationsSnapshot()).toMatchObject({ lifecycle: 'accepting', worker: { state: 'ready' } })

    const stopping = fixture.service.stop()
    expect(fixture.service.operationsSnapshot()).toMatchObject({ lifecycle: 'stopping', worker: { state: 'stopping' } })
    await stopping
    expect(fixture.service.operationsSnapshot()).toMatchObject({
      lifecycle: 'stopped',
      worker: { state: 'stopped', consecutiveClaimFailures: 0 },
    })
    expect(fixture.service.operationsSnapshot()).not.toBe(accepting)
  })

  it('retries failed initialization instead of poisoning the service', async () => {
    const fixture = await createLifecycleFixture('workflow-init-retry')
    const initialize = vi.spyOn(fixture.workflowStore, 'initialize')
    initialize.mockRejectedValueOnce(new Error('temporary store failure'))

    await expect(fixture.service.initialize()).rejects.toThrow('temporary store failure')
    const queued = await fixture.service.start(fixture.workflow.id, 'retry')
    expect(queued.status).toBe('queued')
    expect(initialize).toHaveBeenCalledTimes(2)
    await fixture.service.stop()
  })

  it('retries initialization when starting the Worker fails', async () => {
    const fixture = await createLifecycleFixture('workflow-worker-start-retry')
    const worker = (fixture.service as unknown as { worker: WorkflowRunWorker }).worker
    const startWorker = vi.spyOn(worker, 'start')
      .mockRejectedValueOnce(new Error('temporary worker failure'))
      .mockResolvedValueOnce(undefined)

    await expect(fixture.service.initialize()).rejects.toThrow('temporary worker failure')
    await fixture.service.initialize()
    expect(startWorker).toHaveBeenCalledTimes(2)
    expect((await fixture.service.start(fixture.workflow.id, null)).status).toBe('queued')
    await fixture.service.stop()
  })

  it('lets stop win an initialization race and never starts the Worker', async () => {
    const fixture = await createLifecycleFixture('workflow-init-stop-race')
    const entered = deferred<void>()
    const allowInitialize = deferred<void>()
    const originalInitialize = fixture.workflowStore.initialize.bind(fixture.workflowStore)
    vi.spyOn(fixture.workflowStore, 'initialize').mockImplementation(async () => {
      entered.resolve()
      await allowInitialize.promise
      await originalInitialize()
    })
    const worker = (fixture.service as unknown as { worker: WorkflowRunWorker }).worker
    const startWorker = vi.spyOn(worker, 'start')

    const initializing = fixture.service.initialize()
    await entered.promise
    const stopping = fixture.service.stop()
    const sameStopping = fixture.service.stop()
    expect(sameStopping).toBe(stopping)
    allowInitialize.resolve()

    await Promise.all([initializing, stopping])
    expect(startWorker).not.toHaveBeenCalled()
    await expect(fixture.service.start(fixture.workflow.id, null)).rejects.toMatchObject({ code: 'WORKFLOW_RUN_SERVICE_UNAVAILABLE' })
    expect(fixture.service.list(fixture.workflow.id)).toEqual([])
  })

  it('keeps read-only history available after stop while rejecting new durable work', async () => {
    const fixture = await createLifecycleFixture('workflow-stopped-read-only')
    const queued = await fixture.service.start(fixture.workflow.id, 'saved')
    await eventually(() => fixture.service.get(queued.id), (record) => record.status === 'completed')
    const stopping = fixture.service.stop()
    expect(fixture.service.stop()).toBe(stopping)
    await stopping

    expect(fixture.service.get(queued.id)?.id).toBe(queued.id)
    expect(fixture.service.list(fixture.workflow.id)).toHaveLength(1)
    expect(await fixture.service.getRunDefinition(queued.id)).toMatchObject({ id: fixture.workflow.id, revision: fixture.workflow.revision })
    await expect(fixture.service.start(fixture.workflow.id, 'forbidden')).rejects.toMatchObject({ code: 'WORKFLOW_RUN_SERVICE_UNAVAILABLE' })
    expect(fixture.service.list(fixture.workflow.id)).toHaveLength(1)
  })

  it('rejects every public durable-work entry after stop before changing storage', async () => {
    const fixture = await createLifecycleFixture('workflow-stopped-mutations')
    await fixture.service.initialize()
    await fixture.service.stop()
    const unavailable = { code: 'WORKFLOW_RUN_SERVICE_UNAVAILABLE' }
    const serviceWithPrivateEntries = fixture.service as unknown as {
      reconcileCompensation(runId: string, input: { occurrenceId: string; outcome: 'not-dispatched'; note: string }): Promise<WorkflowRunRecord>
      startReleasedDefinition(releaseId: string, definition: { id: string; revision: number }, input: WorkflowValue): Promise<WorkflowRunRecord>
    }
    const attempts: Array<() => Promise<unknown>> = [
      () => fixture.service.start(fixture.workflow.id, null),
      () => fixture.service.startReleased('missing-release', null),
      () => fixture.service.executeSubWorkflow(fixture.workflow.id, null, false),
      () => fixture.service.resume('missing-run'),
      () => fixture.service.approve('missing-run', true),
      () => fixture.service.reconcileEffect('missing-run', { nodeId: 'node', outcome: 'not-dispatched', note: 'checked' }),
      () => serviceWithPrivateEntries.reconcileCompensation('missing-run', { occurrenceId: 'occurrence', outcome: 'not-dispatched', note: 'checked' }),
      () => fixture.service.compensate('missing-run'),
      () => serviceWithPrivateEntries.startReleasedDefinition('missing-release', { id: fixture.workflow.id, revision: fixture.workflow.revision }, null),
    ]

    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject(unavailable)
    expect(fixture.runStore.list()).toEqual([])
  })

  it('rechecks lifecycle after a workflow lock wait and refuses to enqueue', async () => {
    const fixture = await createLifecycleFixture('workflow-stop-lock-race')
    await fixture.service.initialize()
    const removing = deferred<void>()
    const allowRemove = deferred<void>()
    const originalRemove = fixture.workflowStore.remove.bind(fixture.workflowStore)
    vi.spyOn(fixture.workflowStore, 'remove').mockImplementation(async (workflowId) => {
      removing.resolve()
      await allowRemove.promise
      return originalRemove(workflowId)
    })

    const deletion = fixture.service.removeWorkflow(fixture.workflow.id)
    await removing.promise
    const starting = fixture.service.start(fixture.workflow.id, 'must not persist')
    const rejectedStart = expect(starting).rejects.toMatchObject({ code: 'WORKFLOW_RUN_SERVICE_UNAVAILABLE' })
    const stopping = fixture.service.stop()
    allowRemove.resolve()
    await Promise.all([deletion, stopping])

    await rejectedStart
    expect(fixture.runStore.list(fixture.workflow.id)).toEqual([])
  })

  it('synchronously stops Worker claims before awaiting active-run cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-lifecycle-worker-stop-'))
    const workflowStore = new WorkflowStore(directory)
    const activeWorkflow = await workflowStore.create({
      id: 'lifecycle-active', name: 'Active', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'hold', type: 'ai-task', label: 'Hold', config: { instruction: 'hold', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'hold' }, { id: 'b', source: 'hold', target: 'output' }],
    })
    const queuedWorkflow = await workflowStore.create({
      id: 'lifecycle-queued', name: 'Queued', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write', type: 'mcp', label: 'Must remain queued', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const providerEntered = deferred<void>()
    let writes = 0
    const runStore = new WorkflowRunStore(directory)
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: async ({ signal }) => {
        providerEntered.resolve()
        return new Promise<string>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('aborted'))
          else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      } },
      mcpClient: { call: async () => { writes += 1; return 'written' } },
    })
    await service.start(activeWorkflow.id, null)
    await providerEntered.promise
    await service.start(queuedWorkflow.id, null)
    const allowCleanup = deferred<void>()
    vi.spyOn(service as unknown as { cancelInternalSessions(): Promise<void> }, 'cancelInternalSessions')
      .mockImplementation(async () => allowCleanup.promise)
    const worker = (service as unknown as { worker: WorkflowRunWorker }).worker as unknown as { stopping: boolean }

    const stopping = service.stop()
    try {
      expect(worker.stopping).toBe(true)
    } finally {
      allowCleanup.resolve()
      await stopping
    }
    expect(writes).toBe(0)
    expect(runStore.list(queuedWorkflow.id)).toMatchObject([{ status: 'queued' }])
  })

  it('aborts a parentless child wait on stop and leaves one durable child for a new service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-lifecycle-child-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-lifecycle-child', name: 'Lifecycle child', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write', type: 'mcp', label: 'Write once', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const firstStore = new WorkflowRunStore(directory)
    const claimEntered = deferred<void>()
    const allowClaim = deferred<WorkflowRunRecord | undefined>()
    vi.spyOn(firstStore, 'claimNextDue').mockImplementation(async () => {
      claimEntered.resolve()
      return allowClaim.promise
    })
    let writes = 0
    const createService = (runStore: WorkflowRunStore) => new WorkflowRunService({
      workflowStore, runStore, workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      mcpClient: { call: async () => { writes += 1; return 'written' } },
    })
    const first = createService(firstStore)
    const childCreated = deferred<WorkflowRunRecord>()
    first.watch((record) => {
      if (record.workflowId === workflow.id && record.events.some((event) => event.type === 'run-created')) childCreated.resolve(record)
    })

    const waiting = first.executeSubWorkflow(workflow.id, 'payload', true)
    await Promise.all([claimEntered.promise, childCreated.promise])
    let waitSettled = false
    void waiting.then(() => { waitSettled = true }, () => { waitSettled = true })
    const stopping = first.stop()
    await expect(waiting).rejects.toMatchObject({ code: 'WORKFLOW_RUN_SERVICE_UNAVAILABLE' })
    expect(waitSettled).toBe(true)
    expect(firstStore.list(workflow.id)).toMatchObject([{ status: 'queued' }])
    expect(firstStore.list(workflow.id)[0]?.queue?.lease).toBeUndefined()
    allowClaim.resolve(undefined)
    await stopping

    const restarted = createService(new WorkflowRunStore(directory))
    try {
      await restarted.initialize()
      const completed = await eventually(() => restarted.list(workflow.id)[0], (record) => record.status === 'completed')
      expect(completed.output).toBe('written')
      expect(writes).toBe(1)
      expect(restarted.list(workflow.id)).toHaveLength(1)
    } finally { await restarted.stop() }
  })

  it('does not directly execute a released synchronous child enqueued across stop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-lifecycle-release-child-'))
    const workflowStore = new WorkflowStore(directory)
    const child = await workflowStore.create({
      id: 'released-stop-child', name: 'Released child', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'write', type: 'mcp', label: 'Write once', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const parent = await workflowStore.create({
      id: 'released-stop-parent', name: 'Released parent', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'child', type: 'sub-workflow', label: 'Child', config: { workflowId: child.id, version: child.revision, waitForCompletion: true }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'child' }, { id: 'b', source: 'child', target: 'output' }],
    })
    const releaseSeed = { workflowSnapshot: parent, workflowDependencies: [child] }
    const release: WorkflowRelease = {
      id: 'released-stop-release', environmentId: 'released-stop-environment', workflowId: parent.id, workflowRevision: parent.revision,
      ...releaseSeed, contentSha256: computeWorkflowReleaseSha256(releaseSeed), status: 'published', connectorGrants: [],
      createdAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
    }
    let writes = 0
    const childEnqueueEntered = deferred<void>()
    const allowChildEnqueue = deferred<void>()
    const firstStore = new WorkflowRunStore(directory)
    const originalEnqueue = firstStore.enqueue.bind(firstStore)
    vi.spyOn(firstStore, 'enqueue').mockImplementation(async (record) => {
      if (record.workflowId === child.id) {
        childEnqueueEntered.resolve()
        await allowChildEnqueue.promise
      }
      return originalEnqueue(record)
    })
    const createService = (runStore: WorkflowRunStore) => new WorkflowRunService({
      workflowStore, runStore, workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      resolveReleasedWorkflow: (releaseId) => releaseId === release.id ? release : undefined,
      resolveWorkflowEnvironment: (environmentId) => environmentId === release.environmentId ? {
        id: environmentId, customerName: 'Customer', name: 'Production', kind: 'production', status: 'active', connectorIds: [], allowShellFile: false, allowCode: false,
        createdAt: release.createdAt, updatedAt: release.createdAt,
      } : undefined,
      mcpClient: { call: async () => { writes += 1; return 'written' } },
    })
    const first = createService(firstStore)
    await first.startReleased(release.id, 'payload')
    await childEnqueueEntered.promise
    const stopping = first.stop()
    allowChildEnqueue.resolve()
    await stopping

    expect(writes).toBe(0)
    expect(firstStore.list(child.id)).toMatchObject([{ status: 'queued' }])
    expect(firstStore.list(child.id)[0]?.queue?.lease).toBeUndefined()

    const restarted = createService(new WorkflowRunStore(directory))
    try {
      await restarted.initialize()
      const completed = await eventually(() => restarted.list(child.id)[0], (record) => record.status === 'completed')
      expect(completed.output).toBe('written')
      expect(writes).toBe(1)
      expect(restarted.list(child.id)).toHaveLength(1)
    } finally { await restarted.stop() }
  })
})

describe('workflow worker stop boundary', () => {
  it('recovers a claim that resolves after stop without executing it', async () => {
    const claimEntered = deferred<void>()
    const allowClaim = deferred<WorkflowRunRecord | undefined>()
    const executeClaimedRun = vi.fn(async () => undefined)
    const releaseLease = vi.fn(async () => true)
    const claimedAt = new Date().toISOString()
    const claimed: WorkflowRunRecord = {
      id: 'late-claim', workflowId: 'workflow', workflowRevision: 1, status: 'running', input: null,
      allowShellFile: false, nodeStates: [], events: [],
      queue: { enqueuedAt: claimedAt, availableAt: claimedAt, lease: { ownerId: 'worker-owner', claimedAt, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    }
    const store = {
      claimNextDue: vi.fn(async () => { claimEntered.resolve(); return allowClaim.promise }),
      releaseLease,
      renewLease: vi.fn(async () => claimed),
      nextDueAt: vi.fn(() => undefined),
    }
    const worker = new WorkflowRunWorker({ store: store as unknown as WorkflowRunStore, ownerId: 'worker-owner', executeClaimedRun })

    await worker.start()
    await claimEntered.promise
    const stopping = worker.stop()
    allowClaim.resolve(claimed)
    await stopping

    expect(executeClaimedRun).not.toHaveBeenCalled()
    expect(releaseLease).toHaveBeenCalledWith('late-claim', 'worker-owner', true)
  })
})
