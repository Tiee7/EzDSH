import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'
import { InstalledStoreBrowser } from '../../src/renderer/store/InstalledStoreBrowser'
import { AuditOverrideActions, EntryBadges, EntryCard, StoreBrowser } from '../../src/renderer/store/StoreBrowser'
import { InstallFailureNotice } from '../../src/renderer/store/InstallFailureNotice'
import { finishPluginRuntimeVerification, needsPluginRuntimeVerification } from '../../src/renderer/store/PluginRuntimeRestartNotice'
import type { InstallState, PluginCompatibilityAssessment, StoreEntry } from '../../src/shared/store'
import type { RuntimeMode, RuntimeSnapshot } from '../../src/main/runtime/runtime-types'

const pluginEntry: StoreEntry = {
  id: 'plugin-demo',
  kind: 'skill',
  name: 'Plugin demo',
  description: 'A plugin entry',
  category: 'plugin',
  auditLevel: 'verified',
  version: '1.0.0',
  plugin: { source: 'npm:@example/plugin' }
}

const mcpEntry: StoreEntry = {
  id: 'mcp-demo',
  kind: 'mcp',
  name: 'MCP demo',
  description: 'An MCP entry',
  category: 'tools',
  auditLevel: 'verified',
  version: '1.0.0',
  mcp: { transport: 'stdio', serverName: 'example' }
}

const storeStylesheet = readFileSync(new URL('../../src/renderer/store/store.css', import.meta.url), 'utf8')

