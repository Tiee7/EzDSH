import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'
import type { RecoveryDryRun, RecoveryRestoreResult, RecoverySnapshot, RecoveryState } from '../../src/main/recovery/recovery-manager'
import type { WorkspaceOperationState } from '../../src/shared/state'
import { getAppCopy } from '../../src/shared/locale'
import { getDefaultNavConfig } from '../../src/shared/navigation'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/shared/notifications'

vi.mock('../../src/renderer/app/RuntimePane', () => ({ RuntimePane: ({ url }: { url: string }) => <div data-runtime-url={url}>Runtime workspace</div> }))
vi.mock('../../src/renderer/app/WebPane', () => ({ WebPane: () => null }))
vi.mock('../../src/renderer/store/StorePage', () => ({ StorePage: () => null }))
vi.mock('../../src/renderer/store/PresetPage', () => ({ PresetPage: () => null }))
vi.mock('../../src/renderer/employees/EmployeesPage', () => ({ EMPLOYEES_REFRESH_EVENT: 'employees-refresh', EmployeesPage: () => null }))
vi.mock('../../src/renderer/workflow/WorkflowPage', () => ({ WorkflowPage: () => null }))
vi.mock('../../src/renderer/docs/DocsPage', () => ({ DocsPage: () => null }))
// Keep App's mounting boundary, SettingsPage's actual tab state, and the real
// restore component. Unrelated settings sections need no native services.
vi.mock('../../src/renderer/settings/SettingsPage', async () => {
  const { SettingsPage } = await vi.importActual<typeof import('../../src/renderer/settings/SettingsPage')>('../../src/renderer/settings/SettingsPage')
  return { SettingsPage: (props: Parameters<typeof SettingsPage>[0]) => <div data-recovery-settings><SettingsPage {...props} /></div> }
})
vi.mock('../../src/renderer/settings/ProviderSection', () => ({ ProviderSection: () => null }))
vi.mock('../../src/renderer/settings/UpdateSection', () => ({ UpdateSection: () => null }))
vi.mock('../../src/renderer/settings/RuntimeSection', () => ({ RuntimeSection: () => null }))
vi.mock('../../src/renderer/settings/RuntimeInstancesSection', () => ({ RuntimeInstancesSection: () => null }))
vi.mock('../../src/renderer/settings/ChannelBridgePage', () => ({ ChannelBridgePage: () => null }))
vi.mock('../../src/renderer/settings/NavigationSection', () => ({ NavigationSection: () => null }))
vi.mock('../../src/renderer/settings/ExternalServicesSection', () => ({ ExternalServicesSection: () => null }))
vi.mock('../../src/renderer/settings/NotificationsSection', () => ({ NotificationsSection: () => null }))
vi.mock('../../src/renderer/settings/ArchivedSessionsSection', () => ({ ArchivedSessionsSection: () => null }))
vi.mock('../../src/renderer/settings/ProxySection', () => ({ ProxySection: () => null }))
vi.mock('../../src/renderer/settings/MobileRemoteSection', () => ({ MobileRemoteSection: () => null }))
vi.mock('../../src/renderer/update-center/UpdateCenter', () => ({ UpdateCenter: () => null }))
vi.mock('../../src/renderer/notifications/audio', () => ({ ensureAudio: () => undefined, playNotificationSound: () => undefined }))

import { App } from '../../src/renderer/app/App'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

const copy = getAppCopy('zh')
const ready: RuntimeSnapshot = { phase: 'ready', mode: 'normal', url: 'http://127.0.0.1:4567', launchDirectory: '/fixture', logPath: '/fixture/runtime.log' }
const stopped: RuntimeSnapshot = { ...ready, phase: 'stopped', url: undefined }
const failed: RuntimeSnapshot = { ...ready, phase: 'failed', url: undefined, message: 'Fixture Runtime startup failure' }
const snapshot: RecoverySnapshot = {
  archiveName: 'ezdsh-manual-20260913080100000.tar.gz',
  archivePath: '/fixture/backups/selected.tar.gz', checksumPath: '/fixture/backups/selected.sha256', manifestPath: '/fixture/backups/selected.json',
  manifest: {
    formatVersion: 1, kind: 'manual', reason: 'manual', createdAt: '2026-09-13T08:01:00.000Z',
    appVersion: '1.8.1550', dshRuntimeVersion: '0.1.5-rc.1', dataSchemaVersion: 1,
    archiveName: 'ezdsh-manual-20260913080100000.tar.gz', sha256: 'fixture',
    components: ['harness', 'state', 'workflow'], redactedFiles: [], pluginInventory: [],
  },
}
const preview: RecoveryDryRun = { dryRun: true, snapshotName: snapshot.archiveName, entries: ['harness/', 'state/', 'workflow/'], redactedFiles: [], missingCredentials: [], preflight: [] }
const restored: RecoveryRestoreResult = { dryRun: false, snapshotName: snapshot.archiveName, restoredAt: '2026-09-13T09:00:00.000Z', preRestoreSnapshotName: 'current-before-restore.tar.gz', missingCredentials: [], entries: preview.entries }

