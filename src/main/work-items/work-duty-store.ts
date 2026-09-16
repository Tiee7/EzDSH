import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  occurrenceId,
  validateWorkDuty,
  validateWorkDutyCreateRequest,
  validateWorkDutyExecutionLink,
  validateWorkDutyExecutionRecordRequest,
  validateWorkDutyOccurrenceClaimRequest,
  validateWorkDutyPauseRequest,
  validateWorkDutyResumeRequest,
  type WorkDuty,
  type WorkDutyCreateReceipt,
  type WorkDutyCreateRequest,
  type WorkDutyExecutionLink,
  type WorkDutyExecutionRecordReceipt,
  type WorkDutyExecutionRecordRequest,
  type WorkDutyEvent,
  type WorkDutyMutationReceipt,
  type WorkDutyOccurrenceClaimReceipt,
  type WorkDutyOccurrenceClaimRequest,
  type WorkDutyPauseRequest,
  type WorkDutyResumeRequest,
} from '../../shared/work-duty.js'

type StoredDutyRequest =
  | { kind: 'create'; digest: string; receipt: WorkDutyCreateReceipt }
  | { kind: 'pause'; digest: string; receipt: WorkDutyMutationReceipt }
  | { kind: 'resume'; digest: string; receipt: WorkDutyMutationReceipt }
  | { kind: 'occurrence'; digest: string; receipt: WorkDutyOccurrenceClaimReceipt }
  | { kind: 'execution'; digest: string; receipt: WorkDutyExecutionRecordReceipt }

interface WorkDutyState {
  version: 1
  duties: Record<string, WorkDuty>
  occurrences: Record<string, WorkDutyOccurrenceClaimReceipt>
  requests: Record<string, StoredDutyRequest>
}

export interface WorkDutyStoreOptions {
  writeFile?: (path: string, data: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

export class WorkDutyStoreConflictError extends Error {
  readonly code: 'REQUEST_ID_CONFLICT' | 'DUTY_NOT_FOUND' | 'REVISION_CONFLICT' | 'OCCURRENCE_CONFLICT'

  constructor(
    code: WorkDutyStoreConflictError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'WorkDutyStoreConflictError'
    this.code = code
  }
}

const EMPTY_STATE: WorkDutyState = { version: 1, duties: {}, occurrences: {}, requests: {} }
const MAX_DATE_MS = 8_640_000_000_000_000

function copy<T>(value: T): T {
  return structuredClone(value)
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}

function requestDigest(kind: string, request: unknown): string {
  return createHash('sha256').update(`${kind}:${JSON.stringify(request)}`).digest('hex')
}

function isoNow(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value)
}

function persistedOccurrence(value: unknown): value is WorkDutyOccurrenceClaimReceipt {
  if (!isRecord(value)) return false
  const required = ['requestId', 'dutyId', 'occurrenceId', 'occurrenceAt', 'nextOccurrenceAt', 'skippedOccurrences', 'duty', 'replayed']
  const allowed = [...required, 'execution']
  if (!Object.keys(value).every((key) => allowed.includes(key)) || !required.every((key) => key in value)) return false
  try {
    const duty = validateWorkDuty(value.duty)
    const execution = value.execution === undefined ? undefined : validateWorkDutyExecutionLink(value.execution)
    const requestId = value.requestId
    const dutyId = value.dutyId
    const occurrenceAt = value.occurrenceAt
    const nextOccurrenceAt = value.nextOccurrenceAt
    const skipped = value.skippedOccurrences
    const id = value.occurrenceId
    if (typeof requestId !== 'string' || requestId.trim() === ''
      || typeof dutyId !== 'string' || dutyId !== duty.id
      || typeof occurrenceAt !== 'string' || typeof nextOccurrenceAt !== 'string'
      || typeof id !== 'string' || id !== occurrenceId(dutyId, occurrenceAt)
      || !Number.isSafeInteger(skipped) || (skipped as number) < 0
      || value.replayed !== false
      || new Date(occurrenceAt).toISOString() !== occurrenceAt
      || new Date(nextOccurrenceAt).toISOString() !== nextOccurrenceAt) return false
    return duty.nextOccurrenceAt === nextOccurrenceAt
      && (execution === undefined || execution.taskId === duty.taskId)
  } catch {
    return false
  }
}

function persistedRequest(value: unknown): value is StoredDutyRequest {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)) return false
  if (value.kind === 'create') {
    const receipt = value.receipt
    if (!isRecord(receipt) || !hasExactKeys(receipt, ['requestId', 'digest', 'duty', 'replayed'])) return false
    try {
      validateWorkDuty(receipt.duty)
      return typeof receipt.requestId === 'string' && receipt.requestId.trim() !== ''
        && receipt.digest === value.digest && receipt.replayed === false
    } catch {
      return false
    }
  }
  if (value.kind === 'pause' || value.kind === 'resume') {
    const receipt = value.receipt
    if (!isRecord(receipt) || !hasExactKeys(receipt, ['requestId', 'digest', 'dutyId', 'duty', 'replayed'])) return false
    try {
      validateWorkDuty(receipt.duty)
      return typeof receipt.requestId === 'string' && receipt.requestId.trim() !== ''
        && typeof receipt.dutyId === 'string' && receipt.dutyId === (receipt.duty as WorkDuty).id
        && receipt.digest === value.digest && receipt.replayed === false
    } catch {
      return false
    }
  }
  if (value.kind === 'occurrence') {
    return persistedOccurrence(value.receipt)
  }
  if (value.kind === 'execution') {
    const receipt = value.receipt
    if (!isRecord(receipt) || !hasExactKeys(receipt, ['requestId', 'digest', 'dutyId', 'occurrenceId', 'execution', 'occurrence', 'replayed'])) return false
    try {
      const execution = validateWorkDutyExecutionLink(receipt.execution)
      const occurrence = receipt.occurrence
      return persistedOccurrence(occurrence)
        && typeof receipt.requestId === 'string' && receipt.requestId.trim() !== ''
        && typeof receipt.dutyId === 'string' && receipt.dutyId === occurrence.dutyId
        && typeof receipt.occurrenceId === 'string' && receipt.occurrenceId === occurrence.occurrenceId
        && execution.taskId === occurrence.duty.taskId
        && receipt.digest === value.digest && receipt.replayed === false
    } catch {
      return false
    }
  }
  return false
}

