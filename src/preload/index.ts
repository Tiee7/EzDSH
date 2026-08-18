import { contextBridge, ipcRenderer } from 'electron'
import type { DeepLinkInstallTarget, EzDSHBridge } from '../shared/contracts.js'
import type { IpcResult } from '../shared/errors.js'
import { APP_NAME, APP_VERSION } from '../shared/app-identity.js'
import type { AppTab } from '../shared/navigation.js'
import type { AppPlatform } from '../shared/platform.js'
import type { NavConfig } from '../shared/navigation.js'

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
    },
    onDeepLinkInstall: (listener: (target: DeepLinkInstallTarget) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, target: DeepLinkInstallTarget) => listener(target)
      ipcRenderer.on('store:deep-link-install', handler)
      return () => ipcRenderer.removeListener('store:deep-link-install', handler)
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
    listModels: (input) => invoke('providers:list-models', input),
    getProfile: (providerId) => invoke('providers:get-profile', providerId),
    save: (input) => invoke('providers:save', input),
    delete: (providerId) => invoke('providers:delete', providerId)
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
  },
  channelBridge: {
    getConfig: () => invoke('channel-bridge:get-config'),
    setConfig: (config) => invoke('channel-bridge:set-config', config),
    getConfigPath: () => invoke('channel-bridge:get-config-path'),
    listSessions: () => invoke('channel-bridge:list-sessions'),
    startPairing: () => invoke('channel-bridge:start-pairing'),
    cancelPairing: () => invoke('channel-bridge:cancel-pairing'),
    getPairingState: () => invoke('channel-bridge:get-pairing-state')
  },
  navigation: {
    getConfig: () => invoke<NavConfig>('navigation:get-config'),
    setConfig: (config) => invoke('navigation:set-config', config),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, config: Parameters<typeof listener>[0]) => listener(config)
      ipcRenderer.on('navigation:state-change', handler)
      return () => ipcRenderer.removeListener('navigation:state-change', handler)
    }
  }
}

contextBridge.exposeInMainWorld('EzDSH', bridge)
