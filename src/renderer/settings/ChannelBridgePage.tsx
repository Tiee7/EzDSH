import { useEffect, useState } from 'react'
import type { AdapterConfig, ChannelBridgeConfig, DshSessionSummary, PairingState } from '../../shared/channel-bridge.js'
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
  sessionId?: string
  allowList: string[]
}

type PlatformTab = 'general' | 'feishu' | 'qq' | 'wechat'

interface PlatformDef {
  id: PlatformTab
  label: string
  disabled?: boolean
  badge?: string
}

function getFeishuConfig(adapters: Record<string, AdapterConfig>): FeishuConfig {
  const raw = adapters.feishu
  if (raw !== undefined) {
    return {
      appId: String(raw.appId ?? ''),
      appSecret: String(raw.appSecret ?? ''),
      encryptKey: String(raw.encryptKey ?? ''),
      sessionId: raw.sessionId,
      allowList: Array.isArray(raw.allowList) ? raw.allowList : [],
    }
  }
  return { appId: '', appSecret: '', encryptKey: '', allowList: [] }
}

function isFeishuReady(config: ChannelBridgeConfig): boolean {
  const feishu = getFeishuConfig(config.adapters)
  return feishu.appId.trim() !== '' && feishu.appSecret.trim() !== ''
}

interface ChannelBridgePageProps {
  copy: AppCopy
}

/** Remote-control settings: one full page per IM platform. */
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
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformTab>('feishu')

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
    updateFeishu({ sessionId })
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

  const platforms: PlatformDef[] = [
    { id: 'general', label: copy.remoteControlGeneral },
    { id: 'feishu', label: copy.remoteControlFeishuNav },
    { id: 'qq', label: copy.remoteControlQQ, disabled: true, badge: copy.remoteControlComingSoon },
    { id: 'wechat', label: copy.remoteControlWeChat, disabled: true, badge: copy.remoteControlComingSoon },
  ]

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
      </div>

      <div className="settings-card-content bridge-platform-layout">
        <nav className="bridge-platform-nav" aria-label={copy.remoteControlIMPlatforms}>
          <p className="bridge-platform-nav-title">{copy.remoteControlIMPlatforms}</p>
          <div className="bridge-platform-nav-list" role="tablist">
            {platforms.map((platform) => (
              <button
                key={platform.id}
                type="button"
                role="tab"
                aria-selected={selectedPlatform === platform.id}
                disabled={platform.disabled}
                className={`bridge-platform-nav-item ${selectedPlatform === platform.id ? 'bridge-platform-nav-item-active' : ''}`}
                onClick={() => { setSelectedPlatform(platform.id) }}
              >
                {platform.label}
                {platform.badge ? <span className="bridge-platform-nav-badge">{platform.badge}</span> : null}
              </button>
            ))}
          </div>
        </nav>

        <div className="bridge-platform-content">
          {selectedPlatform === 'general' && (
            <GeneralPage copy={copy} config={config} update={update} />
          )}

          {selectedPlatform === 'feishu' && (
            <FeishuPage
              copy={copy}
              config={config}
              updateFeishu={updateFeishu}
              sessions={sessions}
              listingSessions={listingSessions}
              listSessions={listSessions}
              selectSession={selectSession}
              pairing={pairing}
              pairingError={pairingError}
              pairingSuccess={pairingSuccess}
              pairingSecondsLeft={pairingSecondsLeft}
              startPairing={startPairing}
              cancelPairing={cancelPairing}
            />
          )}

          {selectedPlatform === 'qq' && (
            <PlaceholderPage title={copy.remoteControlQQ} hint={copy.remoteControlComingSoon} />
          )}

          {selectedPlatform === 'wechat' && (
            <PlaceholderPage title={copy.remoteControlWeChat} hint={copy.remoteControlComingSoon} />
          )}
        </div>
      </div>

      <div className="settings-card-content">
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

interface GeneralPageProps {
  copy: AppCopy
  config: ChannelBridgeConfig
  update: (patch: Partial<ChannelBridgeConfig>) => void
}

function GeneralPage({ copy, config, update }: GeneralPageProps): JSX.Element {
  return (
    <div className="bridge-platform-page">
      <h3 className="bridge-platform-page-title">{copy.remoteControlGeneral}</h3>
      <p className="bridge-platform-page-hint">{copy.remoteControlGeneralHint}</p>

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
    </div>
  )
}

interface FeishuPageProps {
  copy: AppCopy
  config: ChannelBridgeConfig
  updateFeishu: (patch: Partial<FeishuConfig>) => void
  sessions: DshSessionSummary[]
  listingSessions: boolean
  listSessions: () => Promise<void>
  selectSession: (sessionId: string) => void
  pairing: PairingState
  pairingError?: string
  pairingSuccess: boolean
  pairingSecondsLeft: () => number
  startPairing: () => Promise<void>
  cancelPairing: () => Promise<void>
}

function FeishuPage({
  copy,
  config,
  updateFeishu,
  sessions,
  listingSessions,
  listSessions,
  selectSession,
  pairing,
  pairingError,
  pairingSuccess,
  pairingSecondsLeft,
  startPairing,
  cancelPairing,
}: FeishuPageProps): JSX.Element {
  const feishu = getFeishuConfig(config.adapters)
  const feishuReady = isFeishuReady(config)

  return (
    <div className="bridge-platform-page">
      <h3 className="bridge-platform-page-title">{copy.remoteControlFeishuTitle}</h3>
      <p className="bridge-platform-page-hint">{copy.remoteControlFeishuHint}</p>

      {config.enabled && !feishuReady ? (
        <p className="settings-error">{copy.remoteControlFeishuIncomplete}</p>
      ) : null}

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

      <label className="bridge-row">
        <span>{copy.channelBridgeSessionId}</span>
        <input
          type="text"
          value={feishu.sessionId ?? ''}
          placeholder={copy.channelBridgeSessionIdPlaceholder}
          onChange={(e) => { updateFeishu({ sessionId: e.target.value }) }}
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

      <label className="bridge-row bridge-row-block">
        <span>{copy.channelBridgeAllowList}</span>
        <textarea
          rows={4}
          value={feishu.allowList.join('\n')}
          onChange={(e) => {
            updateFeishu({
              allowList: e.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }}
        />
      </label>

      <div className="bridge-subsection">
        <div className="bridge-subsection-header">
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
  )
}

interface PlaceholderPageProps {
  title: string
  hint: string
}

function PlaceholderPage({ title, hint }: PlaceholderPageProps): JSX.Element {
  return (
    <div className="bridge-platform-page">
      <h3 className="bridge-platform-page-title">{title}</h3>
      <p className="bridge-platform-page-hint">{hint}</p>
    </div>
  )
}
