import type { WorkflowRunRecord } from '../../shared/workflow.js'
import type {
  WorkflowCustomerEnvironment,
  WorkflowOperationalHealth,
  WorkflowOperationalHealthQuery,
  WorkflowObservationEvent,
  WorkflowRelease,
  WorkflowConnectorHealthEvidence,
} from '../../shared/workflow-operations.js'
import { verifyWorkflowReleaseIntegrity } from './workflow-release-integrity.js'
import type { WorkflowReleaseIntegrityFailure } from './workflow-release-store.js'
import type { WorkflowRunServiceOperationsSnapshot } from './workflow-run-service.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
// The default Worker renews a 60-second lease every 30 seconds. Leave enough
// margin for timer jitter and durable-store latency before declaring it stale.
const DEFAULT_WORKER_STALE_AFTER_MS = 90_000
const DEFAULT_RECENT_FAILURE_WINDOW_MS = 60 * 60 * 1000

export interface WorkflowOperationalHealthServiceOptions {
  getRunServiceOperations: (environmentId?: string) => WorkflowRunServiceOperationsSnapshot
  resolveEnvironment: (environmentId: string) => WorkflowCustomerEnvironment | undefined
  listReleases: () => WorkflowRelease[]
  listReleaseIntegrityFailures: () => WorkflowReleaseIntegrityFailure[]
  listRuns: () => WorkflowRunRecord[]
  /** Ordered by event time and then durable append order. */
  listObservations: () => WorkflowObservationEvent[]
  getConnectorHealthSnapshot?: (query: WorkflowOperationalHealthQuery) => WorkflowConnectorHealthEvidence[]
  now?: () => string
  workerStaleAfterMs?: number
  recentFailureWindowMs?: number
}

type ReleaseEvidence = WorkflowOperationalHealth['release']

interface ReleaseAssessment {
  evidence: ReleaseEvidence
  current?: WorkflowRelease
  issue?: 'missing' | 'multiple' | 'integrity'
}

export class WorkflowOperationalHealthService {
  private readonly now: () => string
  private readonly workerStaleAfterMs: number
  private readonly recentFailureWindowMs: number

  constructor(private readonly options: WorkflowOperationalHealthServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.workerStaleAfterMs = options.workerStaleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS
    this.recentFailureWindowMs = options.recentFailureWindowMs ?? DEFAULT_RECENT_FAILURE_WINDOW_MS
  }

