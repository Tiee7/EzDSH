import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowOperationalHealthService } from '../../src/main/workflow/workflow-operational-health-service.js'
import { computeWorkflowReleaseSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import type { WorkflowRelease } from '../../src/shared/workflow-operations.js'

const NOW = '2026-09-12T10:00:00.000Z'
function run(id: string, environmentId?: string, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return { id, workflowId: 'workflow', workflowRevision: 1, status: 'queued', input: null, allowShellFile: false,
    nodeStates: [], events: [], startedAt: NOW, environmentId,
    queue: { enqueuedAt: NOW, availableAt: NOW }, ...overrides }
}
async function fixture(global = 3, perEnvironment = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-queue-'))
  const store = new WorkflowRunStore(dir, { global, perEnvironment })
  await store.initialize()
  return { dir, store }
}
const full = { code: 'WORKFLOW_RUN_QUEUE_FULL' }

async function serviceFixture(capacity = 1, perEnvironment = capacity) {
  const { dir, store } = await fixture(capacity, perEnvironment)
  const releases = new Map<string, WorkflowRelease>()
  const workflowStore = new WorkflowStore(dir)
  const workflow = await workflowStore.create({ id: 'workflow', name: 'Workflow', description: '', nodes: [
    { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
    { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 300, y: 0 } },
  ], edges: [{ id: 'edge', source: 'input', target: 'output' }] })
  const service = new WorkflowRunService({ workflowStore, runStore: store, workflowRoot: dir,
    resolveReleasedWorkflow: (id) => releases.get(id),
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
  await service.initialize()
  return { dir, store, workflowStore, workflow, service, releases }
}

async function waitFor(read: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (read()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('run did not settle')
}

describe('bounded durable workflow admission', () => {
  it('serializes concurrent starts and returns duplicates even when full', async () => {
    const { dir, store } = await fixture(2, 2)
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.enqueue(run(`${i}`, 'a'))))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject(full)
    const before = await readFile(join(dir, 'workflow-runs.json'), 'utf8')
    const original = store.list()[0]!
    original.idempotencyKey = 'same'
    await store.save(original)
    expect((await store.enqueue(run('duplicate', 'a', { idempotencyKey: 'same' }))).id).toBe(original.id)
    expect(store.list()).toHaveLength(2)
    expect(before).toBeTruthy()
    const persisted = await readFile(join(dir, 'workflow-runs.json'), 'utf8')
    await expect(store.enqueue(run('rejected', 'b'))).rejects.toMatchObject(full)
    expect(await readFile(join(dir, 'workflow-runs.json'), 'utf8')).toBe(persisted)
  })

  it('enforces environment and shared local buckets, including direct save and bucket changes', async () => {
    const { store } = await fixture(5, 1)
    await store.save(run('a', 'a', { status: 'running' }))
    await expect(store.save(run('a2', 'a'))).rejects.toMatchObject(full)
    await store.enqueue(run('local1'))
    await expect(store.enqueue(run('local2'))).rejects.toMatchObject(full)
    await store.save(run('b', 'b', { status: 'waiting-approval' }))
    await expect(store.save(run('b', 'a'))).rejects.toMatchObject(full)
    expect(store.get('b')?.environmentId).toBe('b')
    await store.save(run('paused', 'a', { status: 'paused' }))
    await store.save(run('terminal', 'a', { status: 'completed' }))
    await expect(store.save(run('paused', 'a'))).rejects.toMatchObject(full)
  })

  it('retains over-limit legacy runs and lets counted states drain without readmission', async () => {
    const { dir } = await fixture()
    await writeFile(join(dir, 'workflow-runs.json'), JSON.stringify([run('a'), run('b'), run('c')]))
    const store = new WorkflowRunStore(dir, { global: 1, perEnvironment: 1 })
    await store.initialize()
    expect(store.list()).toHaveLength(3)
    await store.save(run('a', undefined, { status: 'running' }))
    await store.save(run('a', undefined, { status: 'waiting-approval' }))
    await store.save(run('a'))
    await expect(store.enqueue(run('new'))).rejects.toMatchObject(full)
    for (const id of ['a', 'b', 'c']) await store.save(run(id, undefined, { status: 'completed' }))
    await expect(store.enqueue(run('new'))).resolves.toMatchObject({ id: 'new' })
  })

  it('exposes aggregate and selected bucket metrics without other environment identities', async () => {
    const { store } = await fixture(5, 2)
    await store.save(run('a', 'selected', { status: 'running' }))
    await store.save(run('b', 'private-customer', { status: 'waiting-approval' }))
    await store.save(run('c', 'selected'))
    await store.save(run('d', 'selected', { status: 'paused' }))
    const snapshot = store.queueSnapshot('selected')
    expect(snapshot.global).toMatchObject({ capacity: 5, admitted: 3, queued: 1, running: 1, waitingApproval: 1, availableSlots: 2, overCapacity: false })
    expect(snapshot.environment).toMatchObject({ capacity: 2, admitted: 2, availableSlots: 0 })
    expect(JSON.stringify(snapshot)).not.toContain('private-customer')
    snapshot.global.admitted = 999
    expect(store.queueSnapshot('selected').global.admitted).toBe(3)
  })

  it('uses conservative defaults and rejects invalid Main configuration', async () => {
    const { dir } = await fixture()
    const defaults = new WorkflowRunStore(dir).queueSnapshot()
    expect(defaults.global.capacity).toBe(1000)
    expect(defaults.environment.capacity).toBe(100)
    for (const value of [0, -1, 1.1, Infinity, NaN, '100', null]) {
      expect(() => new WorkflowRunStore(dir, { global: value as number, perEnvironment: 1 })).toThrow('WORKFLOW_RUN_QUEUE_CONFIG_INVALID')
      expect(() => new WorkflowRunStore(dir, { global: 1, perEnvironment: value as number })).toThrow('WORKFLOW_RUN_QUEUE_CONFIG_INVALID')
    }
  })
})

describe('persistent fair local claims', () => {
  it('rotates due environments across restart and orders each bucket by due/enqueue/id', async () => {
    const { dir, store } = await fixture(20, 10)
    for (const record of [run('a2', 'a'), run('a1', 'a'), run('b1', 'b'), run('local')]) await store.enqueue(record)
    const first = await store.claimNextDue('worker', 5000, new Date(NOW))
    const restarted = new WorkflowRunStore(dir, { global: 20, perEnvironment: 10 })
    const second = await restarted.claimNextDue('worker', 5000, new Date(NOW))
    const third = await restarted.claimNextDue('worker', 5000, new Date(NOW))
    expect(new Set([first?.environmentId, second?.environmentId, third?.environmentId]).size).toBe(3)
    expect([first?.id, second?.id, third?.id]).toContain('a1')
    expect((await restarted.claimNextDue('worker', 5000, new Date(NOW)))?.id).toBe('a2')
  })

  it('skips delayed buckets, handles arrivals, and uses enqueue time to break due ties', async () => {
    const { store } = await fixture(20, 10)
    await store.enqueue(run('a', 'a'))
    await store.enqueue(run('later', 'b', { queue: { enqueuedAt: NOW, availableAt: '2026-09-12T11:00:00.000Z' } }))
    expect((await store.claimNextDue('worker', 5000, new Date(NOW)))?.id).toBe('a')
    await store.enqueue(run('a2', 'a'))
    await store.enqueue(run('z-older', 'c', { queue: { enqueuedAt: '2026-09-12T09:00:00.000Z', availableAt: NOW } }))
    await store.enqueue(run('a-newer', 'c'))
    expect((await store.claimNextDue('worker', 5000, new Date(NOW)))?.id).toBe('z-older')
    expect((await store.claimNextDue('worker', 5000, new Date(NOW)))?.id).toBe('a2')
    expect((await store.claimNextDue('worker', 5000, new Date(NOW)))?.id).toBe('a-newer')
    expect(await store.claimNextDue('worker', 5000, new Date(NOW))).toBeUndefined()
    expect((await store.claimNextDue('worker', 5000, new Date('2026-09-12T11:00:00.000Z')))?.id).toBe('later')
  })

  it('rolls back a failed cursor/claim write in memory and on disk', async () => {
    const { dir, store } = await fixture(10, 5)
    for (const record of [run('a1', 'a'), run('a2', 'a'), run('b', 'b')]) await store.enqueue(record)
    await store.claimNextDue('worker', 5000, new Date(NOW))
    const before = await readFile(join(dir, 'workflow-runs.json'), 'utf8')
    const spy = vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('disk failed'))
    await expect(store.claimNextDue('worker', 5000, new Date(NOW))).rejects.toThrow('disk failed')
    spy.mockRestore()
    expect(await readFile(join(dir, 'workflow-runs.json'), 'utf8')).toBe(before)
    expect(store.get('b')?.status).toBe('queued')
    expect((await store.claimNextDue('worker', 5000, new Date(NOW)))?.id).toBe('b')
    const restored = new WorkflowRunStore(dir)
    await restored.initialize()
    expect(restored.get('b')?.status).toBe('running')
  })

  it('migrates legacy arrays on write and refuses unknown schema without overwriting', async () => {
    const { dir } = await fixture()
    const path = join(dir, 'workflow-runs.json')
    await writeFile(path, JSON.stringify([run('legacy')]))
    const migrated = new WorkflowRunStore(dir)
    await migrated.claimNextDue('worker', 5000, new Date(NOW))
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 1, runs: [{ id: 'legacy' }] })
    const future = JSON.stringify({ schemaVersion: 999, runs: [run('future')] })
    await writeFile(path, future)
    const unsupported = new WorkflowRunStore(dir)
    await expect(unsupported.initialize()).rejects.toThrow('WORKFLOW_RUN_STORE_SCHEMA_UNSUPPORTED')
    await expect(unsupported.enqueue(run('new'))).rejects.toThrow('WORKFLOW_RUN_STORE_SCHEMA_UNSUPPORTED')
    expect(await readFile(path, 'utf8')).toBe(future)
  })
})

