import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { cloneWorkflow, type WorkflowRunLease, type WorkflowRunQueueState, type WorkflowRunRecord } from '../../shared/workflow.js'

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tempPath, filePath)
}

function isPersistedRunRecord(value: unknown): value is WorkflowRunRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.workflowId !== 'string' || typeof record.workflowRevision !== 'number' || !Number.isInteger(record.workflowRevision)) return false
  if (!['queued', 'running', 'paused', 'waiting-approval', 'completed', 'failed', 'cancelled'].includes(record.status as string)) return false
  if (!Array.isArray(record.nodeStates) || !Array.isArray(record.events)) return false
  if (!record.nodeStates.every((state) => state && typeof state === 'object' && typeof (state as any).nodeId === 'string' && ['pending', 'running', 'completed', 'skipped', 'failed', 'cancelled'].includes((state as any).status))) return false
  const queue = record.queue
  if (queue !== undefined && !isValidQueueState(queue)) return false
  return true
}

function isValidDateString(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(Date.parse(value))
}

function isValidLease(value: unknown): value is WorkflowRunLease {
  if (value === null || typeof value !== 'object') return false
  const lease = value as Record<string, unknown>
  return typeof lease.ownerId === 'string'
    && lease.ownerId.trim() !== ''
    && typeof lease.claimedAt === 'string'
    && isValidDateString(lease.claimedAt)
    && typeof lease.expiresAt === 'string'
    && isValidDateString(lease.expiresAt)
}

function isValidQueueState(value: unknown): value is WorkflowRunQueueState {
  if (value === null || typeof value !== 'object') return false
  const queue = value as Record<string, unknown>
  if (typeof queue.enqueuedAt !== 'string' || !isValidDateString(queue.enqueuedAt)) return false
  if (typeof queue.availableAt !== 'string' || !isValidDateString(queue.availableAt)) return false
  if (queue.cancellationRequestedAt !== undefined && (typeof queue.cancellationRequestedAt !== 'string' || !isValidDateString(queue.cancellationRequestedAt))) return false
  return queue.lease === undefined || isValidLease(queue.lease)
}

/** A confirmed effect can still have an incomplete local checkpoint (for example,
 * a crash after the remote response but before node output was persisted). It
 * must be reconciled just like a dispatched effect rather than replayed. */
function hasUncertainEffect(state: WorkflowRunRecord['nodeStates'][number]): boolean {
  return state.effectState === 'prepared'
    || state.effectState === 'dispatched'
    || state.effectState === 'unknown'
    || state.effectState === 'confirmed' && state.status !== 'completed'
}

