import type {
  WorkAction,
  WorkArtifact,
  WorkAttempt,
  WorkRequirement,
  WorkRunRef,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'
import type { AppCopy } from '../../shared/locale.js'
import { employeeDisplayLabel, type EmployeeSnapshot } from '../../shared/employees.js'

/**
 * Renderer-only helpers for the Work Items surface.  They deliberately retain
 * the Main-owned status values instead of deriving a business conclusion from
 * timestamps or incomplete runtime information.
 */
export function currentRequirement(snapshot: WorkTaskSnapshot): WorkRequirement | undefined {
  return snapshot.task.requirements.find((requirement) => requirement.version === snapshot.task.currentRequirementVersion)
}

export function executorLabel(copy: AppCopy, executor: WorkAttempt['responsibility'] | WorkRunRef['executor'], employees?: ReadonlyMap<string, Pick<EmployeeSnapshot, 'name' | 'displayName' | 'role'>>): string {
  return executor.kind === 'employee'
    ? copy.workItemsExecutorEmployee(employees?.get(executor.employeeId) === undefined ? executor.employeeId : employeeDisplayLabel(employees.get(executor.employeeId)!))
    : copy.workItemsExecutorWorkflow(executor.workflowId, executor.workflowRevision)
}

export function attemptReasonLabel(copy: AppCopy, reason: WorkAttempt['reason']): string {
  return copy.workItemsAttemptReason(reason)
}

export function actionState(action: WorkAction): 'open' | 'resolved' | 'superseded' {
  return action.status
}

export function artifactVersionLabel(copy: AppCopy, artifact: WorkArtifact): string {
  return copy.workItemsArtifactVersion(artifact.contentVersion, artifact.requirementVersion)
}

/** An event with an older revision must never replace a newer snapshot in the UI. */
export function shouldApplySnapshot(
  current: WorkTaskSnapshot | undefined,
  incoming: WorkTaskSnapshot,
): boolean {
  return current === undefined || incoming.task.revision >= current.task.revision
}

/**
 * Merge one Main-owned snapshot into an existing task map. This keeps a newer
 * event if an older list/get response arrives later.
 */
export function mergeSnapshot(
  snapshots: ReadonlyMap<string, WorkTaskSnapshot>,
  incoming: WorkTaskSnapshot,
): Map<string, WorkTaskSnapshot> {
  const next = new Map(snapshots)
  const current = next.get(incoming.task.id)
  if (shouldApplySnapshot(current, incoming)) next.set(incoming.task.id, incoming)
  return next
}

export function mergeSnapshotList(
  snapshots: ReadonlyMap<string, WorkTaskSnapshot>,
  incoming: readonly WorkTaskSnapshot[],
): Map<string, WorkTaskSnapshot> {
  return incoming.reduce((merged, snapshot) => mergeSnapshot(merged, snapshot), new Map(snapshots))
}

export function chronological<T extends { createdAt: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function newestFirst<T extends { observedAt: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => right.observedAt.localeCompare(left.observedAt))
}
