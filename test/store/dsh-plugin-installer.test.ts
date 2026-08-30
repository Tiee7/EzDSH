import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshPluginInstaller } from '../../src/main/store/dsh-plugin-installer'
import type { InstalledRecord, StoreEntry } from '../../src/shared/store'

const workdirs: string[] = []

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function pluginEntry(overrides: Partial<StoreEntry> = {}): StoreEntry {
  return {
    id: 'agent-teams',
    kind: 'skill',
    name: 'Agent Teams',
    description: 'Agent Teams',
    category: 'plugin',
    auditLevel: 'basic',
    version: '0.1.13',
    plugin: {
      source: 'npm:@nanmicoder/dsh-agent-teams@0.1.13',
      profile: 'web'
    },
    ...overrides
  }
}

async function makeProfile(): Promise<{ dshHome: string; packagePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-plugin-'))
  workdirs.push(root)
  const dshHome = join(root, 'harness')
  const packagePath = join(dshHome, 'profiles', 'web', 'package.json')
  await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
  await writeFile(packagePath, JSON.stringify({ name: 'web', dependencies: {} }))
  return { dshHome, packagePath }
}

describe('DshPluginInstaller', () => {
  it('validates the source, forwards add to the profile, and records the installed package', async () => {
    const profile = await makeProfile()
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calls.push([...args])
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.13' }
        }))
      }
    })

    const result = await installer.install(pluginEntry())

    expect(calls).toEqual([['add', 'npm:@nanmicoder/dsh-agent-teams@0.1.13']])
    expect(result.packageName).toBe('@nanmicoder/dsh-agent-teams')
  })

  it('reports that an active Runtime needs a user-approved reload after install', async () => {
    const profile = await makeProfile()
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => {
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.13' }
        }))
      },
      isRuntimeActive: () => true
    })

    const result = await installer.install(pluginEntry())

    expect(result.runtimeRestartRequired).toBe(true)
  })

  it('retries with exact allow-build entries for ignored builds of existing dependencies', async () => {
    const profile = await makeProfile()
    const ignoredBuild = 'dsh-skill-hub@https://codeload.github.com/hskelp9527-pixel/dsh-skill-hub/tar.gz/c9805c50f7d70008bb8f2995b6be733c7f3b1571'
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: { 'dsh-skill-hub': 'github:hskelp9527-pixel/dsh-skill-hub#main' }
    }))
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calls.push([...args])
        if (calls.length === 1) {
          throw new Error(`DSH plugin command failed (code=1, signal=null): [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ${ignoredBuild}`)
        }
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: {
            'dsh-skill-hub': 'github:hskelp9527-pixel/dsh-skill-hub#main',
            '@nanmicoder/dsh-agent-teams': '0.1.13'
          }
        }))
      }
    })

    const result = await installer.install(pluginEntry())

    expect(calls).toEqual([
      ['add', 'npm:@nanmicoder/dsh-agent-teams@0.1.13'],
      [`add`, `--allow-build=${ignoredBuild}`, 'npm:@nanmicoder/dsh-agent-teams@0.1.13']
    ])
    expect(result.packageName).toBe('@nanmicoder/dsh-agent-teams')
  })

  it('automatically retries known DSH dependency build scripts for one-click installs', async () => {
    const profile = await makeProfile()
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calls.push([...args])
        if (calls.length === 1) {
          throw new Error(
            'DSH plugin command failed (code=1, signal=null): [ERR_PNPM_IGNORED_BUILDS] ' +
            'Ignored build scripts: @google/genai@1.52.0, protobufjs@7.6.5'
          )
        }
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.13' }
        }))
      }
    })

    const result = await installer.install(pluginEntry())

    expect(calls).toEqual([
      ['add', 'npm:@nanmicoder/dsh-agent-teams@0.1.13'],
      [
        'add',
        '--allow-build=@google/genai@1.52.0',
        '--allow-build=protobufjs@7.6.5',
        'npm:@nanmicoder/dsh-agent-teams@0.1.13'
      ]
    ])
    expect(result.packageName).toBe('@nanmicoder/dsh-agent-teams')
  })

  it('does not auto-approve build scripts for a newly introduced dependency', async () => {
    const profile = await makeProfile()
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calls.push([...args])
        throw new Error('Ignored build scripts: newly-installed-plugin@https://example.com/plugin.tgz')
      }
    })

    await expect(installer.install(pluginEntry())).rejects.toThrow(/Ignored build scripts/i)
    expect(calls).toEqual([['add', 'npm:@nanmicoder/dsh-agent-teams@0.1.13']])
  })

  it('does not auto-approve an unverified version of a known dependency', async () => {
    const profile = await makeProfile()
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calls.push([...args])
        throw new Error('Ignored build scripts: @google/genai@1.52.1')
      }
    })

    await expect(installer.install(pluginEntry())).rejects.toThrow(/Ignored build scripts/i)
    expect(calls).toEqual([['add', 'npm:@nanmicoder/dsh-agent-teams@0.1.13']])
  })

  it('runs the dependency preflight before scheduling a Runtime reload', async () => {
    const profile = await makeProfile()
    let commandCalled = false
    const runCommand = Object.assign(
      async () => { commandCalled = true },
      { assertAvailable: () => { throw new Error('Bundled pnpm is missing') } }
    )
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand,
      isRuntimeActive: () => { throw new Error('Runtime state must not be read after preflight failure') }
    })

    await expect(installer.install(pluginEntry())).rejects.toThrow(/pnpm/i)
    expect(commandCalled).toBe(false)
  })

  it('removes the package recorded in the install registry', async () => {
    const profile = await makeProfile()
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => { calls.push([...args]) }
    })
    const record: InstalledRecord = {
      kind: 'skill',
      id: 'agent-teams',
      version: '0.1.13',
      sha256: '0'.repeat(64),
      installedAt: new Date().toISOString(),
      name: 'Agent Teams',
      pluginPackageName: '@nanmicoder/dsh-agent-teams'
    }

    await installer.uninstall(record, pluginEntry())

    expect(calls).toEqual([['remove', '@nanmicoder/dsh-agent-teams']])
  })

  it('rejects untrusted plugin sources before invoking the package manager', async () => {
    const profile = await makeProfile()
    let called = false
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => { called = true }
    })

    await expect(installer.install(pluginEntry({ plugin: { source: 'npm:../escape' } }))).rejects.toThrow(/source/i)
    expect(called).toBe(false)
  })

  it('supports a GitHub source when the catalog declares its package name', async () => {
    const profile = await makeProfile()
    let calledArgs: readonly string[] | undefined
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calledArgs = args
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { '@nanmicoder/dsh-agent-teams': 'github:owner/repo#main' }
        }))
      }
    })

    const result = await installer.install(pluginEntry({
      plugin: {
        source: 'github:owner/repo#main',
        packageName: '@nanmicoder/dsh-agent-teams'
      }
    }))

    expect(calledArgs).toEqual(['add', 'github:owner/repo#main'])
    expect(result.packageName).toBe('@nanmicoder/dsh-agent-teams')
  })

  it('recovers a GitHub package name when a previous partial install already wrote the dependency', async () => {
    const profile = await makeProfile()
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: { 'dsh-codex': 'github:ddll8023/dsh-codex' }
    }))
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => {
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { 'dsh-codex': 'github:ddll8023/dsh-codex' }
        }))
      }
    })

    const result = await installer.install(pluginEntry({
      id: 'dsh-codex',
      name: 'DSH Codex',
      plugin: { source: 'github:ddll8023/dsh-codex' }
    }))

    expect(result.packageName).toBe('dsh-codex')
  })

  it('repairs the installed dsh-codex account status before Runtime reload', async () => {
    const profile = await makeProfile()
    const sourcePath = join(profile.dshHome, 'profiles', 'web', 'node_modules', 'dsh-codex', 'lib', 'index.js')
    await mkdir(join(sourcePath, '..'), { recursive: true })
    await writeFile(sourcePath, `
await registerSessionEventType();

  async function buildAccountStatusFast() {
    try {
      return {
        loggedIn: false,
        accountId: undefined,
      };
    } catch (e) {
      return {};
    }
  }

  // Account Remote
`)

    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, _args) => {
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { 'dsh-codex': 'github:ddll8023/dsh-codex' }
        }))
      }
    })

    await installer.install(pluginEntry({
      id: 'dsh-codex',
      name: 'DSH Codex',
      plugin: { source: 'github:ddll8023/dsh-codex' }
    }))

    expect(await readFile(sourcePath, 'utf8')).toContain('function omitUndefinedProperties(value)')
  })
})