function assertState(value: unknown): WorkDutyState {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'duties', 'occurrences', 'requests'])
    || value.version !== 1 || !isRecord(value.duties) || !isRecord(value.occurrences) || !isRecord(value.requests)) {
    throw new Error('Unsupported work duty state')
  }
  for (const [key, dutyValue] of Object.entries(value.duties)) {
    const duty = validateWorkDuty(dutyValue)
    if (key !== duty.id) throw new Error(`Work duty state key ${key} does not match duty id`)
  }
  for (const [key, receiptValue] of Object.entries(value.occurrences)) {
    if (!persistedOccurrence(receiptValue)) throw new Error(`Invalid work duty occurrence ${key}`)
    if (key !== receiptValue.occurrenceId) throw new Error(`Work duty occurrence key ${key} does not match occurrence id`)
  }
  for (const [key, requestValue] of Object.entries(value.requests)) {
    if (!persistedRequest(requestValue)) throw new Error(`Invalid work duty request ${key}`)
    const request = requestValue.receipt.requestId
    if (key !== request) throw new Error(`Work duty request key ${key} does not match request id`)
  }
  return copy(value as unknown as WorkDutyState)
}

function replayReceipt<T extends WorkDutyCreateReceipt | WorkDutyMutationReceipt | WorkDutyOccurrenceClaimReceipt | WorkDutyExecutionRecordReceipt>(
  state: WorkDutyState,
  requestId: string,
  digest: string,
): T | undefined {
  const stored = ownValue(state.requests, requestId)
  if (stored === undefined) return undefined
  if (stored.digest !== digest) {
    throw new WorkDutyStoreConflictError('REQUEST_ID_CONFLICT', `Request id ${requestId} was already used with different content`)
  }
  return { ...copy(stored.receipt), replayed: true } as T
}

