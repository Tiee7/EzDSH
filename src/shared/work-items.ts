import { isWorkflowValue, type WorkflowQuestionProtocol, type WorkflowQuestionResponse } from './workflow.js'
import type { ConversationWorkOrigin } from './conversation-work.js'
import type { WorkbenchMigrationOrigin } from './workbench-migration.js'
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
  /**
   * Typed material identities selected for this Work Item. `resourceRefs` is
   * retained for schema-v1 compatibility and is display-only until a typed
   * selection is explicitly authorized by Main.
   */
  materialRefs?: WorkMaterialRef[]
}

export type WorkMaterialKind = 'local-file' | 'project-document' | 'external-link' | 'generated-artifact'

interface WorkMaterialRefBase {
  materialId: string
  label?: string
}

/** A durable identity, never proof that the bytes have been read or granted. */
export type WorkMaterialRef =
  | (WorkMaterialRefBase & { kind: 'local-file'; path: string })
  | (WorkMaterialRefBase & { kind: 'project-document'; projectId: string; documentId: string })
  | (WorkMaterialRefBase & { kind: 'external-link'; url: string })
  | (WorkMaterialRefBase & { kind: 'generated-artifact'; artifactId: string; contentVersion: number })

/** Explicit per-attempt selection. Omitting a material means it is not sent to an executor. */
export interface WorkMaterialInput {
  materialId: string
  /** Optional optimistic identity check supplied by a stale-safe caller. */
  expectedVersion?: string
}

/** Main-owned, redacted snapshot proving which selected material was authorized. */
export interface WorkMaterialAuthorization {
  materialId: string
  kind: WorkMaterialKind
  version: string
  fingerprint: string
  authorizedAt: string
}

export interface WorkMaterialAuthorizationRequest {
  task: WorkTaskSnapshot
  requirementVersion: number
  inputs: WorkMaterialInput[]
}

export type WorkMaterialAuthorizer = (
  request: WorkMaterialAuthorizationRequest,
) => Promise<WorkMaterialAuthorization[]>

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
  /** Optional provenance for tasks explicitly converted from another surface. */
  origin?: ConversationWorkOrigin | WorkbenchMigrationOrigin
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
  /** Immutable Main authorization snapshot for this attempt, if materials were selected. */
  materialAuthorizations?: WorkMaterialAuthorization[]
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
  origin?: ConversationWorkOrigin | WorkbenchMigrationOrigin
}

