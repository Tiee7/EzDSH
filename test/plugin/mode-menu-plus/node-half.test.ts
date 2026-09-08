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
    ])
    expect(pkg.peerDependencies['@deepseek-ai/dsh-client-store']).toBe('^0.1.3-alpha.2')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-client-runtime']).toBeUndefined()
  })

  it('uses the alpha2 store module-table seed instead of the removed runtime package', () => {
    const source = readFileSync(new URL('../../../plugins/mode-menu-plus/src/client.js', import.meta.url), 'utf8')
    expect(source).toContain("@deepseek-ai/dsh-client-store")
    expect(source).not.toContain("@deepseek-ai/dsh-client-runtime/client")
  })
})
