import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type {
  WorkActionAnswerRequest,
  WorkArtifact,
  WorkArtifactAcceptRequest,
  WorkRunControlRequest,
  WorkTaskArchiveRequest,
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
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
import { mergeSnapshot, mergeSnapshotList } from './work-item-view-model.js'
import { createWorkItemNavigation, restoreWorkItemNavigation, type WorkItemNavigationContext } from './work-item-navigation.js'
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
  const [createOptions, setCreateOptions] = useState<WorkItemCreateOptions>()
  const [loadingCreateOptions, setLoadingCreateOptions] = useState(false)
  const [employeeDirectory, setEmployeeDirectory] = useState<ReadonlyMap<string, EmployeeSnapshot>>(() => new Map())
  const [handoff, setHandoff] = useState<{ mode: 'handoff' | 'redo'; snapshot: WorkTaskSnapshot; executors: WorkItemExecutorOption[]; loadingExecutors: boolean }>()
  const listRequestSequence = useRef(0)
  const getRequestSequence = useRef(0)
  const handoffRequestSequence = useRef(0)
  const taskButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const archiveRetries = useRef(new Map<string, WorkTaskArchiveRequest>())
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
    if (restored !== undefined && onNavigate !== undefined && restored.destination !== 'detail') {
      const destination = restored.destination === 'work-items' ? 'work-items' : restored.destination
      const context = createWorkItemNavigation({
        destination,
        source: 'work-items',
        taskId: restored.selectedTaskId ?? (destination === 'work-items' ? taskId : undefined),
        employeeId: restored.selectedEmployeeId,
        methodId: restored.selectedMethodId,
        methodVersion: restored.selectedMethodVersion,
        workflowId: restored.selectedWorkflowId,
        runId: restored.selectedRunId,
        returnTo: restored.destination === 'work-items' ? undefined : restored,
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
    const returnTo = { destination: 'work-items' as const, source: 'work-items' as const, selectedTaskId: snapshot.task.id }
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
  }, [onNavigate])

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

  const startHandoff = useCallback(async (mode: 'handoff' | 'redo'): Promise<void> => {
    const current = selectedTaskId === undefined ? undefined : snapshots.get(selectedTaskId)
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
    try {
      const [employees, workflows, projects] = await Promise.all([
        window.EzDSH.employees.list(),
        window.EzDSH.workflows.list(),
        window.EzDSH.employees.listProjects(),
      ])
      if (!mounted.current) return
      setEmployeeDirectory(new Map(employees.map((employee) => [employee.id, employee])))
      setCreateOptions({
        employees: employees
          .filter((employee) => employee.enabled)
          .map((employee) => ({ employeeId: employee.id, label: employeeDisplayLabel(employee) })),
        workflows: workflows
          .filter((workflow) => workflow.enabled)
          .map((workflow) => ({ workflowId: workflow.id, workflowRevision: workflow.revision, label: workflow.name })),
        projects: projects.map((project) => ({ projectId: project.projectId, cwd: project.path, label: project.title })),
      })
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
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
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [refresh])

  useEffect(() => {
    if ((navigation?.destination !== 'detail' && navigation?.destination !== 'work-items') || navigation.taskId === undefined) return
    setSelectedTaskId(navigation.taskId)
    selectTask(navigation.taskId)
  }, [navigation, selectTask])

  const orderedSnapshots = useMemo(
    () => [...snapshots.values()]
      .filter((snapshot) => showArchived ? snapshot.task.archivedAt !== undefined : snapshot.task.archivedAt === undefined)
      .sort(taskOrder),
    [showArchived, snapshots],
  )
  const selectedCandidate = selectedTaskId === undefined ? undefined : snapshots.get(selectedTaskId)
  const selected = selectedCandidate !== undefined
    && (showArchived ? selectedCandidate.task.archivedAt !== undefined : selectedCandidate.task.archivedAt === undefined)
    ? selectedCandidate
    : undefined

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
              <small>{snapshot.task.scope.projectId ?? copy.workItemsUnassigned}</small>
            </button>
          )) : orderedSnapshots.length === 0 ? null : <WorkItemAttentionView
            snapshots={orderedSnapshots}
            selectedTaskId={selectedTaskId}
            locale={locale}
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
                onOpenExecutor={(runId) => { openExecutor(selected, runId) }}
                onAnswerAction={answerAction}
                onControlRun={controlRun}
                onChanged={(next) => { setSnapshots((current) => mergeSnapshot(current, next)) }}
                onArchive={archiveTask}
                employeeDirectory={employeeDirectory}
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
      {createOptions === undefined ? null : <WorkItemCreateDialog
        employees={createOptions.employees}
        workflows={createOptions.workflows}
        projects={createOptions.projects}
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
