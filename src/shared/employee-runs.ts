import type { EmployeeSnapshot } from './employees.js'

export type EmployeeExecutionStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type EmployeeRunDispatchStage =
  | 'recorded'
  | 'prompt-in-flight'
  | 'cancel-requested'
  | 'cancelled-before-dispatch'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'outcome-unknown'

export interface EmployeeRunTaskInput {
  description?: string
  taskId?: string
  attemptId?: string
  requirementVersion?: number
  sourceRunId?: string
}

export interface EmployeeRunRoundInput {
  description?: string
  roundId?: string
}

/** Context already established by a trusted Main-process caller. */
export interface EmployeeRunContext {
  cwd: string
  projectId?: string
  sessionId?: string
  /** Required only when Runtime cannot independently list project workspaces. */
  sessionVerification?: 'trusted-main'
}

export interface EmployeeRunStartRequest {
  commandId: string
  employeeId: string
  task: EmployeeRunTaskInput
  round?: EmployeeRunRoundInput
  context: EmployeeRunContext
}

export type EmployeeRunSessionEvidence = 'created' | 'runtime-workspace' | 'trusted-main'

export type EmployeeRunObserverState =
  | 'pending'
  | 'observing'
  | 'completed'
  | 'timeout'
  | 'disconnected'
  | 'unsupported'

export type EmployeeRunCancelRequestState = 'accepted' | 'failed' | 'unsupported'

export interface EmployeeRunTerminalEvidence {
  type: 'turn/end'
  seq: number
  reasonKind: string
}

export interface EmployeeRunObservationEvent {
  cursor: number
  delta?: string
}

export interface EmployeeRunObservationResult {
  outcome: 'completed' | 'cancelled' | 'failed' | 'timeout' | 'disconnected'
  cursor: number
  output: string
  terminalEvidence?: EmployeeRunTerminalEvidence
  error?: string
}

export interface EmployeeRunRecord {
  runId: string
  commandId: string
  requestDigest: string
  employeeId: string
  employeeVersion: number
  employeeSnapshot: EmployeeSnapshot
  task: EmployeeRunTaskInput
  round?: EmployeeRunRoundInput
  context: EmployeeRunContext
  taskId?: string
  attemptId?: string
  requirementVersion?: number
  sourceRunId?: string
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

export interface EmployeeRunStartReceipt {
  run: EmployeeRunRecord
  replayed: boolean
}

export interface EmployeeRunCommandReceipt {
  commandId: string
  requestDigest: string
  run: EmployeeRunRecord
}

export interface EmployeeRunEvent {
  kind: 'created' | 'updated'
  run: EmployeeRunRecord
}

export type EmployeeRunUpdate = Partial<Pick<EmployeeRunRecord,
  | 'status'
  | 'dispatchStage'
  | 'promptAcceptedAt'
  | 'observationCursor'
  | 'observerState'
  | 'observationError'
  | 'terminalEvidence'
  | 'cancelRequestState'
  | 'cancelRequestError'
  | 'partialOutput'
  | 'output'
  | 'error'
  | 'cancelReason'
  | 'updatedAt'
  | 'completedAt'
  | 'cancelRequestedAt'
>>
