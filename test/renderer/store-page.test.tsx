import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'
import { StorePage } from '../../src/renderer/store/StorePage'

describe('StorePage surfaces', () => {
  it('places Plugins between Skills and MCP tool extensions', () => {
    const markup = renderToStaticMarkup(<StorePage copy={getAppCopy('zh')} locale="zh" />)
    const skills = markup.indexOf('>技能<')
    const plugins = markup.indexOf('>插件<')
    const mcp = markup.indexOf('>工具扩展（MCP）<')

    expect(skills).toBeGreaterThanOrEqual(0)
    expect(plugins).toBeGreaterThan(skills)
    expect(mcp).toBeGreaterThan(plugins)
  })
})
