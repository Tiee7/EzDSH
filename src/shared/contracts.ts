import type { DshRuntimeProcess, RuntimeSnapshot } from '../main/runtime/runtime-types.js'
import type { EzDSHError, IpcResult } from './errors.js'
import type { UpdateState } from './update.js'
import type { AppLocale } from './locale.js'
import type { WorkspaceOperationState, WorkspaceSnapshot } from './state.js'
import type { NavigationTarget } from './navigation.js'
import type { NavConfig } from './navigation.js'
import type { AppPlatform } from './platform.js'
import type { ProxyProfileInput, ProxySettingsSnapshot, ProxyTestResult } from './proxy.js'
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
import type { MobileRemoteSnapshot } from './mobile-remote.js'
import type { NotificationSettings, NotificationSignal } from './notifications.js'
import type {
  RecoveryDryRun,
  RecoveryDoctorResult,
  RecoveryRestoreResult,
  RecoverySnapshot,
  RecoveryState,
  RecoveryVerifyResult,
} from '../main/recovery/recovery-manager.js'
import type {
  ExternalServiceCreateInput,
  ExternalServiceSnapshot,
  ExternalServiceUpdateInput,
} from './external-services.js'
import type {
  EmployeeCreateInput,
  EmployeeProjectSummary,
  EmployeeRunRequest,
  EmployeeRunResult,
  EmployeeSessionLock,
  EmployeeSnapshot,
  EmployeeSessionSummary,
  EmployeeUpdateInput,
} from './employees.js'
import type {
  WorkflowCreateInput,
  WorkflowDefinition,
  WorkflowGenerateRequest,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowUpdateInput,
  WorkflowValue,
  WorkflowModelOption,
} from './workflow.js'

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
    listProcesses(): Promise<DshRuntimeProcess[]>
    stopProcess(pid: number): Promise<void>
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
    categories(kind: StoreKind): Promise<StoreCategory[]>
    /** Start an install: downloads and audits, then resolves at `confirm-wait` with the audit report. */
    install(kind: StoreKind, id: string): Promise<InstallState>
    /** Re-run the audit and install once despite a blocking verdict, only after explicit user action. */
    installAnyway(kind: StoreKind, id: string): Promise<InstallState>
    /** Answer a `confirm-wait` prompt; `accepted: false` cancels with `user-cancelled`. */
    confirmInstall(kind: StoreKind, id: string, accepted: boolean): Promise<InstallState>
    update(kind: StoreKind, id: string): Promise<InstallState>
    uninstall(kind: StoreKind, id: string): Promise<InstallState>
    listInstalled(): Promise<InstalledListResult>
    /** Explicitly refresh the catalog from the remote source; resolves with the fetch timestamp. */
    refresh(kind: StoreKind): Promise<StoreRefreshResult>
    onStateChange(listener: (state: InstallState) => void): () => void
  }
  employees: {
    list(): Promise<EmployeeSnapshot[]>
    listProjects(): Promise<EmployeeProjectSummary[]>
    listSessions(projectId?: string): Promise<EmployeeSessionSummary[]>
    createSession(projectId: string, title?: string): Promise<EmployeeSessionSummary>
    listSessionLocks(): Promise<EmployeeSessionLock[]>
    forceUnlockSession(sessionId: string): Promise<void>
    create(input: EmployeeCreateInput): Promise<EmployeeSnapshot>
    update(id: string, input: EmployeeUpdateInput): Promise<EmployeeSnapshot>
    remove(id: string): Promise<void>
    setEnabled(id: string, enabled: boolean): Promise<EmployeeSnapshot>
    run(id: string, request: EmployeeRunRequest): Promise<EmployeeRunResult>
    onStateChange(listener: (employees: EmployeeSnapshot[]) => void): () => void
    onLockChange(listener: (locks: EmployeeSessionLock[]) => void): () => void
  }
  workflows: {
    list(): Promise<WorkflowDefinition[]>
    get(id: string): Promise<WorkflowDefinition | undefined>
    create(input: WorkflowCreateInput): Promise<WorkflowDefinition>
    update(id: string, input: WorkflowUpdateInput): Promise<WorkflowDefinition>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<WorkflowDefinition>
    generate(request: WorkflowGenerateRequest): Promise<WorkflowDefinition>
    importEmployee(employeeId: string): Promise<WorkflowDefinition>
    listRuns(workflowId?: string): Promise<WorkflowRunRecord[]>
    getRun(runId: string): Promise<WorkflowRunRecord | undefined>
    start(workflowId: string, input: WorkflowValue, options?: WorkflowRunOptions): Promise<WorkflowRunRecord>
    resume(runId: string): Promise<WorkflowRunRecord>
    cancel(runId: string): Promise<WorkflowRunRecord>
    approve(runId: string, approved: boolean): Promise<WorkflowRunRecord>
    onStateChange(listener: (record: WorkflowRunRecord) => void): () => void
  }
  settings: {
    setLocale(locale: AppLocale): Promise<void>
    getLanguageTagVisible(): Promise<boolean>
    setLanguageTagVisible(visible: boolean): Promise<boolean>
    onLanguageTagVisibilityChange(listener: (visible: boolean) => void): () => void
    openHarnessDir(): Promise<void>
    getDeveloperMode(): Promise<boolean>
    setDeveloperMode(enabled: boolean): Promise<boolean>
    onDeveloperModeChange(listener: (enabled: boolean) => void): () => void
    getWorkspace(): Promise<WorkspaceSnapshot>
    selectWorkspace(): Promise<string | undefined>
    migrateWorkspace(root: string): Promise<void>
    switchWorkspace(root: string): Promise<void>
    onWorkspaceChange(listener: (state: WorkspaceOperationState | undefined) => void): () => void
    getProxyConfig(): Promise<ProxySettingsSnapshot>
    saveProxy(input: ProxyProfileInput): Promise<ProxySettingsSnapshot>
    activateProxy(id?: string): Promise<ProxySettingsSnapshot>
    deleteProxy(id: string): Promise<ProxySettingsSnapshot>
    testProxy(id: string): Promise<ProxyTestResult>
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
    listWorkflowModels(): Promise<WorkflowModelOption[]>
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
  notifications: {
    getSettings(): Promise<NotificationSettings>
    setSettings(settings: NotificationSettings): Promise<NotificationSettings>
    onSettingsChange(listener: (settings: NotificationSettings) => void): () => void
    onEvent(listener: (notification: NotificationSignal) => void): () => void
  }
  updates: {
    getStatus(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<UpdateState>
    onStateChange(listener: (state: UpdateState) => void): () => void
  }
  recovery: {
    getStatus(): Promise<RecoveryState>
    listSnapshots(): Promise<RecoverySnapshot[]>
    createSnapshot(): Promise<RecoverySnapshot>
    deleteSnapshot(selector: string): Promise<void>
    verify(selector: string): Promise<RecoveryVerifyResult>
    doctor(repair?: boolean): Promise<RecoveryDoctorResult>
    restore(selector: string, dryRun: boolean): Promise<RecoveryDryRun | RecoveryRestoreResult>
    enterSafeMode(): Promise<RuntimeSnapshot>
    exitSafeMode(): Promise<RuntimeSnapshot>
    rollbackPendingPlugin(): Promise<RecoveryRestoreResult>
    resolve(): Promise<void>
    openDirectory(): Promise<void>
    onStateChange(listener: (state: RecoveryState) => void): () => void
  }
  channelBridge: {
    getConfig(): Promise<ChannelBridgeConfig>
    setConfig(config: ChannelBridgeConfig): Promise<void>
    getConfigPath(): Promise<string>
    listSessions(): Promise<DshSessionSummary[]>
    listArchivedSessions(): Promise<DshSessionSummary[]>
    unarchiveSession(sessionId: string): Promise<void>
    deleteArchivedSession(sessionId: string): Promise<void>
    /** Start a verification-code pairing challenge. Returns the code and expiry. */
    startPairing(): Promise<PairingState>
    /** Cancel the active pairing challenge, if any. */
    cancelPairing(): Promise<void>
    /** Get the current pairing challenge state. */
    getPairingState(): Promise<PairingState>
  }
  mobileRemote: {
    getStatus(): Promise<MobileRemoteSnapshot>
    startPairing(): Promise<MobileRemoteSnapshot>
    cancelPairing(): Promise<MobileRemoteSnapshot>
    approvePairing(requestId: string): Promise<MobileRemoteSnapshot>
    rejectPairing(requestId: string): Promise<MobileRemoteSnapshot>
    startPublicAccess(): Promise<MobileRemoteSnapshot>
    stopPublicAccess(): Promise<MobileRemoteSnapshot>
    disconnectDevice(deviceId: string): Promise<MobileRemoteSnapshot>
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
