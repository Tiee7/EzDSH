import { useEffect, useRef, useState } from 'react'
import type { RuntimeMode } from '../../main/runtime/runtime-types.js'
import type { AppCopy } from '../../shared/locale.js'
import type { InstallState } from '../../shared/store.js'

export function needsPluginRuntimeVerification(state: InstallState | undefined): boolean {
  return (state?.phase === 'done' && state.runtimeRestartRequired === true)
    || (state?.phase === 'failed' && state.diagnostic?.code === 'pending-plugin-verification')
}

export function finishPluginRuntimeVerification(state: InstallState | undefined): InstallState | undefined {
  if (state?.diagnostic?.code === 'pending-plugin-verification') return undefined
  return state === undefined ? undefined : { ...state, runtimeRestartRequired: false }
}

/** Plugin activation requires normal startup; recovery-mode restarts keep it paused. */
export function PluginRuntimeRestartNotice({ copy, onBusyChange, onNormalReady }: {
  copy: AppCopy
  onBusyChange: (busy: boolean) => void
  onNormalReady: () => void
}): JSX.Element {
  const [mode, setMode] = useState<RuntimeMode>()
  const [busy, setBusy] = useState(false)
  const [deferred, setDeferred] = useState(false)
  const [error, setError] = useState<string>()
  const [checkingMode, setCheckingMode] = useState(false)
  const active = useRef(true)
  const modeVersion = useRef(0)
  const recoveryMode = mode === 'safe' || mode === 'isolation'

  const readMode = async (): Promise<void> => {
    const version = modeVersion.current
    setCheckingMode(true)
    setError(undefined)
    try {
      const snapshot = await window.EzDSH.runtime.getStatus()
      if (active.current && modeVersion.current === version) setMode(snapshot.mode)
    } catch (reason) {
      if (active.current && modeVersion.current === version) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (active.current) setCheckingMode(false)
    }
  }

  useEffect(() => {
    active.current = true
    const unsubscribe = window.EzDSH.runtime.onStateChange((snapshot) => {
      modeVersion.current += 1
      if (active.current) { setMode(snapshot.mode); setError(undefined) }
    })
    void readMode()
    return () => { active.current = false; unsubscribe() }
  }, [])

  const restart = async (): Promise<void> => {
    if (busy || mode === undefined) return
    setBusy(true)
    onBusyChange(true)
    setError(undefined)
    try {
      const snapshot = recoveryMode
        ? await window.EzDSH.recovery.exitSafeMode()
        : await window.EzDSH.runtime.restart()
      setMode(snapshot.mode)
      if (snapshot.phase !== 'ready') throw new Error(copy.storeRuntimeRestartFailed)
      if (snapshot.mode === 'normal') onNormalReady()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }

  if (deferred && mode === 'normal') {
    return <p className="runtime-restart-deferred" role="status">{copy.storeRuntimeRestartDeferred}</p>
  }
  return (
    <div className="runtime-restart-notice" role="status">
      <p>{recoveryMode
        ? deferred ? copy.storeRuntimeNormalStartDeferred : copy.storeRuntimeNormalStartRequired
        : copy.storeRuntimeRestartRequired}</p>
      {error !== undefined ? <p className="runtime-restart-error" role="alert">{error || copy.storeRuntimeRestartFailed}</p> : null}
      <div className="runtime-restart-actions">
        {mode === undefined && error !== undefined ? <button type="button" className="confirm-cancel" disabled={checkingMode} onClick={() => { void readMode() }}>
          {copy.storeRuntimeCheckMode}
        </button> : null}
        <button type="button" className="confirm-accept" disabled={busy || mode === undefined} onClick={() => { void restart() }}>
          {busy ? copy.storeRuntimeRestarting : recoveryMode ? copy.storeRuntimeNormalStartNow : copy.storeRuntimeRestartNow}
        </button>
        {!deferred ? <button type="button" className="confirm-cancel" disabled={busy} onClick={() => { setDeferred(true) }}>
          {recoveryMode ? copy.storeRuntimeKeepCurrentMode : copy.storeRuntimeRestartLater}
        </button> : null}
      </div>
    </div>
  )
}
