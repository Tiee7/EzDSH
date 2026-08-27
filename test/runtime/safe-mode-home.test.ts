import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SafeModeController } from '../../src/main/runtime/safe-mode-home'
import { getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SafeModeController', () => {
  it('creates a credential-only DSH home without profiles, patches, or sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-mode-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
    await mkdir(join(layout.harness, 'sessions'), { recursive: true })
    await mkdir(layout.state, { recursive: true })
    await writeFile(join(layout.harness, '.credentials.yaml'), 'providers: {}\n', { mode: 0o600 })
    await writeFile(join(layout.harness, 'cordis.patch.yml'), 'plugins: broken\n')
    await writeFile(join(layout.harness, 'profiles', 'web', 'package.json'), '{"dependencies":{"broken":"1.0.0"}}\n')
    await writeFile(join(layout.harness, 'sessions', 'broken.jsonl'), 'bad session\n')
    await writeFile(join(layout.state, 'installed.json'), JSON.stringify([
      { kind: 'skill', id: 'plugin-a', pluginPackageName: '@example/a' },
      { kind: 'skill', id: 'plugin-b', pluginPackageName: '@example/b' },
    ]))
    const controller = new SafeModeController({ layout })

    const enabled = await controller.enable('manual')

    await expect(readFile(join(enabled.dshHome, '.credentials.yaml'), 'utf8')).resolves.toBe('providers: {}\n')
    expect((await stat(join(enabled.dshHome, '.credentials.yaml'))).mode & 0o777).toBe(0o600)
    await expect(stat(join(enabled.dshHome, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(enabled.dshHome, 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(enabled.dshHome, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(enabled.status).toMatchObject({ active: true, reason: 'manual', excludedPluginCount: 2 })
    await expect(readFile(join(layout.harness, 'cordis.patch.yml'), 'utf8')).resolves.toBe('plugins: broken\n')
  })

  it('clears only its owned safe home when Safe Mode is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-mode-disable-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await mkdir(layout.harness, { recursive: true })
    await writeFile(join(layout.harness, '.credentials.yaml'), 'providers: {}\n')
    const controller = new SafeModeController({ layout })
    const enabled = await controller.enable('manual')

    const status = await controller.disable()

    expect(status).toEqual({ active: false, excludedPluginCount: 0 })
    await expect(stat(enabled.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(layout.harness, '.credentials.yaml'), 'utf8')).resolves.toBe('providers: {}\n')
  })
})
