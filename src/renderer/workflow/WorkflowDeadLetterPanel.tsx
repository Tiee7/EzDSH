import { useEffect, useRef, useState } from 'react'
import type { EzDSHBridge } from '../../shared/contracts.js'
import type { AppLocale } from '../../shared/locale.js'
import type { WorkflowDeadLetterPage, WorkflowRecoveryPreview, WorkflowRecoveryExecuteRequest, WorkflowRecoveryResult } from '../../shared/workflow-dead-letter.js'
import { failureCategoryLabel, recoveryDecisionLabel, recoveryOutcomeLabel, recoveryReasonLabel, runStateLabel } from './workflow-evidence-labels.js'

interface Props { workflowId?: string; environmentId?: string; locale?: AppLocale; active?: boolean }

/** A target change unmounts the entire request/selection state, including pending responses. */
export function WorkflowDeadLetterPanel(props: Props): JSX.Element {
  return <WorkflowDeadLetterTarget key={JSON.stringify([props.workflowId, props.environmentId, props.active])} {...props} />
}

function WorkflowDeadLetterTarget({ workflowId, environmentId, locale = 'zh', active = true }: Props): JSX.Element {
  const en = locale === 'en'
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<WorkflowDeadLetterPage>()
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<WorkflowRecoveryPreview[]>()
  const [request, setRequest] = useState<WorkflowRecoveryExecuteRequest>()
  const [results, setResults] = useState<WorkflowRecoveryResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const mounted = useRef(true)
  const sequence = useRef(0)
  const busyRef = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; sequence.current++ }
  }, [])
  const bridge = (): EzDSHBridge['workflows'] => {
    const api = (globalThis as typeof globalThis & { EzDSH?: EzDSHBridge }).EzDSH?.workflows
    if (api === undefined) throw new Error('Unavailable')
    return api
  }
  const begin = (): number => { busyRef.current = true; setBusy(true); setError(false); return ++sequence.current }
  const owns = (id: number): boolean => mounted.current && sequence.current === id
  const finish = (id: number): void => { if (owns(id)) { busyRef.current = false; setBusy(false) } }
  const resetSelection = (): void => { setSelected([]); setPreview(undefined); setRequest(undefined); setResults([]) }
  const load = async (offset = 0): Promise<void> => {
    if (busyRef.current || !active) return
    const id = begin()
    resetSelection()
    try {
      const next = await bridge().listDeadLetters({ ...(workflowId === undefined ? {} : { workflowId }), ...(environmentId === undefined ? {} : { environmentId }), offset, limit: 50 })
      if (owns(id)) setPage(next)
    } catch { if (owns(id)) { setPage(undefined); setError(true) } }
    finally { finish(id) }
  }
  const select = (runId: string, checked: boolean): void => {
    if (busyRef.current) return
    setSelected((current) => checked ? current.includes(runId) || current.length >= 20 ? current : [...current, runId] : current.filter((id) => id !== runId))
    setPreview(undefined); setRequest(undefined); setResults([])
  }
  const previewSelected = async (): Promise<void> => {
    if (busyRef.current || selected.length === 0 || selected.length > 20) return
    const id = begin()
    setPreview(undefined); setRequest(undefined); setResults([])
    try {
      const next = await bridge().previewRecovery({ runIds: [...selected] })
      if (next.length !== selected.length || new Set(next.map((item) => item.runId)).size !== selected.length || next.some((item) => !selected.includes(item.runId))) throw new Error('Target mismatch')
      if (owns(id)) {
        setPreview(next)
        const items = next.filter((item) => item.decision === 'eligible').map(({ runId, expectedStateToken }) => ({ runId, expectedStateToken }))
        if (items.length > 0) setRequest({ requestId: globalThis.crypto.randomUUID(), items })
      }
    } catch { if (owns(id)) setError(true) }
    finally { finish(id) }
  }
  const execute = async (): Promise<void> => {
    if (busyRef.current || request === undefined || request.items.length === 0) return
    const id = begin()
    try {
      const next = await bridge().executeRecovery(request)
      if (owns(id)) setResults(next)
      // Keep the same request after both success and response loss. Retrying
      // cannot silently manufacture another admission for a later failure.
    } catch { if (owns(id)) setError(true) }
    finally { finish(id) }
  }
  const resultText = (result: WorkflowRecoveryResult): string => {
    const outcome = recoveryOutcomeLabel(result.status, locale)
    if (result.status === 'queued' || result.status === 'already-accepted') return outcome
    return `${outcome}: ${recoveryReasonLabel(result.reason, locale)}`
  }
  return <section className="workflow-panel-card workflow-dead-letter-panel">
    <button type="button" data-dlq-action="toggle" aria-expanded={open} disabled={!active || busy} onClick={() => { setOpen(!open); if (!open) void load() }}>{en ? 'Dead-letter runs' : '异常运行与恢复'}</button>
    {open ? <>
      <p className="workflow-muted">{en ? 'Select up to 20 runs, preview safety, then explicitly queue eligible runs. Existing checkpoints and release identities are preserved.' : '选择最多 20 项，先预览恢复条件，再将符合条件的运行排队。保留原运行的检查点与固定版本。'}</p>
      <div className="workflow-dead-letter-actions">
        <button type="button" data-dlq-action="refresh" disabled={busy} onClick={() => void load(page?.offset ?? 0)}>{en ? 'Refresh' : '刷新'}</button>
        <button type="button" data-dlq-action="preview" disabled={busy || selected.length === 0} onClick={() => void previewSelected()}>{en ? 'Preview selected' : '预览所选'} ({selected.length}/20)</button>
        <button type="button" data-dlq-action="execute" disabled={busy || request === undefined} onClick={() => void execute()}>{en ? 'Queue eligible runs' : '将符合条件的运行排队'} ({request?.items.length ?? 0})</button>
      </div>
      {error ? <p role="alert">{en ? 'Unable to complete the request. Retry or refresh the run state.' : '请求未完成，请重试或刷新运行状态。'}</p> : null}
      {busy ? <p role="status">{en ? 'Working…' : '处理中…'}</p> : null}
      {page?.items.length === 0 ? <p>{en ? 'No dead-letter runs.' : '没有待处理的异常运行。'}</p> : null}
      {page === undefined ? null : <div className="workflow-dead-letter-table"><table>
        <thead><tr><th>{en ? 'Select' : '选择'}</th><th>{en ? 'Run / fixed identity' : '运行 / 固定身份'}</th><th>{en ? 'State / review' : '状态 / 核对'}</th><th>{en ? 'Recovery result' : '恢复结果'}</th></tr></thead>
        <tbody>{page.items.map((item) => {
          const decision = preview?.find((entry) => entry.runId === item.runId) ?? item
          const result = results.find((entry) => entry.runId === item.runId)
          return <tr key={item.runId}>
            <td><input type="checkbox" aria-label={item.runId} value={item.runId} checked={selected.includes(item.runId)} disabled={busy || selected.length >= 20 && !selected.includes(item.runId)} onChange={(event) => select(item.runId, event.target.checked)} /></td>
            <td><code>{item.runId}</code><div>{item.workflowId} · v{item.workflowRevision}</div><div>{item.environmentId ?? (en ? 'Local' : '本地')} · {item.releaseId ?? (en ? 'Saved revision' : '保存版本')}</div>{item.traceId === undefined ? null : <div>{item.traceId}</div>}</td>
            <td>{runStateLabel(item.status, locale)} · {recoveryDecisionLabel(decision.decision, locale)}<div>{recoveryReasonLabel(decision.reason, locale)}</div><small>{failureCategoryLabel(item.failureCategory, locale)}</small>{item.retentionHold ? <div>{en ? 'Audit evidence retained' : '审计证据保留中'}</div> : null}</td>
            <td role={result === undefined ? undefined : 'status'}>{result === undefined ? '—' : resultText(result)}</td>
          </tr>
        })}</tbody>
      </table></div>}
      {page === undefined ? null : <div className="workflow-dead-letter-actions">
        <button type="button" disabled={busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - page.limit))}>{en ? 'Previous' : '上一页'}</button>
        <span>{page.items.length === 0 ? 0 : page.offset + 1}–{page.offset + page.items.length} / {page.total}</span>
        <button type="button" disabled={busy || page.offset + page.limit >= page.total} onClick={() => void load(page.offset + page.limit)}>{en ? 'Next' : '下一页'}</button>
      </div>}
    </> : null}
  </section>
}
