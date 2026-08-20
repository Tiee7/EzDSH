import type { RuntimeSnapshot } from '../main/runtime/runtime-types.js'
import type { EzDSHError, IpcResult } from './errors.js'
import type { UpdateState } from './update.js'
import type { AppLocale } from './locale.js'
import type { NavigationTarget } from './navigation.js'
import type { NavConfig } from './navigation.js'
import type { AppPlatform } from './platform.js'
import type {
  InstalledListResult,
  InstallState,
  StoreCategory,
  StoreEntry,
  StoreKind,
  StoreListResult,
  StoreRefreshResult
} from './store.js'
import type {
  DeleteProviderResult,
  ListModelsInput,
  ProviderDefinition,
  ProviderModel,
  ProviderProfile,
  ProviderStatus,
  SaveProviderInput,
  SaveProviderResult,
  TestConnectionResult,
  TestProviderInput
} from './providers.js'
import type { ChannelBridgeConfig, DshSessionSummary, PairingState } from './channel-bridge.js'
import type {
  ExternalServiceCreateInput,
  ExternalServiceSnapshot,
  ExternalServiceUpdateInput,
} from './external-services.js'

/** Payload sent from main to renderer when a deep-link install should begin. */
export interface DeepLinkInstallTarget {
  kind: StoreKind
  id: string
}

/** Opaque DSH session target sent from the main process to the renderer. */
export interface DeepLinkSessionTarget {
  sessionId: string
}

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
    onNavigate(listener: (tab: NavigationTarget) => void): () => void
    /** Fired when the app is awakened by an `ezdsh://install/...` link. */
    onDeepLinkInstall(listener: (target: DeepLinkInstallTarget) => void): () => void
    /** Fired when the app is awakened by an `ezdsh://session/...` link. */
    onDeepLinkSession(listener: (target: DeepLinkSessionTarget) => void): () => void
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
    /** Explicitly refresh the catalog from the remote source; resolves with the fetch timestamp. */
    refresh(): Promise<StoreRefreshResult>
    onStateChange(listener: (state: InstallState) => void): () => void
  }
  settings: {
    setLocale(locale: AppLocale): Promise<void>
    openHarnessDir(): Promise<void>
  }
  externalServices: {
    list(): Promise<ExternalServiceSnapshot[]>
    create(input: ExternalServiceCreateInput): Promise<ExternalServiceSnapshot>
    update(id: string, input: ExternalServiceUpdateInput): Promise<ExternalServiceSnapshot>
    remove(id: string): Promise<void>
    start(id: string): Promise<ExternalServiceSnapshot>
    stop(id: string): Promise<ExternalServiceSnapshot>
    restart(id: string): Promise<ExternalServiceSnapshot>
    /** Subscribe to process snapshots while the management page is mounted. */
    watch(listener: (snapshots: ExternalServiceSnapshot[]) => void): () => void
  }
  providers: {
    listDefinitions(): Promise<ProviderDefinition[]>
    getStatus(): Promise<ProviderStatus[]>
    testConnection(input: TestProviderInput): Promise<TestConnectionResult>
    listModels(input: ListModelsInput): Promise<ProviderModel[]>
    getProfile(providerId: string): Promise<ProviderProfile | undefined>
    save(input: SaveProviderInput): Promise<SaveProviderResult>
    delete(providerId: string): Promise<DeleteProviderResult>
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
  channelBridge: {
    getConfig(): Promise<ChannelBridgeConfig>
    setConfig(config: ChannelBridgeConfig): Promise<void>
    getConfigPath(): Promise<string>
    listSessions(): Promise<DshSessionSummary[]>
    /** Start a verification-code pairing challenge. Returns the code and expiry. */
    startPairing(): Promise<PairingState>
    /** Cancel the active pairing challenge, if any. */
    cancelPairing(): Promise<void>
    /** Get the current pairing challenge state. */
    getPairingState(): Promise<PairingState>
  }
  navigation: {
    getConfig(): Promise<NavConfig>
    setConfig(config: NavConfig): Promise<void>
    onStateChange(listener: (config: NavConfig) => void): () => void
  }
}

export type { EzDSHError, IpcResult }

declare global {
  interface Window {
    EzDSH: EzDSHBridge
  }
}
