import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecoveryPanel, sortRecoverySnapshotsByDate } from '../../src/renderer/recovery/RecoveryPanel'
import type { RecoverySnapshot } from '../../src/main/recovery/recovery-manager'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'
import { getAppCopy } from '../../src/shared/locale'

describe('RecoveryPanel Safe Mode controls', () => {
  it('sorts the specified-backup choices newest first', () => {
    const older = { archiveName: 'older', manifest: { createdAt: '2026-09-07T10:00:00.000Z' } } as RecoverySnapshot
    const newer = { archiveName: 'newer', manifest: { createdAt: '2026-09-08T10:00:00.000Z' } } as RecoverySnapshot

    expect(sortRecoverySnapshotsByDate([older, newer]).map((snapshot) => snapshot.archiveName)).toEqual(['newer', 'older'])
  })

  it('offers a specified-backup recovery entry point', () => {
    const markup = renderToStaticMarkup(
      <RecoveryPanel
        copy={getAppCopy('zh')}
        state={{ phase: 'recovery-required', lastError: 'plugin failed' }}
      />,
    )

    expect(markup).toContain('恢复指定备份')
  })

  it('gives the primary recovery actions a shared button size', () => {
    const css = readFileSync(fileURLToPath(new URL('../../src/renderer/recovery/recovery-panel.css', import.meta.url)), 'utf8')
    expect(css).toMatch(/\.recovery-action-button\s*\{[^}]*width:\s*220px[^}]*min-height:\s*56px/s)
    expect(css).toMatch(/\.recovery-action-button\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s)
  })

  it('keeps recovery actions in aligned two-column rows', () => {
    const css = readFileSync(fileURLToPath(new URL('../../src/renderer/recovery/recovery-panel.css', import.meta.url)), 'utf8')
    expect(css).toMatch(/\.recovery-actions\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*220px\)\)[^}]*justify-content:\s*center/s)
    expect(css).toMatch(/\.recovery-actions\s+\.recovery-action-button\s*\{[^}]*margin-top:\s*0/s)
  })

  it('shows Safe Mode and plugin rollback actions for a failed managed plugin change', () => {
    const markup = renderToStaticMarkup(
      <RecoveryPanel
        copy={getAppCopy('zh')}
        state={{
          phase: 'recovery-required',
          pendingTransaction: {
            id: 'txn-1',
            kind: 'plugin-change',
            phase: 'failed',
            snapshotName: 'ezdsh-pre-plugin-change-test.tar.gz',
            fromAppVersion: '1.8.1536',
            preparedAt: '2026-08-27T00:00:00.000Z',
            affectedPlugin: {
              action: 'install',
              entryId: 'agent-teams',
              packageName: '@nanmicoder/dsh-agent-teams',
              profile: 'web',
            },
          },
        }}
      />,
    )

    expect(markup).toContain('以安全模式启动')
    expect(markup).toContain('回滚此插件变更')
    expect(markup).toContain('agent-teams')
  })

  it('shows a disable choice as well as restore for a normal Runtime plugin failure', () => {
    const markup = renderToStaticMarkup(
      <RecoveryPanel
        copy={getAppCopy('zh')}
        state={{
          phase: 'recovery-required',
          lastError: 'failed to import loader entry (mode-menu-plus)',
          runtimeFailure: {
            logPath: '/tmp/harness.log',
            latestSnapshot: { archiveName: 'ezdsh-manual-test.tar.gz', createdAt: '2026-08-27T00:00:00.000Z', reason: 'manual backup' },
            plugins: [{ packageName: 'mode-menu-plus', profile: 'web', name: 'Mode Menu Plus' }],
          },
        }}
      />,
    )

    expect(markup).toContain('recovery-shell recovery-scroll-region')
    expect(markup).toContain('停用「Mode Menu Plus」并继续启动')
    expect(markup).toContain('恢复上一份环境')
    expect(markup).toContain('failed to import loader entry (mode-menu-plus)')
    expect(markup).toContain('/tmp/harness.log')
  })

  it('gives every recovery action control the shared button geometry', () => {
    const markup = renderToStaticMarkup(
      <RecoveryPanel
        copy={getAppCopy('en')}
        state={{
          phase: 'recovery-required',
          lastError: 'plugin failed',
          runtimeFailure: { logPath: '/tmp/harness.log', plugins: [] },
        }}
      />,
    )
    const actions = markup.match(/<div class="recovery-actions">([\s\S]*?)<\/div>/)?.[1] ?? ''
    const buttons = actions.match(/<button\b[^>]*>/g) ?? []

    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((button) => button.includes('recovery-action-button'))).toBe(true)
  })

  it('shows an exit action when the Runtime is in Safe Mode', () => {
    const runtime: RuntimeSnapshot = {
      phase: 'ready',
      mode: 'safe',
      url: 'http://127.0.0.1:4567/?token=safe-mode-token',
      launchDirectory: '/tmp',
      logPath: '/tmp/harness.log',
    }
    const markup = renderToStaticMarkup(
      <RecoveryPanel
        copy={getAppCopy('zh')}
        runtime={runtime}
        state={{ phase: 'recovery-required', lastError: 'plugin failed' }}
      />,
    )

    expect(markup).toContain('以安全模式启动')
    expect(markup).toContain('退出安全模式并正常启动')
    expect(markup).toContain('class="recovery-link recovery-action-button"')
  })

  it('does not show an exit action when the Runtime is not in Safe Mode', () => {
    const runtime: RuntimeSnapshot = {
      phase: 'failed',
      mode: 'normal',
      launchDirectory: '/tmp',
      logPath: '/tmp/harness.log',
    }
    const markup = renderToStaticMarkup(
      <RecoveryPanel
        copy={getAppCopy('zh')}
        runtime={runtime}
        state={{ phase: 'recovery-required', lastError: 'plugin failed' }}
      />,
    )

    expect(markup).not.toContain('退出安全模式并正常启动')
  })
})
