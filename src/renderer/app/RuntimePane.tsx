import { useEffect, useRef, useState } from 'react'
import type { RuntimeViewBounds } from '../../shared/runtime-view.js'
import type { AppLocale } from '../../shared/locale.js'
import type { EmployeeProjectSummary, EmployeeSnapshot } from '../../shared/employees.js'
import type { WorkflowDefinition } from '../../shared/workflow.js'
import type { WorkTaskSnapshot } from '../../shared/work-items.js'
import type { ConversationSnapshot } from '../../shared/conversation-work.js'
import { ConversationWorkDialog } from './ConversationWorkDialog.js'

interface RuntimePaneProps {
  url: string
  active: boolean
  sessionId?: string
  developerMode?: boolean
  locale?: AppLocale
  onWorkItemCreated?: (snapshot: WorkTaskSnapshot) => void
}

type BoundsInput = Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>

export function toRuntimeViewBounds(bounds: BoundsInput): RuntimeViewBounds | undefined {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return undefined
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

/** DOM anchor for the first-party WebContentsView owned by Electron Main. */
export function RuntimePane({ url, active, sessionId, developerMode = false, locale = 'zh', onWorkItemCreated }: RuntimePaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const lastOpenedSession = useRef<string | undefined>(undefined)
  const lastRuntimeUrl = useRef<string | undefined>(undefined)
  const [sessions, setSessions] = useState<Array<{ sessionId: string; title?: string; updatedAt: number; running: boolean; blank?: boolean }>>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(sessionId)
  const [conversation, setConversation] = useState<ConversationSnapshot>()
  const [conversationError, setConversationError] = useState<string>()
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [loadingCatalogs, setLoadingCatalogs] = useState(false)
  const [dialog, setDialog] = useState<{ snapshot: ConversationSnapshot; employees: EmployeeSnapshot[]; workflows: WorkflowDefinition[]; projects: EmployeeProjectSummary[]; unavailable: Array<'employees' | 'workflows' | 'projects'> }>()
  const requestSequence = useRef(0)
  const [conversationRefreshNonce, setConversationRefreshNonce] = useState(0)

  const refreshSessions = (): void => {
    if (!developerMode) return
    setLoadingSessions(true)
    void window.EzDSH.runtime.listSessions()
      .then((next) => {
        setConversationError(undefined)
        setSessions(next)
        setConversationRefreshNonce((current) => current + 1)
        setSelectedSessionId((current) => {
          if (sessionId !== undefined && next.some((item) => item.sessionId === sessionId)) return sessionId
          if (current !== undefined && next.some((item) => item.sessionId === current)) return current
          return next.find((item) => item.blank !== true)?.sessionId ?? next[0]?.sessionId
        })
      })
      .catch((reason) => setConversationError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoadingSessions(false))
  }

  useEffect(() => {
    if (!active || !developerMode) return
    refreshSessions()
  }, [active, developerMode, url])

  useEffect(() => {
    if (developerMode) return
    setDialog(undefined)
    setConversation(undefined)
  }, [developerMode])

  useEffect(() => {
    if (sessionId !== undefined) setSelectedSessionId(sessionId)
  }, [sessionId])

  useEffect(() => {
    const id = selectedSessionId
    if (!active || !developerMode || id === undefined) {
      setConversation(undefined)
      return
    }
    const sequence = ++requestSequence.current
    setLoadingConversation(true)
    setConversationError(undefined)
    void window.EzDSH.runtime.getConversation(id)
      .then((next) => {
        if (sequence !== requestSequence.current) return
        setConversation(next)
      })
      .catch((reason) => {
        if (sequence === requestSequence.current) setConversationError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoadingConversation(false)
      })
  }, [active, conversationRefreshNonce, developerMode, selectedSessionId, url])

  const openWorkDialog = (): void => {
    if (conversation === undefined || loadingCatalogs) return
    const unavailable: Array<'employees' | 'workflows' | 'projects'> = []
    setLoadingCatalogs(true)
    void Promise.allSettled([
      window.EzDSH.employees.list(),
      window.EzDSH.workflows.list(),
      window.EzDSH.employees.listProjects(),
    ]).then((results) => {
      const employees = results[0]?.status === 'fulfilled' ? results[0].value : (unavailable.push('employees'), [])
      const workflows = results[1]?.status === 'fulfilled' ? results[1].value : (unavailable.push('workflows'), [])
      const projects = results[2]?.status === 'fulfilled' ? results[2].value : (unavailable.push('projects'), [])
      setDialog({ snapshot: conversation, employees, workflows, projects, unavailable })
    }).finally(() => setLoadingCatalogs(false))
  }

  useEffect(() => {
    if (lastRuntimeUrl.current !== url) {
      lastRuntimeUrl.current = url
      lastOpenedSession.current = undefined
    }
    if (!active || dialog !== undefined) {
      void window.EzDSH.runtimeView.hide()
      return
    }

    let disposed = false
    const targetSessionId = selectedSessionId ?? sessionId
    const sync = (): void => {
      const host = hostRef.current
      if (host === null || disposed) return
      const bounds = toRuntimeViewBounds(host.getBoundingClientRect())
      if (bounds === undefined) return
      void window.EzDSH.runtimeView.show(url, bounds).then(async () => {
        if (disposed || targetSessionId === undefined || lastOpenedSession.current === targetSessionId) return
        await window.EzDSH.runtimeView.openSession(targetSessionId)
        lastOpenedSession.current = targetSessionId
      }).catch(() => {
        // Runtime lifecycle errors are reported by the Main process status surface.
      })
    }

    sync()
    const observer = new ResizeObserver(sync)
    if (hostRef.current !== null) observer.observe(hostRef.current)
    window.addEventListener('resize', sync)
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', sync)
      void window.EzDSH.runtimeView.hide()
    }
  }, [active, dialog !== undefined, selectedSessionId, sessionId, url])

  return <div className="runtime-pane-shell">
    {developerMode ? <div className="runtime-work-toolbar" aria-label={locale === 'en' ? 'Conversation work actions' : '对话工作项操作'}>
      <label className="runtime-session-picker">{locale === 'en' ? 'Conversation' : '当前对话'}
        <select aria-label={locale === 'en' ? 'Conversation' : '当前对话'} value={selectedSessionId ?? ''} disabled={loadingSessions || sessions.length === 0} onChange={(event) => setSelectedSessionId(event.target.value || undefined)}>
          {sessions.length === 0 ? <option value="">{loadingSessions ? (locale === 'en' ? 'Loading…' : '正在读取…') : (locale === 'en' ? 'No sessions' : '没有可用会话')}</option> : null}
          {sessions.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.title || item.sessionId}{item.running ? (locale === 'en' ? ' · running' : ' · 进行中') : ''}</option>)}
        </select>
      </label>
      <button type="button" className="runtime-work-button" disabled={conversation === undefined || loadingConversation || loadingCatalogs} onClick={openWorkDialog}>{locale === 'en' ? 'Save as work item…' : '保存为工作项…'}</button>
      <button type="button" className="runtime-work-button runtime-work-button-quiet" disabled={loadingSessions} onClick={refreshSessions}>{locale === 'en' ? 'Refresh' : '刷新'}</button>
      {conversationError ? <span className="runtime-work-error" role="status">{conversationError}</span> : null}
    </div> : null}
    <div ref={hostRef} className="runtime-view-host" data-runtime-view-host="true" aria-label="EzDSH Runtime" />
    {dialog === undefined ? null : <ConversationWorkDialog
      snapshot={dialog.snapshot}
      employees={dialog.employees}
      workflows={dialog.workflows}
      projects={dialog.projects}
      unavailableCatalogs={dialog.unavailable}
      locale={locale === 'en' ? 'en' : 'zh'}
      onCreate={(request) => window.EzDSH.workItems.create(request)}
      onExecute={(request) => window.EzDSH.workItems.execute(request)}
      onCreated={() => {}}
      onExecuted={() => {}}
      onFinished={(next) => { onWorkItemCreated?.(next) }}
      onClose={() => setDialog(undefined)}
    />}
  </div>
}
