import { useEffect, useState } from 'react'
import type { ChannelBridgeConfig } from '../../shared/channel-bridge.js'
import type { AppCopy } from '../../shared/locale.js'

const DEFAULT_CONFIG: ChannelBridgeConfig = {
  enabled: false,
  port: 17891,
  allowList: [],
  timeoutMs: 120_000,
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
          <span>{copy.channelBridgePort}</span>
          <input
            type="number"
            value={config.port}
            onChange={(e) => { update({ port: Number(e.target.value) }) }}
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