export interface WorkTaskExecuteRequest {
  requestId: string
  taskId: string
  expectedRevision: number
  executor: WorkExecutor
  mode: 'initial' | 'continue-attempt' | 'redo' | 'handoff'
  input: unknown
  /** Explicit material selection; legacy scope.resourceRefs are never inferred here. */
  materialInputs?: WorkMaterialInput[]
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
 * Permanent deletion is a developer-only, explicitly confirmed capability.
 * The preview is durable and carries enough identity to make a later purge
 * reviewable and recoverable before any bytes are removed.
 */
export type WorkTaskDeletionBlockerCode =
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
    status: 'not-executed' | 'pending' | 'removed' | 'failed'
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
  canDelete: boolean
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

export const WORK_ITEM_PURGE_CONFIRMATION = 'DELETE_WORK_ITEM'

export interface WorkTaskDeletionPurgeRequest {
  requestId: string
  taskId: string
  expectedRevision: number
  previewRequestId: string
  expectedSnapshotHash: string
  confirmation: typeof WORK_ITEM_PURGE_CONFIRMATION
}

export type WorkTaskDeletionPurgeStage = 'prepared' | 'purged' | 'failed'

export interface WorkTaskDeletionPurgeReceipt {
  requestId: string
  taskId: string
  previewRequestId: string
  expectedRevision: number
  stage: WorkTaskDeletionPurgeStage
  tombstone: WorkTaskTombstonePreview
  createdAt: string
  updatedAt: string
  error?: string
  replayed: boolean
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
  /** Optional read-only project join; unavailable during workspace startup. */
  getProjectContext?(query?: import('./project-context.js').WorkItemProjectContextQuery): Promise<import('./project-context.js').WorkItemProjectContextSnapshot>
  create(request: WorkTaskCreateRequest): Promise<WorkTaskSnapshot>
  execute(request: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot>
  revise(request: WorkTaskRevisionRequest): Promise<WorkTaskSnapshot>
  cancelTask(request: WorkTaskCancelRequest): Promise<WorkTaskSnapshot>
  archive(request: WorkTaskArchiveRequest): Promise<WorkTaskSnapshot>
  /** Developer-only, durable preview for an explicitly confirmed purge. */
  previewDelete?(request: WorkTaskDeletePreviewRequest): Promise<WorkTaskDeletionPreview>
  /** Developer-only, explicitly confirmed permanent deletion. */
  purgeDelete?(request: WorkTaskDeletionPurgeRequest): Promise<WorkTaskDeletionPurgeReceipt>
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
  resourceRefs: 100,
  materialRefs: 100
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

function optionalTextField(
  value: UnknownRecord,
  key: string,
  maxLength: number,
  path: string,
): string | undefined {
  return key in value ? textField(value, key, maxLength, path) : undefined
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkItemValidationError('INVALID_INTEGER', path, `${path} must be a positive safe integer`)
  }
  return value as number
}

function workMaterialRef(value: unknown, path: string): WorkMaterialRef {
  const material = record(value, path)
  if (!('kind' in material)) {
    throw new WorkItemValidationError('MISSING_FIELD', `${path}.kind`, `${path}.kind is required`)
  }
  const materialId = identifierField(material, 'materialId', WORK_ITEM_LIMITS.id, `${path}.materialId`)
  const label = optionalTextField(material, 'label', WORK_ITEM_LIMITS.title, `${path}.label`)
  if (material.kind === 'local-file') {
    exactFields(material, ['kind', 'materialId', 'label', 'path'], path)
    return {
      kind: 'local-file', materialId,
      path: identifierField(material, 'path', WORK_ITEM_LIMITS.cwd, `${path}.path`),
      ...(label === undefined ? {} : { label }),
    }
  }
  if (material.kind === 'project-document') {
    exactFields(material, ['kind', 'materialId', 'label', 'projectId', 'documentId'], path)
    return {
      kind: 'project-document', materialId,
      projectId: identifierField(material, 'projectId', WORK_ITEM_LIMITS.id, `${path}.projectId`),
      documentId: identifierField(material, 'documentId', WORK_ITEM_LIMITS.id, `${path}.documentId`),
      ...(label === undefined ? {} : { label }),
    }
  }
  if (material.kind === 'external-link') {
    exactFields(material, ['kind', 'materialId', 'label', 'url'], path)
    const url = textField(material, 'url', WORK_ITEM_LIMITS.resourceRef, `${path}.url`)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new WorkItemValidationError('INVALID_VALUE', `${path}.url`, `${path}.url must be an absolute HTTP(S) URL`)
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
      throw new WorkItemValidationError('INVALID_VALUE', `${path}.url`, `${path}.url must be an HTTP(S) URL without embedded credentials`)
    }
    return { kind: 'external-link', materialId, url, ...(label === undefined ? {} : { label }) }
  }
  if (material.kind === 'generated-artifact') {
    exactFields(material, ['kind', 'materialId', 'label', 'artifactId', 'contentVersion'], path)
    return {
      kind: 'generated-artifact', materialId,
      artifactId: identifierField(material, 'artifactId', WORK_ITEM_LIMITS.id, `${path}.artifactId`),
      contentVersion: positiveSafeInteger(material.contentVersion, `${path}.contentVersion`),
      ...(label === undefined ? {} : { label }),
    }
  }
  throw new WorkItemValidationError('INVALID_VALUE', `${path}.kind`, `${path}.kind is not supported`)
}

function workMaterialInputs(value: unknown): WorkMaterialInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new WorkItemValidationError('INVALID_TYPE', 'materialInputs', 'materialInputs must be an array')
  }
  if (value.length > WORK_ITEM_LIMITS.materialRefs) {
    throw new WorkItemValidationError(
      'COLLECTION_TOO_LARGE', 'materialInputs', `materialInputs exceeds ${WORK_ITEM_LIMITS.materialRefs} items`,
    )
  }
  const inputs = value.map((candidate, index) => {
    const input = record(candidate, `materialInputs[${index}]`)
    exactFields(input, ['materialId', 'expectedVersion'], `materialInputs[${index}]`)
    return {
      materialId: identifierField(input, 'materialId', WORK_ITEM_LIMITS.id, `materialInputs[${index}].materialId`),
      ...(input.expectedVersion === undefined
        ? {}
        : { expectedVersion: identifierField(input, 'expectedVersion', WORK_ITEM_LIMITS.resourceRef, `materialInputs[${index}].expectedVersion`) }),
    }
  })
  const seen = new Set<string>()
  inputs.forEach((input, index) => {
    if (seen.has(input.materialId)) {
      throw new WorkItemValidationError('DUPLICATE_VALUE', `materialInputs[${index}].materialId`, `materialInputs[${index}].materialId duplicates an earlier material`)
    }
    seen.add(input.materialId)
  })
  return inputs
}

