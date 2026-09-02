import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, safeStorage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { AppUpdater } from 'electron-updater'
import type { IpcResult } from '../shared/errors.js'
import { toEzDSHError } from '../shared/errors.js'
import type { RuntimeSnapshot } from './runtime/runtime-types.js'
import type {
  DeleteProviderResult,
  ListModelsInput,
  ProviderModel,
  ProviderProfile,
  SaveProviderInput,
  TestProviderInput
} from '../shared/providers.js'
import {
  PREVIEW_UPDATE_FEED_URL,
  STABLE_UPDATE_FEED_URL,
  UPDATE_RESOLVE_URL,
  type UpdateState,
} from '../shared/update.js'
import { APP_NAME } from '../shared/app-identity.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../shared/locale.js'
import { isDeveloperOnlyTab, type NavigationTarget } from '../shared/navigation.js'
import { findDeepLinkInArgs, parseDeepLink, type DeepLinkInstall, type DeepLinkSession, type ResolvedDeepLinkInstall } from '../shared/deep-link.js'
import { ensureUserDataLayout, getUserDataLayout } from './state/user-data.js'
import type { UserDataLayout, WorkspaceOperationState, WorkspaceSnapshot } from '../shared/state.js'
import {
  getWorkspaceConfigPath,
  isDirectoryEmpty,
  isWorkspaceTargetInsideSource,
  moveWorkspaceContents,
  readWorkspaceRoot,
  writeWorkspaceRoot,
} from './state/workspace-service.js'
import { readDeveloperMode, writeDeveloperMode } from './state/developer-mode.js'
import { readLanguageTagVisible, writeLanguageTagVisible } from './state/language-tag.js'
import type { StoreKind } from '../shared/store.js'
import { StoreService } from './store/store-service.js'
import { StoreClient } from './store/store-client.js'
import { createDemoFetch } from './store/demo-catalog.js'
import { DshPluginInstaller } from './store/dsh-plugin-installer.js'
import { repairInstalledDshPlugin } from './store/dsh-plugin-compatibility.js'
import { importCodexAuth } from './store/codex-auth-importer.js'
import {
  applyDshPluginCompatibilityWorkaround,
  createDshPluginCommand,
  readBundledVersions,
  resolveBundledPnpm,
} from './store/dsh-plugin-command.js'
import { parseDshCliInvocation, runDshCli } from './cli/dsh-cli.js'
import {
  RuntimeManager,
  resolveRuntimeCommandPath,
  resolveRuntimeEntryPath
} from './runtime/runtime-manager.js'
import { SafeModeController } from './runtime/safe-mode-home.js'
import {
  createRuntimeOwnershipStore,
  DshRuntimeProcessManager,
  type RuntimeOwnershipStore,
} from './runtime/runtime-process-manager.js'
import { ProviderService } from './providers/provider-service.js'
import { UpdateManager } from './update/update-manager.js'
import { getApplicationMenuTemplate } from './application-menu.js'
import { LocaleService, writeDshLocale } from './locale/locale-service.js'
import { ChannelBridgeService } from './channel-bridge/index.js'
import { DshSessionClient } from './channel-bridge/dsh-session.js'
import { deleteArchivedSessionFromStore } from './channel-bridge/archived-session-store.js'
import { openDeepLinkedSession } from './session-deep-link.js'
import { NavigationService } from './navigation/navigation-service.js'
import { getNavigationTargetForInput } from './navigation/navigation-shortcuts.js'
import { ExternalApiService } from './external-api/external-api-service.js'
import { EXTERNAL_API_DEFAULT_PORT } from '../shared/external-api.js'
import type { NavConfig } from '../shared/navigation.js'
import { AdapterRegistry } from './channel-bridge/adapter-registry.js'
import { ChannelAdapterLoader } from './channel-bridge/adapter-loader.js'
import { MobileRemoteService } from './mobile/mobile-remote-service.js'
import type { MobileRemoteSnapshot } from '../shared/mobile-remote.js'
import { ExternalServiceManager } from './external-services/external-service-manager.js'
import type { ExternalServiceCreateInput, ExternalServiceUpdateInput } from '../shared/external-services.js'
import { EmployeeService } from './employees/employee-service.js'
import type { EmployeeCreateInput, EmployeeGenerateRequest, EmployeeProjectSummary, EmployeeRunRequest, EmployeeSessionLock, EmployeeSessionSummary, EmployeeUpdateInput } from '../shared/employees.js'
import { WorkflowStore } from './workflow/workflow-store.js'
import { WorkflowRunStore } from './workflow/workflow-run-store.js'
import { WorkflowRunService } from './workflow/workflow-run-service.js'
import { WorkflowGenerationService } from './workflow/workflow-generation-service.js'
import { WorkflowModificationService } from './workflow/workflow-modification-service.js'
import { WorkflowLightweightClient } from './workflow/workflow-lightweight-client.js'
import { WorkflowRuntimeClient } from './workflow/workflow-runtime-client.js'
import { WorkflowMcpClient } from './workflow/workflow-mcp-client.js'
import { WorkflowInternalSessionStore } from './workflow/workflow-internal-session-store.js'
import { WorkflowAiDiagnostics } from './workflow/workflow-ai-diagnostics.js'
import { WorkflowCredentialStore, createSafeStorageProtector } from './workflow/workflow-credential-service.js'
import { WorkflowConnectorStore } from './workflow/workflow-connector-store.js'
import { WorkflowConnectorService } from './workflow/workflow-connector-service.js'
import { workflowFromEmployee } from './workflow/employee-workflow.js'
import type { WorkflowCreateInput, WorkflowGenerateRequest, WorkflowModifyRequest, WorkflowRunOptions, WorkflowUpdateInput, WorkflowValue, WorkflowCredentialUpsertInput, WorkflowHttpConnector } from '../shared/workflow.js'
import { bindWindowClosedCleanup } from './window-lifecycle.js'
import { shutdownExternalServicesFirst } from './shutdown.js'
import { restartApplication, shouldRelaunchWorkspace } from './restart.js'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
  type NotificationSettings,
  type NotificationSignal,
} from '../shared/notifications.js'
import { readNotificationSettings, writeNotificationSettings } from './notifications/notification-settings.js'
import { RuntimeNotificationService } from './notifications/runtime-notification-service.js'
import { NativeNotificationService, type NativeNotificationLike } from './notifications/native-notification-service.js'
import {
  CURRENT_DATA_SCHEMA_VERSION,
  RecoveryManager,
  type RecoveryDryRun,
  type RecoveryDoctorResult,
  type RecoveryRestoreResult,
  type RecoveryState,
} from './recovery/recovery-manager.js'
import { PluginRecoveryCoordinator } from './recovery/plugin-recovery-coordinator.js'
import { ProxyService } from './proxy/proxy-service.js'
import type { ProxyProfileInput, ProxySettingsSnapshot } from '../shared/proxy.js'
import type { ProxyTestResult } from '../shared/proxy.js'

let mainWindow: BrowserWindow | undefined
let runtimeManager: RuntimeManager | undefined
let runtimeProcessManager: DshRuntimeProcessManager | undefined
let runtimeOwnershipStore: RuntimeOwnershipStore | undefined
let providerService: ProviderService | undefined
let proxyService: ProxyService | undefined
let localeService: LocaleService | undefined
let updateManager: UpdateManager | undefined
let recoveryManager: RecoveryManager | undefined
let safeModeController: SafeModeController | undefined
let pluginRecoveryCoordinator: PluginRecoveryCoordinator | undefined
let userDataLayout: UserDataLayout | undefined
let workspaceConfigPath: string | undefined
let developerModePath: string | undefined
let developerMode = false
let languageTagPath: string | undefined
let languageTagVisible = true
let notificationSettingsPath: string | undefined
let notificationSettings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS }
let notificationSettingsWriteChain: Promise<void> = Promise.resolve()
let runtimeNotificationService: RuntimeNotificationService | undefined
let nativeNotificationService: NativeNotificationService | undefined
let notificationRuntimeUrl: string | undefined
let storeService: StoreService | undefined
let channelBridgeService: ChannelBridgeService | undefined
let navigationService: NavigationService | undefined
let externalApiService: ExternalApiService | undefined
let mobileRemoteService: MobileRemoteService | undefined
let externalServiceManager: ExternalServiceManager | undefined
let employeeService: EmployeeService | undefined
let workflowStore: WorkflowStore | undefined
let workflowRunStore: WorkflowRunStore | undefined
let workflowRunService: WorkflowRunService | undefined
let workflowCredentialStore: WorkflowCredentialStore | undefined
let workflowConnectorStore: WorkflowConnectorStore | undefined
let workflowConnectorService: WorkflowConnectorService | undefined
let workflowGenerationService: WorkflowGenerationService | undefined
let workflowModificationService: WorkflowModificationService | undefined
let isQuitting = false
let updateDialogOpen = false
let workspaceOperationActive = false
let pendingDeepLinkInstall: DeepLinkInstall | undefined
let pendingDeepLinkSession: DeepLinkSession | undefined
const require = createRequire(import.meta.url)
const externalServiceWatchers = new Set<number>()
let stopRuntimeListener: (() => void) | undefined
let stopLocaleListener: (() => void) | undefined
let stopExternalServiceWatcher: (() => void) | undefined
let stopEmployeeWatcher: (() => void) | undefined
let stopEmployeeLockWatcher: (() => void) | undefined
let stopWorkflowWatcher: (() => void) | undefined
let stopWorkflowGenerationWatcher: (() => void) | undefined
let stopWorkflowModificationWatcher: (() => void) | undefined
let stopRecoveryListener: (() => void) | undefined