function dueNextOccurrence(occurrenceAt: string, everySeconds: number, now: string): { next: string; skipped: number } {
  const occurrenceMs = Date.parse(occurrenceAt)
  const nowMs = Date.parse(now)
  const intervalMs = everySeconds * 1000
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isFinite(occurrenceMs) || !Number.isFinite(nowMs)) {
    throw new WorkDutyStoreConflictError('OCCURRENCE_CONFLICT', 'Duty occurrence cannot be advanced safely')
  }
  const skipped = Math.max(0, Math.floor((nowMs - occurrenceMs) / intervalMs))
  const nextMs = occurrenceMs + (skipped + 1) * intervalMs
  if (!Number.isSafeInteger(nextMs) || nextMs > MAX_DATE_MS || nextMs < -MAX_DATE_MS) {
    throw new WorkDutyStoreConflictError('OCCURRENCE_CONFLICT', 'Duty has no representable next occurrence')
  }
  return { next: new Date(nextMs).toISOString(), skipped }
}

/**
 * Durable identity and schedule state for a Work Item's periodic duty.
 * Scheduling and execution are deliberately separate: this store claims at
 * most one due occurrence and gives the caller a stable identity to pass to
 * WorkItemExecutionService.
 */
export class WorkDutyStore {
  private readonly filePath: string
  private state: WorkDutyState = copy(EMPTY_STATE)
  private initialized = false
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(event: WorkDutyEvent) => void>()