function workScope(value: unknown): WorkScope {
  const scope = record(value, 'scope')
  exactFields(scope, ['projectId', 'cwd', 'resourceRefs', 'materialRefs'], 'scope')
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
  let materialRefs: WorkMaterialRef[] | undefined
  if (scope.materialRefs !== undefined) {
    if (!Array.isArray(scope.materialRefs)) {
      throw new WorkItemValidationError('INVALID_TYPE', 'scope.materialRefs', 'scope.materialRefs must be an array')
    }
    if (scope.materialRefs.length > WORK_ITEM_LIMITS.materialRefs) {
      throw new WorkItemValidationError(
        'COLLECTION_TOO_LARGE', 'scope.materialRefs', `scope.materialRefs exceeds ${WORK_ITEM_LIMITS.materialRefs} items`,
      )
    }
    materialRefs = scope.materialRefs.map((candidate, index) => workMaterialRef(candidate, `scope.materialRefs[${index}]`))
    const seenMaterialIds = new Set<string>()
    materialRefs.forEach((material, index) => {
      if (seenMaterialIds.has(material.materialId)) {
        throw new WorkItemValidationError('DUPLICATE_VALUE', `scope.materialRefs[${index}].materialId`, `scope.materialRefs[${index}].materialId duplicates an earlier material`)
      }
      seenMaterialIds.add(material.materialId)
    })
  }
  return {
    ...(scope.projectId === undefined
      ? {}
      : { projectId: identifierField(scope, 'projectId', WORK_ITEM_LIMITS.id, 'scope.projectId') }),
    ...(scope.cwd === undefined
      ? {}
      : { cwd: textField(scope, 'cwd', WORK_ITEM_LIMITS.cwd, 'scope.cwd') }),
    resourceRefs,
    ...(materialRefs === undefined ? {} : { materialRefs }),
  }
}

