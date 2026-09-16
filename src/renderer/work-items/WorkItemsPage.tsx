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
import type { WorkbenchAttentionGroup, WorkbenchAttentionItem, WorkbenchAttentionSnapshot } from '../../shared/workbench-attention.js'
import { getNotificationText, type NotificationInboxItem, type NotificationInboxSnapshot } from '../../shared/notifications.js'
import { employeeDisplayLabel, type EmployeeSnapshot } from '../../shared/employees.js'
import type { WorkDuty } from '../../shared/work-duty.js'
import type { WorkflowDefinition } from '../../shared/workflow.js'
import type { WorkbenchImportPreview } from '../../main/work-items/workbench-import.js'
import type { WorkbenchMigrationPreparation, WorkbenchMigrationReport, WorkbenchMigrationState } from '../../shared/workbench-migration.js'
import { WorkItemAttentionView } from './WorkItemAttentionView.js'
import {
  WorkItemCreateDialog,
  type WorkItemCreateEmployeeCandidate,
  type WorkItemCreateProjectCandidate,
  type WorkItemCreateWorkflowCandidate,
} from './WorkItemCreateDialog.js'
import { WorkItemDetail } from './WorkItemDetail.js'
import { WorkItemProjectContextPanel } from './WorkItemProjectContextPanel.js'
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

function workbenchCandidateConflict(preview: WorkbenchImportPreview, candidate: WorkbenchImportPreview['candidates'][number]): boolean {
  return preview.conflicts.some((conflict) => conflict.sourceKey === candidate.sourceKey
    || conflict.sourceKey.startsWith(`${candidate.sourceKey}:`)
    || conflict.detail.includes(candidate.sourceKey)
    || candidate.fileReferences.some((reference) => conflict.detail.includes(reference)))
}

function migrationBaseSourceKey(sourceKey: string): string {
  return sourceKey.replace(/:duplicate-\d+$/u, '')
}

function selectionForMigrationPreview(
  preview: WorkbenchImportPreview,
  state: WorkbenchMigrationState | undefined,
): string[] {
  const savedPlan = state?.plans.find((plan) => plan.sourceId === preview.sourceId && plan.sourceHash === preview.sourceHash)
  if (savedPlan === undefined) {
    return preview.candidates.filter((candidate) => !workbenchCandidateConflict(preview, candidate)).map((candidate) => candidate.sourceKey)
  }
  const selectedBases = new Set((state?.receipts ?? [])
    .filter((receipt) => receipt.sourceSnapshotHash === savedPlan.sourceHash
      && receipt.mappingHash === savedPlan.mappingHash
      && ['ready', 'failed', 'unknown'].includes(receipt.status))
    .map((receipt) => savedPlan.items.find((item) => item.identity.identity === receipt.identity)?.identity.sourceKey)
    .filter((sourceKey): sourceKey is string => sourceKey !== undefined)
    .map(migrationBaseSourceKey))
  return preview.candidates
    .filter((candidate) => !workbenchCandidateConflict(preview, candidate) && selectedBases.has(migrationBaseSourceKey(candidate.sourceKey)))
    .map((candidate) => candidate.sourceKey)
}

const ATTENTION_GROUPS: readonly { id: WorkbenchAttentionGroup; zh: string; en: string }[] = [
  { id: 'needs-action', zh: '需要处理', en: 'Needs action' },
  { id: 'in-progress', zh: '进行中', en: 'In progress' },
  { id: 'review', zh: '待验收', en: 'Review' },
  { id: 'failed', zh: '失败', en: 'Failed' },
  { id: 'dispatch-anomalies', zh: '调度异常', en: 'Dispatch issues' },
]

