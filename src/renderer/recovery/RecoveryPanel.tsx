import { useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { RecoveryDoctorResult, RecoverySnapshot, RecoveryState, RuntimeFailurePlugin } from '../../main/recovery/recovery-manager.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import './recovery-panel.css'

interface RecoveryPanelProps {
  copy: AppCopy
  state: RecoveryState
  runtime?: RuntimeSnapshot
  onSafeModeStarted?: (runtime: RuntimeSnapshot) => void
}

type RecoveryBusyAction = 'retry' | 'restore' | 'restore-snapshot' | 'list-snapshots' | 'safe-mode' | 'exit-safe-mode' | 'rollback-plugin' | 'disable-plugin' | 'doctor'

export function sortRecoverySnapshotsByDate(snapshots: readonly RecoverySnapshot[]): RecoverySnapshot[] {
  return [...snapshots].sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt))
}

/** Recovery UI that remains usable while the DSH child process is unavailable. */
export function RecoveryPanel({ copy, state, runtime, onSafeModeStarted }: RecoveryPanelProps): JSX.Element {
  const [busyAction, setBusyAction] = useState<RecoveryBusyAction>()
  const [error, setError] = useState<string>()
  const [doctor, setDoctor] = useState<RecoveryDoctorResult>()
  const [snapshotPickerOpen, setSnapshotPickerOpen] = useState(false)
  const [availableSnapshots, setAvailableSnapshots] = useState<RecoverySnapshot[]>([])
  const [selectedSnapshotName, setSelectedSnapshotName] = useState<string>()
  const busy = busyAction !== undefined
  const pendingTransaction = state.pendingTransaction
  const pendingPlugin = pendingTransaction?.kind === 'plugin-change' ? pendingTransaction.affectedPlugin : undefined
  const runtimeFailure = state.runtimeFailure
  const snapshotName = pendingTransaction?.snapshotName ?? state.pendingUpdate?.snapshotName ?? runtimeFailure?.latestSnapshot?.archiveName ?? 'latest'
  const canRestore = pendingTransaction !== undefined || state.pendingUpdate !== undefined || runtimeFailure?.latestSnapshot !== undefined

  const retry = async (): Promise<void> => {
    if (busy) return
    setBusyAction('retry')
    setError(undefined)
    try {
      await window.EzDSH.recovery.exitSafeMode()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.runtimeStartFailed)
    } finally {
      setBusyAction(undefined)
    }
  }

  const restore = async (selector: string, action: 'restore' | 'restore-snapshot' = 'restore', closePicker = false): Promise<void> => {
    if (busy) return
    setBusyAction(action)
    setError(undefined)
    try {
      await window.EzDSH.recovery.restore(selector, false)
      await window.EzDSH.runtime.start()
      if (closePicker) {
        setSnapshotPickerOpen(false)
        setSelectedSnapshotName(undefined)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryRestoreFailed)
    } finally {
      setBusyAction(undefined)
    }
  }

  const openSnapshotPicker = async (): Promise<void> => {
    if (busy) return
    setSnapshotPickerOpen(true)
    setSelectedSnapshotName(undefined)
    setAvailableSnapshots([])
    setBusyAction('list-snapshots')
    setError(undefined)
    try {
      setAvailableSnapshots(sortRecoverySnapshotsByDate(await window.EzDSH.recovery.listSnapshots()))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoverySnapshotsEmpty)
    } finally {
      setBusyAction(undefined)
    }
  }

  const closeSnapshotPicker = (): void => {
    if (busy) return
    setSnapshotPickerOpen(false)
    setSelectedSnapshotName(undefined)
  }

  const enterSafeMode = async (): Promise<void> => {
    if (busy) return
    setBusyAction('safe-mode')
    setError(undefined)
    try {
      const runtime = await window.EzDSH.recovery.enterSafeMode()
      if (runtime.phase !== 'ready' || runtime.mode !== 'safe' || runtime.url === undefined) {
        throw new Error('安全模式 Runtime 未进入可用状态')
      }
      onSafeModeStarted?.(runtime)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法启动安全模式')
    } finally {
      setBusyAction(undefined)
    }
  }

  const exitSafeMode = async (): Promise<void> => {
    if (busy) return
    setBusyAction('exit-safe-mode')
    setError(undefined)
    try {
      await window.EzDSH.recovery.exitSafeMode()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复正常运行模式')
    } finally {
      setBusyAction(undefined)
    }
  }

  const rollbackPlugin = async (): Promise<void> => {
    if (busy) return
    setBusyAction('rollback-plugin')
    setError(undefined)
    try {
      await window.EzDSH.recovery.rollbackPendingPlugin()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryRestoreFailed)
    } finally {
      setBusyAction(undefined)
    }
  }

  const disablePlugin = async (plugin: RuntimeFailurePlugin): Promise<void> => {
    if (busy) return
    setBusyAction('disable-plugin')
    setError(undefined)
    try {
      await window.EzDSH.recovery.disablePlugin(plugin.packageName, plugin.profile)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryRestoreFailed)
    } finally {
      setBusyAction(undefined)
    }
  }

  const inspectSessions = async (repair = false): Promise<void> => {
    if (busy) return
    setBusyAction('doctor')
    setError(undefined)
    try {
      setDoctor(await window.EzDSH.recovery.doctor(repair))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryDoctor)
    } finally {
      setBusyAction(undefined)
    }
  }

  return (
    <main className="app-shell recovery-shell recovery-scroll-region" tabIndex={0}>
      <section className="recovery-card" aria-labelledby="recovery-title">
        <div className="recovery-icon" aria-hidden="true">↺</div>
        <p className="eyebrow">EzDSH Recovery</p>
        <h1 id="recovery-title">{copy.recoveryTitle}</h1>
        <p className="recovery-detail">{runtimeFailure ? copy.recoveryRuntimeFailureDetail : copy.recoveryDetail}</p>
        {state.lastError ? (
          <pre className="recovery-error recovery-error-message"><strong>{copy.recoveryLastError}:</strong> {state.lastError}</pre>
        ) : null}
        {runtimeFailure?.logPath !== undefined ? (
          <p className="recovery-log-path"><strong>{copy.runtimeLogPath}:</strong> <code>{runtimeFailure.logPath}</code></p>
        ) : null}
        {pendingPlugin ? (
          <div className="recovery-plugin-incident" role="status">
            <strong>检测到受管插件变更：</strong> {pendingPlugin.entryId}<br />
            EzDSH 已保留变更前快照。安全模式不会加载任何第三方插件。
          </div>
        ) : null}
        {runtimeFailure ? (
          <div className="recovery-runtime-incident" role="status">
            <strong>{copy.recoveryPluginChoiceTitle}</strong>
            {runtimeFailure.plugins.length === 0
              ? <p>{copy.recoveryNoPluginChoices}</p>
              : (
                <div className="recovery-plugin-choices">
                  {runtimeFailure.plugins.map((plugin) => (
                    <button
                      key={`${plugin.profile}:${plugin.packageName}`}
                      type="button"
                      className="recovery-disable-plugin"
                      disabled={busy}
                      onClick={() => { void disablePlugin(plugin) }}
                    >
                      {busyAction === 'disable-plugin' ? copy.recoveryDisablingPlugin : copy.recoveryDisablePlugin(plugin.name ?? plugin.packageName)}
                    </button>
                  ))}
                </div>
                )}
          </div>
        ) : null}
        <p className="recovery-snapshot">{snapshotName}</p>
        {runtimeFailure?.latestSnapshot !== undefined ? (
          <p className="recovery-snapshot-detail">
            {copy.recoverySnapshotChoice(runtimeFailure.latestSnapshot.archiveName, runtimeFailure.latestSnapshot.createdAt, runtimeFailure.latestSnapshot.reason)}
          </p>
        ) : null}
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
        {snapshotPickerOpen ? (
          <section className="recovery-snapshot-picker" role="dialog" aria-modal="true" aria-labelledby="recovery-snapshot-picker-title">
            <h2 id="recovery-snapshot-picker-title">{copy.recoverySelectSnapshotTitle}</h2>
            <p className="recovery-snapshot-picker-hint">{copy.recoverySelectSnapshotHint}</p>
            {busyAction === 'list-snapshots' ? <p className="recovery-snapshot-picker-status">{copy.recoverySnapshotsLoading}</p> : null}
            {busyAction !== 'list-snapshots' && availableSnapshots.length === 0 ? <p className="recovery-snapshot-picker-status">{copy.recoverySnapshotsEmpty}</p> : null}
            {availableSnapshots.length > 0 ? (
              <div className="recovery-snapshot-choices" role="radiogroup" aria-label={copy.recoverySelectSnapshotTitle}>
                {availableSnapshots.map((snapshot) => (
                  <label key={snapshot.archiveName} className={`recovery-snapshot-choice${selectedSnapshotName === snapshot.archiveName ? ' recovery-snapshot-choice-selected' : ''}`}>
                    <input
                      type="radio"
                      name="recovery-snapshot"
                      value={snapshot.archiveName}
                      checked={selectedSnapshotName === snapshot.archiveName}
                      disabled={busy}
                      onChange={() => setSelectedSnapshotName(snapshot.archiveName)}
                    />
                    <span className="recovery-snapshot-choice-text">
                      <strong>{snapshot.manifest.createdAt}</strong>
                      <code>{snapshot.archiveName}</code>
                      <span>{snapshot.manifest.kind} · {snapshot.manifest.reason}</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            <div className="recovery-snapshot-picker-actions">
              <button type="button" className="recovery-link recovery-action-button" disabled={busy} onClick={closeSnapshotPicker}>
                {copy.recoverySelectSnapshotCancel}
              </button>
              <button
                type="button"
                className="recovery-primary recovery-action-button"
                disabled={busy || selectedSnapshotName === undefined}
                onClick={() => {
                  if (selectedSnapshotName !== undefined) void restore(selectedSnapshotName, 'restore-snapshot', true)
                }}
              >
                {busyAction === 'restore-snapshot' ? copy.recoveryRestoring : copy.recoverySelectSnapshotConfirm}
              </button>
            </div>
          </section>
        ) : null}
        <div className="recovery-actions">
          {pendingPlugin ? (
            <button type="button" className="recovery-primary recovery-action-button" disabled={busy} onClick={() => { void rollbackPlugin() }}>
              {busyAction === 'rollback-plugin' ? copy.recoveryRestoring : '回滚此插件变更'}
            </button>
          ) : null}
          {canRestore ? (
            <button type="button" className="recovery-primary recovery-action-button" disabled={busy} onClick={() => { void restore(snapshotName) }}>
              {busyAction === 'restore' ? copy.recoveryRestoring : copy.recoveryRestorePrevious}
            </button>
          ) : null}
          <button type="button" className="recovery-link recovery-action-button" disabled={busy} onClick={() => { void openSnapshotPicker() }}>
            {copy.recoverySelectSnapshot}
          </button>
          <button type="button" className="recovery-safe-mode recovery-action-button" disabled={busy} onClick={() => { void enterSafeMode() }}>
            {copy.runtimeEnterSafeMode}
          </button>
          {runtime?.mode === 'safe' ? (
            <button type="button" className="recovery-link recovery-action-button" disabled={busy} onClick={() => { void exitSafeMode() }}>
              {copy.safeModeExit}
            </button>
          ) : null}
          <button type="button" className="retry-button recovery-action-button" disabled={busy} onClick={() => { void retry() }}>
            {copy.recoveryRetryRuntime}
          </button>
          <button type="button" className="recovery-link recovery-action-button" disabled={busy} onClick={() => { void window.EzDSH.recovery.openDirectory() }}>
            {copy.recoveryOpenBackups}
          </button>
          {runtimeFailure?.logPath !== undefined ? (
            <button type="button" className="recovery-link recovery-action-button" disabled={busy} onClick={() => { void window.EzDSH.runtime.openLog() }}>
              {copy.settingsOpenLog}
            </button>
          ) : null}
          <button type="button" className="recovery-link recovery-action-button" disabled={busy} onClick={() => { void inspectSessions() }}>
            {busyAction === 'doctor' ? copy.recoveryDoctorRunning : copy.recoveryDoctor}
          </button>
        </div>
      </section>
    </main>
  )
}