export class WorkflowRunStore {
  private readonly filePath: string
  private readonly runs = new Map<string, WorkflowRunRecord>()
  /** Serializes read-modify-write persistence so concurrent Workflow branches cannot overwrite each other. */
  private mutationChain: Promise<void> = Promise.resolve()
  private initialized = false
  private initializationPromise: Promise<void> | undefined

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'workflow-runs.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        if (Array.isArray(parsed)) {
          for (const value of parsed) {
            if (typeof value !== 'object' || value === null || typeof (value as { id?: unknown }).id !== 'string') continue
            const record = value as WorkflowRunRecord
            if (!isPersistedRunRecord(record)) continue
            this.runs.set(record.id, cloneWorkflow(record))
          }
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      this.initialized = true
    })()
    this.initializationPromise = pending
    try {
      await pending
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined
    }
  }

  async pauseActiveRuns(): Promise<WorkflowRunRecord[]> {
    await this.initialize()
    return this.mutate(async () => {
      const paused: WorkflowRunRecord[] = []
      for (const record of this.runs.values()) {
        if (record.status !== 'queued' && record.status !== 'running') continue
        // Durable queue records are recovered through leases. Only legacy
        // records without queue metadata use the old startup-pause fallback.
        if (record.queue !== undefined) continue
        record.status = 'paused'
        record.error = '应用重启导致运行暂停，可从 Workflow 页面恢复。'
        record.events.push({ id: randomUUID(), time: new Date().toISOString(), type: 'run-paused', message: record.error })
        paused.push(cloneWorkflow(record))
      }
      if (paused.length > 0) await this.persist()
      return paused
    })
  }

  list(workflowId?: string): WorkflowRunRecord[] {
    return Array.from(this.runs.values())
      .filter((record) => workflowId === undefined || record.workflowId === workflowId)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .map((record) => cloneWorkflow(record))
  }

  get(id: string): WorkflowRunRecord | undefined {
    const record = this.runs.get(id)
    return record === undefined ? undefined : cloneWorkflow(record)
  }

  /** Return the next persisted queue availability timestamp for Worker wake-up. */
  nextDueAt(): string | undefined {
    return Array.from(this.runs.values())
      .filter((record) => record.status === 'queued')
      .filter((record) => record.queue === undefined || isValidQueueState(record.queue))
      .map((record) => record.queue?.availableAt)
      .filter((value): value is string => value !== undefined && !Number.isNaN(Date.parse(value)))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0]
  }

  async save(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    await this.initialize()
    const snapshot = cloneWorkflow(record)
    return this.mutate(async () => {
      const current = this.runs.get(snapshot.id)
      const incomingLease = snapshot.queue?.lease
      const currentLease = current?.queue?.lease
      // A worker may renew its lease while the service is still holding an
      // older in-memory record. Preserve the newer expiry, and reject a stale
      // writer after another owner has reclaimed the run.
      if (currentLease !== undefined && incomingLease === undefined) return cloneWorkflow(current!)
      // A stale worker must not reintroduce its old lease after another worker
      // has already released or replaced it. Claims mutate the store directly,
      // so a legitimate newly claimed snapshot never needs this path.
      if (current !== undefined && currentLease === undefined && incomingLease !== undefined) return cloneWorkflow(current)
      if (currentLease !== undefined && incomingLease !== undefined && !sameLeaseIdentity(currentLease, incomingLease)) return cloneWorkflow(current!)
      if (currentLease !== undefined && incomingLease !== undefined && sameLeaseIdentity(currentLease, incomingLease) && Date.parse(currentLease.expiresAt) > Date.parse(incomingLease.expiresAt)) {
        snapshot.queue = { ...(snapshot.queue ?? { enqueuedAt: current?.queue?.enqueuedAt ?? new Date().toISOString(), availableAt: current?.queue?.availableAt ?? new Date().toISOString() }), lease: { ...currentLease } }
      }
      if (current?.queue?.cancellationRequestedAt !== undefined && snapshot.queue?.cancellationRequestedAt === undefined) {
        snapshot.queue = { ...(snapshot.queue ?? { enqueuedAt: current.queue.enqueuedAt, availableAt: current.queue.availableAt }), cancellationRequestedAt: current.queue.cancellationRequestedAt, ...(snapshot.queue?.lease === undefined ? {} : { lease: snapshot.queue.lease }) }
      }
      if (snapshot.status !== 'running' && snapshot.queue !== undefined) delete snapshot.queue.lease
      this.runs.set(snapshot.id, snapshot)
      await this.persist()
      return cloneWorkflow(snapshot)
    })
  }

  /**
   * Persist a queued run, returning an existing run only when the caller
   * explicitly supplied the same idempotency key for the same immutable
   * workflow revision. Never infer equivalence from the input payload.
   */
  async enqueue(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    await this.initialize()
    const idempotencyKey = record.idempotencyKey?.trim()
    const now = new Date().toISOString()
    const snapshot = cloneWorkflow({
      ...record,
      ...(idempotencyKey === undefined || idempotencyKey === '' ? {} : { idempotencyKey }),
      queue: record.queue ?? { enqueuedAt: now, availableAt: now },
    })
    return this.mutate(async () => {
      if (idempotencyKey !== undefined && idempotencyKey !== '') {
        const existing = Array.from(this.runs.values()).find((candidate) => (
          candidate.workflowId === snapshot.workflowId
          && candidate.workflowRevision === snapshot.workflowRevision
          && candidate.idempotencyKey === idempotencyKey
        ))
        if (existing !== undefined) return cloneWorkflow(existing)
      }
      this.runs.set(snapshot.id, snapshot)
      await this.persist()
      return cloneWorkflow(snapshot)
    })
  }

  /** Atomically lease the oldest due queued record to one local Worker. */
  async claimNextDue(ownerId: string, leaseMs: number, now = new Date()): Promise<WorkflowRunRecord | undefined> {
    await this.initialize()
    const nowMs = now.getTime()
    const claimedAt = now.toISOString()
    const expiresAt = new Date(nowMs + Math.max(2_000, leaseMs)).toISOString()
    return this.mutate(async () => {
      const candidate = Array.from(this.runs.values())
        .filter((record) => {
          if (record.status !== 'queued') return false
          if (record.queue !== undefined && !isValidQueueState(record.queue)) return false
          const availableAt = record.queue?.availableAt
          return record.queue === undefined || (availableAt !== undefined && Date.parse(availableAt) <= nowMs)
        })
        .sort((left, right) => (left.queue?.availableAt ?? left.startedAt ?? '').localeCompare(right.queue?.availableAt ?? right.startedAt ?? ''))
        .at(0)
      if (candidate === undefined) return undefined
      candidate.status = 'running'
      candidate.queue = {
        ...(candidate.queue ?? { enqueuedAt: claimedAt, availableAt: claimedAt }),
        lease: { ownerId, claimedAt, expiresAt },
      }
      await this.persist()
      return cloneWorkflow(candidate)
    })
  }

  /**
   * Requeue an expired lease only when no external effect was dispatched. A
   * potentially delivered effect is paused for explicit reconciliation.
   */
  async recoverInterruptedRuns(now = new Date(), force = false): Promise<WorkflowRunRecord[]> {
    await this.initialize()
    const nowMs = now.getTime()
    const nowIso = now.toISOString()
    return this.mutate(async () => {
      const recovered: WorkflowRunRecord[] = []
      for (const record of this.runs.values()) {
        if (record.status !== 'running') continue
        const lease = record.queue?.lease
        if (lease === undefined) continue
        if (!isValidLease(lease)) continue
        if (!force && Date.parse(lease.expiresAt) > nowMs) continue
        const uncertainEffect = record.nodeStates.some(hasUncertainEffect)
        if (uncertainEffect) {
          for (const state of record.nodeStates) {
            if (!hasUncertainEffect(state)) continue
            state.effectState = 'unknown'
            state.status = 'cancelled'
            state.completedAt = nowIso
            state.error = '外部副作用可能已发出，未自动重放。'
          }
          record.status = 'paused'
          record.error = '运行中断时存在状态不确定的外部副作用，需先人工核对后才能继续。'
          record.completedAt = nowIso
          record.events.push({ id: randomUUID(), time: nowIso, type: 'run-paused', message: record.error })
          record.queue = { ...(record.queue ?? { enqueuedAt: nowIso, availableAt: nowIso }) }
          delete record.queue.lease
        } else {
          for (const state of record.nodeStates) {
            if (state.status === 'running') {
              state.status = 'pending'
              state.startedAt = undefined
            }
          }
          record.status = 'queued'
          record.error = undefined
          record.completedAt = undefined
          record.queue = { ...(record.queue ?? { enqueuedAt: nowIso, availableAt: nowIso }), availableAt: nowIso }
          delete record.queue.lease
        }
        recovered.push(cloneWorkflow(record))
      }
      if (recovered.length > 0) await this.persist()
      return recovered
    })
  }

  /** Extend a lease only when the caller still owns the running record. */
  async renewLease(runId: string, ownerId: string, leaseMs: number, now = new Date()): Promise<WorkflowRunRecord | undefined> {
    await this.initialize()
    const claimedAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + Math.max(2_000, leaseMs)).toISOString()
    return this.mutate(async () => {
      const record = this.runs.get(runId)
      if (record?.status !== 'running' || !isValidLease(record.queue?.lease) || record.queue.lease.ownerId !== ownerId) return undefined
      record.queue = {
        ...(record.queue ?? { enqueuedAt: claimedAt, availableAt: claimedAt }),
        lease: { ...record.queue.lease, expiresAt },
      }
      await this.persist()
      return cloneWorkflow(record)
    })
  }

  /** Release a lease only when the caller still owns it. */
  async releaseLease(runId: string, ownerId: string, recoverInterrupted = false): Promise<boolean> {
    await this.initialize()
    return this.mutate(async () => {
      const record = this.runs.get(runId)
      if (!isValidLease(record?.queue?.lease) || record.queue?.lease.ownerId !== ownerId) return false
      let queue = { ...record.queue }
      delete queue.lease
      if (recoverInterrupted && record.status === 'running') {
        const uncertainEffect = record.nodeStates.some(hasUncertainEffect)
        if (uncertainEffect) {
          const now = new Date().toISOString()
          for (const state of record.nodeStates) {
            if (!hasUncertainEffect(state)) continue
            state.status = 'cancelled'
            state.effectState = 'unknown'
            state.completedAt = now
            state.error = '外部副作用可能已发出，未自动重放。'
          }
          record.status = 'paused'
          record.error = 'Worker 租约丢失时存在状态不确定的外部副作用，需先人工核对后才能继续。'
          record.completedAt = now
          record.events.push({ id: randomUUID(), time: now, type: 'run-paused', message: record.error })
        } else if (queue.cancellationRequestedAt !== undefined) {
          record.status = 'cancelled'
          record.error = '用户取消了运行'
          record.completedAt = queue.cancellationRequestedAt
        } else {
          for (const state of record.nodeStates) {
            if (state.status !== 'running') continue
            state.status = 'pending'
            state.startedAt = undefined
          }
          record.status = 'queued'
          record.error = undefined
          record.completedAt = undefined
          queue = { ...queue, availableAt: new Date().toISOString() }
        }
      }
      record.queue = queue
      await this.persist()
      return true
    })
  }

  /** Persist a cancellation request before an active Worker is asked to abort. */
  async requestCancellation(runId: string, now = new Date()): Promise<WorkflowRunRecord | undefined> {
    await this.initialize()
    const requestedAt = now.toISOString()
    return this.mutate(async () => {
      const record = this.runs.get(runId)
      if (record === undefined) return undefined
      if (record.status === 'queued' || record.status === 'waiting-approval') {
        record.status = 'cancelled'
        record.error = '用户取消了运行'
        record.completedAt = requestedAt
        record.waitingApprovalNodeId = undefined
        record.queue = {
          ...(record.queue ?? { enqueuedAt: requestedAt, availableAt: requestedAt }),
          cancellationRequestedAt: requestedAt,
        }
        record.events.push({ id: randomUUID(), time: requestedAt, type: 'run-cancelled', message: record.error })
        await this.persist()
        return cloneWorkflow(record)
      }
      if (record.status !== 'running') return cloneWorkflow(record)
      record.queue = {
        ...(record.queue ?? { enqueuedAt: requestedAt, availableAt: requestedAt }),
        cancellationRequestedAt: requestedAt,
      }
      await this.persist()
      return cloneWorkflow(record)
    })
  }

  async remove(id: string): Promise<boolean> {
    await this.initialize()
    return this.mutate(async () => {
      const removed = this.runs.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  /** Remove all persisted run records belonging to a workflow in one write. */
  async removeForWorkflow(workflowId: string): Promise<number> {
    await this.initialize()
    return this.mutate(async () => {
      let removed = 0
      for (const [id, record] of this.runs.entries()) {
        if (record.workflowId !== workflowId) continue
        this.runs.delete(id)
        removed += 1
      }
      if (removed > 0) await this.persist()
      return removed
    })
  }

  /** Remove terminal run history whose configured retention period has elapsed. */
  async pruneExpired(now = new Date()): Promise<string[]> {
    await this.initialize()
    return this.mutate(async () => {
      const removed: string[] = []
      for (const [id, record] of this.runs.entries()) {
        if (record.status === 'queued' || record.status === 'running' || record.status === 'paused' || record.status === 'waiting-approval') continue
        if (record.retentionExpiresAt === undefined) continue
        const expiresAt = new Date(record.retentionExpiresAt)
        if (Number.isNaN(expiresAt.getTime()) || expiresAt > now) continue
        this.runs.delete(id)
        removed.push(id)
      }
      if (removed.length > 0) await this.persist()
      return removed
    })
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, Array.from(this.runs.values()))
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation)
    this.mutationChain = result.then(() => undefined, () => undefined)
    return result
  }
}

function sameLeaseIdentity(left: { ownerId: string; claimedAt: string; expiresAt: string }, right: { ownerId: string; claimedAt: string; expiresAt: string }): boolean {
  return left.ownerId === right.ownerId && left.claimedAt === right.claimedAt
}