function AttentionSummary({ snapshot, locale, onSelect }: { snapshot?: WorkbenchAttentionSnapshot; locale: 'zh' | 'en'; onSelect: (taskId: string) => void }): JSX.Element | null {
  if (snapshot === undefined) return null
  return <section className="work-items-attention-summary" aria-label={locale === 'en' ? 'Workbench attention summary' : '工作台关注摘要'}>
    <div className="work-items-attention-summary-heading">
      <div>
        <strong>{locale === 'en' ? 'Workbench attention' : '工作台关注摘要'}</strong>
        <span>{locale === 'en' ? `${snapshot.total} active items from Main` : `Main 汇总 ${snapshot.total} 个需要关注的工作项`}</span>
      </div>
      <small>{locale === 'en' ? 'Read-only projection' : '只读投影'}</small>
    </div>
    <div className="work-items-attention-summary-groups">
      {ATTENTION_GROUPS.map(({ id, zh, en }) => {
        const items = snapshot.groups[id]
        const label = locale === 'en' ? en : zh
        const first: WorkbenchAttentionItem | undefined = items[0]
        return <div key={id} className="work-items-attention-summary-group" data-attention-group={id}>
          <div className="work-items-attention-summary-label"><span>{label}</span><b>{items.length}</b></div>
          {first === undefined
            ? <span className="work-items-attention-summary-empty">{locale === 'en' ? 'None' : '无'}</span>
            : <button type="button" className="work-items-attention-summary-item" onClick={() => onSelect(first.taskId)} title={first.reason}>
              <span>{first.title}</span><small>{first.reason}</small>
            </button>}
        </div>
      })}
    </div>
  </section>
}

