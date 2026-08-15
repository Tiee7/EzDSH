import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { AppUpdater } from 'electron-updater'
import type { IpcResult } from '../shared/errors.js'
import { toEzDSHError } from '../shared/errors.js'
import type { RuntimeSnapshot } from './runtime/runtime-types.js'
import type { SaveProviderInput, TestProviderInput } from '../shared/providers.js'
import type { UpdateState } from '../shared/update.js'
import { APP_NAME } from '../shared/app-identity.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../shared/locale.js'
import { ensureUserDataLayout, getUserDataLayout } from './state/user-data.js'
import { RuntimeManager, resolveRuntimeEntryPath } from './runtime/runtime-manager.js'
import { ProviderService } from './providers/provider-service.js'
import { UpdateManager } from './update/update-manager.js'
import { getApplicationMenuTemplate } from './application-menu.js'
import { LocaleService } from './locale/locale-service.js'

let mainWindow: BrowserWindow | undefined
let runtimeManager: RuntimeManager | undefined
let providerService: ProviderService | undefined
let localeService: LocaleService | undefined
let updateManager: UpdateManager | undefined
let isQuitting = false
let updateDialogOpen = false
const require = createRequire(import.meta.url)

function getAutoUpdater(): AppUpdater {
  return (require('electron-updater') as typeof import('electron-updater')).autoUpdater
}

function showAppMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const window = mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined
  return window === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options)
}

async function handleUpdateCheck(interactive: boolean): Promise<void> {
  if (updateManager === undefined || updateDialogOpen) return
  updateDialogOpen = true
  try {
    const copy = getAppCopy(localeService?.snapshot() ?? DEFAULT_APP_LOCALE)
    const state = await updateManager.check()
    if (state.phase === 'available') {
      const result = await showAppMessageBox({
        type: 'info',
        title: APP_NAME,
        message: copy.updateAvailable(state.availableVersion ?? ''),
        detail: copy.updateAvailableDetail,
        buttons: [copy.downloadUpdate, copy.later],
        defaultId: 0,
        cancelId: 1
      })
      if (result.response !== 0) return

      const downloaded = await updateManager.download()
      if (downloaded.phase !== 'downloaded') {
        if (downloaded.phase === 'failed') {
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
      message: state.phase === 'failed' ? copy.updateCheckFailed : copy.latestVersion,
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

function setApplicationMenu(locale: AppLocale = localeService?.snapshot() ?? DEFAULT_APP_LOCALE): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(getApplicationMenuTemplate({
    locale,
    onCheckForUpdates: () => void handleUpdateCheck(true)
  })))
}

function success<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function failure<T>(error: unknown): IpcResult<T> {
  return { ok: false, error: toEzDSHError(error, randomUUID()) }
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
  ipcMain.handle('providers:list-definitions', (): IpcResult<ReturnType<ProviderService['listDefinitions']>> => {
    if (providerService === undefined) return failure(new Error('Provider service is not ready'))
    return success(providerService.listDefinitions())
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
  ipcMain.handle('locale:get', (): IpcResult<AppLocale> => {
    if (localeService === undefined) return failure(new Error('Locale service is not ready'))
    return success(localeService.snapshot())
  })
  ipcMain.handle('updates:get-status', (): IpcResult<UpdateState> => {
    if (updateManager === undefined) return failure(new Error('Update manager is not ready'))
    return success(updateManager.snapshot())
  })
  ipcMain.handle('updates:check', async (): Promise<IpcResult<UpdateState>> => {
    try {
      if (updateManager === undefined) throw new Error('Update manager is not ready')
      return success(await updateManager.check())
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
}

registerIpcHandlers()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: '#101114',
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

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = window
  return window
}

app.setName(APP_NAME)

const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    app.setName(APP_NAME)
    const updateFeedUrl = process.env.EZDSH_UPDATE_FEED_URL?.trim() || undefined
    const layout = getUserDataLayout(app.getPath('userData'))
    await ensureUserDataLayout(layout)
    localeService = new LocaleService(join(layout.harness, 'settings.yaml'))
    await localeService.start()
    runtimeManager = new RuntimeManager({
      layout,
      runtimeEntryPath: resolveRuntimeEntryPath({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged
      })
    })
    providerService = new ProviderService(layout)
    const updateChecksEnabled = app.isPackaged || updateFeedUrl !== undefined
    updateManager = new UpdateManager({
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      allowDevUpdates: !app.isPackaged && updateFeedUrl !== undefined,
      updateFeedUrl,
      updater: updateChecksEnabled ? getAutoUpdater() : undefined,
      prepareInstall: async () => {
        isQuitting = true
        await runtimeManager?.stop()
      }
    })
    runtimeManager.onChange((snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('runtime:state-change', snapshot)
      }
    })
    updateManager.onChange((snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('updates:state-change', snapshot)
      }
    })
    localeService.onChange((locale) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('locale:state-change', locale)
      }
      setApplicationMenu(locale)
    })
    createWindow()
    setApplicationMenu()
    if (updateChecksEnabled) void handleUpdateCheck(false)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('second-instance', () => {
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
    if (isQuitting || runtimeManager === undefined) return
    event.preventDefault()
    isQuitting = true
    void runtimeManager.stop().finally(() => {
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
