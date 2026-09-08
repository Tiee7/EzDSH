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

  it('reuses the exact build exception recorded by catalog verification', async () => {
    const profile = await makeProfile()
    const ignoredBuild = 'nihaixia@https://codeload.github.com/jangviktor-web/nihaixia/tar.gz/v2.3.1'
    const calls: string[][] = []
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        calls.push([...args])
        if (calls.length === 1) throw new Error(`Ignored build scripts: ${ignoredBuild}`)
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: { nihaixia: 'github:jangviktor-web/nihaixia#v2.3.1' }
        }))
      }
    })

    await installer.install(pluginEntry({
      plugin: {
        source: 'github:jangviktor-web/nihaixia#v2.3.1',
        packageName: 'nihaixia',
        verification: {
          status: 'passed',
          checkedAt: '2026-09-05T00:00:00.000Z',
          source: 'github:jangviktor-web/nihaixia#v2.3.1',
          dshVersion: '0.1.2-rc.1',
          pnpmVersion: '11.7.0',
          packageName: 'nihaixia',
          allowBuilds: [ignoredBuild]
        }
      }
    }))

    expect(calls).toEqual([
      ['add', 'github:jangviktor-web/nihaixia#v2.3.1'],
      ['add', `--allow-build=${ignoredBuild}`, 'github:jangviktor-web/nihaixia#v2.3.1']
    ])
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

  it('disables a plugin without uninstalling its package and can enable it again', async () => {
    const profile = await makeProfile()
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: { 'mode-menu-plus': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'mode-menu-plus'] } },
    }))
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => { throw new Error('Disabling must not call pnpm') },
    })
    const record: InstalledRecord = {
      kind: 'skill',
      id: 'mode-menu-plus',
      version: '1.0.0',
      sha256: '0'.repeat(64),
      installedAt: new Date().toISOString(),
      name: 'Mode Menu Plus',
      pluginPackageName: 'mode-menu-plus',
      pluginProfile: 'web',
    }

    await installer.setEnabled(record, undefined, false)
    let manifest = JSON.parse(await readFile(profile.packagePath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['mode-menu-plus']).toBe('1.0.0')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])

    await installer.setEnabled(record, undefined, true)
    manifest = JSON.parse(await readFile(profile.packagePath, 'utf8')) as typeof manifest
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'mode-menu-plus'])
  })

  it('isolates a plugin whose DSH peer range excludes the selected Runtime', async () => {
    const profile = await makeProfile()
    const runtimeEntryPath = join(profile.dshHome, 'runtime', 'lib', 'bin.js')
    await mkdir(join(profile.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
    await mkdir(join(profile.dshHome, 'runtime', 'lib'), { recursive: true })
    await writeFile(runtimeEntryPath, '')
    await writeFile(join(profile.dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-llm',
      version: '0.1.3-alpha.2',
      exports: { './package.json': './package.json', '.': './lib/index.js' },
    }))
    const pluginDirectory = join(profile.dshHome, 'profiles', 'web', 'node_modules', 'dsh-agy-provider')
    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(join(pluginDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-agy-provider',
      version: '0.10.0',
      peerDependencies: {
        '@deepseek-ai/dsh-llm': '^0.1.0-rc.7 || ^0.1.0-rc.8',
      },
    }))
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: { 'dsh-agy-provider': '0.10.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-agy-provider'] } },
    }))
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => { throw new Error('Compatibility isolation must not call pnpm') },
    })

    await expect(installer.repairIncompatiblePlugins('web', runtimeEntryPath)).resolves.toEqual([{
      packageName: 'dsh-agy-provider',
      reason: expect.stringContaining('@deepseek-ai/dsh-llm'),
    }])
    const manifest = JSON.parse(await readFile(profile.packagePath, 'utf8')) as {
      dsh: { profile: { bundles: string[]; disabledBundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(manifest.dsh.profile.disabledBundles).toEqual(['dsh-agy-provider'])
    await expect(readFile(join(pluginDirectory, 'package.json'), 'utf8')).resolves.toContain('0.10.0')
  })

  it('lists active third-party profile bundles for startup recovery choices', async () => {
    const profile = await makeProfile()
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: { 'mode-menu-plus': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'mode-menu-plus'] } },
    }))
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => undefined,
    })

    await expect(installer.listActivePlugins()).resolves.toEqual([
      { packageName: 'mode-menu-plus', profile: 'web' },
    ])
  })

  it('lists installed third-party profile packages with their disabled state', async () => {
    const profile = await makeProfile()
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: {
        'dsh-codex': 'github:ddll8023/dsh-codex',
        'dsh-skill-hub': 'github:hskelp9527-pixel/dsh-skill-hub',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], disabledBundles: ['dsh-codex'] } },
    }))
    await mkdir(join(profile.dshHome, 'profiles', 'web', 'node_modules', 'dsh-codex'), { recursive: true })
    await writeFile(join(profile.dshHome, 'profiles', 'web', 'node_modules', 'dsh-codex', 'package.json'), JSON.stringify({ name: 'dsh-codex', version: '0.1.0', dsh: { bundle: {} } }))
    await mkdir(join(profile.dshHome, 'profiles', 'web', 'node_modules', 'dsh-skill-hub'), { recursive: true })
    await writeFile(join(profile.dshHome, 'profiles', 'web', 'node_modules', 'dsh-skill-hub', 'package.json'), JSON.stringify({ name: 'dsh-skill-hub', version: '1.1.0', dsh: { bundle: {} } }))

    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => undefined,
    })

    await expect(installer.listInstalledPlugins()).resolves.toEqual([
      { packageName: 'dsh-codex', profile: 'web', version: '0.1.0', enabled: false },
      { packageName: 'dsh-skill-hub', profile: 'web', version: '1.1.0', enabled: true },
    ])
  })

  it('toggles a plugin that is referenced directly by the profile patch', async () => {
    const profile = await makeProfile()
    const packageDirectory = join(profile.dshHome, 'profiles', 'node_modules', 'mode-menu-plus')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'mode-menu-plus',
      version: '0.1.1',
      dsh: { client: { platform: 'web' } },
    }))
    await writeFile(join(profile.dshHome, 'profiles', 'web', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: mode-menu-plus',
      '      name: mode-menu-plus',
      '',
    ].join('\n'))

    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async () => { throw new Error('Patch toggles must not call pnpm') },
    })

    await installer.setPackageEnabled('web', 'mode-menu-plus', false)
    expect(await readFile(join(profile.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
    await installer.setPackageEnabled('web', 'mode-menu-plus', true)
    expect(await readFile(join(profile.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).not.toContain('disabled: true')
  })

  it('keeps a disabled plugin out of the layer list after another plugin command reconciles bundles', async () => {
    const profile = await makeProfile()
    await writeFile(profile.packagePath, JSON.stringify({
      name: 'web',
      dependencies: { 'mode-menu-plus': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'mode-menu-plus'] } },
    }))
    const installer = new DshPluginInstaller({
      dshHome: profile.dshHome,
      runCommand: async (_profile, args) => {
        if (args[0] !== 'add') throw new Error('unexpected command')
        await writeFile(profile.packagePath, JSON.stringify({
          name: 'web',
          dependencies: {
            'mode-menu-plus': '1.0.0',
            '@nanmicoder/dsh-agent-teams': '0.1.13',
          },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'mode-menu-plus', '@nanmicoder/dsh-agent-teams'], disabledBundles: ['mode-menu-plus'] } },
        }))
      },
    })
    const record: InstalledRecord = {
      kind: 'skill',
      id: 'mode-menu-plus',
      version: '1.0.0',
      sha256: '0'.repeat(64),
      installedAt: new Date().toISOString(),
      name: 'Mode Menu Plus',
      pluginPackageName: 'mode-menu-plus',
      pluginProfile: 'web',
    }
    await installer.setEnabled(record, undefined, false)

    await installer.install(pluginEntry())
    const manifest = JSON.parse(await readFile(profile.packagePath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@nanmicoder/dsh-agent-teams'])
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
