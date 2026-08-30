import { useCallback, useEffect, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { RecoveryDoctorResult, RecoverySnapshot, RecoveryVerifyResult } from '../../main/recovery/recovery-manager.js'

interface RecoverySectionProps {
  copy: AppCopy
}

export function recoveryDeleteApiAvailable(value: unknown): value is (selector: string) => Promise<void> {
  return typeof value === 'function'
}

export function recoveryVerificationLabel(
  copy: AppCopy,
  snapshotName: string,
  verification: RecoveryVerifyResult | undefined,
): string {
  return verification?.snapshotName === snapshotName
    ? copy.settingsRecoveryVerified(verification.ok)
    : copy.settingsRecoveryVerify
}

/** User-facing manual backup, checksum verification, restore preview, and Session Log doctor. */
export function RecoverySection({ copy }: RecoverySectionProps): JSX.Element {
  const [snapshots, setSnapshots] = useState<RecoverySnapshot[]>([])
  const [doctor, setDoctor] = useState<RecoveryDoctorResult>()
  const [verification, setVerification] = useState<RecoveryVerifyResult>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async (): Promise<void> => {
    setSnapshots(await window.EzDSH.recovery.listSnapshots())
  }, [])

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : copy.settingsRecoveryEmpty))
  }, [copy.settingsRecoveryEmpty, refresh])

  const createSnapshot = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      await window.EzDSH.recovery.createSnapshot()
      await refresh()
      setMessage(copy.settingsRecoveryCreated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsRecoveryEmpty)
    } finally {
      setBusy(false)
    }
  }

  const verify = async (snapshotName: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      setVerification(await window.EzDSH.recovery.verify(snapshotName))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsRecoveryEmpty)
    } finally {
      setBusy(false)
    }
  }

  const inspectSessions = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      setDoctor(await window.EzDSH.recovery.doctor())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsRecoveryEmpty)
    } finally {
      setBusy(false)
    }
  }

  const deleteSnapshot = async (snapshot: RecoverySnapshot): Promise<void> => {
    if (busy) return
    const deleteApi: unknown = window.EzDSH.recovery.deleteSnapshot
    if (!recoveryDeleteApiAvailable(deleteApi)) {
      setError(copy.settingsRecoveryBridgeOutdated)
      return
    }
    if (!window.confirm(copy.settingsRecoveryDeleteConfirm(snapshot.archiveName))) return
    setBusy(true)
    setError(undefined)
    setVerification(undefined)
    try {
      await deleteApi(snapshot.archiveName)
      setSnapshots((current) => current.filter((item) => item.archiveName !== snapshot.archiveName))
      setMessage(copy.settingsRecoveryDeleted)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsRecoveryEmpty)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (snapshot: RecoverySnapshot): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const preview = await window.EzDSH.recovery.restore(snapshot.archiveName, true)
      if (!preview.dryRun) throw new Error('Recovery preview returned an invalid result')
      const credentialNote = preview.missingCredentials.length > 0
        ? `\n\n${preview.missingCredentials.join(', ')}`
        : ''
      if (!window.confirm(`${snapshot.archiveName}\n\n${preview.entries.length} entries will replace the current harness and state.${credentialNote}`)) return
      await window.EzDSH.recovery.restore(snapshot.archiveName, false)
      await window.EzDSH.runtime.restart()
      await refresh()
      setMessage(copy.settingsRecoveryCreated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.recoveryRestoreFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-card settings-recovery-card">
      <div className="settings-card-header">
        <div>
          <p className="settings-label">{copy.settingsRecovery}</p>
          <p className="settings-hint settings-recovery-hint">{copy.settingsRecoveryHint}</p>
          <p className="settings-hint settings-recovery-verify-hint">{copy.settingsRecoveryVerifyHint}</p>
        </div>
      </div>
      <div className="settings-recovery-actions">
        <button className="settings-action settings-action-primary" type="button" disabled={busy} onClick={() => { void createSnapshot() }}>
          {busy ? copy.settingsRecoveryCreating : copy.settingsRecoveryCreate}
        </button>
        <button className="settings-action" type="button" disabled={busy} onClick={() => { void inspectSessions() }}>
          {copy.settingsRecoveryCheckLogs}
        </button>
        <button className="settings-action" type="button" disabled={busy} onClick={() => { void window.EzDSH.recovery.openDirectory() }}>
          {copy.settingsRecoveryOpen}
        </button>
      </div>
      {message ? <p className="settings-recovery-message" role="status">{message}</p> : null}
      {error ? <p className="settings-error settings-recovery-message" role="alert">{error}</p> : null}
      {verification ? <p className={`settings-recovery-message ${verification.ok ? '' : 'settings-error'}`} role="status">{copy.settingsRecoveryVerified(verification.ok)}</p> : null}
      {doctor ? <p className={`settings-recovery-message ${doctor.issues.length === 0 ? '' : 'settings-error'}`} role="status">{copy.settingsRecoveryIssues(doctor.issues.length)}</p> : null}
      <div className="settings-recovery-list">
        {snapshots.length === 0 ? <p className="settings-hint">{copy.settingsRecoveryEmpty}</p> : snapshots.map((snapshot) => (
          <div key={snapshot.archiveName} className="settings-recovery-row">
            <div className="settings-item-text">
              <code className="settings-value settings-recovery-name">{snapshot.archiveName}</code>
              <p className="settings-hint">{snapshot.manifest.kind} · {snapshot.manifest.createdAt} · EzDSH {snapshot.manifest.appVersion}</p>
            </div>
            <div className="settings-actions">
              <button className="settings-action" type="button" disabled={busy} onClick={() => { void verify(snapshot.archiveName) }}>{recoveryVerificationLabel(copy, snapshot.archiveName, verification)}</button>
              <button className="settings-action" type="button" disabled={busy} onClick={() => { void restore(snapshot) }}>{copy.settingsRecoveryRestore}</button>
              <button className="settings-action settings-action-danger" type="button" disabled={busy} onClick={() => { void deleteSnapshot(snapshot) }}>{copy.settingsRecoveryDelete}</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
