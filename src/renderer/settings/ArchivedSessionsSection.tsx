import { useCallback, useEffect, useState } from 'react'
import type { DshSessionSummary } from '../../shared/channel-bridge.js'
import type { AppCopy } from '../../shared/locale.js'

interface ArchivedSessionsSectionProps {
  copy: AppCopy
  developerMode: boolean
  onOpenSession?: (sessionId: string) => void
}

function formatUpdatedAt(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
}

/** Lists archived sessions and lets users restore or permanently delete them. */
export function ArchivedSessionsSection({ copy, developerMode, onOpenSession }: ArchivedSessionsSectionProps): JSX.Element {
  const [sessions, setSessions] = useState<DshSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busySessionId, setBusySessionId] = useState<string>()
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      setSessions(await window.EzDSH.channelBridge.listArchivedSessions())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsArchivedSessionsEmpty)
    } finally {
      setLoading(false)
    }
  }, [copy.settingsArchivedSessionsEmpty])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const restore = async (sessionId: string, open: boolean): Promise<void> => {
    if (busySessionId !== undefined) return
    setBusySessionId(sessionId)
    setError(undefined)
    setMessage(undefined)
    try {
      await window.EzDSH.channelBridge.unarchiveSession(sessionId)
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId))
      if (open) {
        onOpenSession?.(sessionId)
      } else {
        setMessage(copy.settingsArchivedSessionsRestored)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsArchivedSessionsEmpty)
    } finally {
      setBusySessionId(undefined)
    }
  }

  const deleteSession = async (session: DshSessionSummary): Promise<void> => {
    if (!developerMode || busySessionId !== undefined) return
    const name = session.title ?? session.sessionId
    if (!window.confirm(copy.settingsArchivedSessionsDeleteConfirm(name))) return

    setBusySessionId(session.sessionId)
    setError(undefined)
    setMessage(undefined)
    try {
      await window.EzDSH.channelBridge.deleteArchivedSession(session.sessionId)
      setSessions((current) => current.filter((item) => item.sessionId !== session.sessionId))
      setMessage(copy.settingsArchivedSessionsDeleted)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsArchivedSessionsEmpty)
    } finally {
      setBusySessionId(undefined)
    }
  }

  return (
    <section className="settings-card settings-archived-sessions-card" aria-labelledby="settings-archived-sessions-title">
      <div className="settings-card-header settings-archived-sessions-header">
        <div>
          <h2 id="settings-archived-sessions-title" className="settings-card-title">{copy.settingsArchivedSessions}</h2>
          <p className="settings-card-description">{copy.settingsArchivedSessionsHint}</p>
        </div>
        <button
          className="settings-action"
          type="button"
          disabled={loading || busySessionId !== undefined}
          onClick={() => { void refresh() }}
        >
          {loading ? copy.settingsArchivedSessionsRefreshing : copy.settingsArchivedSessionsRefresh}
        </button>
      </div>
      {developerMode ? (
        <p className="settings-hint settings-hint-100" role="note">
          {copy.settingsArchivedSessionsDeveloperHint}
        </p>
      ) : null}

      {message ? <p className="settings-recovery-message" role="status">{message}</p> : null}
      {error ? <p className="settings-error settings-recovery-message" role="alert">{error}</p> : null}

      {loading ? (
        <p className="settings-archived-sessions-empty settings-hint">{copy.loading}</p>
      ) : sessions.length === 0 ? (
        <p className="settings-archived-sessions-empty settings-hint">{copy.settingsArchivedSessionsEmpty}</p>
      ) : (
        <div className="settings-archived-sessions-list">
          {sessions.map((session) => {
            const updatedAt = formatUpdatedAt(session.updatedAt)
            const busy = busySessionId === session.sessionId
            return (
              <div key={session.sessionId} className="settings-archived-session-row">
                <div className="settings-item-text">
                  <div className="settings-archived-session-title-row">
                    <span className="settings-archived-session-title" title={session.title ?? session.sessionId}>
                      {session.title ?? copy.channelBridgeUntitledSession}
                    </span>
                    <span className="settings-archived-session-status">
                      {session.running ? copy.channelBridgeSessionRunning : copy.channelBridgeSessionIdle}
                    </span>
                  </div>
                  <code className="settings-value settings-archived-session-id" title={session.sessionId}>
                    {session.sessionId}
                  </code>
                  {updatedAt ? <p className="settings-hint settings-archived-session-updated">{updatedAt}</p> : null}
                </div>
                <div className="settings-actions settings-archived-session-actions">
                  <button
                    className="settings-action"
                    type="button"
                    disabled={busySessionId !== undefined}
                    onClick={() => { void restore(session.sessionId, false) }}
                  >
                    {busy ? copy.settingsArchivedSessionsRestoring : copy.settingsArchivedSessionsRestore}
                  </button>
                  {onOpenSession ? (
                    <button
                      className="settings-action settings-action-primary"
                      type="button"
                      disabled={busySessionId !== undefined}
                      onClick={() => { void restore(session.sessionId, true) }}
                    >
                      {copy.settingsArchivedSessionsRestoreAndOpen}
                    </button>
                  ) : null}
                  {developerMode ? (
                    <button
                      className="settings-action settings-action-danger"
                      type="button"
                      disabled={busySessionId !== undefined}
                      onClick={() => { void deleteSession(session) }}
                    >
                      {busy ? copy.settingsArchivedSessionsDeleting : copy.settingsArchivedSessionsDelete}
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
