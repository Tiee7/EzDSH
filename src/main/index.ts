import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
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
import type { NavigationTarget } from '../shared/navigation.js'
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
import {
  RuntimeManager,
  resolveRuntimeCommandPath,
  resolveRuntimeEntryPath
} from './runtime/runtime-manager.js'
import { ProviderService } from './providers/provider-service.js'
import { UpdateManager } from './update/update-manager.js'
import { getApplicationMenuTemplate } from './application-menu.js'
import { LocaleService, writeDshLocale } from './locale/locale-service.js'
import { ChannelBridgeService } from './channel-bridge/index.js'
import { DshSessionClient } from './channel-bridge/dsh-session.js'
import { openDeepLinkedSession } from './session-deep-link.js'
import { NavigationService } from './navigation/navigation-service.js'
import { getNavigationTargetForInput } from './navigation/navigation-shortcuts.js'
import { ExternalApiService } from './external-api/external-api-service.js'
import { EXTERNAL_API_DEFAULT_PORT } from '../shared/external-api.js'
import type { NavConfig } from '../shared/navigation.js'
import { AdapterRegistry } from './channel-bridge/adapter-registry.js'
import { ChannelAdapterLoader } from './channel-bridge/adapter-loader.js'
import { ExternalServiceManager } from './external-services/external-service-manager.js'
import type { ExternalServiceCreateInput, ExternalServiceUpdateInput } from '../shared/external-services.js'
import { bindWindowClosedCleanup } from './window-lifecycle.js'
import { shutdownExternalServicesFirst } from './shutdown.js'
import { restartApplication, shouldRelaunchWorkspace } from './restart.js'

let mainWindow: BrowserWindow | undefined
let runtimeManager: RuntimeManager | undefined
let providerService: ProviderService | undefined
let localeService: LocaleService | undefined
let updateManager: UpdateManager | undefined
let userDataLayout: UserDataLayout | undefined
let workspaceConfigPath: string | undefined
let developerModePath: string | undefined
let developerMode = false
let languageTagPath: string | undefined
let languageTagVisible = true
let storeService: StoreService | undefined
let channelBridgeService: ChannelBridgeService | undefined
let navigationService: NavigationService | undefined
let externalApiService: ExternalApiService | undefined
let externalServiceManager: ExternalServiceManager | undefined
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

function showAppMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined
  return window === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options)
}

function emitWorkspaceState(state: WorkspaceOperationState | undefined): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('workspace:state-change', state)
  }
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
      void externalServiceManager?.startAutoServices().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[external-services] failed to start auto services:', message)
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
  developerModePath = join(layout.state, 'developer-mode.json')
  developerMode = await readDeveloperMode(developerModePath)
  languageTagPath = join(layout.state, 'language-tag.json')
  languageTagVisible = await readLanguageTagVisible(languageTagPath)

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
  runtimeManager = new RuntimeManager({
    layout,
    runtimeEntryPath,
    command: runtimeCommandPath
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
    registry: channelBridgeRegistry,
  })
  await channelBridgeService.initialize().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[channel-bridge] failed to initialize:', message)
  })

  providerService = new ProviderService(layout)
  await providerService.initialize()
  navigationService = new NavigationService(layout.state)
  await navigationService.initialize()
  storeService = new StoreService({
    client: new StoreClient(),
    fetchImpl: createDemoFetch(),
    dshHome: layout.harness,
    registryPath: join(layout.state, 'installed.json'),
    catalogCachePath: join(layout.state, 'store-catalog.json'),
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
  await shutdownExternalServicesFirst(
    () => externalServiceManager?.stopAll() ?? Promise.resolve(),
    [
      () => runtimeManager?.stop() ?? Promise.resolve(),
      () => channelBridgeService?.stop() ?? Promise.resolve(),
      () => externalApiService?.stop() ?? Promise.resolve(),
    ],
  )
}

function emitExternalServiceState(snapshots: Awaited<ReturnType<ExternalServiceManager['list']>>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !externalServiceWatchers.has(window.webContents.id)) continue
    window.webContents.send('external-services:state-change', snapshots)
  }
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
    const target = getNavigationTargetForInput(input, config, process.platform)
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
      prepareInstall: async () => {
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
