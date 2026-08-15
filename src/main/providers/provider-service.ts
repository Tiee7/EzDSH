import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { UserDataLayout } from '../../shared/state.js'
import type {
  ProviderStatus,
  SaveProviderInput,
  SaveProviderResult,
  TestConnectionResult
} from '../../shared/providers.js'
import { needsProviderSetup } from '../../shared/providers.js'
import { findProviderDefinition, PROVIDER_DEFINITIONS } from './provider-definitions.js'

type JsonMap = Record<string, unknown>

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

  async save(input: SaveProviderInput): Promise<SaveProviderResult> {
    const definition = findProviderDefinition(input.providerId)
    const apiKey = input.apiKey.trim()
    if (apiKey.length === 0) throw new Error('API Key 不能为空')

    const credentials = await this.readDocument(this.credentialsPath)
    credentials[definition.credentialKey] = apiKey
    await this.writePrivateDocument(this.credentialsPath, credentials)

    const settings = await this.readDocument(this.settingsPath)
    this.writeRoute(settings, definition.id, definition.credentialKey, input.baseUrl)
    await this.writePrivateDocument(this.settingsPath, settings)

    const status = (await this.getStatuses()).find((candidate) => candidate.providerId === input.providerId)
    if (status === undefined) throw new Error('Provider status was not available after saving')
    return { status }
  }

  async testConnection(input: { providerId: string; apiKey: string; baseUrl?: string }): Promise<TestConnectionResult> {
    const definition = findProviderDefinition(input.providerId)
    const baseUrl = input.baseUrl?.trim() || definition.defaultBaseUrl
    if (baseUrl === undefined) return { reachable: false, message: '该供应商需要填写 Base URL' }

    const endpoint = new URL('/models', `${baseUrl.replace(/\/$/u, '')}/`).toString()
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(8_000)
      })
      if (!response.ok) return { reachable: false, message: `服务返回 HTTP ${String(response.status)}` }
      return { reachable: true, message: '连接成功' }
    } catch {
      return { reachable: false, message: '无法连接到供应商服务' }
    }
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
    if (providerId === 'deepseek-official') return true
    const piAi = asMap(settings['llm-pi-ai'])
    const providers = asMap(piAi?.providers)
    return providers?.[providerId] !== undefined
  }

  private writeRoute(settings: JsonMap, providerId: string, credentialKey: string, baseUrl?: string): void {
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
    providers[providerId] = {
      ...asMap(providers[providerId]),
      apiKeyEnv: credentialKey,
      ...(baseUrl?.trim() ? { baseURL: baseUrl.trim() } : {})
    }
    settings['llm-pi-ai'] = { ...piAi, providers }
  }
}

export function isMap(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asMap(value: unknown): JsonMap | undefined {
  return isMap(value) ? value : undefined
}
