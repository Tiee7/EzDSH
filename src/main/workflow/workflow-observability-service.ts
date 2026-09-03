import type { WorkflowDeploymentAction, WorkflowOperationsHealth, WorkflowObservationAction, WorkflowObservationEvent, WorkflowRelease } from '../../shared/workflow-operations.js'
import type { WorkflowRunEvent, WorkflowRunEventType, WorkflowRunRecord } from '../../shared/workflow.js'
import { WorkflowObservationStore } from './workflow-observation-store.js'

const DEFAULT_RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000

export interface WorkflowObservabilityServiceOptions {
  store: WorkflowObservationStore
  now?: () => string
  recentFailureWindowMs?: number
}

export interface WorkflowDeploymentObservationInput {
  id?: string
  environmentId: string
  releaseId?: string
  traceId?: string
  nodeId?: string
  time?: string
  action: WorkflowDeploymentAction
}

function isWorkflowRelease(input: WorkflowDeploymentObservationInput | WorkflowRelease): input is WorkflowRelease {
  return 'workflowSnapshot' in input && 'workflowRevision' in input && 'contentSha256' in input
}

function actionForReleaseStatus(status: WorkflowRelease['status']): WorkflowDeploymentAction {
  switch (status) {
    case 'published':
      return 'release-published'
    case 'superseded':
      return 'release-superseded'
    case 'rolled-back':
      return 'release-rolled-back'
  }
}

export class WorkflowObservabilityService {
  private readonly now: () => string
  private readonly recentFailureWindowMs: number

  constructor(private readonly options: WorkflowObservabilityServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.recentFailureWindowMs = options.recentFailureWindowMs ?? DEFAULT_RECENT_FAILURE_WINDOW_MS
  }

  async observeRun(record: WorkflowRunRecord): Promise<void> {
    const environmentId = record.environmentId?.trim()
    if (environmentId === undefined || environmentId === '') return
    for (const event of record.events) {
      await this.options.store.append(this.mapRunEvent(record, event, environmentId))
    }
  }

  async recordDeployment(input: WorkflowDeploymentObservationInput | WorkflowRelease): Promise<void> {
    const deployment = isWorkflowRelease(input)
      ? {
          id: input.id,
          environmentId: input.environmentId,
          releaseId: input.id,
          time: input.publishedAt,
          action: actionForReleaseStatus(input.status),
        }
      : input
    const time = deployment.time?.trim() || this.now()
    const id = deployment.id?.trim() || `deployment-${deployment.action}-${deployment.releaseId ?? deployment.environmentId}-${String(Date.parse(time))}`
    await this.options.store.append({
      id,
      environmentId: deployment.environmentId,
      ...(deployment.releaseId === undefined ? {} : { releaseId: deployment.releaseId }),
      ...(deployment.traceId === undefined ? {} : { traceId: deployment.traceId }),
      ...(deployment.nodeId === undefined ? {} : { nodeId: deployment.nodeId }),
      time,
      kind: 'deployment',
      action: deployment.action,
      severity: severityForAction(deployment.action),
      outcome: outcomeForAction(deployment.action),
    })
  }

  health(environmentId: string): WorkflowOperationsHealth {
    const observedAt = this.now()
    const observations = this.options.store.list(environmentId)
    if (observations.length === 0) {
      return {
        environmentId,
        status: 'unknown',
        observedAt,
        reason: 'no-observations',
      }
    }

    const latestDeployment = observations
      .filter((event) => event.kind === 'deployment')
      .sort(compareObservations)
      .at(-1)
    if (latestDeployment?.action === 'release-rolled-back') {
      return {
        environmentId,
        status: 'unhealthy',
        observedAt,
        reason: 'release-rolled-back',
      }
    }

    const nowMs = Date.parse(observedAt)
    const hasRecentFailure = observations.some((event) => (
      event.severity === 'error'
      && !Number.isNaN(Date.parse(event.time))
      && nowMs - Date.parse(event.time) >= 0
      && nowMs - Date.parse(event.time) < this.recentFailureWindowMs
    ))
    if (hasRecentFailure) {
      return {
        environmentId,
        status: 'degraded',
        observedAt,
        reason: 'recent-failures',
      }
    }

    return {
      environmentId,
      status: 'healthy',
      observedAt,
      reason: 'healthy',
    }
  }

  private mapRunEvent(
    record: WorkflowRunRecord,
    event: WorkflowRunEvent,
    environmentId: string,
  ): WorkflowObservationEvent {
    return {
      id: event.id,
      environmentId,
      ...(record.releaseId === undefined ? {} : { releaseId: record.releaseId }),
      runId: record.id,
      ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      time: event.time,
      kind: kindForRunEvent(event.type),
      action: event.type,
      severity: severityForAction(event.type),
      outcome: outcomeForAction(event.type),
    }
  }
}

function compareObservations(left: WorkflowObservationEvent, right: WorkflowObservationEvent): number {
  const byTime = left.time.localeCompare(right.time)
  if (byTime !== 0) return byTime
  return left.id.localeCompare(right.id)
}

function kindForRunEvent(type: WorkflowRunEventType): WorkflowObservationEvent['kind'] {
  switch (type) {
    case 'node-effect-prepared':
    case 'node-effect-dispatched':
    case 'node-effect-confirmed':
      return 'effect'
    case 'node-started':
    case 'node-retry':
    case 'node-completed':
    case 'node-skipped':
    case 'node-failed':
    case 'compensation-started':
    case 'compensation-completed':
    case 'compensation-failed':
    case 'approval-requested':
    case 'approval-resolved':
      return 'node'
    case 'run-created':
    case 'run-started':
    case 'run-completed':
    case 'run-failed':
    case 'run-paused':
    case 'run-cancelled':
      return 'run'
  }
}

function severityForAction(action: WorkflowObservationAction): WorkflowObservationEvent['severity'] {
  switch (action) {
    case 'node-failed':
    case 'compensation-failed':
    case 'run-failed':
      return 'error'
    case 'node-retry':
    case 'run-paused':
    case 'run-cancelled':
      return 'warning'
    default:
      return 'info'
  }
}

function outcomeForAction(action: WorkflowObservationAction): WorkflowObservationEvent['outcome'] {
  switch (action) {
    case 'run-created':
    case 'run-started':
    case 'node-started':
    case 'node-effect-prepared':
    case 'compensation-started':
    case 'approval-requested':
      return 'started'
    case 'node-completed':
    case 'node-effect-confirmed':
    case 'compensation-completed':
    case 'approval-resolved':
    case 'run-completed':
    case 'release-published':
      return 'succeeded'
    case 'node-failed':
    case 'compensation-failed':
    case 'run-failed':
      return 'failed'
    case 'run-cancelled':
      return 'cancelled'
    case 'node-retry':
    case 'node-effect-dispatched':
    case 'node-skipped':
    case 'run-paused':
    case 'release-superseded':
    case 'release-rolled-back':
      return 'unknown'
  }
}
