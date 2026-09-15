import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { WorkTaskSnapshot } from '../../shared/work-items.js'
import type { WorkArtifactAcceptRequest, WorkTaskExecuteRequest } from '../../shared/work-items.js'
import { employeeDisplayLabel, type EmployeeSnapshot } from '../../shared/employees.js'
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

/**
 * Durable Work Items browser. Main remains the authority for task status and
 * actions; this page only queries, observes and renders its snapshots.
 */
export function WorkItemsPage({ copy, locale = 'zh', runtimeAvailable = true, navigation, onNavigate }: WorkItemsPageProps): JSX.Element {
  const [snapshots, setSnapshots] = useState<Map<string, WorkTaskSnapshot>>(() => new Map())
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [handoff, setHandoff] = useState<{ mode: 'handoff' | 'redo'; snapshot: WorkTaskSnapshot; executors: WorkItemExecutorOption[] }>()
  const listRequestSequence = useRef(0)
  const getRequestSequence = useRef(0)
  const taskButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++listRequestSequence.current
    setLoading(true)
    setError(undefined)
    try {
      const received = await window.EzDSH.workItems.list()
      if (!mounted.current || sequence !== listRequestSequence.current) return
      setSnapshots((current) => mergeSnapshotList(current, received))
    } catch (reason) {
      if (mounted.current && sequence === listRequestSequence.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current && sequence === listRequestSequence.current) setLoading(false)
    }
  }, [])

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

  const openExecutor = useCallback((snapshot: WorkTaskSnapshot): void => {
    const latestAttempt = [...snapshot.attempts].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
    if (latestAttempt === undefined || onNavigate === undefined) return
    const latestRun = [...snapshot.runs]
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

  const startHandoff = useCallback(async (mode: 'handoff' | 'redo'): Promise<void> => {
    const current = selectedTaskId === undefined ? undefined : snapshots.get(selectedTaskId)
    if (current === undefined) return
    try {
      const [employees, workflows] = await Promise.all([
        window.EzDSH.employees.list(),
        window.EzDSH.workflows.list(),
      ])
      const executors: WorkItemExecutorOption[] = [
        ...employees.filter((employee: EmployeeSnapshot) => employee.enabled).map((employee) => ({ label: employeeDisplayLabel(employee), executor: { kind: 'employee' as const, employeeId: employee.id } })),
        ...workflows.filter((workflow) => workflow.enabled).map((workflow) => ({ label: workflow.name, executor: { kind: 'workflow' as const, workflowId: workflow.id, workflowRevision: workflow.revision } })),
      ]
      setHandoff({ mode, snapshot: current, executors })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [selectedTaskId, snapshots])

  const executeHandoff = useCallback(async (request: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot> => {
    const next = await window.EzDSH.workItems.execute(request)
    setSnapshots((current) => mergeSnapshot(current, next))
    return next
  }, [])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.EzDSH.workItems.onChanged((snapshot) => {
      if (!mounted.current) return
      setSnapshots((current) => mergeSnapshot(current, snapshot))
    })
    void refresh()
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

  const orderedSnapshots = useMemo(() => [...snapshots.values()].sort(taskOrder), [snapshots])
  const selected = selectedTaskId === undefined ? undefined : snapshots.get(selectedTaskId)

  return (
    <div className="work-items-page" data-work-items-page>
      <header className="work-items-header">
        <div>
          <p className="work-items-eyebrow">{copy.tabWorkItems}</p>
          <h1>{copy.workItemsTitle}</h1>
          <p>{copy.workItemsHint}</p>
          {!runtimeAvailable ? <p className="work-items-offline" role="status">{copy.workItemsRuntimeOffline}</p> : null}
        </div>
        <button type="button" className="work-items-button" disabled={loading} onClick={() => { void refresh() }}>
          {loading ? copy.workItemsRefreshing : copy.workItemsRefresh}
        </button>
      </header>

      {error === undefined ? null : <p className="work-items-error" role="alert">{error}</p>}
      <div className="work-items-layout">
        <aside className="work-items-list" aria-label={copy.tabWorkItems}>
          {loading && orderedSnapshots.length === 0 ? <p className="work-items-muted">{copy.workItemsLoading}</p> : null}
          {!loading && orderedSnapshots.length === 0 ? <div className="work-items-empty"><h2>{copy.workItemsEmptyTitle}</h2><p>{copy.workItemsEmptyHint}</p></div> : null}
          {orderedSnapshots.map((snapshot) => (
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
          ))}
        </aside>
        <div className="work-items-detail-slot">
          {selected === undefined
            ? <div className="work-items-empty work-items-empty-detail"><h2>{copy.workItemsDetails}</h2><p>{copy.workItemsSelectTask}</p></div>
            : <>
              <WorkItemDetail
                copy={copy}
                locale={locale}
                snapshot={selected}
                onClose={() => { closeDetails(selected.task.id) }}
                onAcceptArtifact={acceptArtifact}
                onAccepted={(next) => { setSnapshots((current) => mergeSnapshot(current, next)) }}
                onStartHandoff={(mode) => { void startHandoff(mode) }}
                onOpenExecutor={() => { openExecutor(selected) }}
              />
              {handoff?.snapshot.task.id === selected.task.id ? <WorkItemHandoffDialog
                snapshot={handoff.snapshot}
                executors={handoff.executors}
                mode={handoff.mode}
                locale={locale}
                onExecute={executeHandoff}
                onExecuted={(next) => { setSnapshots((current) => mergeSnapshot(current, next)); setHandoff(undefined) }}
                onClose={() => { setHandoff(undefined) }}
              /> : null}
            </>}
        </div>
      </div>
    </div>
  )
}