const LIGHT_WINDOW_BACKGROUND = '#f9fafb'
const DARK_WINDOW_BACKGROUND = '#151517'

function resolveExternalApiPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return EXTERNAL_API_DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`EZDSH_EXTERNAL_API_PORT must be an integer from 1 to 65535, got ${raw}`)
  }
  return port
}

function getWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND
}

function syncWindowBackgroundColor(): void {
  const backgroundColor = getWindowBackgroundColor()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor)
  }
}

function getAutoUpdater(): AppUpdater {
  return (require('electron-updater') as typeof import('electron-updater')).autoUpdater
}

function resolveUpdateFeedUrl(): string | undefined {
  const configured = process.env.EZDSH_UPDATE_FEED_URL?.trim()
  if (configured !== undefined && configured !== '') return configured
  if (!app.isPackaged) {
    const resolverConfigured = process.env.EZDSH_UPDATE_RESOLVE_URL?.trim()
    if (resolverConfigured === undefined || resolverConfigured === '') return undefined
  }
  return developerMode ? PREVIEW_UPDATE_FEED_URL : STABLE_UPDATE_FEED_URL
}

function resolveUpdateResolverUrl(): string | undefined {
  const configured = process.env.EZDSH_UPDATE_RESOLVE_URL?.trim()
  if (configured !== undefined && configured !== '') return configured
  if (!app.isPackaged) return undefined
  return UPDATE_RESOLVE_URL
}

async function readDshRuntimeVersion(runtimeEntryPath: string): Promise<string> {
  try {
    const packagePath = join(resolve(runtimeEntryPath, '..', '..'), 'package.json')
    const parsed: unknown = JSON.parse(await readFile(packagePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
      return parsed.version
    }
  } catch {
    // A source checkout may omit package metadata; the recovery manifest still records the app.
  }
  return 'unknown'
}

function allowPrereleaseUpdates(): boolean {
  return developerMode || app.getVersion().includes('-')
}

function emitDeveloperMode(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('developer-mode:state-change', developerMode)
  }
}

function emitLanguageTagVisibility(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('language-tag:state-change', languageTagVisible)
  }
}

function emitNotificationSettings(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('notifications:state-change', notificationSettings)
  }
}

function handleNotificationSignal(notification: NotificationSignal): void {
  nativeNotificationService?.notify(notification)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('notifications:event', notification)
  }
}

const CLI_PROFILE_NAME = /^[a-z][a-z0-9-]*$/

function dshProfileFromArgs(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--profile') {
      const profile = args[index + 1]
      return profile !== undefined && CLI_PROFILE_NAME.test(profile) ? profile : undefined
    }
    if (argument?.startsWith('--profile=')) {
      const profile = argument.slice('--profile='.length)
      return CLI_PROFILE_NAME.test(profile) ? profile : undefined
    }
  }
  return 'web'
}

/** Execute a DSH command without creating the EzDSH window or touching Runtime ownership. */
async function runDshCliMode(dshArgs: readonly string[]): Promise<void> {
  try {
    app.setName(APP_NAME)
    await app.whenReady()
    const workspaceConfigPath = getWorkspaceConfigPath(app.getPath('appData'))
    const workspaceRoot = await readWorkspaceRoot(workspaceConfigPath, app.getPath('userData'))
    const layout = getUserDataLayout(workspaceRoot)
    await ensureUserDataLayout(layout)

    const appPath = app.getAppPath()
    const runtimeEntryPath = resolveRuntimeEntryPath({
      appPath,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      developmentSourceRoot: process.env.EZDSH_DSH_SOURCE?.trim() || undefined
    })
    const runtimeCommandPath = resolveRuntimeCommandPath({
      appPath,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      arch: process.arch
    })
    const versions = await readBundledVersions(appPath)
    const profile = dshProfileFromArgs(dshArgs)
    const profileHasWorkspaceFile = profile !== undefined
      && existsSync(join(layout.harness, 'profiles', profile, 'pnpm-workspace.yaml'))
    const forwardedArgs = applyDshPluginCompatibilityWorkaround(dshArgs, {
      ...versions,
      profileHasWorkspaceFile
    })
    const exitCode = await runDshCli({
      command: runtimeCommandPath ?? process.execPath,
      runtimeEntryPath,
      pnpmPath: resolveBundledPnpm(appPath),
      dshHome: layout.harness,
      dshArgs: forwardedArgs,
      launchRoot: layout.launchRoot,
      environment: process.env
    })
    app.exit(exitCode)
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`EzDSH CLI failed:\n${message}`)
    app.exit(1)
  }
}

function syncRuntimeNotifications(snapshot: RuntimeSnapshot): void {
  const nextUrl = snapshot.phase === 'ready' ? snapshot.url : undefined
  if (nextUrl === notificationRuntimeUrl) return
  notificationRuntimeUrl = nextUrl
  if (nextUrl === undefined) {
    runtimeNotificationService?.stop()
  } else {
    runtimeNotificationService?.start(nextUrl)
  }
}

function emitRecoveryState(state: RecoveryState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('recovery:state-change', state)
  }
}

function showAppMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined
  return window === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options)
}

function emitWorkspaceState(state: WorkspaceOperationState | undefined): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('workspace:state-change', state)
  }
}

async function handleRuntimeBootFailure(snapshot: RuntimeSnapshot): Promise<void> {
  const recovery = recoveryManager
  if (recovery === undefined) return
  const state = await recovery.markBootFailure(snapshot.message ?? 'DSH Runtime failed to start')
  if (state.phase !== 'recovery-required' || state.pendingTransaction === undefined) return
  const reason = state.pendingTransaction.kind === 'update' ? 'update-recovery' : 'plugin-recovery'
  await pluginRecoveryCoordinator?.startSafeMode(reason)
}

async function assertWorkspaceTarget(root: string): Promise<string> {
  const trimmed = root.trim()
  if (trimmed === '') throw new Error('Workspace target cannot be empty')
  const target = resolve(trimmed)
  if (userDataLayout === undefined) throw new Error('User data layout is not ready')
  if (target === userDataLayout.root) throw new Error('Workspace target must be different from the current workspace')
  if (isWorkspaceTargetInsideSource(userDataLayout.root, target)) {
    throw new Error('Workspace target cannot be inside the current workspace')
  }
  return target
}

function bindWorkspaceServiceListeners(): void {
  stopRuntimeListener?.()
  stopRuntimeListener = runtimeManager?.onChange((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('runtime:state-change', snapshot)
    }
    if (snapshot.phase === 'ready') {
      syncRuntimeNotifications(snapshot)
      void externalServiceManager?.startAutoServices().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[external-services] failed to start auto services:', message)
      })
    } else {
      syncRuntimeNotifications(snapshot)
    }
    if (snapshot.phase === 'ready' && snapshot.mode === 'normal') {
      void recoveryManager?.completePendingTransaction().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[recovery] failed to commit recovery transaction:', message)
      })
    } else if (snapshot.phase === 'failed' && snapshot.mode === 'normal') {
      void handleRuntimeBootFailure(snapshot).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[recovery] failed to record boot failure:', message)
      })
    }
  })

  stopLocaleListener?.()
  stopLocaleListener = localeService?.onChange((locale) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('locale:state-change', locale)
    }
    setApplicationMenu(locale)
  })
}

