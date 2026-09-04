import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  PINNED_DSH_RUNTIME_VERSION,
  assertPinnedDshRuntimeVersion
} from '../../scripts/dsh-runtime-version.mjs'

describe('published DSH Runtime version', () => {
  it('uses the exact published pin', () => {
    expect(PINNED_DSH_RUNTIME_VERSION).toBe('0.1.2-rc.1')
  })

  it('declares every root direct DSH companion at the exact published pin', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    const dshDependencies = Object.entries(packageJson.dependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))

    expect(dshDependencies.length).toBeGreaterThan(0)
    expect(dshDependencies.every(([, spec]) => spec === '0.1.2-rc.1')).toBe(true)
  })

  it('rejects a version that differs from the pin with useful details', () => {
    expect(() => assertPinnedDshRuntimeVersion('fixture', '0.1.0-rc.8'))
      .toThrow(/fixture.*0\.1\.2-rc\.1.*0\.1\.0-rc\.8/)
  })

  it('accepts the pinned version', () => {
    expect(() => assertPinnedDshRuntimeVersion('fixture', '0.1.2-rc.1')).not.toThrow()
  })

  it('rejects a selected Runtime entry whose owning manifest is stale before Runtime startup', async () => {
    const bundleRoot = await mkdtemp(join(tmpdir(), 'ezdsh-stale-runtime-bundle-'))
    const runtimeEntry = join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeExecutable = join(
      bundleRoot,
      'node-runtime',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )
    const pnpmExecutable = join(
      bundleRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    )

    try {
      await mkdir(dirname(runtimeEntry), { recursive: true })
      await mkdir(dirname(nodeExecutable), { recursive: true })
      await mkdir(dirname(pnpmExecutable), { recursive: true })
      await writeFile(runtimeEntry, '// The version gate must run before this entry can start.\n')
      await writeFile(
        join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' })
      )
      await writeFile(nodeExecutable, '')
      await writeFile(pnpmExecutable, '')

      const verifier = resolve('scripts/verify-runtime-bundle.mjs')
      const result = spawnSync(process.execPath, [verifier, bundleRoot], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/selected DSH Runtime.*0\.1\.2-rc\.1.*0\.1\.0-rc\.8/)
    } finally {
      await rm(bundleRoot, { recursive: true, force: true })
    }
  })
})
