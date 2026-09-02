import { mkdtemp } from 'node:fs/promises'
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

describe('workflow safe execution store', () => {
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
