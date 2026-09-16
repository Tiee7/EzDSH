import type { WorkTaskStatus } from '../../shared/work-items.js'

/** Versioned, renderer-only state used to move between the three work surfaces. */
export const WORK_ITEM_NAVIGATION_VERSION = 1 as const

export type WorkItemNavigationSource = 'work-items' | 'employees' | 'workflow' | 'harness'
export type WorkItemNavigationDestination = 'work-items' | 'employees' | 'workflow' | 'detail'
/** A task run is the formal path. Debug runs deliberately remain outside task state. */
export type WorkItemRunMode = 'task' | 'debug'

export interface WorkItemListFilter {
  status?: WorkTaskStatus
  employeeId?: string
  workflowId?: string
  query?: string
  projectId?: string
  unassignedProject?: true
}

/** The view to restore when the user closes the linked employee/workflow surface. */
export interface WorkItemReturnContext {
  destination: WorkItemNavigationDestination
  source: WorkItemNavigationSource
  selectedTaskId?: string
  selectedEmployeeId?: string
  selectedMethodId?: string
  selectedMethodVersion?: number
  selectedWorkflowId?: string
  selectedRunId?: string
  filter?: WorkItemListFilter
  scrollTop?: number
}

export interface WorkItemNavigationContext {
  version: typeof WORK_ITEM_NAVIGATION_VERSION
  destination: WorkItemNavigationDestination
  source: WorkItemNavigationSource
  taskId?: string
  employeeId?: string
  methodId?: string
  methodVersion?: number
  workflowId?: string
  runId?: string
  runMode: WorkItemRunMode
  returnTo?: WorkItemReturnContext
}

export interface WorkItemNavigationInput {
  destination: WorkItemNavigationDestination
  source?: WorkItemNavigationSource
  taskId?: string
  employeeId?: string
  methodId?: string
  methodVersion?: number
  workflowId?: string
  runId?: string
  /** Omit for the formal task path. Set explicitly for the existing debug path. */
  runMode?: WorkItemRunMode
  returnTo?: WorkItemReturnContext
}

const SOURCES: readonly WorkItemNavigationSource[] = ['work-items', 'employees', 'workflow', 'harness']
const DESTINATIONS: readonly WorkItemNavigationDestination[] = ['work-items', 'employees', 'workflow', 'detail']
const STATUSES: readonly WorkTaskStatus[] = ['open', 'active', 'review', 'completed', 'cancelled']
const MAX_ID_LENGTH = 256
const MAX_QUERY_LENGTH = 512

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function optionalText(value: unknown, maxLength = MAX_ID_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined
  return trimmed
}

function requiredText(value: unknown, field: string): string {
  const normalized = optionalText(value)
  if (normalized === undefined) throw new Error(`${field} is required`)
  return normalized
}

function safePositiveVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function safeScrollTop(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.floor(value)
    : undefined
}

