import { contextBridge, ipcRenderer } from 'electron'
import type { DeepLinkInstallTarget, DeepLinkSessionTarget, EzDSHBridge } from '../shared/contracts.js'
import type { IpcResult } from '../shared/errors.js'
import { APP_NAME, APP_VERSION } from '../shared/app-identity.js'
import type { NavigationTarget } from '../shared/navigation.js'
import type { AppPlatform } from '../shared/platform.js'
import type { NavConfig } from '../shared/navigation.js'
import type { MobileRemoteSnapshot } from '../shared/mobile-remote.js'
import type { NotificationSettings } from '../shared/notifications.js'
import type { ProxyProfileInput, ProxySettingsSnapshot, ProxyTestResult } from '../shared/proxy.js'
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
} from '../shared/external-services.js'
import type {
  EmployeeCreateInput,
  EmployeeGenerateRequest,
  EmployeeGeneratedProfile,
  EmployeeProjectSummary,
  EmployeeRunRequest,
  EmployeeRunResult,
  EmployeeSessionLock,
  EmployeeSnapshot,
  EmployeeSessionSummary,
  EmployeeUpdateInput,
} from '../shared/employees.js'
import type {
  WorkflowCreateInput,
  WorkflowDefinition,
  WorkflowGenerateRequest,
  WorkflowGenerateResult,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowUpdateInput,
  WorkflowValue,
  WorkflowModelOption,
} from '../shared/workflow.js'

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
    listProcesses: () => invoke('runtime:list-processes'),
    stopProcess: (pid: number) => invoke('runtime:stop-process', pid),
    openLog: () => invoke('runtime:open-log'),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot)
      ipcRenderer.on('runtime:state-change', handler)
      return () => ipcRenderer.removeListener('runtime:state-change', handler)
    }
  },
  ui: {
    onNavigate: (listener: (tab: NavigationTarget) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, tab: NavigationTarget) => listener(tab)
      ipcRenderer.on('ui:navigate', handler)
      return () => ipcRenderer.removeListener('ui:navigate', handler)
    },
    onDeepLinkInstall: (listener: (target: DeepLinkInstallTarget) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, target: DeepLinkInstallTarget) => listener(target)
      ipcRenderer.on('store:deep-link-install', handler)
      return () => ipcRenderer.removeListener('store:deep-link-install', handler)
    },
    onDeepLinkSession: (listener: (target: DeepLinkSessionTarget) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, target: DeepLinkSessionTarget) => listener(target)
      ipcRenderer.on('session:deep-link', handler)
      return () => ipcRenderer.removeListener('session:deep-link', handler)
    }
  },
  store: {
    list: (kind, query) => invoke('store:list', kind, query ?? {}),
    entry: (kind, id) => invoke('store:entry', kind, id),
    categories: (kind) => invoke('store:categories', kind),
    install: (kind, id) => invoke('store:install', kind, id),
    installAnyway: (kind, id) => invoke('store:install-anyway', kind, id),
    confirmInstall: (kind, id, accepted) => invoke('store:confirm-install', kind, id, accepted),
    update: (kind, id) => invoke('store:update', kind, id),
    uninstall: (kind, id) => invoke('store:uninstall', kind, id),
    listInstalled: () => invoke('store:list-installed'),
    refresh: (kind) => invoke('store:refresh', kind),
    onStateChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on('store:state-change', handler)
      return () => ipcRenderer.removeListener('store:state-change', handler)
    }
  },
  employees: {
    list: () => invoke<EmployeeSnapshot[]>('employees:list'),
    listProjects: () => invoke<EmployeeProjectSummary[]>('employees:list-projects'),
    listSessions: (projectId?: string) => invoke<EmployeeSessionSummary[]>('employees:list-sessions', projectId),
    createSession: (projectId: string, title?: string) => invoke<EmployeeSessionSummary>('employees:create-session', projectId, title),
    listSessionLocks: () => invoke<EmployeeSessionLock[]>('employees:list-session-locks'),
    forceUnlockSession: (sessionId: string) => invoke<void>('employees:force-unlock-session', sessionId),
    generate: (request: EmployeeGenerateRequest) => invoke<EmployeeGeneratedProfile>('employees:generate', request),
    create: (input: EmployeeCreateInput) => invoke<EmployeeSnapshot>('employees:create', input),
    update: (id: string, input: EmployeeUpdateInput) => invoke<EmployeeSnapshot>('employees:update', id, input),
    remove: (id: string) => invoke<void>('employees:remove', id),
    setEnabled: (id: string, enabled: boolean) => invoke<EmployeeSnapshot>('employees:set-enabled', id, enabled),
    run: (id: string, request: EmployeeRunRequest) => invoke<EmployeeRunResult>('employees:run', id, request),
    onStateChange: (listener: (employees: EmployeeSnapshot[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, employees: EmployeeSnapshot[]) => listener(employees)
      ipcRenderer.on('employees:state-change', handler)
      return () => ipcRenderer.removeListener('employees:state-change', handler)
    },
    onLockChange: (listener: (locks: EmployeeSessionLock[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, locks: EmployeeSessionLock[]) => listener(locks)
      ipcRenderer.on('employees:lock-change', handler)
      return () => ipcRenderer.removeListener('employees:lock-change', handler)
    }
  },
  workflows: {
    list: () => invoke<WorkflowDefinition[]>('workflows:list'),
    get: (id: string) => invoke<WorkflowDefinition | undefined>('workflows:get', id),
    create: (input: WorkflowCreateInput) => invoke<WorkflowDefinition>('workflows:create', input),
    update: (id: string, input: WorkflowUpdateInput) => invoke<WorkflowDefinition>('workflows:update', id, input),
    remove: (id: string) => invoke<void>('workflows:remove', id),
    duplicate: (id: string) => invoke<WorkflowDefinition>('workflows:duplicate', id),
    generate: (request: WorkflowGenerateRequest) => invoke<WorkflowGenerateResult>('workflows:generate', request),
    importEmployee: (employeeId: string) => invoke<WorkflowDefinition>('workflows:import-employee', employeeId),
    listRuns: (workflowId?: string) => invoke<WorkflowRunRecord[]>('workflow-runs:list', workflowId),
    getRun: (runId: string) => invoke<WorkflowRunRecord | undefined>('workflow-runs:get', runId),
    start: (workflowId: string, input: WorkflowValue, options?: WorkflowRunOptions) => invoke<WorkflowRunRecord>('workflow-runs:start', workflowId, input, options ?? {}),
    resume: (runId: string) => invoke<WorkflowRunRecord>('workflow-runs:resume', runId),
    cancel: (runId: string) => invoke<WorkflowRunRecord>('workflow-runs:cancel', runId),
    approve: (runId: string, approved: boolean) => invoke<WorkflowRunRecord>('workflow-runs:approve', runId, approved),
    onStateChange: (listener: (record: WorkflowRunRecord) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, record: WorkflowRunRecord) => listener(record)
      ipcRenderer.on('workflow-runs:state-change', handler)
      return () => ipcRenderer.removeListener('workflow-runs:state-change', handler)
    }
  },
  settings: {
    setLocale: (locale) => invoke('settings:set-locale', locale),
    getLanguageTagVisible: () => invoke<boolean>('settings:get-language-tag-visible'),
    setLanguageTagVisible: (visible: boolean) => invoke<boolean>('settings:set-language-tag-visible', visible),
    onLanguageTagVisibilityChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => listener(visible)
      ipcRenderer.on('language-tag:state-change', handler)
      return () => ipcRenderer.removeListener('language-tag:state-change', handler)
    },
    openHarnessDir: () => invoke('settings:open-harness-dir'),
    getDeveloperMode: () => invoke<boolean>('settings:get-developer-mode'),
    setDeveloperMode: (enabled: boolean) => invoke<boolean>('settings:set-developer-mode', enabled),
    onDeveloperModeChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, enabled: boolean) => listener(enabled)
      ipcRenderer.on('developer-mode:state-change', handler)
      return () => ipcRenderer.removeListener('developer-mode:state-change', handler)
    },
    getWorkspace: () => invoke('settings:get-workspace'),
    selectWorkspace: () => invoke<string | undefined>('settings:select-workspace'),
    migrateWorkspace: (root: string) => invoke('settings:migrate-workspace', root),
    switchWorkspace: (root: string) => invoke('settings:switch-workspace', root),
    getProxyConfig: () => invoke<ProxySettingsSnapshot>('settings:get-proxy-config'),
    saveProxy: (input: ProxyProfileInput) => invoke<ProxySettingsSnapshot>('settings:save-proxy', input),
    activateProxy: (id?: string) => invoke<ProxySettingsSnapshot>('settings:activate-proxy', id),
    deleteProxy: (id: string) => invoke<ProxySettingsSnapshot>('settings:delete-proxy', id),
    testProxy: (id: string) => invoke<ProxyTestResult>('settings:test-proxy', id),
    onWorkspaceChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on('workspace:state-change', handler)
      return () => ipcRenderer.removeListener('workspace:state-change', handler)
    }
  },
  externalServices: {
    list: () => invoke<ExternalServiceSnapshot[]>('external-services:list'),
    create: (input: ExternalServiceCreateInput) => invoke<ExternalServiceSnapshot>('external-services:create', input),
    update: (id: string, input: ExternalServiceUpdateInput) => invoke<ExternalServiceSnapshot>('external-services:update', id, input),
    remove: (id: string) => invoke<void>('external-services:remove', id),
    start: (id: string) => invoke<ExternalServiceSnapshot>('external-services:start', id),
    stop: (id: string) => invoke<ExternalServiceSnapshot>('external-services:stop', id),
    restart: (id: string) => invoke<ExternalServiceSnapshot>('external-services:restart', id),
    watch: (listener: (snapshots: ExternalServiceSnapshot[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshots: ExternalServiceSnapshot[]) => listener(snapshots)
      ipcRenderer.on('external-services:state-change', handler)
      void invoke('external-services:watch').catch(() => {
        ipcRenderer.removeListener('external-services:state-change', handler)
      })
      return () => {
        ipcRenderer.removeListener('external-services:state-change', handler)
        void invoke('external-services:unwatch').catch(() => {})
      }
    }
  },
  providers: {
    listDefinitions: () => invoke('providers:list-definitions'),
    getStatus: () => invoke('providers:get-status'),
    listWorkflowModels: (refresh = false) => invoke<WorkflowModelOption[]>('providers:list-workflow-models', refresh),
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
  notifications: {
    getSettings: () => invoke<NotificationSettings>('notifications:get-settings'),
    setSettings: (settings) => invoke<NotificationSettings>('notifications:set-settings', settings),
    onSettingsChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: Parameters<typeof listener>[0]) => listener(settings)
      ipcRenderer.on('notifications:state-change', handler)
      return () => ipcRenderer.removeListener('notifications:state-change', handler)
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, notification: Parameters<typeof listener>[0]) => listener(notification)
      ipcRenderer.on('notifications:event', handler)
      return () => ipcRenderer.removeListener('notifications:event', handler)
    },
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
  recovery: {
    getStatus: () => invoke<RecoveryState>('recovery:get-status'),
    listSnapshots: () => invoke<RecoverySnapshot[]>('recovery:list'),
    createSnapshot: () => invoke<RecoverySnapshot>('recovery:create-snapshot'),
    deleteSnapshot: (selector: string) => invoke<void>('recovery:delete', selector),
    verify: (selector: string) => invoke<RecoveryVerifyResult>('recovery:verify', selector),
    doctor: (repair = false) => invoke<RecoveryDoctorResult>('recovery:doctor', repair),
    restore: (selector: string, dryRun: boolean) => invoke<RecoveryDryRun | RecoveryRestoreResult>('recovery:restore', selector, dryRun),
    enterSafeMode: () => invoke('recovery:enter-safe-mode'),
    exitSafeMode: () => invoke('recovery:exit-safe-mode'),
    rollbackPendingPlugin: () => invoke<RecoveryRestoreResult>('recovery:rollback-pending-plugin'),
    resolve: () => invoke<void>('recovery:resolve'),
    openDirectory: () => invoke<void>('recovery:open-directory'),
    onStateChange: (listener: (state: RecoveryState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RecoveryState) => listener(state)
      ipcRenderer.on('recovery:state-change', handler)
      return () => ipcRenderer.removeListener('recovery:state-change', handler)
    }
  },
  channelBridge: {
    getConfig: () => invoke('channel-bridge:get-config'),
    setConfig: (config) => invoke('channel-bridge:set-config', config),
    getConfigPath: () => invoke('channel-bridge:get-config-path'),
    listSessions: () => invoke('channel-bridge:list-sessions'),
    listArchivedSessions: () => invoke('channel-bridge:list-archived-sessions'),
    unarchiveSession: (sessionId: string) => invoke('channel-bridge:unarchive-session', sessionId),
    deleteArchivedSession: (sessionId: string) => invoke('channel-bridge:delete-archived-session', sessionId),
    startPairing: () => invoke('channel-bridge:start-pairing'),
    cancelPairing: () => invoke('channel-bridge:cancel-pairing'),
    getPairingState: () => invoke('channel-bridge:get-pairing-state')
  },
  mobileRemote: {
    getStatus: () => invoke<MobileRemoteSnapshot>('mobile-remote:get-status'),
    startPairing: () => invoke<MobileRemoteSnapshot>('mobile-remote:start-pairing'),
    cancelPairing: () => invoke<MobileRemoteSnapshot>('mobile-remote:cancel-pairing'),
    approvePairing: (requestId: string) => invoke<MobileRemoteSnapshot>('mobile-remote:approve-pairing', requestId),
    rejectPairing: (requestId: string) => invoke<MobileRemoteSnapshot>('mobile-remote:reject-pairing', requestId),
    startPublicAccess: () => invoke<MobileRemoteSnapshot>('mobile-remote:start-public-access'),
    stopPublicAccess: () => invoke<MobileRemoteSnapshot>('mobile-remote:stop-public-access'),
    disconnectDevice: (deviceId: string) => invoke<MobileRemoteSnapshot>('mobile-remote:disconnect-device', deviceId),
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