function NotificationInbox({ snapshot, locale, onMarkRead, onDismiss, onSelectWorkItem }: {
  snapshot?: NotificationInboxSnapshot
  locale: 'zh' | 'en'
  onMarkRead: (id: string) => void
  onDismiss: (id: string) => void
  onSelectWorkItem?: (taskId: string) => void
}): JSX.Element | null {
  if (snapshot === undefined) return null
  const items = snapshot.items.filter((item) => item.dismissedAt === undefined).slice(-8).reverse()
  return <section className="work-items-notification-inbox" aria-label={locale === 'en' ? 'Notification inbox' : '通知收件箱'}>
    <div className="work-items-notification-heading">
      <div>
        <strong>{locale === 'en' ? 'Notification inbox' : '通知收件箱'}</strong>
        <span>{locale === 'en' ? `${snapshot.unreadCount} unread` : `${snapshot.unreadCount} 条未读`}</span>
      </div>
      <small>{locale === 'en' ? 'Durable Main records' : 'Main 持久记录'}</small>
    </div>
    {items.length === 0
      ? <p className="work-items-notification-empty">{locale === 'en' ? 'No retained notifications.' : '暂无保留的通知。'}</p>
      : <ul className="work-items-notification-list">
        {items.map((item: NotificationInboxItem) => {
          const text = getNotificationText(locale, item.signal)
          return <li key={item.id} className={item.readAt === undefined ? 'work-items-notification-unread' : undefined}>
            <div className="work-items-notification-copy">
              {item.signal.workItemId !== undefined && onSelectWorkItem !== undefined
                ? <button type="button" className="work-items-notification-link" onClick={() => onSelectWorkItem(item.signal.workItemId!)}>{text.title}</button>
                : <strong>{text.title}</strong>}
              <span>{item.signal.detail ?? text.body}</span>
              <small>{new Date(item.createdAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}</small>
            </div>
            <div className="work-items-notification-actions">
              {item.readAt === undefined ? <button type="button" onClick={() => onMarkRead(item.id)}>{locale === 'en' ? 'Mark read' : '标记已读'}</button> : null}
              <button type="button" onClick={() => onDismiss(item.id)}>{locale === 'en' ? 'Dismiss' : '关闭'}</button>
            </div>
          </li>
        })}
      </ul>}
  </section>
}

function WorkDutyPanel({ snapshots, employees, locale }: {
  snapshots: ReadonlyArray<WorkTaskSnapshot>
  employees: ReadonlyMap<string, EmployeeSnapshot>
  locale: 'zh' | 'en'
}): JSX.Element | null {
  const [duties, setDuties] = useState<WorkDuty[]>([])
  const [busyDutyId, setBusyDutyId] = useState<string>()
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [creating, setCreating] = useState(false)
  const [creatingDuty, setCreatingDuty] = useState(false)
  const [createError, setCreateError] = useState<string>()
  const activeTasks = useMemo(() => snapshots.filter((snapshot) => snapshot.task.archivedAt === undefined && snapshot.task.status !== 'cancelled'), [snapshots])
  const employeeOptions = useMemo(() => [...employees.values()].filter((employee) => employee.enabled), [employees])
  const taskTitles = useMemo(() => new Map(snapshots.map((snapshot) => [snapshot.task.id, snapshot.task.title])), [snapshots])
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDuties(await window.EzDSH.workbench.duties.list())
    } catch {
      // The Work Items surface remains usable when the optional duty store is unavailable.
    }
  }, [])
  useEffect(() => {
    void refresh()
    void window.EzDSH.workflows.list().then(setWorkflows).catch(() => setWorkflows([]))
    return window.EzDSH.workbench.duties.onChange(() => { void refresh() })
  }, [refresh])

  const setPaused = useCallback(async (duty: WorkDuty, paused: boolean): Promise<void> => {
    setBusyDutyId(duty.id)
    try {
      const request = {
        requestId: mutationRequestId(paused ? 'work-duty-pause' : 'work-duty-resume'),
        dutyId: duty.id,
        expectedRevision: duty.revision,
      }
      if (paused) await window.EzDSH.workbench.duties.pause(request)
      else await window.EzDSH.workbench.duties.resume(request)
      await refresh()
    } finally {
      setBusyDutyId(undefined)
    }
  }, [refresh])

  const createDuty = useCallback(async (form: HTMLFormElement): Promise<void> => {
    const data = new FormData(form)
    const taskId = String(data.get('taskId') ?? '').trim()
    const executorKey = String(data.get('executor') ?? '').trim()
    const everySeconds = Number(data.get('everySeconds') ?? 300)
    const rawInput = String(data.get('input') ?? '').trim()
    if (taskId === '' || executorKey === '' || !Number.isSafeInteger(everySeconds) || everySeconds < 300) {
      setCreateError(locale === 'en' ? 'Choose a task and executor; interval must be at least 300 seconds.' : '请选择工作项和执行者，间隔至少为 300 秒。')
      return
    }
    let input: unknown = rawInput
    if (rawInput === '') input = {}
    else {
      try { input = JSON.parse(rawInput) } catch { /* Plain text is a valid recurring input. */ }
    }
    const executor = executorKey.startsWith('employee:')
      ? { kind: 'employee' as const, employeeId: executorKey.slice('employee:'.length) }
      : { kind: 'workflow' as const, workflowId: executorKey.slice('workflow:'.length), workflowRevision: workflows.find((workflow) => `workflow:${workflow.id}` === executorKey)?.revision }
    setCreatingDuty(true)
    setCreateError(undefined)
    try {
      await window.EzDSH.workbench.duties.create({
        requestId: mutationRequestId('work-duty-create'),
        taskId,
        executor,
        input,
        everySeconds,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        nextOccurrenceAt: new Date(Date.now() + everySeconds * 1000).toISOString(),
      })
      setCreating(false)
      await refresh()
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreatingDuty(false)
    }
  }, [locale, refresh, workflows])

  return <section className="work-items-duty-panel" aria-label={locale === 'en' ? 'Scheduled duties' : '周期职责'}>
    <div className="work-items-duty-heading">
      <div>
        <strong>{locale === 'en' ? 'Scheduled duties' : '周期职责'}</strong>
        <span>{duties.length === 0
          ? (locale === 'en' ? 'No duties configured' : '尚未配置职责')
          : (locale === 'en' ? `${duties.length} durable responsibilities` : `${duties.length} 个持久职责`)}</span>
      </div>
      <button type="button" className="work-items-button work-items-button-quiet" onClick={() => { setCreating((current) => !current); setCreateError(undefined) }}>
        {creating ? (locale === 'en' ? 'Close' : '收起') : (locale === 'en' ? 'New duty' : '新建职责')}
      </button>
    </div>
    {creating ? <form className="work-items-duty-create" onSubmit={(event) => { event.preventDefault(); void createDuty(event.currentTarget) }}>
      <label>{locale === 'en' ? 'Work item' : '工作项'}
        <select name="taskId" defaultValue={activeTasks[0]?.task.id ?? ''} disabled={activeTasks.length === 0}>
          {activeTasks.map((snapshot) => <option key={snapshot.task.id} value={snapshot.task.id}>{snapshot.task.title}</option>)}
        </select>
      </label>
      <label>{locale === 'en' ? 'Executor' : '执行者'}
        <select name="executor" defaultValue={employeeOptions[0] === undefined ? (workflows.find((workflow) => workflow.enabled) === undefined ? '' : `workflow:${workflows.find((workflow) => workflow.enabled)!.id}`) : `employee:${employeeOptions[0].id}`}>
          {employeeOptions.map((employee) => <option key={`employee:${employee.id}`} value={`employee:${employee.id}`}>{employeeDisplayLabel(employee)}</option>)}
          {workflows.filter((workflow) => workflow.enabled).map((workflow) => <option key={`workflow:${workflow.id}`} value={`workflow:${workflow.id}`}>{workflow.name}</option>)}
        </select>
      </label>
      <label>{locale === 'en' ? 'Every seconds' : '间隔秒数'}
        <input name="everySeconds" type="number" min={300} step={1} defaultValue={300} />
      </label>
      <label>{locale === 'en' ? 'Input (JSON or text)' : '输入（JSON 或文本）'}
        <textarea name="input" rows={2} placeholder={locale === 'en' ? '{} or a plain text prompt' : '{} 或一段文本'} />
      </label>
      {createError === undefined ? null : <p className="work-items-duty-create-error" role="alert">{createError}</p>}
      <div className="work-items-duty-create-actions">
        <button type="submit" className="work-items-button" disabled={creatingDuty || activeTasks.length === 0}>{creatingDuty ? '…' : (locale === 'en' ? 'Create' : '创建')}</button>
      </div>
    </form> : null}
    {duties.length === 0 ? <p className="work-items-duty-empty">{locale === 'en' ? 'A duty runs this Work Item on a durable interval after the Runtime is available.' : '创建后，Runtime 可用时会按持久化间隔执行这个工作项。'}</p> : null}
    {duties.length === 0 ? null : <ul className="work-items-duty-list">
      {duties.map((duty) => {
        const executor = duty.executor.kind === 'employee'
          ? employees.get(duty.executor.employeeId) === undefined
            ? duty.executor.employeeId
            : employeeDisplayLabel(employees.get(duty.executor.employeeId)!)
          : duty.executor.workflowId
        return <li key={duty.id} className={duty.paused ? 'work-items-duty-paused' : undefined}>
          <div className="work-items-duty-copy">
            <strong>{taskTitles.get(duty.taskId) ?? duty.taskId}</strong>
            <span>{executor} · {duty.everySeconds}s · {duty.timezone}</span>
            <small>{locale === 'en' ? 'Next' : '下次'} {new Date(duty.nextOccurrenceAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')}</small>
          </div>
          <button
            type="button"
            className="work-items-button work-items-button-quiet"
            disabled={busyDutyId === duty.id}
            onClick={() => { void setPaused(duty, !duty.paused) }}
          >{busyDutyId === duty.id ? '…' : duty.paused
            ? (locale === 'en' ? 'Resume' : '恢复')
            : (locale === 'en' ? 'Pause' : '暂停')}</button>
        </li>
      })}
    </ul>}
  </section>
}

function WorkbenchMigrationPanel({ locale }: { locale: 'zh' | 'en' }): JSX.Element {
  const [sourceDirectory, setSourceDirectory] = useState('')
  const [preview, setPreview] = useState<WorkbenchImportPreview>()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [preparation, setPreparation] = useState<WorkbenchMigrationPreparation>()
  const [migrationState, setMigrationState] = useState<WorkbenchMigrationState>()
  const [report, setReport] = useState<WorkbenchMigrationReport>()
  const [busy, setBusy] = useState<'preview' | 'prepare' | 'apply' | 'batch'>()
  const [error, setError] = useState<string>()
  const refreshMigrationState = useCallback(async (): Promise<void> => {
    try {
      setMigrationState(await window.EzDSH.workbench.migration.state())
    } catch {
      // Migration is developer-only and optional while the workspace is reopening.
    }
  }, [])
  useEffect(() => { void refreshMigrationState() }, [refreshMigrationState])
  const refreshReport = useCallback(async (plan: WorkbenchMigrationPreparation['plan']): Promise<void> => {
    try {
      setReport(await window.EzDSH.workbench.migration.report({ sourceId: plan.sourceId, sourceHash: plan.sourceHash, mappingHash: plan.mappingHash }))
    } catch {
      // A report is a read-only projection and may be unavailable during recovery.
    }
  }, [])
  const previewSource = useCallback(async (): Promise<void> => {
    if (sourceDirectory.trim() === '') {
      setError(locale === 'en' ? 'Enter the legacy Workbench directory.' : '请输入旧 Workbench 目录。')
      return
    }
    setBusy('preview')
    setError(undefined)
    try {
      const next = await window.EzDSH.workbench.migration.preview(sourceDirectory.trim())
      setPreview(next)
      setPreparation(undefined)
      setReport(undefined)
      setSelected(new Set(selectionForMigrationPreview(next, migrationState)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }, [locale, migrationState, sourceDirectory])
  const prepare = useCallback(async (): Promise<void> => {
    if (preview === undefined) return
    setBusy('prepare')
    setError(undefined)
    try {
      const next = await window.EzDSH.workbench.migration.prepare({
        requestId: mutationRequestId('workbench-migration-prepare'),
        sourceDirectory: sourceDirectory.trim(),
        sourceId: preview.sourceId,
        sourceHash: preview.sourceHash,
        confirmedSourceKeys: [...selected],
      })
      setPreparation(next)
      await refreshMigrationState()
      if (!next.stale) await refreshReport(next.plan)
      if (next.stale) setError(next.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }, [preview, refreshMigrationState, refreshReport, selected, sourceDirectory])
  const apply = useCallback(async (identity: string, allowUnknown = false): Promise<void> => {
    if (preparation === undefined) return
    const receipt = preparation.receipts.find((candidate) => candidate.identity === identity)
    const canRetryUnknown = receipt?.status === 'unknown' && allowUnknown
    const targetStatus = report?.items.find((candidate) => candidate.identity === identity)?.targetStatus
    const canRecoverMissing = receipt?.status === 'applied' && targetStatus === 'missing' && allowUnknown
    if (receipt === undefined || (receipt.status !== 'ready' && !canRetryUnknown && !canRecoverMissing)) return
    setBusy('apply')
    setError(undefined)
    try {
      const result = await window.EzDSH.workbench.migration.apply({
        requestId: mutationRequestId('workbench-migration-apply'),
        identity,
        sourceId: preparation.plan.sourceId,
        sourceSnapshotHash: preparation.plan.sourceHash,
        mappingHash: preparation.plan.mappingHash,
        ...(allowUnknown ? { allowUnknown: true } : {}),
      })
      setPreparation((current) => current === undefined ? current : {
        ...current,
        message: locale === 'en' ? 'The selected Work Item was created and linked to this migration receipt.' : '已创建所选工作项，并将实际任务 ID 写入迁移回执。',
        receipts: current.receipts.map((candidate) => candidate.identity === identity ? result.receipt : candidate),
      })
      await refreshMigrationState()
      await refreshReport(preparation.plan)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refreshMigrationState()
    } finally {
      setBusy(undefined)
    }
  }, [locale, preparation, refreshMigrationState, refreshReport, report])
  const applyBatch = useCallback(async (): Promise<void> => {
    if (preparation === undefined) return
    const identities = preparation.receipts
      .filter((receipt) => receipt.status === 'ready')
      .filter((receipt) => {
        const item = preparation.plan.items.find((candidate) => candidate.identity.identity === receipt.identity)
        return item?.target.kind === 'work-item' && item.target.action === 'create' && item.conflicts.length === 0
      })
      .map((receipt) => receipt.identity)
    if (identities.length === 0) return
    setBusy('batch')
    setError(undefined)
    try {
      const result = await window.EzDSH.workbench.migration.applyBatch({
        batchRequestId: mutationRequestId('workbench-migration-batch'),
        sourceId: preparation.plan.sourceId,
        sourceSnapshotHash: preparation.plan.sourceHash,
        mappingHash: preparation.plan.mappingHash,
        identities,
      })
      setPreparation((current) => current === undefined ? current : {
        ...current,
        message: result.status === 'completed'
          ? (locale === 'en' ? `Batch Apply completed for ${result.items.length} items.` : `批量应用已完成，共处理 ${result.items.length} 项。`)
          : (locale === 'en' ? `Batch Apply stopped with ${result.items.filter((item) => item.status !== 'applied').length} item(s) needing attention.` : `批量应用部分完成，还有 ${result.items.filter((item) => item.status !== 'applied').length} 项需要处理。`),
        receipts: current.receipts.map((receipt) => result.items.find((item) => item.identity === receipt.identity)?.receipt ?? receipt),
      })
      await refreshMigrationState()
      await refreshReport(preparation.plan)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refreshMigrationState()
    } finally {
      setBusy(undefined)
    }
  }, [locale, preparation, refreshMigrationState, refreshReport])
  const toggle = useCallback((sourceKey: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(sourceKey)) next.delete(sourceKey)
      else next.add(sourceKey)
      return next
    })
  }, [])
  return <section className="work-items-migration-panel" aria-label={locale === 'en' ? 'Legacy Workbench migration' : '旧 Workbench 迁移'}>
    <div className="work-items-duty-heading">
      <div>
        <strong>{locale === 'en' ? 'Legacy Workbench migration' : '旧 Workbench 迁移'}</strong>
        <span>{locale === 'en' ? 'Preview, confirm, then apply eligible Work Items one at a time.' : '先预览并逐项确认持久计划，再逐项应用可创建的工作项。'}</span>
      </div>
    </div>
    {migrationState === undefined || migrationState.plans.length === 0 ? null : <div className="work-items-migration-saved" aria-label={locale === 'en' ? 'Saved migration plans' : '已保存的迁移计划'}>
      <small>{locale === 'en' ? `${migrationState.plans.length} saved plan(s)` : `已保存 ${migrationState.plans.length} 个迁移计划`}</small>
      <ul className="work-items-migration-list">
        {migrationState.plans.slice(-4).reverse().map((plan) => {
          const receipts = migrationState.receipts.filter((receipt) => plan.items.some((item) => item.identity.identity === receipt.identity)
            && receipt.sourceSnapshotHash === plan.sourceHash && receipt.mappingHash === plan.mappingHash)
          const ready = receipts.filter((receipt) => receipt.status === 'ready').length
          const applied = receipts.filter((receipt) => receipt.status === 'applied').length
          return <li key={`${plan.sourceId}:${plan.sourceHash}`}>
            <span><strong>{plan.sourceDirectory}</strong><small>{locale === 'en' ? `${plan.items.length} mapped · ${ready} ready · ${applied} applied` : `${plan.items.length} 项映射 · ${ready} 项待执行 · ${applied} 项已应用`}</small></span>
            <button type="button" className="work-items-button work-items-button-quiet" onClick={() => { setSourceDirectory(plan.sourceDirectory); setPreview(undefined); setPreparation(undefined); setReport(undefined); setError(undefined) }}>{locale === 'en' ? 'Use source' : '使用源目录'}</button>
          </li>
        })}
      </ul>
    </div>}
    <div className="work-items-migration-input">
      <input value={sourceDirectory} onChange={(event) => setSourceDirectory(event.target.value)} placeholder={locale === 'en' ? '/path/to/legacy-workbench' : '/旧 Workbench 目录'} />
      <button type="button" className="work-items-button" disabled={busy !== undefined} onClick={() => { void previewSource() }}>{busy === 'preview' ? '…' : (locale === 'en' ? 'Preview' : '预览')}</button>
    </div>
    {error === undefined ? null : <p className="work-items-duty-create-error" role="alert">{error}</p>}
    {preview === undefined ? <p className="work-items-duty-empty">{locale === 'en' ? 'No legacy source selected.' : '尚未选择旧 Workbench 源。'}</p> : <>
      <div className="work-items-migration-summary">
        <span>{locale === 'en' ? `${preview.summary.projects} projects · ${preview.summary.tasks} tasks · ${preview.summary.ideas} ideas` : `${preview.summary.projects} 个项目 · ${preview.summary.tasks} 个任务 · ${preview.summary.ideas} 个思路`}</span>
        <small>{preview.conflicts.length === 0 ? (locale === 'en' ? 'No source conflicts' : '没有源冲突') : (locale === 'en' ? `${preview.conflicts.length} source conflicts` : `${preview.conflicts.length} 个源冲突`)}</small>
      </div>
      {preview.files.length === 0 ? null : <div className="work-items-migration-files" aria-label={locale === 'en' ? 'Legacy material references' : '旧 Workbench 资料引用'}>
        <small>{locale === 'en' ? 'Material references are preview-only; no file is copied or injected.' : '资料引用仅用于预览；当前不会复制文件或注入执行器。'}</small>
        <ul className="work-items-migration-list">
          {preview.files.map((file) => {
            const status = file.status === 'available'
              ? (locale === 'en' ? 'available' : '可读取')
              : file.status === 'missing'
                ? (locale === 'en' ? 'missing' : '缺失')
                : (locale === 'en' ? 'unsafe' : '不安全')
            return <li key={file.relativePath}>
              <span><strong>{file.relativePath}</strong><small>{status} · {file.linkedSourceKeys.length} {locale === 'en' ? 'linked item(s)' : '个关联项'}</small></span>
              {file.contentHash === undefined ? null : <code>{file.contentHash.slice(0, 12)}</code>}
            </li>
          })}
        </ul>
      </div>}
      <ul className="work-items-migration-list">
        {preview.candidates.map((candidate) => {
          const conflict = workbenchCandidateConflict(preview, candidate)
          return <li key={candidate.sourceKey} className={conflict ? 'work-items-migration-conflict' : undefined}>
            <label>
              <input type="checkbox" checked={selected.has(candidate.sourceKey)} disabled={conflict || busy !== undefined} onChange={() => toggle(candidate.sourceKey)} />
              <span><strong>{candidate.title}</strong><small>{candidate.kind} · {candidate.sourceKey}</small></span>
            </label>
            {conflict ? <em>{locale === 'en' ? 'Conflict' : '有冲突'}</em> : null}
          </li>
        })}
      </ul>
      <div className="work-items-duty-create-actions">
        <button type="button" className="work-items-button" disabled={busy !== undefined || selected.size === 0} onClick={() => { void prepare() }}>{busy === 'prepare' ? '…' : (locale === 'en' ? 'Save confirmation plan' : '保存确认计划')}</button>
        {preparation === undefined ? null : <button type="button" className="work-items-button work-items-button-quiet" disabled={busy !== undefined || !preparation.receipts.some((receipt) => receipt.status === 'ready')} onClick={() => { void applyBatch() }}>{busy === 'batch' ? '…' : (locale === 'en' ? 'Apply ready items' : '应用待执行项')}</button>}
      </div>
      {preparation === undefined ? null : <>
        <p className="work-items-migration-result" role="status">{preparation.message} {locale === 'en' ? `${preparation.receipts.filter((receipt) => receipt.status === 'ready').length} items ready.` : `${preparation.receipts.filter((receipt) => receipt.status === 'ready').length} 项已准备。`}</p>
        {report === undefined ? null : <div className="work-items-migration-report">
          <span>{locale === 'en' ? `Report: ${report.counts.applied} applied · ${report.counts.failed} failed · ${report.counts.unknown} unknown · ${report.items.filter((item) => item.targetStatus === 'missing').length} targets missing` : `报告：${report.counts.applied} 已应用 · ${report.counts.failed} 失败 · ${report.counts.unknown} 未知 · ${report.items.filter((item) => item.targetStatus === 'missing').length} 个目标缺失`}</span>
          <button type="button" className="work-items-button work-items-button-quiet" disabled={busy !== undefined} onClick={() => { void refreshReport(preparation.plan) }}>{locale === 'en' ? 'Refresh report' : '刷新报告'}</button>
        </div>}
        <ul className="work-items-migration-list">
          {preparation.receipts.map((receipt) => {
            const item = preparation.plan.items.find((candidate) => candidate.identity.identity === receipt.identity)
            const targetStatus = report?.items.find((candidate) => candidate.identity === receipt.identity)?.targetStatus
            const canRecoverMissing = receipt.status === 'applied' && targetStatus === 'missing'
            const canApply = item?.target.kind === 'work-item' && item.target.action === 'create'
              && (receipt.status === 'ready' || receipt.status === 'unknown' || canRecoverMissing)
            return <li key={`${receipt.identity}:${receipt.sourceSnapshotHash}`}>
              <span><strong>{item?.source.title ?? receipt.identity}</strong><small>{receipt.status}{receipt.targetId === undefined ? '' : ` · ${receipt.targetId}`}{targetStatus === undefined ? '' : ` · target ${targetStatus}`}</small></span>
              {canApply ? <button type="button" className="work-items-button work-items-button-quiet" disabled={busy !== undefined} onClick={() => { void apply(receipt.identity, receipt.status === 'unknown' || canRecoverMissing) }}>{canRecoverMissing ? (locale === 'en' ? 'Recover target' : '恢复缺失目标') : receipt.status === 'unknown' ? (locale === 'en' ? 'Reconcile' : '对账重试') : (locale === 'en' ? 'Apply' : '应用')}</button> : null}
            </li>
          })}
        </ul>
      </>}
    </>}
  </section>
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
  const [attention, setAttention] = useState<WorkbenchAttentionSnapshot>()
  const [notificationInbox, setNotificationInbox] = useState<NotificationInboxSnapshot>()
  const [showArchived, setShowArchived] = useState(false)
  const [projectFilter, setProjectFilter] = useState<WorkItemProjectFilterValue>(() => projectFilterFromNavigation(navigation?.returnTo?.filter))
  const [projectDirectory, setProjectDirectory] = useState<WorkItemProjectDirectoryEntry[]>([])
  const [createOptions, setCreateOptions] = useState<WorkItemCreateOptions>()
  const [loadingCreateOptions, setLoadingCreateOptions] = useState(false)
  const [employeeDirectory, setEmployeeDirectory] = useState<ReadonlyMap<string, EmployeeSnapshot>>(() => new Map())
  const [handoff, setHandoff] = useState<{ mode: 'handoff' | 'redo'; snapshot: WorkTaskSnapshot; executors: WorkItemExecutorOption[]; loadingExecutors: boolean }>()
  const [revisionTaskId, setRevisionTaskId] = useState<string>()
  const listRequestSequence = useRef(0)
  const attentionRequestSequence = useRef(0)
  const notificationInboxRequestSequence = useRef(0)
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

  const refreshAttention = useCallback(async (): Promise<void> => {
    const sequence = ++attentionRequestSequence.current
    try {
      const next = await window.EzDSH.workbench.getAttention()
      if (mounted.current && sequence === attentionRequestSequence.current) setAttention(next)
    } catch {
      // The durable Work Item list remains usable when the optional summary is unavailable.
    }
  }, [])

  const refreshNotificationInbox = useCallback(async (): Promise<void> => {
    const sequence = ++notificationInboxRequestSequence.current
    try {
      const next = await window.EzDSH.notifications.getInbox()
      if (mounted.current && sequence === notificationInboxRequestSequence.current) setNotificationInbox(next)
    } catch {
      // The work item surface remains usable when the developer-only inbox is unavailable.
    }
  }, [])

  const markNotificationRead = useCallback((id: string): void => {
    void window.EzDSH.notifications.markInboxRead(id).catch(() => undefined)
  }, [])

  const dismissNotification = useCallback((id: string): void => {
    void window.EzDSH.notifications.dismissInbox(id).catch(() => undefined)
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
      void refreshAttention()
    })
    void refresh()
    void refreshAttention()
    void refreshNotificationInbox()
    const unsubscribeNotificationInbox = window.EzDSH.notifications.onInboxChange((snapshot) => {
      if (mounted.current) setNotificationInbox(snapshot)
    })
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
      unsubscribeNotificationInbox()
    }
  }, [refresh, refreshAttention, refreshNotificationInbox])

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
      {showArchived ? null : <AttentionSummary snapshot={attention} locale={locale} onSelect={selectTask} />}
      {showArchived ? null : <NotificationInbox snapshot={notificationInbox} locale={locale} onMarkRead={markNotificationRead} onDismiss={dismissNotification} onSelectWorkItem={selectTask} />}
      {showArchived ? null : <WorkDutyPanel snapshots={[...snapshots.values()]} employees={employeeDirectory} locale={locale} />}
      {showArchived ? null : <WorkbenchMigrationPanel locale={locale} />}
      <WorkItemProjectContextPanel locale={locale} includeArchived={showArchived} />
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
