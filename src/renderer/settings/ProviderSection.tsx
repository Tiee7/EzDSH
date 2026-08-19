import { useEffect, useMemo, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type {
  ProviderApiProtocol,
  ProviderDefinition,
  ProviderModel,
  ProviderProfile,
  ProviderStatus
} from '../../shared/providers.js'
import { PROVIDER_API_PROTOCOLS } from '../../shared/providers.js'
import { providerBadge } from './settings-display.js'

const CUSTOM_PROVIDER_DEFINITION: ProviderDefinition = {
  id: '__custom__',
  displayName: '',
  category: 'aggregator',
  credentialKey: '',
  supportsConnectionTest: true,
  modelCatalogSource: 'custom',
  isCustom: true
}

/** Provider management: preset card grid with an inline add/replace key form and model selection. */
export function ProviderSection({ copy }: { copy: AppCopy }): JSX.Element {
  const [definitions, setDefinitions] = useState<readonly ProviderDefinition[]>()
  const [statuses, setStatuses] = useState<readonly ProviderStatus[]>()
  const [loadError, setLoadError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingProviderId, setEditingProviderId] = useState<string>()
  const [formDefinition, setFormDefinition] = useState<ProviderDefinition>()
  const [creatingCustomProvider, setCreatingCustomProvider] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [providerDisplayName, setProviderDisplayName] = useState('')
  const [apiProtocol, setApiProtocol] = useState<ProviderApiProtocol>('openai-completions')
  const [customOptionsOpen, setCustomOptionsOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<ProviderModel[]>([])
  const [availableModels, setAvailableModels] = useState<ProviderModel[]>([])
  const [customModels, setCustomModels] = useState<ProviderModel[]>([])
  const [addingModel, setAddingModel] = useState(false)
  const [customModelId, setCustomModelId] = useState('')
  const [customModelName, setCustomModelName] = useState('')
  const [customModelContextWindow, setCustomModelContextWindow] = useState('')
  const [customModelMaxTokens, setCustomModelMaxTokens] = useState('')
  const [customModelOptionsOpen, setCustomModelOptionsOpen] = useState(false)
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set())
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelsMessage, setModelsMessage] = useState<string>()
  const [statusMessage, setStatusMessage] = useState<string>()
  const [saving, setSaving] = useState(false)

  const effectiveProviderId = providerId
  const isEditing = editingProviderId !== undefined

  const statusById = useMemo(() => {
    const map = new Map<string, ProviderStatus>()
    for (const status of statuses ?? []) map.set(status.providerId, status)
    return map
  }, [statuses])

  const definition = useMemo(
    () => definitions?.find((candidate) => candidate.id === effectiveProviderId)
      ?? formDefinition,
    [definitions, effectiveProviderId, formDefinition]
  )

  const presetDefinitions = useMemo(
    () => (definitions ?? []).filter((candidate) => candidate.isCustom !== true),
    [definitions]
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
    setFormDefinition(next)
    setCreatingCustomProvider(false)
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
    setProviderDisplayName(profile?.displayName ?? next.displayName)
    setApiProtocol(profile?.api ?? defaultApiProtocol(next))
    setCustomOptionsOpen(profile?.isCustom === true)
    const savedModels = profile?.models ?? (profile?.modelIds ?? []).map((id) => ({ id }))
    setModels(savedModels)
    setAvailableModels([])
    setCustomModels(savedModels)
    setAddingModel(false)
    setCustomModelId('')
    setCustomModelName('')
    setCustomModelContextWindow('')
    setCustomModelMaxTokens('')
    setCustomModelOptionsOpen(false)
    setSelectedModelIds(new Set(savedModels.map((model) => model.id)))
    setModelsMessage(undefined)
    setStatusMessage(undefined)
  }

  const startAdd = (): void => {
    const first = presetDefinitions[0]
    if (first !== undefined) openForm(first)
  }

  const openCustomProviderForm = (): void => {
    setFormDefinition(CUSTOM_PROVIDER_DEFINITION)
    setCreatingCustomProvider(true)
    setAdding(true)
    setEditingProviderId(undefined)
    setProviderId('')
    setProviderDisplayName('')
    setApiProtocol('openai-completions')
    setCustomOptionsOpen(true)
    setApiKey('')
    setBaseUrl('')
    setModels([])
    setAvailableModels([])
    setCustomModels([])
    setAddingModel(false)
    setCustomModelId('')
    setCustomModelName('')
    setCustomModelContextWindow('')
    setCustomModelMaxTokens('')
    setCustomModelOptionsOpen(false)
    setSelectedModelIds(new Set())
    setModelsMessage(undefined)
    setStatusMessage(undefined)
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
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(customOptionsOpen ? { api: apiProtocol } : {})
      })
      if (result.length === 0) {
        setAvailableModels([])
        setModels(mergeModels(customModels, []))
        setModelsMessage(copy.settingsProviderModelsEmpty)
        return
      }
      setAvailableModels(result)
      setModels(mergeModels(customModels, result))
      setSelectedModelIds((previous) => previous.size === 0
        ? new Set(result.map((model) => model.id))
        : new Set(previous))
    } catch (error) {
      setAvailableModels([])
      setModels(mergeModels(customModels, []))
      setSelectedModelIds(new Set())
      setModelsMessage(error instanceof Error ? error.message : copy.settingsProviderFetchFailed)
    } finally {
      setFetchingModels(false)
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (effectiveProviderId.trim() === '') {
      setStatusMessage(copy.settingsProviderIdRequired)
      return
    }
    if (creatingCustomProvider && baseUrl.trim() === '') {
      setStatusMessage(copy.settingsProviderBaseUrlRequired)
      return
    }
    if (selectedModelIds.size === 0) {
      setStatusMessage(copy.settingsProviderModelsRequired)
      return
    }
    setSaving(true)
    setStatusMessage(undefined)
    try {
      await window.EzDSH.providers.save({
        providerId: effectiveProviderId.trim(),
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        modelIds: [...selectedModelIds],
        models: models.filter((model) => selectedModelIds.has(model.id)),
        ...(isEditing && editingProviderId !== effectiveProviderId
          ? { previousProviderId: editingProviderId }
          : {}),
        ...(customOptionsOpen
          ? { custom: true, displayName: providerDisplayName.trim(), api: apiProtocol }
          : {})
      })
      setApiKey('')
      setAdding(false)
      setEditingProviderId(undefined)
      setFormDefinition(undefined)
      setCreatingCustomProvider(false)
      setProviderId('')
      setProviderDisplayName('')
      setApiProtocol('openai-completions')
      setCustomOptionsOpen(false)
      setBaseUrl('')
      setModels([])
      setAvailableModels([])
      setCustomModels([])
      setAddingModel(false)
      setCustomModelId('')
      setCustomModelName('')
      setCustomModelContextWindow('')
      setCustomModelMaxTokens('')
      setCustomModelOptionsOpen(false)
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
    setFormDefinition(undefined)
    setCreatingCustomProvider(false)
    setProviderId('')
    setProviderDisplayName('')
    setApiProtocol('openai-completions')
    setCustomOptionsOpen(false)
    setApiKey('')
    setBaseUrl('')
    setModels([])
    setAvailableModels([])
    setCustomModels([])
    setAddingModel(false)
    setCustomModelId('')
    setCustomModelName('')
    setCustomModelContextWindow('')
    setCustomModelMaxTokens('')
    setCustomModelOptionsOpen(false)
    setSelectedModelIds(new Set())
    setModelsMessage(undefined)
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

  const addCustomModel = (): void => {
    const id = customModelId.trim()
    if (id === '') {
      setModelsMessage(copy.settingsProviderModelIdRequired)
      return
    }
    const contextWindow = parseTokenLimit(customModelContextWindow)
    const maxTokens = parseTokenLimit(customModelMaxTokens)
    if ((customModelContextWindow.trim() !== '' && contextWindow === undefined)
      || (customModelMaxTokens.trim() !== '' && maxTokens === undefined)) {
      setModelsMessage(copy.settingsProviderModelLimitsInvalid)
      return
    }
    const nextModel: ProviderModel = {
      id,
      ...(customModelName.trim() ? { name: customModelName.trim() } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {})
    }
    const nextCustomModels = [
      ...customModels.filter((model) => model.id !== id),
      nextModel
    ]
    setCustomModels(nextCustomModels)
    setModels(mergeModels(nextCustomModels, availableModels))
    setSelectedModelIds((previous) => new Set(previous).add(id))
    setAddingModel(false)
    setCustomModelId('')
    setCustomModelName('')
    setCustomModelContextWindow('')
    setCustomModelMaxTokens('')
    setCustomModelOptionsOpen(false)
    setModelsMessage(undefined)
  }

  const removeCustomModel = (id: string): void => {
    const nextCustomModels = customModels.filter((model) => model.id !== id)
    setCustomModels(nextCustomModels)
    setModels(mergeModels(nextCustomModels, availableModels))
    setSelectedModelIds((previous) => {
      const next = new Set(previous)
      next.delete(id)
      return next
    })
  }

  const cancelCustomModelEditor = (): void => {
    setAddingModel(false)
    setCustomModelId('')
    setCustomModelName('')
    setCustomModelContextWindow('')
    setCustomModelMaxTokens('')
    setCustomModelOptionsOpen(false)
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
            {presetDefinitions.map((candidate) => {
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
                  {badge !== 'empty' ? (
                    <span className={`provider-badge provider-badge-${badge}`}>
                      {badge === 'usable' ? copy.settingsProviderUsable : copy.settingsProviderConfigured}
                    </span>
                  ) : null}
                </button>
              )
            })}
            <button
              type="button"
              className={`provider-card provider-card-custom ${creatingCustomProvider ? 'provider-card-active' : ''}`}
              onClick={openCustomProviderForm}
            >
              <span className="provider-card-custom-icon" aria-hidden="true">＋</span>
              <span className="provider-card-name">{copy.settingsProviderCustomProvider}</span>
            </button>
          </div>
        </div>
      ) : null}
      {definition !== undefined ? (
        <div className="settings-card-content">
          <form className="provider-form" onSubmit={submit}>
            <label htmlFor="provider-api-key">
              {copy.settingsProviderApiKey}
              {isEditing ? (
                <span className="provider-optional"> {copy.optional}</span>
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
              {copy.baseUrl}
              <input
                id="provider-base-url"
                type="url"
                value={baseUrl}
                onChange={(event) => { setBaseUrl(event.target.value) }}
                placeholder={definition.defaultBaseUrl ?? copy.baseUrlPlaceholder}
                required={creatingCustomProvider}
                disabled={saving}
              />
            </label>
            <fieldset className="provider-model-fieldset">
              <legend className="provider-model-legend">
                <span>{copy.settingsProviderModelList}</span>
                <span className="provider-model-count">{selectedModelIds.size}/{models.length}</span>
                <button
                  type="button"
                  className="settings-action provider-model-fetch"
                  onClick={() => { void fetchModels() }}
                  disabled={saving || fetchingModels || effectiveProviderId === '' || (!isEditing && apiKey.trim() === '')}
                >
                  {fetchingModels ? copy.loading : copy.settingsProviderListModels}
                </button>
              </legend>
              {models.length > 0 ? (
                <>
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
                    {models.map((model) => {
                      const isCustomModel = customModels.some((candidate) => candidate.id === model.id)
                      return (
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
                          {isCustomModel ? (
                            <button
                              type="button"
                              className="provider-model-remove"
                              onClick={() => { removeCustomModel(model.id) }}
                              disabled={saving}
                              aria-label={`${copy.settingsProviderDelete} ${model.id}`}
                            >
                              ×
                            </button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </>
              ) : (
                <p className="provider-model-empty">{copy.settingsProviderModelsEmptyHint}</p>
              )}
              <button
                type="button"
                className="settings-action provider-model-add"
                onClick={() => { setAddingModel(true); setCustomModelOptionsOpen(false); setModelsMessage(undefined) }}
                disabled={saving}
              >
                {copy.settingsProviderAddModel}
              </button>
              {addingModel ? (
                <div className="provider-model-editor">
                  <div className="provider-model-editor-main">
                    <input
                      aria-label={copy.settingsProviderModelId}
                      type="text"
                      value={customModelId}
                      onChange={(event) => { setCustomModelId(event.target.value) }}
                      placeholder={copy.settingsProviderModelId}
                      autoComplete="off"
                      disabled={saving}
                    />
                    <input
                      aria-label={copy.settingsProviderModelName}
                      type="text"
                      value={customModelName}
                      onChange={(event) => { setCustomModelName(event.target.value) }}
                      placeholder={copy.settingsProviderModelName}
                      autoComplete="off"
                      disabled={saving}
                    />
                    <button
                      type="button"
                      className="provider-model-expand"
                      aria-label={customModelOptionsOpen ? copy.settingsProviderCustomOptionsOpen : copy.settingsProviderCustomOptions}
                      aria-expanded={customModelOptionsOpen}
                      onClick={() => { setCustomModelOptionsOpen((open) => !open) }}
                      disabled={saving}
                    >
                      <span
                        className={`provider-model-expand-icon ${customModelOptionsOpen ? 'provider-model-expand-icon-open' : ''}`}
                        aria-hidden="true"
                      >
                        {customModelOptionsOpen ? '⌄' : '›'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="provider-model-cancel"
                      aria-label={copy.storeCancel}
                      onClick={cancelCustomModelEditor}
                      disabled={saving}
                    >
                      ×
                    </button>
                  </div>
                  {customModelOptionsOpen ? (
                    <div className="provider-model-editor-details">
                      <label className="provider-model-editor-field">
                        <span>{copy.settingsProviderModelContextWindow}</span>
                        <input
                          type="text"
                          value={customModelContextWindow}
                          onChange={(event) => { setCustomModelContextWindow(event.target.value) }}
                          placeholder={copy.settingsProviderModelContextWindowPlaceholder}
                          autoComplete="off"
                          disabled={saving}
                        />
                      </label>
                      <label className="provider-model-editor-field">
                        <span>{copy.settingsProviderModelMaxTokens}</span>
                        <input
                          type="text"
                          value={customModelMaxTokens}
                          onChange={(event) => { setCustomModelMaxTokens(event.target.value) }}
                          placeholder={copy.settingsProviderModelMaxTokensPlaceholder}
                          autoComplete="off"
                          disabled={saving}
                        />
                      </label>
                    </div>
                  ) : null}
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="settings-action"
                      onClick={addCustomModel}
                      disabled={saving}
                    >
                      {copy.settingsProviderAddModel}
                    </button>
                  </div>
                </div>
              ) : null}
            </fieldset>
            <button
              className="settings-action provider-custom-toggle"
              type="button"
              aria-expanded={customOptionsOpen}
              onClick={() => { setCustomOptionsOpen((open) => !open) }}
              disabled={saving}
            >
              <span aria-hidden="true">{customOptionsOpen ? '▾' : '▸'}</span>
              {customOptionsOpen ? copy.settingsProviderCustomOptionsOpen : copy.settingsProviderCustomOptions}
            </button>
            {customOptionsOpen ? (
              <div className="provider-custom-options">
                <label htmlFor="provider-id">
                  {copy.settingsProviderId}
                  <input
                    id="provider-id"
                    type="text"
                    value={providerId}
                    onChange={(event) => { setProviderId(event.target.value) }}
                    placeholder="openai-custom"
                    autoComplete="off"
                    required={customOptionsOpen}
                    disabled={saving}
                  />
                  <span className="provider-custom-hint">{copy.settingsProviderIdHint}</span>
                </label>
                <label htmlFor="provider-display-name">
                  {copy.settingsProviderDisplayName}
                  <input
                    id="provider-display-name"
                    type="text"
                    value={providerDisplayName}
                    onChange={(event) => { setProviderDisplayName(event.target.value) }}
                    placeholder={providerId}
                    disabled={saving}
                  />
                </label>
                <label htmlFor="provider-api-protocol">
                  {copy.settingsProviderApiProtocol}
                  <select
                    id="provider-api-protocol"
                    value={apiProtocol}
                    onChange={(event) => { setApiProtocol(event.target.value as ProviderApiProtocol) }}
                    disabled={saving}
                  >
                    {PROVIDER_API_PROTOCOLS.map((protocol) => (
                      <option key={protocol} value={protocol}>{protocol}</option>
                    ))}
                  </select>
                </label>
              </div>
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
            {statusMessage ? <p className="settings-error">{statusMessage}</p> : null}
          </form>
        </div>
      ) : null}
    </section>
  )
}

function defaultApiProtocol(definition: ProviderDefinition): ProviderApiProtocol {
  return definition.id === 'anthropic' || definition.id === 'minimax'
    ? 'anthropic-messages'
    : 'openai-completions'
}

function mergeModels(primary: readonly ProviderModel[], secondary: readonly ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>()
  for (const model of [...primary, ...secondary]) {
    if (!byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()]
}

function parseTokenLimit(raw: string): number | undefined {
  const normalized = raw.trim().replace(/,/gu, '').toUpperCase()
  if (normalized === '') return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([KM])?$/u.exec(normalized)
  if (match === null) return undefined
  const value = Number(match[1]) * (match[2] === 'M' ? 1024 * 1024 : match[2] === 'K' ? 1024 : 1)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
