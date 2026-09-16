import { isWorkflowValue, type WorkflowQuestionProtocol, type WorkflowQuestionResponse } from './workflow.js'
import type {
  EmployeeRunContext,
  EmployeeRunObserverState,
  EmployeeRunSessionEvidence,
  EmployeeRunTaskInput,
  EmployeeRunTerminalEvidence,
  EmployeeRunCancelRequestState,
  EmployeeRunDispatchStage,
  EmployeeExecutionStatus,
} from './employee-runs.js'
import type {
  WorkflowApprovalDecisionReceipt,
  WorkflowCompensationEntry,
  WorkflowEffectReconciliationTarget,
  WorkflowNodeRunState,
  WorkflowQuestionAnswerReceipt,
  WorkflowRunEvent,
  WorkflowRunQueueState,
  WorkflowRunStatus,
  WorkflowValue,
  WorkflowWaitingQuestion,
} from './workflow.js'

export type WorkExecutor =
  | { kind: 'employee'; employeeId: string; methodId?: string; methodVersion?: number }
  | { kind: 'workflow'; workflowId: string; workflowRevision?: number }

export type WorkTaskStatus = 'open' | 'active' | 'review' | 'completed' | 'cancelled'
export type WorkRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface WorkScope {
  projectId?: string
  cwd?: string
  resourceRefs: string[]
}

export interface WorkRequirement {
  version: number
  goal: string
  acceptance: string
  createdAt: string
}

export type WorkTaskCancellationState = 'requested' | 'cancelling' | 'outcome-unknown' | 'cancelled'
export type WorkTaskCancellationTargetState = 'pending' | 'cancelling' | 'cancelled' | 'settled' | 'outcome-unknown'

export interface WorkTaskCancellationTarget {
  commandId: string
  runId: string
  attemptId: string
  requirementVersion: number
  executor: WorkExecutor
  state: WorkTaskCancellationTargetState
  finalRunStatus?: WorkRunStatus
  error?: string
  observedAt: string
}

export interface WorkTaskCancellation {
  requestId: string
  expectedRevision: number
  requestedAt: string
  updatedAt: string
  state: WorkTaskCancellationState
  targets: WorkTaskCancellationTarget[]
}