async function mountApp() {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const subscribe = () => () => undefined
  let runtimeListener: ((state: RuntimeSnapshot) => void) | undefined
  let recoveryListener: ((state: RecoveryState) => void) | undefined
  let workspaceListener: ((state: WorkspaceOperationState | undefined) => void) | undefined
  let currentRuntime = ready
  const emitRuntime = (state: RuntimeSnapshot) => { currentRuntime = state; runtimeListener?.(state) }
  const restoreResult = deferred<RecoveryRestoreResult>()
  const startupResult = deferred<RuntimeSnapshot>()
  const start = vi.fn(async () => currentRuntime)
  const restart = vi.fn(async () => {
    emitRuntime({ ...stopped, phase: 'starting' })
    await Promise.resolve()
    emitRuntime(ready)
    return ready
  }).mockImplementationOnce(async () => {
    emitRuntime({ ...stopped, phase: 'starting' })
    const result = await startupResult.promise
    emitRuntime(result)
    return result
  })
  const restore = vi.fn(async (_selector: string, dryRun: boolean): Promise<RecoveryDryRun | RecoveryRestoreResult> => {
    if (dryRun) return preview
    recoveryListener?.({ phase: 'restoring' })
    emitRuntime(stopped)
    const result = await restoreResult.promise
    recoveryListener?.({ phase: 'idle' })
    return result
  })
  const enterSafeMode = vi.fn(async (): Promise<RuntimeSnapshot> => {
    const state = { ...ready, mode: 'safe' as const }
    emitRuntime(state)
    return state
  })
  const enterIsolationMode = vi.fn(async (): Promise<RuntimeSnapshot> => {
    const state = { ...ready, mode: 'isolation' as const }
    emitRuntime(state)
    return state
  })
  const confirm = vi.fn(() => true)
  Object.assign(dom, { confirm, EzDSH: {
    app: { platform: 'darwin' },
    runtime: {
      getStatus: async () => ({ ...ready, phase: 'idle', url: undefined }), start, restart,
      onStateChange: (listener: typeof runtimeListener) => { runtimeListener = listener; return () => { runtimeListener = undefined } },
    },
    ui: { onNavigate: subscribe, onDeepLinkInstall: subscribe, onDeepLinkSession: subscribe },
    locale: { get: async () => 'zh', onChange: subscribe },
    settings: {
      getWorkspace: async () => ({ root: '/fixture' }),
      getLanguageTagVisible: async () => false, getDeveloperMode: async () => false,
      onLanguageTagVisibilityChange: subscribe, onDeveloperModeChange: subscribe,
      onWorkspaceChange: (listener: typeof workspaceListener) => { workspaceListener = listener; return () => { workspaceListener = undefined } },
    },
    updates: { getStatus: async () => ({ phase: 'idle' }), onStateChange: subscribe },
    recovery: {
      getStatus: async () => ({ phase: 'idle' }), listSnapshots: async () => [snapshot], restore, enterSafeMode, enterIsolationMode,
      onStateChange: (listener: typeof recoveryListener) => { recoveryListener = listener; return () => { recoveryListener = undefined } },
    },
    navigation: { getConfig: async () => getDefaultNavConfig(), onStateChange: subscribe },
    notifications: { getSettings: async () => DEFAULT_NOTIFICATION_SETTINGS, onSettingsChange: subscribe, onEvent: subscribe },
  } })
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(dom.document.getElementById('root')!)
  await act(async () => { root.render(<App />) })
  const click = async (label: string) => {
    const button = (Array.from(dom.document.querySelectorAll('button')) as HTMLButtonElement[]).find((element) => element.textContent?.trim() === label)
    if (button === undefined) throw new Error(`Missing button: ${label}`)
    await act(async () => { button.click() })
  }
  return {
    dom, start, restart, restore, confirm, click, enterSafeMode, enterIsolationMode,
    finishRestore: async () => { await act(async () => { restoreResult.resolve(restored) }) },
    finishStartup: async (state = failed) => { await act(async () => { startupResult.resolve(state) }) },
    publishWorkspace: async (state: WorkspaceOperationState | undefined) => { await act(async () => { workspaceListener?.(state) }) },
    publishRuntime: async (state: RuntimeSnapshot) => { await act(async () => { emitRuntime(state) }) },
    publishRecovery: async (state: RecoveryState) => { await act(async () => { recoveryListener?.(state) }) },
    cleanup: async () => {
      await act(async () => { root.unmount() })
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, descriptor)
      }
    },
  }
}

