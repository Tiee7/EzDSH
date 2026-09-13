import { createWindow } from '@mixmark-io/domino'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'
import { InstalledStoreBrowser } from '../../src/renderer/store/InstalledStoreBrowser'
import { AuditOverrideActions, EntryBadges, EntryCard, InstallFailureNotice, StoreBrowser } from '../../src/renderer/store/StoreBrowser'
import type { StoreEntry } from '../../src/shared/store'
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
}) => Promise<void>, installedSurface = false, failModeRead = false): Promise<void> {
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
      install: vi.fn(async () => ({ kind: 'skill', id: pluginEntry.id, phase: 'done', runtimeRestartRequired: true })),
      setEnabled: vi.fn(async () => ({ kind: 'skill', id: pluginEntry.id, phase: 'done', runtimeRestartRequired: true })),
      onStateChange: vi.fn(() => () => undefined),
    },
  } })
  for (const [key, value] of Object.entries({ window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
    HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const root = createRoot(domWindow.document.getElementById('root')!)
  try {
    await act(async () => { root.render(installedSurface
      ? <InstalledStoreBrowser copy={getAppCopy('zh')} onBack={() => undefined} />
      : <StoreBrowser kind="skill" copy={getAppCopy('zh')} locale="zh" />) })
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
      <AuditOverrideActions copy={getAppCopy('zh')} disabled={false} onInstallAnyway={() => {}} />
    )

    expect(markup).toContain('class="confirm-row"')
    expect(markup).toContain('>仍要安装<')
  })
})

describe('StoreBrowser install failure notice', () => {
  it('shows the command failure and the durable install log path', () => {
    const markup = renderToStaticMarkup(
      <InstallFailureNotice
        copy={getAppCopy('zh')}
        state={{
          kind: 'skill',
          id: 'dsh-codex',
          phase: 'failed',
          failureReason: 'install',
          message: 'ERR_PNPM_IGNORED_BUILDS: protobufjs',
          logPath: '/tmp/ezdsh/logs/plugins/dsh-codex.log',
        }}
      />
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('插件安装失败')
    expect(markup).toContain('ERR_PNPM_IGNORED_BUILDS')
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
