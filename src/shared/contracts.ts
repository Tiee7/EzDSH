import type { RuntimeSnapshot } from '../main/runtime/runtime-types.js'
import type { EzDSHError, IpcResult } from './errors.js'
import type { UpdateState } from './update.js'
import type { AppLocale } from './locale.js'
import type {
  ProviderDefinition,
  ProviderStatus,
  SaveProviderInput,
  SaveProviderResult,
  TestConnectionResult
} from './providers.js'

export interface EzDSHBridge {
  app: {
    name: string
    version: string
  }
  runtime: {
    getStatus(): Promise<RuntimeSnapshot>
    start(): Promise<RuntimeSnapshot>
    restart(): Promise<RuntimeSnapshot>
    openLog(): Promise<void>
    onStateChange(listener: (snapshot: RuntimeSnapshot) => void): () => void
  }
  providers: {
    listDefinitions(): Promise<ProviderDefinition[]>
    getStatus(): Promise<ProviderStatus[]>
    testConnection(input: { providerId: string; apiKey: string; baseUrl?: string }): Promise<TestConnectionResult>
    save(input: SaveProviderInput): Promise<SaveProviderResult>
  }
  locale: {
    get(): Promise<AppLocale>
    onChange(listener: (locale: AppLocale) => void): () => void
  }
  updates: {
    getStatus(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<UpdateState>
    onStateChange(listener: (state: UpdateState) => void): () => void
  }
}

export type { EzDSHError, IpcResult }

declare global {
  interface Window {
    EzDSH: EzDSHBridge
  }
}
