import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot } from '../../src/main/runtime/runtime-types'
import { isRecoveryModeActive, SafeModeCornerOverlay } from '../../src/renderer/app/SafeModeOverlay'
import { SafeModeSettingsBanner } from '../../src/renderer/settings/SafeModeSettingsBanner'
import { getAppCopy } from '../../src/shared/locale'

describe('Safe Mode UI', () => {
  it('renders four non-interactive Safe Mode corner labels', () => {
    const markup = renderToStaticMarkup(<SafeModeCornerOverlay label="安全模式" />)

    expect(markup.match(/安全模式/g)).toHaveLength(4)
    expect(markup).toContain('style="pointer-events:none"')
  })

  it('explains that Safe Mode keeps the workspace while disabling extensions and skills', () => {
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
    expect(markup).toContain('保留当前工作文件夹、会话、设置和凭据')
    expect(markup).toContain('停用所有第三方插件、Skills 和自定义 Agent 模式')
    expect(markup).toContain('退出安全模式并正常启动')
    expect(markup).toContain('打开恢复选项')
  })

  it('renames the old isolated-home mode to Isolation Mode', () => {
    const runtime: RuntimeSnapshot = {
      phase: 'ready',
      mode: 'isolation',
      url: 'http://127.0.0.1:4567/?token=isolation-mode-token',
      launchDirectory: '/tmp',
      logPath: '/tmp/harness.log',
    }
    const copy = getAppCopy('zh')
    const markup = renderToStaticMarkup(
      <SafeModeSettingsBanner copy={copy} runtime={runtime} onExit={async () => {}} />,
    )

    expect(markup).toContain('隔离模式运行中')
    expect(markup).toContain('独立的临时 DSH_HOME')
    expect(markup).toContain('退出隔离模式并正常启动')
    expect(copy.isolationModeBadge).toBe('隔离模式')
    expect(isRecoveryModeActive(runtime)).toBe(true)
  })
})
