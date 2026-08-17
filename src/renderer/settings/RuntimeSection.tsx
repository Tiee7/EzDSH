import { useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'

interface RuntimeSectionProps {
  copy: AppCopy
  runtime: RuntimeSnapshot | undefined
}

/** Runtime status row: phase, port, restart, log, and data directory actions. */
export function RuntimeSection({ copy, runtime }: RuntimeSectionProps): JSX.Element {
  const [restarting, setRestarting] = useState(false)
  const phase = runtime?.phase
  const ready = phase === 'ready'
  const phaseLabel = phase === 'starting' || phase === 'preparing'
    ? copy.starting
    : ready
      ? copy.ready
      : phase === 'failed'
        ? copy.runtimeFailed
        : copy.preparing

  const restart = async (): Promise<void> => {
    if (restarting) return
    setRestarting(true)
    try {
      await window.EzDSH.runtime.restart()
    } finally {
      setRestarting(false)
    }
  }

  return (
    <section className="settings-item">
      <div>
        <p className="settings-label">{copy.settingsRuntimeSection}</p>
        <p className="settings-hint">
          <span className={`settings-dot ${ready ? 'settings-dot-ready' : ''}`} aria-hidden="true" />
          {phaseLabel}
          {runtime?.port !== undefined ? ` · ${copy.settingsRuntimePort} ${runtime.port}` : ''}
        </p>
      </div>
      <div className="settings-actions">
        <button className="settings-action" disabled={restarting} onClick={() => { void restart() }}>
          {restarting ? copy.preparing : copy.settingsRestartRuntime}
        </button>
        <button className="settings-action" onClick={() => { void window.EzDSH.runtime.openLog() }}>
          {copy.settingsOpenLog}
        </button>
        <button className="settings-action" onClick={() => { void window.EzDSH.settings.openHarnessDir() }}>
          {copy.settingsOpenHarnessDir}
        </button>
      </div>
    </section>
  )
}
