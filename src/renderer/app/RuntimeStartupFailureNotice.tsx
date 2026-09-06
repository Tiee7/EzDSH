import { useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'

interface RuntimeStartupFailureNoticeProps {
  copy: AppCopy
  message: string | undefined
  logPath: string | undefined
  onOpenLog: () => Promise<void>
  onEnterSafeMode?: () => Promise<void>
  onOpenRecoverySettings?: () => void
  initialExpanded?: boolean
}

/** Keep the startup screen compact while making the real failure evidence one click away. */
export function RuntimeStartupFailureNotice({
  copy,
  message,
  logPath,
  onOpenLog,
  onEnterSafeMode,
  onOpenRecoverySettings,
  initialExpanded = false,
}: RuntimeStartupFailureNoticeProps): JSX.Element {
  const [expanded, setExpanded] = useState(initialExpanded)
  const [openingLog, setOpeningLog] = useState(false)
  const [openLogError, setOpenLogError] = useState<string>()
  const [enteringSafeMode, setEnteringSafeMode] = useState(false)
  const [safeModeError, setSafeModeError] = useState<string>()

  const openLog = async (): Promise<void> => {
    if (openingLog || logPath === undefined) return
    setOpeningLog(true)
    setOpenLogError(undefined)
    try {
      await onOpenLog()
    } catch (reason) {
      setOpenLogError(reason instanceof Error ? reason.message : copy.runtimeOpenLogFailed)
    } finally {
      setOpeningLog(false)
    }
  }

  const enterSafeMode = async (): Promise<void> => {
    if (enteringSafeMode || onEnterSafeMode === undefined) return
    setEnteringSafeMode(true)
    setSafeModeError(undefined)
    try {
      await onEnterSafeMode()
    } catch (reason) {
      setSafeModeError(reason instanceof Error ? reason.message : copy.runtimeSafeModeFailed)
    } finally {
      setEnteringSafeMode(false)
    }
  }

  return (
    <div className="runtime-failure-notice">
      <button
        type="button"
        className="runtime-failure-toggle"
        aria-expanded={expanded}
        aria-controls="runtime-startup-failure-details"
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        {expanded ? copy.runtimeHideFailureDetails : copy.runtimeShowFailureDetails}
      </button>
      {onEnterSafeMode !== undefined || onOpenRecoverySettings !== undefined || logPath !== undefined ? (
        <div className="runtime-failure-actions">
          {onEnterSafeMode !== undefined ? (
            <button type="button" className="runtime-failure-action runtime-failure-action-primary" disabled={enteringSafeMode} onClick={() => { void enterSafeMode() }}>
              {enteringSafeMode ? copy.runtimeEnteringSafeMode : copy.runtimeEnterSafeMode}
            </button>
          ) : null}
          {onOpenRecoverySettings !== undefined ? (
            <button type="button" className="runtime-failure-action" onClick={onOpenRecoverySettings}>
              {copy.runtimeOpenRecoverySettings}
            </button>
          ) : null}
          {logPath !== undefined ? (
            <button type="button" className="runtime-failure-action" disabled={openingLog} onClick={() => { void openLog() }}>
              {openingLog ? copy.runtimeOpeningLog : copy.settingsOpenLog}
            </button>
          ) : null}
        </div>
      ) : null}
      {safeModeError !== undefined ? <p className="runtime-failure-open-error" role="alert">{copy.runtimeSafeModeFailed}: {safeModeError}</p> : null}
      {expanded ? (
        <div id="runtime-startup-failure-details" className="runtime-failure-details" role="region" aria-label={copy.runtimeShowFailureDetails}>
          <p className="runtime-failure-label">{copy.runtimeFailureReason}</p>
          <pre className="runtime-failure-message">{message ?? copy.runtimeFailureUnknown}</pre>
          <p className="runtime-failure-label">{copy.runtimeLogPath}</p>
          <code className="runtime-failure-log-path">{logPath ?? copy.runtimeLogPathUnavailable}</code>
          {openLogError !== undefined ? <p className="runtime-failure-open-error" role="alert">{copy.runtimeOpenLogFailed}: {openLogError}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
