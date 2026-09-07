import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCodesignArgs, buildVerifyArgs, collectCodePaths } from '../../scripts/macos-sign.mjs'

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-macos-sign-'))
  roots.push(root)
  return root
}

async function writeMachO(path: string) {
  await writeFile(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('macOS packaging signer', () => {
  it('uses the bounded signer for the unarchived application bundle', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))

    expect(packageJson.build.mac.sign).toBe('./scripts/macos-sign.mjs')
  })

  it('signs each discovered code object with the per-file options', () => {
    expect(buildCodesignArgs({
      app: '/tmp/EzDSH.app',
      identity: 'ABC123',
      keychain: '/tmp/build.keychain-db'
    }, {
      entitlements: '/tmp/entitlements.plist',
      hardenedRuntime: true,
      timestamp: 'none'
    }, '/tmp/EzDSH.app/Contents/MacOS/EzDSH')).toEqual([
      '--sign',
      'ABC123',
      '--force',
      '--keychain',
      '/tmp/build.keychain-db',
      '--timestamp=none',
      '--options',
      'runtime',
      '--entitlements',
      '/tmp/entitlements.plist',
      '/tmp/EzDSH.app/Contents/MacOS/EzDSH'
    ])
  })

  it('walks real files once, avoids symlink cycles, and orders containers after children', async () => {
    const root = await tempRoot()
    const app = join(root, 'EzDSH.app')
    const framework = join(app, 'Contents', 'Frameworks', 'Sample.framework')
    const frameworkBinary = join(framework, 'Versions', 'A', 'Sample')
    const helperApp = join(app, 'Contents', 'Frameworks', 'EzDSH Helper.app')
    const helperBinary = join(helperApp, 'Contents', 'MacOS', 'EzDSH Helper')

    await mkdir(join(framework, 'Versions', 'A'), { recursive: true })
    await mkdir(join(helperApp, 'Contents', 'MacOS'), { recursive: true })
    await writeMachO(frameworkBinary)
    await writeMachO(helperBinary)
    await symlink('Versions/A/Sample', join(framework, 'Sample'))

    const paths = await collectCodePaths(app)

    expect(paths).toContain(frameworkBinary)
    expect(paths).toContain(helperBinary)
    expect(paths).toContain(framework)
    expect(paths).toContain(helperApp)
    expect(paths.at(-1)).toBe(app)
    expect(paths.indexOf(frameworkBinary)).toBeLessThan(paths.indexOf(framework))
    expect(paths.indexOf(helperBinary)).toBeLessThan(paths.indexOf(helperApp))
    expect(paths).not.toContain(join(framework, 'Sample'))
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
    expect(buildVerifyArgs({ app: '/tmp/EzDSH.app', strictVerify: 'resource-rules' })).toEqual([
      '--verify',
      '--deep',
      '--strict=resource-rules',
      '/tmp/EzDSH.app'
    ])
  })
})
