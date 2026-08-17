import { useEffect, useMemo, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { ProviderDefinition, ProviderStatus } from '../../shared/providers.js'
import { providerBadge } from './settings-display.js'

/** Provider management: preset card grid with an inline add/replace key form. */
export function ProviderSection({ copy }: { copy: AppCopy }): JSX.Element {
  const [definitions, setDefinitions] = useState<readonly ProviderDefinition[]>()
  const [statuses, setStatuses] = useState<readonly ProviderStatus[]>()
  const [loadError, setLoadError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [testMessage, setTestMessage] = useState<string>()
  const [statusMessage, setStatusMessage] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const statusById = useMemo(() => {
    const map = new Map<string, ProviderStatus>()
    for (const status of statuses ?? []) map.set(status.providerId, status)
    return map
  }, [statuses])

  const definition = useMemo(
    () => definitions?.find((candidate) => candidate.id === providerId),
    [definitions, providerId]
  )

  const configuredStatuses = useMemo(
    () => (statuses ?? []).filter((status) => status.hasCredential || status.routeConfigured),
    [statuses]
  )

  const load = async (): Promise<void> => {
    setLoadError(false)
    try {
      const [nextDefinitions, nextStatuses] = await Promise.all([
        window.EzDSH.providers.listDefinitions(),
        window.EzDSH.providers.getStatus()
      ])
      setDefinitions(nextDefinitions)
      setStatuses(nextStatuses)
    } catch {
      setLoadError(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const openForm = (next: ProviderDefinition): void => {
    setAdding(true)
    setProviderId(next.id)
    setApiKey('')
    setBaseUrl(next.defaultBaseUrl ?? '')
    setTestMessage(undefined)
    setStatusMessage(undefined)
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestMessage(undefined)
    try {
      const result = await window.EzDSH.providers.testConnection({
        providerId,
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
      })
      setTestMessage(result.message)
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : copy.connectionTestFailed)
    } finally {
      setTesting(false)
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setStatusMessage(undefined)
    try {
      await window.EzDSH.providers.save({
        providerId,
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
      })
      setApiKey('')
      setAdding(false)
      await load()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const cancel = (): void => {
    setAdding(false)
    setProviderId('')
    setApiKey('')
    setBaseUrl('')
    setTestMessage(undefined)
    setStatusMessage(undefined)
  }

  if (definitions === undefined || statuses === undefined) {
    return (
      <section className="settings-card">
        <header className="settings-card-header">
          <h3 className="settings-card-title">{copy.settingsProviders}</h3>
          <p className="settings-card-description">{copy.settingsProvidersHint}</p>
        </header>
        <div className="settings-item">
          <p className="settings-label">{loadError ? copy.storeLoadFailed : copy.storeLoading}</p>
          {loadError ? (
            <button className="settings-action" onClick={() => { void load() }}>
              {copy.storeRetry}
            </button>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <section className="settings-card">
      <header className="settings-card-header">
        <h3 className="settings-card-title">{copy.settingsProviders}</h3>
        <p className="settings-card-description">{copy.settingsProvidersHint}</p>
      </header>
      {configuredStatuses.length > 0 ? (
        <div className="settings-card-content">
          <ul className="provider-status-list">
            {configuredStatuses.map((status) => {
              const def = definitions.find((candidate) => candidate.id === status.providerId)
              const badge = providerBadge(status)
              return (
                <li key={status.providerId} className="provider-status-item">
                  <span className="provider-status-name">{def?.displayName ?? status.providerId}</span>
                  <span className={`provider-badge provider-badge-${badge}`}>
                    {badge === 'usable' ? copy.settingsProviderUsable : copy.settingsProviderConfigured}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {!adding ? (
        <div className="settings-card-content">
          <button
            className="settings-action"
            onClick={() => {
              const first = definitions[0]
              if (first !== undefined) openForm(first)
            }}
          >
            {copy.settingsProviderAdd}
          </button>
        </div>
      ) : (
        <div className="settings-card-content">
          <div className="provider-card-grid" role="listbox" aria-label={copy.settingsProviderAdd}>
            {definitions.map((candidate) => {
              const badge = providerBadge(statusById.get(candidate.id))
              return (
                <button
                  key={candidate.id}
                  role="option"
                  aria-selected={candidate.id === providerId}
                  className={`provider-card ${candidate.id === providerId ? 'provider-card-active' : ''}`}
                  onClick={() => { openForm(candidate) }}
                >
                  <span className="provider-card-name">{candidate.displayName}</span>
                  {candidate.defaultBaseUrl ? (
                    <span className="provider-card-url">{candidate.defaultBaseUrl}</span>
                  ) : null}
                  {badge !== 'empty' ? (
                    <span className={`provider-badge provider-badge-${badge}`}>
                      {badge === 'usable' ? copy.settingsProviderUsable : copy.settingsProviderConfigured}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {definition !== undefined ? (
            <form className="provider-form" onSubmit={submit}>
              <label>
                API Key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => { setApiKey(event.target.value) }}
                  placeholder={copy.apiKeyPlaceholder}
                  autoComplete="off"
                  required
                  disabled={saving}
                />
              </label>
              <label>
                {copy.baseUrl}{' '}
                <span className="provider-optional">({copy.optional})</span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(event) => { setBaseUrl(event.target.value) }}
                  placeholder={definition.defaultBaseUrl ?? copy.baseUrlPlaceholder}
                  disabled={saving}
                />
              </label>
              <div className="settings-actions">
                <button
                  className="settings-action"
                  type="submit"
                  disabled={saving || testing || apiKey.trim() === ''}
                >
                  {saving ? copy.saving : copy.settingsProviderSave}
                </button>
                <button
                  className="settings-action"
                  type="button"
                  onClick={() => { void testConnection() }}
                  disabled={saving || testing || apiKey.trim() === ''}
                >
                  {testing ? copy.testing : copy.testConnection}
                </button>
                <button
                  className="settings-action"
                  type="button"
                  onClick={cancel}
                  disabled={saving || testing}
                >
                  {copy.storeCancel}
                </button>
              </div>
              {statusMessage ? <p className="settings-error">{statusMessage}</p> : null}
              {testMessage ? <p className="settings-success">{testMessage}</p> : null}
            </form>
          ) : null}
        </div>
      )}
    </section>
  )
}