function normalizeFilter(value: unknown): WorkItemListFilter | undefined {
  if (!isRecord(value)) return undefined
  const status = isOneOf(value.status, STATUSES) ? value.status : undefined
  const employeeId = optionalText(value.employeeId)
  const workflowId = optionalText(value.workflowId)
  const query = optionalText(value.query, MAX_QUERY_LENGTH)
  const projectId = optionalText(value.projectId)
  const unassignedProject: true | undefined = value.unassignedProject === true ? true : undefined
  const hasProjectId = Object.prototype.hasOwnProperty.call(value, 'projectId')
  const hasUnassignedProject = Object.prototype.hasOwnProperty.call(value, 'unassignedProject')
  const projectFilter: Pick<WorkItemListFilter, 'projectId' | 'unassignedProject'> = hasProjectId && hasUnassignedProject
    ? {}
    : {
        ...(projectId === undefined ? {} : { projectId }),
        ...(unassignedProject === undefined ? {} : { unassignedProject }),
      }
  if (
    status === undefined &&
    employeeId === undefined &&
    workflowId === undefined &&
    query === undefined &&
    Object.keys(projectFilter).length === 0
  ) return undefined
  return {
    ...(status === undefined ? {} : { status }),
    ...(employeeId === undefined ? {} : { employeeId }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(query === undefined ? {} : { query }),
    ...projectFilter,
  }
}

function normalizeReturnTo(value: unknown): WorkItemReturnContext | undefined {
  if (!isRecord(value)) return undefined
  const destination = isOneOf(value.destination, DESTINATIONS) ? value.destination : undefined
  const source = isOneOf(value.source, SOURCES) ? value.source : undefined
  if (destination === undefined || source === undefined) return undefined
  const selectedTaskId = optionalText(value.selectedTaskId)
  const selectedEmployeeId = optionalText(value.selectedEmployeeId)
  const selectedMethodId = optionalText(value.selectedMethodId)
  const selectedMethodVersion = safePositiveVersion(value.selectedMethodVersion)
  const selectedWorkflowId = optionalText(value.selectedWorkflowId)
  const selectedRunId = optionalText(value.selectedRunId)
  const filter = normalizeFilter(value.filter)
  const scrollTop = safeScrollTop(value.scrollTop)
  return {
    destination,
    source,
    ...(selectedTaskId === undefined ? {} : { selectedTaskId }),
    ...(selectedEmployeeId === undefined ? {} : { selectedEmployeeId }),
    ...(selectedMethodId === undefined ? {} : { selectedMethodId }),
    ...(selectedMethodVersion === undefined ? {} : { selectedMethodVersion }),
    ...(selectedWorkflowId === undefined ? {} : { selectedWorkflowId }),
    ...(selectedRunId === undefined ? {} : { selectedRunId }),
    ...(filter === undefined ? {} : { filter }),
    ...(scrollTop === undefined ? {} : { scrollTop }),
  }
}

/** Build a safe context from known navigation values. Empty optional IDs are omitted. */
export function createWorkItemNavigation(input: WorkItemNavigationInput): WorkItemNavigationContext {
  const source = input.source ?? 'work-items'
  const runMode = input.runMode ?? 'task'
  if (!DESTINATIONS.includes(input.destination)) throw new Error(`Unsupported work item navigation destination: ${input.destination}`)
  if (!SOURCES.includes(source)) throw new Error(`Unsupported work item navigation source: ${source}`)
  if (runMode !== 'task' && runMode !== 'debug') throw new Error(`Unsupported work item run mode: ${runMode}`)
  const taskId = optionalText(input.taskId)
  const employeeId = optionalText(input.employeeId)
  const methodId = optionalText(input.methodId)
  const methodVersion = safePositiveVersion(input.methodVersion)
  const workflowId = optionalText(input.workflowId)
  const runId = optionalText(input.runId)
  if (input.destination === 'detail') requiredText(taskId, 'taskId')
  if (input.destination === 'employees') requiredText(employeeId, 'employeeId')
  if (input.destination === 'workflow') requiredText(workflowId, 'workflowId')
  return {
    version: WORK_ITEM_NAVIGATION_VERSION,
    destination: input.destination,
    source,
    ...(taskId === undefined ? {} : { taskId }),
    ...(employeeId === undefined ? {} : { employeeId }),
    ...(methodId === undefined ? {} : { methodId }),
    ...(methodVersion === undefined ? {} : { methodVersion }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(runId === undefined ? {} : { runId }),
    runMode,
    ...(normalizeReturnTo(input.returnTo) === undefined ? {} : { returnTo: normalizeReturnTo(input.returnTo) }),
  }
}

export function openWorkItemTask(taskId: string, returnTo?: WorkItemReturnContext): WorkItemNavigationContext {
  return createWorkItemNavigation({ destination: 'detail', taskId, returnTo })
}

export function openEmployeeFromWorkItem(input: { employeeId: string; taskId?: string; methodId?: string; methodVersion?: number; returnTo?: WorkItemReturnContext }): WorkItemNavigationContext {
  return createWorkItemNavigation({ destination: 'employees', source: 'work-items', ...input })
}

export function openWorkflowFromWorkItem(input: { workflowId: string; taskId?: string; methodId?: string; runId?: string; returnTo?: WorkItemReturnContext }): WorkItemNavigationContext {
  return createWorkItemNavigation({ destination: 'workflow', source: 'work-items', ...input })
}

export function openExistingWorkItemRun(input: { taskId: string; runId: string; destination?: 'employees' | 'workflow'; employeeId?: string; workflowId?: string; methodId?: string; methodVersion?: number; source?: WorkItemNavigationSource; returnTo?: WorkItemReturnContext; runMode?: WorkItemRunMode }): WorkItemNavigationContext {
  const { destination, ...context } = input
  return createWorkItemNavigation({ destination: destination ?? 'detail', ...context, taskId: requiredText(input.taskId, 'taskId'), runId: requiredText(input.runId, 'runId') })
}

/** JSON is deliberately used as a transport value; business task definitions never live in this context. */
export function serializeWorkItemNavigation(context: WorkItemNavigationContext): string {
  return JSON.stringify(createWorkItemNavigation(context))
}

/** Parse untrusted history/state. Unknown fields are dropped and invalid optional values use safe defaults. */
export function parseWorkItemNavigation(value: unknown): WorkItemNavigationContext | undefined {
  let raw: unknown = value
  if (typeof value === 'string') {
    try { raw = JSON.parse(value) } catch { return undefined }
  }
  if (!isRecord(raw)) return undefined
  if (raw.version !== undefined && raw.version !== WORK_ITEM_NAVIGATION_VERSION) return undefined
  const destination = isOneOf(raw.destination, DESTINATIONS) ? raw.destination : 'work-items'
  const source = isOneOf(raw.source, SOURCES) ? raw.source : 'work-items'
  const runMode = raw.runMode === undefined || raw.runMode === 'task' || raw.runMode === 'debug' ? (raw.runMode ?? 'task') : undefined
  if (runMode === undefined) return undefined
  try {
    return createWorkItemNavigation({
      destination,
      source,
      taskId: optionalText(raw.taskId),
      employeeId: optionalText(raw.employeeId),
      methodId: optionalText(raw.methodId),
      methodVersion: safePositiveVersion(raw.methodVersion),
      workflowId: optionalText(raw.workflowId),
      runId: optionalText(raw.runId),
      runMode,
      returnTo: normalizeReturnTo(raw.returnTo),
    })
  } catch {
    return undefined
  }
}

/** Restore the origin after a linked surface closes without mutating task state. */
export function restoreWorkItemNavigation(context: WorkItemNavigationContext): WorkItemReturnContext | undefined {
  return context.returnTo === undefined ? undefined : { ...context.returnTo, filter: context.returnTo.filter === undefined ? undefined : { ...context.returnTo.filter } }
}

/** Build the explicit linked-surface return while retaining the list restoration context. */
export function returnToWorkItemsNavigation(
  context: WorkItemNavigationContext,
  source: 'employees' | 'workflow',
): WorkItemNavigationContext | undefined {
  const origin = restoreWorkItemNavigation(context)
  if (origin?.destination !== 'work-items') return undefined
  return createWorkItemNavigation({
    destination: 'work-items',
    source,
    taskId: origin.selectedTaskId,
    returnTo: origin,
  })
}