/** Construct every service that is rooted in the active workspace. */
async function initializeWorkspaceServices(layout: UserDataLayout): Promise<void> {
  userDataLayout = layout
  stopRecoveryListener?.()
  stopRecoveryListener = undefined
  developerModePath = join(layout.state, 'developer-mode.json')
  developerMode = await readDeveloperMode(developerModePath)
  languageTagPath = join(layout.state, 'language-tag.json')
  languageTagVisible = await readLanguageTagVisible(languageTagPath)
  notificationSettingsPath = join(layout.state, 'notifications.json')
  notificationSettings = await readNotificationSettings(notificationSettingsPath)

  if (await repairInstalledDshPlugin(layout.harness, 'web', 'dsh-codex')) {
    console.warn('[dsh-plugin] repaired dsh-codex account status compatibility')
  }
  if (await importCodexAuth(
    join(layout.harness, '.credentials.yaml'),
    undefined,
    join(layout.state, 'codex-auth-imported'),
  )) {
    console.warn('[dsh-plugin] imported the existing local Codex OAuth session')
  }

  localeService = new LocaleService(join(layout.harness, 'settings.yaml'))
  await localeService.start()

  const runtimeEntryPath = resolveRuntimeEntryPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    developmentSourceRoot: process.env.EZDSH_DSH_SOURCE?.trim() || undefined
  })
  const runtimeCommandPath = resolveRuntimeCommandPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    arch: process.arch
  })
  const dshRuntimeVersion = await readDshRuntimeVersion(runtimeEntryPath)
  proxyService = new ProxyService({
    configPath: join(layout.state, 'proxy.json'),
    applyRuntime: async () => {
      const phase = runtimeManager?.snapshot().phase
      if (phase === 'ready' || phase === 'starting') await runtimeManager?.restart()
    },
  })
  await proxyService.initialize()
  recoveryManager = new RecoveryManager({
    layout,
    appVersion: app.getVersion(),
    dshRuntimeVersion,
    dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
    rescueScriptPath: join(app.getAppPath(), 'recovery', 'rescue.mjs'),
  })
  await recoveryManager.initialize()
  stopRecoveryListener = recoveryManager.onChange(emitRecoveryState)
  runtimeOwnershipStore ??= createRuntimeOwnershipStore(join(app.getPath('appData'), 'ezdsh-runtime-ownership'))
  runtimeProcessManager ??= new DshRuntimeProcessManager({
    getCurrentPid: () => runtimeManager?.snapshot().pid,
    stopCurrent: () => runtimeManager?.stop() ?? Promise.resolve(),
    ownershipStore: runtimeOwnershipStore,
  })
  await runtimeProcessManager.stopOwnedOrphans()
  runtimeManager = new RuntimeManager({
    layout,
    runtimeEntryPath,
    command: runtimeCommandPath,
    runtimeOwnership: runtimeOwnershipStore,
    getEnvironment: () => proxyService?.getRuntimeEnvironment() ?? { ...process.env },
  })
  mobileRemoteService = new MobileRemoteService({
    statePath: join(layout.state, 'mobile-remote.json'),
    getRuntimeUrl: () => runtimeManager?.snapshot().url,
    appIconPath: getAppIconPath(),
    getLocale: () => localeService?.snapshot() ?? DEFAULT_APP_LOCALE,
  })
  await mobileRemoteService.initialize()
  await mobileRemoteService.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[mobile-remote] failed to start:', message)
  })
  safeModeController = new SafeModeController({ layout })
  await safeModeController.initialize()
  pluginRecoveryCoordinator = new PluginRecoveryCoordinator({
    runtime: runtimeManager,
    recovery: recoveryManager,
    safeMode: safeModeController,
  })
  runtimeNotificationService = new RuntimeNotificationService({ onSignal: handleNotificationSignal })
  nativeNotificationService = new NativeNotificationService({
    createNotification: (options) => new Notification({
      ...options,
      icon: getAppIconPath(),
    }) as unknown as NativeNotificationLike,
    getSettings: () => notificationSettings,
    getLocale: () => localeService?.snapshot() ?? DEFAULT_APP_LOCALE,
    onReview: (sessionId) => handleDeepLinkSession({ action: 'session', sessionId }),
  })
  const pluginInstaller = new DshPluginInstaller({
    dshHome: layout.harness,
    runCommand: createDshPluginCommand({
      appPath: app.getAppPath(),
      dshHome: layout.harness,
      launchRoot: layout.launchRoot,
      logsDir: layout.logs,
      runtimeEntryPath,
      command: runtimeCommandPath
    }),
    isRuntimeActive: () => {
      const phase = runtimeManager?.snapshot().phase
      return phase === 'ready' || phase === 'starting'
    }
  })

  externalServiceManager = new ExternalServiceManager({
    configPath: join(layout.state, 'external-services.json'),
    logsDir: join(layout.logs, 'external-services'),
  })
  await externalServiceManager.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[external-services] failed to initialize:', message)
  })
  stopExternalServiceWatcher?.()
  stopExternalServiceWatcher = externalServiceManager.watch(emitExternalServiceState)

  stopEmployeeWatcher?.()
  stopEmployeeLockWatcher?.()
  stopWorkflowWatcher?.()
  stopWorkflowWatcher = undefined
  stopWorkflowGenerationWatcher?.()
  stopWorkflowGenerationWatcher = undefined
  stopWorkflowModificationWatcher?.()
  stopWorkflowModificationWatcher = undefined
  const createWorkflowSessionClient = (): DshSessionClient => {
    const runtimeUrl = runtimeManager?.snapshot().url
    if (runtimeUrl === undefined) throw new Error('DSH Runtime 尚未启动')
    return new DshSessionClient({ baseUrl: runtimeUrl, timeoutMs: 10 * 60 * 1000 })
  }
  const runtimeWorkflowClient = new WorkflowRuntimeClient({
    cwd: layout.workflowRoot,
    createClient: createWorkflowSessionClient,
  })
  const lightweightClient = new WorkflowLightweightClient({
    resolveProfile: async (selection) => {
      if (providerService === undefined) throw new Error('模型供应商服务尚未初始化')
      return providerService.resolveWorkflowModel(selection)
    },
    completeWithRuntime: (request) => runtimeWorkflowClient.complete(request),
  })
  employeeService = new EmployeeService({
    configPath: join(layout.state, 'employees.json'),
    cwd: layout.root,
    lightweightClient,
    getLocale: () => localeService?.snapshot() ?? DEFAULT_APP_LOCALE,
    createClient: createWorkflowSessionClient,
  })
  await employeeService.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[employees] failed to initialize:', message)
  })
  stopEmployeeWatcher = employeeService.watch(emitEmployeeState)
  stopEmployeeLockWatcher = employeeService.watchSessionLocks(emitEmployeeLockState)

  workflowStore = new WorkflowStore(layout.state)
  workflowRunStore = new WorkflowRunStore(layout.state)
  workflowCredentialStore = new WorkflowCredentialStore(layout.state, { protector: createSafeStorageProtector(safeStorage) })
  workflowConnectorStore = new WorkflowConnectorStore(layout.state)
  await workflowCredentialStore.initialize()
  await workflowConnectorStore.initialize()
  workflowConnectorService = new WorkflowConnectorService({
    connectors: workflowConnectorStore,
    credentials: workflowCredentialStore,
  })
  const workflowAiDiagnostics = new WorkflowAiDiagnostics(layout.logs)
  workflowRunService = new WorkflowRunService({
    workflowStore,
    runStore: workflowRunStore,
    workflowRoot: layout.workflowRoot,
    nodeCommandPath: runtimeCommandPath,
    createClient: createWorkflowSessionClient,
    resolveEmployee: (id) => employeeService?.get(id),
    listEmployees: () => employeeService?.list() ?? [],
    createEmployee: (input) => {
      if (employeeService === undefined) throw new Error('员工服务尚未就绪')
      return employeeService.create(input)
    },
    getLocale: () => localeService?.snapshot() ?? DEFAULT_APP_LOCALE,
    loadWorkflowAiDocumentation: readWorkflowAiDocumentation,
    createGenerationSession: ({ sessionId, model }) => sessionId === undefined
      ? runtimeWorkflowClient.createSession(model)
      : runtimeWorkflowClient.resumeSession(sessionId, model),
    lightweightClient,
    mcpClient: new WorkflowMcpClient({ patchPath: join(layout.harness, 'profiles', 'web', 'cordis.patch.yml') }),
    connectorService: workflowConnectorService,
    allowLegacyHttp: false,
    executeSubWorkflow: async (childWorkflowId, input, waitForCompletion, version, childOptions) => {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (workflowStore === undefined) throw new Error('Workflow store is not ready')
      const childDefinition = workflowStore.get(childWorkflowId)
      if (childDefinition === undefined) throw new Error(`子工作流不存在：${childWorkflowId}`)
      if (typeof version === 'number' && childDefinition.revision !== version) throw new Error(`子工作流版本不匹配：需要 v${version}，当前为 v${childDefinition.revision}。`)
      const child = await workflowRunService.start(childWorkflowId, input, { ...(childOptions ?? {}), ...(typeof version === 'number' ? { workflowRevision: version } : {}) })
      if (!waitForCompletion) return { runId: child.id }
      const deadline = Date.now() + 10 * 60 * 1_000
      while (Date.now() < deadline) {
        const current = workflowRunService.get(child.id)
        if (current?.status === 'completed') return current.output ?? null
        if (current?.status === 'failed' || current?.status === 'cancelled') throw new Error(current.error ?? '子工作流执行失败。')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('子工作流执行超时。')
    },
    internalSessionStore: new WorkflowInternalSessionStore(layout.state),
  })
  await workflowRunService.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[workflows] failed to initialize:', message)
  })
  await workflowRunService.cleanupExpiredInternalArtifacts(async (sessionId) => {
    const deleted = await deleteArchivedSessionFromStore(layout.harness, sessionId)
    if (!deleted) throw new Error(`Workflow 内部 Session ${sessionId} 不在 DSH 归档列表中，保留以便下次安全重试`)
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[workflows] failed to clean retained internal sessions:', message)
  })
  stopWorkflowWatcher = workflowRunService.watch(emitWorkflowState)
  workflowGenerationService = new WorkflowGenerationService({ stateDir: layout.state, runService: workflowRunService, diagnostics: workflowAiDiagnostics })
  await workflowGenerationService.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[workflows] failed to initialize generation history:', message)
  })
  stopWorkflowGenerationWatcher = workflowGenerationService.watch(emitWorkflowGenerationState)
  workflowModificationService = new WorkflowModificationService({ stateDir: layout.state, runService: workflowRunService, diagnostics: workflowAiDiagnostics })
  await workflowModificationService.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[workflows] failed to initialize modification history:', message)
  })
  stopWorkflowModificationWatcher = workflowModificationService.watch(emitWorkflowModificationState)

  externalApiService = new ExternalApiService({
    getRuntimeUrl: () => runtimeManager?.snapshot().url,
    port: resolveExternalApiPort(process.env.EZDSH_EXTERNAL_API_PORT),
    runStatePath: join(layout.state, 'external-runs.json'),
  })
  await externalApiService.start()
  console.log(`[external-api] listening at ${externalApiService.url}`)

  const channelBridgeRegistry = new AdapterRegistry()
  const adapterLoader = new ChannelAdapterLoader({ registry: channelBridgeRegistry, logger: console })
  const builtinAdaptersDir = join(app.getAppPath(), 'plugins')
  const userAdaptersDir = join(layout.harness, 'channel-adapters')
  await adapterLoader.loadFromDirectories([builtinAdaptersDir, userAdaptersDir]).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[channel-bridge] failed to load adapters:', message)
  })
  channelBridgeService = new ChannelBridgeService({
    layout,
    getRuntimeUrl: () => runtimeManager?.snapshot().url,
    isDeveloperMode: () => developerMode,
    stopRuntime: () => runtimeManager?.stop() ?? Promise.resolve(),
    startRuntime: async () => { await runtimeManager?.start() },
    registry: channelBridgeRegistry,
  })
  await channelBridgeService.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[channel-bridge] failed to initialize:', message)
  })

  providerService = new ProviderService(layout, {
    listRuntimeModels: async () => {
      const catalog = await createWorkflowSessionClient().getModelCatalog()
      return catalog.groups.flatMap((group) => group.models.map((model) => ({
        providerId: group.id,
        providerName: group.name,
        modelId: model.id,
        modelName: model.name,
      })))
    },
  })
  await providerService.initialize()
  navigationService = new NavigationService(layout.state)
  await navigationService.initialize()
  storeService = new StoreService({
    client: new StoreClient(),
    fetchImpl: createDemoFetch(),
    dshHome: layout.harness,
    registryPath: join(layout.state, 'installed.json'),
    catalogCachePath: join(layout.state, 'store-catalog.json'),
    pluginInstaller,
    pluginRecovery: pluginRecoveryCoordinator,
    dshRuntimeVersion: () => dshRuntimeVersion,
    onStateChange: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('store:state-change', state)
      }
    }
  })

  bindWorkspaceServiceListeners()
}