async function withApp(check: (fixture: Awaited<ReturnType<typeof mountApp>>) => Promise<void>) {
  const fixture = await mountApp()
  try { await check(fixture) } finally { await fixture.cleanup() }
}

describe('App backup restore across Runtime and workspace changes', () => {
  it('retains the completed restore after Settings unmounts and retries only startup without an automatic competing start', async () => {
    await withApp(async (h) => {
      expect(h.start).toHaveBeenCalledExactlyOnceWith({ automatic: true })
      await h.click(copy.tabSettings)
      await h.click(copy.settingsRecovery)
      expect(h.dom.document.querySelectorAll('[data-recovery-settings]')).toHaveLength(1)
      await h.click(copy.settingsRecoveryRestore)
      expect(h.dom.document.querySelectorAll('[data-recovery-settings]')).toHaveLength(0)
      expect(h.restart).not.toHaveBeenCalled()

      await h.finishRestore()
      expect(h.restart).toHaveBeenCalledOnce()
      expect(h.start).toHaveBeenCalledOnce()
      await h.finishStartup()
      expect(h.dom.document.body.textContent).toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      expect(h.start).toHaveBeenCalledOnce()

      await h.click(copy.settingsRecoveryRetryRuntime)
      expect(h.restore.mock.calls).toEqual([[snapshot.archiveName, true], [snapshot.archiveName, false]])
      expect(h.confirm).toHaveBeenCalledOnce()
      expect(h.restart).toHaveBeenCalledTimes(2)
      expect(h.start).toHaveBeenCalledOnce()
      expect(h.dom.document.querySelectorAll('[data-recovery-settings]')).toHaveLength(1)
      expect(h.dom.document.body.textContent).toContain(copy.settingsRecoveryRestored)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestoredRuntimeFailed)
    })
  })

  it('clears the old workspace restore feedback when switching workspaces', async () => {
    await withApp(async (h) => {
      await h.click(copy.tabSettings)
      await h.click(copy.settingsRecovery)
      await h.click(copy.settingsRecoveryRestore)
      await h.finishRestore()
      await h.finishStartup()
      expect(h.dom.document.body.textContent).toContain(copy.settingsRecoveryRestoredRuntimeFailed)

      await h.publishWorkspace({ phase: 'switching', message: 'Switching to another workspace' })
      await h.publishRuntime({ ...ready, launchDirectory: '/another-workspace', url: 'http://127.0.0.1:9876' })
      await h.publishWorkspace(undefined)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRetryRuntime)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestored)
      expect(h.restart).toHaveBeenCalledOnce()
    })
  })

  it('keeps restore feedback and its startup retry inside the visible recovery card when recovery becomes required', async () => {
    await withApp(async (h) => {
      await h.click(copy.tabSettings)
      await h.click(copy.settingsRecovery)
      await h.click(copy.settingsRecoveryRestore)
      await h.finishRestore()
      await h.publishRecovery({ phase: 'recovery-required' })
      const competingActions = Array.from(h.dom.document.querySelectorAll('.recovery-actions button')) as HTMLButtonElement[]
      expect(competingActions.length).toBeGreaterThan(3)
      expect(competingActions.every((button) => button.disabled)).toBe(true)
      await h.finishStartup()

      const card = h.dom.document.querySelector('.recovery-card')
      expect(card?.textContent).toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      const buttons = Array.from(card?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
      expect(buttons.some((button) => button.textContent?.trim() === copy.settingsRecoveryRetryRuntime)).toBe(true)
      await h.click(copy.settingsRecoveryRetryRuntime)
      expect(h.restore.mock.calls).toEqual([[snapshot.archiveName, true], [snapshot.archiveName, false]])
      expect(h.restart).toHaveBeenCalledTimes(2)
      expect(h.start).toHaveBeenCalledOnce()
    })
  })

  it.each(['safe', 'isolation'] as const)('clears the stale restore startup failure after a separate %s-mode action starts Runtime successfully', async (mode) => {
    await withApp(async (h) => {
      await h.click(copy.tabSettings)
      await h.click(copy.settingsRecovery)
      await h.click(copy.settingsRecoveryRestore)
      await h.finishRestore()
      await h.finishStartup()
      expect(h.dom.document.body.textContent).toContain(copy.settingsRecoveryRestoredRuntimeFailed)

      await h.click(mode === 'safe' ? copy.runtimeEnterSafeMode : copy.runtimeEnterIsolationMode)
      expect(mode === 'safe' ? h.enterSafeMode : h.enterIsolationMode).toHaveBeenCalledOnce()
      expect(h.dom.document.querySelectorAll('.workspace')).toHaveLength(1)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRetryRuntime)
      expect(h.restore.mock.calls).toEqual([[snapshot.archiveName, true], [snapshot.archiveName, false]])
      expect(h.restart).toHaveBeenCalledOnce()
      expect(h.start).toHaveBeenCalledOnce()
    })
  })

  it('ignores a late restore result from the old workspace instead of restarting the new workspace Runtime', async () => {
    await withApp(async (h) => {
      await h.click(copy.tabSettings)
      await h.click(copy.settingsRecovery)
      await h.click(copy.settingsRecoveryRestore)
      expect(h.restart).not.toHaveBeenCalled()
      await h.publishWorkspace({ phase: 'switching', message: 'Switching to another workspace' })
      await h.publishRuntime({ ...ready, launchDirectory: '/another-workspace', url: 'http://127.0.0.1:9876' })
      await h.publishRecovery({ phase: 'idle' })
      await h.publishWorkspace(undefined)

      await h.finishRestore()
      expect(h.restart).not.toHaveBeenCalled()
      expect(h.dom.document.querySelector('[data-runtime-url]')?.getAttribute('data-runtime-url')).toBe('http://127.0.0.1:9876')
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestored)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRetryRuntime)
      expect(h.restore.mock.calls).toEqual([[snapshot.archiveName, true], [snapshot.archiveName, false]])
    })
  })

  it('does not confirm or apply an old workspace preview that arrives after switching workspaces', async () => {
    await withApp(async (h) => {
      const delayedPreview = deferred<RecoveryDryRun>()
      h.restore.mockImplementationOnce(async () => delayedPreview.promise)
      await h.click(copy.tabSettings)
      await h.click(copy.settingsRecovery)
      await h.click(copy.settingsRecoveryRestore)
      expect(h.confirm).not.toHaveBeenCalled()

      await h.publishWorkspace({ phase: 'switching', message: 'Switching to another workspace' })
      await h.publishRuntime({ ...ready, launchDirectory: '/another-workspace', url: 'http://127.0.0.1:9876' })
      await h.publishWorkspace(undefined)
      await act(async () => { delayedPreview.resolve(preview) })

      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.restore.mock.calls).toEqual([[snapshot.archiveName, true]])
      expect(h.restart).not.toHaveBeenCalled()
      expect(h.dom.document.querySelector('[data-runtime-url]')?.getAttribute('data-runtime-url')).toBe('http://127.0.0.1:9876')
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestored)
    })
  })

  it('does not automatically retry a failed Runtime again when recovery status changes after initial startup', async () => {
    await withApp(async (h) => {
      expect(h.start).toHaveBeenCalledExactlyOnceWith({ automatic: true })
      await h.publishRuntime(failed)
      await h.publishRecovery({ phase: 'restoring' })
      await h.publishRecovery({ phase: 'idle' })

      expect(h.start).toHaveBeenCalledOnce()
      expect(h.restart).not.toHaveBeenCalled()
      expect(h.dom.document.querySelectorAll('.workspace')).toHaveLength(0)
    })
  })
})
