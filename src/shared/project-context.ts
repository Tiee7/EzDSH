import type {
  WorkRunStatus,
  WorkTaskCancellationState,
  WorkTaskStatus,
} from './work-items.js'

/** Renderer-safe project metadata. Session identities stay in Main. */
export interface ProjectContextDirectoryEntry {
  projectId: string
  title: string
  path: string
  sessionCount: number
}

export type ProjectContextKey =
  | { kind: 'project'; projectId: string }
  | { kind: 'unassigned' }

export type ProjectContextSource = 'directory' | 'work-items' | 'directory-and-work-items' | 'unassigned'

/** A compact Work Item projection for project-level browsing and counts. */
export interface ProjectContextWorkItemSummary {
  taskId: string
  title: string
  revision: number
  status: WorkTaskStatus
  currentRequirementVersion: number
  archived: boolean
  cancellationState?: WorkTaskCancellationState
  runCount: number
  activeRunCount: number
  openActionCount: number
  artifactCount: number
  updatedAt: string
}

export interface ProjectContextTotals {
  workItems: number
  activeWorkItems: number
  archivedWorkItems: number
  openActions: number
  activeRuns: number
  artifacts: number
}

/** One project (or the unassigned bucket) joined with its durable Work Items. */
export interface WorkItemProjectContext {
  key: ProjectContextKey
  source: ProjectContextSource
  project?: ProjectContextDirectoryEntry
  totals: ProjectContextTotals
  workItems: ProjectContextWorkItemSummary[]
}

export interface WorkItemProjectContextQuery {
  projectId?: string
  includeArchived?: boolean
  includeUnassigned?: boolean
}

export interface WorkItemProjectContextSnapshot {
  observedAt: string
  directory: { state: 'available' } | { state: 'unavailable'; code: 'PROJECT_DIRECTORY_UNAVAILABLE' }
  contexts: WorkItemProjectContext[]
}

export const PROJECT_CONTEXT_ACTIVE_RUN_STATUSES: ReadonlySet<WorkRunStatus> = new Set([
  'queued',
  'running',
  'waiting',
  'paused',
  'cancelling',
])

/** Validate the renderer-facing read query before it reaches Main. */
export function validateWorkItemProjectContextQuery(value: unknown): WorkItemProjectContextQuery {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Project context query must be an object')
  }
  const query = value as Record<string, unknown>
  for (const key of Object.keys(query)) {
    if (!['projectId', 'includeArchived', 'includeUnassigned'].includes(key)) {
      throw new Error(`Project context query field ${key} is not allowed`)
    }
  }
  let projectId: string | undefined
  if (query.projectId !== undefined) {
    if (typeof query.projectId !== 'string' || query.projectId.trim() === '') throw new Error('Project context projectId must not be empty')
    projectId = query.projectId.trim()
    if (projectId.length > 128 || /[\u0000-\u001f\u007f]/u.test(projectId)) throw new Error('Project context projectId is invalid')
  }
  if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean') {
    throw new Error('Project context includeArchived must be a boolean')
  }
  if (query.includeUnassigned !== undefined && typeof query.includeUnassigned !== 'boolean') {
    throw new Error('Project context includeUnassigned must be a boolean')
  }
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
    ...(query.includeUnassigned === undefined ? {} : { includeUnassigned: query.includeUnassigned }),
  }
}
