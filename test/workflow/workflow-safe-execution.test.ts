import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowRunWorker } from '../../src/main/workflow/workflow-run-worker.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

interface QueueStore {
  enqueue(record: WorkflowRunRecord): Promise<WorkflowRunRecord>
  claimNextDue(ownerId: string, leaseMs: number, now?: Date): Promise<WorkflowRunRecord | undefined>
  recoverInterruptedRuns(now?: Date, force?: boolean): Promise<WorkflowRunRecord[]>
  renewLease(runId: string, ownerId: string, leaseMs: number, now?: Date): Promise<WorkflowRunRecord | undefined>
  releaseLease(runId: string, ownerId: string): Promise<boolean>
  requestCancellation(runId: string, now?: Date): Promise<WorkflowRunRecord | undefined>
}

function queuedRecord(id: string, idempotencyKey?: string): WorkflowRunRecord {
  return {
    id,
    workflowId: 'workflow-publish',
    workflowRevision: 1,
    status: 'queued',
    input: { customerId: 'customer-42' },
    nodeStates: [],
    events: [],
    allowShellFile: false,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  } as unknown as WorkflowRunRecord
}

function rejectNextPersist(store: WorkflowRunStore, message = 'ENOSPC'): void {
  vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist')
    .mockRejectedValueOnce(Object.assign(new Error(message), { code: 'ENOSPC' }))
}

