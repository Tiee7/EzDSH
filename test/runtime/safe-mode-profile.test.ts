import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SafeModeProfileController } from '../../src/main/runtime/safe-mode-profile'
import { getUserDataLayout } from '../../src/main/state/user-data'

const faults = vi.hoisted(() => ({ failCompositionWrite: false, failProfileInstall: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (faults.failCompositionWrite && String(args[0]).includes('agent.cordis.yml')) {
        faults.failCompositionWrite = false
        throw Object.assign(new Error('simulated full disk during composition write'), { code: 'ENOSPC' })
      }
      return fs.writeFile(...args)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (faults.failProfileInstall && (String(args[1]) === faults.failProfileInstall
        || String(args[1]) === `${faults.failProfileInstall}/package.json`)) {
        faults.failProfileInstall = ''
        throw Object.assign(new Error('simulated failure installing the final profile'), { code: 'EACCES' })
      }
      return fs.rename(...args)
    },
  }
})

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  faults.failCompositionWrite = false
  faults.failProfileInstall = ''
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SafeModeProfileController', () => {
  it('does not select Safe Mode when no choice has been saved', async () => {
    const { layout } = await createSharedDataFixture()

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toBeUndefined()
  })

  it('restores the saved choice across controllers and rebuilds only the generated Safe Mode profile', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    const first = new SafeModeProfileController({ layout })
    const enabled = await first.enable()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    const selection = await readFile(selectionPath, 'utf8')
    const compositionPath = join(layout.state, 'safe-mode-profile', 'presets', 'standard', 'agent.cordis.yml')
    await writeFile(compositionPath, 'name: third-party-plugin\n')

    const restored = await new SafeModeProfileController({ layout }).restoreIfEnabled()

    expect(restored).toEqual(enabled)
    await expect(readFile(compositionPath, 'utf8')).resolves.not.toContain('third-party-plugin')
    await expect(readFile(selectionPath, 'utf8')).resolves.toBe(selection)
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('forgets the saved choice only after disabling while preserving shared user data', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await new SafeModeProfileController({ layout }).enable()

    await new SafeModeProfileController({ layout }).disable()

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toBeUndefined()
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it.each([
    ['invalid JSON', '{'],
    ['unsupported version', '{"version":2,"mode":"safe"}'],
    ['invalid mode', '{"version":1,"mode":"normal"}'],
    ['missing version', '{"mode":"safe"}'],
    ['non-object choice', 'null'],
  ])('fails closed on a saved choice with %s', async (_description, content) => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    await writeFile(selectionPath, content)

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).rejects.toThrow(/safe mode selection/i)

    await expect(readFile(selectionPath, 'utf8')).resolves.toBe(content)
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('fails closed when the saved choice cannot be read', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await mkdir(join(layout.state, 'safe-mode-selection.json'))

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).rejects.toMatchObject({ code: 'EISDIR' })
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('does not treat a dangling selection symlink as an absent choice', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await symlink(join(layout.state, 'missing-selection.json'), join(layout.state, 'safe-mode-selection.json'))

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).rejects.toMatchObject({ code: 'ENOENT' })
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('rejects an unsuccessful selection write without leaving temporary selection files', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    await mkdir(selectionPath)
    await writeFile(join(selectionPath, 'keep.txt'), 'existing content')

    await expect(new SafeModeProfileController({ layout }).enable()).rejects.toThrow()

    expect((await readdir(layout.state)).filter((name) => name.startsWith('.safe-mode-selection.json.tmp-'))).toEqual([])
    await expect(readFile(join(selectionPath, 'keep.txt'), 'utf8')).resolves.toBe('existing content')
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('keeps the previous saved choice and shared files when rebuilding fails, then allows retry', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await new SafeModeProfileController({ layout }).enable()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    const selection = await readFile(selectionPath, 'utf8')
    await writeFile(join(layout.harness, '.agent-presets'), 'not a directory')

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).rejects.toMatchObject({ code: 'ENOTDIR' })

    await expect(readFile(selectionPath, 'utf8')).resolves.toBe(selection)
    await expectSharedFilesUnchanged(sharedFiles)
    await rm(join(layout.harness, '.agent-presets'))
    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toMatchObject({ profile: 'ezdsh-safe' })
  })

  it.each(['composition write', 'profile install'])('preserves an owned profile and allows cold retry after a failed %s', async (stage) => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await new SafeModeProfileController({ layout }).enable()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    const selection = await readFile(selectionPath, 'utf8')
    const profilePath = join(layout.harness, 'profiles', 'ezdsh-safe')
    const manifest = await readFile(join(profilePath, 'package.json'), 'utf8')
    const compositionPath = join(layout.state, 'safe-mode-profile', 'presets', 'standard', 'agent.cordis.yml')
    const composition = await readFile(compositionPath, 'utf8')
    if (stage === 'composition write') faults.failCompositionWrite = true
    else faults.failProfileInstall = profilePath

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).rejects.toThrow(/simulated/)

    await expect(readFile(selectionPath, 'utf8')).resolves.toBe(selection)
    await expect(readFile(join(profilePath, 'package.json'), 'utf8')).resolves.toBe(manifest)
    await expect(readFile(compositionPath, 'utf8')).resolves.toBe(composition)
    await expectSharedFilesUnchanged(sharedFiles)
    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toMatchObject({ profile: 'ezdsh-safe' })
    expect((await readdir(join(layout.harness, 'profiles'))).sort()).toEqual(['ezdsh-safe', 'web'])
    expect((await readdir(layout.state)).sort()).toEqual(['safe-mode-profile', 'safe-mode-selection.json', 'unrelated-user-state.json'])
  })

  it('can retry the first enable after generation fails without publishing an incomplete profile', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    faults.failCompositionWrite = true

    await expect(new SafeModeProfileController({ layout }).enable()).rejects.toMatchObject({ code: 'ENOSPC' })

    await expect(stat(join(layout.harness, 'profiles', 'ezdsh-safe'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toBeUndefined()
    await expect(new SafeModeProfileController({ layout }).enable()).resolves.toMatchObject({ profile: 'ezdsh-safe' })
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('migrates the legacy generated root identified by its owned profile', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await new SafeModeProfileController({ layout }).enable()
    const ownerPath = join(layout.state, 'safe-mode-profile', 'owner.json')
    await rm(ownerPath)

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toMatchObject({ profile: 'ezdsh-safe' })

    await expect(readFile(ownerPath, 'utf8')).resolves.toContain('ezdsh-safe-mode-profile-v1')
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('does not overwrite a foreign profile during cold restoration or disabling', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    await new SafeModeProfileController({ layout }).enable()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    const selection = await readFile(selectionPath, 'utf8')
    const profileManifest = join(layout.harness, 'profiles', 'ezdsh-safe', 'package.json')
    const foreignManifest = '{"name":"user-replaced-profile"}\n'
    await writeFile(profileManifest, foreignManifest)

    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).rejects.toThrow(/not owned by EzDSH/i)
    await expect(readFile(selectionPath, 'utf8')).resolves.toBe(selection)
    await new SafeModeProfileController({ layout }).disable()

    await expect(readFile(profileManifest, 'utf8')).resolves.toBe(foreignManifest)
    await expect(new SafeModeProfileController({ layout }).restoreIfEnabled()).resolves.toBeUndefined()
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('does not overwrite an unowned generated-resource directory', async () => {
    const { layout, sharedFiles } = await createSharedDataFixture()
    const foreignRoot = join(layout.state, 'safe-mode-profile')
    await mkdir(foreignRoot)
    await writeFile(join(foreignRoot, 'keep.txt'), 'unrelated content')

    await expect(new SafeModeProfileController({ layout }).enable()).rejects.toThrow(/not owned by EzDSH/i)
    await new SafeModeProfileController({ layout }).disable()

    await expect(readFile(join(foreignRoot, 'keep.txt'), 'utf8')).resolves.toBe('unrelated content')
    await expectSharedFilesUnchanged(sharedFiles)
  })

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

async function createSharedDataFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-safe-profile-persist-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
  await mkdir(join(layout.harness, 'sessions'), { recursive: true })
  await mkdir(layout.state, { recursive: true })
  const sharedFiles = new Map([
    [join(layout.harness, 'settings.yaml'), 'agent-presets:\n  default: standard\nmodels:\n  selected: saved-model\n'],
    [join(layout.harness, '.credentials.yaml'), 'provider:\n  token: fixture-token\n'],
    [join(layout.harness, 'sessions', 'existing.json'), '{"id":"existing-session"}\n'],
    [join(layout.harness, 'profiles', 'web', 'package.json'), '{"name":"normal-web","dependencies":{"third-party":"1.0.0"}}\n'],
    [join(layout.state, 'unrelated-user-state.json'), '{"value":"keep"}\n'],
  ])
  await Promise.all([...sharedFiles].map(([path, content]) => writeFile(path, content)))
  return { layout, sharedFiles }
}

async function expectSharedFilesUnchanged(sharedFiles: Map<string, string>): Promise<void> {
  for (const [path, content] of sharedFiles) {
    await expect(readFile(path, 'utf8')).resolves.toBe(content)
  }
}
