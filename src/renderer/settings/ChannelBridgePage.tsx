import { useEffect, useState } from 'react'
import type { ChannelBridgeConfig, DshSessionSummary, PairingState } from '../../shared/channel-bridge.js'
import type { AppCopy } from '../../shared/locale.js'

const DEFAULT_CONFIG: ChannelBridgeConfig = {
  enabled: false,
  adapters: {},
  allowList: [],
  timeoutMs: 120_000,
  sessionTimeoutMs: 300_000,
  statusIntervalMs: 60_000,
}

interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey: string
}

function getFeishuConfig(adapters: Record<string, unknown>): FeishuConfig {
  const raw = adapters.feishu
  if (raw !== undefined && typeof raw === 'object') {
    const cfg = raw as Record<string, unknown>
    return {
      appId: String(cfg.appId ?? ''),
      appSecret: String(cfg.appSecret ?? ''),
      encryptKey: String(cfg.encryptKey ?? ''),
    }
  }
  return { appId: '', appSecret: '', encryptKey: '' }
}

function isFeishuReady(config: ChannelBridgeConfig): boolean {
  const feishu = getFeishuConfig(config.adapters)
  return feishu.appId.trim() !== '' && feishu.appSecret.trim() !== ''
}

interface ChannelBridgePageProps {
  copy: AppCopy
}

