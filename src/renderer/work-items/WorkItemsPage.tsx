import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type {
  WorkActionAnswerRequest,
  WorkArtifact,
  WorkArtifactAcceptRequest,
  WorkRunControlRequest,
  WorkTaskArchiveRequest,
  WorkTaskCancelRequest,
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
  WorkTaskRevisionRequest,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'
import { employeeDisplayLabel, type EmployeeSnapshot } from '../../shared/employees.js'
import { WorkItemAttentionView } from './WorkItemAttentionView.js'
import {
  WorkItemCreateDialog,
  type WorkItemCreateEmployeeCandidate,
  type WorkItemCreateProjectCandidate,
  type WorkItemCreateWorkflowCandidate,
} from './WorkItemCreateDialog.js'
import { WorkItemDetail } from './WorkItemDetail.js'
import { WorkItemHandoffDialog, type WorkItemExecutorOption } from './WorkItemHandoffDialog.js'
import { WorkItemProjectFilter } from './WorkItemProjectFilter.js'
import { WorkItemRevisionDialog, type WorkItemRevisionFollowUp } from './WorkItemRevisionDialog.js'
import {
  filterWorkItemsByProject,
  workItemProjectOptions,
  type WorkItemProjectDirectoryEntry,
  type WorkItemProjectFilterValue,
} from './work-item-project-filter.js'
import { mergeSnapshot, mergeSnapshotList } from './work-item-view-model.js'
import { createWorkItemNavigation, restoreWorkItemNavigation, type WorkItemListFilter, type WorkItemNavigationContext } from './work-item-navigation.js'
import './work-items.css'

interface WorkItemsPageProps {
  copy: AppCopy
  locale?: 'zh' | 'en'
  /** DSH Runtime is not a prerequisite for reading Main's durable task records. */
  runtimeAvailable?: boolean
  navigation?: WorkItemNavigationContext
  onNavigate?: (context: WorkItemNavigationContext) => void
}

function taskOrder(left: WorkTaskSnapshot, right: WorkTaskSnapshot): number {
  return right.task.updatedAt.localeCompare(left.task.updatedAt)
}

interface WorkItemCreateOptions {
  employees: WorkItemCreateEmployeeCandidate[]
  workflows: WorkItemCreateWorkflowCandidate[]
  projects: WorkItemCreateProjectCandidate[]
  unavailableCatalogs: Array<'employees' | 'workflows' | 'projects'>
}

function projectFilterFromNavigation(filter?: WorkItemListFilter): WorkItemProjectFilterValue {
  if (filter?.projectId !== undefined) return { kind: 'project', projectId: filter.projectId }
  if (filter?.unassignedProject === true) return { kind: 'unassigned' }
  return { kind: 'all' }
}

function navigationProjectFilter(filter: WorkItemProjectFilterValue): WorkItemListFilter | undefined {
  if (filter.kind === 'project') return { projectId: filter.projectId }
  if (filter.kind === 'unassigned') return { unassignedProject: true }
  return undefined
}

function mutationRequestId(prefix: string): string {
  const token = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${token}`
}

/**
 * Durable Work Items browser. Main remains the authority for task status and
 * actions; this page only queries, observes and renders its snapshots.
 */
export function WorkItemsPage({ copy, locale = 'zh', runtimeAvailable = true, navigation, onNavigate }: WorkItemsPageProps): JSX.Element {
  const [snapshots, setSnapshots] = useState<Map<string, WorkTaskSnapshot>>(() => new Map())
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [showArchived, setShowArchived] = useState(false)
  const [projectFilter, setProjectFilter] = useState<WorkItemProjectFilterValue>(() => projectFilterFromNavigation(navigation?.returnTo?.filter))
  const [projectDirectory, setProjectDirectory] = useState<WorkItemProjectDirectoryEntry[]>([])
  const [createOptions, setCreateOptions] = useState<WorkItemCreateOptions>()
  const [loadingCreateOptions, setLoadingCreateOptions] = useState(false)
  const [employeeDirectory, setEmployeeDirectory] = useState<ReadonlyMap<string, EmployeeSnapshot>>(() => new Map())
  const [handoff, setHandoff] = useState<{ mode: 'handoff' | 'redo'; snapshot: WorkTaskSnapshot; executors: WorkItemExecutorOption[]; loadingExecutors: boolean }>()
  const [revisionTaskId, setRevisionTaskId] = useState<string>()
  const listRequestSequence = useRef(0)
  const getRequestSequence = useRef(0)
  const handoffRequestSequence = useRef(0)
  const projectDirectoryRequestSequence = useRef(0)
  const appliedProjectDirectorySequence = useRef(0)
  const taskButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const archiveRetries = useRef(new Map<string, WorkTaskArchiveRequest>())
  const cancellationRetries = useRef(new Map<string, WorkTaskCancelRequest>())
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++listRequestSequence.current
    setLoading(true)
    setError(undefined)
    try {
      const received = await window.EzDSH.workItems.list({ includeArchived: showArchived })
      if (!mounted.current || sequence !== listRequestSequence.current) return
      setSnapshots((current) => mergeSnapshotList(current, received))
    } catch (reason) {
      if (mounted.current && sequence === listRequestSequence.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current && sequence === listRequestSequence.current) setLoading(false)
    }
  }, [showArchived])

  const selectTask = useCallback((taskId: string): void => {
    setSelectedTaskId(taskId)
    const requestSequence = ++getRequestSequence.current
    setError(undefined)
    void window.EzDSH.workItems.get(taskId)
      .then((snapshot) => {
        if (!mounted.current || requestSequence !== getRequestSequence.current || snapshot === undefined) return
        setSnapshots((current) => mergeSnapshot(current, snapshot))
      })
      .catch((reason) => {
        if (mounted.current && requestSequence === getRequestSequence.current) setError(reason instanceof Error ? reason.message : String(reason))
      })
  }, [])

  const closeDetails = useCallback((taskId: string): void => {
    const restored = navigation === undefined ? undefined : restoreWorkItemNavigation(navigation)
    if (restored !== undefined && onNavigate !== undefined && restored.destination !== 'detail' && restored.destination !== 'work-items') {
      const destination = restored.destination
      const context = createWorkItemNavigation({
        destination,
        source: 'work-items',
        taskId: restored.selectedTaskId,
        employeeId: restored.selectedEmployeeId,
        methodId: restored.selectedMethodId,
        methodVersion: restored.selectedMethodVersion,
        workflowId: restored.selectedWorkflowId,
        runId: restored.selectedRunId,
        returnTo: restored,
      })
      onNavigate(context)
      return
    }
    setSelectedTaskId(undefined)
    setTimeout(() => { taskButtonRefs.current.get(taskId)?.focus() }, 0)
  }, [navigation, onNavigate])

  const openExecutor = useCallback((snapshot: WorkTaskSnapshot, requestedRunId?: string): void => {
    const requestedRun = requestedRunId === undefined
      ? undefined
      : snapshot.runs.find((run) => run.runId === requestedRunId)
    const latestAttempt = requestedRun === undefined
      ? [...snapshot.attempts].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
      : snapshot.attempts.find((attempt) => attempt.id === requestedRun.attemptId)
    if (latestAttempt === undefined || onNavigate === undefined) return
    const latestRun = requestedRun ?? [...snapshot.runs]
      .filter((run) => run.attemptId === latestAttempt.id && run.runId !== '')
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
      .at(-1)
    const returnTo = {
      destination: 'work-items' as const,
      source: 'work-items' as const,
      selectedTaskId: snapshot.task.id,
      ...(navigationProjectFilter(projectFilter) === undefined ? {} : { filter: navigationProjectFilter(projectFilter) }),
    }
    // A handoff can add another run under the same attempt. The run is the
    // execution truth for the executor picker; only fall back to attempt
    // responsibility when no run was recorded yet.
    const executor = latestRun?.executor ?? latestAttempt.responsibility
    if (executor.kind === 'employee') {
      onNavigate(createWorkItemNavigation({
        destination: 'employees', source: 'work-items', taskId: snapshot.task.id,
        employeeId: executor.employeeId, methodId: executor.methodId, methodVersion: executor.methodVersion, runId: latestRun?.runId, returnTo,
      }))
      return
    }
      onNavigate(createWorkItemNavigation({
        destination: 'workflow', source: 'work-items', taskId: snapshot.task.id,
        workflowId: executor.workflowId, ...(latestRun?.runId === undefined ? {} : { runId: latestRun.runId }), returnTo,
      }))
  }, [onNavigate, projectFilter])

  const acceptArtifact = useCallback(async (request: WorkArtifactAcceptRequest): Promise<WorkTaskSnapshot> => {
    const next = await window.EzDSH.workItems.acceptArtifact(request)
    setSnapshots((current) => mergeSnapshot(current, next))
    return next
  }, [])

  const openArtifact = useCallback((artifact: WorkArtifact): void => {
    setError(undefined)
    void window.EzDSH.workItems.openArtifact(artifact.taskId, artifact.id).catch((reason) => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [])

  const startHandoff = useCallback(async (mode: 'handoff' | 'redo', snapshot?: WorkTaskSnapshot): Promise<void> => {
    const current = snapshot ?? (selectedTaskId === undefined ? undefined : snapshots.get(selectedTaskId))
    if (current === undefined) return
    const sequence = ++handoffRequestSequence.current
    setError(undefined)
    setHandoff({ mode, snapshot: current, executors: [], loadingExecutors: true })
    try {
      const [employees, workflows] = await Promise.all([
        window.EzDSH.employees.list(),
        window.EzDSH.workflows.list(),
      ])
      const executors: WorkItemExecutorOption[] = [
        ...employees.filter((employee: EmployeeSnapshot) => employee.enabled).map((employee) => ({ label: employeeDisplayLabel(employee), executor: { kind: 'employee' as const, employeeId: employee.id } })),
        ...workflows.filter((workflow) => workflow.enabled).map((workflow) => ({ label: workflow.name, executor: { kind: 'workflow' as const, workflowId: workflow.id, workflowRevision: workflow.revision } })),
      ]
      if (!mounted.current || sequence !== handoffRequestSequence.current) return
      setEmployeeDirectory(new Map(employees.map((employee) => [employee.id, employee])))
      setHandoff({ mode, snapshot: current, executors, loadingExecutors: false })
    } catch (reason) {
      if (!mounted.current || sequence !== handoffRequestSequence.current) return
      setHandoff(undefined)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [selectedTaskId, snapshots])

  const reviseTask = useCallback((request: WorkTaskRevisionRequest): Promise<WorkTaskSnapshot> => {
    return window.EzDSH.workItems.revise(request)
  }, [])

  const reloadRevisionTask = useCallback(async (taskId: string): Promise<WorkTaskSnapshot | undefined> => {
    const latest = await window.EzDSH.workItems.get(taskId)
    if (latest !== undefined) setSnapshots((current) => mergeSnapshot(current, latest))
    return latest
  }, [])

  const applyRevisedSnapshot = useCallback((next: WorkTaskSnapshot, followUp: WorkItemRevisionFollowUp): void => {
    setSnapshots((current) => mergeSnapshot(current, next))
    if (followUp !== 'none') void startHandoff(followUp, next)
  }, [startHandoff])

  const closeHandoff = useCallback((): void => {
    handoffRequestSequence.current += 1
    setHandoff(undefined)
  }, [])

  const executeHandoff = useCallback(async (request: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot> => {
    const next = await window.EzDSH.workItems.execute(request)
    setSnapshots((current) => mergeSnapshot(current, next))
    return next
  }, [])

  const openCreateDialog = useCallback(async (): Promise<void> => {
    if (loadingCreateOptions) return
    setLoadingCreateOptions(true)
    setError(undefined)
    const projectSequence = ++projectDirectoryRequestSequence.current
    try {
      const [employeeResult, workflowResult, projectResult] = await Promise.allSettled([
        window.EzDSH.employees.list(),
        window.EzDSH.workflows.list(),
        window.EzDSH.employees.listProjects(),
      ])
      if (!mounted.current) return
      const employees = employeeResult.status === 'fulfilled' ? employeeResult.value : []
      const workflows = workflowResult.status === 'fulfilled' ? workflowResult.value : []
      const projects = projectResult.status === 'fulfilled' ? projectResult.value : []
      if (employeeResult.status === 'fulfilled') setEmployeeDirectory(new Map(employees.map((employee) => [employee.id, employee])))
      if (projectResult.status === 'fulfilled' && projectSequence > appliedProjectDirectorySequence.current) {
        appliedProjectDirectorySequence.current = projectSequence
        setProjectDirectory(projects.map((project) => ({ projectId: project.projectId, title: project.title, path: project.path })))
      }
      setCreateOptions({
        employees: employees
          .filter((employee) => employee.enabled)
          .map((employee) => ({ employeeId: employee.id, label: employeeDisplayLabel(employee) })),
        workflows: workflows
          .filter((workflow) => workflow.enabled)
          .map((workflow) => ({ workflowId: workflow.id, workflowRevision: workflow.revision, label: workflow.name })),
        projects: projects.map((project) => ({ projectId: project.projectId, cwd: project.path, label: project.title })),
        unavailableCatalogs: [
          ...(employeeResult.status === 'rejected' ? ['employees' as const] : []),
          ...(workflowResult.status === 'rejected' ? ['workflows' as const] : []),
          ...(projectResult.status === 'rejected' ? ['projects' as const] : []),
        ],
      })
    } finally {
      if (mounted.current) setLoadingCreateOptions(false)
    }
  }, [loadingCreateOptions])

  const createTask = useCallback((request: WorkTaskCreateRequest): Promise<WorkTaskSnapshot> => {
    return window.EzDSH.workItems.create(request)
  }, [])

  const executeTask = useCallback((request: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot> => {
    return window.EzDSH.workItems.execute(request)
  }, [])

  const applyCreatedSnapshot = useCallback((snapshot: WorkTaskSnapshot): void => {
    setSnapshots((current) => mergeSnapshot(current, snapshot))
    setSelectedTaskId(snapshot.task.id)
  }, [])

  const answerAction = useCallback((request: WorkActionAnswerRequest): Promise<WorkTaskSnapshot> => {
    return window.EzDSH.workItems.answerAction(request)
  }, [])

  const controlRun = useCallback((request: WorkRunControlRequest): Promise<WorkTaskSnapshot> => {
    return window.EzDSH.workItems.controlRun(request)
  }, [])

  const archiveTask = useCallback(async (archived: boolean): Promise<void> => {
    if (selectedTaskId === undefined) return
    const current = snapshots.get(selectedTaskId)
    if (current === undefined) return
    const signature = `${current.task.id}:${current.task.revision}:${archived}`
    const request = archiveRetries.current.get(signature) ?? {
      requestId: mutationRequestId(archived ? 'work-item-archive' : 'work-item-restore'),
      taskId: current.task.id,
      expectedRevision: current.task.revision,
      archived,
    }
    archiveRetries.current.set(signature, request)
    try {
      const next = await window.EzDSH.workItems.archive(request)
      if (!mounted.current) return
      archiveRetries.current.delete(signature)
      setSnapshots((stored) => mergeSnapshot(stored, next))
      setSelectedTaskId(undefined)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    }
  }, [selectedTaskId, snapshots])

  const cancelTask = useCallback(async (): Promise<WorkTaskSnapshot> => {
    if (selectedTaskId === undefined) throw new Error(locale === 'en' ? 'No work item is selected.' : '尚未选择工作项。')
    const current = snapshots.get(selectedTaskId)
    if (current === undefined) throw new Error(locale === 'en' ? 'The work item is unavailable.' : '工作项当前不可用。')
    const persisted = current.task.cancellation
    const signature = `${current.task.id}:${current.task.revision}`
    const request = persisted?.state === 'outcome-unknown'
      ? {
          requestId: persisted.requestId,
          taskId: current.task.id,
          expectedRevision: persisted.expectedRevision,
        }
      : cancellationRetries.current.get(signature) ?? {
          requestId: mutationRequestId('work-item-cancel'),
          taskId: current.task.id,
          expectedRevision: current.task.revision,
        }
    if (persisted?.state !== 'outcome-unknown') cancellationRetries.current.set(signature, request)
    try {
      const next = await window.EzDSH.workItems.cancelTask(request)
      cancellationRetries.current.delete(signature)
      if (mounted.current) setSnapshots((stored) => mergeSnapshot(stored, next))
      return next
    } catch (reason) {
      const code = typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string'
        ? reason.code
        : undefined
      if (code === 'REVISION_CONFLICT') {
        cancellationRetries.current.delete(signature)
        try {
          const latest = await window.EzDSH.workItems.get(current.task.id)
          if (mounted.current && latest !== undefined) setSnapshots((stored) => mergeSnapshot(stored, latest))
        } catch {
          // Preserve the revision-conflict signal so the detail always drops
          // its stale confirmation, even when the follow-up read also fails.
        }
      }
      throw reason
    }
  }, [locale, selectedTaskId, snapshots])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.EzDSH.workItems.onChanged((snapshot) => {
      if (!mounted.current) return
      setSnapshots((current) => mergeSnapshot(current, snapshot))
    })
    void refresh()
    void window.EzDSH.employees.list().then((employees) => {
      if (!mounted.current) return
      setEmployeeDirectory(new Map(employees.map((employee) => [employee.id, employee])))
    }).catch(() => {
      // Work item history remains readable with the persisted employee id if the directory is unavailable.
    })
    const projectSequence = ++projectDirectoryRequestSequence.current
    void window.EzDSH.employees.listProjects().then((projects) => {
      if (!mounted.current || projectSequence <= appliedProjectDirectorySequence.current) return
      appliedProjectDirectorySequence.current = projectSequence
      setProjectDirectory(projects.map((project) => ({ projectId: project.projectId, title: project.title, path: project.path })))
    }).catch(() => {
      // The persisted project id remains visible when the runtime project directory is unavailable.
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [refresh])

  useEffect(() => {
    if ((navigation?.destination !== 'detail' && navigation?.destination !== 'work-items') || navigation.taskId === undefined) return
    setProjectFilter(projectFilterFromNavigation(navigation.returnTo?.filter))
    setSelectedTaskId(navigation.taskId)
    selectTask(navigation.taskId)
  }, [navigation, selectTask])

  const projectOptions = useMemo(
    () => workItemProjectOptions([...snapshots.values()], projectDirectory),
    [projectDirectory, snapshots],
  )
  const projectLabels = useMemo(
    () => new Map(projectOptions.map((option) => [option.projectId, option.orphaned ? option.projectId : option.title])),
    [projectOptions],
  )
  const orderedSnapshots = useMemo(() => filterWorkItemsByProject(
    [...snapshots.values()].filter((snapshot) => showArchived
      ? snapshot.task.archivedAt !== undefined
      : snapshot.task.archivedAt === undefined),
    projectFilter,
  ).sort(taskOrder), [projectFilter, showArchived, snapshots])
  const selectedCandidate = selectedTaskId === undefined ? undefined : snapshots.get(selectedTaskId)
  const selected = selectedCandidate !== undefined && orderedSnapshots.some((snapshot) => snapshot.task.id === selectedCandidate.task.id)
    ? selectedCandidate
    : undefined
  const selectedProject = selected?.task.scope.projectId === undefined
    ? undefined
    : projectDirectory.find((project) => project.projectId === selected.task.scope.projectId)

  return (
    <div className="work-items-page" data-work-items-page>
      <header className="work-items-header">
        <div>
          <p className="work-items-eyebrow">{copy.tabWorkItems}</p>
          <h1>{copy.workItemsTitle}</h1>
          <p>{copy.workItemsHint}</p>
          {!runtimeAvailable ? <p className="work-items-offline" role="status">{copy.workItemsRuntimeOffline}</p> : null}
        </div>
        <div className="work-items-header-actions">
          <button type="button" className="work-items-button" disabled={loadingCreateOptions} onClick={() => { void openCreateDialog() }}>
            {loadingCreateOptions ? (locale === 'en' ? 'Loading…' : '正在读取…') : (locale === 'en' ? 'New work item' : '新建工作项')}
          </button>
          <button
            type="button"
            className="work-items-button work-items-button-quiet"
            aria-pressed={showArchived}
            onClick={() => {
              setSelectedTaskId(undefined)
              setShowArchived((current) => !current)
            }}
          >{showArchived ? (locale === 'en' ? 'Back to active' : '返回进行中') : (locale === 'en' ? 'Archived' : '查看归档')}</button>
          <button type="button" className="work-items-button work-items-button-quiet" disabled={loading} onClick={() => { void refresh() }}>
            {loading ? copy.workItemsRefreshing : copy.workItemsRefresh}
          </button>
        </div>
      </header>

      {error === undefined ? null : <p className="work-items-error" role="alert">{error}</p>}
      <div className="work-items-layout">
        <aside className="work-items-list" aria-label={copy.tabWorkItems}>
          <WorkItemProjectFilter
            value={projectFilter}
            options={projectOptions}
            locale={locale}
            onChange={(next) => {
              setProjectFilter(next)
              setSelectedTaskId(undefined)
            }}
          />
          {loading && orderedSnapshots.length === 0 ? <p className="work-items-muted">{copy.workItemsLoading}</p> : null}
          {!loading && orderedSnapshots.length === 0 ? <div className="work-items-empty"><h2>{copy.workItemsEmptyTitle}</h2><p>{copy.workItemsEmptyHint}</p></div> : null}
          {showArchived ? orderedSnapshots.map((snapshot) => (
            <button
              key={snapshot.task.id}
              type="button"
              className={`work-items-task ${selectedTaskId === snapshot.task.id ? 'work-items-task-selected' : ''}`}
              aria-pressed={selectedTaskId === snapshot.task.id}
              ref={(button) => {
                if (button === null) taskButtonRefs.current.delete(snapshot.task.id)
                else taskButtonRefs.current.set(snapshot.task.id, button)
              }}
              onClick={() => { selectTask(snapshot.task.id) }}
            >
              <span className="work-items-task-title">{snapshot.task.title}</span>
              <span>{copy.workItemsTaskStatus(snapshot.task.status)} · {copy.workItemsRequirementVersion(snapshot.task.currentRequirementVersion)}</span>
              <small>{snapshot.task.scope.projectId === undefined
                ? copy.workItemsUnassigned
                : projectLabels.get(snapshot.task.scope.projectId) ?? snapshot.task.scope.projectId}</small>
            </button>
          )) : orderedSnapshots.length === 0 ? null : <WorkItemAttentionView
            snapshots={orderedSnapshots}
            selectedTaskId={selectedTaskId}
            locale={locale}
            projectLabels={projectLabels}
            onButtonRef={(taskId, button) => {
              if (button === null) taskButtonRefs.current.delete(taskId)
              else taskButtonRefs.current.set(taskId, button)
            }}
            onSelect={selectTask}
          />}
        </aside>
        <div className="work-items-detail-slot">
          {selected === undefined
            ? <div className="work-items-empty work-items-empty-detail"><h2>{copy.workItemsDetails}</h2><p>{copy.workItemsSelectTask}</p></div>
            : <>
              <WorkItemDetail
                key={selected.task.id}
                copy={copy}
                locale={locale}
                snapshot={selected}
                onClose={() => { closeDetails(selected.task.id) }}
                onAcceptArtifact={acceptArtifact}
                onAccepted={(next) => { setSnapshots((current) => mergeSnapshot(current, next)) }}
                onOpenArtifact={openArtifact}
                onStartHandoff={(mode) => { void startHandoff(mode) }}
                onStartRevision={() => setRevisionTaskId(selected.task.id)}
                onOpenExecutor={(runId) => { openExecutor(selected, runId) }}
                onAnswerAction={answerAction}
                onControlRun={controlRun}
                onChanged={(next) => { setSnapshots((current) => mergeSnapshot(current, next)) }}
                onArchive={archiveTask}
                onCancelTask={cancelTask}
                employeeDirectory={employeeDirectory}
                project={selectedProject}
              />
            </>}
        </div>
      </div>
      {handoff === undefined ? null : <WorkItemHandoffDialog
        snapshot={handoff.snapshot}
        executors={handoff.executors}
        mode={handoff.mode}
        loadingExecutors={handoff.loadingExecutors}
        locale={locale}
        onExecute={executeHandoff}
        onExecuted={(next) => { setSnapshots((current) => mergeSnapshot(current, next)) }}
        onClose={closeHandoff}
      />}
      {revisionTaskId === undefined || snapshots.get(revisionTaskId) === undefined ? null : <WorkItemRevisionDialog
        snapshot={snapshots.get(revisionTaskId)!}
        locale={locale}
        onRevise={reviseTask}
        onReload={reloadRevisionTask}
        onRevised={applyRevisedSnapshot}
        onClose={() => setRevisionTaskId(undefined)}
      />}
      {createOptions === undefined ? null : <WorkItemCreateDialog
        employees={createOptions.employees}
        workflows={createOptions.workflows}
        projects={createOptions.projects}
        unavailableCatalogs={createOptions.unavailableCatalogs}
        locale={locale}
        onCreate={createTask}
        onExecute={executeTask}
        onCreated={applyCreatedSnapshot}
        onExecuted={applyCreatedSnapshot}
        onClose={() => setCreateOptions(undefined)}
      />}
    </div>
  )
}
