import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
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
vi.mock('../../src/renderer/settings/SettingsPage', () => ({ SettingsPage: () => null }))
vi.mock('../../src/renderer/update-center/UpdateCenter', () => ({ UpdateCenter: () => null }))
vi.mock('../../src/renderer/notifications/audio', () => ({ ensureAudio: () => undefined, playNotificationSound: () => undefined }))

import { App } from '../../src/renderer/app/App'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

const copy = getAppCopy('zh')
const reviewLabel = copy.recoverySelectSnapshotReview
const ready: RuntimeSnapshot = { phase: 'ready', mode: 'normal', url: 'http://127.0.0.1:4567', launchDirectory: '/fixture', logPath: '/fixture/runtime.log' }
const stopped: RuntimeSnapshot = { ...ready, phase: 'stopped', url: undefined }
const failed: RuntimeSnapshot = { ...ready, phase: 'failed', url: undefined, message: 'Fixture Runtime startup failure' }
const selected: RecoverySnapshot = {
  archiveName: 'ezdsh-manual-20260913080100000.tar.gz',
  archivePath: '/fixture/backups/selected.tar.gz', checksumPath: '/fixture/backups/selected.sha256', manifestPath: '/fixture/backups/selected.json',
  manifest: {
    formatVersion: 1, kind: 'manual', reason: 'selected backup', createdAt: '2026-09-13T08:01:00.000Z',
    appVersion: '1.8.1550', dshRuntimeVersion: '0.1.5-rc.1', dataSchemaVersion: 1,
    archiveName: 'ezdsh-manual-20260913080100000.tar.gz', sha256: 'fixture',
    components: ['harness', 'state', 'workflow'], redactedFiles: [], pluginInventory: [],
  },
}
const another: RecoverySnapshot = {
  ...selected,
  archiveName: 'ezdsh-manual-20260913090200000.tar.gz',
  manifest: { ...selected.manifest, archiveName: 'ezdsh-manual-20260913090200000.tar.gz', createdAt: '2026-09-13T09:02:00.000Z', reason: 'new workspace backup' },
}
const preview: RecoveryDryRun = { dryRun: true, snapshotName: selected.archiveName, entries: ['harness/', 'state/', 'workflow/'], redactedFiles: [], missingCredentials: [], preflight: [] }
const restored: RecoveryRestoreResult = { dryRun: false, snapshotName: selected.archiveName, restoredAt: '2026-09-13T09:00:00.000Z', preRestoreSnapshotName: 'current-before-restore.tar.gz', missingCredentials: [], entries: preview.entries }

function requiredRecovery(snapshot: RecoverySnapshot | undefined = selected): RecoveryState {
  return {
    phase: 'recovery-required', lastError: 'Fixture boot failure',
    runtimeFailure: { plugins: [], ...(snapshot === undefined ? {} : { latestSnapshot: { archiveName: snapshot.archiveName, createdAt: snapshot.manifest.createdAt, reason: snapshot.manifest.reason } }) },
  }
}

