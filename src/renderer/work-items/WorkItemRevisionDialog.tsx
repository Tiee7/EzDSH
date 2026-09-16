import { useEffect, useRef, useState } from 'react'
import type { WorkTaskRevisionRequest, WorkTaskSnapshot } from '../../shared/work-items.js'

export type WorkItemRevisionFollowUp = 'none' | 'redo' | 'handoff'

export interface WorkItemRevisionDialogProps {
  snapshot: WorkTaskSnapshot
  locale?: 'zh' | 'en'
  onRevise: (request: WorkTaskRevisionRequest) => Promise<WorkTaskSnapshot>
  onReload: (taskId: string) => Promise<WorkTaskSnapshot | undefined>
  onRevised: (snapshot: WorkTaskSnapshot, followUp: WorkItemRevisionFollowUp) => void
  onClose: () => void
}

interface PendingRevision {
  signature: string
  request: WorkTaskRevisionRequest
}

function requestId(): string {
  const token = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `work-item-revise-${token}`
}

/** Revises the durable requirement before any optional new attempt is opened. */
export function WorkItemRevisionDialog({ snapshot, locale = 'zh', onRevise, onReload, onRevised, onClose }: WorkItemRevisionDialogProps): JSX.Element {
  const english = locale === 'en'
  const current = snapshot.task.requirements.find((item) => item.version === snapshot.task.currentRequirementVersion)
  const [goal, setGoal] = useState(current?.goal ?? '')
  const [acceptance, setAcceptance] = useState(current?.acceptance ?? '')
  const [expectedRevision, setExpectedRevision] = useState(snapshot.task.revision)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const dialog = useRef<HTMLElement>(null)
  const goalField = useRef<HTMLTextAreaElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const composing = useRef(false)
  const pending = useRef<PendingRevision>()

  useEffect(() => {
    if (snapshot.task.revision <= expectedRevision) return
    // A newer snapshot can be the changed event for this very request arriving
    // before its IPC response. Until that response is known, retain the
    // original requestId so a retry resolves through Main's receipt replay.
    if (pending.current !== undefined) return
    setExpectedRevision(snapshot.task.revision)
    pending.current = undefined
    setError(english
      ? `The task changed to revision ${snapshot.task.revision}. Your draft is preserved; review it and try again.`
      : `任务已更新到 revision ${snapshot.task.revision}。草稿已保留，请确认后重试。`)
  }, [english, expectedRevision, snapshot.task.revision])

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusTimer = window.setTimeout(() => { goalField.current?.focus() }, 0)
    return () => {
      window.clearTimeout(focusTimer)
      previousFocus.current?.focus()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        if (busy || event.isComposing || event.keyCode === 229 || composing.current) return
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialog.current
      if (root === null) return
      const controls = Array.from(root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      ))
      if (controls.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const active = document.activeElement
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!root.contains(active)) {
        event.preventDefault()
        first?.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function submit(followUp: WorkItemRevisionFollowUp): Promise<void> {
    if (inFlight.current) return
    const nextGoal = goal.trim()
    const nextAcceptance = acceptance.trim()
    if (!nextGoal || !nextAcceptance) {
      setError(english ? 'Goal and acceptance are required.' : '目标和验收标准均为必填项。')
      return
    }
    const signature = JSON.stringify({ taskId: snapshot.task.id, expectedRevision, goal: nextGoal, acceptance: nextAcceptance })
    const request = pending.current?.signature === signature
      ? pending.current.request
      : {
          requestId: requestId(),
          taskId: snapshot.task.id,
          expectedRevision,
          goal: nextGoal,
          acceptance: nextAcceptance,
        }
    pending.current = { signature, request }
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const revised = await onRevise(request)
      onRevised(revised, followUp)
      onClose()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : undefined
      if (code !== 'REVISION_CONFLICT') {
        // The outcome may be unknown (for example, a lost IPC response after
        // Main committed). Keep the same requestId so replay returns the
        // durable receipt instead of creating another requirement version.
        setError(message)
        return
      }
      try {
        const latest = await onReload(snapshot.task.id)
        if (latest !== undefined && latest.task.revision !== request.expectedRevision) {
          setExpectedRevision(latest.task.revision)
          pending.current = undefined
          setError(english
            ? `${message} The task was reloaded at revision ${latest.task.revision}; your draft is preserved.`
            : `${message} 已重新载入任务 revision ${latest.task.revision}，草稿仍保留。`)
        } else {
          setError(message)
        }
      } catch {
        setError(message)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <div className="work-item-create-backdrop" role="presentation">
    <section ref={dialog} tabIndex={-1} className="work-item-create-dialog work-item-revision-dialog" role="dialog" aria-modal="true" aria-labelledby="work-item-revision-dialog-title" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
      <div className="work-item-create-fields">
        <h2 id="work-item-revision-dialog-title">{english ? 'Revise requirement' : '修改任务要求'}</h2>
        <p>{english
          ? `The saved requirement becomes version ${snapshot.task.currentRequirementVersion + 1}. Earlier requirements, runs, and deliverables stay in history.`
          : `保存后形成要求 v${snapshot.task.currentRequirementVersion + 1}。旧要求、执行记录和成果继续保留在历史中。`}</p>
        <label>{english ? 'Goal' : '目标'}
          <textarea ref={goalField} aria-label={english ? 'Revised goal' : '新目标'} aria-required="true" rows={4} value={goal} disabled={busy} onChange={(event) => setGoal(event.target.value)} />
        </label>
        <label>{english ? 'Acceptance' : '验收标准'}
          <textarea aria-label={english ? 'Revised acceptance' : '新验收标准'} aria-required="true" rows={4} value={acceptance} disabled={busy} onChange={(event) => setAcceptance(event.target.value)} />
        </label>
        <p className="work-item-handoff-note">{english
          ? 'Saving does not change or cancel an existing run. Redo and handoff start a separate attempt after the revision succeeds.'
          : '保存新要求不会修改或取消已有运行。“修订后重做”和“修订后交接”会在修订成功后另开执行轮次。'}</p>
        {error ? <p className="work-items-error" role="alert">{error}</p> : null}
      </div>
      <div className="work-item-create-actions">
        <button type="button" className="work-items-button" disabled={busy} onClick={() => { void submit('none') }}>{busy ? (english ? 'Saving…' : '正在保存…') : (english ? 'Save requirement' : '仅保存新要求')}</button>
        <button type="button" className="work-items-button" disabled={busy} onClick={() => { void submit('redo') }}>{english ? 'Save and redo' : '修订后重做'}</button>
        <button type="button" className="work-items-button" disabled={busy} onClick={() => { void submit('handoff') }}>{english ? 'Save and hand off' : '修订后交接'}</button>
        <button type="button" className="work-items-button work-items-button-quiet" disabled={busy} onClick={onClose}>{english ? 'Close' : '关闭'}</button>
      </div>
    </section>
  </div>
}
