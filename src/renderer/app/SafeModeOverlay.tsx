import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'

export function isRecoveryModeActive(runtime: RuntimeSnapshot | undefined): boolean {
  return runtime?.phase === 'ready' && (runtime.mode === 'safe' || runtime.mode === 'isolation')
}

interface SafeModeCornerOverlayProps {
  label: string
}

/** A visual-only status mark that never captures clicks from the active page. */
export function SafeModeCornerOverlay({ label }: SafeModeCornerOverlayProps): JSX.Element {
  return (
    <div className="safe-mode-corner-overlay" aria-hidden="true" style={{ pointerEvents: 'none' }}>
      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
        <span key={corner} className={`safe-mode-corner-label safe-mode-corner-${corner}`}>{label}</span>
      ))}
    </div>
  )
}