describe('workflow safe execution store', () => {
  it('rolls back enqueue when persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-persist-failure-'))
    const store = new WorkflowRunStore(directory)
    await store.initialize()
    const beforeList = store.list()
    const beforeRun = store.get('run-enqueue-failure')
    rejectNextPersist(store)

    await expect(store.enqueue(queuedRecord('run-enqueue-failure'))).rejects.toThrow('ENOSPC')

    expect(store.list()).toEqual(beforeList)
    expect(store.get('run-enqueue-failure')).toEqual(beforeRun)
  })

  it('rolls back save when persistence fails and accepts the next mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-persist-failure-'))
    const store = new WorkflowRunStore(directory)
    const record = await store.enqueue(queuedRecord('run-save-failure'))
    const beforeList = store.list()
    const beforeRun = store.get(record.id)
    rejectNextPersist(store)

    await expect(store.save({ ...record, output: 'uncommitted-output' })).rejects.toThrow('ENOSPC')

    expect(store.list()).toEqual(beforeList)
    expect(store.get(record.id)).toEqual(beforeRun)
    await expect(store.save({ ...record, output: 'committed-output' })).resolves.toMatchObject({ output: 'committed-output' })
  })

  it('rolls back claimNextDue when persistence fails in memory and on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-persist-failure-'))
    const store = new WorkflowRunStore(directory)
    const record = await store.enqueue(queuedRecord('run-claim-failure'))
    const beforeList = store.list()
    const beforeRun = store.get(record.id)
    rejectNextPersist(store)

    await expect(store.claimNextDue('worker-left', 10_000)).rejects.toThrow('ENOSPC')

    expect(store.list()).toEqual(beforeList)
    expect(store.get(record.id)).toEqual(beforeRun)
    const diskStore = new WorkflowRunStore(directory)
    await diskStore.initialize()
    expect(diskStore.get(record.id)).toMatchObject({ status: 'queued' })
    expect(diskStore.get(record.id)?.queue?.lease).toBeUndefined()
  })

  it('rolls back renewLease when persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-persist-failure-'))
    const store = new WorkflowRunStore(directory)
    const record = queuedRecord('run-renew-failure')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await store.enqueue(record)
    await store.claimNextDue('worker-left', 2_000, new Date('2026-01-01T00:00:00.000Z'))
    const beforeList = store.list()
    const beforeRun = store.get(record.id)
    rejectNextPersist(store)

    await expect(store.renewLease(record.id, 'worker-left', 10_000, new Date('2026-01-01T00:00:01.000Z'))).rejects.toThrow('ENOSPC')

    expect(store.list()).toEqual(beforeList)
    expect(store.get(record.id)).toEqual(beforeRun)
  })

  it('rolls back releaseLease when persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-persist-failure-'))
    const store = new WorkflowRunStore(directory)
    const record = queuedRecord('run-release-failure')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await store.enqueue(record)
    await store.claimNextDue('worker-left', 2_000, new Date('2026-01-01T00:00:00.000Z'))
    const beforeList = store.list()
    const beforeRun = store.get(record.id)
    rejectNextPersist(store)

    await expect(store.releaseLease(record.id, 'worker-left')).rejects.toThrow('ENOSPC')

    expect(store.list()).toEqual(beforeList)
    expect(store.get(record.id)).toEqual(beforeRun)
  })

  it('rejects malformed persisted loop checkpoints before recovery traverses them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-loop-malformed-'))
    await writeFile(join(dir, 'workflow-runs.json'), JSON.stringify([{ ...queuedRecord('malformed-loop'), nodeStates: [{ nodeId: 'loop', status: 'pending', loopIterations: [{ iterationId: 'x', iterationIndex: 0, input: 'A', status: 'running', nodeStates: null }] }] }]))
    const store = new WorkflowRunStore(dir)
    await store.initialize()
    expect(store.get('malformed-loop')).toBeUndefined()
  })

  it.each(['prepared', 'dispatched', 'confirmed', 'unknown'])('pauses recovery for nested %s loop effects', async (effectState) => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-loop-recovery-'))
    const store = new WorkflowRunStore(dir)
    const record = queuedRecord('nested-effect')
    record.nodeStates = [{ nodeId: 'loop', status: 'running', loopIterations: [{ iterationId: 'iteration-0', iterationIndex: 0, input: 'A', status: 'running', nodeStates: [{ nodeId: 'body', status: 'running', effectState }] }] }] as any
    await store.enqueue(record)
    await store.claimNextDue('worker', 2_000)
    const disk = new WorkflowRunStore(dir)
    const recovered = await disk.recoverInterruptedRuns(new Date(), true)
    expect(recovered[0]?.status).toBe('paused')
    expect((recovered[0]?.nodeStates[0] as any).loopIterations[0].nodeStates[0].effectState).toBe('unknown')
  })

  it('releases a lost lease without replaying a nested dispatched effect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-loop-lease-loss-'))
    const store = new WorkflowRunStore(dir)
    const record = queuedRecord('nested-lost-lease')
    record.nodeStates = [{ nodeId: 'loop', status: 'pending', loopIterations: [{ iterationId: 'iteration-0', iterationIndex: 0, input: 'A', status: 'running', nodeStates: [{ nodeId: 'body', status: 'running', effectState: 'dispatched' }] }] }]
    await store.enqueue(record)
    await store.claimNextDue('worker', 2_000)
    await store.releaseLease(record.id, 'worker', true)
    expect(store.get(record.id)?.status).toBe('paused')
    expect(store.get(record.id)?.nodeStates[0]?.loopIterations?.[0]?.nodeStates[0]?.effectState).toBe('unknown')
  })

  it('preserves completed effect checkpoints while requeueing an unfinished read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-loop-completed-effect-'))
    const store = new WorkflowRunStore(dir)
    const record = queuedRecord('nested-completed')
    record.nodeStates = [{ nodeId: 'loop', status: 'pending', loopIterations: [{ iterationId: 'iteration-0', iterationIndex: 0, input: 'A', status: 'running', nodeStates: [{ nodeId: 'write', status: 'completed', effectState: 'confirmed', output: 'saved-A' }, { nodeId: 'read', status: 'running' }] }] }]
    await store.enqueue(record)
    await store.claimNextDue('worker', 2_000)
    const disk = new WorkflowRunStore(dir)
    const [recovered] = await disk.recoverInterruptedRuns(new Date(), true)
    expect(recovered?.status).toBe('queued')
    expect(recovered?.nodeStates[0]?.loopIterations?.[0]?.nodeStates).toEqual([{ nodeId: 'write', status: 'completed', effectState: 'confirmed', output: 'saved-A' }, { nodeId: 'read', status: 'pending' }])
  })

  it('returns the existing run for the same explicit idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore

    const first = await store.enqueue(queuedRecord('run-first', 'publish-42'))
    const second = await store.enqueue(queuedRecord('run-second', 'publish-42'))

    expect(second.id).toBe(first.id)
  })

  it('deduplicates the same explicit idempotency key under concurrent submits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const runStore = new WorkflowRunStore(directory)
    await runStore.initialize()
    const store = runStore as unknown as QueueStore

    const [first, second] = await Promise.all([
      store.enqueue(queuedRecord('run-first', 'publish-42')),
      store.enqueue(queuedRecord('run-second', 'publish-42')),
    ])

    expect(second.id).toBe(first.id)
  })

  it('does not deduplicate explicit idempotency keys across different release or environment contexts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore

    const first = await store.enqueue({
      ...queuedRecord('run-release-a', 'publish-42'),
      environmentId: 'customer-acme-staging',
      releaseId: 'release-a',
      traceId: 'trace-a',
    })
    const differentRelease = await store.enqueue({
      ...queuedRecord('run-release-b', 'publish-42'),
      environmentId: 'customer-acme-staging',
      releaseId: 'release-b',
      traceId: 'trace-b',
    })
    const differentEnvironment = await store.enqueue({
      ...queuedRecord('run-release-c', 'publish-42'),
      environmentId: 'customer-acme-prod',
      releaseId: 'release-a',
      traceId: 'trace-c',
    })

    expect(differentRelease.id).toBe('run-release-b')
    expect(differentEnvironment.id).toBe('run-release-c')
    expect(differentRelease.id).not.toBe(first.id)
    expect(differentEnvironment.id).not.toBe(first.id)
  })

  it('allows exactly one worker to claim a due queued run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    await store.enqueue(queuedRecord('run-first'))

    const [left, right] = await Promise.all([
      store.claimNextDue('worker-left', 10_000),
      store.claimNextDue('worker-right', 10_000),
    ])
    const claimed = [left, right].filter((record): record is WorkflowRunRecord => record !== undefined)

    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('running')
    expect(claimed[0]).toMatchObject({ queue: { lease: { ownerId: expect.stringMatching(/^worker-/u) } } })
  })

  it('requeues an expired lease when no external effect was dispatched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    const record = queuedRecord('run-first')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await store.enqueue(record)
    await store.claimNextDue('worker-left', 1_000, new Date('2026-01-01T00:00:00.000Z'))

    const recovered = await store.recoverInterruptedRuns(new Date('2026-01-01T00:00:02.000Z'))

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: 'run-first', status: 'queued' })
    expect(recovered[0]?.queue?.lease).toBeUndefined()
  })

  it('reclaims a queue lease left by a previous process even before its wall-clock expiry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory)
    const record = queuedRecord('run-restart')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await store.enqueue(record)
    await store.claimNextDue('old-process', 60_000, new Date('2026-01-01T00:00:00.000Z'))

    const recovered = await store.recoverInterruptedRuns(new Date('2026-01-01T00:00:01.000Z'), true)

    expect(recovered).toMatchObject([{ id: 'run-restart', status: 'queued' }])
    expect(recovered[0]?.queue?.lease).toBeUndefined()
  })

  it('pauses an expired lease when a dispatched external effect is uncertain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    const record = queuedRecord('run-http')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    record.nodeStates = [{ nodeId: 'http', status: 'running', effectState: 'dispatched' }] as unknown as WorkflowRunRecord['nodeStates']
    await store.enqueue(record)
    await store.claimNextDue('worker-left', 1_000, new Date('2026-01-01T00:00:00.000Z'))

    const recovered = await store.recoverInterruptedRuns(new Date('2026-01-01T00:00:02.000Z'))

    expect(recovered[0]).toMatchObject({
      id: 'run-http',
      status: 'paused',
      nodeStates: [{ nodeId: 'http', status: 'cancelled', effectState: 'unknown' }],
    })
  })

  it('does not replay a confirmed external effect whose output checkpoint is incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    const record = queuedRecord('run-confirmed')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    record.nodeStates = [{ nodeId: 'http', status: 'running', effectState: 'confirmed' }] as unknown as WorkflowRunRecord['nodeStates']
    await store.enqueue(record)
    await store.claimNextDue('worker-left', 1_000, new Date('2026-01-01T00:00:00.000Z'))

    const recovered = await store.recoverInterruptedRuns(new Date('2026-01-01T00:00:02.000Z'))

    expect(recovered[0]).toMatchObject({
      id: 'run-confirmed',
      status: 'paused',
      nodeStates: [{ nodeId: 'http', status: 'cancelled', effectState: 'unknown' }],
    })
  })

  it('renews and releases only a lease owned by the claiming worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    const record = queuedRecord('run-first')
    record.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await store.enqueue(record)
    await store.claimNextDue('worker-left', 1_000, new Date('2026-01-01T00:00:00.000Z'))

    const renewed = await store.renewLease('run-first', 'worker-left', 5_000, new Date('2026-01-01T00:00:01.000Z'))
    const rejected = await store.renewLease('run-first', 'worker-right', 5_000, new Date('2026-01-01T00:00:01.000Z'))

    expect(renewed?.queue?.lease?.ownerId).toBe('worker-left')
    expect(renewed?.queue?.lease?.expiresAt).toBe('2026-01-01T00:00:06.000Z')
    expect(rejected).toBeUndefined()
    expect(await store.releaseLease('run-first', 'worker-right')).toBe(false)
    expect(await store.releaseLease('run-first', 'worker-left')).toBe(true)
    expect((store as unknown as { get(id: string): WorkflowRunRecord | undefined }).get('run-first')?.queue?.lease).toBeUndefined()
  })

  it('does not let a stale checkpoint overwrite a newer lease heartbeat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const runStore = new WorkflowRunStore(directory)
    const queued = queuedRecord('run-heartbeat')
    queued.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await runStore.enqueue(queued)
    const claimed = await runStore.claimNextDue('worker-left', 1_000, new Date('2026-01-01T00:00:00.000Z'))
    expect(claimed?.queue?.lease?.expiresAt).toBe('2026-01-01T00:00:02.000Z')
    await runStore.renewLease('run-heartbeat', 'worker-left', 5_000, new Date('2026-01-01T00:00:01.000Z'))
    await runStore.save({ ...claimed!, events: [...(claimed?.events ?? []), { id: 'stale', time: '2026-01-01T00:00:01.100Z', type: 'node-started', message: 'stale checkpoint' }] })

    expect(runStore.get('run-heartbeat')?.queue?.lease?.expiresAt).toBe('2026-01-01T00:00:06.000Z')
  })

  it('does not let a stale worker reintroduce a lease after it was released', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const runStore = new WorkflowRunStore(directory)
    const queued = queuedRecord('run-stale-owner')
    queued.queue = { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z' }
    await runStore.enqueue(queued)
    const claimed = await runStore.claimNextDue('worker-left', 5_000, new Date('2026-01-01T00:00:00.000Z'))
    await runStore.releaseLease('run-stale-owner', 'worker-left')
    await runStore.save(cloneWithEvent(claimed!))

    expect(runStore.get('run-stale-owner')?.queue?.lease).toBeUndefined()
  })

  it('cancels an unclaimed queued run durably', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    await store.enqueue(queuedRecord('run-first'))

    const cancelled = await store.requestCancellation('run-first', new Date('2026-01-01T00:00:02.000Z'))

    expect(cancelled).toMatchObject({ id: 'run-first', status: 'cancelled', error: '用户取消了运行' })
    expect(cancelled?.completedAt).toBe('2026-01-01T00:00:02.000Z')
  })

  it('fails closed when an in-memory queue record has malformed availability metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory) as unknown as QueueStore
    await store.enqueue({
      ...queuedRecord('run-malformed-queue'),
      queue: { enqueuedAt: '2026-01-01T00:00:00.000Z', availableAt: 'not-a-date' },
    } as unknown as WorkflowRunRecord)

    expect(await store.claimNextDue('worker', 10_000, new Date('2026-01-02T00:00:00.000Z'))).toBeUndefined()
  })

  it('claims a persisted record and runs it once after the worker wakes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory)
    await store.enqueue(queuedRecord('run-first'))
    let executions = 0
    const executeClaimedRun = async (): Promise<void> => { executions += 1 }
    const workerPath = '../../src/main/workflow/workflow-run-worker.js'
    const workerModule = await import(/* @vite-ignore */ workerPath) as {
      WorkflowRunWorker: new (options: {
        store: WorkflowRunStore
        ownerId: string
        leaseMs?: number
        executeClaimedRun: (runId: string, lease: NonNullable<WorkflowRunRecord['queue']>['lease']) => Promise<void>
      }) => { start(): Promise<void>; wake(): void; stop(): Promise<void> }
    }
    const worker = new workerModule.WorkflowRunWorker({ store, ownerId: 'test-worker', leaseMs: 100, executeClaimedRun })
    await worker.start()
    worker.wake()
    for (let attempt = 0; attempt < 100 && store.get('run-first')?.queue?.lease !== undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    await worker.stop()

    expect(executions).toBe(1)
    expect(store.get('run-first')?.queue?.lease).toBeUndefined()
    expect(store.get('run-first')?.status).toBe('running')
  })

  it('retries a failed claim without an external wake or unhandled rejection', async () => {
    vi.useFakeTimers()
    const claimError = new Error('transient claim failure')
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
    process.on('unhandledRejection', onUnhandledRejection)
    const claimed = queuedRecord('run-after-claim-failure')
    claimed.status = 'running'
    claimed.queue = {
      enqueuedAt: '2026-01-01T00:00:00.000Z',
      availableAt: '2026-01-01T00:00:00.000Z',
      lease: {
        ownerId: 'retry-worker',
        claimedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:01:00.000Z',
      },
    }
    const claimNextDue = vi.fn()
      .mockRejectedValueOnce(claimError)
      .mockResolvedValueOnce(claimed)
      .mockResolvedValue(undefined)
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
      renewLease: vi.fn(),
      releaseLease: vi.fn().mockResolvedValue(true),
    } as unknown as WorkflowRunStore
    const executeClaimedRun = vi.fn().mockResolvedValue(undefined)
    const onWorkerError = vi.fn().mockRejectedValue(new Error('observer failure'))
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'retry-worker',
      pollIntervalMs: 25,
      executeClaimedRun,
      onWorkerError,
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(25)
      await worker.stop()

      expect(claimNextDue).toHaveBeenCalledTimes(3)
      expect(executeClaimedRun).toHaveBeenCalledTimes(1)
      expect(onWorkerError).toHaveBeenCalledOnce()
      expect(onWorkerError).toHaveBeenCalledWith(claimError)
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      vi.useRealTimers()
    }
  })

  it('does not retry a failed claim after stop', async () => {
    vi.useFakeTimers()
    const claimNextDue = vi.fn().mockRejectedValue(new Error('persistent claim failure'))
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'stopping-worker',
      pollIntervalMs: 25,
      executeClaimedRun: vi.fn(),
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(claimNextDue).toHaveBeenCalledOnce()

      await worker.stop()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(claimNextDue).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets claim backoff after a successful empty poll', async () => {
    vi.useFakeTimers()
    const claimNextDue = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('failure after empty poll'))
      .mockResolvedValue(undefined)
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'resetting-worker',
      pollIntervalMs: 25,
      executeClaimedRun: vi.fn(),
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(74)
      expect(claimNextDue).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(1)
      expect(claimNextDue).toHaveBeenCalledTimes(4)
      await worker.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces an idle poll timer with claim backoff after an external wake', async () => {
    vi.useFakeTimers()
    const claimNextDue = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('claim failed after external wake'))
      .mockResolvedValue(undefined)
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'timer-worker',
      pollIntervalMs: 100,
      executeClaimedRun: vi.fn(),
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(10)
      worker.wake()
      await vi.advanceTimersByTimeAsync(90)
      expect(claimNextDue).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(10)
      expect(claimNextDue).toHaveBeenCalledTimes(3)
    } finally {
      await worker.stop()
      vi.useRealTimers()
    }
  })

  it('does not let repeated external wakes bypass claim failure backoff', async () => {
    vi.useFakeTimers()
    const claimNextDue = vi.fn()
      .mockRejectedValueOnce(new Error('claim failure'))
      .mockResolvedValue(undefined)
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'backoff-worker',
      pollIntervalMs: 100,
      executeClaimedRun: vi.fn(),
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(10)
      worker.wake()
      worker.wake()
      await vi.advanceTimersByTimeAsync(89)
      worker.wake()
      await vi.advanceTimersByTimeAsync(0)

      expect(claimNextDue).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(1)
      expect(claimNextDue).toHaveBeenCalledTimes(2)
    } finally {
      await worker.stop()
      vi.useRealTimers()
    }
  })

  it('grows consecutive claim backoff by 1x, 2x, and 4x before capping at 30 seconds', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const claimTimes: number[] = []
    const claimNextDue = vi.fn(async () => {
      claimTimes.push(Date.now() - startedAt)
      throw new Error('persistent claim failure')
    })
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'bounded-backoff-worker',
      pollIntervalMs: 1_000,
      executeClaimedRun: vi.fn(),
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(91_000)

      expect(claimTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000])
    } finally {
      await worker.stop()
      vi.useRealTimers()
    }
  })

  it('does not schedule a retry when stopped while claim is pending', async () => {
    vi.useFakeTimers()
    let rejectClaim: ((error: unknown) => void) | undefined
    const claimNextDue = vi.fn(() => new Promise<WorkflowRunRecord | undefined>((_resolve, reject) => {
      rejectClaim = reject
    }))
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'pending-claim-worker',
      pollIntervalMs: 25,
      executeClaimedRun: vi.fn(),
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(0)
      const stopPromise = worker.stop()
      rejectClaim?.(new Error('claim failed during stop'))
      await stopPromise
      await vi.advanceTimersByTimeAsync(60_000)

      expect(claimNextDue).toHaveBeenCalledOnce()
    } finally {
      rejectClaim?.(new Error('test cleanup'))
      await worker.stop()
      vi.useRealTimers()
    }
  })

  it('does not schedule a retry when stopped while onWorkerError is pending', async () => {
    vi.useFakeTimers()
    let resolveWorkerError: (() => void) | undefined
    const claimNextDue = vi.fn().mockRejectedValue(new Error('claim failed before stop'))
    const onWorkerError = vi.fn(() => new Promise<void>((resolve) => {
      resolveWorkerError = resolve
    }))
    const store = {
      claimNextDue,
      nextDueAt: vi.fn(() => undefined),
    } as unknown as WorkflowRunStore
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'pending-observer-worker',
      pollIntervalMs: 25,
      executeClaimedRun: vi.fn(),
      onWorkerError,
    })

    try {
      await worker.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onWorkerError).toHaveBeenCalledOnce()
      const stopPromise = worker.stop()
      resolveWorkerError?.()
      await stopPromise
      await vi.advanceTimersByTimeAsync(60_000)

      expect(claimNextDue).toHaveBeenCalledOnce()
    } finally {
      resolveWorkerError?.()
      await worker.stop()
      vi.useRealTimers()
    }
  })

  it('aborts a claimed execution when lease renewal is lost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-safe-execution-'))
    const store = new WorkflowRunStore(directory)
    await store.enqueue(queuedRecord('run-lease-loss'))
    vi.spyOn(store, 'renewLease').mockResolvedValue(undefined)
    let aborted = false
    const worker = new WorkflowRunWorker({
      store,
      ownerId: 'lease-worker',
      leaseMs: 2_000,
      executeClaimedRun: async (_runId, _lease, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) { aborted = true; resolve(); return }
          signal?.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
        })
      },
    })
    await worker.start()
    for (let attempt = 0; attempt < 300 && !aborted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await worker.stop()
    expect(aborted).toBe(true)
    expect(store.get('run-lease-loss')?.status).toBe('queued')
    expect(store.get('run-lease-loss')?.queue?.lease).toBeUndefined()
  })
})

function cloneWithEvent(record: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...record,
    events: [...record.events, { id: 'stale', time: '2026-01-01T00:00:01.000Z', type: 'node-started', message: 'stale checkpoint' }],
  }
}
