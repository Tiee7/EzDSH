export type ProviderCategory = 'vendor' | 'aggregator' | 'inference'

export interface ProviderDefinition {
  id: string
  displayName: string
  category: ProviderCategory
  credentialKey: string
  defaultBaseUrl?: string
  supportsConnectionTest: boolean
  modelCatalogSource: 'builtin' | 'remote' | 'custom'
}

export interface ProviderStatus {
  providerId: string
  hasCredential: boolean
  routeConfigured: boolean
  reachable?: boolean
  usable: boolean
}

export interface SaveProviderInput {
  providerId: string
  apiKey: string
  baseUrl?: string
}

export interface TestProviderInput {
  providerId: string
  apiKey: string
  baseUrl?: string
}

export interface TestConnectionResult {
  reachable: boolean
  message: string
}

export interface SaveProviderResult {
  status: ProviderStatus
}

export function needsProviderSetup(statuses: readonly ProviderStatus[]): boolean {
  return statuses.length === 0 || !statuses.some((status) => status.usable)
}