async function changeWorkspace(kind: 'migrate' | 'switch', root: string): Promise<void> {
  if (workspaceOperationActive) throw new Error('Another workspace operation is already in progress')
  if (userDataLayout === undefined || workspaceConfigPath === undefined) {
    throw new Error('Workspace service is not ready')
  }

  const target = await assertWorkspaceTarget(root)
  if (kind === 'migrate') {
    if (!(await isDirectoryEmpty(target))) throw new Error('Workspace target must be an existing empty folder')
    const copy = getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)
    const confirmation = await showAppMessageBox({
      type: 'question',
      title: copy.settingsWorkspaceMigrate,
      message: copy.settingsWorkspaceMigrate,
      detail: copy.settingsWorkspaceMigrateConfirmDetail,
      buttons: [copy.settingsWorkspaceMigrateConfirm, copy.storeCancel],
      defaultId: 0,
      cancelId: 1
    })
    if (confirmation.response !== 0) return
  }

  workspaceOperationActive = true
  emitWorkspaceState({
    phase: kind === 'migrate' ? 'moving' : 'switching',
    message: kind === 'migrate'
      ? (getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)).settingsWorkspaceMoving
      : (getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)).settingsWorkspaceSwitching
  })

  try {
    // Stop every process that can write into the old root before touching its contents.
    await stopApplicationComponents()
    if (kind === 'migrate') await moveWorkspaceContents(userDataLayout.root, target)

    const nextLayout = getUserDataLayout(target)
    await ensureUserDataLayout(nextLayout)
    await writeWorkspaceRoot(workspaceConfigPath, target)
    emitWorkspaceState({
      phase: 'restarting',
      message: (getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)).settingsWorkspaceRestarting
    })

    // In packaged builds, a clean relaunch gives an empty switch the exact
    // first-run initialization path. In development, electron-vite owns the
    // renderer server and exits as soon as this Electron child exits, so a
    // relaunch would leave the new window pointed at a dead Vite URL.
    if (shouldRelaunchWorkspace(app.isPackaged)) {
      setTimeout(() => {
        isQuitting = true
        restartApplication(app, process.argv.slice(1))
      }, 250)
      return
    }

    stopRuntimeListener?.()
    stopRuntimeListener = undefined
    stopLocaleListener?.()
    stopLocaleListener = undefined
    localeService?.stop()
    await initializeWorkspaceServices(nextLayout)
    setApplicationMenu()
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      await loadRenderer(mainWindow)
    }
    workspaceOperationActive = false
    emitWorkspaceState(undefined)
  } catch (error) {
    await Promise.allSettled([
      runtimeManager?.start() ?? Promise.resolve(),
      externalApiService?.start() ?? Promise.resolve(),
      channelBridgeService?.start() ?? Promise.resolve(),
      mobileRemoteService?.start() ?? Promise.resolve(),
    ])
    workspaceOperationActive = false
    emitWorkspaceState(undefined)
    throw error
  }
}

async function handleUpdateCheck(interactive: boolean): Promise<void> {
  if (updateManager === undefined || updateDialogOpen) return
  updateDialogOpen = true
  try {
    const copy = getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)
    const state = await updateManager.check(interactive ? 'manual' : 'startup')
    if (state.phase === 'available') {
      const downloaded = await updateManager.download()
      if (downloaded.phase !== 'downloaded') {
        if (downloaded.phase === 'failed' && interactive) {
          await showAppMessageBox({
            type: 'error',
            title: APP_NAME,
            message: copy.updateDownloadFailed,
            detail: downloaded.message
          })
        }
        return
      }

      const install = await showAppMessageBox({
        type: 'info',
        title: APP_NAME,
        message: copy.updateDownloaded,
        detail: copy.updateDownloadedDetail,
        buttons: [copy.restartAndInstall, copy.later],
        defaultId: 0,
        cancelId: 1
      })
      if (install.response === 0) await updateManager.install()
      return
    }

    if (!interactive) return
    await showAppMessageBox({
      type: state.phase === 'failed' ? 'error' : 'info',
      title: APP_NAME,
      message: state.phase === 'failed'
        ? copy.updateCheckFailed
        : copy.latestVersionDetail(state.currentVersion),
      detail: state.phase === 'failed'
        ? state.message
        : state.message === '开发模式不检查更新'
          ? copy.updateDisabledInDevelopment
          : undefined
    })
  } finally {
    updateDialogOpen = false
  }
}

function navigateToTab(tab: NavigationTarget): void {
  if (isDeveloperOnlyTab(tab) && !developerMode) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('ui:navigate', tab)
  }
}

function focusMainWindow(): BrowserWindow {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    return createWindow()
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

function emitDeepLinkInstall(kind: StoreKind, id: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send('ui:navigate', 'store')
    window.webContents.send('store:deep-link-install', { kind, id })
  }
}

function emitDeepLinkSession(sessionId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send('ui:navigate', 'harness')
    window.webContents.send('session:deep-link', { sessionId })
  }
}

async function openDeepLinkSession(sessionId: string): Promise<void> {
  await openDeepLinkedSession({
    sessionId,
    unarchiveSession: async (targetSessionId) => {
      if (runtimeManager === undefined) throw new Error('Runtime manager is not ready')
      if (channelBridgeService !== undefined) {
        const snapshot = runtimeManager.snapshot()
        if (snapshot.url === undefined) await runtimeManager.start()
        await channelBridgeService.unarchiveSession(targetSessionId)
        return
      }
      const snapshot = runtimeManager.snapshot()
      const runtime = snapshot.url === undefined ? await runtimeManager.start() : snapshot
      if (runtime.url === undefined) throw new Error('DSH Runtime URL is not available')
      const client = new DshSessionClient({ baseUrl: runtime.url, timeoutMs: 10_000 })
      await client.unarchiveSession(targetSessionId)
    },
    emitSession: emitDeepLinkSession,
    onUnarchiveError: (error) => {
      console.error(`[deep-link] failed to unarchive session "${sessionId}":`, error.message)
    },
  })
}