async function withPluginInstall(mode: RuntimeMode, check: (fixture: {
  document: Document
  restart: ReturnType<typeof vi.fn>
  exitSafeMode: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  changeMode: (mode: RuntimeMode) => Promise<void>
}) => Promise<void>, installedSurface = false, failModeRead = false, locale: 'zh' | 'en' = 'zh', compatibility?: PluginCompatibilityAssessment, installedOperationState?: InstallState): Promise<void> {
  const previous = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
  const snapshot = (selectedMode: RuntimeMode): RuntimeSnapshot => ({ phase: 'ready', mode: selectedMode, launchDirectory: '/fixture', logPath: '/fixture/log' })
  let onRuntimeChange: ((value: RuntimeSnapshot) => void) | undefined
  const restart = vi.fn(async () => snapshot(mode))
  const exitSafeMode = vi.fn(async () => snapshot('normal'))
  const getStatus = vi.fn(async () => snapshot(mode))
  if (failModeRead) getStatus.mockRejectedValueOnce(new Error('Mode status unavailable'))
  Object.assign(domWindow, { EzDSH: {
    runtime: {
      getStatus, restart,
      onStateChange: vi.fn((listener: typeof onRuntimeChange) => { onRuntimeChange = listener; return () => { onRuntimeChange = undefined } }),
    },
    recovery: { exitSafeMode },
    store: {
      categories: vi.fn(async () => []),
      list: vi.fn(async () => ({ entries: [pluginEntry], page: 1, pageCount: 1 })),
      listInstalled: vi.fn(async () => ({ records: installedSurface ? [{
        kind: 'skill', id: pluginEntry.id, name: pluginEntry.name, version: pluginEntry.version,
        pluginPackageName: '@example/plugin', pluginProfile: 'web', enabled: false,
      }] : [] })),
      entry: vi.fn(async () => pluginEntry),
      install: vi.fn(async () => ({
        kind: 'skill',
        id: pluginEntry.id,
        phase: compatibility?.status === 'incompatible' ? 'failed' : 'done',
        ...(compatibility?.status === 'incompatible'
          ? { failureReason: 'incompatible', message: compatibility.reason }
          : { runtimeRestartRequired: true }),
        ...(compatibility === undefined ? {} : { compatibility }),
      })),
      setEnabled: vi.fn(async () => installedOperationState ?? ({ kind: 'skill', id: pluginEntry.id, phase: 'done', runtimeRestartRequired: true })),
      onStateChange: vi.fn(() => () => undefined),
    },
  } })
  for (const [key, value] of Object.entries({ window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
    HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(domWindow.document.getElementById('root')!)
  try {
    await act(async () => { root.render(installedSurface
      ? <InstalledStoreBrowser copy={getAppCopy(locale)} onBack={() => undefined} />
      : <StoreBrowser kind="skill" copy={getAppCopy(locale)} locale={locale} />) })
    if (installedSurface) {
      await act(async () => { (domWindow.document.querySelector('.detail-toggle-plugin') as HTMLElement).click() })
    } else {
      await act(async () => { (domWindow.document.querySelector('.entry-card') as HTMLElement).click() })
      await act(async () => { (domWindow.document.querySelector('.detail-install') as HTMLElement).click() })
    }
    await check({ document: domWindow.document, restart, exitSafeMode, getStatus,
      changeMode: async (nextMode) => { await act(async () => { onRuntimeChange?.(snapshot(nextMode)) }) },
    })
  } finally {
    await act(async () => { root.unmount() })
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

describe('StoreBrowser plugin activation in recovery modes', () => {
  it('keeps the normal-start action after another plugin change is blocked by pending verification', () => {
    const blocked = {
      kind: 'skill', id: 'second-plugin', phase: 'failed', failureReason: 'install',
      diagnostic: {
        code: 'pending-plugin-verification', detail: 'pending previous change', suggestedAction: 'Start normally',
      },
    } as const
    expect(needsPluginRuntimeVerification(blocked)).toBe(true)
    expect(finishPluginRuntimeVerification(blocked)).toBeUndefined()
    expect(needsPluginRuntimeVerification({
      kind: 'skill', id: 'plugin', phase: 'failed', failureReason: 'install',
      diagnostic: { code: 'network', detail: 'offline', suggestedAction: 'Check network' },
    })).toBe(false)
    expect(finishPluginRuntimeVerification({
      kind: 'skill', id: 'plugin', phase: 'done', runtimeRestartRequired: true,
    })).toEqual({ kind: 'skill', id: 'plugin', phase: 'done', runtimeRestartRequired: false })
  })

  it('retries a failed mode read before asking the user to explicitly start normally', async () => {
    await withPluginInstall('safe', async ({ document, restart, exitSafeMode, getStatus }) => {
      expect(document.body.textContent).toContain('Mode status unavailable')
      const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '重新检查运行模式')!
      expect(retry).toBeDefined()
      await act(async () => { retry.click() })
      expect(getStatus).toHaveBeenCalledTimes(2)
      expect(restart).not.toHaveBeenCalled()
      expect(exitSafeMode).not.toHaveBeenCalled()
      const activate = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '正常启动并应用插件变更')!
      expect(activate.disabled).toBe(false)
      await act(async () => { activate.click() })
      expect(exitSafeMode).toHaveBeenCalledOnce()
    }, false, true)
  })
  it.each(['normal', 'safe', 'isolation'] as const)('uses the same explicit activation flow for installed plugins in %s mode', async (mode) => {
    await withPluginInstall(mode, async ({ document, restart, exitSafeMode }) => {
      if (mode !== 'normal') {
        expect(document.body.textContent).toContain('普通重启仍会保持当前模式')
        const keepWorking = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '继续当前模式')!
        await act(async () => { keepWorking.click() })
        expect(exitSafeMode).not.toHaveBeenCalled()
      }
      const label = mode === 'normal' ? '立即重启' : '正常启动并应用插件变更'
      const activate = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === label)!
      await act(async () => { activate.click() })
      expect(exitSafeMode).toHaveBeenCalledTimes(mode === 'normal' ? 0 : 1)
      expect(restart).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0)
      expect(document.querySelectorAll('.runtime-restart-notice')).toHaveLength(0)
    }, true)
  })
  it.each(['safe', 'isolation'] as const)('requires an explicit normal start to activate a plugin in %s mode', async (mode) => {
    await withPluginInstall(mode, async ({ document, restart, exitSafeMode }) => {
      expect(document.body.textContent).toContain('普通重启仍会保持当前模式')
      expect(document.body.textContent).toContain('正常启动并应用插件变更')
      expect(restart).not.toHaveBeenCalled()
      expect(exitSafeMode).not.toHaveBeenCalled()
      const activate = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '正常启动并应用插件变更')!
      await act(async () => { activate.click() })
      expect(exitSafeMode).toHaveBeenCalledOnce()
      expect(restart).not.toHaveBeenCalled()
      expect(document.querySelectorAll('.runtime-restart-notice')).toHaveLength(0)
    })
  })

  it.each(['safe', 'isolation'] as const)('allows continuing %s mode and keeps a later explicit activation action', async (mode) => {
    await withPluginInstall(mode, async ({ document, restart, exitSafeMode }) => {
      const keepWorking = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '继续当前模式')!
      expect(keepWorking).toBeDefined()
      await act(async () => { keepWorking.click() })
      expect(document.body.textContent).toContain('可以继续使用当前模式')
      expect(document.body.textContent).toContain('正常启动并应用插件变更')
      expect(document.body.textContent).not.toContain('稍后重启 Runtime 后生效')
      expect(restart).not.toHaveBeenCalled()
      expect(exitSafeMode).not.toHaveBeenCalled()
    })
  })

  it('retains the ordinary restart action in normal mode', async () => {
    await withPluginInstall('normal', async ({ document, restart, exitSafeMode }) => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === '立即重启')!
      await act(async () => { button.click() })
      expect(restart).toHaveBeenCalledOnce()
      expect(exitSafeMode).not.toHaveBeenCalled()
    })
  })

  it('updates activation guidance when Runtime changes to a recovery mode', async () => {
    await withPluginInstall('normal', async ({ document, changeMode }) => {
      await changeMode('safe')
      expect(document.body.textContent).toContain('正常启动并应用插件变更')
      expect(document.body.textContent).not.toContain('立即重启')
    })
  })

  it('keeps the explicit activation action available after normal startup fails', async () => {
    await withPluginInstall('safe', async ({ document, restart, exitSafeMode }) => {
      exitSafeMode.mockRejectedValueOnce(new Error('Plugin failed to start'))
      const activate = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '正常启动并应用插件变更')!
      await act(async () => { activate().click() })
      expect(document.body.textContent).toContain('Plugin failed to start')
      expect(activate().disabled).toBe(false)
      expect(restart).not.toHaveBeenCalled()
      await act(async () => { activate().click() })
      expect(exitSafeMode).toHaveBeenCalledTimes(2)
      expect(document.querySelectorAll('.runtime-restart-notice')).toHaveLength(0)
    })
  })

  it.each([
    ['zh', '无法确认此插件与当前 DSH Runtime 是否兼容。安装后请正常启动 Runtime 验证；若启动失败，可在恢复页处理该插件。'],
    ['en', 'Compatibility with the current DSH Runtime could not be confirmed. After installing, start Runtime normally to verify it; if startup fails, manage the plugin from Recovery.'],
  ] as const)('does not suggest Safe Mode as compatibility verification in %s', async (locale, expected) => {
    await withPluginInstall('normal', async ({ document }) => {
      const warning = document.querySelector('.compatibility-warning')
      expect(warning?.textContent).toBe(expected)
      expect(warning?.textContent).not.toContain('安全模式验证')
      expect(warning?.textContent).not.toContain('Safe Mode')
    }, false, false, locale, {
      status: 'unknown',
      runtimeVersion: '1.2.3',
      reason: 'The catalog does not declare a DSH runtime range.',
    })
  })

  it.each([
    ['zh', '当前 DSH Runtime（0.1.1-rc.2）不在该插件声明的支持范围内。请更新 Runtime 或选择兼容的插件版本后重试；安全模式无法解决版本不兼容。'],
    ['en', 'The current DSH Runtime (0.1.1-rc.2) is outside the range declared by this plugin. Update Runtime or choose a compatible plugin version, then retry; Safe Mode cannot resolve a version mismatch.'],
  ] as const)('shows one actionable incompatibility notice in %s', async (locale, expected) => {
    const reason = 'Requires DSH 0.2.0 or later.'
    await withPluginInstall('normal', async ({ document }) => {
      expect(document.querySelector('.compatibility-error-message')?.textContent).toBe(expected)
      expect(document.querySelector('.compatibility-error-technical pre')?.textContent).toBe(reason)
      expect(document.querySelectorAll('.install-failure')).toHaveLength(0)
    }, false, false, locale, {
      status: 'incompatible',
      runtimeVersion: '0.1.1-rc.2',
      reason,
    })
  })
})