export interface WorkTask {
  id: string
  revision: number
  title: string
  scope: WorkScope
  requirements: WorkRequirement[]
  currentRequirementVersion: number
  status: WorkTaskStatus
  activeAttemptId?: string
  acceptedArtifactIds: string[]
  cancellation?: WorkTaskCancellation
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

export interface WorkAttempt {
  id: string
  taskId: string
  requirementVersion: number
  reason: 'initial' | 'redo' | 'handoff' | 'requirements-changed'
  responsibility: WorkExecutor
  createdAt: string
}

export interface WorkRunRef {
  taskId: string
  attemptId: string
  runId: string
  executor: WorkExecutor
  commandId: string
  requirementVersion: number
  sourceRunId?: string
  status: WorkRunStatus
  rawStatus: string
  observedAt: string
  capabilities: { cancel: boolean; resume: boolean; append: boolean }
}

export interface WorkArtifact {
  id: string
  taskId: string
  attemptId: string
  runId: string
  requirementVersion: number
  contentVersion: number
  contentHash: string
  kind: 'text' | 'json' | 'file'
  name: string
  storedPath: string
  createdAt: string
}

/**
 * The durable, renderer-safe contract for a question that needs a human answer.
 * Version 1 intentionally supports only scalar text, a selected stable option,
 * or a flat JSON object. More expressive schemas need a new version.
 */
export type WorkQuestionResponse = WorkflowQuestionResponse
export type WorkQuestionActionProtocol = WorkflowQuestionProtocol

export interface WorkAction {
  id: string
  taskId: string
  runId: string
  sourceEventId: string
  requirementVersion: number
  kind: 'approval' | 'question' | 'recovery'
  status: 'open' | 'resolved' | 'superseded'
  nodeId?: string
  /** Present only for question actions produced by a versioned protocol. Legacy questions remain readable but cannot be answered. */
  question?: WorkQuestionActionProtocol
}

export interface WorkTaskSnapshot {
  task: WorkTask
  attempts: WorkAttempt[]
  runs: WorkRunRef[]
  artifacts: WorkArtifact[]
  actions: WorkAction[]
}

/** The renderer may inspect a durable run only through this explicit, redacted projection. */
export interface WorkTaskRunDetailRequest {
  taskId: string
  runId: string
}

/** Details for a direct Employee execution. The immutable employee profile is intentionally omitted. */
export interface WorkTaskEmployeeRunDetail {
  kind: 'employee'
  executor: Extract<WorkExecutor, { kind: 'employee' }>
  taskId: string
  attemptId?: string
  requirementVersion?: number
  runId: string
  commandId: string
  requestDigest: string
  sourceRunId?: string
  employeeId: string
  employeeVersion: number
  task: EmployeeRunTaskInput
  round?: { description?: string; roundId?: string }
  context: EmployeeRunContext
  projectId?: string
  cwd: string
  sessionId: string
  sessionEvidence: EmployeeRunSessionEvidence
  status: EmployeeExecutionStatus
  dispatchStage: EmployeeRunDispatchStage
  promptRequestId: string
  promptAcceptedAt?: string
  observationCursor?: number
  observerState?: EmployeeRunObserverState
  observationError?: string
  terminalEvidence?: EmployeeRunTerminalEvidence
  cancelRequestState?: EmployeeRunCancelRequestState
  cancelRequestError?: string
  partialOutput: string
  output: string
  error?: string
  cancelReason?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  cancelRequestedAt?: string
}

/** Details for a Workflow execution, including node checkpoints and event history. */
export interface WorkTaskWorkflowRunDetail {
  kind: 'workflow'
  executor: WorkExecutor
  taskId: string
  attemptId?: string
  requirementVersion?: number
  runId: string
  commandId: string
  sourceRunId?: string
  workflowId: string
  workflowRevision: number
  environmentId?: string
  releaseId?: string
  traceId?: string
  idempotencyKey?: string
  parentRunId?: string
  workflowAncestry?: string[]
  origin?: { kind: 'top-level' } | { kind: 'child'; parentRunId: string }
  status: WorkflowRunStatus
  queue?: Omit<WorkflowRunQueueState, 'lease'>
  input: WorkflowValue
  output?: WorkflowValue
  nodeStates: WorkflowNodeRunState[]
  events: WorkflowRunEvent[]
  approvalDecisionReceipts?: WorkflowApprovalDecisionReceipt[]
  questionAnswerReceipts?: WorkflowQuestionAnswerReceipt[]
  compensationStack?: WorkflowCompensationEntry[]
  compensationBlocker?: string
  effectReconciliationTargets?: WorkflowEffectReconciliationTarget[]
  allowShellFile: boolean
  allowCode?: boolean
  debug?: boolean
  waitingApprovalNodeId?: string
  waitingQuestionNodeId?: string
  waitingQuestion?: WorkflowWaitingQuestion
  startedAt?: string
  completedAt?: string
}

export type WorkTaskRunDetail = WorkTaskEmployeeRunDetail | WorkTaskWorkflowRunDetail

export interface WorkTaskCreateRequest {
  requestId: string
  title: string
  goal: string
  acceptance: string
  scope: WorkScope
}

export interface WorkTaskExecuteRequest {
  requestId: string
  taskId: string
  expectedRevision: number
  executor: WorkExecutor
  mode: 'initial' | 'continue-attempt' | 'redo' | 'handoff'
  input: unknown
  sourceRunId?: string
}

export interface WorkItemQuery {
  projectId?: string
  employeeId?: string
  workflowId?: string
  includeArchived?: boolean
}

export interface WorkTaskRevisionRequest {
  requestId: string
  taskId: string
  expectedRevision: number
  goal: string
  acceptance: string
}

export interface WorkTaskArchiveRequest {
  requestId: string
  taskId: string
  expectedRevision: number
  archived: boolean
}

/**
 * Permanent deletion is deliberately a preview-only capability in 1.8.
 * The preview is durable and carries enough identity to make a later purge
 * explicit, reviewable, and recoverable before any bytes are removed.
 */
export type WorkTaskDeletionBlockerCode =
  | 'PERMANENT_DELETE_DISABLED'
  | 'TASK_NOT_ARCHIVED'
  | 'ACTIVE_RUN'
  | 'OPEN_ACTION'
  | 'CANCELLATION_UNRESOLVED'

export interface WorkTaskDeletionBlocker {
  code: WorkTaskDeletionBlockerCode
  message: string
  referenceIds: string[]
}

export interface WorkTaskDeletionInventory {
  attemptIds: string[]
  runIds: string[]
  actionIds: string[]
  artifactIds: string[]
  acceptedArtifactIds: string[]
  resourceRefs: string[]
  artifactPaths: string[]
}

/**
 * A planned tombstone, not a claim that the task has been deleted. It keeps
 * task identity and every cross-record reference visible while deletion is
 * still disabled.
 */
export interface WorkTaskTombstonePreview {
  kind: 'work-item-tombstone-preview'
  schemaVersion: 1
  taskId: string
  sourceRevision: number
  snapshotHash: string
  createdAt: string
  references: WorkTaskDeletionInventory
  retention: 'indefinite-until-explicit-purge'
  artifactCleanup: {
    strategy: 'task-owned-artifact-directory'
    status: 'not-executed'
    paths: string[]
  }
  recovery: {
    beforePurge: 'restore-from-retained-snapshot'
    afterPurge: 'unsupported'
  }
}

export interface WorkTaskDeletionPreview {
  requestId: string
  taskId: string
  expectedRevision: number
  observedRevision: number
  generatedAt: string
  canDelete: false
  blockers: WorkTaskDeletionBlocker[]
  inventory: WorkTaskDeletionInventory
  tombstone: WorkTaskTombstonePreview
  message: string
}

export interface WorkTaskDeletePreviewRequest {
  requestId: string
  taskId: string
  expectedRevision: number
}

export interface WorkTaskCancelRequest {
  requestId: string
  taskId: string
  expectedRevision: number
}

export interface WorkArtifactAcceptRequest {
  requestId: string
  taskId: string
  expectedRevision: number
  artifactId: string
  contentVersion: number
  requirementVersion: number
}

export interface WorkRunControlRequest {
  requestId: string
  taskId: string
  runId: string
  expectedRevision: number
  action: 'cancel' | 'resume'
}

export interface WorkActionAnswerRequest {
  requestId: string
  taskId: string
  actionId: string
  expectedSourceEventId: string
  expectedRequirementVersion: number
  /** Required for a versioned question; omitted by legacy approval callers. */
  expectedActionVersion?: number
  answer: unknown
}

export interface WorkItemsBridge {
  list(query?: WorkItemQuery): Promise<WorkTaskSnapshot[]>
  get(taskId: string): Promise<WorkTaskSnapshot | undefined>
  getRunDetail(taskId: string, runId: string): Promise<WorkTaskRunDetail | undefined>
  create(request: WorkTaskCreateRequest): Promise<WorkTaskSnapshot>
  execute(request: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot>
  revise(request: WorkTaskRevisionRequest): Promise<WorkTaskSnapshot>
  cancelTask(request: WorkTaskCancelRequest): Promise<WorkTaskSnapshot>
  archive(request: WorkTaskArchiveRequest): Promise<WorkTaskSnapshot>
  /** Main implementation is available now; renderer bridge remains optional until its UI entry is integrated. */
  previewDelete?(request: WorkTaskDeletePreviewRequest): Promise<WorkTaskDeletionPreview>
  acceptArtifact(request: WorkArtifactAcceptRequest): Promise<WorkTaskSnapshot>
  openArtifact(taskId: string, artifactId: string): Promise<void>
  controlRun(request: WorkRunControlRequest): Promise<WorkTaskSnapshot>
  answerAction(request: WorkActionAnswerRequest): Promise<WorkTaskSnapshot>
  onChanged(listener: (snapshot: WorkTaskSnapshot) => void): () => void
}

export type WorkItemValidationErrorCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'EMPTY_STRING'
  | 'STRING_TOO_LONG'
  | 'INVALID_INTEGER'
  | 'INVALID_VALUE'
  | 'DUPLICATE_VALUE'
  | 'COLLECTION_TOO_LARGE'

export class WorkItemValidationError extends Error {
  readonly code: WorkItemValidationErrorCode
  readonly path: string

