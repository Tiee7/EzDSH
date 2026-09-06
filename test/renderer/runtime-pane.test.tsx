import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RuntimePane, toRuntimeViewBounds } from '../../src/renderer/app/RuntimePane'

const appStylesheet = readFileSync(new URL('../../src/renderer/app/app.css', import.meta.url), 'utf8')

describe('RuntimePane', () => {
  it('reserves a native Runtime surface without embedding DSH in an iframe', () => {
    const markup = renderToStaticMarkup(
      <RuntimePane
        url="http://127.0.0.1:4567/?token=runtime-token"
        active
      />,
    )

    expect(markup).toContain('data-runtime-view-host="true"')
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('runtime-token')
  })

  it('rounds visible DOM bounds for Electron and rejects collapsed hosts', () => {
    expect(toRuntimeViewBounds({ x: 248.4, y: 44.2, width: 1031.6, height: 775.7 }))
      .toEqual({ x: 248, y: 44, width: 1032, height: 776 })
    expect(toRuntimeViewBounds({ x: 0, y: 0, width: 0, height: 600 })).toBeUndefined()
  })

  it('keeps the native Runtime host outside the window drag region so Runtime controls receive clicks', () => {
    const hostStyles = appStylesheet.match(/\.runtime-view-host \{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(hostStyles).toContain('-webkit-app-region: no-drag;')
  })
})
