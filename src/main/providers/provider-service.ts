import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { UserDataLayout } from '../../shared/state.js'
import type {
  DeleteProviderResult,
  ListModelsInput,
  ProviderModel,
  ProviderProfile,
  ProviderStatus,
  SaveProviderInput,
  SaveProviderResult,
  TestConnectionResult,
  TestProviderInput
} from '../../shared/providers.js'
import { needsProviderSetup } from '../../shared/providers.js'
import { findProviderDefinition, PROVIDER_DEFINITIONS } from './provider-definitions.js'

type JsonMap = Record<string, unknown>

const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  zhipuai: 'zai',
  togetherai: 'together',
  'kimi-code': 'kimi-coding'
}

/** Main-process provider persistence; secrets never leave this service. */
export class ProviderService {
  private readonly credentialsPath: string
  private readonly settingsPath: string

  constructor(private readonly layout: UserDataLayout) {
    this.credentialsPath = join(layout.harness, '.credentials.yaml')
    this.settingsPath = join(layout.harness, 'settings.yaml')
  }

  listDefinitions() {
    return PROVIDER_DEFINITIONS.map((definition) => ({ ...definition }))
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
    return PROVIDER_DEFINITIONS.map((definition) => {
      const hasCredential = this.hasCredential(definition.credentialKey, credentials)
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
    return {
      baseUrl: typeof route.baseURL === 'string' ? route.baseURL : undefined,
      modelIds
    }
  }

  async listModels(input: ListModelsInput): Promise<ProviderModel[]> {
    const definition = findProviderDefinition(input.providerId)
    try {
      return await this.fetchModels(input)
    } catch (error) {
      if (definition.modelCatalogSource === 'catalog') {
        return this.getCatalogModels(definition.id)
      }
      throw error instanceof Error ? error : new Error('无法获取模型列表')
    }
  }

  async testConnection(input: TestProviderInput): Promise<TestConnectionResult> {
    const definition = findProviderDefinition(input.providerId)
    try {
      await this.fetchModels(input)
      return { reachable: true, message: '连接成功' }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接到供应商服务'
      if (/\bHTTP\s+(401|403)\b/.test(message)) {
        return { reachable: false, message }
      }
      if (definition.modelCatalogSource === 'catalog') {
        return { reachable: true, message: '连接成功' }
      }
      return { reachable: false, message }
    }
  }

  async save(input: SaveProviderInput): Promise<SaveProviderResult> {
    const definition = findProviderDefinition(input.providerId)
    const apiKey = input.apiKey.trim()

    const credentials = await this.readDocument(this.credentialsPath)
    const hasStoredKey = typeof credentials[definition.credentialKey] === 'string'
      && (credentials[definition.credentialKey] as string).trim().length > 0
    if (apiKey.length === 0 && !hasStoredKey) {
      throw new Error('API Key 不能为空')
    }
    if (apiKey.length > 0) credentials[definition.credentialKey] = apiKey
    await this.writePrivateDocument(this.credentialsPath, credentials)

    const settings = await this.readDocument(this.settingsPath)
    this.writeRoute(
      settings,
      definition.id,
      definition.credentialKey,
      input.baseUrl,
      input.modelIds,
      definition.modelCatalogSource === 'custom'
    )
    await this.writePrivateDocument(this.settingsPath, settings)

    const status = (await this.getStatuses()).find((candidate) => candidate.providerId === input.providerId)
    if (status === undefined) throw new Error('Provider status was not available after saving')
    return { status }
  }

  async delete(providerId: string): Promise<DeleteProviderResult> {
    const definition = findProviderDefinition(providerId)
    const settings = await this.readDocument(this.settingsPath)
    const credentials = await this.readDocument(this.credentialsPath)
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

    if (typeof credentials[definition.credentialKey] === 'string') {
      delete credentials[definition.credentialKey]
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
    const definition = findProviderDefinition(input.providerId)
    const baseUrl = input.baseUrl?.trim() || definition.defaultBaseUrl
    if (baseUrl === undefined) throw new Error('该供应商需要填写 Base URL')

    let apiKey = input.apiKey.trim()
    if (apiKey.length === 0) {
      const credentials = await this.readDocument(this.credentialsPath)
      const stored = credentials[definition.credentialKey]
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

  private writeRoute(
    settings: JsonMap,
    providerId: string,
    credentialKey: string,
    baseUrl?: string,
    modelIds?: string[],
    isCustom?: boolean
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
    const models = modelIds !== undefined && modelIds.length > 0
      ? modelIds.map((id) => ({ id }))
      : undefined
    const route: JsonMap = {
      ...asMap(providers[providerId]),
      apiKeyEnv: credentialKey,
      ...(baseUrl?.trim() ? { baseURL: baseUrl.trim() } : {}),
      ...(models !== undefined ? { models } : {})
    }
    if (isCustom) route.api = 'openai-completions'
    providers[providerId] = route
    settings['llm-pi-ai'] = { ...piAi, providers }
  }
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
