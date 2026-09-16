import { useRef, useState } from 'react'
import type {
  WorkAction,
  WorkActionAnswerRequest,
  WorkRunControlRequest,
  WorkRunRef,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'
import './work-item-attention.css'

export interface WorkItemActionPanelProps {
  snapshot: WorkTaskSnapshot
  onAnswer: (request: WorkActionAnswerRequest) => Promise<WorkTaskSnapshot>
  onControl: (request: WorkRunControlRequest) => Promise<WorkTaskSnapshot>
  onChanged: (snapshot: WorkTaskSnapshot) => void
  onOpenExecutor: (runId: string) => void
  locale?: 'zh' | 'en'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function actionKindLabel(kind: WorkAction['kind'], english: boolean): string {
  if (english) return kind
  if (kind === 'approval') return '审批'
  if (kind === 'question') return '问题'
  return '恢复'
}

function runStatusLabel(status: WorkRunRef['status'], english: boolean): string {
  if (english) return status
  const labels: Record<WorkRunRef['status'], string> = {
    queued: '排队中', running: '运行中', waiting: '等待中', paused: '已暂停', cancelling: '取消中',
    completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  }
  return labels[status]
}

/**
 * Sends durable action/control requests through injected callbacks. It never
 * projects a terminal state locally: only the returned snapshot is published.
 */
export function WorkItemActionPanel({
  snapshot,
  onAnswer,
  onControl,
  onChanged,
  onOpenExecutor,
  locale = 'zh',
}: WorkItemActionPanelProps): JSX.Element {
  const english = locale === 'en'
  const [busyKey, setBusyKey] = useState<string>()
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const controlRetries = useRef(new Map<string, WorkRunControlRequest>())
  const openActions = snapshot.actions.filter((action) => action.status === 'open')

  async function perform(key: string, operation: () => Promise<WorkTaskSnapshot>): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setBusyKey(key)
    setError('')
    try {
      onChanged(await operation())
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      inFlight.current = false
      setBusyKey(undefined)
    }
  }

  function answer(action: WorkAction, value: boolean): void {
    const request: WorkActionAnswerRequest = {
      requestId: crypto.randomUUID(),
      taskId: snapshot.task.id,
      actionId: action.id,
      expectedSourceEventId: action.sourceEventId,
      expectedRequirementVersion: action.requirementVersion,
      answer: value,
    }
    void perform(`action:${action.id}`, () => onAnswer(request))
  }

  function control(run: WorkRunRef, action: WorkRunControlRequest['action'], key: string): void {
    const signature = JSON.stringify({
      taskId: snapshot.task.id,
      runId: run.runId,
      expectedRevision: snapshot.task.revision,
      action,
    })
    const request = controlRetries.current.get(signature) ?? {
      requestId: crypto.randomUUID(),
      taskId: snapshot.task.id,
      runId: run.runId,
      expectedRevision: snapshot.task.revision,
      action,
    }
    controlRetries.current.set(signature, request)
    void perform(key, () => onControl(request))
  }

  function actionContents(action: WorkAction): JSX.Element {
    const run = snapshot.runs.find((candidate) => candidate.runId === action.runId)
    if (action.kind === 'approval') {
      return <>
        <p>{english ? 'This workflow is waiting for an explicit approval decision.' : '此流程正在等待批准，请明确选择同意或拒绝。'}</p>
        <div className="work-item-action-buttons">
          <button
            type="button"
            className="work-items-button"
            aria-label={english ? `Approve approval ${action.id}` : `同意审批 ${action.id}`}
            disabled={busyKey !== undefined}
            onClick={() => answer(action, true)}
          >{english ? 'Approve' : '同意'}</button>
          <button
            type="button"
            className="work-items-button work-items-button-quiet"
            aria-label={english ? `Reject approval ${action.id}` : `拒绝审批 ${action.id}`}
            disabled={busyKey !== undefined}
            onClick={() => answer(action, false)}
          >{english ? 'Reject' : '拒绝'}</button>
        </div>
      </>
    }

    if (action.kind === 'recovery') {
      return <>
        <p>{run?.capabilities.resume
          ? (english ? 'The linked run declares durable resume capability.' : '对应运行已声明可恢复能力。')
          : (english ? 'The linked run has not declared resume capability.' : '对应运行未声明可恢复能力。')}</p>
        <div className="work-item-action-buttons">
          {run?.capabilities.resume ? <button
            type="button"
            className="work-items-button"
            aria-label={english ? `Resume recovery ${action.id}` : `恢复待处理项 ${action.id}`}
            disabled={busyKey !== undefined}
            onClick={() => control(run, 'resume', `action:${action.id}`)}
          >{english ? 'Resume' : '恢复'}</button> : null}
          {run ? <button
            type="button"
            className="work-items-button work-items-button-quiet"
            aria-label={english ? `Open executor for ${action.id}` : `打开执行器 ${action.id}`}
            onClick={() => onOpenExecutor(run.runId)}
          >{english ? 'Open executor' : '打开执行器'}</button> : null}
        </div>
      </>
    }

    return <>
      <p>{english
        ? 'This action does not include question text or an answer protocol. Open the executor to inspect and handle it.'
        : '此待处理项没有问题正文或回答协议。请打开执行器查看并处理。'}</p>
      {run ? <button
        type="button"
        className="work-items-button work-items-button-quiet"
        aria-label={english ? `Open executor for ${action.id}` : `打开执行器 ${action.id}`}
        onClick={() => onOpenExecutor(run.runId)}
      >{english ? 'Open executor' : '打开执行器'}</button> : null}
    </>
  }

  return <section className="work-item-action-panel" aria-label={english ? 'Task actions and run controls' : '任务操作与运行控制'}>
    <section className="work-item-action-section">
      <h3>{english ? 'Needs action' : '需要处理'}</h3>
      {openActions.length === 0 ? <p className="work-item-attention-empty">{english ? 'No open actions.' : '没有待处理事项。'}</p> : <ul className="work-item-action-list">
        {openActions.map((action) => <li key={action.id} data-action-id={action.id}>
          <header><strong>{actionKindLabel(action.kind, english)}</strong><code>{action.id}</code></header>
          {actionContents(action)}
        </li>)}
      </ul>}
    </section>

    <section className="work-item-action-section">
      <h3>{english ? 'Run controls' : '运行控制'}</h3>
      {snapshot.runs.length === 0 ? <p className="work-item-attention-empty">{english ? 'No runs.' : '没有运行记录。'}</p> : <ul className="work-item-run-control-list">
        {snapshot.runs.map((run) => <li key={run.runId || run.commandId} data-run-id={run.runId}>
          <div><strong>{run.runId || run.commandId}</strong><span>{runStatusLabel(run.status, english)} · {run.rawStatus}</span></div>
          <div className="work-item-action-buttons">
            {run.capabilities.cancel ? <button
              type="button"
              className="work-items-button work-items-button-quiet"
              aria-label={english ? `Cancel run ${run.runId}` : `取消运行 ${run.runId}`}
              disabled={busyKey !== undefined}
              onClick={() => control(run, 'cancel', `run:${run.runId}:cancel`)}
            >{english ? 'Cancel' : '取消'}</button> : null}
            {run.capabilities.resume ? <button
              type="button"
              className="work-items-button"
              aria-label={english ? `Resume run ${run.runId}` : `恢复运行 ${run.runId}`}
              disabled={busyKey !== undefined}
              onClick={() => control(run, 'resume', `run:${run.runId}:resume`)}
            >{english ? 'Resume' : '恢复'}</button> : null}
          </div>
        </li>)}
      </ul>}
    </section>

    {error ? <p className="work-item-action-error" role="alert">{error}</p> : null}
  </section>
}
