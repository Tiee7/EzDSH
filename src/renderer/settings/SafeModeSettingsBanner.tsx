import { useState } from 'react'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import type { AppCopy } from '../../shared/locale.js'

interface SafeModeSettingsBannerProps {
  copy: AppCopy
  runtime: RuntimeSnapshot | undefined
  onExit: () => Promise<void>
  onOpenRecoveryOptions?: () => void
}

/** Explains why Safe Mode is active and keeps the exit action at the top of Settings. */
export function SafeModeSettingsBanner({ copy, runtime, onExit, onOpenRecoveryOptions }: SafeModeSettingsBannerProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  if (runtime?.mode !== 'safe') return null

  const exit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onExit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.safeModeExitFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-safe-mode-banner" role="status">
      <div className="settings-safe-mode-copy">
        <p className="settings-safe-mode-title">{copy.safeModeTitle}</p>
        <p className="settings-hint">{copy.safeModeDescription}</p>
        {error ? <p className="settings-error" role="alert">{copy.safeModeExitFailed}: {error}</p> : null}
      </div>
      <div className="settings-actions settings-safe-mode-actions">
        <button className="settings-action settings-action-primary" type="button" disabled={busy} onClick={() => { void exit() }}>
          {busy ? copy.safeModeExiting : copy.safeModeExit}
        </button>
        {onOpenRecoveryOptions !== undefined ? (
          <button className="settings-action" type="button" disabled={busy} onClick={onOpenRecoveryOptions}>
            {copy.safeModeOpenRecovery}
          </button>
        ) : null}
      </div>
    </section>
  )
}
