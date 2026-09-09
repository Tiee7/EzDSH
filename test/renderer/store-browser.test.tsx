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
    expect(storeStylesheet).toContain('.detail-install,\n.detail-update {')
    expect(storeStylesheet).toContain('.detail-install:hover:not(:disabled),\n.detail-update:hover:not(:disabled) {')
    expect(storeStylesheet).toContain('.detail-install:disabled,\n.detail-update:disabled {')
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
