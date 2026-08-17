import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply } from '../../../plugins/mode-menu-plus/src/index.js'

describe('mode-menu-plus node half', () => {
  it('exports an apply so the host Loader can adopt the plugin', () => {
    expect(typeof apply).toBe('function')
  })

  it('declares a browser client entry and the dsh.client manifest', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../plugins/mode-menu-plus/package.json', import.meta.url), 'utf8'))
    expect(pkg.name).toBe('mode-menu-plus')
    expect(pkg.type).toBe('module')
    expect(pkg.exports['./client'].default).toBe('./src/client.js')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
    ])
  })
})