async function mountApp(initialRecovery = requiredRecovery(), initialRuntime = failed) {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const subscribe = () => () => undefined
  let runtimeListener: ((state: RuntimeSnapshot) => void) | undefined
  let recoveryListener: ((state: RecoveryState) => void) | undefined
  let workspaceListener: ((state: WorkspaceOperationState | undefined) => void) | undefined
  let currentRuntime = initialRuntime
  const emitRuntime = (state: RuntimeSnapshot) => { currentRuntime = state; runtimeListener?.(state) }
  const restoreResult = deferred<RecoveryRestoreResult>()
  const startupResult = deferred<RuntimeSnapshot>()
  const operations: string[] = []
  const start = vi.fn(async () => currentRuntime)
  const exitSafeMode = vi.fn(async () => {
    emitRuntime(ready)
    return ready
  })
  const restart = vi.fn(async () => {
    operations.push('restart')
    emitRuntime(ready)
    return ready
  }).mockImplementationOnce(async () => {
    operations.push('restart')
    emitRuntime({ ...stopped, phase: 'starting' })
    const state = await startupResult.promise
    emitRuntime(state)
    return state
  })
  const listSnapshots = vi.fn(async (): Promise<RecoverySnapshot[]> => [selected])
  const restore = vi.fn(async (_selector: string, dryRun: boolean): Promise<RecoveryDryRun | RecoveryRestoreResult> => {
    operations.push(dryRun ? 'preview' : 'restore')
    if (dryRun) return preview
    recoveryListener?.({ phase: 'restoring' })
    emitRuntime(stopped)
    const result = await restoreResult.promise
    recoveryListener?.({ phase: 'idle' })
    return result
  })
  const confirm = vi.fn((_message: string) => { operations.push('confirm'); return true })
  Object.assign(dom, { confirm, EzDSH: {
    app: { platform: 'darwin' },
    runtime: { getStatus: async () => currentRuntime, start, restart, onStateChange: (listener: typeof runtimeListener) => { runtimeListener = listener; return () => { runtimeListener = undefined } } },
    ui: { onNavigate: subscribe, onDeepLinkInstall: subscribe, onDeepLinkSession: subscribe },
    locale: { get: async () => 'zh', onChange: subscribe },
    settings: {
      getWorkspace: async () => ({ root: '/fixture' }), getLanguageTagVisible: async () => false, getDeveloperMode: async () => false,
      onLanguageTagVisibilityChange: subscribe, onDeveloperModeChange: subscribe,
      onWorkspaceChange: (listener: typeof workspaceListener) => { workspaceListener = listener; return () => { workspaceListener = undefined } },
    },
    updates: { getStatus: async () => ({ phase: 'idle' }), onStateChange: subscribe },
    recovery: { getStatus: async () => initialRecovery, listSnapshots, restore, exitSafeMode, onStateChange: (listener: typeof recoveryListener) => { recoveryListener = listener; return () => { recoveryListener = undefined } } },
    navigation: { getConfig: async () => getDefaultNavConfig(), onStateChange: subscribe },
    notifications: { getSettings: async () => DEFAULT_NOTIFICATION_SETTINGS, onSettingsChange: subscribe, onEvent: subscribe },
  } })
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(dom.document.getElementById('root')!)
  await act(async () => { root.render(<App />) })
  const button = (label: string) => (Array.from(dom.document.querySelectorAll('button')) as HTMLButtonElement[]).find((element) => element.textContent?.trim() === label)
  const click = async (label: string) => {
    const target = button(label)
    if (target === undefined) throw new Error(`Missing button: ${label}`)
    await act(async () => { target.click() })
  }
  const radio = (name: string) => (Array.from(dom.document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]).find((input) => input.value === name)
  return {
    dom, start, restart, restore, exitSafeMode, listSnapshots, confirm, operations, click, button, radio,
    choose: async (name = selected.archiveName) => {
      const input = radio(name)
      if (input === undefined) throw new Error(`Missing snapshot: ${name}`)
      expect(input.disabled).toBe(false)
      // Domino's radio click implementation assumes a parent form. The actual
      // picker has none; dispatch React's change event without that DOM bug.
      await act(async () => { Simulate.change(input) })
    },
    finishRestore: async () => { await act(async () => { restoreResult.resolve(restored) }) },
    finishStartup: async () => { await act(async () => { startupResult.resolve(failed) }) },
    publishRecovery: async (state: RecoveryState) => { await act(async () => { recoveryListener?.(state) }) },
    switchWorkspace: async (finishInSameBatch = false) => {
      await act(async () => {
        workspaceListener?.({ phase: 'switching', message: 'Switching workspace' })
        emitRuntime({ ...failed, launchDirectory: '/another-workspace' })
        recoveryListener?.(requiredRecovery(another))
        if (finishInSameBatch) workspaceListener?.(undefined)
      })
      if (!finishInSameBatch) await act(async () => { workspaceListener?.(undefined) })
    },
    switchWorkspaceBeforeCommit: async (finishPending: () => void) => {
      await act(async () => {
        workspaceListener?.({ phase: 'switching', message: 'Switching workspace' })
        emitRuntime({ ...failed, launchDirectory: '/another-workspace' })
        recoveryListener?.(requiredRecovery(another))
        finishPending()
        // Let the old IPC continuation run within this batch, before React
        // commits the new panel key and invokes the old panel's cleanup.
        await Promise.resolve()
        workspaceListener?.(undefined)
      })
    },
    cleanup: async () => {
      await act(async () => { root.unmount() })
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, descriptor)
      }
    },
  }
}

