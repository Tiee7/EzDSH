import { useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { RecoveryDoctorResult, RecoveryState } from '../../main/recovery/recovery-manager.js'
import './recovery-panel.css'

interface RecoveryPanelProps {
  copy: AppCopy
  state: RecoveryState
}

/** Recovery UI that remains usable while the DSH child process is unavailable. */
export function RecoveryPanel({ copy, state }: RecoveryPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [doctor, setDoctor] = useState<RecoveryDoctorResult>()
  const pendingTransaction = state.pendingTransaction
  const snapshotName = pendingTransaction?.snapshotName ?? state.pendingUpdate?.snapshotName ?? 'latest'
  const pendingPlugin = pendingTransaction?.kind === 'plugin-change' ? pendingTransaction.affectedPlugin : undefined

  const retry = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await window.EzDSH.runtime.start()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.runtimeStartFailed)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await window.EzDSH.recovery.restore(snapshotName, false)
      await window.EzDSH.runtime.start()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryRestoreFailed)
    } finally {
      setBusy(false)
    }
  }

  const enterSafeMode = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await window.EzDSH.recovery.enterSafeMode()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法启动安全模式')
    } finally {
      setBusy(false)
    }
  }

  const exitSafeMode = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await window.EzDSH.recovery.exitSafeMode()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复正常运行模式')
    } finally {
      setBusy(false)
    }
  }

  const rollbackPlugin = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await window.EzDSH.recovery.rollbackPendingPlugin()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryRestoreFailed)
    } finally {
      setBusy(false)
    }
  }

  const inspectSessions = async (repair = false): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      setDoctor(await window.EzDSH.recovery.doctor(repair))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryDoctor)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="recovery-card" aria-labelledby="recovery-title">
        <div className="recovery-icon" aria-hidden="true">↺</div>
        <p className="eyebrow">EzDSH Recovery</p>
        <h1 id="recovery-title">{copy.recoveryTitle}</h1>
        <p className="recovery-detail">{copy.recoveryDetail}</p>
        {state.lastError ? (
          <p className="recovery-error"><strong>{copy.recoveryLastError}:</strong> {state.lastError}</p>
        ) : null}
        {pendingPlugin ? (
          <div className="recovery-plugin-incident" role="status">
            <strong>检测到受管插件变更：</strong> {pendingPlugin.entryId}<br />
            EzDSH 已保留变更前快照。安全模式不会加载任何第三方插件。
          </div>
        ) : null}
        <p className="recovery-snapshot">{snapshotName}</p>
        {busy ? <div className="loading-spinner" aria-hidden="true" /> : null}
        {error ? <p className="recovery-error" role="alert">{error}</p> : null}
        {doctor ? (
          <div className="recovery-doctor-result" role="status">
            <p>{copy.recoveryDoctorDone(doctor.issues.length, doctor.repairedFiles.length)}</p>
            {doctor.issues.some((issue) => issue.kind === 'incomplete-final-record') ? (
              <button type="button" className="recovery-link" disabled={busy} onClick={() => { void inspectSessions(true) }}>
                {copy.recoveryRepairSessionTail}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="recovery-actions">
          {pendingPlugin ? (
            <button type="button" className="recovery-primary" disabled={busy} onClick={() => { void rollbackPlugin() }}>
              {busy ? copy.recoveryRestoring : '回滚此插件变更'}
            </button>
          ) : null}
          <button type="button" className="recovery-primary" disabled={busy} onClick={() => { void restore() }}>
            {busy ? copy.recoveryRestoring : copy.recoveryRestorePrevious}
          </button>
          <button type="button" className="recovery-safe-mode" disabled={busy} onClick={() => { void enterSafeMode() }}>
            以安全模式启动
          </button>
          <button type="button" className="recovery-link" disabled={busy} onClick={() => { void exitSafeMode() }}>
            退出安全模式并正常启动
          </button>
          <button type="button" className="retry-button" disabled={busy} onClick={() => { void retry() }}>
            {copy.recoveryRetryRuntime}
          </button>
          <button type="button" className="recovery-link" disabled={busy} onClick={() => { void window.EzDSH.recovery.openDirectory() }}>
            {copy.recoveryOpenBackups}
          </button>
          <button type="button" className="recovery-link" disabled={busy} onClick={() => { void inspectSessions() }}>
            {busy ? copy.recoveryDoctorRunning : copy.recoveryDoctor}
          </button>
        </div>
      </section>
    </main>
  )
}