  constructor(code: WorkItemValidationErrorCode, path: string, message: string) {
    super(message)
    this.name = 'WorkItemValidationError'
    this.code = code
    this.path = path
  }
}

export const WORK_ITEM_LIMITS = {
  id: 128,
  title: 200,
  requirementText: 10_000,
  cwd: 4_096,
  resourceRef: 2_048,
  resourceRefs: 100
} as const

type UnknownRecord = Record<string, unknown>

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkItemValidationError('INVALID_TYPE', path, `${path} must be an object`)
  }
  return value as UnknownRecord
}

function exactFields(value: UnknownRecord, allowed: readonly string[], path = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const fieldPath = path ? `${path}.${key}` : key
      throw new WorkItemValidationError('UNKNOWN_FIELD', fieldPath, `${fieldPath} is not allowed`)
    }
  }
}

function textField(value: UnknownRecord, key: string, maxLength: number, path = key): string {
  if (!(key in value)) {
    throw new WorkItemValidationError('MISSING_FIELD', path, `${path} is required`)
  }
  if (typeof value[key] !== 'string') {
    throw new WorkItemValidationError('INVALID_TYPE', path, `${path} must be a string`)
  }
  const normalized = value[key].trim()
  if (normalized.length === 0) {
    throw new WorkItemValidationError('EMPTY_STRING', path, `${path} must not be blank`)
  }
  if (normalized.length > maxLength) {
    throw new WorkItemValidationError('STRING_TOO_LONG', path, `${path} exceeds ${maxLength} characters`)
  }
  return normalized
}