async function withApp(check: (fixture: Awaited<ReturnType<typeof mountApp>>) => Promise<void>, state?: RecoveryState, runtime?: RuntimeSnapshot) {
  const fixture = await mountApp(state, runtime)
  try { await check(fixture) } finally { await fixture.cleanup() }
}

describe('App RecoveryPanel restore uses the shared restore flow', () => {
  it.each(['safe', 'isolation'] as const)('retries a failed %s Runtime in the same mode and uses its returned ready state without exiting the mode', async (mode) => {
    await withApp(async (h) => {
      const resumed = { ...ready, mode, url: `http://127.0.0.1:4567/?mode=${mode}` }
      // No separate runtime event: the retry response must reach App through
      // the panel callback before it can show the recovered workspace.
      h.restart.mockReset().mockResolvedValue(resumed)
      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(1)

      await h.click(copy.recoveryRetryRuntime)

      expect(h.exitSafeMode).not.toHaveBeenCalled()
      expect(h.restart).toHaveBeenCalledExactlyOnceWith()
      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(0)
      expect(h.dom.document.querySelector('[data-runtime-url]')?.getAttribute('data-runtime-url')).toBe(resumed.url)
      expect(h.dom.document.body.textContent).toContain(mode === 'safe' ? copy.safeModeBadge : copy.isolationModeBadge)
      expect(h.restore).not.toHaveBeenCalled()
    }, requiredRecovery(), { ...failed, mode })
  })

  it.each([false, true])('waits for Main to clear required recovery after a normal retry is ready (pending plugin transaction: %s)', async (hasPendingPlugin) => {
    const recovery: RecoveryState = hasPendingPlugin ? {
      phase: 'recovery-required',
      pendingTransaction: {
        id: 'fixture-plugin-change', kind: 'plugin-change', phase: 'failed',
        snapshotName: selected.archiveName, fromAppVersion: '1.8.1550', preparedAt: '2026-09-13T08:02:00.000Z',
        affectedPlugin: { action: 'install', entryId: 'fixture-plugin', packageName: 'fixture-plugin', profile: 'web' },
      },
    } : requiredRecovery()
    await withApp(async (h) => {
      h.restart.mockReset().mockResolvedValue(ready)

      await h.click(copy.recoveryRetryRuntime)

      expect(h.exitSafeMode).not.toHaveBeenCalled()
      expect(h.restart).toHaveBeenCalledExactlyOnceWith()
      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(1)
      expect(h.dom.document.querySelectorAll('[data-runtime-url]').length).toBe(0)
      if (hasPendingPlugin) expect(h.button('回滚此插件变更')).toBeDefined()
      expect(h.restore).not.toHaveBeenCalled()

      await h.publishRecovery({ phase: 'idle' })

      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(0)
      expect(h.dom.document.querySelector('[data-runtime-url]')?.getAttribute('data-runtime-url')).toBe(ready.url)
      expect(h.restart).toHaveBeenCalledOnce()
    }, recovery)
  })

  it('ignores an old retry response after workspace switching remounts the recovery panel', async () => {
    await withApp(async (h) => {
      const oldRetry = deferred<RuntimeSnapshot>()
      h.restart.mockReset().mockImplementation(() => oldRetry.promise)
      await h.click(copy.recoveryRetryRuntime)
      expect(h.restart).toHaveBeenCalledOnce()

      await h.switchWorkspace(true)
      await act(async () => { oldRetry.resolve({ ...ready, mode: 'safe', url: 'http://127.0.0.1:4567/?old-safe-mode' }) })

      expect(h.exitSafeMode).not.toHaveBeenCalled()
      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(1)
      expect(h.dom.document.querySelectorAll('[data-runtime-url]').length).toBe(0)
      expect(h.dom.document.body.textContent).toContain(another.archiveName)
      expect(h.dom.document.body.textContent).not.toContain(selected.archiveName)
    }, requiredRecovery(), { ...failed, mode: 'safe' })
  })

  it('ignores an old retry response after the workspace event but before the panel unmount commits', async () => {
    await withApp(async (h) => {
      const oldRetry = deferred<RuntimeSnapshot>()
      h.restart.mockReset().mockImplementation(() => oldRetry.promise)
      await h.click(copy.recoveryRetryRuntime)
      expect(h.restart).toHaveBeenCalledOnce()

      await h.switchWorkspaceBeforeCommit(() => {
        oldRetry.resolve({ ...ready, mode: 'safe', url: 'http://127.0.0.1:4567/?old-safe-before-commit' })
      })

      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(1)
      expect(h.dom.document.querySelectorAll('[data-runtime-url]').length).toBe(0)
      expect(h.dom.document.body.textContent).toContain(another.archiveName)
      expect(h.dom.document.body.textContent).not.toContain(selected.archiveName)
      expect(h.exitSafeMode).not.toHaveBeenCalled()
    }, requiredRecovery(), { ...failed, mode: 'safe' })
  })

  it.each(['associated backup', 'historical selection'] as const)('previews and confirms %s once, then retains startup retry after the panel unmounts', async (entry) => {
    await withApp(async (h) => {
      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(1)
      expect(h.start).toHaveBeenCalledExactlyOnceWith({ automatic: true })
      if (entry === 'historical selection') {
        await h.click(copy.recoverySelectSnapshot)
        await h.choose()
        await h.click(reviewLabel)
      } else await h.click(copy.recoveryRestorePrevious)

      expect(h.restore.mock.calls).toEqual([[selected.archiveName, true], [selected.archiveName, false]])
      expect(h.operations).toEqual(['preview', 'confirm', 'restore'])
      expect(h.confirm).toHaveBeenCalledOnce()
      expect(h.confirm.mock.calls[0]?.[0]).toContain(selected.archiveName)
      expect(h.dom.document.querySelectorAll('.recovery-card').length).toBe(0)
      expect(h.restart).not.toHaveBeenCalled()

      await h.finishRestore()
      expect(h.restart).toHaveBeenCalledOnce()
      await h.finishStartup()
      expect(h.dom.document.body.textContent).toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      expect(h.button(copy.settingsRecoveryRetryRuntime)).toBeDefined()
      expect(h.start).toHaveBeenCalledOnce()

      await h.click(copy.settingsRecoveryRetryRuntime)
      expect(h.restart).toHaveBeenCalledTimes(2)
      expect(h.restore.mock.calls).toEqual([[selected.archiveName, true], [selected.archiveName, false]])
      expect(h.confirm).toHaveBeenCalledOnce()
      expect(h.start).toHaveBeenCalledOnce()
      expect(h.dom.document.querySelectorAll('[data-runtime-url]').length).toBe(1)
      expect(h.dom.document.body.textContent).not.toContain(copy.settingsRecoveryRestoredRuntimeFailed)
    })
  })

  it('keeps the historical picker and selected radio when the single details confirmation is canceled', async () => {
    await withApp(async (h) => {
      h.confirm.mockReturnValueOnce(false)
      await h.click(copy.recoverySelectSnapshot)
      await h.choose()
      expect(h.radio(selected.archiveName)?.checked).toBe(true)

      await h.click(reviewLabel)

      expect(h.confirm).toHaveBeenCalledOnce()
      expect(h.restore.mock.calls).toEqual([[selected.archiveName, true]])
      expect(h.dom.document.querySelectorAll('.recovery-snapshot-picker').length).toBe(1)
      expect(h.radio(selected.archiveName)?.checked).toBe(true)
      expect(h.button(reviewLabel)?.disabled).toBe(false)
      expect(h.restart).not.toHaveBeenCalled()
    })
  })

  it('disables shared startup retry while the recovery panel is loading historical backups', async () => {
    await withApp(async (h) => {
      await h.click(copy.recoveryRestorePrevious)
      await h.finishRestore()
      await h.finishStartup()
      await h.publishRecovery(requiredRecovery())
      expect(h.dom.document.querySelector('.recovery-card')?.textContent).toContain(copy.settingsRecoveryRestoredRuntimeFailed)
      expect(h.button(copy.settingsRecoveryRetryRuntime)?.disabled).toBe(false)
      expect(h.restart).toHaveBeenCalledOnce()
      const pendingList = deferred<RecoverySnapshot[]>()
      h.listSnapshots.mockImplementationOnce(() => pendingList.promise)

      await h.click(copy.recoverySelectSnapshot)

      expect(h.dom.document.querySelectorAll('.recovery-snapshot-picker').length).toBe(1)
      expect(h.button(copy.settingsRecoveryRetryRuntime)?.disabled).toBe(true)
      await h.click(copy.settingsRecoveryRetryRuntime)
      expect(h.restart).toHaveBeenCalledOnce()

      await act(async () => { pendingList.resolve([selected]) })

      expect(h.button(copy.settingsRecoveryRetryRuntime)?.disabled).toBe(false)
      await h.click(copy.settingsRecoveryRetryRuntime)
      expect(h.restart).toHaveBeenCalledTimes(2)
      expect(h.restore.mock.calls).toEqual([[selected.archiveName, true], [selected.archiveName, false]])
    })
  })

  it('does not fall back to a different backup when the failure-associated full name is missing', async () => {
    await withApp(async (h) => {
      h.listSnapshots.mockResolvedValue([another])

      await h.click(copy.recoveryRestorePrevious)

      expect(h.listSnapshots).toHaveBeenCalledOnce()
      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.restore).not.toHaveBeenCalled()
      expect(h.restart).not.toHaveBeenCalled()
      expect(h.dom.document.querySelector('[role="alert"]')?.textContent).toBeTruthy()
    })
  })

  it('has no associated restore action or latest fallback when the failure has no backup name', async () => {
    await withApp(async (h) => {
      expect(h.button(copy.recoveryRestorePrevious)).toBeUndefined()
      expect(h.button(copy.recoverySelectSnapshot)).toBeDefined()
      expect(h.restore).not.toHaveBeenCalled()
      expect(h.confirm).not.toHaveBeenCalled()
    }, { phase: 'recovery-required', lastError: 'No associated backup', runtimeFailure: { plugins: [] } })
  })

  it('ignores an associated-name lookup that finishes after switching workspaces', async () => {
    await withApp(async (h) => {
      const oldList = deferred<RecoverySnapshot[]>()
      h.listSnapshots.mockImplementationOnce(() => oldList.promise).mockResolvedValue([another])
      await h.click(copy.recoveryRestorePrevious)
      expect(h.listSnapshots).toHaveBeenCalledOnce()
      expect(h.confirm).not.toHaveBeenCalled()

      await h.switchWorkspace()
      await act(async () => { oldList.resolve([selected]) })

      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.restore).not.toHaveBeenCalled()
      expect(h.restart).not.toHaveBeenCalled()
      expect(h.dom.document.body.textContent).not.toContain(selected.archiveName)
      expect(h.dom.document.body.textContent).toContain(another.archiveName)
    })
  })

  it('ignores a late historical list and starts a fresh picker in the new workspace', async () => {
    await withApp(async (h) => {
      const oldList = deferred<RecoverySnapshot[]>()
      h.listSnapshots.mockImplementationOnce(() => oldList.promise).mockResolvedValue([another])
      await h.click(copy.recoverySelectSnapshot)
      expect(h.dom.document.querySelectorAll('.recovery-snapshot-picker').length).toBe(1)

      await h.switchWorkspace()
      await act(async () => { oldList.resolve([selected]) })

      expect(h.dom.document.querySelectorAll('.recovery-snapshot-picker').length).toBe(0)
      expect(h.radio(selected.archiveName)).toBeUndefined()
      await h.click(copy.recoverySelectSnapshot)
      expect(h.radio(another.archiveName)?.checked).toBe(false)
      expect(h.radio(selected.archiveName)).toBeUndefined()
      expect(h.button(reviewLabel)?.disabled).toBe(true)
      expect(h.restore).not.toHaveBeenCalled()
      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.restart).not.toHaveBeenCalled()
    })
  })

  it('clears an already-selected historical backup even when workspace change starts and finishes in one React batch', async () => {
    await withApp(async (h) => {
      await h.click(copy.recoverySelectSnapshot)
      await h.choose()
      expect(h.radio(selected.archiveName)?.checked).toBe(true)
      h.listSnapshots.mockResolvedValue([another])

      await h.switchWorkspace(true)

      expect(h.dom.document.querySelectorAll('.recovery-snapshot-picker').length).toBe(0)
      await h.click(copy.recoverySelectSnapshot)
      expect(h.radio(another.archiveName)?.checked).toBe(false)
      expect(h.button(reviewLabel)?.disabled).toBe(true)
      expect(h.radio(selected.archiveName)).toBeUndefined()
      expect(h.restore).not.toHaveBeenCalled()
      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.restart).not.toHaveBeenCalled()
    })
  })
})
