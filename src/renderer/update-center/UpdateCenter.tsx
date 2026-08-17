import type { AppCopy } from '../../shared/locale.js'
import type { UpdateState } from '../../shared/update.js'
import './update-center.css'

interface UpdateCenterProps {
  state: UpdateState
  copy: AppCopy
}

export function UpdateCenter({ state, copy }: UpdateCenterProps) {
  if (state.phase === 'idle' || state.phase === 'up-to-date') return null

  const action = state.phase === 'available'
    ? <button onClick={() => void window.EzDSH.updates.download()}>{copy.settingsDownloadUpdate}</button>
    : state.phase === 'downloaded'
      ? <button onClick={() => void window.EzDSH.updates.install()}>{copy.restartAndInstall}</button>
      : state.phase === 'failed'
        ? <button onClick={() => void window.EzDSH.updates.check()}>{copy.storeRetry}</button>
        : null

  return (
    <aside className="update-center" aria-live="polite">
      <div>
        <strong>{state.message ?? copy.settingsUpdateSection}</strong>
        {state.availableVersion ? <span> v{state.availableVersion}</span> : null}
      </div>
      {state.phase === 'downloading' && state.percent !== undefined ? (
        <progress max="100" value={state.percent} aria-label={copy.settingsDownloadUpdate} />
      ) : null}
      {action}
    </aside>
  )
}
