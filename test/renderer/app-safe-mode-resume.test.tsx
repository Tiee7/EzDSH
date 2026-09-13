import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'
import type { RecoveryState } from '../../src/main/recovery/recovery-manager'
import { getDefaultNavConfig } from '../../src/shared/navigation'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/shared/notifications'

// Exercise App's real startup hooks and recovery/workspace routing without
// mounting unrelated products or a native Runtime webview.
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

async function mountApp(recoveryPhase: RecoveryState['phase'], nextRuntime: RuntimeSnapshot, check: (fixture: {
  document: Document
  start: ReturnType<typeof vi.fn>
  publishRecovery: (state: RecoveryState) => Promise<void>
}) => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const subscribe = () => () => undefined
  let recoveryListener: ((state: RecoveryState) => void) | undefined
  const start = vi.fn(async () => nextRuntime)
  Object.assign(domWindow, { EzDSH: {
    app: { platform: 'darwin' },
    runtime: {
      getStatus: async () => ({ ...nextRuntime, phase: 'idle', mode: 'normal', url: undefined }),
      start, onStateChange: subscribe,
    },
    ui: { onNavigate: subscribe, onDeepLinkInstall: subscribe, onDeepLinkSession: subscribe },
    locale: { get: async () => 'zh', onChange: subscribe },
    settings: {
      getLanguageTagVisible: async () => false, getDeveloperMode: async () => false,
      onLanguageTagVisibilityChange: subscribe, onDeveloperModeChange: subscribe, onWorkspaceChange: subscribe,
    },
    updates: { getStatus: async () => ({ phase: 'idle' }), onStateChange: subscribe },
    recovery: {
      getStatus: async () => ({ phase: recoveryPhase }),
      onStateChange: (listener: typeof recoveryListener) => { recoveryListener = listener; return () => { recoveryListener = undefined } },
    },
    navigation: { getConfig: async () => getDefaultNavConfig(), onStateChange: subscribe },
    notifications: { getSettings: async () => DEFAULT_NOTIFICATION_SETTINGS, onSettingsChange: subscribe, onEvent: subscribe },
  } })
  for (const [key, value] of Object.entries({ window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
    HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(domWindow.document.getElementById('root')!)
  try {
    await act(async () => { root.render(<App />) })
    await check({ document: domWindow.document, start,
      publishRecovery: async (state) => { await act(async () => { recoveryListener?.(state) }) },
    })
  } finally {
    await act(async () => { root.unmount() })
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

const safeReady: RuntimeSnapshot = { phase: 'ready', mode: 'safe', url: 'http://127.0.0.1:4567', launchDirectory: '/fixture', logPath: '/fixture/runtime.log' }

describe('App remembered Safe Mode startup', () => {
  it('requests a guarded automatic start despite pending recovery and opens the restored Safe Mode workspace', async () => {
    await mountApp('recovery-required', safeReady, async ({ document, start }) => {
      expect(start).toHaveBeenCalledExactlyOnceWith({ automatic: true })
      expect(document.querySelectorAll('.workspace')).toHaveLength(1)
      expect(document.querySelector('[data-runtime-url]')?.getAttribute('data-runtime-url')).toBe(safeReady.url)
      expect(document.querySelectorAll('.recovery-shell')).toHaveLength(0)
      expect(document.body.textContent).toContain('安全模式')
    })
  })

  it('keeps recovery visible when Main declines automatic normal startup without a saved safe choice', async () => {
    await mountApp('recovery-required', { ...safeReady, phase: 'stopped', mode: 'normal', url: undefined }, async ({ document, start }) => {
      expect(start).toHaveBeenCalledExactlyOnceWith({ automatic: true })
      expect(document.querySelectorAll('.recovery-shell')).toHaveLength(1)
      expect(document.querySelectorAll('.workspace')).toHaveLength(0)
    })
  })

  it('does not start while files are restoring and only resumes after restoration leaves that phase', async () => {
    await mountApp('restoring', safeReady, async ({ document, start, publishRecovery }) => {
      expect(start).not.toHaveBeenCalled()
      expect(document.querySelectorAll('.workspace')).toHaveLength(0)
      await publishRecovery({ phase: 'recovery-required' })
      expect(start).toHaveBeenCalledExactlyOnceWith({ automatic: true })
      expect(document.querySelectorAll('.workspace')).toHaveLength(1)
    })
  })
})
