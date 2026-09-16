import type { WorkTaskSnapshot } from '../../shared/work-items.js'

export type WorkItemProjectFilterValue =
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'project'; projectId: string }

export interface WorkItemProjectDirectoryEntry {
  projectId: string
  title: string
  path?: string
}

export interface WorkItemProjectOption extends WorkItemProjectDirectoryEntry {
  orphaned: boolean
}

export function workItemProjectOptions(
  snapshots: readonly WorkTaskSnapshot[],
  directory: readonly WorkItemProjectDirectoryEntry[],
): WorkItemProjectOption[] {
  const observedProjectIds = new Set<string>()
  for (const snapshot of snapshots) {
    const projectId = snapshot.task.scope.projectId
    if (projectId !== undefined) observedProjectIds.add(projectId)
  }

  return [...observedProjectIds].map((projectId) => {
    const entry = directory.find((candidate) => candidate.projectId === projectId)
    return entry === undefined
      ? { projectId, title: projectId, orphaned: true }
      : { ...entry, orphaned: false }
  })
}

export function filterWorkItemsByProject(
  snapshots: readonly WorkTaskSnapshot[],
  filter: WorkItemProjectFilterValue,
): WorkTaskSnapshot[] {
  if (filter.kind === 'all') return [...snapshots]
  if (filter.kind === 'unassigned') return snapshots.filter((snapshot) => snapshot.task.scope.projectId === undefined)
  return snapshots.filter((snapshot) => snapshot.task.scope.projectId === filter.projectId)
}
