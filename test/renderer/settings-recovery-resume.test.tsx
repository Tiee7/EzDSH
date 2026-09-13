import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'
import type { RecoveryRestoreFlow } from '../../src/renderer/recovery/useRecoveryRestore'
import type { RecoveryRestoreResult } from '../../src/main/recovery/recovery-manager'

vi.mock('../../src/renderer/settings/ProviderSection', () => ({ ProviderSection: () => <div data-provider-settings /> }))
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

import { SettingsPage } from '../../src/renderer/settings/SettingsPage'

const copy = getAppCopy('zh')
const restored: RecoveryRestoreResult = {
  dryRun: false, snapshotName: 'selected.tar.gz', restoredAt: '2026-09-13T08:00:00.000Z',
  preRestoreSnapshotName: 'before.tar.gz', missingCredentials: [], entries: [],
}
const makeFlow = (state: Partial<RecoveryRestoreFlow> = {}): RecoveryRestoreFlow => ({
  busy: false, restore: vi.fn(async () => {}), retryRuntime: vi.fn(async () => {}), onRuntimeReady: vi.fn(), clear: vi.fn(), ...state,
})

async function withSettings(run: (h: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  const h = await mount()
  try { await run(h) } finally { await h.cleanup() }
}

async function mount() {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.assign(dom, { EzDSH: {
    app: { name: 'EzDSH', version: '1.0.0' },
    settings: {
      getWorkspace: async () => ({ root: '/fixture' }), getDeveloperMode: async () => false,
      getLanguageTagVisible: async () => true, onDeveloperModeChange: () => () => {}, onLanguageTagVisibilityChange: () => () => {},
    },
    recovery: { listSnapshots: vi.fn(async () => []) },
  } })
  const root = createRoot(dom.document.getElementById('root')!)
  const render = (flow?: RecoveryRestoreFlow, key = 'initial', rescueOnly = false) => act(async () => {
    root.render(<SettingsPage key={key} copy={copy} locale="zh" runtime={undefined} restoreFlow={flow} rescueOnly={rescueOnly} />)
  })
  await render()
  return {
    dom, render,
    selectedTab: () => dom.document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    clickTab: async (label: string) => {
      const tab = (Array.from(dom.document.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]).find((item) => item.textContent === label)
      if (!tab) throw new Error(`Missing tab: ${label}`)
      await act(async () => { tab.click() })
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

describe('SettingsPage restore result on remount', () => {
  it.each([
    ['success', { message: copy.settingsRecoveryRestored }],
    ['error', { error: copy.settingsRecoveryRestoredRuntimeFailed }],
    ['pending startup', { pendingRuntimeRestore: restored }],
    ['busy', { busy: true }],
  ] as const)('reopens the real recovery section when %s survives the Runtime transition', async (_label, state) => {
    await withSettings(async (h) => {
      expect(h.selectedTab()).toBe(copy.settingsTabGeneral)
      await h.render(makeFlow(state), 'after-runtime-transition')
      expect(h.selectedTab()).toBe(copy.settingsRecovery)
      expect(h.dom.document.querySelector('.settings-recovery-card')).toBeTruthy()
      expect(h.dom.document.querySelector('[data-provider-settings]')).toBeFalsy()
      if ('message' in state) expect(h.dom.document.querySelector('[role="status"]')?.textContent).toBe(state.message)
      if ('error' in state) expect(h.dom.document.querySelector('[role="alert"]')?.textContent).toBe(state.error)
      if ('pendingRuntimeRestore' in state) expect(h.dom.document.body.textContent).toContain(copy.settingsRecoveryRetryRuntime)
      if ('busy' in state) expect((h.dom.document.querySelector('.settings-recovery-actions button') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('keeps ordinary settings on General when there is no restore state', async () => {
    await withSettings(async (h) => {
      expect(h.selectedTab()).toBe(copy.settingsTabGeneral)
      await h.render(makeFlow(), 'empty-flow-remount')
      expect(h.selectedTab()).toBe(copy.settingsTabGeneral)
      expect(h.dom.document.querySelector('[data-provider-settings]')).toBeTruthy()
      expect(h.dom.document.querySelector('.settings-recovery-card')).toBeFalsy()
    })
  })

  it('preserves the existing recovery-only initial page without a restore flow', async () => {
    await withSettings(async (h) => {
      await h.render(undefined, 'rescue-remount', true)
      expect(h.selectedTab()).toBe(copy.settingsRecovery)
      expect(h.dom.document.querySelector('.settings-recovery-card')).toBeTruthy()
    })
  })

  it('lets users navigate away after viewing recovery feedback', async () => {
    await withSettings(async (h) => {
      await h.render(makeFlow({ message: copy.settingsRecoveryRestored }), 'restored')
      await h.clickTab(copy.settingsTabGeneral)
      await h.render(makeFlow({ message: copy.settingsRecoveryRestored }), 'restored')
      expect(h.selectedTab()).toBe(copy.settingsTabGeneral)
      expect(h.dom.document.querySelector('[data-provider-settings]')).toBeTruthy()
    })
  })
})
