import { useState } from 'react'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import type { AppCopy } from '../../shared/locale.js'

interface SafeModeSettingsBannerProps {
  copy: AppCopy
  runtime: RuntimeSnapshot | undefined
  onExit: () => Promise<void>
  onOpenRecoveryOptions?: () => void
}

/** Explains the active recovery mode and keeps its exit action at the top of Settings. */
export function SafeModeSettingsBanner({ copy, runtime, onExit, onOpenRecoveryOptions }: SafeModeSettingsBannerProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  if (runtime?.mode !== 'safe' && runtime?.mode !== 'isolation') return null
  const isolation = runtime.mode === 'isolation'
  const title = isolation ? copy.isolationModeTitle : copy.safeModeTitle
  const description = isolation ? copy.isolationModeDescription : copy.safeModeDescription
  const exitLabel = isolation ? copy.isolationModeExit : copy.safeModeExit
  const exitingLabel = isolation ? copy.isolationModeExiting : copy.safeModeExiting
  const exitFailedLabel = isolation ? copy.isolationModeExitFailed : copy.safeModeExitFailed

  const exit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onExit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : exitFailedLabel)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-safe-mode-banner" role="status">
      <div className="settings-safe-mode-copy">
        <p className="settings-safe-mode-title">{title}</p>
        <p className="settings-hint">{description}</p>
        {error ? <p className="settings-error" role="alert">{exitFailedLabel}: {error}</p> : null}
      </div>
      <div className="settings-actions settings-safe-mode-actions">
        <button className="settings-action settings-action-primary" type="button" disabled={busy} onClick={() => { void exit() }}>
          {busy ? exitingLabel : exitLabel}
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
