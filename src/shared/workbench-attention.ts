import type { WorkRunRef, WorkTaskSnapshot } from './work-items.js'

/**
 * Main-owned attention projection for the Workbench. It is intentionally a
 * read-only view over durable Work Item snapshots; it does not become a
 * second task or notification store.
 */
export type WorkbenchAttentionGroup = 'needs-action' | 'in-progress' | 'review' | 'failed' | 'dispatch-anomalies'

export interface WorkbenchAttentionItem {
  taskId: string
  title: string
  group: WorkbenchAttentionGroup
  reason: string
  updatedAt: string
  runId?: string
  actionId?: string
}

export interface WorkbenchAttentionSnapshot {
  generatedAt: string
  groups: Record<WorkbenchAttentionGroup, WorkbenchAttentionItem[]>
  total: number
}

const ACTIVE_RUN_STATUSES = new Set<WorkRunRef['status']>([
  'queued',
  'running',
  'waiting',
  'paused',
  'cancelling',
])

const GROUPS: readonly WorkbenchAttentionGroup[] = [
  'needs-action',
  'in-progress',
  'review',
  'failed',
  'dispatch-anomalies',
]

function emptyGroups(): Record<WorkbenchAttentionGroup, WorkbenchAttentionItem[]> {
  return {
    'needs-action': [],
    'in-progress': [],
    review: [],
    failed: [],
    'dispatch-anomalies': [],
  }
}

function latestFailure(snapshot: WorkTaskSnapshot): WorkRunRef | undefined {
  return snapshot.runs
    .filter((run) => run.status === 'failed' || run.status === 'interrupted')
    .reduce<WorkRunRef | undefined>((latest, run) => (
      latest === undefined || run.observedAt > latest.observedAt ? run : latest
    ), undefined)
}

function item(
  snapshot: WorkTaskSnapshot,
  group: WorkbenchAttentionGroup,
  reason: string,
  run?: WorkRunRef,
  actionId?: string,
): WorkbenchAttentionItem {
  return {
    taskId: snapshot.task.id,
    title: snapshot.task.title,
    group,
    reason,
    updatedAt: snapshot.task.updatedAt,
    ...(run?.runId === undefined || run.runId === '' ? {} : { runId: run.runId }),
    ...(actionId === undefined ? {} : { actionId }),
  }
}

function dispatchAnomaly(snapshot: WorkTaskSnapshot): WorkRunRef | undefined {
  return snapshot.runs.find((run) => run.runId === '' && (
    run.rawStatus === 'dispatch-intent-recorded'
    || run.rawStatus === 'dispatching'
    || run.rawStatus.startsWith('outcome-unknown:')
  ))
}

/** Derive the single highest-priority attention reason for each active task. */
export function deriveWorkbenchAttention(snapshots: readonly WorkTaskSnapshot[], generatedAt = new Date().toISOString()): WorkbenchAttentionSnapshot {
  const groups = emptyGroups()

  for (const snapshot of snapshots) {
    if (snapshot.task.archivedAt !== undefined || snapshot.task.status === 'cancelled') continue

    const anomaly = dispatchAnomaly(snapshot)
    if (anomaly !== undefined || snapshot.task.cancellation?.state === 'outcome-unknown') {
      groups['dispatch-anomalies'].push(item(
        snapshot,
        'dispatch-anomalies',
        anomaly === undefined ? '取消结果尚未核实' : `调度尚未关联执行记录（${anomaly.rawStatus}）`,
        anomaly,
      ))
      continue
    }

    const openAction = snapshot.actions.find((action) => action.status === 'open')
    if (openAction !== undefined) {
      groups['needs-action'].push(item(snapshot, 'needs-action', `待处理：${openAction.kind}`, undefined, openAction.id))
      continue
    }

    const currentArtifacts = snapshot.artifacts.filter(
      (artifact) => artifact.requirementVersion === snapshot.task.currentRequirementVersion,
    )
    const pendingArtifact = currentArtifacts.find((artifact) => !snapshot.task.acceptedArtifactIds.includes(artifact.id))
    if (pendingArtifact !== undefined) {
      groups.review.push(item(snapshot, 'review', `成果待验收：${pendingArtifact.name}`))
      continue
    }

    const activeRun = snapshot.runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status))
    if (activeRun !== undefined || snapshot.task.cancellation?.state === 'requested' || snapshot.task.cancellation?.state === 'cancelling') {
      groups['in-progress'].push(item(snapshot, 'in-progress', activeRun === undefined ? '整项工作取消中' : `执行中：${activeRun.status}`, activeRun))
      continue
    }

    const failure = latestFailure(snapshot)
    if (
      failure !== undefined
      && !snapshot.runs.some((run) => run.status === 'completed' && run.observedAt > failure.observedAt)
    ) {
      groups.failed.push(item(snapshot, 'failed', `最近一次执行：${failure.rawStatus}`, failure))
      continue
    }

    if (snapshot.task.status === 'open' || snapshot.task.status === 'review') {
      groups['needs-action'].push(item(snapshot, 'needs-action', '工作项尚未完成下一步'))
    }
  }

  const total = GROUPS.reduce((count, group) => count + groups[group].length, 0)
  return { generatedAt, groups, total }
}
