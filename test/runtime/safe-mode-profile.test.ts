import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SafeModeProfileController } from '../../src/main/runtime/safe-mode-profile'
import { getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SafeModeProfileController', () => {
  it('keeps the normal DSH home and web profile while creating a core-only profile without skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-profile-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const webProfile = join(layout.harness, 'profiles', 'web', 'package.json')
    await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
    await mkdir(join(layout.harness, '.agent-presets', 'custom-agent'), { recursive: true })
    await writeFile(webProfile, '{"dependencies":{"third-party":"1.0.0"}}\n')
    await writeFile(join(layout.harness, 'settings.yaml'), 'agent-presets:\n  default: custom-agent\n')
    const controller = new SafeModeProfileController({ layout })

    const enabled = await controller.enable()

    expect(enabled.dshHome).toBe(layout.harness)
    expect(enabled.profile).toBe('ezdsh-safe')
    expect(enabled.presetIds).toContain('custom-agent')
    await expect(readFile(webProfile, 'utf8')).resolves.toBe('{"dependencies":{"third-party":"1.0.0"}}\n')

    const manifest = JSON.parse(await readFile(join(layout.harness, 'profiles', enabled.profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies).toEqual({})
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

    const composition = await readFile(join(layout.state, 'safe-mode-profile', 'presets', 'custom-agent', 'agent.cordis.yml'), 'utf8')
    expect(composition).toContain("name: '@deepseek-ai/dsh-tool-fs'")
    expect(composition).not.toContain('dsh-skill-filesystem')
    expect(composition).not.toContain('dsh-tool-skill')
    expect(composition).not.toContain('dsh-agent-instructions')
  })

  it('removes only its owned generated profile when disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-profile-disable-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const webProfile = join(layout.harness, 'profiles', 'web', 'package.json')
    await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
    await writeFile(webProfile, '{"name":"normal-web"}\n')
    const controller = new SafeModeProfileController({ layout })
    const enabled = await controller.enable()

    await controller.disable()

    await expect(stat(join(layout.harness, 'profiles', enabled.profile))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(layout.state, 'safe-mode-profile'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(webProfile, 'utf8')).resolves.toBe('{"name":"normal-web"}\n')
  })

  it('refuses to overwrite a profile it does not own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-profile-foreign-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const profile = join(layout.harness, 'profiles', 'ezdsh-safe')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), '{"name":"user-profile"}\n')
    const controller = new SafeModeProfileController({ layout })

    await expect(controller.enable()).rejects.toThrow(/not owned by EzDSH/i)
    await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toBe('{"name":"user-profile"}\n')
  })

  it('is accepted by the bundled DSH profile composer without loading a normal-profile plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-profile-compose-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
    await writeFile(join(layout.harness, 'profiles', 'web', 'package.json'), '{"dependencies":{"normal-only-plugin":"1.0.0"}}\n')
    const controller = new SafeModeProfileController({ layout })
    const enabled = await controller.enable()
    const runtimeEntry = fileURLToPath(new URL('../../vendor/deepseek-harness/apps/cli/lib/bin.js', import.meta.url))

    const { stdout, stderr } = await execFileAsync(process.execPath, [runtimeEntry, '--profile', enabled.profile, '--dump-config'], {
      env: { ...process.env, DSH_HOME: layout.harness },
      maxBuffer: 10 * 1024 * 1024,
    })

    expect(stderr).toBe('')
    expect(stdout).toContain('agent-presets')
    expect(stdout).not.toContain('normal-only-plugin')
    expect(stdout).toMatch(/name: '@deepseek-ai\/dsh-skill-filesystem'\n  disabled: true/u)
    expect(stdout).toMatch(/name: '@deepseek-ai\/dsh-tool-skill'\n  disabled: true/u)
    expect(stdout).toMatch(/name: '@deepseek-ai\/dsh-agent-instructions'[\s\S]*?disabled: true/u)
  }, 20_000)
})
