import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { probeWebPaneUrl, WEB_PANE_MAX_AUTO_RETRIES, webPaneRetryDelay, WebPane } from '../../src/renderer/app/WebPane'

describe('WebPane startup state', () => {
  it('shows a startup message before loading a custom page', () => {
    const markup = renderToStaticMarkup(
      <WebPane item={{ kind: 'custom', id: 'workbench', label: 'Workbench', url: 'http://127.0.0.1:3456' }} active />,
    )

    expect(markup).toContain('正在启动')
    expect(markup).toContain('无需手动刷新')
    expect(markup).toContain('自动检查最多 3 次')
    expect(markup).not.toContain('<iframe')
  })

  it('treats a connection failure as unavailable and accepts opaque local responses', async () => {
    const unavailable = await probeWebPaneUrl('http://127.0.0.1:3456', async () => {
      throw new TypeError('fetch failed')
    })
    const available = await probeWebPaneUrl('http://127.0.0.1:3456', async () => ({
      ok: false,
      type: 'opaque',
    }) as Response)

    expect(unavailable).toBe(false)
    expect(available).toBe(true)
  })

  it('limits automatic retries and backs off between attempts', () => {
    expect(WEB_PANE_MAX_AUTO_RETRIES).toBe(3)
    expect(webPaneRetryDelay(1)).toBe(1_000)
    expect(webPaneRetryDelay(2)).toBe(3_000)
    expect(webPaneRetryDelay(3)).toBe(3_000)
    expect(webPaneRetryDelay(99)).toBe(3_000)
  })
})
