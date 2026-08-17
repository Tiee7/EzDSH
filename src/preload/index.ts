import { contextBridge, ipcRenderer } from 'electron'
import type { EzDSHBridge } from '../shared/contracts.js'
import type { IpcResult } from '../shared/errors.js'
import { APP_NAME, APP_VERSION } from '../shared/app-identity.js'
import type { AppTab } from '../shared/navigation.js'
import type { AppPlatform } from '../shared/platform.js'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IpcResult<T>
  if (!result.ok) {
    const error = new Error(result.error.message)
    Object.assign(error, result.error)
    throw error
  }
  return result.data
}

const bridge: EzDSHBridge = {
  app: {
    name: APP_NAME,
    version: APP_VERSION,
    platform: (process.platform as unknown) as AppPlatform
  },
  runtime: {
    getStatus: () => invoke('runtime:get-status'),
    start: () => invoke('runtime:start'),
    restart: () => invoke('runtime:restart'),
    openLog: () => invoke('runtime:open-log'),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot)
      ipcRenderer.on('runtime:state-change', handler)
      return () => ipcRenderer.removeListener('runtime:state-change', handler)
    }
  },
  ui: {
    onNavigate: (listener: (tab: AppTab) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, tab: AppTab) => listener(tab)
      ipcRenderer.on('ui:navigate', handler)
      return () => ipcRenderer.removeListener('ui:navigate', handler)
    }
  },
  store: {
    list: (kind, query) => invoke('store:list', kind, query ?? {}),
    entry: (kind, id) => invoke('store:entry', kind, id),
    categories: () => invoke('store:categories'),
    install: (kind, id) => invoke('store:install', kind, id),
    confirmInstall: (kind, id, accepted) => invoke('store:confirm-install', kind, id, accepted),
    uninstall: (kind, id) => invoke('store:uninstall', kind, id),
    listInstalled: () => invoke('store:list-installed'),
    refresh: () => invoke('store:refresh'),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on('store:state-change', handler)
      return () => ipcRenderer.removeListener('store:state-change', handler)
    }
  },
  settings: {
    setLocale: (locale) => invoke('settings:set-locale', locale),
    openHarnessDir: () => invoke('settings:open-harness-dir')
  },
  providers: {
    listDefinitions: () => invoke('providers:list-definitions'),
    getStatus: () => invoke('providers:get-status'),
    testConnection: (input) => invoke('providers:test-connection', input),
    save: (input) => invoke('providers:save', input)
  },
  locale: {
    get: () => invoke('locale:get'),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, locale: Parameters<typeof listener>[0]) => listener(locale)
      ipcRenderer.on('locale:state-change', handler)
      return () => ipcRenderer.removeListener('locale:state-change', handler)
    }
  },
  updates: {
    getStatus: () => invoke('updates:get-status'),
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    install: () => invoke('updates:install'),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on('updates:state-change', handler)
      return () => ipcRenderer.removeListener('updates:state-change', handler)
    }
  }
}

contextBridge.exposeInMainWorld('EzDSH', bridge)
