import { useEffect, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import { PROXY_PROTOCOLS, type ProxyProfile, type ProxyProfileInput, type ProxyProtocol, type ProxySettingsSnapshot, type ProxyTestResult } from '../../shared/proxy.js'

interface ProxySectionProps {
  copy: AppCopy
}

interface ProxyDraft {
  name: string
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  password: string
  bypass: string
}

const EMPTY_DRAFT: ProxyDraft = {
  name: '',
  protocol: 'http',
  host: '',
  port: '',
  username: '',
  password: '',
  bypass: '',
}

function draftFromProfile(profile: ProxyProfile): ProxyDraft {
  return {
    name: profile.name,
    protocol: profile.protocol,
    host: profile.host,
    port: String(profile.port),
    username: profile.username ?? '',
    password: '',
    bypass: profile.bypass.join('\n'),
  }
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)
}

function toProxyInput(draft: ProxyDraft, id?: string): ProxyProfileInput | 'name' | 'host' | 'port' {
  if (draft.name.trim() === '') return 'name'
  if (draft.host.trim() === '') return 'host'
  const port = Number(draft.port.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'port'
  return {
    ...(id === undefined ? {} : { id }),
    name: draft.name.trim(),
    protocol: draft.protocol,
    host: draft.host.trim(),
    port,
    ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
    ...(draft.password === '' ? {} : { password: draft.password }),
    bypass: splitLines(draft.bypass),
  }
}

function proxyDescription(profile: ProxyProfile): string {
  return `${profile.protocol.toUpperCase()}://${profile.host}:${String(profile.port)}${profile.username === undefined ? '' : ` · ${profile.username}`}`
}

/** Configure saved Runtime proxies while keeping the active profile single-select. */
export function ProxySection({ copy }: ProxySectionProps): JSX.Element {
  const [profiles, setProfiles] = useState<ProxyProfile[]>([])
  const [activeProxyId, setActiveProxyId] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<ProxyDraft>({ ...EMPTY_DRAFT })
  const [busyId, setBusyId] = useState<string>()
  const [testingId, setTestingId] = useState<string>()
  const [testState, setTestState] = useState<(ProxyTestResult & { id: string })>()
  const [error, setError] = useState<string>()

  const applySnapshot = (snapshot: ProxySettingsSnapshot): void => {
    setProfiles(snapshot.profiles)
    setActiveProxyId(snapshot.activeProxyId)
  }

  useEffect(() => {
    let active = true
    void window.EzDSH.settings.getProxyConfig()
      .then((snapshot) => {
        if (active) applySnapshot(snapshot)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : copy.settingsProxyOperationFailed)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => { active = false }
  }, [copy.settingsProxyOperationFailed])

  const beginAdd = (): void => {
    setEditingId('new')
    setDraft({ ...EMPTY_DRAFT })
    setError(undefined)
  }

  const beginEdit = (profile: ProxyProfile): void => {
    setEditingId(profile.id)
    setDraft(draftFromProfile(profile))
    setError(undefined)
  }

  const cancelEdit = (): void => {
    setEditingId(undefined)
    setDraft({ ...EMPTY_DRAFT })
  }

  const save = async (): Promise<void> => {
    const input = toProxyInput(draft, editingId === undefined || editingId === 'new' ? undefined : editingId)
    if (typeof input === 'string') {
      setError(input === 'name'
        ? `${copy.settingsProxyName} is required`
        : input === 'host'
          ? `${copy.settingsProxyHost} is required`
          : `${copy.settingsProxyPort} must be between 1 and 65535`)
      return
    }
    setBusyId(editingId ?? 'new')
    setError(undefined)
    try {
      applySnapshot(await window.EzDSH.settings.saveProxy(input))
      cancelEdit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsProxyOperationFailed)
    } finally {
      setBusyId(undefined)
    }
  }

  const activate = async (id: string | undefined): Promise<void> => {
    setBusyId(id ?? 'proxy-toggle')
    setError(undefined)
    try {
      applySnapshot(await window.EzDSH.settings.activateProxy(id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsProxyOperationFailed)
    } finally {
      setBusyId(undefined)
    }
  }

  const test = async (profile: ProxyProfile): Promise<void> => {
    setTestingId(profile.id)
    setTestState(undefined)
    setError(undefined)
    try {
      setTestState({ id: profile.id, ...(await window.EzDSH.settings.testProxy(profile.id)) })
    } catch (reason) {
      setTestState({
        id: profile.id,
        reachable: false,
        error: reason instanceof Error ? reason.message : copy.settingsProxyTestFailed,
      })
    } finally {
      setTestingId(undefined)
    }
  }

  const remove = async (profile: ProxyProfile): Promise<void> => {
    if (!window.confirm(`${copy.settingsProxyDeleteConfirm} ${profile.name}`)) return
    setBusyId(profile.id)
    setError(undefined)
    try {
      applySnapshot(await window.EzDSH.settings.deleteProxy(profile.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsProxyOperationFailed)
    } finally {
      setBusyId(undefined)
    }
  }

  const setField = <K extends keyof ProxyDraft>(field: K, value: ProxyDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  if (!loaded) return <section className="settings-card proxy-card"><p className="settings-hint proxy-loading">{copy.loading}</p></section>

  return (
    <section className="settings-card proxy-card">
      <div className="settings-card-header">
        <div className="settings-card-heading-row">
          <div>
            <h2 className="settings-card-title">{copy.settingsProxy}</h2>
            <p className="settings-card-description">{copy.settingsProxyHint}</p>
          </div>
          <button type="button" className="settings-action" onClick={beginAdd} disabled={editingId !== undefined || busyId !== undefined}>
            {copy.settingsProxyAdd}
          </button>
        </div>
      </div>

      {editingId !== undefined ? (
        <div className="settings-card-content">
          <div className="proxy-form">
            <label>
              {copy.settingsProxyName}
              <input value={draft.name} placeholder={copy.settingsProxyNamePlaceholder} onChange={(event) => setField('name', event.target.value)} autoFocus />
            </label>
            <div className="proxy-form-row">
              <label>
                {copy.settingsProxyProtocol}
                <select value={draft.protocol} onChange={(event) => setField('protocol', event.target.value as ProxyProtocol)}>
                  {PROXY_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>)}
                </select>
              </label>
              <label>
                {copy.settingsProxyHost}
                <input value={draft.host} placeholder={copy.settingsProxyHostPlaceholder} onChange={(event) => setField('host', event.target.value)} />
              </label>
              <label>
                {copy.settingsProxyPort}
                <input type="number" min="1" max="65535" value={draft.port} onChange={(event) => setField('port', event.target.value)} />
              </label>
            </div>
            <div className="proxy-form-row">
              <label>
                {copy.settingsProxyUsername}
                <input value={draft.username} placeholder={copy.settingsProxyUsernamePlaceholder} onChange={(event) => setField('username', event.target.value)} />
              </label>
              <label>
                {copy.settingsProxyPassword}
                <input type="password" value={draft.password} placeholder={copy.settingsProxyPasswordPlaceholder} onChange={(event) => setField('password', event.target.value)} />
                <span className="proxy-field-hint">{copy.settingsProxyPasswordHint}</span>
              </label>
            </div>
            <label>
              {copy.settingsProxyBypass}
              <textarea rows={3} value={draft.bypass} placeholder={copy.settingsProxyBypassPlaceholder} onChange={(event) => setField('bypass', event.target.value)} />
              <span className="proxy-field-hint">{copy.settingsProxyBypassHint}</span>
            </label>
            <div className="settings-actions">
              <button type="button" className="settings-action settings-action-primary" disabled={busyId !== undefined} onClick={() => void save()}>{copy.settingsProxySave}</button>
              <button type="button" className="settings-action" disabled={busyId !== undefined} onClick={cancelEdit}>{copy.settingsProxyCancel}</button>
            </div>
          </div>
        </div>
      ) : null}

      {profiles.length === 0 ? (
        <p className="proxy-empty">{copy.settingsProxyEmpty}</p>
      ) : (
        <ul className="proxy-list">
          {profiles.map((profile) => {
            const active = profile.id === activeProxyId
            const rowBusy = busyId === profile.id || busyId === 'proxy-toggle' || testingId === profile.id
            return (
              <li key={profile.id} className={`proxy-row ${active ? 'proxy-row-active' : ''}`}>
                <div className="proxy-main">
                  <div className="proxy-title-row">
                    <span className={`settings-dot ${active ? 'settings-dot-ready' : ''}`} aria-hidden="true" />
                    <span>{profile.name}</span>
                    <span className="proxy-badge">{active ? copy.settingsProxyActive : copy.settingsProxyInactive}</span>
                  </div>
                  <p className="proxy-meta">{proxyDescription(profile)}</p>
                  {profile.bypass.length > 0 ? <p className="proxy-meta">{`${copy.settingsProxyBypass}: ${profile.bypass.join(', ')}`}</p> : null}
                </div>
                <div className="proxy-controls">
                  <button type="button" className="settings-action" disabled={busyId !== undefined || testingId !== undefined} onClick={() => void test(profile)}>
                    {testingId === profile.id ? copy.settingsProxyTesting : copy.settingsProxyTest}
                  </button>
                  <button type="button" className={`settings-action ${active ? 'settings-action-primary' : ''}`} disabled={busyId !== undefined || testingId !== undefined} onClick={() => void activate(active ? undefined : profile.id)}>
                    {active ? copy.settingsProxyDisable : copy.settingsProxyEnable}
                  </button>
                  <button type="button" className="settings-action" disabled={busyId !== undefined || testingId !== undefined} onClick={() => beginEdit(profile)}>{copy.settingsProxyEdit}</button>
                  <button type="button" className="settings-action" disabled={busyId !== undefined || testingId !== undefined} onClick={() => void remove(profile)}>{copy.settingsProxyDelete}</button>
                  {rowBusy ? <span className="proxy-busy" aria-live="polite">{copy.loading}</span> : null}
                  {testState?.id === profile.id && !rowBusy ? (
                    <span className={`proxy-test-result ${testState.reachable ? 'proxy-test-result-success' : 'proxy-test-result-failed'}`} role="status">
                      {testState.reachable ? copy.settingsProxyTestSuccess : `${copy.settingsProxyTestFailed}${testState.error === undefined ? '' : `: ${testState.error}`}`}
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {error !== undefined ? <p className="settings-error proxy-error" role="alert">{error}</p> : null}
    </section>
  )
}
