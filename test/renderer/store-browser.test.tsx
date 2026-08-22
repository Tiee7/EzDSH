import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'
import { AuditOverrideActions, StoreBrowser } from '../../src/renderer/store/StoreBrowser'

describe('StoreBrowser refresh control', () => {
  it('does not submit the surrounding search form', () => {
    const markup = renderToStaticMarkup(
      <StoreBrowser kind="preset" copy={getAppCopy('zh')} locale="zh" />
    )

    expect(markup).toMatch(/<button type="button" class="store-refresh"/)
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
