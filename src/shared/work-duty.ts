import type { WorkExecutor } from './work-items.js'
import { isWorkflowValue } from './workflow.js'

/**
 * A Work Duty is a durable responsibility attached to one Work Item.  The
 * executor is a snapshot: changing an Employee method or Workflow revision
 * does not silently change a duty that is already scheduled.
 */
export interface WorkDuty {
  id: string
  taskId: string
  executor: WorkExecutor
  /** JSON-safe input passed to each recurring Work Item attempt. */
  input: unknown
  everySeconds: number
  /** IANA time zone used for display and future calendar-aware policies. */
  timezone: string
  /** Canonical UTC timestamp of the next occurrence to be considered. */
  nextOccurrenceAt: string
  paused: boolean
  /** Version of the bounded catch-up policy used by this duty. */
  missedPolicy: 'catch-up-once'
  revision: number
  createdAt: string
  updatedAt: string
}

export interface WorkDutyCreateRequest {
  requestId: string
  taskId: string
  executor: WorkExecutor
  input: unknown
  everySeconds: number
  timezone: string
  nextOccurrenceAt: string
  paused?: boolean
}

export interface WorkDutyPauseRequest {
  requestId: string
  dutyId: string
  expectedRevision: number
}

export interface WorkDutyResumeRequest {
  requestId: string
  dutyId: string
  expectedRevision: number
}

export interface WorkDutyOccurrenceClaimRequest {
  requestId: string
  dutyId: string
  /** A caller supplied clock makes wake-up/retry behavior deterministic. */
  now?: string
  /** Re-supply the observed occurrence when retrying after an uncertain write. */
  occurrenceAt?: string
}

export type WorkDutyExecutionStatus = 'submitted' | 'failed'

export interface WorkDutyExecutionLink {
  status: WorkDutyExecutionStatus
  taskId: string
  runId?: string
  commandId?: string
  recordedAt: string
  error?: string
}

export interface WorkDutyExecutionRecordRequest {
  requestId: string
  dutyId: string
  occurrenceId: string
  taskId: string
  status: WorkDutyExecutionStatus
  runId?: string
  commandId?: string
  error?: string
}

export interface WorkDutyCreateReceipt {
  requestId: string
  digest: string
  duty: WorkDuty
  replayed: boolean
}

export interface WorkDutyMutationReceipt {
  requestId: string
  digest: string
  dutyId: string
  duty: WorkDuty
  replayed: boolean
}

export interface WorkDutyOccurrenceClaimReceipt {
  /** The request that first recorded this occurrence. */
  requestId: string
  dutyId: string
  occurrenceId: string
  occurrenceAt: string
  /** The next occurrence after applying the bounded missed policy. */
  nextOccurrenceAt: string
  /** Number of additional due slots skipped after the one catch-up. */
  skippedOccurrences: number
  duty: WorkDuty
  execution?: WorkDutyExecutionLink
  replayed: boolean
}

export interface WorkDutyExecutionRecordReceipt {
  requestId: string
  digest: string
  dutyId: string
  occurrenceId: string
  execution: WorkDutyExecutionLink
  occurrence: WorkDutyOccurrenceClaimReceipt
  replayed: boolean
}

export interface WorkDutyEvent {
  kind: 'created' | 'updated' | 'occurrence-claimed' | 'occurrence-execution-recorded'
  duty: WorkDuty
  occurrence?: WorkDutyOccurrenceClaimReceipt
  execution?: WorkDutyExecutionLink
}

export type WorkDutyValidationErrorCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'EMPTY_STRING'
  | 'STRING_TOO_LONG'
  | 'INVALID_INTEGER'
  | 'INVALID_VALUE'

export class WorkDutyValidationError extends Error {
  readonly code: WorkDutyValidationErrorCode
  readonly path: string

  constructor(code: WorkDutyValidationErrorCode, path: string, message: string) {
    super(message)
    this.name = 'WorkDutyValidationError'
    this.code = code
    this.path = path
  }
}

export const WORK_DUTY_LIMITS = {
  id: 128,
  timezone: 128,
  everySecondsMinimum: 300,
} as const

type UnknownRecord = Record<string, unknown>

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkDutyValidationError('INVALID_TYPE', path, `${path} must be an object`)
  }
  return value as UnknownRecord
}

