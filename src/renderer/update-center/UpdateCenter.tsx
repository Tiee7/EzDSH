import type { UpdateState } from '../../shared/update.js'
import './update-center.css'

interface UpdateCenterProps {
  state: UpdateState
}

export function UpdateCenter({ state }: UpdateCenterProps) {
  if (state.phase === 'idle' || state.phase === 'up-to-date') return null

  const action = state.phase === 'available'
    ? <button onClick={() => void window.EzDSH.updates.download()}>下载更新</button>
    : state.phase === 'downloaded'
      ? <button onClick={() => void window.EzDSH.updates.install()}>重启并安装</button>
      : state.phase === 'failed'
        ? <button onClick={() => void window.EzDSH.updates.check()}>重新检查</button>
        : null

  return (
    <aside className="update-center" aria-live="polite">
      <div>
        <strong>{state.message ?? 'EzDSH 更新'}</strong>
        {state.availableVersion ? <span> v{state.availableVersion}</span> : null}
      </div>
      {state.phase === 'downloading' && state.percent !== undefined ? (
        <progress max="100" value={state.percent} aria-label="更新下载进度" />
      ) : null}
      {action}
    </aside>
  )
}
