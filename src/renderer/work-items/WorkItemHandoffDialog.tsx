import { useEffect, useRef, useState } from 'react'
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
  loadingExecutors?: boolean
  locale?: 'zh' | 'en'
  onExecute: (request: WorkTaskExecuteRequest) => Promise<WorkTaskSnapshot>
  onExecuted: (snapshot: WorkTaskSnapshot) => void
  onClose: () => void
}

/** Explicitly starts a new attempt; it never appends to or cancels the previous run. */
export function WorkItemHandoffDialog({ snapshot, executors, mode, loadingExecutors = false, locale = 'zh', onExecute, onExecuted, onClose }: WorkItemHandoffDialogProps): JSX.Element {
  const english = locale === 'en'
  const [selected, setSelected] = useState('0')
  const [input, setInput] = useState('')
  const [sourceRunId, setSourceRunId] = useState(() => [...snapshot.runs].reverse().find((run) => run.runId)?.runId ?? '')
  /** Materials are opt-in for every new attempt; an empty selection is deliberate. */
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const composing = useRef(false)
  const retry = useRef<{ signature: string; request: WorkTaskExecuteRequest }>()
  const executor = executors[Number(selected)]?.executor
  const requirement = snapshot.task.requirements.find((item) => item.version === snapshot.task.currentRequirementVersion)
  const localMaterials = (snapshot.task.scope.materialRefs ?? []).filter((material): material is Extract<typeof material, { kind: 'local-file' }> => material.kind === 'local-file')
  const title = mode === 'redo' ? (english ? 'Make another version' : '再做一版') : (english ? 'Hand off this task' : '交接这项工作')

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy || event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing.current) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

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
      ...(selectedMaterialIds.length === 0 ? {} : {
        materialInputs: localMaterials
          .filter((material) => selectedMaterialIds.includes(material.materialId))
          .map((material) => ({ materialId: material.materialId })),
      }),
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

  return <div className="work-item-handoff-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="work-item-handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="work-item-handoff-title" onMouseDown={(event) => event.stopPropagation()} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
      <header className="work-item-handoff-header">
        <div>
          <p className="work-items-eyebrow">{english ? 'WORK ITEM' : '工作项'}</p>
          <h2 id="work-item-handoff-title">{title}</h2>
          <p>{english ? `Requirement v${snapshot.task.currentRequirementVersion}` : `要求 v${snapshot.task.currentRequirementVersion}`} · {requirement?.goal}</p>
        </div>
        <button type="button" className="work-items-button work-items-button-quiet" disabled={busy} onClick={onClose}>{english ? 'Close' : '关闭'}</button>
      </header>
      <div className="work-item-handoff-body">
        <p className="work-item-handoff-intro">{english ? 'This starts a new attempt on the same task. Any previous run keeps its current state.' : '在同一工作项中开始新的执行轮次。之前的运行保持当前状态。'}</p>
        {loadingExecutors ? <p className="work-item-handoff-status" role="status">{english ? 'Loading available executors…' : '正在读取可用执行器…'}</p> : <>
          <div className="work-item-handoff-fields">
            <label className="work-item-handoff-field"><span>{english ? 'Executor' : '交给谁执行'}</span>
              <select aria-label={english ? 'Executor' : '交给谁执行'} value={selected} disabled={busy} onChange={(event) => { setSelected(event.target.value); setInput('') }}>
                {executors.map((option, index) => <option key={index} value={String(index)}>{option.label}</option>)}
              </select>
            </label>
            <label className="work-item-handoff-field"><span>{english ? 'Source run' : '承接哪次运行'}</span>
              <select aria-label={english ? 'Source run' : '承接哪次运行'} value={sourceRunId} disabled={busy} onChange={(event) => setSourceRunId(event.target.value)}>
                <option value="">{english ? 'No source run' : '不引用来源运行'}</option>
                {snapshot.runs.filter((run) => run.runId).map((run) => <option key={run.runId} value={run.runId}>{run.runId} · {run.status} · v{run.requirementVersion}</option>)}
              </select>
            </label>
            <label className="work-item-handoff-field work-item-handoff-field-wide"><span>{executor?.kind === 'workflow' ? (english ? 'Workflow input (JSON)' : '流程输入（JSON）') : (english ? 'Instructions for this attempt' : '本轮执行说明')}</span>
              <textarea aria-label={english ? 'Execution input' : '执行输入'} value={input} disabled={busy} rows={5} onChange={(event) => setInput(event.target.value)} />
            </label>
          </div>
          {executor?.kind === 'workflow' ? <p className="work-item-handoff-note">{english ? 'Map the required inputs explicitly. To use an unfinished result, wait for it or specify a saved draft version. No conversation or artifact is copied automatically.' : '请明确填写流程所需的输入映射。依赖未完成的成果时，等待成果产生或明确指定已保存的草稿版本。聊天和成果不会自动复制到输入。'}</p> : null}
          {localMaterials.length === 0 ? null : <section className="work-item-handoff-materials" aria-label={english ? 'Materials for this attempt' : '本轮资料'}>
            <strong>{english ? 'Materials for this attempt (optional)' : '本轮资料（可选）'}</strong>
            <p>{english ? 'Nothing is selected by default. Only checked local files are sent as material inputs; Main authorizes them and checks their current version before execution.' : '默认不选择任何资料。只有勾选的本地文件会作为本轮资料输入发送；Main 会在执行前授权并校验当前版本。'}</p>
            <div className="work-item-handoff-material-list">
              {localMaterials.map((material) => <label className="work-item-handoff-material-option" key={material.materialId}>
                <input
                  type="checkbox"
                  checked={selectedMaterialIds.includes(material.materialId)}
                  disabled={busy}
                  onChange={() => setSelectedMaterialIds((current) => current.includes(material.materialId)
                    ? current.filter((id) => id !== material.materialId)
                    : [...current, material.materialId])}
                />
                <span><code>{material.path}</code><small>{material.materialId}</small></span>
              </label>)}
            </div>
          </section>}
          {snapshot.artifacts.length ? <div className="work-item-handoff-artifacts"><strong>{english ? 'Available artifact versions' : '可引用的成果版本'}</strong><ul aria-label={english ? 'Available artifact versions' : '可引用的成果版本'}>{snapshot.artifacts.map((artifact) => <li key={artifact.id}>{artifact.name} · {english ? 'content' : '内容'} v{artifact.contentVersion} · {english ? 'requirement' : '要求'} v{artifact.requirementVersion} · {artifact.id}</li>)}</ul></div> : null}
          <p className="work-item-handoff-note">{english ? 'Updated instructions apply to this new attempt. They are not appended to an existing run.' : '新的执行说明用于本轮执行，不会追加到已有运行。'}</p>
          {error ? <p className="work-items-error" role="alert">{error}</p> : null}
        </>}
      </div>
      <footer className="work-item-handoff-actions">
        <button type="button" className="work-items-button" disabled={busy || loadingExecutors || !executor} onClick={() => { void submit() }}>{busy ? (english ? 'Submitting…' : '正在提交…') : title}</button>
        <button type="button" className="work-items-button work-items-button-quiet" disabled={busy} onClick={onClose}>{english ? 'Cancel' : '取消'}</button>
      </footer>
    </section>
  </div>
}
