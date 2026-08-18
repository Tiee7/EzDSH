import { useEffect, useState } from 'react'
import type { ChannelBridgeConfig, DshSessionSummary } from '../../shared/channel-bridge.js'
import type { AppCopy } from '../../shared/locale.js'

const DEFAULT_CONFIG: ChannelBridgeConfig = {
  enabled: false,
  allowList: [],
  timeoutMs: 120_000,
  sessionTimeoutMs: 300_000,
  statusIntervalMs: 60_000,
}

interface ChannelBridgePageProps {
  copy: AppCopy
}

/** Remote-control settings page: Feishu bot integration. */
export function ChannelBridgePage({ copy }: ChannelBridgePageProps): JSX.Element {
  const [config, setConfig] = useState<ChannelBridgeConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [sessions, setSessions] = useState<DshSessionSummary[]>([])
  const [listingSessions, setListingSessions] = useState(false)

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

  const update = (patch: Partial<ChannelBridgeConfig>): void => {
    setConfig((prev) => ({ ...prev, ...patch }))
    setSaved(false)
  }

  const updateFeishu = (patch: Partial<NonNullable<ChannelBridgeConfig['feishu']>>): void => {
    setConfig((prev) => ({
      ...prev,
      feishu: { ...prev.feishu, ...patch } as NonNullable<ChannelBridgeConfig['feishu']>,
    }))
    setSaved(false)
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
      <div className="settings-item settings-item-column">
        <div>
          <p className="settings-label">{copy.channelBridgeTitle}</p>
          <p className="settings-hint">{copy.channelBridgeHint}</p>
        </div>

        <label className="bridge-row">
          <span>{copy.channelBridgeEnabled}</span>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => { update({ enabled: e.target.checked }) }}
          />
        </label>

        <label className="bridge-row">
          <span>{copy.channelBridgeAppId}</span>
          <input
            type="text"
            value={config.feishu?.appId ?? ''}
            placeholder="cli_xxxxxxxx"
            onChange={(e) => { updateFeishu({ appId: e.target.value }) }}
          />
        </label>

        <label className="bridge-row">
          <span>{copy.channelBridgeAppSecret}</span>
          <input
            type="password"
            value={config.feishu?.appSecret ?? ''}
            onChange={(e) => { updateFeishu({ appSecret: e.target.value }) }}
          />
        </label>

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
                  <code className="bridge-session-id" title={session.sessionId}>
                    {session.sessionId}
                  </code>
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
