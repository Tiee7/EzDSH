import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { cloneWorkflow, isWorkflowValue, workflowAllNodeRunStates, type WorkflowRunLease, type WorkflowRunQueueState, type WorkflowRunRecord } from '../../shared/workflow.js'
import type { WorkflowQueueCapacityMetrics, WorkflowRunQueueSnapshot } from '../../shared/workflow-operations.js'
import { workflowRunHasUnresolvedAudit } from '../../shared/workflow-dead-letter.js'
import { WorkflowMutationCoordinator, workflowMutationCoordinator } from './workflow-mutation-coordinator.js'
import type { WorkflowStore } from './workflow-store.js'

/** Main-only configuration. Never accept these limits from run/Renderer options. */
export interface WorkflowRunQueueLimits {
  global: number
  perEnvironment: number
}

export const DEFAULT_WORKFLOW_RUN_QUEUE_LIMITS: Readonly<WorkflowRunQueueLimits> = Object.freeze({ global: 1000, perEnvironment: 100 })

export class WorkflowRunQueueFullError extends Error {
  readonly code = 'WORKFLOW_RUN_QUEUE_FULL'
  constructor() {
    super('WORKFLOW_RUN_QUEUE_FULL: Workflow queue capacity reached; try again after admitted work settles.')
    this.name = 'WorkflowRunQueueFullError'
  }
}

function queueBucket(environmentId?: string): string {
  // Prefixing prevents a real environment named "local" colliding with local work.
  return environmentId === undefined ? 'local' : `environment:${environmentId}`
}

function isAdmitted(record: WorkflowRunRecord): boolean {
  return record.status === 'queued' || record.status === 'running' || record.status === 'waiting-approval'
}

function capacityMetrics(records: WorkflowRunRecord[], capacity: number): WorkflowQueueCapacityMetrics {
  const queued = records.filter((record) => record.status === 'queued').length
  const running = records.filter((record) => record.status === 'running').length
  const waitingApproval = records.filter((record) => record.status === 'waiting-approval').length
  const admitted = queued + running + waitingApproval
  return { capacity, admitted, queued, running, waitingApproval, availableSlots: Math.max(0, capacity - admitted), overCapacity: admitted > capacity }
}

function admissionCounts(records: Iterable<WorkflowRunRecord>): { global: number; buckets: Map<string, number> } {
  let global = 0
  const buckets = new Map<string, number>()
  for (const record of records) {
    if (!isAdmitted(record)) continue
    global += 1
    const bucket = queueBucket(record.environmentId)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  return { global, buckets }
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

function compareQueuedRuns(left: WorkflowRunRecord, right: WorkflowRunRecord): number {
  const timestamp = (value?: string): number => value === undefined ? 0 : Date.parse(value) || 0
  return timestamp(left.queue?.availableAt ?? left.startedAt) - timestamp(right.queue?.availableAt ?? right.startedAt)
    || timestamp(left.queue?.enqueuedAt ?? left.startedAt) - timestamp(right.queue?.enqueuedAt ?? right.startedAt)
    || compareText(left.id, right.id)
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tempPath, filePath)
}

export function isPersistedRunRecord(value: unknown): value is WorkflowRunRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.workflowId !== 'string' || typeof record.workflowRevision !== 'number' || !Number.isInteger(record.workflowRevision)) return false
  if (!['queued', 'running', 'paused', 'waiting-approval', 'completed', 'failed', 'cancelled'].includes(record.status as string)) return false
  if (!Array.isArray(record.nodeStates) || !Array.isArray(record.events)) return false
  if (!record.nodeStates.every(isPersistedNodeState)) return false
  if (record.parentRunId !== undefined && (typeof record.parentRunId !== 'string' || record.parentRunId.trim() === '')) return false
  if (record.workflowAncestry !== undefined && (!Array.isArray(record.workflowAncestry) || !record.workflowAncestry.every((id) => typeof id === 'string' && id.trim() !== ''))) return false
  if (record.effectIdempotencyKey !== undefined && (typeof record.effectIdempotencyKey !== 'string' || record.effectIdempotencyKey.trim() === '')) return false
  if (record.origin !== undefined) {
    if (record.origin === null || typeof record.origin !== 'object') return false
    const origin = record.origin as Record<string, unknown>
    if (origin.kind !== 'top-level' && (origin.kind !== 'child' || typeof origin.parentRunId !== 'string' || origin.parentRunId.trim() === '')) return false
  }
  const queue = record.queue
  if (queue !== undefined && !isValidQueueState(queue)) return false
  return true
}

