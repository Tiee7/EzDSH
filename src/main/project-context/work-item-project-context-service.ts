import type { EmployeeProjectSummary } from '../../shared/employees.js'
import {
  PROJECT_CONTEXT_ACTIVE_RUN_STATUSES,
  type ProjectContextDirectoryEntry,
  type ProjectContextTotals,
  type ProjectContextWorkItemSummary,
  type WorkItemProjectContext,
  type WorkItemProjectContextQuery,
  type WorkItemProjectContextSnapshot,
} from '../../shared/project-context.js'
import type { WorkItemQuery, WorkTaskSnapshot } from '../../shared/work-items.js'

export interface ProjectContextDirectoryPort {
  listProjects(): Promise<ReadonlyArray<EmployeeProjectSummary>>
}

export interface ProjectContextWorkItemPort {
  list(query?: WorkItemQuery): Promise<WorkTaskSnapshot[]>
}

export interface WorkItemProjectContextServiceOptions {
  directory: ProjectContextDirectoryPort
  workItems: ProjectContextWorkItemPort
  now?: () => Date
  onDirectoryError?: (error: unknown) => void
}

/**
 * Read-only join between the Runtime project directory and durable Work Items.
 * Directory failure is data, not a reason to hide locally persisted tasks.
 */
export class WorkItemProjectContextService {
  constructor(private readonly options: WorkItemProjectContextServiceOptions) {}

  async read(query: WorkItemProjectContextQuery = {}): Promise<WorkItemProjectContextSnapshot> {
    const normalized = normalizeQuery(query)
    const [directoryResult, workItems] = await Promise.all([
      this.readDirectory(),
      this.options.workItems.list({
        ...(normalized.projectId === undefined ? {} : { projectId: normalized.projectId }),
        includeArchived: normalized.includeArchived,
      }),
    ])
    const projects = normalized.projectId === undefined
      ? directoryResult.projects
      : directoryResult.projects.filter((project) => project.projectId === normalized.projectId)
    return {
      observedAt: (this.options.now?.() ?? new Date()).toISOString(),
      directory: directoryResult.directory,
      contexts: aggregateContexts(projects, workItems, normalized),
    }
  }

  private async readDirectory(): Promise<{
    directory: WorkItemProjectContextSnapshot['directory']
    projects: ProjectContextDirectoryEntry[]
  }> {
    try {
      const projects = await this.options.directory.listProjects()
      return {
        directory: { state: 'available' },
        projects: normalizeDirectory(projects),
      }
    } catch (error) {
      this.options.onDirectoryError?.(error)
      return {
        directory: { state: 'unavailable', code: 'PROJECT_DIRECTORY_UNAVAILABLE' },
        projects: [],
      }
    }
  }
}

interface NormalizedQuery {
  projectId?: string
  includeArchived: boolean
  includeUnassigned: boolean
}

function normalizeQuery(query: WorkItemProjectContextQuery): NormalizedQuery {
  const projectId = query.projectId?.trim()
  if (query.projectId !== undefined && projectId === '') throw new Error('Project context projectId must not be empty')
  if (query.includeArchived !== undefined && typeof query.includeArchived !== 'boolean') {
    throw new Error('Project context includeArchived must be a boolean')
  }
  if (query.includeUnassigned !== undefined && typeof query.includeUnassigned !== 'boolean') {
    throw new Error('Project context includeUnassigned must be a boolean')
  }
  return {
    ...(projectId === undefined ? {} : { projectId }),
    includeArchived: query.includeArchived ?? false,
    includeUnassigned: projectId === undefined && (query.includeUnassigned ?? true),
  }
}

function normalizeDirectory(projects: ReadonlyArray<EmployeeProjectSummary>): ProjectContextDirectoryEntry[] {
  const byId = new Map<string, ProjectContextDirectoryEntry>()
  for (const project of projects) {
    const projectId = project.projectId.trim()
    if (projectId === '' || byId.has(projectId)) continue
    byId.set(projectId, {
      projectId,
      title: project.title.trim() || projectId,
      path: project.path,
      sessionCount: new Set(project.sessionIds).size,
    })
  }
  return [...byId.values()].sort(compareProjects)
}

