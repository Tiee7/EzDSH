import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecoveryPanel } from '../../src/renderer/recovery/RecoveryPanel'
import { getAppCopy } from '../../src/shared/locale'

describe('RecoveryPanel Safe Mode controls', () => {
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
})
