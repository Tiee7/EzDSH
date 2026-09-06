import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'
import { SafeModeCornerOverlay } from '../../src/renderer/app/SafeModeOverlay'
import { SafeModeSettingsBanner } from '../../src/renderer/settings/SafeModeSettingsBanner'
import { getAppCopy } from '../../src/shared/locale'

describe('Safe Mode UI', () => {
  it('renders four non-interactive Safe Mode corner labels', () => {
    const markup = renderToStaticMarkup(<SafeModeCornerOverlay label="安全模式" />)

    expect(markup.match(/安全模式/g)).toHaveLength(4)
    expect(markup).toContain('style="pointer-events:none"')
  })

  it('explains the temporary nature of Safe Mode and offers an exit action', () => {
    const runtime: RuntimeSnapshot = {
      phase: 'ready',
      mode: 'safe',
      url: 'http://127.0.0.1:4567/?token=safe-mode-token',
      launchDirectory: '/tmp',
      logPath: '/tmp/harness.log',
    }
    const markup = renderToStaticMarkup(
      <SafeModeSettingsBanner
        copy={getAppCopy('zh')}
        runtime={runtime}
        onExit={async () => {}}
        onOpenRecoveryOptions={() => {}}
      />,
    )

    expect(markup).toContain('安全模式运行中')
    expect(markup).toContain('安全模式仅用于临时恢复和排查')
    expect(markup).toContain('退出安全模式并正常启动')
    expect(markup).toContain('打开恢复选项')
  })
})