function exactFields(value: UnknownRecord, allowed: readonly string[], path = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const fieldPath = path === '' ? key : `${path}.${key}`
      throw new WorkDutyValidationError('UNKNOWN_FIELD', fieldPath, `${fieldPath} is not allowed`)
    }
  }
}

function textField(value: UnknownRecord, key: string, maxLength: number, path = key): string {
  if (!(key in value)) throw new WorkDutyValidationError('MISSING_FIELD', path, `${path} is required`)
  if (typeof value[key] !== 'string') throw new WorkDutyValidationError('INVALID_TYPE', path, `${path} must be a string`)
  const normalized = value[key].trim()
  if (normalized === '') throw new WorkDutyValidationError('EMPTY_STRING', path, `${path} must not be blank`)
  if (normalized.length > maxLength) throw new WorkDutyValidationError('STRING_TOO_LONG', path, `${path} exceeds ${maxLength} characters`)
  if (/[\x00-\x1f\x7f]/u.test(normalized)) throw new WorkDutyValidationError('INVALID_VALUE', path, `${path} must not contain control characters`)
  return normalized
}

function identifierField(value: UnknownRecord, key: string, path = key): string {
  return textField(value, key, WORK_DUTY_LIMITS.id, path)
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkDutyValidationError('INVALID_INTEGER', path, `${path} must be a positive safe integer`)
  }
  return value as number
}

function everySeconds(value: unknown, path = 'everySeconds'): number {
  const seconds = positiveSafeInteger(value, path)
  if (seconds < WORK_DUTY_LIMITS.everySecondsMinimum) {
    throw new WorkDutyValidationError('INVALID_INTEGER', path, `${path} must be at least ${WORK_DUTY_LIMITS.everySecondsMinimum} seconds`)
  }
  return seconds
}

function timestamp(value: unknown, path: string): string {
  const input = textField({ value }, 'value', 64, path)
  // Keep persisted occurrence identities canonical even when callers omit
  // milliseconds or use an explicit UTC offset.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(input)) {
    throw new WorkDutyValidationError('INVALID_VALUE', path, `${path} must be an ISO-8601 timestamp with a time zone`)
  }
  const parsed = new Date(input)
  if (Number.isNaN(parsed.getTime())) throw new WorkDutyValidationError('INVALID_VALUE', path, `${path} is not a valid timestamp`)
  return parsed.toISOString()
}

function timezone(value: unknown): string {
  const zone = textField({ value }, 'value', WORK_DUTY_LIMITS.timezone, 'timezone')
  try {
    // Intl is the platform's IANA database; this rejects arbitrary labels and
    // keeps timezone validation in the shared boundary.
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
  } catch {
    throw new WorkDutyValidationError('INVALID_VALUE', 'timezone', 'timezone must be a valid IANA time zone')
  }
  return zone
}

function workExecutor(value: unknown): WorkExecutor {
  const executor = record(value, 'executor')
  if (executor.kind === 'employee') {
    exactFields(executor, ['kind', 'employeeId', 'methodId', 'methodVersion'], 'executor')
    const methodId = executor.methodId === undefined
      ? undefined
      : identifierField(executor, 'methodId', 'executor.methodId')
    if (methodId !== undefined && executor.methodVersion === undefined) {
      throw new WorkDutyValidationError('MISSING_FIELD', 'executor.methodVersion', 'executor.methodVersion is required when methodId is set')
    }
    return {
      kind: 'employee',
      employeeId: identifierField(executor, 'employeeId', 'executor.employeeId'),
      ...(methodId === undefined ? {} : {
        methodId,
        methodVersion: positiveSafeInteger(executor.methodVersion, 'executor.methodVersion'),
      }),
    }
  }
  if (executor.kind === 'workflow') {
    exactFields(executor, ['kind', 'workflowId', 'workflowRevision'], 'executor')
    return {
      kind: 'workflow',
      workflowId: identifierField(executor, 'workflowId', 'executor.workflowId'),
      ...(executor.workflowRevision === undefined ? {} : {
        workflowRevision: positiveSafeInteger(executor.workflowRevision, 'executor.workflowRevision'),
      }),
    }
  }
  if (!('kind' in executor)) throw new WorkDutyValidationError('MISSING_FIELD', 'executor.kind', 'executor.kind is required')
  throw new WorkDutyValidationError('INVALID_VALUE', 'executor.kind', 'executor.kind is not supported')
}

