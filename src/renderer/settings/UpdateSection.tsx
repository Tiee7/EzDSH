import { useEffect, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { UpdateState } from '../../shared/update.js'
import { updateAction } from './settings-display.js'

/** Update row: current version, check/download/install actions driven by update phase. */
export function UpdateSection({ copy }: { copy: AppCopy }): JSX.Element {
  const [state, setState] = useState<UpdateState>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    const fetchStatus = async (): Promise<void> => {
      try {
        const snapshot = await window.EzDSH.updates.getStatus()
        if (active) setState(snapshot)
      } catch {
        if (active) setError(copy.updateCheckFailed)
      }
    }
    void fetchStatus()
    const unsubscribe = window.EzDSH.updates.onStateChange((snapshot) => {
      if (active) {
        setState(snapshot)
        setError(undefined)
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [copy])

  const phase = state?.phase ?? 'idle'
  const action = updateAction(phase)
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing'
  const message = phase === 'up-to-date'
    ? copy.latestVersion
    : phase === 'failed'
      ? `${copy.updateCheckFailed}${state?.message ? `: ${state.message}` : ''}`
      : state?.message

  const runAction = async (): Promise<void> => {
    setError(undefined)
    try {
      if (action === 'download') await window.EzDSH.updates.download()
      else if (action === 'install') await window.EzDSH.updates.install()
      else if (action === 'retry' || action === 'check') await window.EzDSH.updates.check()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.updateCheckFailed)
    }
  }

  return (
    <div className="settings-item">
      <div className="settings-item-text">
        <p className="settings-label">{copy.settingsUpdateSection}</p>
        <p className="settings-hint">
          {copy.settingsUpdateCurrent} {window.EzDSH.app.version}
          {state?.availableVersion ? ` → v${state.availableVersion}` : ''}
          {message ? ` · ${message}` : ''}
        </p>
        {phase === 'downloading' && state?.percent !== undefined ? (
          <progress className="settings-progress" max="100" value={state.percent} aria-label={copy.settingsDownloadUpdate} />
        ) : null}
        {error ? <p className="settings-error">{error}</p> : null}
      </div>
      <div className="settings-actions">
        {action !== 'none' ? (
          <button className="settings-action" disabled={busy} onClick={() => { void runAction() }}>
            {action === 'download'
              ? copy.settingsDownloadUpdate
              : action === 'install'
                ? copy.restartAndInstall
                : action === 'retry'
                  ? copy.storeRetry
                  : copy.settingsCheckUpdate}
          </button>
        ) : null}
      </div>
    </div>
  )
}
