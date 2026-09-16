import type { WorkRunRef, WorkTaskSnapshot } from '../../shared/work-items.js'

export type WorkItemAttentionGroup = 'needs-action' | 'in-progress' | 'review' | 'failed' | 'completed'

const ACTIVE_RUN_STATUSES = new Set<WorkRunRef['status']>([
  'queued',
  'running',
  'waiting',
  'paused',
  'cancelling',
])

function latestFailure(snapshot: WorkTaskSnapshot): WorkRunRef | undefined {
  return snapshot.runs
    .filter((run) => run.status === 'failed' || run.status === 'interrupted')
    .reduce<WorkRunRef | undefined>((latest, run) => (
      latest === undefined || run.observedAt > latest.observedAt ? run : latest
    ), undefined)
}

/**
 * Derive the user's next-attention bucket from durable evidence in a snapshot.
 * Task status is only a completion fallback; actions, artifacts, and runs retain
 * precedence so a stale/coarse status cannot hide work that still needs review.
 */
export function attentionGroup(snapshot: WorkTaskSnapshot): WorkItemAttentionGroup {
  if (snapshot.actions.some((action) => action.status === 'open')) return 'needs-action'

  const currentArtifacts = snapshot.artifacts.filter(
    (artifact) => artifact.requirementVersion === snapshot.task.currentRequirementVersion,
  )
  if (currentArtifacts.some((artifact) => !snapshot.task.acceptedArtifactIds.includes(artifact.id))) {
    return 'review'
  }

  if (snapshot.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return 'in-progress'

  const failure = latestFailure(snapshot)
  if (
    failure !== undefined
    && !snapshot.runs.some((run) => run.status === 'completed' && run.observedAt > failure.observedAt)
  ) {
    return 'failed'
  }

  const acceptedCurrentArtifact = currentArtifacts.some((artifact) => (
    snapshot.task.acceptedArtifactIds.includes(artifact.id)
  ))
  if (acceptedCurrentArtifact || snapshot.task.status === 'completed') return 'completed'

  return 'needs-action'
}