  getOperationalHealth(query: WorkflowOperationalHealthQuery): WorkflowOperationalHealth {
    const workflowId = validateId(query?.workflowId, 'workflow')
    const environmentId = validateId(query?.environmentId, 'environment')
    const observedAt = this.now()
    const operations = this.options.getRunServiceOperations(environmentId)
    const unchecked = {
      workflowId,
      environmentId,
      observedAt,
      service: { lifecycle: operations.lifecycle, mutationRecoveryRequired: operations.mutationRecoveryRequired },
      worker: { ...operations.worker },
      ...(operations.queue === undefined ? {} : { queue: { global: { ...operations.queue.global }, environment: { ...operations.queue.environment } } }),
      environment: { state: 'unchecked' as const },
      release: { state: 'unchecked' as const },
      execution: { state: 'unchecked' as const },
      ...(this.options.getConnectorHealthSnapshot === undefined ? {} : { connectors: this.options.getConnectorHealthSnapshot({ workflowId, environmentId }) }),
    }

    if (operations.mutationRecoveryRequired) return { ...unchecked, status: 'unhealthy', reason: 'mutation-recovery-required' }
    if (operations.lifecycle === 'initializing') return { ...unchecked, status: 'unknown', reason: 'service-initializing' }
    if (operations.lifecycle !== 'accepting') return { ...unchecked, status: 'unhealthy', reason: 'service-not-accepting' }

    // These stores are initialized before the service becomes accepting. Read
    // their independent evidence once so an early Worker result can still show
    // ambiguous deployment truth without changing the specified primary reason.
    const release = assessRelease(
      workflowId,
      environmentId,
      this.options.listReleases(),
      this.options.listReleaseIntegrityFailures(),
    )
    const environment = assessEnvironment(environmentId, this.options.resolveEnvironment(environmentId))
    const evidence = { ...unchecked, environment, release: release.evidence }

    if (operations.worker.state === 'stopped' || operations.worker.state === 'stopping') {
      return { ...evidence, status: 'unhealthy', reason: 'worker-stopped' }
    }
    if (operations.worker.state === 'backing-off') {
      return { ...evidence, status: 'degraded', reason: 'worker-backing-off' }
    }
    if (operations.worker.activeRunLeaseLostAt !== undefined) {
      return { ...evidence, status: 'degraded', reason: 'worker-active-lease-lost' }
    }
    if (operations.worker.lastPollSucceededAt === undefined) {
      return { ...evidence, status: 'unknown', reason: 'worker-never-polled' }
    }
    // A claimed execution holds the single Worker loop between polls. Its
    // counter is direct process evidence, not the age of a business event.
    const activeHeartbeatIsFresh = operations.worker.activeRunCount > 0
      && operations.worker.activeRunHeartbeatAt !== undefined
      && !isStale(operations.worker.activeRunHeartbeatAt, observedAt, this.workerStaleAfterMs)
    if (!activeHeartbeatIsFresh && isStale(operations.worker.lastPollSucceededAt, observedAt, this.workerStaleAfterMs)) {
      return { ...evidence, status: 'degraded', reason: 'worker-stale' }
    }

    if (environment.state === 'missing') return { ...evidence, status: 'unhealthy', reason: 'environment-not-found' }
    if (environment.state === 'inactive') return { ...evidence, status: 'unhealthy', reason: 'environment-not-active' }
    if (release.issue === 'missing') return { ...evidence, status: 'unknown', reason: 'no-current-release' }
    if (release.issue === 'multiple') return { ...evidence, status: 'unhealthy', reason: 'multiple-current-releases' }
    if (release.issue === 'integrity' || release.current === undefined) {
      return { ...evidence, status: 'unhealthy', reason: 'release-integrity-failed' }
    }

    const current = release.current
    if (current.activation === undefined) return { ...evidence, status: 'unknown', reason: 'release-activation-unknown' }

    const terminalRuns = this.options.listRuns()
      .map((run, durableOrder) => ({ run, durableOrder, time: terminalTime(run) }))
      .filter((entry): entry is { run: WorkflowRunRecord & { status: 'completed' | 'failed' | 'cancelled' }; durableOrder: number; time: string } => (
        entry.run.workflowId === workflowId
        && entry.run.workflowRevision === current.workflowRevision
        && typeof entry.run.id === 'string' && ID_PATTERN.test(entry.run.id)
        && entry.run.environmentId === environmentId
        && entry.run.releaseId === current.id
        && entry.time !== undefined
        && (entry.run.status === 'completed' || entry.run.status === 'failed' || entry.run.status === 'cancelled')
        && compareTime(entry.time, current.activation!.at) >= 0
        && compareTime(entry.time, observedAt) <= 0
      ))
      .sort((left, right) => (
        compareTime(right.time, left.time)
        // Cross-record completion order is unknowable at an equal timestamp.
        // Fail conservatively, then retain the store's stable order.
        || terminalRiskRank(left.run.status) - terminalRiskRank(right.run.status)
        || left.durableOrder - right.durableOrder
      ))

    const latest = terminalRuns[0]
    if (latest === undefined) {
      return { ...evidence, status: 'unknown', reason: 'no-terminal-run-after-activation', execution: { state: 'none' } }
    }
    const execution = { state: latest.run.status, runId: latest.run.id, time: latest.time } as const
    if (latest.run.status === 'failed') return { ...evidence, status: 'degraded', reason: 'latest-run-failed', execution }
    if (latest.run.status === 'cancelled') return { ...evidence, status: 'degraded', reason: 'latest-run-cancelled', execution }

    if (hasUnresolvedRecentFailure(
      this.options.listObservations(), environmentId, current.id, latest.run.id, latest.time, observedAt, this.recentFailureWindowMs,
    )) {
      return { ...evidence, status: 'degraded', reason: 'recent-failures', execution }
    }
    return { ...evidence, status: 'healthy', reason: 'healthy', execution }
  }
}

function assessEnvironment(
  environmentId: string,
  environment: WorkflowCustomerEnvironment | undefined,
): WorkflowOperationalHealth['environment'] {
  if (environment === undefined || environment.id !== environmentId) return { state: 'missing' }
  if (environment.status !== 'active') return { state: 'inactive', status: environment.status }
  return { state: 'active' }
}