function isPersistedNodeState(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  if (typeof state.nodeId !== 'string' || !['pending', 'running', 'completed', 'skipped', 'failed', 'cancelled'].includes(state.status as string)) return false
  if (state.loopIterations === undefined) return true
  if (!Array.isArray(state.loopIterations)) return false
  const indices = new Set<number>()
  const ids = new Set<string>()
  return state.loopIterations.every((value: unknown) => {
    if (value === null || typeof value !== 'object') return false
    const iteration = value as Record<string, unknown>
    if (typeof iteration.iterationIndex !== 'number' || !Number.isInteger(iteration.iterationIndex) || iteration.iterationIndex < 0 || indices.has(iteration.iterationIndex)) return false
    if (typeof iteration.iterationId !== 'string' || iteration.iterationId.trim() === '' || ids.has(iteration.iterationId)) return false
    indices.add(iteration.iterationIndex)
    ids.add(iteration.iterationId)
    return ['pending', 'running', 'completed'].includes(iteration.status as string)
      && isWorkflowValue(iteration.input)
      && Array.isArray(iteration.nodeStates) && iteration.nodeStates.every(isPersistedNodeState)
      && (iteration.output === undefined || isWorkflowValue(iteration.output))
  })
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
  readonly mutations: WorkflowMutationCoordinator
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private readonly queueLimits: Readonly<WorkflowRunQueueLimits>
  private lastClaimedBucket: string | undefined
  private mutationBaseline: Map<string, WorkflowRunRecord> | undefined

  constructor(stateDir: string, queueLimits: WorkflowRunQueueLimits = DEFAULT_WORKFLOW_RUN_QUEUE_LIMITS, mutations = workflowMutationCoordinator(stateDir)) {
    if (queueLimits === null || !Number.isSafeInteger(queueLimits.global) || queueLimits.global <= 0
      || !Number.isSafeInteger(queueLimits.perEnvironment) || queueLimits.perEnvironment <= 0) {
      throw new Error('WORKFLOW_RUN_QUEUE_CONFIG_INVALID')
    }
    this.queueLimits = Object.freeze({ ...queueLimits })
    this.mutations = mutations
    mutations.runStore = this
    this.filePath = join(stateDir, 'workflow-runs.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await this.mutations.initialize()
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        let values: unknown[]
        let cursor: string | undefined
        if (Array.isArray(parsed)) values = parsed
        else {
          if (parsed === null || typeof parsed !== 'object') throw new Error('WORKFLOW_RUN_STORE_SCHEMA_UNSUPPORTED')
          const envelope = parsed as Record<string, unknown>
          if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.runs)
            || envelope.lastClaimedBucket !== undefined && (typeof envelope.lastClaimedBucket !== 'string' || envelope.lastClaimedBucket === '')) {
            throw new Error('WORKFLOW_RUN_STORE_SCHEMA_UNSUPPORTED')
          }
          values = envelope.runs
          cursor = envelope.lastClaimedBucket as string | undefined
        }
        {
          for (const value of values) {
            if (typeof value !== 'object' || value === null || typeof (value as { id?: unknown }).id !== 'string') continue
            const record = value as WorkflowRunRecord
            if (!isPersistedRunRecord(record)) continue
            this.runs.set(record.id, cloneWorkflow(record))
          }
          this.lastClaimedBucket = cursor
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
    return Array.from((this.mutationBaseline ?? this.runs).values())
      .filter((record) => workflowId === undefined || record.workflowId === workflowId)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .map((record) => cloneWorkflow(record))
  }

  get(id: string): WorkflowRunRecord | undefined {
    const record = (this.mutationBaseline ?? this.runs).get(id)
    return record === undefined ? undefined : cloneWorkflow(record)
  }

  /** Retention protection includes durable tombstones and live reference chains. */
  isRunProtected(id: string): boolean {
    return this.mutations.isRunProtected(id) || this.referenceProtectedIds().has(id)
  }

  queueSnapshot(environmentId?: string): WorkflowRunQueueSnapshot {
    const records = [...(this.mutationBaseline ?? this.runs).values()]
    const bucket = queueBucket(environmentId)
    return {
      global: capacityMetrics(records, this.queueLimits.global),
      environment: capacityMetrics(records.filter((record) => queueBucket(record.environmentId) === bucket), this.queueLimits.perEnvironment),
    }
  }

  /** Return the next persisted queue availability timestamp for Worker wake-up. */
  nextDueAt(): string | undefined {
    return Array.from((this.mutationBaseline ?? this.runs).values())
      .filter((record) => record.status === 'queued')
      .filter((record) => record.queue === undefined || isValidQueueState(record.queue))
      .map((record) => record.queue?.availableAt)
      .filter((value): value is string => value !== undefined && !Number.isNaN(Date.parse(value)))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0]
  }

  async save(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    return this.saveRecord(record, false)
  }

  /** Main-only audit persistence for an existing retained record. It cannot
   * admit work, change record identity, or recreate a deleted run ID. */
  async saveRetainedAudit(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    return this.saveRecord(record, true)
  }

  private async saveRecord(record: WorkflowRunRecord, retainedAudit: boolean): Promise<WorkflowRunRecord> {
    await this.initialize()
    const snapshot = cloneWorkflow(record)
    return this.mutate(async () => {
      const current = this.runs.get(snapshot.id)
      if (retainedAudit) {
        this.mutations.assertAvailable()
        if (current === undefined || !this.mutations.isWorkflowDeleted(snapshot.workflowId) || !this.mutations.isRunProtected(snapshot.id)
          || isAdmitted(current) || isAdmitted(snapshot)
          || current.workflowId !== snapshot.workflowId || current.workflowRevision !== snapshot.workflowRevision
          || current.releaseId !== snapshot.releaseId || current.environmentId !== snapshot.environmentId || current.traceId !== snapshot.traceId
          || JSON.stringify(current.queue) !== JSON.stringify(snapshot.queue)) throw new Error('WORKFLOW_RETAINED_AUDIT_INVALID')
      } else {
        if (current !== undefined && this.mutations.isRunProtected(current.id) && this.mutations.isWorkflowDeleted(current.workflowId)) throw new Error('WORKFLOW_TOMBSTONED: retained record is audit-only')
        this.mutations.assertRunWritable(snapshot.id, snapshot.workflowId, snapshot.releaseId !== undefined && snapshot.environmentId !== undefined && snapshot.traceId !== undefined)
      }
      // Acceptance is append-only across later worker/admin snapshots. A
      // stale writer must not erase a receipt and enable another admission.
      if (current?.recoveryReceipts !== undefined) {
        const accepted = new Map(current.recoveryReceipts.map((receipt) => [receipt.requestId, receipt]))
        for (const receipt of snapshot.recoveryReceipts ?? []) if (!accepted.has(receipt.requestId)) accepted.set(receipt.requestId, receipt)
        snapshot.recoveryReceipts = [...accepted.values()].map((receipt) => ({ ...receipt }))
      }
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
      if (this.mutations.isRunProtected(snapshot.id) && this.mutations.isWorkflowDeleted(this.runs.get(snapshot.id)?.workflowId ?? snapshot.workflowId)) throw new Error('WORKFLOW_TOMBSTONED: retained record is audit-only')
      this.mutations.assertRunWritable(snapshot.id, snapshot.workflowId, snapshot.releaseId !== undefined && snapshot.environmentId !== undefined && snapshot.traceId !== undefined)
      if (idempotencyKey !== undefined && idempotencyKey !== '') {
        const existing = Array.from(this.runs.values()).find((candidate) => (
          candidate.workflowId === snapshot.workflowId
          && candidate.workflowRevision === snapshot.workflowRevision
          && candidate.idempotencyKey === idempotencyKey
          && candidate.environmentId === snapshot.environmentId
          && candidate.releaseId === snapshot.releaseId
        ))
        if (existing !== undefined) return cloneWorkflow(existing)
      }
      this.runs.set(snapshot.id, snapshot)
      await this.persist()
      return cloneWorkflow(snapshot)
    })
  }

  /** Round-robin due environment buckets; one claim and cursor per atomic local snapshot. */
  async claimNextDue(ownerId: string, leaseMs: number, now = new Date()): Promise<WorkflowRunRecord | undefined> {
    await this.initialize()
    const nowMs = now.getTime()
    const claimedAt = now.toISOString()
    const expiresAt = new Date(nowMs + Math.max(2_000, leaseMs)).toISOString()
    return this.mutate(async () => {
      const due = Array.from(this.runs.values())
        .filter((record) => {
          if (record.status !== 'queued') return false
          if (record.queue !== undefined && !isValidQueueState(record.queue)) return false
          const availableAt = record.queue?.availableAt
          return record.queue === undefined || (availableAt !== undefined && Date.parse(availableAt) <= nowMs)
        })
      const buckets = [...new Set(due.map((record) => queueBucket(record.environmentId)))].sort(compareText)
      const nextBucket = buckets.find((bucket) => this.lastClaimedBucket === undefined || compareText(bucket, this.lastClaimedBucket) > 0) ?? buckets[0]
      const candidate = due.filter((record) => queueBucket(record.environmentId) === nextBucket).sort(compareQueuedRuns)[0]
      if (candidate === undefined) return undefined
      this.lastClaimedBucket = nextBucket
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
        const uncertainEffect = workflowAllNodeRunStates(record.nodeStates).some(hasUncertainEffect)
        if (uncertainEffect) {
          for (const state of workflowAllNodeRunStates(record.nodeStates)) {
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
          for (const state of workflowAllNodeRunStates(record.nodeStates)) {
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

  /** A compensation dispatch can outlive this process. Never replay an
   * unconfirmed dispatch: convert it to a durable manual-review state. */
  async recoverInterruptedCompensations(now = new Date()): Promise<WorkflowRunRecord[]> {
    await this.initialize()
    const nowIso = now.toISOString()
    return this.mutate(async () => {
      const recovered: WorkflowRunRecord[] = []
      for (const record of this.runs.values()) {
        let changed = false
        for (const entry of record.compensationStack ?? []) {
          if (entry.status !== 'running' && entry.effectState !== 'dispatched') continue
          entry.status = 'failed'
          entry.effectState = 'unknown'
          entry.completedAt = nowIso
          entry.error = '补偿副作用可能已派发，必须人工核对后再决定是否重试。'
          record.compensationBlocker = entry.error
          record.events.push({
            id: randomUUID(),
            time: nowIso,
            type: 'compensation-effect-unknown',
            nodeId: entry.sourceNodeId,
            message: entry.error,
            ...(entry.executionScope === undefined ? {} : { executionScope: cloneWorkflow(entry.executionScope) }),
          })
          changed = true
        }
        if (changed) recovered.push(cloneWorkflow(record))
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
        const uncertainEffect = workflowAllNodeRunStates(record.nodeStates).some(hasUncertainEffect)
        if (uncertainEffect) {
          const now = new Date().toISOString()
          for (const state of workflowAllNodeRunStates(record.nodeStates)) {
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
          for (const state of workflowAllNodeRunStates(record.nodeStates)) {
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
      if (this.mutations.isRunProtected(id) || this.referenceProtectedIds().has(id)) throw new Error('WORKFLOW_RUN_PROTECTED')
      const removed = this.runs.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  /** Remove all persisted run records belonging to a workflow in one write. */
  async removeForWorkflow(workflowId: string): Promise<number> {
    await this.initialize()
    return this.mutate(async () => {
      const protectedIds = this.referenceProtectedIds()
      let removed = 0
      for (const [id, record] of this.runs.entries()) {
        if (record.workflowId !== workflowId) continue
        if (this.mutations.isRunProtected(id) || protectedIds.has(id)) continue
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
      const protectedIds = this.referenceProtectedIds()
      const removed: string[] = []
      for (const [id, record] of this.runs.entries()) {
        if (this.mutations.isRunProtected(id) || protectedIds.has(id)) continue
        if (record.status === 'queued' || record.status === 'running' || record.status === 'paused' || record.status === 'waiting-approval') continue
        if (workflowRunHasUnresolvedAudit(record)) continue
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
    // Every mutation, including save/resume/inline child/recovery, passes this
    // serialized guard before disk writes. Legacy excess can drain, never grow.
    const before = admissionCounts((this.mutationBaseline ?? this.runs).values())
    const after = admissionCounts(this.runs.values())
    if (after.global > this.queueLimits.global && after.global > before.global) throw new WorkflowRunQueueFullError()
    for (const [bucket, count] of after.buckets) {
      if (count > this.queueLimits.perEnvironment && count > (before.buckets.get(bucket) ?? 0)) throw new WorkflowRunQueueFullError()
    }
    await atomicWriteJson(this.filePath, { schemaVersion: 1, lastClaimedBucket: this.lastClaimedBucket, runs: Array.from(this.runs.values()) })
  }

  private cloneRuns(): Map<string, WorkflowRunRecord> {
    return new Map(Array.from(this.runs, ([id, record]) => [id, cloneWorkflow(record)]))
  }

  private restoreRuns(snapshot: Map<string, WorkflowRunRecord>): void {
    this.runs.clear()
    for (const [id, record] of snapshot) this.runs.set(id, cloneWorkflow(record))
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const mutateWithRollback = async (): Promise<T> => {
      const snapshot = this.cloneRuns()
      const cursor = this.lastClaimedBucket
      this.mutationBaseline = snapshot
      try {
        return await operation()
      } catch (error) {
        this.restoreRuns(snapshot)
        this.lastClaimedBucket = cursor
        throw error
      } finally {
        this.mutationBaseline = undefined
      }
    }
    return this.mutations.run(mutateWithRollback)
  }

  /** Only the fixed workflow deletion operation may span these stores. The
   * service holds its administration locks before entering this writer gate. */
  async deleteWorkflow(workflows: WorkflowStore, workflowId: string, removeDefinition: boolean): Promise<number> {
    if (workflows.mutations !== this.mutations) throw new Error('WORKFLOW_MUTATION_COORDINATOR_MISMATCH')
    await Promise.all([this.initialize(), workflows.initialize()])
    return this.mutations.run(async () => {
      this.mutations.assertWorkflowWritable(workflowId)
      const candidates = [...this.runs.values()].filter((record) => record.workflowId === workflowId)
      if (candidates.some(isAdmitted)) throw new Error('工作流仍有运行中的记录，请先取消运行后再删除工作流')
      const protectedIds = this.referenceProtectedIds()
      const tombstones = this.mutations.snapshotTombstones()
      const retained = candidates.filter((record) => protectedIds.has(record.id) || this.mutations.isRunProtected(record.id) || workflowRunHasUnresolvedAudit(record))
      for (const record of retained) {
        if (workflows.getRevision(record.workflowId, record.workflowRevision) === undefined) throw new Error(`WORKFLOW_MUTATION_UNVERIFIED_REVISION: ${record.id}`)
      }
      const retainedIds = new Set(retained.map((record) => record.id))
      const deletedIds = candidates.filter((record) => !retainedIds.has(record.id)).map((record) => record.id)
      const next = new Map(this.runs)
      for (const id of deletedIds) next.delete(id)
      const images = workflows.deletionImages(workflowId, removeDefinition)
      if (removeDefinition) tombstones.workflowIds = [...new Set([...tombstones.workflowIds, workflowId])]
      tombstones.runIds = [...new Set([...tombstones.runIds, ...deletedIds])]
      tombstones.protectedRunIds = [...new Set([...tombstones.protectedRunIds, ...retainedIds, ...protectedIds])]
      await this.mutations.delete({ ...images, tombstones, runs: { schemaVersion: 1, lastClaimedBucket: this.lastClaimedBucket, runs: [...next.values()] } })
      workflows.publish(images)
      this.restoreRuns(next)
      return deletedIds.length
    })
  }

  /** Conservatively retain both ends of every parent/child or compensation
   * reference. Recursive walking includes loop states and childRunId(s) arrays.
   * An unresolvable reference blocks destructive cleanup rather than guessing. */
  private referenceProtectedIds(): Set<string> {
    const protectedIds = new Set<string>()
    const walk = (value: unknown, source: string): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item, source); return }
      if (value === null || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (/RunIds?$/.test(key)) {
          if (child === undefined) continue
          const references = key.endsWith('Ids') ? child : [child]
          if (!Array.isArray(references) || references.some((id) => typeof id !== 'string' || !this.runs.has(id))) {
            // Legacy orphan chains must still load so execution can pause them
            // for review. Unknown references conservatively retain all history.
            for (const id of this.runs.keys()) protectedIds.add(id)
            continue
          }
          if (references.length > 0) protectedIds.add(source)
          for (const id of references) protectedIds.add(id as string)
        } else walk(child, source)
      }
    }
    for (const record of this.runs.values()) walk(record, record.id)
    for (const parent of this.runs.values()) {
      const definition = this.mutations.workflowStore?.getRevision(parent.workflowId, parent.workflowRevision)
      for (const state of workflowAllNodeRunStates(parent.nodeStates)) {
        const output = state.output
        if (output === null || output === undefined || Array.isArray(output) || typeof output !== 'object' || typeof output.runId !== 'string') continue
        const node = definition?.nodes.find((candidate) => candidate.id === state.nodeId)
        // A known ordinary node's user payload is not child provenance.
        if (node !== undefined && node.type !== 'sub-workflow') continue
        const child = this.runs.get(output.runId)
        if (node?.type !== 'sub-workflow' || node.config.waitForCompletion !== false || child === undefined || node.config.workflowId !== child.workflowId
          || typeof node.config.version === 'number' && node.config.version !== child.workflowRevision) {
          for (const id of this.runs.keys()) protectedIds.add(id)
          continue
        }
        protectedIds.add(parent.id)
        protectedIds.add(child.id)
      }
    }
    return protectedIds
  }
}

function sameLeaseIdentity(left: { ownerId: string; claimedAt: string; expiresAt: string }, right: { ownerId: string; claimedAt: string; expiresAt: string }): boolean {
  return left.ownerId === right.ownerId && left.claimedAt === right.claimedAt
}