  constructor(
    private readonly stateDirectory: string,
    private readonly options: WorkDutyStoreOptions = {},
  ) {
    this.filePath = join(stateDirectory, 'work-duties.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    try {
      this.state = assertState(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = copy(EMPTY_STATE)
    }
    this.initialized = true
  }

  async get(dutyId: string): Promise<WorkDuty | undefined> {
    this.assertInitialized()
    const duty = ownValue(this.state.duties, dutyId)
    return duty === undefined ? undefined : copy(duty)
  }

  async list(): Promise<WorkDuty[]> {
    this.assertInitialized()
    return Object.values(this.state.duties).map(copy)
  }

  async create(input: WorkDutyCreateRequest): Promise<WorkDutyCreateReceipt> {
    return this.mutate(async () => {
      const request = validateWorkDutyCreateRequest(input)
      const digest = requestDigest('create', request)
      const replay = replayReceipt<WorkDutyCreateReceipt>(this.state, request.requestId, digest)
      if (replay !== undefined) return replay
      const now = isoNow()
      const duty: WorkDuty = {
        id: randomUUID(),
        taskId: request.taskId,
        executor: copy(request.executor),
        input: copy(request.input),
        everySeconds: request.everySeconds,
        timezone: request.timezone,
        nextOccurrenceAt: request.nextOccurrenceAt,
        paused: request.paused === true,
        missedPolicy: 'catch-up-once',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      const receipt: WorkDutyCreateReceipt = { requestId: request.requestId, digest, duty, replayed: false }
      const next = copy(this.state)
      setOwnValue(next.duties, duty.id, copy(duty))
      setOwnValue(next.requests, request.requestId, { kind: 'create', digest, receipt: copy(receipt) })
      await this.commit(next)
      this.emit({ kind: 'created', duty })
      return copy(receipt)
    })
  }

  async pause(input: WorkDutyPauseRequest): Promise<WorkDutyMutationReceipt> {
    return this.setPaused(validateWorkDutyPauseRequest(input), true, 'pause')
  }

  async resume(input: WorkDutyResumeRequest): Promise<WorkDutyMutationReceipt> {
    return this.setPaused(validateWorkDutyResumeRequest(input), false, 'resume')
  }

  /**
   * Claims the current due occurrence and advances the duty in one durable
   * commit. A long sleep/restart produces one catch-up receipt at most; all
   * later missed slots are skipped and nextOccurrenceAt is moved past now.
   * `occurrenceAt` is optional for normal polling and useful when retrying an
   * uncertain write with the occurrence observed before the first attempt.
   */
  async claimDueOccurrence(input: WorkDutyOccurrenceClaimRequest): Promise<WorkDutyOccurrenceClaimReceipt | undefined> {
    return this.mutate(async () => {
      const request = validateWorkDutyOccurrenceClaimRequest(input)
      const digest = requestDigest('occurrence', request)
      const replay = replayReceipt<WorkDutyOccurrenceClaimReceipt>(this.state, request.requestId, digest)
      if (replay !== undefined) return replay
      const duty = ownValue(this.state.duties, request.dutyId)
      if (duty === undefined) throw new WorkDutyStoreConflictError('DUTY_NOT_FOUND', `Duty ${request.dutyId} was not found`)
      const observedOccurrenceAt = request.occurrenceAt ?? duty.nextOccurrenceAt
      const id = occurrenceId(duty.id, observedOccurrenceAt)
      const existing = ownValue(this.state.occurrences, id)
      if (existing !== undefined) return { ...copy(existing), replayed: true }
      if (observedOccurrenceAt !== duty.nextOccurrenceAt) {
        throw new WorkDutyStoreConflictError('OCCURRENCE_CONFLICT', `Duty ${duty.id} no longer points at occurrence ${observedOccurrenceAt}`)
      }
      if (duty.paused) return undefined
      const now = request.now ?? isoNow()
      if (Date.parse(duty.nextOccurrenceAt) > Date.parse(now)) return undefined
      const advanced = dueNextOccurrence(duty.nextOccurrenceAt, duty.everySeconds, now)
      const updatedDuty: WorkDuty = {
        ...copy(duty),
        nextOccurrenceAt: advanced.next,
        revision: duty.revision + 1,
        updatedAt: isoNow(),
      }
      const receipt: WorkDutyOccurrenceClaimReceipt = {
        requestId: request.requestId,
        dutyId: duty.id,
        occurrenceId: id,
        occurrenceAt: observedOccurrenceAt,
        nextOccurrenceAt: updatedDuty.nextOccurrenceAt,
        skippedOccurrences: advanced.skipped,
        duty: updatedDuty,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.duties, duty.id, copy(updatedDuty))
      setOwnValue(next.occurrences, id, copy(receipt))
      setOwnValue(next.requests, request.requestId, { kind: 'occurrence', digest, receipt: copy(receipt) })
      await this.commit(next)
      this.emit({ kind: 'occurrence-claimed', duty: updatedDuty, occurrence: receipt })
      return copy(receipt)
    })
  }

  /** Persist the result of submitting one claimed occurrence to Work Items. */
  async recordExecution(input: WorkDutyExecutionRecordRequest): Promise<WorkDutyExecutionRecordReceipt> {
    return this.mutate(async () => {
      const request = validateWorkDutyExecutionRecordRequest(input)
      const digest = requestDigest('execution', request)
      const replay = replayReceipt<WorkDutyExecutionRecordReceipt>(this.state, request.requestId, digest)
      if (replay !== undefined) return replay
      const duty = ownValue(this.state.duties, request.dutyId)
      if (duty === undefined) throw new WorkDutyStoreConflictError('DUTY_NOT_FOUND', `Duty ${request.dutyId} was not found`)
      const occurrence = ownValue(this.state.occurrences, request.occurrenceId)
      if (occurrence === undefined || occurrence.dutyId !== duty.id || occurrence.duty.taskId !== request.taskId) {
        throw new WorkDutyStoreConflictError('OCCURRENCE_CONFLICT', `Occurrence ${request.occurrenceId} does not belong to duty ${duty.id}`)
      }
      if (request.occurrenceId !== occurrenceId(duty.id, occurrence.occurrenceAt)) {
        throw new WorkDutyStoreConflictError('OCCURRENCE_CONFLICT', `Occurrence ${request.occurrenceId} has an invalid identity`)
      }
      if (occurrence.execution !== undefined) {
        const same = occurrence.execution.status === request.status
          && occurrence.execution.taskId === request.taskId
          && occurrence.execution.runId === request.runId
          && occurrence.execution.commandId === request.commandId
          && occurrence.execution.executorStatus?.status === request.executorStatus?.status
          && occurrence.execution.executorStatus?.rawStatus === request.executorStatus?.rawStatus
          && occurrence.execution.error === request.error
        if (!same) throw new WorkDutyStoreConflictError('OCCURRENCE_CONFLICT', `Occurrence ${request.occurrenceId} already has a different execution result`)
        const receipt: WorkDutyExecutionRecordReceipt = {
          requestId: request.requestId,
          digest,
          dutyId: duty.id,
          occurrenceId: occurrence.occurrenceId,
          execution: copy(occurrence.execution),
          occurrence: copy(occurrence),
          replayed: false,
        }
        const next = copy(this.state)
        setOwnValue(next.requests, request.requestId, { kind: 'execution', digest, receipt: copy(receipt) })
        await this.commit(next)
        return copy(receipt)
      }
      const execution: WorkDutyExecutionLink = {
        status: request.status,
        taskId: request.taskId,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
        recordedAt: isoNow(),
        ...(request.executorStatus === undefined ? {} : {
          executorStatus: {
            ...request.executorStatus,
            observedAt: isoNow(),
          },
        }),
        ...(request.error === undefined ? {} : { error: request.error }),
      }
      const updatedOccurrence: WorkDutyOccurrenceClaimReceipt = { ...copy(occurrence), execution }
      const receipt: WorkDutyExecutionRecordReceipt = {
        requestId: request.requestId,
        digest,
        dutyId: duty.id,
        occurrenceId: occurrence.occurrenceId,
        execution,
        occurrence: updatedOccurrence,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.occurrences, occurrence.occurrenceId, copy(updatedOccurrence))
      setOwnValue(next.requests, request.requestId, { kind: 'execution', digest, receipt: copy(receipt) })
      await this.commit(next)
      this.emit({ kind: 'occurrence-execution-recorded', duty, occurrence: updatedOccurrence, execution })
      return copy(receipt)
    })
  }

  onChanged(listener: (event: WorkDutyEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async setPaused(
    request: WorkDutyPauseRequest | WorkDutyResumeRequest,
    paused: boolean,
    kind: 'pause' | 'resume',
  ): Promise<WorkDutyMutationReceipt> {
    return this.mutate(async () => {
      const digest = requestDigest(kind, request)
      const replay = replayReceipt<WorkDutyMutationReceipt>(this.state, request.requestId, digest)
      if (replay !== undefined) return replay
      const duty = ownValue(this.state.duties, request.dutyId)
      if (duty === undefined) throw new WorkDutyStoreConflictError('DUTY_NOT_FOUND', `Duty ${request.dutyId} was not found`)
      if (duty.revision !== request.expectedRevision) {
        throw new WorkDutyStoreConflictError('REVISION_CONFLICT', `Expected duty revision ${request.expectedRevision}, found ${duty.revision}`)
      }
      if (duty.paused === paused) {
        const receipt: WorkDutyMutationReceipt = { requestId: request.requestId, digest, duty: copy(duty), dutyId: duty.id, replayed: false }
        const next = copy(this.state)
        setOwnValue(next.requests, request.requestId, { kind, digest, receipt: copy(receipt) })
        await this.commit(next)
        return copy(receipt)
      }
      const updatedDuty: WorkDuty = { ...copy(duty), paused, revision: duty.revision + 1, updatedAt: isoNow() }
      const receipt: WorkDutyMutationReceipt = { requestId: request.requestId, digest, duty: updatedDuty, dutyId: duty.id, replayed: false }
      const next = copy(this.state)
      setOwnValue(next.duties, duty.id, copy(updatedDuty))
      setOwnValue(next.requests, request.requestId, { kind, digest, receipt: copy(receipt) })
      await this.commit(next)
      this.emit({ kind: 'updated', duty: updatedDuty })
      return copy(receipt)
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized()
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(next: WorkDutyState): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const serialized = `${JSON.stringify(next, null, 2)}\n`
      if (this.options.writeFile) await this.options.writeFile(temporaryPath, serialized)
      else await writeFile(temporaryPath, serialized, { mode: 0o600 })
      if (this.options.rename) await this.options.rename(temporaryPath, this.filePath)
      else await rename(temporaryPath, this.filePath)
      this.state = next
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private emit(event: WorkDutyEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(copy(event))
      } catch {
        // Persistence has committed; observers cannot alter the mutation result.
      }
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkDutyStore must be initialized before use')
  }
}