function identifierField(value: UnknownRecord, key: string, maxLength: number, path = key): string {
  const normalized = textField(value, key, maxLength, path)
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new WorkItemValidationError('INVALID_VALUE', path, `${path} must not contain control characters`)
  }
  return normalized
}

function optionalIdentifierField(
  value: UnknownRecord,
  key: string,
  maxLength: number,
  path: string
): string | undefined {
  return key in value ? identifierField(value, key, maxLength, path) : undefined
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkItemValidationError('INVALID_INTEGER', path, `${path} must be a positive safe integer`)
  }
  return value as number
}

function workScope(value: unknown): WorkScope {
  const scope = record(value, 'scope')
  exactFields(scope, ['projectId', 'cwd', 'resourceRefs'], 'scope')
  if (!('resourceRefs' in scope)) {
    throw new WorkItemValidationError('MISSING_FIELD', 'scope.resourceRefs', 'scope.resourceRefs is required')
  }
  if (!Array.isArray(scope.resourceRefs)) {
    throw new WorkItemValidationError('INVALID_TYPE', 'scope.resourceRefs', 'scope.resourceRefs must be an array')
  }
  const rawResourceRefs = scope.resourceRefs
  if (rawResourceRefs.length > WORK_ITEM_LIMITS.resourceRefs) {
    throw new WorkItemValidationError(
      'COLLECTION_TOO_LARGE',
      'scope.resourceRefs',
      `scope.resourceRefs exceeds ${WORK_ITEM_LIMITS.resourceRefs} items`
    )
  }
  const resourceRefs = Array.from({ length: rawResourceRefs.length }, (_, index) =>
    identifierField(
      { value: rawResourceRefs[index] },
      'value',
      WORK_ITEM_LIMITS.resourceRef,
      `scope.resourceRefs[${index}]`
    )
  )
  const firstRefIndex = new Map<string, number>()
  resourceRefs.forEach((resourceRef, index) => {
    if (firstRefIndex.has(resourceRef)) {
      throw new WorkItemValidationError(
        'DUPLICATE_VALUE',
        `scope.resourceRefs[${index}]`,
        `scope.resourceRefs[${index}] duplicates an earlier resource reference`
      )
    }
    firstRefIndex.set(resourceRef, index)
  })
  return {
    ...(scope.projectId === undefined
      ? {}
      : { projectId: identifierField(scope, 'projectId', WORK_ITEM_LIMITS.id, 'scope.projectId') }),
    ...(scope.cwd === undefined
      ? {}
      : { cwd: textField(scope, 'cwd', WORK_ITEM_LIMITS.cwd, 'scope.cwd') }),
    resourceRefs
  }
}