async function handleDeepLinkInstall(link: DeepLinkInstall): Promise<void> {
  let kind = link.kind
  const id = link.id
  if (kind === undefined) {
    if (storeService === undefined) {
      console.error('[deep-link] store service is not ready')
      return
    }
    try {
      const resolved = await storeService.resolveEntryById(id)
      if (resolved === undefined) {
        console.error(`[deep-link] no plugin found for id "${id}"`)
        return
      }
      kind = resolved.kind
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[deep-link] failed to resolve plugin "${id}":`, message)
      return
    }
  }
  const resolved: ResolvedDeepLinkInstall = { action: 'install', kind, id }
  pendingDeepLinkInstall = resolved
  focusMainWindow()
  emitDeepLinkInstall(kind, id)
}

function consumePendingDeepLinkInstall(): DeepLinkInstall | undefined {
  const link = pendingDeepLinkInstall
  pendingDeepLinkInstall = undefined
  return link
}

function consumePendingDeepLinkSession(): DeepLinkSession | undefined {
  const link = pendingDeepLinkSession
  pendingDeepLinkSession = undefined
  return link
}

function handleDeepLinkSession(link: DeepLinkSession): void {
  pendingDeepLinkSession = link
  const window = focusMainWindow()
  if (window.webContents.isLoading()) return
  const pending = consumePendingDeepLinkSession()
  if (pending !== undefined) void openDeepLinkSession(pending.sessionId)
}

function setApplicationMenu(locale: AppLocale = localeService?.snapshot() ?? DEFAULT_APP_LOCALE): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(getApplicationMenuTemplate({
    locale,
    navConfig: navigationService?.getConfig(),
    developerMode,
    onCheckForUpdates: () => void handleUpdateCheck(true),
    onNavigate: navigateToTab,
    onOpenRuntimeLog: () => {
      if (runtimeManager === undefined) return
      void shell.openPath(runtimeManager.snapshot().logPath)
    },
    onOpenHarnessDir: () => {
      if (userDataLayout === undefined) return
      void shell.openPath(userDataLayout.harness)
    }
  })))
}

function getAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets', 'logo.png')
    : join(app.getAppPath(), 'assets', 'logo.png')
}

function setDockIcon(): void {
  if (process.platform === 'darwin' && app.dock !== undefined) {
    app.dock.setIcon(getAppIconPath())
  }
}

function success<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function failure<T>(error: unknown): IpcResult<T> {
  return { ok: false, error: toEzDSHError(error, randomUUID()) }
}

async function stopApplicationComponents(): Promise<void> {
  notificationRuntimeUrl = undefined
  runtimeNotificationService?.stop()
  await notificationSettingsWriteChain.catch(() => undefined)
  await workflowRunService?.stop()
  await shutdownExternalServicesFirst(
    () => externalServiceManager?.stopAll() ?? Promise.resolve(),
    [
      () => runtimeProcessManager?.stopAll() ?? Promise.resolve(),
      () => channelBridgeService?.stop() ?? Promise.resolve(),
      () => externalApiService?.stop() ?? Promise.resolve(),
      () => mobileRemoteService?.stop() ?? Promise.resolve(),
    ],
  )
}

function emitExternalServiceState(snapshots: Awaited<ReturnType<ExternalServiceManager['list']>>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !externalServiceWatchers.has(window.webContents.id)) continue
    window.webContents.send('external-services:state-change', snapshots)
  }
}

function emitEmployeeState(employees: Awaited<ReturnType<EmployeeService['list']>>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('employees:state-change', employees)
  }
}

function emitEmployeeLockState(locks: EmployeeSessionLock[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('employees:lock-change', locks)
  }
}

function emitWorkflowState(record: Awaited<ReturnType<WorkflowRunService['get']>>): void {
  if (record === undefined) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('workflow-runs:state-change', record)
  }
}

function emitWorkflowGenerationState(record: Awaited<ReturnType<WorkflowGenerationService['get']>>): void {
  if (record === undefined) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('workflow-generation:state-change', record)
  }
}

function emitWorkflowModificationState(record: Awaited<ReturnType<WorkflowModificationService['get']>>): void {
  if (record === undefined) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('workflow-modification:state-change', record)
  }
}

async function readWorkflowAiDocumentation(): Promise<string | undefined> {
  const files = [
    join(app.getAppPath(), 'docs', 'ai-workflow-generation.md'),
    join(app.getAppPath(), 'docs', 'workflow-schema.md'),
  ]
  const documents: string[] = []
  for (const file of files) {
    try {
      documents.push(`# ${basename(file)}\n\n${await readFile(file, 'utf8')}`)
    } catch {
      // Development builds may be started from a checkout without packaged docs.
    }
  }
  return documents.length === 0 ? undefined : documents.join('\n\n')
}

function requireDeveloperModeFeature(): void {
  if (!developerMode) throw new Error('Employee features are available only in developer mode')
}

