import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { UserDataLayout } from '../../shared/state.js'
import type {
  DeleteProviderResult,
  ListModelsInput,
  ProviderDefinition,
  ProviderApiProtocol,
  ProviderModel,
  ProviderProfile,
  ProviderStatus,
  SaveProviderInput,
  SaveProviderResult,
  TestConnectionResult,
  TestProviderInput
} from '../../shared/providers.js'
import { needsProviderSetup, PROVIDER_API_PROTOCOLS } from '../../shared/providers.js'
import { findProviderDefinition, PROVIDER_DEFINITIONS } from './provider-definitions.js'

type JsonMap = Record<string, unknown>

const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  zhipuai: 'zai',
  togetherai: 'together',
  'kimi-code': 'kimi-coding'
}
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** Main-process provider persistence; secrets never leave this service. */
export class ProviderService {
  private readonly credentialsPath: string
  private readonly settingsPath: string

  constructor(private readonly layout: UserDataLayout) {
    this.credentialsPath = join(layout.harness, '.credentials.yaml')
    this.settingsPath = join(layout.harness, 'settings.yaml')
  }

  async listDefinitions(): Promise<ProviderDefinition[]> {
    const settings = await this.readDocument(this.settingsPath)
    const definitions = PROVIDER_DEFINITIONS.map((definition) => {
      const baseUrl = definition.defaultBaseUrl ?? this.catalogBaseUrl(definition.id)
      const route = this.readRoute(settings, definition.id)
      const displayName = typeof route?.displayName === 'string' && route.displayName.trim() !== ''
        ? route.displayName
        : definition.displayName
      return {
        ...(baseUrl === undefined ? { ...definition } : { ...definition, defaultBaseUrl: baseUrl }),
        displayName
      }
    })
    const knownIds = new Set(definitions.map((definition) => definition.id))
    const piAi = asMap(settings['llm-pi-ai'])
    const providers = asMap(piAi?.providers)
    for (const [providerId, routeValue] of Object.entries(providers ?? {})) {
      if (knownIds.has(providerId) || !isMap(routeValue)) continue
      definitions.push({
        id: providerId,
        displayName: typeof routeValue.displayName === 'string' && routeValue.displayName.trim() !== ''
          ? routeValue.displayName
          : providerId,
        category: 'aggregator',
        credentialKey: typeof routeValue.apiKeyEnv === 'string'
          ? routeValue.apiKeyEnv
          : deriveCredentialKey(providerId),
        ...(typeof routeValue.baseURL === 'string' ? { defaultBaseUrl: routeValue.baseURL } : {}),
        supportsConnectionTest: true,
        modelCatalogSource: 'custom',
        isCustom: true
      })
    }
    return definitions
  }

  /** Repair provider route IDs written by older EzDSH builds before Runtime starts. */
  async initialize(): Promise<void> {
    const settings = await this.readDocument(this.settingsPath)
    if (this.migrateLegacyProviderRoutes(settings)) {
      await this.writePrivateDocument(this.settingsPath, settings)
    }
  }

  async getStatuses(): Promise<ProviderStatus[]> {
    const credentials = await this.readDocument(this.credentialsPath)
    const settings = await this.readDocument(this.settingsPath)
    const definitions = await this.listDefinitions()
    return definitions.map((definition) => {
      const route = this.readRoute(settings, definition.id)
      const credentialKey = typeof route?.apiKeyEnv === 'string' ? route.apiKeyEnv : definition.credentialKey
      const hasCredential = this.hasCredential(credentialKey, credentials)
      const routeConfigured = this.isRouteConfigured(definition.id, settings)
      return {
        providerId: definition.id,
        hasCredential,
        routeConfigured,
        usable: hasCredential && routeConfigured
      }
    })
  }