/** Remote-control settings page: one friendly form per supported IM platform. */
export function ChannelBridgePage({ copy }: ChannelBridgePageProps): JSX.Element {
  const [config, setConfig] = useState<ChannelBridgeConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [sessions, setSessions] = useState<DshSessionSummary[]>([])
  const [listingSessions, setListingSessions] = useState(false)
  const [pairing, setPairing] = useState<PairingState>({ active: false })
  const [pairingError, setPairingError] = useState<string>()
  const [pairingSuccess, setPairingSuccess] = useState(false)

  useEffect(() => {
    window.EzDSH.channelBridge
      .getConfig()
      .then((loaded) => {
        setConfig(loaded)
        setLoading(false)
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const state = await window.EzDSH.channelBridge.getPairingState()
        if (cancelled) return
        setPairing((prev) => {
          if (prev.active && !state.active) {
            window.EzDSH.channelBridge
              .getConfig()
              .then((loaded) => {
                setConfig(loaded)
              })
              .catch(() => {})
            setPairingSuccess(true)
            setTimeout(() => {
              setPairingSuccess(false)
            }, 5000)
          }
          return state
        })
      } catch (reason) {
        // Ignore polling errors.
      }
    }

    void tick()
    const interval = setInterval(() => {
      void tick()
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const update = (patch: Partial<ChannelBridgeConfig>): void => {
    setConfig((prev) => ({ ...prev, ...patch }))
    setSaved(false)
  }

  const updateFeishu = (patch: Partial<FeishuConfig>): void => {
    const current = getFeishuConfig(config.adapters)
    const next = { ...current, ...patch }
    update({
      adapters: {
        ...config.adapters,
        feishu: next,
      },
    })
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await window.EzDSH.channelBridge.setConfig(config)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const listSessions = async (): Promise<void> => {
    setListingSessions(true)
    setError(undefined)
    try {
      const items = await window.EzDSH.channelBridge.listSessions()
      setSessions(items)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSessions([])
    } finally {
      setListingSessions(false)
    }
  }

  const selectSession = (sessionId: string): void => {
    update({ sessionId })
  }

  const startPairing = async (): Promise<void> => {
    setPairingError(undefined)
    setPairingSuccess(false)
    try {
      const state = await window.EzDSH.channelBridge.startPairing()
      setPairing(state)
    } catch (reason) {
      setPairingError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const cancelPairing = async (): Promise<void> => {
    try {
      await window.EzDSH.channelBridge.cancelPairing()
      setPairing({ active: false })
    } catch (reason) {
      setPairingError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const pairingSecondsLeft = (): number => {
    if (!pairing.active || pairing.expiresAt === undefined) return 0
    const left = Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000))
    return left
  }

  const feishu = getFeishuConfig(config.adapters)
  const feishuReady = isFeishuReady(config)

  if (loading) {
    return (
      <div className="settings-card">
        <div className="settings-item">
          <p className="settings-label">{copy.channelBridgeTitle}</p>
          <p className="settings-hint">{copy.loading}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h2 className="settings-card-title">{copy.channelBridgeTitle}</h2>
        <p className="settings-card-description">{copy.channelBridgeHint}</p>
      </div>

      <div className="settings-card-content">
        <label className="bridge-row">
          <span>{copy.channelBridgeEnabled}</span>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => { update({ enabled: e.target.checked }) }}
          />
        </label>

        {config.enabled && !feishuReady ? (
          <p className="settings-error">{copy.remoteControlFeishuIncomplete}</p>
        ) : null}
      </div>

      <div className="settings-card-content">
        <div className="bridge-subsection">
          <div className="bridge-subsection-header">
            <span className="settings-label">{copy.remoteControlFeishuTitle}</span>
            <p className="settings-hint">{copy.remoteControlFeishuHint}</p>
          </div>

          <label className="bridge-row">
            <span>{copy.remoteControlFeishuAppId}</span>
            <input
              type="text"
              value={feishu.appId}
              placeholder={copy.remoteControlFeishuAppIdPlaceholder}
              onChange={(e) => { updateFeishu({ appId: e.target.value }) }}
            />
          </label>

          <label className="bridge-row">
            <span>{copy.remoteControlFeishuAppSecret}</span>
            <input
              type="password"
              value={feishu.appSecret}
              placeholder={copy.remoteControlFeishuAppSecretPlaceholder}
              onChange={(e) => { updateFeishu({ appSecret: e.target.value }) }}
            />
          </label>

          <label className="bridge-row">
            <span>{copy.remoteControlFeishuEncryptKey}</span>
            <input
              type="text"
              value={feishu.encryptKey}
              placeholder={copy.optional}
              onChange={(e) => { updateFeishu({ encryptKey: e.target.value }) }}
            />
          </label>
        </div>
      </div>

      <div className="settings-card-content">
        <div className="bridge-subsection">
          <div className="bridge-pairing-header">
            <span className="settings-label">{copy.channelBridgePairTitle}</span>
            <p className="settings-hint">{copy.channelBridgePairHint}</p>
          </div>

          {pairing.active && pairing.code !== undefined ? (
            <div className="bridge-pairing-active">
              <div className="bridge-pairing-code">{pairing.code}</div>
              <p className="settings-hint">
                {copy.channelBridgePairingCodeHint(pairing.code, pairingSecondsLeft())}
              </p>
              <button
                className="settings-action settings-action-small"
                onClick={() => { void cancelPairing() }}
              >
                {copy.channelBridgeCancelPairing}
              </button>
            </div>
          ) : (
            <button
              className="settings-action settings-action-secondary"
              disabled={!config.enabled || !feishuReady}
              onClick={() => { void startPairing() }}
            >
              {copy.channelBridgeStartPairing}
            </button>
          )}

          {pairingSuccess ? <p className="settings-hint">{copy.channelBridgePairingSuccess}</p> : null}
          {pairingError ? <p className="settings-error">{copy.channelBridgePairingFailed}: {pairingError}</p> : null}
        </div>
      </div>

      <div className="settings-card-content">
        <label className="bridge-row">
          <span>{copy.channelBridgeSessionId}</span>
          <input
            type="text"
            value={config.sessionId ?? ''}
            placeholder={copy.channelBridgeSessionIdPlaceholder}
            onChange={(e) => { update({ sessionId: e.target.value }) }}
          />
        </label>

        <div className="bridge-row bridge-row-block">
          <button
            className="settings-action settings-action-secondary"
            disabled={listingSessions}
            onClick={() => { void listSessions() }}
          >
            {listingSessions ? copy.channelBridgeListingSessions : copy.channelBridgeListSessions}
          </button>

          {sessions.length > 0 ? (
            <div className="bridge-session-list">
              {sessions.map((session) => (
                <div key={session.sessionId} className="bridge-session-item">
                  <div className="bridge-session-info">
                    <span className="bridge-session-title" title={session.title ?? session.sessionId}>
                      {session.title ?? copy.channelBridgeUntitledSession}
                    </span>
                    <code className="bridge-session-id" title={session.sessionId}>
                      {session.sessionId}
                    </code>
                  </div>
                  <span className="bridge-session-meta">
                    {session.running ? copy.channelBridgeSessionRunning : copy.channelBridgeSessionIdle}
                  </span>
                  <button
                    className="settings-action settings-action-small"
                    onClick={() => { selectSession(session.sessionId) }}
                  >
                    {copy.channelBridgeUseSession}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="settings-card-content">
        <label className="bridge-row">
          <span>{copy.channelBridgeSessionTimeout}</span>
          <input
            type="number"
            value={config.sessionTimeoutMs}
            onChange={(e) => { update({ sessionTimeoutMs: Number(e.target.value) }) }}
          />
        </label>

        <label className="bridge-row">
          <span>{copy.channelBridgeStatusInterval}</span>
          <input
            type="number"
            value={config.statusIntervalMs}
            onChange={(e) => { update({ statusIntervalMs: Number(e.target.value) }) }}
          />
        </label>

        <label className="bridge-row bridge-row-block">
          <span>{copy.channelBridgeAllowList}</span>
          <textarea
            rows={4}
            value={config.allowList.join('\n')}
            onChange={(e) => {
              update({
                allowList: e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              })
            }}
          />
        </label>

        {error ? <p className="settings-error">{error}</p> : null}
        {saved ? <p className="settings-hint">{copy.channelBridgeSaved}</p> : null}

        <div className="settings-actions">
          <button className="settings-action" disabled={saving} onClick={() => { void save() }}>
            {saving ? copy.saving : copy.save}
          </button>
        </div>
      </div>
    </div>
  )
}
