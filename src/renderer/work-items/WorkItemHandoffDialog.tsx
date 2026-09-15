import { useRef, useState } from 'react'
import type { WorkExecutor, WorkTaskExecuteRequest, WorkTaskSnapshot } from '../../shared/work-items.js'
import { isWorkflowValue } from '../../shared/workflow.js'

export interface WorkItemExecutorOption {
  label: string
  executor: WorkExecutor
}

export interface WorkItemHandoffDialogProps {
  snapshot: WorkTaskSnapshot
  executors: WorkItemExecutorOption[]
  mode: 'handoff' | 'redo'
  locale?: 'zh' | 'en'
  onExecute: (request: WorkTaskExecuteRequest) => Promise<WorkTaskSnapshot>
  onExecuted: (snapshot: WorkTaskSnapshot) => void
  onClose: () => void
}

/** Explicitly starts a new attempt; it never appends to or cancels the previous run. */
export function WorkItemHandoffDialog({ snapshot, executors, mode, locale = 'zh', onExecute, onExecuted, onClose }: WorkItemHandoffDialogProps): JSX.Element {
  const english = locale === 'en'
  const [selected, setSelected] = useState('0')
  const [input, setInput] = useState('')
  const [sourceRunId, setSourceRunId] = useState(() => [...snapshot.runs].reverse().find((run) => run.runId)?.runId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const retry = useRef<{ signature: string; request: WorkTaskExecuteRequest }>()
  const executor = executors[Number(selected)]?.executor
  const requirement = snapshot.task.requirements.find((item) => item.version === snapshot.task.currentRequirementVersion)
  const title = mode === 'redo' ? (english ? 'Make another version' : '再做一版') : (english ? 'Hand off this task' : '交接这项工作')

  async function submit(): Promise<void> {
    if (inFlight.current || !executor) return
    let parsed: unknown = input.trim()
    if (executor.kind === 'workflow') {
      try { parsed = input.trim() ? JSON.parse(input) : null }
      catch { setError(english ? 'Enter valid JSON for workflow input.' : '请填写有效的流程输入 JSON。'); return }
      if (!isWorkflowValue(parsed)) {
        setError(english ? 'Workflow input must be a finite JSON-safe value.' : '流程输入必须是有限且安全的 JSON 值。')
        return
      }
    }
    const payload = {
      taskId: snapshot.task.id,
      expectedRevision: snapshot.task.revision,
      executor,
      mode,
      input: parsed,
      ...(sourceRunId ? { sourceRunId } : {}),
    }
    const signature = JSON.stringify(payload)
    const request = retry.current?.signature === signature ? retry.current.request : { ...payload, requestId: crypto.randomUUID() }
    retry.current = { signature, request }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const updated = await onExecute(request)
      onExecuted(updated)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { inFlight.current = false; setBusy(false) }
  }

  return <section className="work-item-detail-section" role="dialog" aria-modal="false" aria-label={title}>
    <h3>{title}</h3>
    <p>{english ? `Requirement v${snapshot.task.currentRequirementVersion}` : `要求 v${snapshot.task.currentRequirementVersion}`} · {requirement?.goal}</p>
    <p>{english ? 'This starts a new attempt on the same task. Any previous run keeps its current state.' : '在同一工作项中开始新的执行轮次。之前的运行保持当前状态。'}</p>
    <label>{english ? 'Executor' : '交给谁执行'}
      <select aria-label={english ? 'Executor' : '交给谁执行'} value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value); setInput('') }}>
        {executors.map((option, index) => <option key={index} value={String(index)}>{option.label}</option>)}
      </select>
    </label>
    <label>{english ? 'Source run' : '承接哪次运行'}
      <select aria-label={english ? 'Source run' : '承接哪次运行'} value={sourceRunId} disabled={busy} onChange={(event) => setSourceRunId(event.target.value)}>
        <option value="">{english ? 'No source run' : '不引用来源运行'}</option>
        {snapshot.runs.filter((run) => run.runId).map((run) => <option key={run.runId} value={run.runId}>{run.runId} · {run.status} · v{run.requirementVersion}</option>)}
      </select>
    </label>
    <label>{executor?.kind === 'workflow' ? (english ? 'Workflow input (JSON)' : '流程输入（JSON）') : (english ? 'Instructions for this attempt' : '本轮执行说明')}
      <textarea aria-label={english ? 'Execution input' : '执行输入'} value={input} disabled={busy} rows={5} onChange={(event) => setInput(event.target.value)} />
    </label>
    {executor?.kind === 'workflow' ? <p>{english ? 'Map the required inputs explicitly. To use an unfinished result, wait for it or specify a saved draft version. No conversation or artifact is copied automatically.' : '请明确填写流程所需的输入映射。依赖未完成的成果时，等待成果产生或明确指定已保存的草稿版本。聊天和成果不会自动复制到输入。'}</p> : null}
    {snapshot.artifacts.length ? <ul aria-label={english ? 'Available artifact versions' : '可引用的成果版本'}>{snapshot.artifacts.map((artifact) => <li key={artifact.id}>{artifact.name} · {english ? 'content' : '内容'} v{artifact.contentVersion} · {english ? 'requirement' : '要求'} v{artifact.requirementVersion} · {artifact.id}</li>)}</ul> : null}
    <p>{english ? 'Updated instructions apply to this new attempt. They are not appended to an existing run.' : '新的执行说明用于本轮执行，不会追加到已有运行。'}</p>
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" className="work-items-button" disabled={busy || !executor} onClick={() => { void submit() }}>{busy ? (english ? 'Submitting…' : '正在提交…') : title}</button>
    <button type="button" className="work-items-button work-items-button-quiet" disabled={busy} onClick={onClose}>{english ? 'Close' : '关闭'}</button>
  </section>
}
