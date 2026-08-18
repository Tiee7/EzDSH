import { useEffect, useState } from 'react'
import type { ChannelBridgeConfig } from '../../shared/channel-bridge.js'
import type { AppCopy } from '../../shared/locale.js'

interface ChannelBridgeSectionProps {
  copy: AppCopy
}

const DEFAULT_CONFIG: ChannelBridgeConfig = {
  enabled: false,
  port: 17891,
  allowList: [],
  timeoutMs: 120_000,
}

/** Channel bridge (Feishu remote control) settings. */
export function ChannelBridgeSection({ copy }: ChannelBridgeSectionProps): JSX.Element {
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

  const openConfigFile = async (): Promise<void> => {
    try {
      const path = await window.EzDSH.channelBridge.getConfigPath()
      await navigator.clipboard.writeText(path)
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="settings-item">
        <p className="settings-label">{copy.channelBridgeTitle ?? '远程控制'}</p>
        <p className="settings-hint">{copy.loading ?? '加载中…'}</p>
      </div>
    )
  }

  return (
    <div className="settings-item settings-item-column">
      <div>
        <p className="settings-label">{copy.channelBridgeTitle ?? '远程控制'}</p>
        <p className="settings-hint">
          {copy.channelBridgeHint ?? '通过飞书机器人远程向 DSH 发送命令。'}
        </p>
      </div>

      <label className="bridge-row">
        <span>{copy.channelBridgeEnabled ?? '启用远程控制'}</span>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => { update({ enabled: e.target.checked }) }}
        />
      </label>

      <label className="bridge-row">
        <span>{copy.channelBridgePort ?? '本地端口'}</span>
        <input
          type="number"
          value={config.port}
          onChange={(e) => { update({ port: Number(e.target.value) }) }}
        />
      </label>

      <label className="bridge-row">
        <span>{copy.channelBridgeTimeout ?? '超时（毫秒）'}</span>
        <input
          type="number"
          value={config.timeoutMs}
          onChange={(e) => { update({ timeoutMs: Number(e.target.value) }) }}
        />
      </label>

      <label className="bridge-row bridge-row-block">
        <span>{copy.channelBridgeAllowList ?? '白名单用户 Open ID（每行一个）'}</span>
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

      <label className="bridge-row">
        <span>{copy.channelBridgeWorkspace ?? 'DSH 工作目录'}</span>
        <input
          type="text"
          value={config.workspace ?? ''}
          placeholder="留空使用 EzDSH 启动目录"
          onChange={(e) => { update({ workspace: e.target.value || undefined }) }}
        />
      </label>

      <div className="bridge-subsection">
        <p className="settings-label">{copy.channelBridgeFeishu ?? '飞书机器人'}</p>
        <label className="bridge-row">
          <span>{copy.channelBridgeAppId ?? 'App ID'}</span>
          <input
            type="text"
            value={config.feishu?.appId ?? ''}
            onChange={(e) => { updateFeishu({ appId: e.target.value }) }}
          />
        </label>
        <label className="bridge-row">
          <span>{copy.channelBridgeAppSecret ?? 'App Secret'}</span>
          <input
            type="password"
            value={config.feishu?.appSecret ?? ''}
            onChange={(e) => { updateFeishu({ appSecret: e.target.value }) }}
          />
        </label>
        <label className="bridge-row">
          <span>{copy.channelBridgeEncryptKey ?? 'Encrypt Key（可选）'}</span>
          <input
            type="text"
            value={config.feishu?.encryptKey ?? ''}
            onChange={(e) => { updateFeishu({ encryptKey: e.target.value }) }}
          />
        </label>
      </div>

      {error ? <p className="settings-error">{error}</p> : null}
      {saved ? <p className="settings-hint">{copy.channelBridgeSaved ?? '已保存'}</p> : null}

      <div className="settings-actions">
        <button className="settings-action" disabled={saving} onClick={() => { void save() }}>
          {saving ? (copy.saving ?? '保存中…') : (copy.save ?? '保存')}
        </button>
        <button className="settings-action" onClick={() => { void openConfigFile() }}>
          {copy.channelBridgeCopyConfigPath ?? '复制配置路径'}
        </button>
      </div>
    </div>
  )
}