function dutyFields(value: UnknownRecord, path: string): WorkDuty {
  exactFields(value, [
    'id', 'taskId', 'executor', 'input', 'everySeconds', 'timezone', 'nextOccurrenceAt', 'paused',
    'missedPolicy', 'revision', 'createdAt', 'updatedAt',
  ], path)
  if (!('paused' in value)) {
    throw new WorkDutyValidationError('MISSING_FIELD', `${path}.paused`, `${path}.paused is required`)
  }
  if (typeof value.paused !== 'boolean') {
    throw new WorkDutyValidationError('INVALID_TYPE', `${path}.paused`, `${path}.paused must be a boolean`)
  }
  if (value.missedPolicy !== 'catch-up-once') {
    throw new WorkDutyValidationError('INVALID_VALUE', `${path}.missedPolicy`, `${path}.missedPolicy is not supported`)
  }
  if (!isWorkflowValue(value.input)) {
    throw new WorkDutyValidationError('INVALID_VALUE', `${path}.input`, `${path}.input must be a finite JSON-safe value`)
  }
  return {
    id: identifierField(value, 'id', `${path}.id`),
    taskId: identifierField(value, 'taskId', `${path}.taskId`),
    executor: workExecutorAt(value.executor, `${path}.executor`),
    input: structuredClone(value.input),
    everySeconds: everySeconds(value.everySeconds, `${path}.everySeconds`),
    timezone: timezoneAt(value.timezone, `${path}.timezone`),
    nextOccurrenceAt: timestampAt(value.nextOccurrenceAt, `${path}.nextOccurrenceAt`),
    paused: value.paused === true,
    missedPolicy: 'catch-up-once',
    revision: positiveSafeInteger(value.revision, `${path}.revision`),
    createdAt: timestampAt(value.createdAt, `${path}.createdAt`),
    updatedAt: timestampAt(value.updatedAt, `${path}.updatedAt`),
  }
}

function textAt(value: unknown, path: string, maxLength: number): string {
  return textField({ value }, 'value', maxLength, path)
}

function identifierAt(value: unknown, path: string): string {
  return textAt(value, path, WORK_DUTY_LIMITS.id)
}

function timestampAt(value: unknown, path: string): string {
  return timestamp(value, path)
}

function executionLink(value: unknown, path: string): WorkDutyExecutionLink {
  const execution = record(value, path)
  exactFields(execution, ['status', 'taskId', 'runId', 'commandId', 'recordedAt', 'error'], path)
  if (execution.status !== 'submitted' && execution.status !== 'failed') {
    throw new WorkDutyValidationError('INVALID_VALUE', `${path}.status`, `${path}.status is not supported`)
  }
  const runId = execution.runId === undefined ? undefined : identifierAt(execution.runId, `${path}.runId`)
  const commandId = execution.commandId === undefined ? undefined : identifierAt(execution.commandId, `${path}.commandId`)
  const error = execution.error === undefined ? undefined : textAt(execution.error, `${path}.error`, 4_000)
  return {
    status: execution.status,
    taskId: identifierAt(execution.taskId, `${path}.taskId`),
    ...(runId === undefined ? {} : { runId }),
    ...(commandId === undefined ? {} : { commandId }),
    recordedAt: timestampAt(execution.recordedAt, `${path}.recordedAt`),
    ...(error === undefined ? {} : { error }),
  }
}

export function validateWorkDutyExecutionLink(value: unknown): WorkDutyExecutionLink {
  return executionLink(value, '$')
}

function timezoneAt(value: unknown, path: string): string {
  const zone = textAt(value, path, WORK_DUTY_LIMITS.timezone)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format()
  } catch {
    throw new WorkDutyValidationError('INVALID_VALUE', path, `${path} must be a valid IANA time zone`)
  }
  return zone
}