function assessRelease(
  workflowId: string,
  environmentId: string,
  releases: readonly WorkflowRelease[],
  failures: readonly WorkflowReleaseIntegrityFailure[],
): ReleaseAssessment {
  const published = releases.filter((candidate) => (
    candidate.workflowId === workflowId && candidate.environmentId === environmentId && candidate.status === 'published'
  ))
  const rejected = failures.filter((candidate) => (
    candidate.workflowId === workflowId && candidate.environmentId === environmentId && candidate.status === 'published'
  ))
  if (published.length + rejected.length === 0) return { evidence: { state: 'missing' }, issue: 'missing' }
  if (published.length + rejected.length > 1) return { evidence: { state: 'multiple-published' }, issue: 'multiple' }
  const failed = rejected[0]
  if (failed !== undefined) {
    return { evidence: { state: 'integrity-failed', id: failed.id, revision: failed.workflowRevision }, issue: 'integrity' }
  }
  const current = published[0]!
  if (!verifyWorkflowReleaseIntegrity(current)) {
    return { evidence: { state: 'integrity-failed', id: current.id, revision: current.workflowRevision }, issue: 'integrity' }
  }
  return {
    current,
    evidence: {
      state: 'active', id: current.id, revision: current.workflowRevision,
      ...(current.activation === undefined ? {} : { activation: { ...current.activation } }),
    },
  }
}

function hasUnresolvedRecentFailure(
  observations: readonly WorkflowObservationEvent[],
  environmentId: string,
  releaseId: string,
  latestCompletedRunId: string,
  latestCompletedAt: string,
  observedAt: string,
  recentFailureWindowMs: number,
): boolean {
  const completedAtMs = Date.parse(latestCompletedAt)
  const observedAtMs = Date.parse(observedAt)
  return observations.some((event, index) => {
    if (event.environmentId !== environmentId || event.releaseId !== releaseId || event.severity !== 'error') return false
    const time = Date.parse(event.time)
    if (Number.isNaN(time) || observedAtMs - time < 0 || observedAtMs - time >= recentFailureWindowMs) return false
    if (time > completedAtMs) return true
    if (time < completedAtMs) return false
    // On a timestamp tie only durable append order can prove recovery.
    return !observations.slice(index + 1).some((candidate) => (
      candidate.environmentId === environmentId
      && candidate.releaseId === releaseId
      && candidate.action === 'run-completed'
      // Append order alone is not execution evidence. Correlate recovery with
      // the terminal run already verified for this exact release and revision.
      && candidate.runId === latestCompletedRunId
      && compareTime(candidate.time, latestCompletedAt) === 0
      && compareTime(candidate.time, observedAt) <= 0
      && compareTime(candidate.time, event.time) >= 0
    ))
  })
}

function validateId(value: unknown, name: 'workflow' | 'environment'): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`Invalid ${name} ID`)
  return value
}

function compareTime(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right)
}

function isStale(lastSucceededAt: string, observedAt: string, thresholdMs: number): boolean {
  const age = Date.parse(observedAt) - Date.parse(lastSucceededAt)
  return !Number.isFinite(age) || age < 0 || age > thresholdMs
}

function terminalRiskRank(status: 'completed' | 'failed' | 'cancelled'): number {
  if (status === 'failed') return 0
  if (status === 'cancelled') return 1
  return 2
}

function terminalTime(run: WorkflowRunRecord): string | undefined {
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') return undefined
  if (typeof run.completedAt === 'string' && !Number.isNaN(Date.parse(run.completedAt))) return run.completedAt
  const terminalTypes = run.status === 'completed'
    ? new Set(['run-completed'])
    : run.status === 'failed'
      ? new Set(['run-failed'])
      : new Set(['run-cancelled'])
  return run.events.filter((event) => (
    event !== null
    && typeof event === 'object'
    && terminalTypes.has((event as { type?: unknown }).type as string)
    && typeof (event as { time?: unknown }).time === 'string'
    && !Number.isNaN(Date.parse((event as { time: string }).time))
  ))
    .map((event) => (event as { time: string }).time)
    .sort(compareTime)
    .at(-1)
}