function workExecutor(value: unknown): WorkExecutor {
  const executor = record(value, 'executor')
  if (!('kind' in executor)) {
    throw new WorkItemValidationError('MISSING_FIELD', 'executor.kind', 'executor.kind is required')
  }
  if (executor.kind === 'employee') {
    exactFields(executor, ['kind', 'employeeId', 'methodId', 'methodVersion'], 'executor')
    if (executor.methodId !== undefined && executor.methodVersion === undefined) {
      throw new WorkItemValidationError('MISSING_FIELD', 'executor.methodVersion', 'executor.methodVersion is required when methodId is set')
    }
    return {
      kind: 'employee',
      employeeId: identifierField(executor, 'employeeId', WORK_ITEM_LIMITS.id, 'executor.employeeId'),
      ...(executor.methodId === undefined ? {} : {
        methodId: identifierField(executor, 'methodId', WORK_ITEM_LIMITS.id, 'executor.methodId'),
        ...(executor.methodVersion === undefined ? {} : { methodVersion: positiveSafeInteger(executor.methodVersion, 'executor.methodVersion') }),
      }),
    }
  }
  if (executor.kind === 'workflow') {
    exactFields(executor, ['kind', 'workflowId', 'workflowRevision'], 'executor')
    return {
      kind: 'workflow',
      workflowId: identifierField(executor, 'workflowId', WORK_ITEM_LIMITS.id, 'executor.workflowId'),
      ...(executor.workflowRevision === undefined
        ? {}
        : { workflowRevision: positiveSafeInteger(executor.workflowRevision, 'executor.workflowRevision') })
    }
  }
  throw new WorkItemValidationError('INVALID_VALUE', 'executor.kind', 'executor.kind is not supported')
}

export function validateWorkTaskCreateRequest(value: unknown): WorkTaskCreateRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'title', 'goal', 'acceptance', 'scope'])
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    title: textField(request, 'title', WORK_ITEM_LIMITS.title),
    goal: textField(request, 'goal', WORK_ITEM_LIMITS.requirementText),
    acceptance: textField(request, 'acceptance', WORK_ITEM_LIMITS.requirementText),
    scope: workScope(request.scope)
  }
}

export function validateWorkTaskExecuteRequest(value: unknown): WorkTaskExecuteRequest {
  const request = record(value, '$')
  exactFields(request, [
    'requestId', 'taskId', 'expectedRevision', 'executor', 'mode', 'input', 'sourceRunId'
  ])
  if (!('input' in request)) {
    throw new WorkItemValidationError('MISSING_FIELD', 'input', 'input is required')
  }
  if (!['initial', 'continue-attempt', 'redo', 'handoff'].includes(request.mode as string)) {
    throw new WorkItemValidationError('INVALID_VALUE', 'mode', 'mode is not supported')
  }
  const executor = workExecutor(request.executor)
  if (executor.kind === 'workflow' && !isWorkflowValue(request.input)) {
    throw new WorkItemValidationError('INVALID_VALUE', 'input', 'workflow input must be a finite JSON-safe value')
  }
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
    executor,
    mode: request.mode as WorkTaskExecuteRequest['mode'],
    input: request.input,
    ...(request.sourceRunId === undefined
      ? {}
      : { sourceRunId: optionalIdentifierField(request, 'sourceRunId', WORK_ITEM_LIMITS.id, 'sourceRunId') })
  }
}

