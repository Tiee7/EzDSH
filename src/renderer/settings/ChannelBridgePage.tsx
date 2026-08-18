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

interface ChannelBridgePageProps {
  copy: AppCopy
}

/** Remote-control settings page: configure IM adapters generically. */
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
  const [selectedAdapter, setSelectedAdapter] = useState<string>()
  const [newAdapterName, setNewAdapterName] = useState('')
  const [adapterConfigJson, setAdapterConfigJson] = useState<Record<string, string>>({})

  useEffect(() => {
    window.EzDSH.channelBridge
      .getConfig()
      .then((loaded) => {
        setConfig(loaded)
        const json: Record<string, string> = {}
        for (const [name, value] of Object.entries(loaded.adapters)) {
          json[name] = JSON.stringify(value, null, 2)
        }
        setAdapterConfigJson(json)
        const adapterNames = Object.keys(loaded.adapters)
        if (adapterNames.length > 0) {
          setSelectedAdapter(adapterNames[0])
        }
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
                const json: Record<string, string> = {}
                for (const [name, value] of Object.entries(loaded.adapters)) {
                  json[name] = JSON.stringify(value, null, 2)
                }
                setAdapterConfigJson(json)
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

  const updateAdapterJson = (name: string, json: string): void => {
    setAdapterConfigJson((prev) => ({ ...prev, [name]: json }))
    setSaved(false)
  }

  const parseAdaptersFromJson = (): Record<string, unknown> | undefined => {
    const adapters: Record<string, unknown> = {}
    for (const [name, json] of Object.entries(adapterConfigJson)) {
      if (json.trim() === '') {
        adapters[name] = {}
        continue
      }
      try {
        adapters[name] = JSON.parse(json) as unknown
      } catch {
        setError(copy.channelBridgeAdapterConfigInvalid)
        return undefined
      }
    }
    return adapters
  }

  const addAdapter = (): void => {
    const name = newAdapterName.trim().toLowerCase()
    if (name === '' || config.adapters[name] !== undefined) return
    setConfig((prev) => ({
      ...prev,
      adapters: { ...prev.adapters, [name]: {} },
    }))
    setAdapterConfigJson((prev) => ({ ...prev, [name]: '{}' }))
    setSelectedAdapter(name)
    setNewAdapterName('')
    setSaved(false)
  }

  const removeAdapter = (name: string): void => {
    setConfig((prev) => {
      const next = { ...prev.adapters }
      delete next[name]
      return { ...prev, adapters: next }
    })
    setAdapterConfigJson((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    setSelectedAdapter((current) => {
      if (current !== name) return current
      const remaining = Object.keys(config.adapters).filter((n) => n !== name)
      return remaining[0]
    })
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const adapters = parseAdaptersFromJson()
      if (adapters === undefined) {
        setSaving(false)
        return
      }
      const nextConfig = { ...config, adapters }
      await window.EzDSH.channelBridge.setConfig(nextConfig)
      setConfig(nextConfig)
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

  const adapterNames = Object.keys(config.adapters)
  const hasAdapters = adapterNames.length > 0

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

        <div className="bridge-row bridge-row-block">
          <span className="settings-label">{copy.channelBridgeAdapters}</span>

          {!hasAdapters ? (
            <p className="settings-hint">{copy.channelBridgeNoAdapters}</p>
          ) : (
            <>
              <div className="bridge-adapter-tabs">
                {adapterNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`bridge-adapter-tab ${selectedAdapter === name ? 'bridge-adapter-tab-active' : ''}`}
                    onClick={() => { setSelectedAdapter(name) }}
                  >
                    {name}
                  </button>
                ))}
              </div>

              {selectedAdapter !== undefined && (
                <div className="bridge-adapter-editor">
                  <label className="bridge-row bridge-row-block">
                    <span>{copy.channelBridgeAdapterConfig}</span>
                    <textarea
                      rows={10}
                      value={adapterConfigJson[selectedAdapter] ?? '{}'}
                      onChange={(e) => { updateAdapterJson(selectedAdapter, e.target.value) }}
                    />
                  </label>
                  <button
                    type="button"
                    className="settings-action settings-action-small settings-action-secondary"
                    onClick={() => { removeAdapter(selectedAdapter) }}
                  >
                    {copy.channelBridgeRemoveAdapter}
                  </button>
                </div>
              )}
            </>
          )}

          <div className="bridge-add-adapter">
            <input
              type="text"
              value={newAdapterName}
              placeholder={copy.channelBridgeAdapterName}
              onChange={(e) => { setNewAdapterName(e.target.value) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addAdapter()
                }
              }}
            />
            <button
              type="button"
              className="settings-action settings-action-secondary"
              disabled={newAdapterName.trim() === ''}
              onClick={() => { addAdapter() }}
            >
              {copy.channelBridgeAddAdapter}
            </button>
          </div>
        </div>

        <div className="bridge-row bridge-row-block bridge-pairing-box">
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
              disabled={!config.enabled || !hasAdapters}
              onClick={() => { void startPairing() }}
            >
              {copy.channelBridgeStartPairing}
            </button>
          )}

          {pairingSuccess ? <p className="settings-hint">{copy.channelBridgePairingSuccess}</p> : null}
          {pairingError ? <p className="settings-error">{copy.channelBridgePairingFailed}: {pairingError}</p> : null}
        </div>

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