describe('StoreBrowser refresh control', () => {
  it('does not submit the surrounding search form', () => {
    const markup = renderToStaticMarkup(
      <StoreBrowser kind="preset" copy={getAppCopy('zh')} locale="zh" />
    )

    expect(markup).toMatch(/<button type="button" class="store-refresh"/)
  })
})

describe('InstalledStoreBrowser update controls', () => {
  it('uses the primary action styling for installed-entry updates', () => {
    expect(storeStylesheet).toMatch(/\.detail-install,\s*\.detail-update(?:,\s*[^{}]+)?\s*\{/)
    expect(storeStylesheet).toMatch(/\.detail-install:hover:not\(:disabled\),\s*\.detail-update:hover:not\(:disabled\)(?:,\s*[^{}]+)?\s*\{/)
    expect(storeStylesheet).toMatch(/\.detail-install:disabled,\s*\.detail-update:disabled(?:,\s*[^{}]+)?\s*\{/)
  })

  it.each([
    ['zh', '暂不能修改其他插件', '上一项插件变更尚未验证', '请正常启动并确认上一项插件变更', '技术细节'],
    ['en', 'Another plugin change is waiting', 'The previous plugin change is awaiting verification', 'Start normally and verify the previous plugin change', 'Technical details'],
  ] as const)('shows the structured pending-plugin diagnosis on the installed surface in %s', async (locale, title, cause, action, details) => {
    const raw = 'Restart Runtime before changing another DSH plugin'
    const state: InstallState = {
      kind: 'skill',
      id: pluginEntry.id,
      phase: 'failed',
      failureReason: 'install',
      message: raw,
      diagnostic: {
        code: 'pending-plugin-verification',
        detail: raw,
        suggestedAction: 'Start Runtime in normal mode.',
      },
    }
    await withPluginInstall('safe', async ({ document }) => {
      const card = document.querySelector('.installed-card')
      expect(card?.querySelector('.install-failure-title')?.textContent).toBe(title)
      expect(card?.querySelector('.install-failure-cause')?.textContent).toBe(cause)
      expect(card?.querySelector('.install-failure-action')?.textContent).toContain(action)
      expect(card?.querySelector('.install-failure-technical summary')?.textContent).toBe(details)
      expect(card?.querySelector('.install-failure-technical pre')?.textContent).toBe(raw)
      expect(card?.querySelectorAll('.installed-card-error')).toHaveLength(0)
    }, true, false, locale, undefined, state)
  })

  it('refreshes the skill catalog when checking for updates', async () => {
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
      HTMLElement: globalThis.HTMLElement,
      Node: globalThis.Node,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
    }
    const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    const refresh = vi.fn(async () => ({
      fetchedAt: '2026-09-09T00:00:00.000Z',
      counts: { skill: 0, preset: 0, mcp: 0 },
      rejected: [],
    }))
    const list = vi.fn(async () => ({ entries: [], page: 1, pageCount: 1 }))
    ;(domWindow as unknown as { EzDSH: unknown }).EzDSH = {
      store: {
        listInstalled: vi.fn(async () => ({ records: [] })),
        refresh,
        list,
      },
    }
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      HTMLElement: domWindow.HTMLElement,
      Node: domWindow.Node,
      Event: domWindow.Event,
      MouseEvent: domWindow.MouseEvent,
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => {
        root.render(<InstalledStoreBrowser copy={getAppCopy('zh')} onBack={() => {}} />)
        await Promise.resolve()
      })
      const button = Array.from(domWindow.document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent === '检查更新')
      if (button === undefined) throw new Error('check-for-updates button should render')

      await act(async () => {
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(refresh).toHaveBeenCalledWith('skill')
      expect(list).toHaveBeenCalledWith('skill', { page: 1 })
      expect(domWindow.document.body.textContent).toContain('所有 skill 都是最新版本')
    } finally {
      await act(async () => {
        root.unmount()
      })
      const { navigator: previousNavigator, ...previousGlobalsWithoutNavigator } = previousGlobals
      Object.assign(globalThis, previousGlobalsWithoutNavigator)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
      if (previousActEnvironment === undefined) {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
      } else {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
      }
    }
  })
})

describe('StoreBrowser audit override', () => {
  it('places the temporary override in the confirmation action row', () => {
    const markup = renderToStaticMarkup(
      <AuditOverrideActions copy={getAppCopy('zh')} disabled={false} operation="install" onProceed={() => {}} />
    )

    expect(markup).toContain('class="confirm-row"')
    expect(markup).toContain('>仍要安装<')
  })

  it('continues an audit-blocked catalog update through updateAnyway', async () => {
    const previousGlobals = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
      HTMLElement: globalThis.HTMLElement,
      Node: globalThis.Node,
      Event: globalThis.Event,
      MouseEvent: globalThis.MouseEvent,
    }
    const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const domWindow = createWindow('<!doctype html><html><body><div id="root"></div></body></html>')
    const preset: StoreEntry = {
      id: 'dsh-expert-mode', kind: 'preset', name: '专家模式', description: 'Expert', category: 'mode',
      auditLevel: 'verified', version: '1.0.1', files: [],
    }
    const updateAnyway = vi.fn(async () => ({ kind: 'preset', id: preset.id, phase: 'done' as const }))
    const installAnyway = vi.fn(async () => ({ kind: 'preset', id: preset.id, phase: 'done' as const }))
    const update = vi.fn(async () => ({
      kind: 'preset', id: preset.id, phase: 'failed' as const, failureReason: 'audit-blocked' as const,
      audit: { verdict: 'block' as const, findings: [], externalUrls: [] },
    }))
    ;(domWindow as unknown as { EzDSH: unknown }).EzDSH = {
      store: {
        categories: vi.fn(async () => []),
        list: vi.fn(async () => ({ entries: [preset], page: 1, pageCount: 1 })),
        listInstalled: vi.fn(async () => ({ records: [{
          kind: 'preset', id: preset.id, name: preset.name, version: '1.0.0', sha256: '0'.repeat(64), installedAt: '2026-09-14T00:00:00.000Z'
        }] })),
        entry: vi.fn(async () => preset),
        update,
        updateAnyway,
        installAnyway,
        onStateChange: vi.fn(() => () => undefined),
      },
    }
    Object.assign(globalThis, {
      window: domWindow,
      document: domWindow.document,
      HTMLElement: domWindow.HTMLElement,
      Node: domWindow.Node,
      Event: domWindow.Event,
      MouseEvent: domWindow.MouseEvent,
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

    const root = createRoot(domWindow.document.getElementById('root')!)
    try {
      await act(async () => {
        root.render(<StoreBrowser kind="preset" copy={getAppCopy('zh')} locale="zh" />)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      const card = domWindow.document.querySelector('.entry-card') as HTMLElement | null
      expect(card).not.toBeNull()
      await act(async () => { card?.click() })
      const updateButton = domWindow.document.querySelector('.detail-actions .detail-install') as HTMLElement | null
      expect(updateButton).toBeTruthy()
      await act(async () => {
        updateButton?.click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(update).toHaveBeenCalledWith('preset', preset.id)
      const override = Array.from(domWindow.document.querySelectorAll('button')).find((button) => button.textContent === '仍要更新')
      expect(domWindow.document.body.textContent).toContain('仍要更新')
      expect(override).toBeDefined()
      await act(async () => { override?.click() })

      expect(updateAnyway).toHaveBeenCalledWith('preset', preset.id)
      expect(installAnyway).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root.unmount() })
      const { navigator: previousNavigator, ...previousGlobalsWithoutNavigator } = previousGlobals
      Object.assign(globalThis, previousGlobalsWithoutNavigator)
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator })
      if (previousActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
      else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    }
  })
})

describe('StoreBrowser install failure notice', () => {
  it.each([
    ['zh', '暂不能修改其他插件', '上一项插件变更尚未验证', '请正常启动并确认上一项插件变更', '技术细节'],
    ['en', 'Another plugin change is waiting', 'The previous plugin change is awaiting verification', 'Start normally and verify the previous plugin change', 'Technical details'],
  ] as const)('explains the pending plugin guard in %s without leading with the internal English error', (locale, title, cause, action, details) => {
    const raw = 'Start Runtime in normal mode to verify the previous plugin change before changing another DSH plugin. Restarting Safe Mode or Isolation Mode does not verify plugins.'
    const markup = renderToStaticMarkup(
      <InstallFailureNotice
        copy={getAppCopy(locale)}
        state={{
          kind: 'skill', id: 'second-plugin', phase: 'failed', failureReason: 'install', message: raw,
          diagnostic: { code: 'pending-plugin-verification' as never, detail: raw, suggestedAction: 'Start Runtime in normal mode.' },
        }}
      />
    )

    expect(markup).toContain(title)
    expect(markup).toContain(cause)
    expect(markup).toContain(action)
    expect(markup).toContain(details)
    expect(markup.indexOf(cause)).toBeLessThan(markup.indexOf(raw))
  })

  it.each([
    ['zh', '插件操作失败', '插件安装失败', '详细操作日志', '详细安装日志'],
    ['en', 'Plugin operation failed', 'Plugin installation failed', 'Detailed operation log', 'Detailed install log'],
  ] as const)('uses generic operation wording for an uninstall failure in %s', (locale, title, installOnlyTitle, logLabel, installOnlyLogLabel) => {
    const markup = renderToStaticMarkup(
      <InstallFailureNotice
        copy={getAppCopy(locale)}
        state={{
          kind: 'skill',
          id: 'dsh-codex',
          phase: 'failed',
          failureReason: 'install',
          message: 'Failed to uninstall dsh-codex',
          logPath: '/tmp/ezdsh/logs/plugins/dsh-codex.log',
        }}
      />
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain(title)
    expect(markup).not.toContain(installOnlyTitle)
    expect(markup).toContain('Failed to uninstall dsh-codex')
    expect(markup).toContain(logLabel)
    expect(markup).not.toContain(installOnlyLogLabel)
    expect(markup).toContain('/tmp/ezdsh/logs/plugins/dsh-codex.log')
  })

  it('shows the classified cause and corrective owner for an invalid dependency name', () => {
    const markup = renderToStaticMarkup(
      <InstallFailureNotice
        copy={getAppCopy('zh')}
        state={{
          kind: 'skill',
          id: 'nihaixia',
          phase: 'failed',
          failureReason: 'install',
          message: '[ERR_PNPM_INVALID_DEPENDENCY_NAME] invalid alias "nihaixia#v2.3.1"',
          diagnostic: {
            code: 'invalid-dependency-name',
            packageSpec: 'nihaixia#v2.3.1',
            detail: '[ERR_PNPM_INVALID_DEPENDENCY_NAME] invalid alias "nihaixia#v2.3.1"',
            suggestedAction: 'Changing build permissions will not fix it.'
          }
        }}
      />
    )

    expect(markup).toContain('依赖名称或别名无效')
    expect(markup).toContain('应修正目录条目或上游包')
    expect(markup).toContain('nihaixia#v2.3.1')
    expect(markup).not.toContain('修改 allowBuilds')
  })
})

describe('StoreBrowser entry type badges', () => {
  it('uses the compact Disabled label on a disabled entry card', () => {
    const markup = renderToStaticMarkup(
      <EntryCard
        entry={pluginEntry}
        installed={{
          kind: 'skill',
          id: pluginEntry.id,
          version: pluginEntry.version,
          sha256: '0'.repeat(64),
          installedAt: '2026-09-05T00:00:00.000Z',
          name: pluginEntry.name,
          enabled: false,
        }}
        copy={getAppCopy('en')}
        selected={false}
        onSelect={() => {}}
      />,
    )

    expect(markup).toContain('>Disabled<')
    expect(markup).not.toContain('Plugin disabled (installation kept)')
  })

  it('keeps the type badge on a normal cursor instead of showing a help question mark', () => {
    const badgeTypeStyles = storeStylesheet.match(/\.badge-type \{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(badgeTypeStyles).toContain('cursor: default;')
    expect(badgeTypeStyles).not.toContain('cursor: help;')
  })

  it('places the plugin type badge before the audit badge', () => {
    const markup = renderToStaticMarkup(<EntryBadges entry={pluginEntry} copy={getAppCopy('zh')} />)

    expect(markup.indexOf('title="插件"')).toBeGreaterThanOrEqual(0)
    expect(markup.indexOf('data-icon="puzzle-piece"')).toBeGreaterThanOrEqual(0)
    expect(markup.indexOf('title="插件"')).toBeLessThan(markup.indexOf('>已验证<'))
  })

  it('uses a plug icon and MCP server label for MCP entries', () => {
    const markup = renderToStaticMarkup(<EntryBadges entry={mcpEntry} copy={getAppCopy('zh')} />)

    expect(markup).toContain('title="MCP 服务"')
    expect(markup).toContain('aria-label="MCP 服务"')
    expect(markup).toContain('data-icon="plug"')
  })

  it('does not render a type badge for a regular skill', () => {
    const markup = renderToStaticMarkup(<EntryBadges entry={{ ...pluginEntry, plugin: undefined }} copy={getAppCopy('zh')} />)

    expect(markup).not.toContain('badge-type')
    expect(markup).toContain('>已验证<')
  })
})