export function validateWorkTaskRevisionRequest(value: unknown): WorkTaskRevisionRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'taskId', 'expectedRevision', 'goal', 'acceptance'])
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
    goal: textField(request, 'goal', WORK_ITEM_LIMITS.requirementText),
    acceptance: textField(request, 'acceptance', WORK_ITEM_LIMITS.requirementText),
  }
}

export function validateWorkTaskArchiveRequest(value: unknown): WorkTaskArchiveRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'taskId', 'expectedRevision', 'archived'])
  if (!('archived' in request)) {
    throw new WorkItemValidationError('MISSING_FIELD', 'archived', 'archived is required')
  }
  if (typeof request.archived !== 'boolean') {
    throw new WorkItemValidationError('INVALID_TYPE', 'archived', 'archived must be a boolean')
  }
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
    archived: request.archived,
  }
}

export function validateWorkTaskDeletePreviewRequest(value: unknown): WorkTaskDeletePreviewRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'taskId', 'expectedRevision'])
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
  }
}

export function validateWorkTaskCancelRequest(value: unknown): WorkTaskCancelRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'taskId', 'expectedRevision'])
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
  }
}

export function validateWorkTaskRunDetailRequest(value: unknown): WorkTaskRunDetailRequest {
  const request = record(value, '$')
  exactFields(request, ['taskId', 'runId'])
  return {
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    runId: identifierField(request, 'runId', WORK_ITEM_LIMITS.id),
  }
}

export function validateWorkArtifactAcceptRequest(value: unknown): WorkArtifactAcceptRequest {
  const request = record(value, '$')
  exactFields(request, [
    'requestId', 'taskId', 'expectedRevision', 'artifactId', 'contentVersion', 'requirementVersion'
  ])
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
    artifactId: identifierField(request, 'artifactId', WORK_ITEM_LIMITS.id),
    contentVersion: positiveSafeInteger(request.contentVersion, 'contentVersion'),
    requirementVersion: positiveSafeInteger(request.requirementVersion, 'requirementVersion'),
  }
}

export function validateWorkRunControlRequest(value: unknown): WorkRunControlRequest {
  const request = record(value, '$')
  exactFields(request, ['requestId', 'taskId', 'runId', 'expectedRevision', 'action'])
  if (request.action !== 'cancel' && request.action !== 'resume') {
    throw new WorkItemValidationError('INVALID_VALUE', 'action', 'action is not supported')
  }
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    runId: identifierField(request, 'runId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
    action: request.action,
  }
}

export function validateWorkActionAnswerRequest(value: unknown): WorkActionAnswerRequest {
  const request = record(value, '$')
  exactFields(request, [
    'requestId', 'taskId', 'actionId', 'expectedSourceEventId', 'expectedRequirementVersion', 'expectedActionVersion', 'answer'
  ])
  if (!('answer' in request)) {
    throw new WorkItemValidationError('MISSING_FIELD', 'answer', 'answer is required')
  }
  const expectedActionVersion = request.expectedActionVersion === undefined
    ? undefined
    : positiveSafeInteger(request.expectedActionVersion, 'expectedActionVersion')
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    actionId: identifierField(request, 'actionId', WORK_ITEM_LIMITS.id),
    expectedSourceEventId: identifierField(request, 'expectedSourceEventId', WORK_ITEM_LIMITS.id),
    expectedRequirementVersion: positiveSafeInteger(request.expectedRequirementVersion, 'expectedRequirementVersion'),
    ...(expectedActionVersion === undefined ? {} : { expectedActionVersion }),
    answer: request.answer,
  }
}

export function canAcceptWorkArtifact(task: WorkTask, artifact: WorkArtifact): boolean {
  return artifact.taskId === task.id
    && artifact.requirementVersion === task.currentRequirementVersion
    && task.cancellation === undefined
    && task.status !== 'cancelled'
}
