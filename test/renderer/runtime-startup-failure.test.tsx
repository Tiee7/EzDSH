import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RuntimeStartupFailureNotice } from '../../src/renderer/app/RuntimeStartupFailureNotice'
import { SettingsPage } from '../../src/renderer/settings/SettingsPage'
import { getAppCopy } from '../../src/shared/locale'

const appStylesheet = readFileSync(new URL('../../src/renderer/app/app.css', import.meta.url), 'utf8')

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

  it('offers Safe Mode and a Runtime-independent recovery settings entry point', () => {
    const copy = getAppCopy('zh')
    const markup = renderToStaticMarkup(
      <RuntimeStartupFailureNotice
        copy={copy}
        message="plugin failed"
        logPath="/tmp/harness.log"
        onOpenLog={async () => {}}
        onEnterSafeMode={async () => {}}
        onOpenRecoverySettings={() => {}}
        initialExpanded
      />
    )

    expect(markup).toContain(copy.runtimeEnterSafeMode)
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
