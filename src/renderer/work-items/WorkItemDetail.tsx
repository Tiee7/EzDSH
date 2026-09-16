import { useState } from 'react'
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
  onOpenExecutor?: (runId?: string) => void
  onAnswerAction?: (request: WorkActionAnswerRequest) => Promise<WorkTaskSnapshot>
  onControlRun?: (request: WorkRunControlRequest) => Promise<WorkTaskSnapshot>
  onChanged?: (snapshot: WorkTaskSnapshot) => void
  onArchive?: (archived: boolean) => Promise<void>
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

/** Durable task detail. Closing it only changes the selected task. */
export function WorkItemDetail({
  copy,
  snapshot,
  onClose,
  onAcceptArtifact,
  onAccepted,
  onOpenArtifact,
  onStartHandoff,
  onOpenExecutor,
  onAnswerAction,
  onControlRun,
  onChanged,
  onArchive,
  employeeDirectory,
  project,
  locale = 'zh',
}: WorkItemDetailProps): JSX.Element {
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const requirement = currentRequirement(snapshot)
  const historicalRequirements = chronological(snapshot.task.requirements)
  const attempts = chronological(snapshot.attempts)
  const runs = newestFirst(snapshot.runs)
  const artifacts = chronological(snapshot.artifacts)
  const actions = snapshot.actions
  const actionable = onAnswerAction !== undefined && onControlRun !== undefined && onChanged !== undefined && onOpenExecutor !== undefined

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
          {onStartHandoff ? <>
            <button type="button" className="work-items-button work-items-button-quiet" onClick={() => { onStartHandoff('redo') }}>{copy.workItemsRedo}</button>
            <button type="button" className="work-items-button" onClick={() => { onStartHandoff('handoff') }}>{copy.workItemsHandoff}</button>
          </> : null}
          {onOpenExecutor ? <button type="button" className="work-items-button work-items-button-quiet" onClick={() => onOpenExecutor()}>{locale === 'en' ? 'Open executor' : '打开执行器'}</button> : null}
          {onArchive ? <button
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
        {actionable ? <section className="work-item-detail-section">
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

        {onAcceptArtifact && onAccepted ? <WorkItemDeliverables snapshot={snapshot} locale={locale} onAcceptArtifact={onAcceptArtifact} onAccepted={onAccepted} onOpenArtifact={onOpenArtifact} /> : null}
      </div>
    </section>
  )
}