function workOrigin(value: unknown): ConversationWorkOrigin | WorkbenchMigrationOrigin {
  const origin = record(value, 'origin')
  if (origin.kind === 'conversation') {
    exactFields(origin, ['kind', 'sessionId', 'throughSeq', 'snapshotHash'], 'origin')
    if (typeof origin.throughSeq !== 'number' || !Number.isSafeInteger(origin.throughSeq) || origin.throughSeq < -1) {
      throw new WorkItemValidationError('INVALID_INTEGER', 'origin.throughSeq', 'origin.throughSeq must be a safe sequence number')
    }
    if (typeof origin.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/u.test(origin.snapshotHash)) {
      throw new WorkItemValidationError('INVALID_VALUE', 'origin.snapshotHash', 'origin.snapshotHash must be a SHA-256 hex digest')
    }
    return {
      kind: 'conversation',
      sessionId: identifierField(origin, 'sessionId', WORK_ITEM_LIMITS.id, 'origin.sessionId'),
      throughSeq: origin.throughSeq,
      snapshotHash: origin.snapshotHash,
    }
  }
  if (origin.kind === 'workbench-migration') {
    exactFields(origin, ['kind', 'sourceType', 'sourceId', 'sourceSnapshotHash', 'mappingHash', 'identity', 'sourceFingerprint'], 'origin')
    if (origin.sourceType !== 'ezdsh-workbench-v1') {
      throw new WorkItemValidationError('INVALID_VALUE', 'origin.sourceType', 'origin.sourceType is not supported')
    }
    const hashes = {
      sourceSnapshotHash: origin.sourceSnapshotHash,
      mappingHash: origin.mappingHash,
      sourceFingerprint: origin.sourceFingerprint,
    }
    for (const key of ['sourceSnapshotHash', 'mappingHash', 'sourceFingerprint'] as const) {
      if (typeof hashes[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(hashes[key])) {
        throw new WorkItemValidationError('INVALID_VALUE', `origin.${key}`, `origin.${key} must be a SHA-256 hex digest`)
      }
    }
    const sourceSnapshotHash = hashes.sourceSnapshotHash as string
    const mappingHash = hashes.mappingHash as string
    const sourceFingerprint = hashes.sourceFingerprint as string
    return {
      kind: 'workbench-migration',
      sourceType: 'ezdsh-workbench-v1',
      sourceId: identifierField(origin, 'sourceId', WORK_ITEM_LIMITS.id, 'origin.sourceId'),
      sourceSnapshotHash,
      mappingHash,
      identity: identifierField(origin, 'identity', WORK_ITEM_LIMITS.id, 'origin.identity'),
      sourceFingerprint,
    }
  }
  throw new WorkItemValidationError('INVALID_VALUE', 'origin.kind', 'origin.kind is not supported')
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
  exactFields(request, ['requestId', 'title', 'goal', 'acceptance', 'scope', 'origin'])
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    title: textField(request, 'title', WORK_ITEM_LIMITS.title),
    goal: textField(request, 'goal', WORK_ITEM_LIMITS.requirementText),
    acceptance: textField(request, 'acceptance', WORK_ITEM_LIMITS.requirementText),
    scope: workScope(request.scope),
    ...(request.origin === undefined ? {} : { origin: workOrigin(request.origin) }),
  }
}

export function validateWorkTaskExecuteRequest(value: unknown): WorkTaskExecuteRequest {
  const request = record(value, '$')
  exactFields(request, [
    'requestId', 'taskId', 'expectedRevision', 'executor', 'mode', 'input', 'materialInputs', 'sourceRunId'
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
    ...(request.materialInputs === undefined ? {} : { materialInputs: workMaterialInputs(request.materialInputs) }),
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

export function validateWorkTaskDeletionPurgeRequest(value: unknown): WorkTaskDeletionPurgeRequest {
  const request = record(value, '$')
  exactFields(request, [
    'requestId', 'taskId', 'expectedRevision', 'previewRequestId', 'expectedSnapshotHash', 'confirmation'
  ])
  if (request.confirmation !== WORK_ITEM_PURGE_CONFIRMATION) {
    throw new WorkItemValidationError('INVALID_VALUE', 'confirmation', 'confirmation does not match the permanent deletion command')
  }
  return {
    requestId: identifierField(request, 'requestId', WORK_ITEM_LIMITS.id),
    taskId: identifierField(request, 'taskId', WORK_ITEM_LIMITS.id),
    expectedRevision: positiveSafeInteger(request.expectedRevision, 'expectedRevision'),
    previewRequestId: identifierField(request, 'previewRequestId', WORK_ITEM_LIMITS.id),
    expectedSnapshotHash: identifierField(request, 'expectedSnapshotHash', 128),
    confirmation: WORK_ITEM_PURGE_CONFIRMATION,
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
