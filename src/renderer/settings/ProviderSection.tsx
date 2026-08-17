import { useEffect, useMemo, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type {
  ProviderDefinition,
  ProviderModel,
  ProviderProfile,
  ProviderStatus
} from '../../shared/providers.js'
import { providerBadge } from './settings-display.js'

/** Provider management: preset card grid with an inline add/replace key form and model selection. */
export function ProviderSection({ copy }: { copy: AppCopy }): JSX.Element {
  const [definitions, setDefinitions] = useState<readonly ProviderDefinition[]>()
  const [statuses, setStatuses] = useState<readonly ProviderStatus[]>()
  const [loadError, setLoadError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string>()
  const [providerId, setProviderId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<ProviderModel[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set())
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelsMessage, setModelsMessage] = useState<string>()
  const [testMessage, setTestMessage] = useState<string>()
  const [statusMessage, setStatusMessage] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const effectiveProviderId = editingProviderId ?? providerId
  const isEditing = editingProviderId !== undefined

  const statusById = useMemo(() => {
    const map = new Map<string, ProviderStatus>()
    for (const status of statuses ?? []) map.set(status.providerId, status)
    return map
  }, [statuses])

  const definition = useMemo(
    () => definitions?.find((candidate) => candidate.id === effectiveProviderId),
    [definitions, effectiveProviderId]
  )

  const configuredStatuses = useMemo(
    () => (statuses ?? []).filter((status) => status.routeConfigured),
    [statuses]
  )

  const load = async (active = true): Promise<void> => {
    setLoadError(false)
    try {
      const [nextDefinitions, nextStatuses] = await Promise.all([
        window.EzDSH.providers.listDefinitions(),
        window.EzDSH.providers.getStatus()
      ])
      if (active) {
        setDefinitions(nextDefinitions)
        setStatuses(nextStatuses)
      }
    } catch {
      if (active) setLoadError(true)
    }
  }

  useEffect(() => {
    let active = true
    void load(active)
    return () => {
      active = false
    }
  }, [])

  const openForm = (next: ProviderDefinition, profile?: ProviderProfile): void => {
    if (profile === undefined) {
      setAdding(true)
      setEditingProviderId(undefined)
      setProviderId(next.id)
    } else {
      setAdding(false)
      setEditingProviderId(next.id)
      setProviderId(next.id)
    }
    setApiKey('')
    setBaseUrl(profile?.baseUrl ?? next.defaultBaseUrl ?? '')
    setModels([])
    setSelectedModelIds(new Set(profile?.modelIds ?? []))
    setModelsMessage(undefined)
    setTestMessage(undefined)
    setStatusMessage(undefined)
  }

  const startAdd = (): void => {
    const first = definitions?.[0]
    if (first !== undefined) openForm(first)
  }

  const startEdit = async (id: string): Promise<void> => {
    const def = definitions?.find((candidate) => candidate.id === id)
    if (def === undefined) return
    setStatusMessage(undefined)
    try {
      const profile = await window.EzDSH.providers.getProfile(id)
      openForm(def, profile ?? undefined)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : copy.saveFailed)
    }
  }

  const fetchModels = async (): Promise<void> => {
    if (definition === undefined) return
    setFetchingModels(true)
    setModelsMessage(undefined)
    try {
      const result = await window.EzDSH.providers.listModels({
        providerId: effectiveProviderId,
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
      })
      if (result.length === 0) {
        setModels([])
        setSelectedModelIds(new Set())
        setModelsMessage(copy.settingsProviderModelsEmpty)
        return
      }
      setModels(result)
      const nextSelected = new Set<string>()
      for (const model of result) {
        if (selectedModelIds.size === 0 || selectedModelIds.has(model.id)) {
          nextSelected.add(model.id)
        }
      }
      setSelectedModelIds(nextSelected)
    } catch (error) {
      setModels([])
      setSelectedModelIds(new Set())
      setModelsMessage(error instanceof Error ? error.message : copy.settingsProviderFetchFailed)
    } finally {
      setFetchingModels(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestMessage(undefined)
    try {
      const result = await window.EzDSH.providers.testConnection({
        providerId: effectiveProviderId,
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
    if (selectedModelIds.size === 0) {
      setStatusMessage(copy.settingsProviderModelsRequired)
      return
    }
    setSaving(true)
    setStatusMessage(undefined)
    try {
      await window.EzDSH.providers.save({
        providerId: effectiveProviderId,
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        modelIds: [...selectedModelIds]
      })
      setApiKey('')
      setAdding(false)
      setEditingProviderId(undefined)
      setProviderId('')
      setBaseUrl('')
      setModels([])
      setSelectedModelIds(new Set())
      await load()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const deleteProvider = async (id: string): Promise<void> => {
    setStatusMessage(undefined)
    try {
      await window.EzDSH.providers.delete(id)
      await load()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : copy.saveFailed)
    }
  }

  const cancel = (): void => {
    setAdding(false)
    setEditingProviderId(undefined)
    setProviderId('')
    setApiKey('')
    setBaseUrl('')
    setModels([])
    setSelectedModelIds(new Set())
    setModelsMessage(undefined)
    setTestMessage(undefined)
    setStatusMessage(undefined)
  }

  const toggleModel = (id: string): void => {
    setSelectedModelIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = (): void => {
    setSelectedModelIds(new Set(models.map((model) => model.id)))
  }

  const deselectAll = (): void => {
    setSelectedModelIds(new Set())
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
                <li key={status.providerId} className="provider-status-item provider-status-item-with-actions">
                  <span className="provider-status-name">{def?.displayName ?? status.providerId}</span>
                  <span className={`provider-badge provider-badge-${badge}`}>
                    {badge === 'usable' ? copy.settingsProviderUsable : copy.settingsProviderConfigured}
                  </span>
                  <div className="provider-status-actions">
                    <button
                      className="settings-action provider-status-action"
                      onClick={() => { void startEdit(status.providerId) }}
                    >
                      {copy.settingsProviderEdit}
                    </button>
                    <button
                      className="settings-action provider-status-action"
                      onClick={() => { void deleteProvider(status.providerId) }}
                    >
                      {copy.settingsProviderDelete}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {!adding && editingProviderId === undefined ? (
        <div className="settings-card-content">
          <button className="settings-action" onClick={() => { startAdd() }}>
            {copy.settingsProviderAdd}
          </button>
        </div>
      ) : null}
      {adding && editingProviderId === undefined ? (
        <div className="settings-card-content">
          <div className="provider-card-grid" aria-label={copy.settingsProviderAdd}>
            {definitions.map((candidate) => {
              const badge = providerBadge(statusById.get(candidate.id))
              return (
                <button
                  key={candidate.id}
                  className={`provider-card ${candidate.id === providerId ? 'provider-card-active' : ''}`}
                  onClick={() => { openForm(candidate) }}
                >
                  <span className="provider-card-name">{candidate.displayName}</span>
                  {candidate.defaultBaseUrl ? (
                    <span className="provider-card-url">{candidate.defaultBaseUrl}</span>
                  ) : null}
                  {candidate.modelCatalogSource === 'custom' ? (
                    <span className="provider-card-tag">{copy.settingsProviderListModels}</span>
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
        </div>
      ) : null}
      {definition !== undefined ? (
        <div className="settings-card-content">
          <form className="provider-form" onSubmit={submit}>
            <label htmlFor="provider-api-key">
              {copy.settingsProviderApiKey}
              {isEditing ? (
                <span className="provider-optional"> ({copy.optional})</span>
              ) : null}
              <input
                id="provider-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => { setApiKey(event.target.value) }}
                placeholder={copy.apiKeyPlaceholder}
                autoComplete="off"
                disabled={saving}
              />
            </label>
            <label htmlFor="provider-base-url">
              {copy.baseUrl}{' '}
              <span className="provider-optional">({copy.optional})</span>
              <input
                id="provider-base-url"
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
                type="button"
                onClick={() => { void fetchModels() }}
                disabled={saving || fetchingModels || effectiveProviderId === '' || (!isEditing && apiKey.trim() === '')}
              >
                {fetchingModels ? copy.testing : copy.settingsProviderListModels}
              </button>
              <button
                className="settings-action"
                type="button"
                onClick={() => { void testConnection() }}
                disabled={saving || testing || fetchingModels || effectiveProviderId === '' || (!isEditing && apiKey.trim() === '')}
              >
                {testing ? copy.testing : copy.testConnection}
              </button>
            </div>
            {models.length > 0 ? (
              <fieldset className="provider-model-fieldset">
                <legend className="provider-model-legend">
                  {copy.settingsProviderModelList}
                  <span className="provider-model-count">{selectedModelIds.size}/{models.length}</span>
                </legend>
                <div className="provider-model-actions">
                  <button
                    type="button"
                    className="settings-action provider-model-action"
                    onClick={selectAll}
                    disabled={selectedModelIds.size === models.length}
                  >
                    {copy.settingsProviderSelectAll}
                  </button>
                  <button
                    type="button"
                    className="settings-action provider-model-action"
                    onClick={deselectAll}
                    disabled={selectedModelIds.size === 0}
                  >
                    {copy.settingsProviderDeselectAll}
                  </button>
                </div>
                <ul className="provider-model-list">
                  {models.map((model) => (
                    <li key={model.id} className="provider-model-item">
                      <label className="provider-model-label">
                        <input
                          type="checkbox"
                          checked={selectedModelIds.has(model.id)}
                          onChange={() => { toggleModel(model.id) }}
                          disabled={saving}
                        />
                        <span className="provider-model-name">{model.name ?? model.id}</span>
                        <span className="provider-model-id">{model.id}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
            {modelsMessage ? <p className="settings-error">{modelsMessage}</p> : null}
            <div className="settings-actions">
              <button
                className="settings-action"
                type="submit"
                disabled={saving || fetchingModels || selectedModelIds.size === 0 || (!isEditing && apiKey.trim() === '')}
              >
                {saving ? copy.saving : copy.settingsProviderSave}
              </button>
              <button
                className="settings-action"
                type="button"
                onClick={cancel}
                disabled={saving}
              >
                {copy.storeCancel}
              </button>
            </div>
            {testMessage ? <p className="settings-success">{testMessage}</p> : null}
            {statusMessage ? <p className="settings-error">{statusMessage}</p> : null}
          </form>
        </div>
      ) : null}
    </section>
  )
}
