import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { createWindow } from '@mixmark-io/domino'
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeStartupFailureNotice } from '../../src/renderer/app/RuntimeStartupFailureNotice'
import { SettingsPage } from '../../src/renderer/settings/SettingsPage'
import { getAppCopy } from '../../src/shared/locale'

const appStylesheet = readFileSync(new URL('../../src/renderer/app/app.css', import.meta.url), 'utf8')

async function withFailureNotice(
  props: ComponentProps<typeof RuntimeStartupFailureNotice>,
  check: (container: HTMLElement) => Promise<void>,
): Promise<void> {
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
  }
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    HTMLElement: domWindow.HTMLElement,
    Node: domWindow.Node,
    Event: domWindow.Event,
    MouseEvent: domWindow.MouseEvent,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
  const container = domWindow.document.getElementById('root') as unknown as HTMLElement
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<RuntimeStartupFailureNotice {...props} />) })
    await check(container)
  } finally {
    await act(async () => { root.unmount() })
    Object.assign(globalThis, previousGlobals)
    if (previousNavigator === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator')
    } else {
      Object.defineProperty(globalThis, 'navigator', previousNavigator)
    }
    if (previousActEnvironment === undefined) {
      delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
    } else {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    }
  }
}

describe('Runtime startup failure notice', () => {
  it('exposes the failure reason and absolute Runtime log path behind an expandable control', () => {
    const markup = renderToStaticMarkup(
      <RuntimeStartupFailureNotice
        copy={getAppCopy('zh')}
        message="Unable to allocate a loopback port"
        logPath="/Users/snake/Library/Application Support/EzDSH/logs/harness.log"
        onOpenLog={async () => {}}
        initialExpanded
      />
    )

    expect(markup).toContain('收起启动失败原因')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Unable to allocate a loopback port')
    expect(markup).toContain('/Users/snake/Library/Application Support/EzDSH/logs/harness.log')
  })

  it('marks the failure details as a selectable non-drag region', () => {
    const detailsStyles = appStylesheet.match(/\.runtime-failure-details \{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(detailsStyles).toContain('-webkit-app-region: no-drag;')
    expect(detailsStyles).toContain('user-select: text;')
    expect(detailsStyles).toContain('-webkit-user-select: text;')
  })

  it('offers Safe Mode, Isolation Mode, and a Runtime-independent recovery settings entry point', () => {
    const copy = getAppCopy('zh')
    const markup = renderToStaticMarkup(
      <RuntimeStartupFailureNotice
        copy={copy}
        message="plugin failed"
        logPath="/tmp/harness.log"
        onOpenLog={async () => {}}
        onEnterSafeMode={async () => {}}
        onEnterIsolationMode={async () => {}}
        onOpenRecoverySettings={() => {}}
        initialExpanded
      />
    )

    expect(markup).toContain(copy.runtimeEnterSafeMode)
    expect(markup).toContain(copy.runtimeEnterIsolationMode)
    expect(markup).toContain(copy.runtimeOpenRecoverySettings)
  })

  it('keeps the Runtime log action visible while failure details are collapsed', () => {
    const copy = getAppCopy('zh')
    const markup = renderToStaticMarkup(
      <RuntimeStartupFailureNotice
        copy={copy}
        message="plugin failed"
        logPath="/tmp/harness.log"
        onOpenLog={async () => {}}
        initialExpanded={false}
      />
    )

    expect(markup).toContain(copy.settingsOpenLog)
  })

  it.each(['zh', 'en'] as const)('shows a log-opening failure while details are collapsed in %s', async (locale) => {
    const copy = getAppCopy(locale)
    const onOpenLog = vi.fn(async () => { throw new Error('Log file is unavailable') })
    await withFailureNotice({ copy, message: 'plugin failed', logPath: '/example/harness.log', onOpenLog }, async (container) => {
      const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === copy.settingsOpenLog)!
      const toggle = container.querySelector<HTMLButtonElement>('.runtime-failure-toggle')!
      expect(toggle.getAttribute('aria-expanded')).toBe('false')

      await act(async () => { openButton.click() })

      expect(onOpenLog).toHaveBeenCalledTimes(1)
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(`${copy.runtimeOpenLogFailed}: Log file is unavailable`)
      expect(container.querySelectorAll('#runtime-startup-failure-details')).toHaveLength(0)

      await act(async () => { toggle.click() })
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
      expect(container.querySelectorAll('#runtime-startup-failure-details [role="alert"]')).toHaveLength(0)

      await act(async () => { toggle.click() })
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    })
  })

  it('clears the previous log error and prevents repeated clicks while retrying', async () => {
    const copy = getAppCopy('en')
    let completeRetry!: () => void
    const retry = new Promise<void>((resolve) => { completeRetry = resolve })
    const onOpenLog = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Log file is unavailable'))
      .mockImplementationOnce(() => retry)
    await withFailureNotice({ copy, message: 'plugin failed', logPath: '/example/harness.log', onOpenLog }, async (container) => {
      const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === copy.settingsOpenLog)!
      await act(async () => { openButton.click() })
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)

      await act(async () => { openButton.click() })
      expect(openButton.disabled).toBe(true)
      expect(openButton.textContent).toBe(copy.runtimeOpeningLog)
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
      await act(async () => { openButton.click() })
      expect(onOpenLog).toHaveBeenCalledTimes(2)

      await act(async () => { completeRetry() })
      expect(openButton.disabled).toBe(false)
      expect(openButton.textContent).toBe(copy.settingsOpenLog)
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    })
  })

  it('does not offer a log-opening action when the log path is unavailable', async () => {
    const copy = getAppCopy('en')
    const onOpenLog = vi.fn(async () => {})
    await withFailureNotice({ copy, message: undefined, logPath: undefined, onOpenLog }, async (container) => {
      expect(container.textContent).not.toContain(copy.settingsOpenLog)
      await act(async () => { container.querySelector<HTMLButtonElement>('.runtime-failure-toggle')!.click() })
      expect(container.textContent).toContain(copy.runtimeLogPathUnavailable)
      expect(container.textContent).not.toContain(copy.settingsOpenLog)
      expect(onOpenLog).not.toHaveBeenCalled()
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    })
  })

  it('renders only recovery controls in the failure-page settings surface', () => {
    const copy = getAppCopy('zh')
    const markup = renderToStaticMarkup(
      <SettingsPage
        copy={copy}
        locale="zh"
        runtime={undefined}
        rescueOnly
        onExitRescue={() => {}}
      />
    )

    expect(markup).toContain(copy.settingsRecovery)
    expect(markup).toContain(copy.runtimeReturnToFailure)
    expect(markup).not.toContain(copy.settingsWorkspace)
    expect(markup).not.toContain(copy.settingsRuntimeInstances)
  })
})