describe('service queue boundary', () => {
  it('uses the immutable release environment for admission and keeps duplicate starts available', async () => {
    const { store, service, workflow, releases } = await serviceFixture(3, 1)
    const release: WorkflowRelease = { id: 'release', environmentId: 'customer', workflowId: workflow.id, workflowRevision: workflow.revision,
      workflowSnapshot: workflow, contentSha256: '', status: 'published', connectorGrants: [], createdAt: NOW, publishedAt: NOW }
    release.contentSha256 = computeWorkflowReleaseSha256(release)
    releases.set(release.id, release)
    try {
      await store.save(run('existing', release.environmentId, { releaseId: release.id, workflowRevision: workflow.revision, idempotencyKey: 'same', status: 'waiting-approval' }))
      expect((await service.startReleased(release.id, null, { idempotencyKey: 'same' })).id).toBe('existing')
      await expect(service.startReleased(release.id, null, { environmentId: 'different', queueCapacity: 9999 } as never)).rejects.toMatchObject(full)
      expect(store.queueSnapshot(release.environmentId).environment.admitted).toBe(1)
      expect(store.list()).toHaveLength(1)
    } finally { await service.stop() }
  })

  it.each(['resume', 'reconcile'] as const)('leaves %s records, disk and observer events unchanged when full', async (operation) => {
    const { dir, store, service } = await serviceFixture()
    try {
      await store.save(run('occupied', undefined, { queue: { enqueuedAt: NOW, availableAt: '2999-01-01T00:00:00.000Z' }, origin: { kind: 'top-level' } }))
      await store.save(run('paused', undefined, { status: 'paused', origin: { kind: 'top-level' }, nodeStates: operation === 'resume' ? [] : [{ nodeId: 'output', status: 'failed', effectState: 'unknown' }] }))
      const before = store.get('paused')
      const disk = await readFile(join(dir, 'workflow-runs.json'), 'utf8')
      const observed = vi.fn()
      service.watch(observed)
      await expect(operation === 'resume' ? service.resume('paused') : service.reconcileEffect('paused', { nodeId: 'output', outcome: 'not-dispatched', note: 'Verified no dispatch' })).rejects.toMatchObject(full)
      expect(store.get('paused')).toEqual(before)
      expect(await readFile(join(dir, 'workflow-runs.json'), 'utf8')).toBe(disk)
      expect(observed).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })

  it.each([true, false])('fails a capacity-rejected child without unknown effects or leaked lineage (wait=%s)', async (waitForCompletion) => {
    const { store, service, workflow, workflowStore } = await serviceFixture()
    const parent = await workflowStore.create({ name: 'parent', description: '', nodes: [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'sub', type: 'sub-workflow', label: 'Sub', config: { workflowId: workflow.id, waitForCompletion }, retryPolicy: { mode: 'idempotent', maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, position: { x: 150, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 300, y: 0 } },
    ], edges: [{ id: 'e1', source: 'input', target: 'sub' }, { id: 'e2', source: 'sub', target: 'output' }] })
    try {
      const started = await service.start(parent.id, null)
      await waitFor(() => ['failed', 'paused', 'completed'].includes(service.get(started.id)!.status))
      const result = service.get(started.id)!
      expect(result.status).toBe('failed')
      expect(result.error).toContain('WORKFLOW_RUN_QUEUE_FULL')
      expect(result.nodeStates.find((state) => state.nodeId === 'sub')).toMatchObject({ effectState: 'none', attempt: 1 })
      expect(result.events.some((event) => event.type === 'node-retry')).toBe(false)
      expect(store.list(workflow.id)).toHaveLength(0)
      expect((service as unknown as { liveLineages: Map<string, readonly string[]> }).liveLineages.size).toBe(0)
    } finally { await service.stop() }
  })

  it('includes only selected bucket plus global counts in operational health', async () => {
    const { store, service } = await serviceFixture(5)
    try {
      for (const [id, env] of [['a', 'selected'], ['b', 'private-other']]) await store.save(run(id!, env, { status: 'waiting-approval' }))
      const getOperations = vi.fn((environmentId?: string) => service.operationsSnapshot(environmentId))
      const health = new WorkflowOperationalHealthService({ getRunServiceOperations: getOperations, resolveEnvironment: () => undefined,
        listReleases: () => [], listReleaseIntegrityFailures: () => [], listRuns: () => store.list(), listObservations: () => [] })
      const snapshot = health.getOperationalHealth({ workflowId: 'workflow', environmentId: 'selected' })
      expect(getOperations).toHaveBeenCalledWith('selected')
      expect(snapshot.queue?.global.admitted).toBe(2)
      expect(snapshot.queue?.environment.admitted).toBe(1)
      expect(JSON.stringify(snapshot)).not.toContain('private-other')
    } finally { await service.stop() }
  })

  it('keeps approval in its admitted slot and admits a new run only after settlement', async () => {
    const { store, service, workflowStore } = await serviceFixture()
    const workflow = await workflowStore.create({ name: 'approval', description: '', nodes: [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'approval', type: 'approval', label: 'Approve', config: { message: 'Confirm' }, position: { x: 150, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 300, y: 0 } },
    ], edges: [{ id: 'e1', source: 'input', target: 'approval' }, { id: 'e2', source: 'approval', target: 'output' }] })
    try {
      const started = await service.start(workflow.id, null)
      await waitFor(() => service.get(started.id)!.status === 'waiting-approval')
      expect(store.queueSnapshot().global).toMatchObject({ admitted: 1, waitingApproval: 1, availableSlots: 0 })
      await expect(service.start(workflow.id, null)).rejects.toMatchObject(full)
      await service.approve(started.id, true)
      await waitFor(() => service.get(started.id)!.status === 'completed')
      expect(store.queueSnapshot().global.admitted).toBe(0)
      await expect(service.start(workflow.id, null)).resolves.toMatchObject({ status: 'queued' })
    } finally { await service.stop() }
  })

  it('does not mark a never-created compensation child as an unknown effect', async () => {
    const { store, service, workflow, workflowStore } = await serviceFixture()
    const source = await workflowStore.create({ ...workflow, id: 'source', name: 'source' })
    try {
      await store.save(run('occupied', undefined, { status: 'waiting-approval' }))
      await store.save(run('source-run', undefined, { workflowId: source.id, workflowRevision: source.revision, status: 'failed',
        compensationStack: [{ sourceNodeId: 'output', status: 'pending', action: { workflowId: workflow.id, workflowRevision: workflow.revision } }] }))
      const result = await service.compensate('source-run')
      expect(result.compensationStack?.[0]).toMatchObject({ status: 'failed', effectState: 'none', error: expect.stringContaining('WORKFLOW_RUN_QUEUE_FULL') })
      expect(result.compensationBlocker).toBeUndefined()
      expect(result.events.some((event) => event.type === 'compensation-effect-unknown')).toBe(false)
      expect(store.list(workflow.id).filter((record) => record.id !== 'occupied')).toHaveLength(0)
      expect((service as unknown as { liveLineages: Map<string, readonly string[]> }).liveLineages.size).toBe(0)
    } finally { await service.stop() }
  })
})