function aggregateContexts(
  projects: ProjectContextDirectoryEntry[],
  snapshots: WorkTaskSnapshot[],
  query: NormalizedQuery,
): WorkItemProjectContext[] {
  const workItemsByProject = new Map<string, ProjectContextWorkItemSummary[]>()
  const unassigned: ProjectContextWorkItemSummary[] = []
  for (const snapshot of snapshots) {
    if (!query.includeArchived && snapshot.task.archivedAt !== undefined) continue
    const summary = summarizeWorkItem(snapshot)
    const projectId = snapshot.task.scope.projectId?.trim()
    if (projectId === undefined || projectId === '') {
      if (query.includeUnassigned) unassigned.push(summary)
      continue
    }
    const summaries = workItemsByProject.get(projectId) ?? []
    summaries.push(summary)
    workItemsByProject.set(projectId, summaries)
  }

  const directoryById = new Map(projects.map((project) => [project.projectId, project]))
  const projectIds = new Set([...directoryById.keys(), ...workItemsByProject.keys()])
  const contexts = [...projectIds].map((projectId): WorkItemProjectContext => {
    const project = directoryById.get(projectId)
    const workItems = sortWorkItems(workItemsByProject.get(projectId) ?? [])
    return {
      key: { kind: 'project', projectId },
      source: project === undefined ? 'work-items' : workItems.length === 0 ? 'directory' : 'directory-and-work-items',
      ...(project === undefined ? {} : { project }),
      totals: totals(workItems),
      workItems,
    }
  }).sort(compareContexts)

  if (query.includeUnassigned && unassigned.length > 0) {
    const workItems = sortWorkItems(unassigned)
    contexts.push({
      key: { kind: 'unassigned' },
      source: 'unassigned',
      totals: totals(workItems),
      workItems,
    })
  }
  return contexts
}

function summarizeWorkItem(snapshot: WorkTaskSnapshot): ProjectContextWorkItemSummary {
  return {
    taskId: snapshot.task.id,
    title: snapshot.task.title,
    revision: snapshot.task.revision,
    status: snapshot.task.status,
    currentRequirementVersion: snapshot.task.currentRequirementVersion,
    archived: snapshot.task.archivedAt !== undefined,
    ...(snapshot.task.cancellation === undefined ? {} : { cancellationState: snapshot.task.cancellation.state }),
    runCount: snapshot.runs.length,
    activeRunCount: snapshot.runs.filter((run) => PROJECT_CONTEXT_ACTIVE_RUN_STATUSES.has(run.status)).length,
    openActionCount: snapshot.actions.filter((action) => action.status === 'open').length,
    artifactCount: snapshot.artifacts.length,
    updatedAt: snapshot.task.updatedAt,
  }
}

function totals(workItems: ProjectContextWorkItemSummary[]): ProjectContextTotals {
  return workItems.reduce<ProjectContextTotals>((result, item) => ({
    workItems: result.workItems + 1,
    activeWorkItems: result.activeWorkItems + (item.archived ? 0 : 1),
    archivedWorkItems: result.archivedWorkItems + (item.archived ? 1 : 0),
    openActions: result.openActions + item.openActionCount,
    activeRuns: result.activeRuns + item.activeRunCount,
    artifacts: result.artifacts + item.artifactCount,
  }), { workItems: 0, activeWorkItems: 0, archivedWorkItems: 0, openActions: 0, activeRuns: 0, artifacts: 0 })
}

function sortWorkItems(items: ProjectContextWorkItemSummary[]): ProjectContextWorkItemSummary[] {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId))
}

function compareProjects(left: ProjectContextDirectoryEntry, right: ProjectContextDirectoryEntry): number {
  return left.title.localeCompare(right.title) || left.projectId.localeCompare(right.projectId)
}

function compareContexts(left: WorkItemProjectContext, right: WorkItemProjectContext): number {
  if (left.key.kind === 'unassigned') return 1
  if (right.key.kind === 'unassigned') return -1
  const leftTitle = left.project?.title ?? left.key.projectId
  const rightTitle = right.project?.title ?? right.key.projectId
  return leftTitle.localeCompare(rightTitle) || left.key.projectId.localeCompare(right.key.projectId)
}