function registerIpcHandlers(): void {
  ipcMain.handle('runtime:get-status', (): IpcResult<RuntimeSnapshot> => {
    if (runtimeManager === undefined) return failure(new Error('Runtime manager is not ready'))
    return success(runtimeManager.snapshot())
  })
  ipcMain.handle('runtime:start', async (): Promise<IpcResult<RuntimeSnapshot>> => {
    try {
      if (runtimeManager === undefined) throw new Error('Runtime manager is not ready')
      return success(await runtimeManager.start())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('runtime:restart', async (): Promise<IpcResult<RuntimeSnapshot>> => {
    try {
      if (runtimeManager === undefined) throw new Error('Runtime manager is not ready')
      return success(await runtimeManager.restart())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('runtime:list-processes', async (): Promise<IpcResult<Awaited<ReturnType<DshRuntimeProcessManager['list']>>>> => {
    try {
      if (runtimeProcessManager === undefined) throw new Error('Runtime process manager is not ready')
      return success(await runtimeProcessManager.list())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('runtime:stop-process', async (_event, pid: number): Promise<IpcResult<void>> => {
    try {
      if (runtimeProcessManager === undefined) throw new Error('Runtime process manager is not ready')
      await runtimeProcessManager.stop(pid)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('runtime:open-log', async (): Promise<IpcResult<void>> => {
    try {
      if (runtimeManager === undefined) throw new Error('Runtime manager is not ready')
      const errorMessage = await shell.openPath(runtimeManager.snapshot().logPath)
      if (errorMessage !== '') throw new Error(errorMessage)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:list-definitions', async (): Promise<IpcResult<Awaited<ReturnType<ProviderService['listDefinitions']>>>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.listDefinitions())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:get-status', async (): Promise<IpcResult<Awaited<ReturnType<ProviderService['getStatuses']>>>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.getStatuses())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:list-workflow-models', async (_event, refresh = false): Promise<IpcResult<Awaited<ReturnType<ProviderService['listWorkflowModels']>>>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      if (typeof refresh !== 'boolean') throw new Error('刷新参数无效')
      return success(await providerService.listWorkflowModels(refresh))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:test-connection', async (_event, input: TestProviderInput): Promise<IpcResult<Awaited<ReturnType<ProviderService['testConnection']>>>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.testConnection(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:save', async (_event, input: SaveProviderInput): Promise<IpcResult<Awaited<ReturnType<ProviderService['save']>>>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.save(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:list-models', async (_event, input: ListModelsInput): Promise<IpcResult<ProviderModel[]>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.listModels(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:get-profile', async (_event, providerId: string): Promise<IpcResult<ProviderProfile | undefined>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.getProfile(providerId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('providers:delete', async (_event, providerId: string): Promise<IpcResult<DeleteProviderResult>> => {
    try {
      if (providerService === undefined) throw new Error('Provider service is not ready')
      return success(await providerService.delete(providerId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('locale:get', (): IpcResult<AppLocale> => {
    if (localeService === undefined) return failure(new Error('Locale service is not ready'))
    return success(localeService.snapshot())
  })
  ipcMain.handle('notifications:get-settings', (): IpcResult<NotificationSettings> => success(notificationSettings))
  ipcMain.handle('notifications:set-settings', async (_event, value: unknown): Promise<IpcResult<NotificationSettings>> => {
    try {
      const settingsPath = notificationSettingsPath
      if (settingsPath === undefined) throw new Error('Notification settings are not ready')
      const next = normalizeNotificationSettings(value)
      const write = notificationSettingsWriteChain
        .catch(() => undefined)
        .then(() => writeNotificationSettings(settingsPath, next))
      notificationSettingsWriteChain = write.catch(() => undefined)
      await write
      notificationSettings = next
      emitNotificationSettings()
      return success(notificationSettings)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:list', async (_event, kind: StoreKind, query: { category?: string; search?: string; page?: number }): Promise<IpcResult<Awaited<ReturnType<StoreService['list']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.list(kind, query ?? {}))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:entry', async (_event, kind: StoreKind, id: string): Promise<IpcResult<Awaited<ReturnType<StoreService['entry']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.entry(kind, id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:categories', async (_event, kind: StoreKind): Promise<IpcResult<Awaited<ReturnType<StoreService['categories']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.categories(kind))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:install', async (_event, kind: StoreKind, id: string): Promise<IpcResult<Awaited<ReturnType<StoreService['install']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.install(kind, id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:install-anyway', async (_event, kind: StoreKind, id: string): Promise<IpcResult<Awaited<ReturnType<StoreService['installAnyway']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.installAnyway(kind, id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:confirm-install', async (_event, kind: StoreKind, id: string, accepted: boolean): Promise<IpcResult<Awaited<ReturnType<StoreService['confirmInstall']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.confirmInstall(kind, id, accepted))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:update', async (_event, kind: StoreKind, id: string): Promise<IpcResult<Awaited<ReturnType<StoreService['update']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.update(kind, id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:uninstall', async (_event, kind: StoreKind, id: string): Promise<IpcResult<Awaited<ReturnType<StoreService['uninstall']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.uninstall(kind, id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:list-installed', async (): Promise<IpcResult<Awaited<ReturnType<StoreService['listInstalled']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.listInstalled())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('store:refresh', async (_event, kind: StoreKind): Promise<IpcResult<Awaited<ReturnType<StoreService['refresh']>>>> => {
    try {
      if (storeService === undefined) throw new Error('Store service is not ready')
      return success(await storeService.refresh(kind))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:set-locale', async (_event, locale: 'zh' | 'en'): Promise<IpcResult<void>> => {
    try {
      if (locale !== 'zh' && locale !== 'en') throw new Error(`Unsupported locale: ${String(locale)}`)
      if (localeService === undefined || userDataLayout === undefined) throw new Error('Locale service is not ready')
      await writeDshLocale(join(userDataLayout.harness, 'settings.yaml'), locale)
      await localeService.reload()
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:get-language-tag-visible', (): IpcResult<boolean> => success(languageTagVisible))
  ipcMain.handle('settings:set-language-tag-visible', async (_event, visible: boolean): Promise<IpcResult<boolean>> => {
    try {
      if (typeof visible !== 'boolean') throw new Error('Language tag visibility must be a boolean')
      if (languageTagPath === undefined) throw new Error('Language tag setting is not ready')

      await writeLanguageTagVisible(languageTagPath, visible)
      languageTagVisible = visible
      emitLanguageTagVisibility()
      return success(languageTagVisible)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:open-harness-dir', async (): Promise<IpcResult<void>> => {
    try {
      if (userDataLayout === undefined) throw new Error('User data layout is not ready')
      const errorMessage = await shell.openPath(userDataLayout.harness)
      if (errorMessage !== '') throw new Error(errorMessage)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:get-developer-mode', (): IpcResult<boolean> => success(developerMode))
  ipcMain.handle('settings:set-developer-mode', async (_event, enabled: boolean): Promise<IpcResult<boolean>> => {
    try {
      if (typeof enabled !== 'boolean') throw new Error('Developer mode must be a boolean')
      if (developerModePath === undefined) throw new Error('Developer mode is not ready')

      await writeDeveloperMode(developerModePath, enabled)
      developerMode = enabled
      updateManager?.setFeedURL(resolveUpdateFeedUrl() ?? STABLE_UPDATE_FEED_URL, allowPrereleaseUpdates())
      emitDeveloperMode()
      setApplicationMenu()
      return success(developerMode)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:get-workspace', (): IpcResult<WorkspaceSnapshot> => {
    if (userDataLayout === undefined) return failure(new Error('Workspace service is not ready'))
    return success({ root: userDataLayout.root })
  })
  ipcMain.handle('settings:select-workspace', async (): Promise<IpcResult<string | undefined>> => {
    try {
      const options: Electron.OpenDialogOptions = {
        title: (getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)).settingsWorkspace,
        properties: ['openDirectory', 'createDirectory']
      }
      const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined
      const result = window === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options)
      return success(result.canceled ? undefined : result.filePaths[0])
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:migrate-workspace', async (_event, root: string): Promise<IpcResult<void>> => {
    try {
      await changeWorkspace('migrate', root)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:switch-workspace', async (_event, root: string): Promise<IpcResult<void>> => {
    try {
      await changeWorkspace('switch', root)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:get-proxy-config', (): IpcResult<ProxySettingsSnapshot> => {
    try {
      if (proxyService === undefined) throw new Error('Proxy service is not ready')
      return success(proxyService.snapshot())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:save-proxy', async (_event, input: ProxyProfileInput): Promise<IpcResult<ProxySettingsSnapshot>> => {
    try {
      if (proxyService === undefined) throw new Error('Proxy service is not ready')
      return success(await proxyService.save(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:activate-proxy', async (_event, id?: string): Promise<IpcResult<ProxySettingsSnapshot>> => {
    try {
      if (proxyService === undefined) throw new Error('Proxy service is not ready')
      if (id !== undefined && typeof id !== 'string') throw new Error('Invalid proxy ID')
      return success(await proxyService.activate(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:delete-proxy', async (_event, id: string): Promise<IpcResult<ProxySettingsSnapshot>> => {
    try {
      if (proxyService === undefined) throw new Error('Proxy service is not ready')
      if (typeof id !== 'string') throw new Error('Invalid proxy ID')
      return success(await proxyService.remove(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('settings:test-proxy', async (_event, id: string): Promise<IpcResult<ProxyTestResult>> => {
    try {
      if (proxyService === undefined) throw new Error('Proxy service is not ready')
      if (typeof id !== 'string') throw new Error('Invalid proxy ID')
      return success(await proxyService.test(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:list', async (): Promise<IpcResult<Awaited<ReturnType<ExternalServiceManager['list']>>>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      await externalServiceManager.initialize()
      return success(externalServiceManager.list())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:create', async (_event, input: ExternalServiceCreateInput): Promise<IpcResult<Awaited<ReturnType<ExternalServiceManager['create']>>>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      return success(await externalServiceManager.create(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:update', async (_event, id: string, input: ExternalServiceUpdateInput): Promise<IpcResult<Awaited<ReturnType<ExternalServiceManager['update']>>>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      return success(await externalServiceManager.update(id, input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:remove', async (_event, id: string): Promise<IpcResult<void>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      await externalServiceManager.remove(id)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:start', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<ExternalServiceManager['start']>>>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      return success(await externalServiceManager.start(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:stop', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<ExternalServiceManager['stop']>>>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      return success(await externalServiceManager.stop(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:restart', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<ExternalServiceManager['restart']>>>> => {
    try {
      if (externalServiceManager === undefined) throw new Error('External service manager is not ready')
      return success(await externalServiceManager.restart(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('external-services:watch', (event): IpcResult<void> => {
    externalServiceWatchers.add(event.sender.id)
    return success(undefined)
  })
  ipcMain.handle('external-services:unwatch', (event): IpcResult<void> => {
    externalServiceWatchers.delete(event.sender.id)
    return success(undefined)
  })
  ipcMain.handle('employees:list', async (): Promise<IpcResult<Awaited<ReturnType<EmployeeService['list']>>>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      await employeeService.initialize()
      return success(employeeService.list())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:list-projects', async (): Promise<IpcResult<EmployeeProjectSummary[]>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.listProjects())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:list-sessions', async (_event, projectId?: string): Promise<IpcResult<EmployeeSessionSummary[]>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.listSessions(projectId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:create-session', async (_event, projectId: string, title?: string): Promise<IpcResult<EmployeeSessionSummary>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.createSession(projectId, title))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:list-session-locks', async (): Promise<IpcResult<EmployeeSessionLock[]>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      await employeeService.initialize()
      return success(employeeService.listSessionLocks())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:force-unlock-session', async (_event, sessionId: string): Promise<IpcResult<void>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      await employeeService.forceUnlockSession(sessionId)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:generate', async (_event, request: EmployeeGenerateRequest): Promise<IpcResult<Awaited<ReturnType<EmployeeService['generate']>>>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.generate(request))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:create', async (_event, input: EmployeeCreateInput): Promise<IpcResult<Awaited<ReturnType<EmployeeService['create']>>>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.create(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:update', async (_event, id: string, input: EmployeeUpdateInput): Promise<IpcResult<Awaited<ReturnType<EmployeeService['update']>>>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.update(id, input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:remove', async (_event, id: string): Promise<IpcResult<void>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      await employeeService.remove(id)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:set-enabled', async (_event, id: string, enabled: boolean): Promise<IpcResult<Awaited<ReturnType<EmployeeService['setEnabled']>>>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.setEnabled(id, enabled))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('employees:run', async (_event, id: string, request: EmployeeRunRequest): Promise<IpcResult<Awaited<ReturnType<EmployeeService['run']>>>> => {
    try {
      requireDeveloperModeFeature()
      if (employeeService === undefined) throw new Error('Employee service is not ready')
      return success(await employeeService.run(id, request))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:list', async (): Promise<IpcResult<Awaited<ReturnType<WorkflowStore['list']>>>> => {
    try {
      if (workflowStore === undefined) throw new Error('Workflow service is not ready')
      await workflowStore.initialize()
      return success(workflowStore.list())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:get', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<WorkflowStore['get']>>>> => {
    try {
      if (typeof id !== 'string' || id.trim() === '') throw new Error('Invalid workflow ID')
      if (workflowStore === undefined) throw new Error('Workflow service is not ready')
      await workflowStore.initialize()
      return success(workflowStore.get(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:create', async (_event, input: WorkflowCreateInput): Promise<IpcResult<Awaited<ReturnType<WorkflowStore['create']>>>> => {
    try {
      if (workflowStore === undefined) throw new Error('Workflow service is not ready')
      return success(await workflowStore.create(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:update', async (_event, id: string, input: WorkflowUpdateInput): Promise<IpcResult<Awaited<ReturnType<WorkflowStore['update']>>>> => {
    try {
      if (workflowStore === undefined) throw new Error('Workflow service is not ready')
      return success(await workflowStore.update(id, input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:remove', async (_event, id: string): Promise<IpcResult<void>> => {
    try {
      if (workflowStore === undefined || workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (typeof id !== 'string' || id.trim() === '') throw new Error('Invalid workflow ID')
      await workflowRunService.initialize()
      if (workflowStore.get(id) === undefined) throw new Error(`Workflow not found: ${id}`)
      await workflowRunService.removeForWorkflow(id)
      await workflowStore.remove(id)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:duplicate', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<WorkflowStore['duplicate']>>>> => {
    try {
      if (workflowStore === undefined) throw new Error('Workflow service is not ready')
      return success(await workflowStore.duplicate(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:generate', async (_event, request: WorkflowGenerateRequest): Promise<IpcResult<Awaited<ReturnType<WorkflowGenerationService['generate']>>>> => {
    try {
      if (workflowGenerationService === undefined) throw new Error('Workflow generation service is not ready')
      return success(await workflowGenerationService.generate(request))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-generations:cancel', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<WorkflowGenerationService['cancel']>>>> => {
    try {
      if (workflowGenerationService === undefined) throw new Error('Workflow generation service is not ready')
      return success(await workflowGenerationService.cancel(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-generations:resume', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<WorkflowGenerationService['resume']>>>> => {
    try {
      if (workflowGenerationService === undefined) throw new Error('Workflow generation service is not ready')
      return success(await workflowGenerationService.resume(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:modify', async (_event, request: WorkflowModifyRequest): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['modify']>>>> => {
    try {
      if (workflowModificationService === undefined) throw new Error('Workflow modification service is not ready')
      return success(await workflowModificationService.modify(request))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-modifications:cancel', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<WorkflowModificationService['cancel']>>>> => {
    try {
      if (workflowModificationService === undefined) throw new Error('Workflow modification service is not ready')
      return success(await workflowModificationService.cancel(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-modifications:list', async (_event, workflowId?: string): Promise<IpcResult<Awaited<ReturnType<WorkflowModificationService['list']>>>> => {
    try {
      if (workflowModificationService === undefined) throw new Error('Workflow modification service is not ready')
      return success(await workflowModificationService.list(workflowId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-generations:list', async (): Promise<IpcResult<Awaited<ReturnType<WorkflowGenerationService['list']>>>> => {
    try {
      if (workflowGenerationService === undefined) throw new Error('Workflow generation service is not ready')
      return success(await workflowGenerationService.list())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflows:import-employee', async (_event, employeeId: string): Promise<IpcResult<Awaited<ReturnType<WorkflowStore['create']>>>> => {
    try {
      if (employeeService === undefined || workflowStore === undefined) throw new Error('Workflow service is not ready')
      await employeeService.initialize()
      const employee = employeeService.get(employeeId)
      if (employee === undefined) throw new Error(`Employee "${employeeId}" was not found`)
      return success(await workflowStore.create(workflowFromEmployee(employee)))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-credentials:list', async (): Promise<IpcResult<Awaited<ReturnType<WorkflowCredentialStore['listMetadata']>>>> => {
    try {
      if (workflowCredentialStore === undefined) throw new Error('Workflow credential store is not ready')
      await workflowCredentialStore.initialize()
      return success(workflowCredentialStore.listMetadata())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-credentials:upsert', async (_event, input: WorkflowCredentialUpsertInput): Promise<IpcResult<Awaited<ReturnType<WorkflowCredentialStore['upsert']>>>> => {
    try {
      if (workflowCredentialStore === undefined) throw new Error('Workflow credential store is not ready')
      return success(await workflowCredentialStore.upsert(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-credentials:remove', async (_event, id: string): Promise<IpcResult<void>> => {
    try {
      if (workflowCredentialStore === undefined) throw new Error('Workflow credential store is not ready')
      if (typeof id !== 'string' || id.trim() === '') throw new Error('Invalid workflow credential ID')
      await workflowCredentialStore.remove(id)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-connectors:list', async (): Promise<IpcResult<Awaited<ReturnType<WorkflowConnectorStore['list']>>>> => {
    try {
      if (workflowConnectorStore === undefined) throw new Error('Workflow connector store is not ready')
      await workflowConnectorStore.initialize()
      return success(workflowConnectorStore.list())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-connectors:get', async (_event, id: string): Promise<IpcResult<Awaited<ReturnType<WorkflowConnectorStore['get']>>>> => {
    try {
      if (workflowConnectorStore === undefined) throw new Error('Workflow connector store is not ready')
      if (typeof id !== 'string' || id.trim() === '') throw new Error('Invalid workflow connector ID')
      await workflowConnectorStore.initialize()
      return success(workflowConnectorStore.get(id))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-connectors:upsert', async (_event, input: WorkflowHttpConnector): Promise<IpcResult<Awaited<ReturnType<WorkflowConnectorStore['upsert']>>>> => {
    try {
      if (workflowConnectorStore === undefined) throw new Error('Workflow connector store is not ready')
      return success(await workflowConnectorStore.upsert(input))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-connectors:remove', async (_event, id: string): Promise<IpcResult<void>> => {
    try {
      if (workflowConnectorStore === undefined) throw new Error('Workflow connector store is not ready')
      if (typeof id !== 'string' || id.trim() === '') throw new Error('Invalid workflow connector ID')
      await workflowConnectorStore.remove(id)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:list', async (_event, workflowId?: string): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['list']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      await workflowRunService.initialize()
      return success(workflowRunService.list(workflowId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:get', async (_event, runId: string): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['get']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (typeof runId !== 'string' || runId.trim() === '') throw new Error('Invalid workflow run ID')
      return success(workflowRunService.get(runId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:remove', async (_event, runId: string): Promise<IpcResult<void>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (typeof runId !== 'string' || runId.trim() === '') throw new Error('Invalid workflow run ID')
      await workflowRunService.remove(runId)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:start', async (_event, workflowId: string, input: WorkflowValue, options: WorkflowRunOptions): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['start']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (typeof workflowId !== 'string' || workflowId.trim() === '') throw new Error('Invalid workflow ID')
      return success(await workflowRunService.start(workflowId, input, options))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:resume', async (_event, runId: string): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['resume']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      return success(await workflowRunService.resume(runId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:cancel', async (_event, runId: string): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['cancel']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      return success(await workflowRunService.cancel(runId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:approve', async (_event, runId: string, approved: boolean): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['approve']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (typeof runId !== 'string' || typeof approved !== 'boolean') throw new Error('Invalid workflow approval input')
      return success(await workflowRunService.approve(runId, approved))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('workflow-runs:compensate', async (_event, runId: string): Promise<IpcResult<Awaited<ReturnType<WorkflowRunService['compensate']>>>> => {
    try {
      if (workflowRunService === undefined) throw new Error('Workflow service is not ready')
      if (typeof runId !== 'string' || runId.trim() === '') throw new Error('Invalid workflow run ID')
      return success(await workflowRunService.compensate(runId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('updates:get-status', (): IpcResult<UpdateState> => {
    if (updateManager === undefined) return failure(new Error('Update manager is not ready'))
    return success(updateManager.snapshot())
  })
  ipcMain.handle('updates:check', async (): Promise<IpcResult<UpdateState>> => {
    try {
      if (updateManager === undefined) throw new Error('Update manager is not ready')
      return success(await updateManager.check('manual'))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('updates:download', async (): Promise<IpcResult<UpdateState>> => {
    try {
      if (updateManager === undefined) throw new Error('Update manager is not ready')
      return success(await updateManager.download())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('updates:install', async (): Promise<IpcResult<UpdateState>> => {
    try {
      if (updateManager === undefined) throw new Error('Update manager is not ready')
      return success(await updateManager.install())
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('recovery:get-status', (): IpcResult<RecoveryState> => {
    if (recoveryManager === undefined) return failure(new Error('Recovery manager is not ready'))
    return success(recoveryManager.snapshot())
  })
  ipcMain.handle('recovery:list', async (): Promise<IpcResult<Awaited<ReturnType<RecoveryManager['listSnapshots']>>>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      return success(await recoveryManager.listSnapshots())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:create-snapshot', async (): Promise<IpcResult<Awaited<ReturnType<RecoveryManager['createSnapshot']>>>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      return success(await recoveryManager.createSnapshot({
        kind: 'manual',
        reason: 'Manual backup requested from EzDSH settings',
      }))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:delete', async (_event, selector: string): Promise<IpcResult<void>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      if (typeof selector !== 'string') throw new Error('Invalid recovery delete input')
      await recoveryManager.deleteSnapshot(selector)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:verify', async (_event, selector: string): Promise<IpcResult<Awaited<ReturnType<RecoveryManager['verify']>>>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      return success(await recoveryManager.verify(selector))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:doctor', async (_event, repair: boolean = false): Promise<IpcResult<RecoveryDoctorResult>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      if (typeof repair !== 'boolean') throw new Error('Invalid recovery doctor input')
      return success(await recoveryManager.doctor(repair))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:restore', async (_event, selector: string, dryRun: boolean): Promise<IpcResult<RecoveryDryRun | RecoveryRestoreResult>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      if (typeof selector !== 'string' || typeof dryRun !== 'boolean') throw new Error('Invalid recovery restore input')
      if (dryRun) return success(await recoveryManager.restore(selector, true))
      await stopApplicationComponents()
      return success(await recoveryManager.restore(selector, false))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:enter-safe-mode', async (): Promise<IpcResult<RuntimeSnapshot>> => {
    try {
      if (pluginRecoveryCoordinator === undefined || runtimeManager === undefined) throw new Error('Safe Mode is not ready')
      await pluginRecoveryCoordinator.startSafeMode('manual')
      return success(runtimeManager.snapshot())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:exit-safe-mode', async (): Promise<IpcResult<RuntimeSnapshot>> => {
    try {
      if (safeModeController === undefined || runtimeManager === undefined) throw new Error('Safe Mode is not ready')
      await runtimeManager.stop()
      await safeModeController.disable()
      return success(await runtimeManager.start({ mode: 'normal' }))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:rollback-pending-plugin', async (): Promise<IpcResult<RecoveryRestoreResult>> => {
    try {
      if (recoveryManager === undefined || safeModeController === undefined || runtimeManager === undefined) throw new Error('Recovery manager is not ready')
      const pending = recoveryManager.snapshot().pendingTransaction
      if (pending?.kind !== 'plugin-change') throw new Error('No pending plugin change can be rolled back')
      await runtimeManager.stop()
      const result = await recoveryManager.restore(pending.snapshotName, false)
      await safeModeController.disable()
      await runtimeManager.start({ mode: 'normal' })
      await recoveryManager.resolveRecovery()
      return success(result)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:resolve', async (): Promise<IpcResult<void>> => {
    try {
      if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
      await recoveryManager.resolveRecovery()
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('recovery:open-directory', async (): Promise<IpcResult<void>> => {
    try {
      if (userDataLayout === undefined) throw new Error('User data layout is not ready')
      const error = await shell.openPath(userDataLayout.backups)
      if (error !== '') throw new Error(error)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:get-config', async (): Promise<IpcResult<Awaited<ReturnType<ChannelBridgeService['getConfig']>>>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      return success(await channelBridgeService.getConfig())
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:set-config', async (_event, config: Awaited<ReturnType<ChannelBridgeService['getConfig']>>): Promise<IpcResult<void>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      await channelBridgeService.setConfig(config)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:list-sessions', async (): Promise<IpcResult<Awaited<ReturnType<ChannelBridgeService['listSessions']>>>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      return success(await channelBridgeService.listSessions())
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:list-archived-sessions', async (): Promise<IpcResult<Awaited<ReturnType<ChannelBridgeService['listArchivedSessions']>>>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      return success(await channelBridgeService.listArchivedSessions())
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:unarchive-session', async (_event, sessionId: string): Promise<IpcResult<void>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      await channelBridgeService.unarchiveSession(sessionId)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:delete-archived-session', async (_event, sessionId: string): Promise<IpcResult<void>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      await channelBridgeService.deleteArchivedSession(sessionId)
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:start-pairing', async (): Promise<IpcResult<Awaited<ReturnType<ChannelBridgeService['startPairing']>>>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      return success(await channelBridgeService.startPairing())
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:cancel-pairing', async (): Promise<IpcResult<void>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      await channelBridgeService.cancelPairing()
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('channel-bridge:get-pairing-state', async (): Promise<IpcResult<Awaited<ReturnType<ChannelBridgeService['getPairingState']>>>> => {
    try {
      if (channelBridgeService === undefined) throw new Error('Channel bridge service is not ready')
      return success(channelBridgeService.getPairingState())
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('mobile-remote:get-status', (): IpcResult<MobileRemoteSnapshot> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      return success(mobileRemoteService.snapshot())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:start-pairing', async (): Promise<IpcResult<MobileRemoteSnapshot>> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      return success(await mobileRemoteService.startPairing())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:cancel-pairing', (): IpcResult<MobileRemoteSnapshot> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      return success(mobileRemoteService.cancelPairing())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:approve-pairing', (_event, requestId: string): IpcResult<MobileRemoteSnapshot> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      if (typeof requestId !== 'string' || requestId.trim() === '') throw new Error('Invalid pairing request ID')
      return success(mobileRemoteService.approvePairing(requestId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:reject-pairing', (_event, requestId: string): IpcResult<MobileRemoteSnapshot> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      if (typeof requestId !== 'string' || requestId.trim() === '') throw new Error('Invalid pairing request ID')
      return success(mobileRemoteService.rejectPairing(requestId))
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:start-public-access', async (): Promise<IpcResult<MobileRemoteSnapshot>> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      return success(await mobileRemoteService.startPublicAccess())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:stop-public-access', async (): Promise<IpcResult<MobileRemoteSnapshot>> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      return success(await mobileRemoteService.stopPublicAccess())
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle('mobile-remote:disconnect-device', (_event, deviceId: string): IpcResult<MobileRemoteSnapshot> => {
    try {
      if (mobileRemoteService === undefined) throw new Error('Mobile remote service is not ready')
      if (typeof deviceId !== 'string' || deviceId.trim() === '') throw new Error('Invalid device ID')
      return success(mobileRemoteService.disconnectDevice(deviceId))
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('navigation:get-config', (): IpcResult<NavConfig> => {
    if (navigationService === undefined) return failure(new Error('Navigation service is not ready'))
    return success(navigationService.getConfig())
  })
  ipcMain.handle('navigation:set-config', async (_event, config: NavConfig): Promise<IpcResult<void>> => {
    try {
      if (navigationService === undefined) throw new Error('Navigation service is not ready')
      await navigationService.setConfig(config)
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('navigation:state-change', navigationService.getConfig())
      }
      setApplicationMenu()
      return success(undefined)
    } catch (error) {
      return failure(error)
    }
  })
}

registerIpcHandlers()

function loadRenderer(window: BrowserWindow): Promise<void> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  return rendererUrl !== undefined && rendererUrl !== ''
    ? window.loadURL(rendererUrl)
    : window.loadFile(join(__dirname, '../renderer/index.html'))
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: getWindowBackgroundColor(),
    icon: getAppIconPath(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('close', (event) => {
    if (workspaceOperationActive && !isQuitting) event.preventDefault()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      protocol = ''
    }
    if (protocol === 'http:' || protocol === 'https:') {
      void shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })

  window.webContents.on('before-input-event', (event, input) => {
    const config = navigationService?.getConfig()
    if (config === undefined) return
    const target = getNavigationTargetForInput(input, config, process.platform, developerMode)
    if (target === undefined) return
    // Keep navigation reliable when an embedded page would otherwise consume the key.
    event.preventDefault()
    navigateToTab(target)
  })

  window.webContents.on('did-finish-load', () => {
    const link = consumePendingDeepLinkInstall()
    if (link !== undefined) {
      void handleDeepLinkInstall(link)
    }
    const sessionLink = consumePendingDeepLinkSession()
    if (sessionLink !== undefined) void openDeepLinkSession(sessionLink.sessionId)
  })

  bindWindowClosedCleanup(window, externalServiceWatchers, () => {
    if (mainWindow === window) {
      mainWindow = undefined
    }
  })

  void loadRenderer(window).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[renderer] failed to load:', message)
  })

  mainWindow = window
  return window
}

app.setName(APP_NAME)

const cliInvocation = parseDshCliInvocation(process.argv)

if (cliInvocation !== undefined) {
  void runDshCliMode(cliInvocation.args)
} else {
  const singleInstance = app.requestSingleInstanceLock()

  if (!singleInstance) {
    app.quit()
  } else {
    app.setAsDefaultProtocolClient('ezdsh')

    const startupLink = parseDeepLink(findDeepLinkInArgs(process.argv) ?? '')
    if (startupLink?.action === 'install') {
      pendingDeepLinkInstall = startupLink
    } else if (startupLink?.action === 'session') {
      pendingDeepLinkSession = startupLink
    }

    app.whenReady().then(async () => {
      app.setName(APP_NAME)
      nativeTheme.on('updated', syncWindowBackgroundColor)
      workspaceConfigPath = getWorkspaceConfigPath(app.getPath('appData'))
      const workspaceRoot = await readWorkspaceRoot(workspaceConfigPath, app.getPath('userData'))
      const layout = getUserDataLayout(workspaceRoot)
      await ensureUserDataLayout(layout)
      await initializeWorkspaceServices(layout)
    const configuredUpdateFeedUrl = process.env.EZDSH_UPDATE_FEED_URL?.trim() || undefined
    const updateFeedUrl = resolveUpdateFeedUrl()
    const configuredUpdateResolveUrl = process.env.EZDSH_UPDATE_RESOLVE_URL?.trim() || undefined
    const updateResolveUrl = resolveUpdateResolverUrl()
    const updateChecksEnabled = app.isPackaged || configuredUpdateFeedUrl !== undefined || configuredUpdateResolveUrl !== undefined
    updateManager = new UpdateManager({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      allowDevUpdates: !app.isPackaged && (configuredUpdateFeedUrl !== undefined || configuredUpdateResolveUrl !== undefined),
      allowPrerelease: allowPrereleaseUpdates(),
      updateFeedUrl,
      updateResolveUrl,
      updatePlatform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : undefined,
      updateArch: process.arch,
      getUpdateChannel: () => developerMode ? 'preview' : 'stable',
      getUpdateLanguage: () => localeService?.snapshot() ?? DEFAULT_APP_LOCALE,
      updater: updateChecksEnabled ? getAutoUpdater() : undefined,
      prepareInstall: async ({ targetVersion, targetDshRuntimeVersion }) => {
        if (recoveryManager === undefined) throw new Error('Recovery manager is not ready')
        await recoveryManager.prepareUpdate({ targetAppVersion: targetVersion, targetDshRuntimeVersion })
        isQuitting = true
        await stopApplicationComponents()
      }
    })
    updateManager.onChange((snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('updates:state-change', snapshot)
      }
    })
    setDockIcon()
    createWindow()
    setApplicationMenu()
    const startupInstall = consumePendingDeepLinkInstall()
    if (startupInstall !== undefined) {
      void handleDeepLinkInstall(startupInstall)
    }
    if (updateChecksEnabled) void handleUpdateCheck(false)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })

    app.on('open-url', (_event, url) => {
      const link = parseDeepLink(url)
      if (link?.action === 'install') {
        void handleDeepLinkInstall(link)
      } else if (link?.action === 'session') {
        handleDeepLinkSession(link)
      }
    })
  }).catch((error: unknown) => {
    // A silent rejection here previously left the app running without any window.
    console.error('EzDSH failed to start:', error)
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    dialog.showErrorBox(APP_NAME, `EzDSH 启动失败，应用将退出。\nEzDSH failed to start and will now quit.\n\n${message}`)
    app.exit(1)
  })

  app.on('second-instance', (_event, argv) => {
    const url = findDeepLinkInArgs(argv)
    const link = url === undefined ? undefined : parseDeepLink(url)
    if (link?.action === 'install') {
      void handleDeepLinkInstall(link)
      return
    }
    if (link?.action === 'session') {
      handleDeepLinkSession(link)
      return
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('before-quit', (event) => {
    if (workspaceOperationActive && !isQuitting) {
      event.preventDefault()
      return
    }
    if (isQuitting) return
    event.preventDefault()
    isQuitting = true
    void stopApplicationComponents().finally(() => {
      localeService?.stop()
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
}
