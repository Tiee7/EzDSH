import type { RuntimeSnapshot } from '../main/runtime/runtime-types.js'
import type { EzDSHError, IpcResult } from './errors.js'
import type { UpdateState } from './update.js'
import type { AppLocale } from './locale.js'
import type { AppTab } from './navigation.js'
import type { AppPlatform } from './platform.js'
import type {
  InstalledListResult,
  InstallState,
  StoreCategory,
  StoreEntry,
  StoreKind,
  StoreListResult
} from './store.js'
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
    platform: AppPlatform
  }
  runtime: {
    getStatus(): Promise<RuntimeSnapshot>
    start(): Promise<RuntimeSnapshot>
    restart(): Promise<RuntimeSnapshot>
    openLog(): Promise<void>
    onStateChange(listener: (snapshot: RuntimeSnapshot) => void): () => void
  }
  ui: {
    onNavigate(listener: (tab: AppTab) => void): () => void
  }
  store: {
    list(kind: StoreKind, query?: { category?: string; search?: string; page?: number }): Promise<StoreListResult>
    entry(kind: StoreKind, id: string): Promise<StoreEntry>
    categories(): Promise<StoreCategory[]>
    /** Start an install: downloads and audits, then resolves at `confirm-wait` with the audit report. */
    install(kind: StoreKind, id: string): Promise<InstallState>
    /** Answer a `confirm-wait` prompt; `accepted: false` cancels with `user-cancelled`. */
    confirmInstall(kind: StoreKind, id: string, accepted: boolean): Promise<InstallState>
    uninstall(kind: StoreKind, id: string): Promise<InstallState>
    listInstalled(): Promise<InstalledListResult>
    onStateChange(listener: (state: InstallState) => void): () => void
  }
  settings: {
    setLocale(locale: AppLocale): Promise<void>
    openHarnessDir(): Promise<void>
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
