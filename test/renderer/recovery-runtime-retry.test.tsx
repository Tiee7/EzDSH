import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'
import { RecoveryPanel } from '../../src/renderer/recovery/RecoveryPanel'
import { getAppCopy } from '../../src/shared/locale'

const copy = getAppCopy('zh')
const ready: RuntimeSnapshot = {
  phase: 'ready', mode: 'safe', url: 'http://127.0.0.1:4567',
  launchDirectory: '/fixture', logPath: '/fixture/runtime.log',
}

async function mountPanel(restart: () => Promise<RuntimeSnapshot>) {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const dom = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const exitSafeMode = vi.fn(async () => ({ ...ready, mode: 'normal' as const }))
  const onStarted = vi.fn()
  Object.assign(dom, { EzDSH: { runtime: { restart }, recovery: { exitSafeMode } } })
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(dom.document.getElementById('root')!)
  await act(async () => { root.render(<RecoveryPanel copy={copy} state={{ phase: 'recovery-required' }}
    runtime={{ ...ready, phase: 'failed', url: undefined }} onRecoveryModeStarted={onStarted} />) })
  const button = () => (Array.from(dom.document.querySelectorAll('button')) as HTMLButtonElement[])
    .find((element) => element.textContent === copy.recoveryRetryRuntime)!
  return {
    dom, exitSafeMode, onStarted, button,
    click: async () => { await act(async () => { button().click() }) },
    dispose: async () => {
      await act(async () => { root.unmount() })
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, descriptor)
      }
    },
  }
}

describe('RecoveryPanel current-mode startup retry', () => {
  it('still exits the mode only when the explicit normal-start action is chosen', async () => {
    const restart = vi.fn(async () => ready)
    const ui = await mountPanel(restart)
    try {
      const exit = (Array.from(ui.dom.document.querySelectorAll('button')) as HTMLButtonElement[])
        .find((element) => element.textContent === copy.safeModeExit)!
      await act(async () => { exit.click() })
      expect(ui.exitSafeMode).toHaveBeenCalledExactlyOnceWith()
      expect(restart).not.toHaveBeenCalled()
    } finally { await ui.dispose() }
  })

  it.each([
    { ...ready, phase: 'failed' as const, url: undefined, message: 'Port still unavailable' },
    { ...ready, phase: 'stopped' as const, url: undefined, message: undefined },
    { ...ready, url: undefined, message: undefined },
  ])('keeps retry available and reports an unusable result: $phase / $url', async (result) => {
    const restart = vi.fn(async () => result)
    const ui = await mountPanel(restart)
    try {
      await ui.click()
      expect(restart).toHaveBeenCalledExactlyOnceWith()
      expect(ui.exitSafeMode).not.toHaveBeenCalled()
      expect(ui.onStarted).not.toHaveBeenCalled()
      expect(ui.dom.document.querySelector('[role="alert"]')?.textContent).toBe(result.message ?? copy.runtimeStartFailed)
      expect(ui.button().disabled).toBe(false)
    } finally { await ui.dispose() }
  })

  it('shows rejected startup errors and clears them after a successful retry', async () => {
    const restart = vi.fn(async () => ready).mockRejectedValueOnce(new Error('Cannot read the saved mode'))
    const ui = await mountPanel(restart)
    try {
      await ui.click()
      expect(ui.dom.document.querySelector('[role="alert"]')?.textContent).toBe('Cannot read the saved mode')
      expect(ui.onStarted).not.toHaveBeenCalled()
      await ui.click()
      expect(restart).toHaveBeenCalledTimes(2)
      expect(ui.exitSafeMode).not.toHaveBeenCalled()
      expect(ui.onStarted).toHaveBeenCalledExactlyOnceWith(ready)
      expect(ui.dom.document.querySelectorAll('[role="alert"]')).toHaveLength(0)
    } finally { await ui.dispose() }
  })

  it('starts only one retry before the first click has rendered its busy state', async () => {
    let finish!: (snapshot: RuntimeSnapshot) => void
    const pending = new Promise<RuntimeSnapshot>((resolve) => { finish = resolve })
    const restart = vi.fn(() => pending)
    const ui = await mountPanel(restart)
    try {
      await act(async () => { ui.button().click(); ui.button().click() })
      expect(restart).toHaveBeenCalledTimes(1)
      expect(ui.exitSafeMode).not.toHaveBeenCalled()
      expect(ui.button().disabled).toBe(true)
      await act(async () => { finish(ready) })
      expect(ui.button().disabled).toBe(false)
      expect(ui.onStarted).toHaveBeenCalledExactlyOnceWith(ready)
    } finally { finish(ready); await ui.dispose() }
  })
})
