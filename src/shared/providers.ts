export type ProviderCategory = 'vendor' | 'aggregator' | 'inference'
export type ProviderCatalogSource = 'catalog' | 'custom'
export const PROVIDER_API_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages'
] as const
export type ProviderApiProtocol = (typeof PROVIDER_API_PROTOCOLS)[number]

export interface ProviderDefinition {
  id: string
  displayName: string
  category: ProviderCategory
  credentialKey: string
  defaultBaseUrl?: string
  supportsConnectionTest: boolean
  modelCatalogSource: ProviderCatalogSource
  isCustom?: boolean
}

export interface ProviderStatus {
  providerId: string
  hasCredential: boolean
  routeConfigured: boolean
  reachable?: boolean
  usable: boolean
}

export interface ProviderModel {
  id: string
  name?: string
}

export interface ProviderProfile {
  baseUrl?: string
  modelIds: string[]
  models?: ProviderModel[]
  displayName?: string
  api?: ProviderApiProtocol
  isCustom?: boolean
}

export interface ListModelsInput {
  providerId: string
  apiKey: string
  baseUrl?: string
  api?: ProviderApiProtocol
}

export interface SaveProviderInput {
  providerId: string
  apiKey: string
  baseUrl?: string
  modelIds: string[]
  models?: ProviderModel[]
  displayName?: string
  api?: ProviderApiProtocol
  custom?: boolean
  previousProviderId?: string
}

export interface TestProviderInput {
  providerId: string
  apiKey: string
  baseUrl?: string
  api?: ProviderApiProtocol
}

export interface TestConnectionResult {
  reachable: boolean
  message: string
}

export interface SaveProviderResult {
  status: ProviderStatus
}

export interface DeleteProviderResult {
  providerId: string
  deleted: boolean
}

export function needsProviderSetup(statuses: readonly ProviderStatus[]): boolean {
  return statuses.length === 0 || !statuses.some((status) => status.usable)
}