function workExecutorAt(value: unknown, path: string): WorkExecutor {
  const executor = record(value, path)
  if (executor.kind === 'employee') {
    exactFields(executor, ['kind', 'employeeId', 'methodId', 'methodVersion'], path)
    const methodId = executor.methodId === undefined ? undefined : identifierAt(executor.methodId, `${path}.methodId`)
    if (methodId !== undefined && executor.methodVersion === undefined) {
      throw new WorkDutyValidationError('MISSING_FIELD', `${path}.methodVersion`, `${path}.methodVersion is required when methodId is set`)
    }
    return {
      kind: 'employee',
      employeeId: identifierAt(executor.employeeId, `${path}.employeeId`),
      ...(methodId === undefined ? {} : { methodId, methodVersion: positiveSafeInteger(executor.methodVersion, `${path}.methodVersion`) }),
    }
  }
  if (executor.kind === 'workflow') {
    exactFields(executor, ['kind', 'workflowId', 'workflowRevision'], path)
    return {
      kind: 'workflow',
      workflowId: identifierAt(executor.workflowId, `${path}.workflowId`),
      ...(executor.workflowRevision === undefined ? {} : { workflowRevision: positiveSafeInteger(executor.workflowRevision, `${path}.workflowRevision`) }),
    }
  }
  if (!('kind' in executor)) throw new WorkDutyValidationError('MISSING_FIELD', `${path}.kind`, `${path}.kind is required`)
  throw new WorkDutyValidationError('INVALID_VALUE', `${path}.kind`, `${path}.kind is not supported`)
}

export function occurrenceId(dutyId: string, occurrenceAt: string): string {
  return `${dutyId}:${occurrenceAt}`
}

export function validateWorkDutyCreateRequest(value: unknown): WorkDutyCreateRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'taskId', 'executor', 'input', 'everySeconds', 'timezone', 'nextOccurrenceAt', 'paused'])
  if (!('input' in request) || !isWorkflowValue(request.input)) {
    throw new WorkDutyValidationError('INVALID_VALUE', 'input', 'input must be a finite JSON-safe value')
  }
  if (request.paused !== undefined && typeof request.paused !== 'boolean') {
    throw new WorkDutyValidationError('INVALID_TYPE', 'paused', 'paused must be a boolean')
  }
  return {
    requestId: identifierField(request, 'requestId'),
    taskId: identifierField(request, 'taskId'),
    executor: workExecutor(request.executor),
    input: structuredClone(request.input),
    everySeconds: everySeconds(request.everySeconds),
    timezone: timezone(request.timezone),
    nextOccurrenceAt: timestamp(request.nextOccurrenceAt, 'nextOccurrenceAt'),
    ...(request.paused === true ? { paused: true } : {}),
  }
}

export function validateWorkDutyPauseRequest(value: unknown): WorkDutyPauseRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'dutyId', 'expectedRevision'])
  return {
    requestId: identifierField(request, 'requestId'),
    dutyId: identifierField(request, 'dutyId'),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
  }
}

export function validateWorkDutyResumeRequest(value: unknown): WorkDutyResumeRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'dutyId', 'expectedRevision'])
  return {
    requestId: identifierField(request, 'requestId'),
    dutyId: identifierField(request, 'dutyId'),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
  }
}

export function validateWorkDutyOccurrenceClaimRequest(value: unknown): WorkDutyOccurrenceClaimRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'dutyId', 'now', 'occurrenceAt'])
  const now = request.now === undefined ? undefined : timestamp(request.now, 'now')
  const occurrenceAt = request.occurrenceAt === undefined ? undefined : timestamp(request.occurrenceAt, 'occurrenceAt')
  return {
    requestId: identifierField(request, 'requestId'),
    dutyId: identifierField(request, 'dutyId'),
    ...(now === undefined ? {} : { now }),
    ...(occurrenceAt === undefined ? {} : { occurrenceAt }),
  }
}

export function validateWorkDutyExecutionRecordRequest(value: unknown): WorkDutyExecutionRecordRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'dutyId', 'occurrenceId', 'taskId', 'status', 'runId', 'commandId', 'error'])
  if (request.status !== 'submitted' && request.status !== 'failed') {
    throw new WorkDutyValidationError('INVALID_VALUE', 'status', 'status is not supported')
  }
  const runId = request.runId === undefined ? undefined : identifierField(request, 'runId')
  const commandId = request.commandId === undefined ? undefined : identifierField(request, 'commandId')
  const error = request.error === undefined ? undefined : textField(request, 'error', 4_000)
  return {
    requestId: identifierField(request, 'requestId'),
    dutyId: identifierField(request, 'dutyId'),
    occurrenceId: textField(request, 'occurrenceId', 256),
    taskId: identifierField(request, 'taskId'),
    status: request.status,
    ...(runId === undefined ? {} : { runId }),
    ...(commandId === undefined ? {} : { commandId }),
    ...(error === undefined ? {} : { error }),
  }
}

export function validateWorkDuty(value: unknown): WorkDuty {
  return dutyFields(record(value, '$'), '$')
}