  async getProfile(providerId: string): Promise<ProviderProfile | undefined> {
    const settings = await this.readDocument(this.settingsPath)
    const route = this.readRoute(settings, providerId)
    if (route === undefined) return undefined
    const models = asArray(route.models)
    const modelIds = models
      ?.filter((entry): entry is JsonMap => isMap(entry) && typeof entry.id === 'string')
      .map((entry) => String(entry.id)) ?? []
    const modelEntries = models
      ?.filter((entry): entry is JsonMap => isMap(entry) && typeof entry.id === 'string')
      .map((entry) => ({
        id: String(entry.id),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {})
      })) ?? []
    return {
      baseUrl: typeof route.baseURL === 'string' ? route.baseURL : undefined,
      modelIds,
      ...(modelEntries.some((entry) => entry.name !== undefined) ? { models: modelEntries } : {}),
      ...(typeof route.displayName === 'string' ? { displayName: route.displayName } : {}),
      ...(isProviderApiProtocol(route.api) ? { api: route.api } : {}),
      ...(PROVIDER_DEFINITIONS.find((definition) => definition.id === providerId) === undefined || route.api !== undefined
        ? { isCustom: true }
        : {})
    }
  }

  async listModels(input: ListModelsInput): Promise<ProviderModel[]> {
    const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === input.providerId)
    if (definition === undefined && input.api === undefined) throw new Error(`Unknown provider: ${input.providerId}`)
    try {
      return await this.fetchModels(input)
    } catch (error) {
      if (definition?.modelCatalogSource === 'catalog') {
        return this.getCatalogModels(definition.id)
      }
      throw error instanceof Error ? error : new Error('无法获取模型列表')
    }
  }

  async testConnection(input: TestProviderInput): Promise<TestConnectionResult> {
    const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === input.providerId)
    if (definition === undefined && input.api === undefined) throw new Error(`Unknown provider: ${input.providerId}`)
    try {
      await this.fetchModels(input)
      return { reachable: true, message: '连接成功' }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接到供应商服务'
      if (/\bHTTP\s+(401|403)\b/.test(message)) {
        return { reachable: false, message }
      }
      if (definition?.modelCatalogSource === 'catalog') {
        return { reachable: true, message: '连接成功' }
      }
      return { reachable: false, message }
    }
  }

  async save(input: SaveProviderInput): Promise<SaveProviderResult> {
    const providerId = input.providerId.trim()
    const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === providerId)
    const isCustom = input.custom === true
      || definition === undefined
      || definition.modelCatalogSource === 'custom'
    if (providerId === '') throw new Error('Provider ID 不能为空')
    if (isCustom && !PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error('Provider ID 只能包含小写字母、数字和连字符，且必须以小写字母开头')
    }
    if ((input.custom === true || definition === undefined) && !isProviderApiProtocol(input.api)) {
      throw new Error('API 协议无效')
    }
    const apiKey = input.apiKey.trim()

    const settings = await this.readDocument(this.settingsPath)
    const existingRoute = this.readRoute(settings, providerId)
    const previousRoute = input.previousProviderId !== undefined && input.previousProviderId !== providerId
      ? this.readRoute(settings, input.previousProviderId)
      : undefined
    const sourceRoute = existingRoute ?? previousRoute
    const credentialKey = typeof sourceRoute?.apiKeyEnv === 'string'
      ? sourceRoute.apiKeyEnv
      : definition?.credentialKey ?? deriveCredentialKey(providerId)
    const credentials = await this.readDocument(this.credentialsPath)
    const hasStoredKey = typeof credentials[credentialKey] === 'string'
      && (credentials[credentialKey] as string).trim().length > 0
    if (apiKey.length === 0 && !hasStoredKey) {
      throw new Error('API Key 不能为空')
    }
    if (apiKey.length > 0) credentials[credentialKey] = apiKey
    await this.writePrivateDocument(this.credentialsPath, credentials)

    this.writeRoute(
      settings,
      providerId,
      credentialKey,
      input.baseUrl,
      input.modelIds,
      isCustom,
      input.api,
      input.displayName,
      input.models
    )
    if (input.previousProviderId !== undefined && input.previousProviderId !== providerId) {
      this.removeRoute(settings, input.previousProviderId)
    }
    await this.writePrivateDocument(this.settingsPath, settings)

    const status = (await this.getStatuses()).find((candidate) => candidate.providerId === providerId)
    if (status === undefined) throw new Error('Provider status was not available after saving')
    return { status }
  }

  async delete(providerId: string): Promise<DeleteProviderResult> {
    const settings = await this.readDocument(this.settingsPath)
    const credentials = await this.readDocument(this.credentialsPath)
    const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === providerId)
    const route = this.readRoute(settings, providerId)
    const credentialKey = typeof route?.apiKeyEnv === 'string' ? route.apiKeyEnv : definition?.credentialKey
    let changed = false

    if (providerId === 'deepseek-official') {
      if (settings['llm-deepseek'] !== undefined) {
        delete settings['llm-deepseek']
        changed = true
      }
    } else {
      const piAi = asMap(settings['llm-pi-ai'])
      const providers = asMap(piAi?.providers)
      if (providers !== undefined && providerId in providers) {
        delete providers[providerId]
        settings['llm-pi-ai'] = { ...piAi, providers }
        changed = true
      }
    }

    if (credentialKey !== undefined && typeof credentials[credentialKey] === 'string') {
      delete credentials[credentialKey]
      await this.writePrivateDocument(this.credentialsPath, credentials)
    }

    if (changed) await this.writePrivateDocument(this.settingsPath, settings)
    return { providerId, deleted: changed }
  }

  needsSetup(statuses: readonly ProviderStatus[]): boolean {
    return needsProviderSetup(statuses)
  }

  private async readDocument(path: string): Promise<JsonMap> {
    try {
      const raw = await readFile(path, 'utf8')
      const value = parse(raw) as unknown
      return isMap(value) ? value : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private async writePrivateDocument(path: string, value: JsonMap): Promise<void> {
    await mkdir(this.layout.harness, { recursive: true, mode: 0o700 })
    await writeFile(path, stringify(value), { mode: 0o600 })
    await chmod(path, 0o600)
  }

  private hasCredential(key: string, credentials: JsonMap): boolean {
    const fromEnvironment = process.env[key]
    const fromFile = credentials[key]
    return (typeof fromEnvironment === 'string' && fromEnvironment.trim().length > 0)
      || (typeof fromFile === 'string' && fromFile.trim().length > 0)
  }

  private isRouteConfigured(providerId: string, settings: JsonMap): boolean {
    if (providerId === 'deepseek-official') return settings['llm-deepseek'] !== undefined
    const piAi = asMap(settings['llm-pi-ai'])
    const providers = asMap(piAi?.providers)
    return providers?.[providerId] !== undefined
  }

  private readRoute(settings: JsonMap, providerId: string): JsonMap | undefined {
    if (providerId === 'deepseek-official') return asMap(settings['llm-deepseek'])
    const piAi = asMap(settings['llm-pi-ai'])
    const providers = asMap(piAi?.providers)
    return asMap(providers?.[providerId])
  }

  private removeRoute(settings: JsonMap, providerId: string): void {
    if (providerId === 'deepseek-official') {
      delete settings['llm-deepseek']
      return
    }
    const piAi = asMap(settings['llm-pi-ai'])
    const providers = asMap(piAi?.providers)
    if (providers === undefined || !(providerId in providers)) return
    delete providers[providerId]
    settings['llm-pi-ai'] = { ...piAi, providers }
  }

  private migrateLegacyProviderRoutes(settings: JsonMap): boolean {
    const piAi = asMap(settings['llm-pi-ai'])
    const providers = asMap(piAi?.providers)
    if (piAi === undefined || providers === undefined) return false

    let changed = false
    for (const [legacyId, currentId] of Object.entries(LEGACY_PROVIDER_ALIASES)) {
      const legacyProfile = providers[legacyId]
      if (!isMap(legacyProfile)) continue
      if (providers[currentId] === undefined) providers[currentId] = legacyProfile
      delete providers[legacyId]
      changed = true
    }
    if (changed) settings['llm-pi-ai'] = { ...piAi, providers }
    return changed
  }

  private async fetchModels(input: { providerId: string; apiKey: string; baseUrl?: string }): Promise<ProviderModel[]> {
    const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === input.providerId)
    const baseUrl = input.baseUrl?.trim() || definition?.defaultBaseUrl
    if (baseUrl === undefined) throw new Error('该供应商需要填写 Base URL')

    let apiKey = input.apiKey.trim()
    if (apiKey.length === 0) {
      const settings = await this.readDocument(this.settingsPath)
      const route = this.readRoute(settings, input.providerId)
      const credentialKey = typeof route?.apiKeyEnv === 'string'
        ? route.apiKeyEnv
        : definition?.credentialKey ?? deriveCredentialKey(input.providerId)
      const credentials = await this.readDocument(this.credentialsPath)
      const stored = credentials[credentialKey]
      if (typeof stored === 'string' && stored.trim().length > 0) apiKey = stored.trim()
      else throw new Error('API Key 不能为空')
    }

    const endpoint = new URL(`${baseUrl.replace(/\/+$/u, '')}/models`).toString()
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) throw new Error(`服务返回 HTTP ${String(response.status)}`)

    const text = await response.text()
    const parsed = this.parseModelList(text)
    return parsed
  }

  private parseModelList(text: string): ProviderModel[] {
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw new Error('模型列表返回不是有效 JSON')
    }
    if (!isMap(payload) || !Array.isArray(payload.data)) {
      throw new Error('模型列表格式不符合 OpenAI /models 响应')
    }
    return payload.data
      .filter((entry): entry is { id: string; name?: string } =>
        isMap(entry) && typeof entry.id === 'string'
      )
      .map((entry) => ({ id: entry.id, name: entry.name }))
  }

  private getCatalogModels(providerId: string): ProviderModel[] {
    const provider = builtinProviders().find((candidate) => candidate.id === providerId)
    if (provider === undefined) return []
    const models = (provider as unknown as { getModels?: () => Array<{ id: string; name?: string }> }).getModels?.()
    if (!Array.isArray(models)) return []
    return models.map((model) => ({ id: model.id, name: model.name }))
  }

  private catalogBaseUrl(providerId: string): string | undefined {
    return builtinProviders().find((candidate) => candidate.id === providerId)?.baseUrl
  }

  private officialBaseUrl(providerId: string): string | undefined {
    const definition = findProviderDefinition(providerId)
    return definition.defaultBaseUrl ?? this.catalogBaseUrl(providerId)
  }

  private normalizeBaseUrl(url: string | undefined): string | undefined {
    const trimmed = url?.trim()
    if (trimmed === undefined || trimmed === '') return undefined
    return trimmed.replace(/\/+$/u, '')
  }

  private writeRoute(
    settings: JsonMap,
    providerId: string,
    credentialKey: string,
    baseUrl?: string,
    modelIds?: string[],
    isCustom?: boolean,
    api?: ProviderApiProtocol,
    displayName?: string,
    modelEntries?: ProviderModel[]
  ): void {
    if (providerId === 'deepseek-official') {
      settings['llm-deepseek'] = {
        ...asMap(settings['llm-deepseek']),
        apiKeyEnv: credentialKey,
        ...(baseUrl?.trim() ? { baseURL: baseUrl.trim() } : {})
      }
      return
    }

    const piAi = asMap(settings['llm-pi-ai']) ?? {}
    const providers = asMap(piAi.providers) ?? {}
    const models = modelEntries !== undefined && modelEntries.length > 0
      ? modelEntries.map((model) => ({
        id: model.id,
        ...(model.name !== undefined && model.name.trim() !== '' ? { name: model.name.trim() } : {})
      }))
      : modelIds !== undefined && modelIds.length > 0
        ? modelIds.map((id) => ({ id }))
      : undefined
    const route: JsonMap = {
      ...asMap(providers[providerId]),
      apiKeyEnv: credentialKey,
      ...(models !== undefined ? { models } : {})
    }
    if (isCustom) {
      route.api = api ?? 'openai-completions'
      const customName = displayName?.trim()
      if (customName !== undefined && customName !== '') route.displayName = customName
      else delete route.displayName
      const customBase = this.normalizeBaseUrl(baseUrl)
      if (customBase !== undefined) route.baseURL = customBase
    } else {
      delete route.api
      delete route.displayName
      const requested = this.normalizeBaseUrl(baseUrl)
      const official = this.normalizeBaseUrl(this.officialBaseUrl(providerId))
      if (requested !== undefined && requested !== official) route.baseURL = requested
      else delete route.baseURL
    }
    providers[providerId] = route
    settings['llm-pi-ai'] = { ...piAi, providers }
  }
}

function deriveCredentialKey(providerId: string): string {
  return `EZDSH_${providerId.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

function isProviderApiProtocol(value: unknown): value is ProviderApiProtocol {
  return typeof value === 'string' && (PROVIDER_API_PROTOCOLS as readonly string[]).includes(value)
}

export function isMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asMap(value: unknown): JsonMap | undefined {
  return isMap(value) ? value : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}
