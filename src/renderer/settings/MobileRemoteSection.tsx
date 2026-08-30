import { useEffect, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { MobileRemoteSnapshot } from '../../shared/mobile-remote.js'

interface MobileRemoteSectionProps {
  copy: AppCopy
}

function statusLabel(snapshot: MobileRemoteSnapshot, copy: AppCopy): string {
  if (snapshot.status === 'starting') return copy.mobileRemoteStatusStarting
  if (snapshot.status === 'error') return copy.mobileRemoteStatusError
  if (snapshot.status === 'ready') return copy.mobileRemoteStatusReady
  return copy.mobileRemoteStatusStopped
}

export function MobileRemoteSection({ copy }: MobileRemoteSectionProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<MobileRemoteSnapshot>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = async (): Promise<void> => {
    try {
      setSnapshot(await window.EzDSH.mobileRemote.getStatus())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.mobileRemoteOperationFailed)
    }
  }

  useEffect(() => {
    let active = true
    void window.EzDSH.mobileRemote.getStatus().then((next) => {
      if (active) setSnapshot(next)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : copy.mobileRemoteOperationFailed)
    })
    const timer = window.setInterval(() => {
      if (active && busy === undefined) void refresh()
    }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [busy, copy.mobileRemoteOperationFailed])

  const run = async (label: string, operation: () => Promise<MobileRemoteSnapshot>): Promise<void> => {
    if (busy !== undefined) return
    setBusy(label)
    setError(undefined)
    try {
      setSnapshot(await operation())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.mobileRemoteOperationFailed)
    } finally {
      setBusy(undefined)
    }
  }

  const copyUrl = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      setError(copy.mobileRemoteCopyFailed)
    }
  }

  return (
    <section className="settings-card mobile-remote-card">
      <div className="settings-card-header">
        <div className="settings-card-heading-row">
          <div>
            <h2 className="settings-card-title">{copy.mobileRemoteTitle}</h2>
            <p className="settings-card-description">{copy.mobileRemoteHint}</p>
          </div>
          <span className={`mobile-remote-status mobile-remote-status-${snapshot?.status ?? 'stopped'}`}>
            <span className="settings-dot" />{snapshot === undefined ? copy.loading : statusLabel(snapshot, copy)}
          </span>
        </div>
      </div>

      <div className="settings-card-content mobile-remote-content">
        <div className="mobile-remote-section-heading">
          <div>
            <p className="settings-label">{copy.mobileRemoteLanTitle}</p>
            <p className="settings-hint">{copy.mobileRemoteLanHint}</p>
          </div>
          <button className="settings-action settings-action-primary" type="button" disabled={busy !== undefined || snapshot?.status !== 'ready'} onClick={() => void run('pairing', () => window.EzDSH.mobileRemote.startPairing())}>
            {busy === 'pairing' ? copy.mobileRemotePairing : copy.mobileRemoteStartPairing}
          </button>
        </div>

        {snapshot?.lanUrls.length ? (
          <div className="mobile-remote-url-list">
            {snapshot.lanUrls.map((url) => <button key={url} type="button" className="mobile-remote-url" onClick={() => void copyUrl(url)} title={copy.mobileRemoteCopyUrl}>{url}</button>)}
          </div>
        ) : <p className="settings-hint">{copy.mobileRemoteUnavailable}</p>}

        {snapshot?.pairing.active && snapshot.pairing.qrDataUrl && snapshot.pairing.url ? (
          <div className="mobile-remote-pairing">
            <img className="mobile-remote-qr" src={snapshot.pairing.qrDataUrl} alt={copy.mobileRemoteQrAlt} />
            <div className="mobile-remote-pairing-info">
              <p className="settings-label">{copy.mobileRemoteQrTitle}</p>
              <p className="settings-hint">{copy.mobileRemoteQrHint}</p>
              <button type="button" className="mobile-remote-url" onClick={() => void copyUrl(snapshot.pairing.url!)}>{snapshot.pairing.url}</button>
              <button className="settings-action" type="button" disabled={busy !== undefined} onClick={() => void run('cancel-pairing', () => Promise.resolve(window.EzDSH.mobileRemote.cancelPairing()))}>{copy.mobileRemoteCancelPairing}</button>
            </div>
          </div>
        ) : null}

        {snapshot?.pendingPairings.length ? (
          <div className="mobile-remote-pending">
            <p className="settings-label">{copy.mobileRemotePendingTitle}</p>
            {snapshot.pendingPairings.map((pairing) => (
              <div className="mobile-remote-pending-row" key={pairing.requestId}>
                <div className="settings-item-text">
                  <span className="settings-value">{pairing.userAgent ?? copy.mobileRemoteUnknownDevice}</span>
                  <span className="settings-hint">{pairing.address ?? ''}</span>
                </div>
                {pairing.status === 'pending' ? (
                  <div className="settings-actions">
                    <button className="settings-action settings-action-primary" type="button" disabled={busy !== undefined} onClick={() => void run('approve', () => window.EzDSH.mobileRemote.approvePairing(pairing.requestId))}>{copy.mobileRemoteApprove}</button>
                    <button className="settings-action" type="button" disabled={busy !== undefined} onClick={() => void run('reject', () => window.EzDSH.mobileRemote.rejectPairing(pairing.requestId))}>{copy.mobileRemoteReject}</button>
                  </div>
                ) : <span className="settings-hint">{pairing.status === 'approved' ? copy.mobileRemoteApproved : copy.mobileRemoteRejected}</span>}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="settings-card-content mobile-remote-content">
        <div className="mobile-remote-section-heading">
          <div>
            <p className="settings-label">{copy.mobileRemotePublicTitle}</p>
            <p className="settings-hint">{copy.mobileRemotePublicHint}</p>
          </div>
          <button className="settings-action" type="button" disabled={busy !== undefined || snapshot?.status !== 'ready'} onClick={() => void run('public', () => snapshot?.publicAccess ? window.EzDSH.mobileRemote.stopPublicAccess() : window.EzDSH.mobileRemote.startPublicAccess())}>
            {busy === 'public' ? copy.mobileRemotePublicStarting : snapshot?.publicAccess ? copy.mobileRemotePublicStop : copy.mobileRemotePublicStart}
          </button>
        </div>
        {snapshot?.publicUrl ? <button type="button" className="mobile-remote-url" onClick={() => void copyUrl(snapshot.publicUrl!)} title={copy.mobileRemoteCopyUrl}>{snapshot.publicUrl}</button> : null}
        <p className="mobile-remote-warning">{copy.mobileRemotePublicWarning}</p>
      </div>

      <div className="settings-card-content mobile-remote-content">
        <div className="mobile-remote-section-heading">
          <div>
            <p className="settings-label">{copy.mobileRemoteDevicesTitle}</p>
            <p className="settings-hint">{copy.mobileRemoteDevicesHint}</p>
          </div>
        </div>
        {snapshot?.devices.length ? snapshot.devices.map((device) => (
          <div className="mobile-remote-device-row" key={device.id}>
            <div className="settings-item-text"><span className="settings-label">{device.label}</span><span className="settings-hint">{device.lastSeenAt}</span></div>
            <button className="settings-action settings-action-danger" type="button" disabled={busy !== undefined} onClick={() => void run('disconnect', () => Promise.resolve(window.EzDSH.mobileRemote.disconnectDevice(device.id)))}>{copy.mobileRemoteDisconnect}</button>
          </div>
        )) : <p className="settings-hint">{copy.mobileRemoteNoDevices}</p>}
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
