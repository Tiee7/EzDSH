import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCodesignArgs, buildVerifyArgs } from '../../scripts/macos-sign.mjs'

describe('macOS packaging signer', () => {
  it('uses the bounded signer for the unarchived application bundle', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))

    expect(packageJson.build.mac.sign).toBe('./scripts/macos-sign.mjs')
  })

  it('uses deep signing without asking osx-sign to enumerate the application tree', () => {
    expect(buildCodesignArgs({
      app: '/tmp/EzDSH.app',
      identity: 'ABC123',
      keychain: '/tmp/build.keychain-db'
    }, {
      entitlements: '/tmp/entitlements.plist',
      hardenedRuntime: true,
      timestamp: 'none'
    })).toEqual([
      '--deep',
      '--force',
      '--timestamp=none',
      '--options',
      'runtime',
      '--keychain',
      '/tmp/build.keychain-db',
      '--entitlements',
      '/tmp/entitlements.plist',
      '--sign',
      'ABC123',
      '/tmp/EzDSH.app'
    ])
  })

  it('keeps strict verification enabled by default', () => {
    expect(buildVerifyArgs({ app: '/tmp/EzDSH.app' })).toEqual([
      '--verify',
      '--deep',
      '--strict',
      '/tmp/EzDSH.app'
    ])
    expect(buildVerifyArgs({ app: '/tmp/EzDSH.app', strictVerify: false })).toEqual([
      '--verify',
      '--deep',
      '/tmp/EzDSH.app'
    ])
  })
})
