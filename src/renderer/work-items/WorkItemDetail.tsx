import { useEffect, useRef, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { EmployeeSnapshot } from '../../shared/employees.js'
import type {
  WorkActionAnswerRequest,
  WorkRunControlRequest,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'
import {
  actionState,
  artifactVersionLabel,
  attemptReasonLabel,
  chronological,
  currentRequirement,
  executorLabel,
  newestFirst,
} from './work-item-view-model.js'
import { WorkItemDeliverables } from './WorkItemDeliverables.js'
import { WorkItemActionPanel } from './WorkItemActionPanel.js'
import { WorkItemScopePanel } from './WorkItemScopePanel.js'
import type { WorkArtifact, WorkArtifactAcceptRequest } from '../../shared/work-items.js'

interface WorkItemDetailProps {
  copy: AppCopy
  snapshot: WorkTaskSnapshot
  onClose: () => void
  onAcceptArtifact?: (request: WorkArtifactAcceptRequest) => Promise<WorkTaskSnapshot>
  onAccepted?: (snapshot: WorkTaskSnapshot) => void
  onOpenArtifact?: (artifact: WorkArtifact) => void
  onStartHandoff?: (mode: 'handoff' | 'redo') => void
  onStartRevision?: () => void
  onOpenExecutor?: (runId?: string) => void
  onAnswerAction?: (request: WorkActionAnswerRequest) => Promise<WorkTaskSnapshot>
  onControlRun?: (request: WorkRunControlRequest) => Promise<WorkTaskSnapshot>
  onChanged?: (snapshot: WorkTaskSnapshot) => void
  onArchive?: (archived: boolean) => Promise<void>
  onCancelTask?: () => Promise<WorkTaskSnapshot>
  employeeDirectory?: ReadonlyMap<string, Pick<EmployeeSnapshot, 'name' | 'displayName' | 'role'>>
  project?: { projectId: string; title: string; path?: string }
  locale?: 'zh' | 'en'
}

function dateLabel(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function requirementLabel(copy: AppCopy, version: number): string {
  return copy.workItemsRequirementVersion(version)
}

function errorCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined
}

/** Durable task detail. Closing it only changes the selected task. */
export function WorkItemDetail({
  copy,
  snapshot,
  onClose,
  onAcceptArtifact,
  onAccepted,
  onOpenArtifact,
  onStartHandoff,
  onStartRevision,
  onOpenExecutor,
  onAnswerAction,
  onControlRun,
  onChanged,
  onArchive,
  onCancelTask,
  employeeDirectory,
  project,
  locale = 'zh',
}: WorkItemDetailProps): JSX.Element {
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const cancelInFlight = useRef(false)
  const confirmationRevision = useRef<number>()
  const requirement = currentRequirement(snapshot)
  const historicalRequirements = chronological(snapshot.task.requirements)
  const attempts = chronological(snapshot.attempts)
  const runs = newestFirst(snapshot.runs)
  const artifacts = chronological(snapshot.artifacts)
  const actions = snapshot.actions
  const actionable = onAnswerAction !== undefined && onControlRun !== undefined && onChanged !== undefined && onOpenExecutor !== undefined
  const cancellation = snapshot.task.cancellation
  const cancellationState = cancellation?.state ?? (snapshot.task.status === 'cancelled' ? 'cancelled' : undefined)
  const unknownCancellationTargets = cancellation?.targets.filter((target) => target.state === 'outcome-unknown') ?? []
  const cancellationLocked = cancellationState !== undefined || confirmCancel || cancelBusy
  const canStartCancellation = onCancelTask !== undefined
    && cancellation === undefined
    && snapshot.task.status !== 'completed'
    && snapshot.task.status !== 'cancelled'
    && snapshot.task.archivedAt === undefined

  useEffect(() => {
    if (!confirmCancel || confirmationRevision.current === snapshot.task.revision) return
    confirmationRevision.current = undefined
    setConfirmCancel(false)
    setCancelError(locale === 'en'
      ? 'The work item changed. Review it and confirm cancellation again.'
      : '工作项已更新，请重新确认取消。')
  }, [confirmCancel, locale, snapshot.task.revision])

  async function submitCancellation(): Promise<void> {
    if (onCancelTask === undefined || cancelInFlight.current) return
    cancelInFlight.current = true
    setCancelBusy(true)
    setCancelError('')
    try {
      await onCancelTask()
      confirmationRevision.current = undefined
      setConfirmCancel(false)
    } catch (cause) {
      if (errorCode(cause) === 'REVISION_CONFLICT') {
        confirmationRevision.current = undefined
        setConfirmCancel(false)
        setCancelError(locale === 'en'
          ? 'The work item changed. Review it and confirm cancellation again.'
          : '工作项已更新，请重新确认取消。')
      } else {
        setCancelError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      cancelInFlight.current = false
      setCancelBusy(false)
    }
  }

  function beginCancellation(): void {
    if (!canStartCancellation || cancelBusy) return
    if (!confirmCancel) {
      confirmationRevision.current = snapshot.task.revision
      setCancelError('')
      setConfirmCancel(true)
      return
    }
    void submitCancellation()
  }

  async function changeArchiveState(): Promise<void> {
    if (onArchive === undefined || archiveBusy) return
    if (snapshot.task.archivedAt === undefined && !confirmArchive) {
      setConfirmArchive(true)
      return
    }
    setArchiveBusy(true)
    try {
      await onArchive(snapshot.task.archivedAt === undefined)
      setConfirmArchive(false)
    } finally {
      setArchiveBusy(false)
    }
  }

  return (
    <section className="work-item-detail" aria-label={copy.workItemsDetails} data-work-item-detail={snapshot.task.id}>
      <header className="work-item-detail-header">
        <div>
          <p className="work-items-eyebrow">{copy.workItemsDetails}</p>
          <h2>{snapshot.task.title}</h2>
          <p>{copy.workItemsUpdatedAt(dateLabel(snapshot.task.updatedAt))}</p>
        </div>
        <div className="work-item-detail-header-actions">
          {onStartRevision && !cancellationLocked && snapshot.task.status !== 'cancelled' && snapshot.task.archivedAt === undefined
            ? <button type="button" className="work-items-button work-items-button-quiet" onClick={onStartRevision}>{locale === 'en' ? 'Revise requirement' : '修改要求'}</button>
            : null}
          {onStartHandoff && !cancellationLocked ? <>
            <button type="button" className="work-items-button work-items-button-quiet" onClick={() => { onStartHandoff('redo') }}>{copy.workItemsRedo}</button>
            <button type="button" className="work-items-button" onClick={() => { onStartHandoff('handoff') }}>{copy.workItemsHandoff}</button>
          </> : null}
          {onOpenExecutor ? <button type="button" className="work-items-button work-items-button-quiet" onClick={() => onOpenExecutor()}>{locale === 'en' ? 'Open executor' : '打开执行器'}</button> : null}
          {canStartCancellation ? <button
            type="button"
            className="work-items-button work-items-button-cancel"
            disabled={cancelBusy}
            onClick={beginCancellation}
          >{cancelBusy
            ? (locale === 'en' ? 'Requesting cancellation…' : '正在提交取消…')
            : confirmCancel
              ? (locale === 'en' ? 'Confirm cancel work item' : '确认取消工作项')
              : (locale === 'en' ? 'Cancel work item' : '取消工作项')}</button> : null}
          {onArchive && !cancellationLocked ? <button
            type="button"
            className="work-items-button work-items-button-quiet"
            disabled={archiveBusy}
            onBlur={() => setConfirmArchive(false)}
            onClick={() => { void changeArchiveState() }}
          >{archiveBusy
            ? (locale === 'en' ? 'Saving…' : '正在保存…')
            : snapshot.task.archivedAt !== undefined
              ? (locale === 'en' ? 'Restore' : '恢复')
              : confirmArchive
                ? (locale === 'en' ? 'Confirm archive' : '确认归档')
                : (locale === 'en' ? 'Archive' : '归档')}</button> : null}
          <button type="button" className="work-items-button work-items-button-quiet" onClick={onClose}>
            {copy.workItemsCloseDetails}
          </button>
        </div>
      </header>

      <div className="work-item-detail-content">
        {cancellationState === undefined ? null : <section className={`work-item-cancellation-panel work-item-cancellation-${cancellationState}`} role="status">
          <div>
            <h3>{cancellationState === 'outcome-unknown'
              ? (locale === 'en' ? 'Cancellation outcome is not confirmed' : '取消结果尚未确认')
              : cancellationState === 'cancelled'
                ? (locale === 'en' ? 'Work item cancelled' : '工作项已取消')
                : (locale === 'en' ? 'Cancelling work item' : '正在取消工作项')}</h3>
            <p>{cancellationState === 'outcome-unknown'
              ? (locale === 'en' ? 'The last response was uncertain. History and deliverables are retained; recheck the durable executor state with the same request identity.' : '上次请求的结果尚不确定。历史和成果会保留；可使用同一请求标识重新核对执行器的持久状态。')
              : cancellationState === 'cancelled'
                ? (locale === 'en' ? 'All executions reached a verified final state. Some may have completed or failed before cancellation. Saved history and deliverables remain available.' : '所有执行都已进入可核实的最终状态；部分执行可能在取消前已经完成或失败。已有历史和成果仍然保留。')
                : (locale === 'en' ? 'Waiting for executors to confirm the stop. History and deliverables are retained.' : '正在等待执行器确认停止。已有历史和成果会保留。')}</p>
            {unknownCancellationTargets.length > 0 ? <ul className="work-item-cancellation-targets">
              {unknownCancellationTargets.map((target) => <li key={target.commandId}>
                <strong>{executorLabel(copy, target.executor, employeeDirectory)}</strong>
                <span>{target.error ?? (locale === 'en' ? 'No verified result is available.' : '暂无可核实的结果。')}</span>
              </li>)}
            </ul> : null}
          </div>
          {cancellationState === 'outcome-unknown' && onCancelTask !== undefined ? <button
            type="button"
            className="work-items-button work-items-button-quiet"
            disabled={cancelBusy}
            onClick={() => { void submitCancellation() }}
          >{cancelBusy ? (locale === 'en' ? 'Rechecking…' : '正在重新核对…') : (locale === 'en' ? 'Recheck cancellation status' : '重新核对取消状态')}</button> : null}
        </section>}
        {confirmCancel ? <section className="work-item-cancellation-panel work-item-cancellation-confirm" role="status">
          <div>
            <h3>{locale === 'en' ? 'Cancel this work item?' : '确认取消这个工作项？'}</h3>
            <p>{locale === 'en'
              ? 'Saved history and deliverables will be retained. The work item is only cancelled after every related execution reaches a verified final state.'
              : '已有历史和成果会保留。只有全部相关执行都进入可核实的最终状态后，工作项才算取消。'}</p>
          </div>
          <button type="button" className="work-items-button work-items-button-quiet" disabled={cancelBusy} onClick={() => {
            confirmationRevision.current = undefined
            setConfirmCancel(false)
            setCancelError('')
          }}>{locale === 'en' ? 'Keep work item' : '保留工作项'}</button>
        </section> : null}
        {cancelError ? <p className="work-item-cancellation-error" role="alert">{cancelError}</p> : null}
        {actionable && !cancellationLocked ? <section className="work-item-detail-section">
          <WorkItemActionPanel
            snapshot={snapshot}
            onAnswer={onAnswerAction}
            onControl={onControlRun}
            onChanged={onChanged}
            onOpenExecutor={(runId) => onOpenExecutor(runId)}
            locale={locale}
          />
        </section> : null}
        <WorkItemScopePanel scope={snapshot.task.scope} project={project} locale={locale} />
        <section className="work-item-detail-section">
          <div className="work-item-detail-section-heading">
            <h3>{copy.workItemsCurrentRequirement}</h3>
            {requirement === undefined ? null : <span>{requirementLabel(copy, requirement.version)}</span>}
          </div>
          {requirement === undefined ? <p className="work-items-muted">{copy.workItemsNotAvailable}</p> : (
            <dl className="work-item-requirement">
              <div><dt>{copy.workItemsGoal}</dt><dd>{requirement.goal}</dd></div>
              <div><dt>{copy.workItemsAcceptance}</dt><dd>{requirement.acceptance}</dd></div>
            </dl>
          )}
        </section>

        <section className="work-item-detail-section">
          <div className="work-item-detail-section-heading"><h3>{copy.workItemsRequirementsHistory}</h3></div>
          {historicalRequirements.length === 0 ? <p className="work-items-muted">{copy.workItemsNotAvailable}</p> : (
            <ol className="work-item-history-list">
              {historicalRequirements.map((item) => <li key={item.version} className={item.version === snapshot.task.currentRequirementVersion ? 'work-item-history-current' : ''}>
                <strong>{requirementLabel(copy, item.version)}</strong><span>{item.goal}</span><small>{dateLabel(item.createdAt)}</small>
              </li>)}
            </ol>
          )}
        </section>

        <section className="work-item-detail-section">
          <div className="work-item-detail-section-heading"><h3>{copy.workItemsAttempts}</h3></div>
          {attempts.length === 0 ? <p className="work-items-muted">{copy.workItemsNoAttempts}</p> : (
            <ol className="work-item-history-list">
              {attempts.map((attempt) => <li key={attempt.id}><strong>{executorLabel(copy, attempt.responsibility, employeeDirectory)}</strong><span>{attemptReasonLabel(copy, attempt.reason)} · {requirementLabel(copy, attempt.requirementVersion)}</span><small>{dateLabel(attempt.createdAt)}</small></li>)}
            </ol>
          )}
        </section>

        <section className="work-item-detail-section">
          <div className="work-item-detail-section-heading"><h3>{copy.workItemsRuns}</h3></div>
          {runs.length === 0 ? <p className="work-items-muted">{copy.workItemsNoRuns}</p> : (
            <ol className="work-item-history-list">
              {runs.map((run) => <li key={run.runId} className={run.status === 'failed' ? 'work-item-history-failed' : undefined}><strong>{executorLabel(copy, run.executor, employeeDirectory)}</strong><span>{copy.workItemsRunStatus(run.status)} · {run.rawStatus} · {requirementLabel(copy, run.requirementVersion)}</span><small>{dateLabel(run.observedAt)}</small></li>)}
            </ol>
          )}
        </section>

        <section className="work-item-detail-section">
          <div className="work-item-detail-section-heading"><h3>{copy.workItemsArtifacts}</h3></div>
          {artifacts.length === 0 ? <p className="work-items-muted">{copy.workItemsNoArtifacts}</p> : (
            <ol className="work-item-history-list">
              {artifacts.map((artifact) => <li key={artifact.id}><strong>{artifact.name}</strong><span>{artifactVersionLabel(copy, artifact)} · {artifact.kind}</span><small>{dateLabel(artifact.createdAt)}</small></li>)}
            </ol>
          )}
        </section>

        <section className="work-item-detail-section">
          <div className="work-item-detail-section-heading"><h3>{copy.workItemsActions}</h3><span>{actionable ? (locale === 'en' ? 'History' : '历史记录') : copy.workItemsReadOnly}</span></div>
          {actions.length === 0 ? <p className="work-items-muted">{copy.workItemsNoActions}</p> : (
            <ol className="work-item-history-list">
              {actions.map((action) => <li key={action.id}><strong>{copy.workItemsActionKind(action.kind)}</strong><span>{copy.workItemsActionState(actionState(action))} · {requirementLabel(copy, action.requirementVersion)}</span><small>{action.sourceEventId}</small></li>)}
            </ol>
          )}
        </section>

        {cancellationLocked ? <section className="work-item-detail-section" aria-label={locale === 'en' ? 'Deliverables' : '交付成果'}>
          <h3>{locale === 'en' ? 'Deliverables' : '交付成果'}</h3>
          {snapshot.artifacts.length === 0 ? <p>{locale === 'en' ? 'No saved deliverables yet.' : '尚无已保存的交付成果。'}</p> : <ul className="work-item-history-list">
            {snapshot.artifacts.map((artifact) => <li key={artifact.id}>
              <strong>{artifact.name}</strong>
              <span>{locale === 'en' ? 'Content' : '内容'} v{artifact.contentVersion} · {locale === 'en' ? 'Requirement' : '要求'} v{artifact.requirementVersion}</span>
              {onOpenArtifact ? <button type="button" className="work-items-button work-items-button-quiet" onClick={() => onOpenArtifact(artifact)}>{locale === 'en' ? 'View this version' : '查看这一版'}</button> : null}
            </li>)}
          </ul>}
        </section> : onAcceptArtifact && onAccepted ? <WorkItemDeliverables snapshot={snapshot} locale={locale} onAcceptArtifact={onAcceptArtifact} onAccepted={onAccepted} onOpenArtifact={onOpenArtifact} /> : null}
      </div>
    </section>
  )
}
