import { createHash } from 'node:crypto'
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data.js'
import { RecoveryManager } from '../../src/main/recovery/recovery-manager.js'

const temporaryRoots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createFixture(): Promise<ReturnType<typeof getUserDataLayout>> {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-'))
  temporaryRoots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
    await writeFile(join(layout.harness, 'settings.yaml'), 'locale:\n  preference: zh\n', { mode: 0o600 })
    await writeFile(join(layout.harness, '.credentials.yaml'), 'providers:\n  secret: do-not-archive\n', { mode: 0o600 })
    await writeFile(join(layout.workflowRoot, 'README.md'), '# Workflow files\n', { mode: 0o600 })
    await writeFile(join(layout.state, 'installed.json'), '[{"kind":"preset","id":"writing","version":"1.0.0"}]\n', { mode: 0o600 })
  return layout
}

function createManager(layout: ReturnType<typeof getUserDataLayout>, overrides: Partial<ConstructorParameters<typeof RecoveryManager>[0]> = {}): RecoveryManager {
  return new RecoveryManager({
    layout,
    appVersion: '1.8.1536',
    dshRuntimeVersion: '0.1.1-rc.2',
    dataSchemaVersion: 1,
    now: () => new Date('2026-08-27T01:02:03.004Z'),
    ...overrides,
  })
}

describe('RecoveryManager', () => {
  it('keeps only the plugin disabled from Recovery as an uninstall choice after retry fails', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    await manager.markRuntimeFailure('first failure', [
      { packageName: 'suspect-plugin', profile: 'web', name: 'Suspect Plugin', enabled: true },
      { packageName: 'other-plugin', profile: 'web', name: 'Other Plugin', enabled: true },
    ])

    await manager.markRuntimePluginDisabled('suspect-plugin', 'web')
    await manager.markRuntimeFailure('retry failure', [
      { packageName: 'other-plugin', profile: 'web', name: 'Other Plugin', enabled: true },
    ])

    expect(manager.snapshot().runtimeFailure?.plugins).toEqual([
      { packageName: 'suspect-plugin', profile: 'web', name: 'Suspect Plugin', enabled: false },
      { packageName: 'other-plugin', profile: 'web', name: 'Other Plugin', enabled: true },
    ])
  })

  it('creates a checksummed snapshot with an inventory and a local credential vault', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)

    const snapshot = await manager.createSnapshot({
      kind: 'manual',
      reason: 'user requested backup',
      pluginInventory: ['preset:writing@1.0.0'],
    })

    expect(snapshot.archiveName).toMatch(/^ezdsh-manual-.*\.tar\.gz$/)
    await access(snapshot.archivePath)
    await access(snapshot.checksumPath)
    await access(snapshot.manifestPath)

    const manifest = JSON.parse(await readFile(snapshot.manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      formatVersion: 1,
      kind: 'manual',
      reason: 'user requested backup',
      appVersion: '1.8.1536',
      dshRuntimeVersion: '0.1.1-rc.2',
      dataSchemaVersion: 1,
      pluginInventory: ['preset:writing@1.0.0'],
      redactedFiles: ['harness/.credentials.yaml'],
      components: ['harness', 'state', 'workflow'],
    })

    const archiveText = await readFile(snapshot.archivePath)
    expect(archiveText.includes(Buffer.from('do-not-archive'))).toBe(false)
    await expect(manager.restore(snapshot.archiveName, true)).resolves.toMatchObject({
      entries: expect.arrayContaining(['workflow/README.md']),
    })
    expect(await readFile(join(layout.backups, 'vault', snapshot.archiveName, 'harness/.credentials.yaml'), 'utf8'))
      .toContain('do-not-archive')
  })

  it('stores and edits a user-facing snapshot note without changing archive integrity', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)

    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'user requested backup', note: 'Before installing a risky plugin' })
    expect(snapshot.manifest.note).toBe('Before installing a risky plugin')
    const archiveChecksum = snapshot.manifest.sha256

    const updated = await manager.updateNote(snapshot.archiveName, 'After plugin installation')

    expect(updated.manifest.note).toBe('After plugin installation')
    expect(updated.manifest.sha256).toBe(archiveChecksum)
    await expect(manager.listSnapshots()).resolves.toEqual([expect.objectContaining({ manifest: expect.objectContaining({ note: 'After plugin installation' }) })])
    const cleared = await manager.updateNote(snapshot.archiveName, '   ')
    expect(cleared.manifest.note).toBeUndefined()
  })

  it('captures managed plugin compatibility evidence in a recovery snapshot', async () => {
    const layout = await createFixture()
    await writeFile(join(layout.state, 'installed.json'), JSON.stringify([{
      kind: 'skill',
      id: 'agent-teams',
      version: '0.1.13',
      pluginPackageName: '@nanmicoder/dsh-agent-teams',
      pluginSource: 'npm:@nanmicoder/dsh-agent-teams@0.1.13',
      pluginCompatibilityRequirements: { minDshVersion: '0.1.0' },
      pluginCompatibility: { status: 'compatible', runtimeVersion: '0.1.1-rc.2', reason: 'Declared DSH runtime range matches.' },
    }]))
    const manager = createManager(layout)

    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'compatibility evidence' })

    expect(snapshot.manifest.compatibilityInventory).toEqual([
      expect.objectContaining({
        entryId: 'agent-teams',
        packageName: '@nanmicoder/dsh-agent-teams',
        source: 'npm:@nanmicoder/dsh-agent-teams@0.1.13',
        assessment: { status: 'compatible', runtimeVersion: '0.1.1-rc.2', reason: 'Declared DSH runtime range matches.' },
      }),
    ])
  })

  it('restores a legacy snapshot without a workflow component', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const archiveName = 'ezdsh-manual-20260831010203004-legacy.tar.gz'
    const archivePath = join(layout.backups, archiveName)
    await execFileAsync('tar', ['-czf', archivePath, '-C', layout.root, 'harness', 'state'])
    const sha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex')
    await writeFile(`${archivePath}.sha256`, `${sha256}  ${archiveName}\n`, { mode: 0o600 })
    await writeFile(`${archivePath}.manifest.json`, `${JSON.stringify({
      formatVersion: 1,
      kind: 'manual',
      reason: 'legacy snapshot',
      createdAt: '2026-08-31T01:02:03.004Z',
      appVersion: '1.8.1535',
      dshRuntimeVersion: '0.1.1-rc.1',
      dataSchemaVersion: 1,
      archiveName,
      sha256,
      components: ['harness', 'state'],
      redactedFiles: [],
      pluginInventory: [],
    }, null, 2)}\n`, { mode: 0o600 })

    await writeFile(join(layout.state, 'installed.json'), 'broken\n', { mode: 0o600 })
    const restored = await manager.restore(archiveName, false)

    expect(restored.missingCredentials).toEqual([])
    expect(await readFile(join(layout.state, 'installed.json'), 'utf8')).toContain('writing')
    await expect(readFile(join(layout.workflowRoot, 'README.md'), 'utf8')).resolves.toContain('Workflow files')
  })

  it('detects archive tampering before restore', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'integrity test' })
    await writeFile(snapshot.archivePath, Buffer.from('tampered archive'))

    await expect(manager.verify(snapshot.archiveName)).resolves.toMatchObject({
      ok: false,
      snapshotName: snapshot.archiveName,
    })
    await expect(manager.restore(snapshot.archiveName, false)).rejects.toThrow('checksum')
  })

  it('dry-runs restore without modifying live data', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'dry run' })
    await writeFile(join(layout.harness, 'settings.yaml'), 'locale:\n  preference: en\n', { mode: 0o600 })

    const preview = await manager.restore(snapshot.archiveName, true)

    expect(preview.dryRun).toBe(true)
    expect(preview.entries).toContain('harness/settings.yaml')
    expect(preview.preRestoreSnapshotName).toBeUndefined()
    expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toContain('preference: en')
  })

  it('restores data atomically and reports credentials missing on a new machine', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'restore test' })
    await rm(join(layout.backups, 'vault', snapshot.archiveName), { recursive: true, force: true })
    await writeFile(join(layout.harness, 'settings.yaml'), 'broken: true\n', { mode: 0o600 })

    const restored = await manager.restore(snapshot.archiveName, false)

    expect(restored.dryRun).toBe(false)
    expect(restored.preRestoreSnapshotName).toMatch(/^ezdsh-pre-restore-/)
    expect(restored.missingCredentials).toEqual(['harness/.credentials.yaml'])
    expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toContain('preference: zh')
  })

  it('preserves a selected pre-restore snapshot while creating the restore safety snapshot', async () => {
    const layout = await createFixture()
    let now = new Date('2026-08-27T01:02:03.004Z')
    const manager = createManager(layout, { now: () => now })
    const snapshot = await manager.createSnapshot({ kind: 'pre-restore', reason: 'selected recovery point' })
    await writeFile(join(layout.harness, 'settings.yaml'), 'broken: true\n', { mode: 0o600 })
    now = new Date('2026-08-27T01:03:03.004Z')

    await expect(manager.restore(snapshot.archiveName, false)).resolves.toMatchObject({
      snapshotName: snapshot.archiveName,
    })
    await expect(access(snapshot.archivePath)).resolves.toBeUndefined()
    expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toContain('preference: zh')
  })

  it('restores a trusted absolute dependency symlink automatically', async () => {
    const layout = await createFixture()
    const trustedRoot = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-'))
    temporaryRoots.push(trustedRoot)
    const dependencyTarget = join(trustedRoot, 'node_modules', '@agentclientprotocol', 'sdk')
    const dependencyLink = join(layout.harness, 'profiles', 'node_modules', '@agentclientprotocol', 'sdk')
    await mkdir(dependencyTarget, { recursive: true })
    await writeFile(join(dependencyTarget, 'package.json'), '{"name":"@agentclientprotocol/sdk"}\n', { mode: 0o600 })
    await mkdir(join(dependencyLink, '..'), { recursive: true })
    await symlink(dependencyTarget, dependencyLink)
    const manager = createManager(layout, { trustedSymlinkRoots: [trustedRoot] })
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'trusted dependency link' })
    await rm(dependencyLink, { force: true })

    await expect(manager.restore(snapshot.archiveName, false)).resolves.toMatchObject({ snapshotName: snapshot.archiveName })
    await expect(lstat(dependencyLink)).resolves.toSatisfy((entry) => entry.isSymbolicLink())
  })

  describe.each(['desktop', 'rescue'] as const)('%s recovery of stale Runtime fallbacks', (channel) => {
    async function restore(manager: RecoveryManager, layout: ReturnType<typeof getUserDataLayout>, snapshotName: string): Promise<unknown> {
      if (channel === 'desktop') return manager.restore(snapshotName, false)
      return execFileAsync(process.execPath, [resolve('recovery/rescue.mjs'), 'restore', snapshotName, '--yes', '--root', layout.root])
    }

    it('restores user data after an application update removes a shared fallback dependency', async () => {
      const layout = await createFixture()
      const trustedRoot = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-old-runtime-'))
      temporaryRoots.push(trustedRoot)
      const removedPackages = [
        ...['dsh-tool-subagent-report', 'dsh-client-web', 'dsh-client-ui-primitives', 'dsh-client-schema-form',
          'dsh-client-web-react', 'dsh-client-runtime', 'dsh-host-apiproxy', 'dsh-client-ui-slots'].map((name) => ({
          name: `@deepseek-ai/${name}`, modules: 'node_modules',
        })),
        ...['node-addon-landlock-run', 'dsh-client-ui-sidebar-textpreview'].map((name) => ({
          name: `@deepseek-ai/${name}`, modules: 'out/dsh-runtime/node_modules',
        })),
        { name: 'micromark', modules: 'node_modules' },
        { name: 'typescript', modules: 'out/dsh-runtime/node_modules' },
        { name: '@types/removed-runtime-dependency', modules: 'node_modules' },
      ]
      for (const { name: packageName, modules } of removedPackages) {
        const target = join(trustedRoot, modules, packageName)
        const link = join(layout.harness, 'profiles', 'node_modules', packageName)
        await mkdir(target, { recursive: true })
        await mkdir(join(link, '..'), { recursive: true })
        await symlink(target, link)
      }
      const pluginPath = join(layout.harness, 'profiles', 'web', 'node_modules', 'my-plugin', 'package.json')
      await mkdir(join(pluginPath, '..'), { recursive: true })
      await writeFile(pluginPath, '{"name":"my-plugin","version":"1.0.0"}\n')
      const manager = createManager(layout, { trustedSymlinkRoots: [trustedRoot], rescueScriptPath: resolve('recovery/rescue.mjs') })
      const snapshot = await manager.createSnapshot({ kind: 'pre-plugin-change', reason: 'Runtime dependency removed after backup' })
      for (const { name, modules } of removedPackages) await rm(join(trustedRoot, modules, name), { recursive: true })
      await writeFile(join(layout.harness, 'settings.yaml'), 'broken: true\n')

      // A preview preserves live data and the original, now-stale fallback links.
      await manager.restore(snapshot.archiveName, true)
      for (const { name, modules } of removedPackages) {
        await expect(readlink(join(layout.harness, 'profiles', 'node_modules', name))).resolves.toBe(join(trustedRoot, modules, name))
      }
      await expect(restore(manager, layout, snapshot.archiveName)).resolves.toBeDefined()

      expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toContain('preference: zh')
      expect(await readFile(pluginPath, 'utf8')).toContain('my-plugin')
      for (const { name } of removedPackages) {
        await expect(lstat(join(layout.harness, 'profiles', 'node_modules', name))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await expect(manager.verify(snapshot.archiveName)).resolves.toMatchObject({ ok: true })
      const archived = await execFileAsync('tar', ['-tvzf', snapshot.archivePath])
      expect(archived.stdout).toContain('dsh-client-runtime')
    })

    it('recognizes a bundled Runtime when no application root was saved', async () => {
      const layout = await createFixture()
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-bundled-fallback-'))
      temporaryRoots.push(runtimeRoot)
      await mkdir(join(runtimeRoot, 'lib'), { recursive: true })
      await mkdir(join(runtimeRoot, 'node_modules'), { recursive: true })
      await writeFile(join(runtimeRoot, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.5"}\n')
      await writeFile(join(runtimeRoot, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
      const link = join(layout.harness, 'profiles', 'node_modules', 'removed-runtime-dependency')
      await mkdir(join(link, '..'), { recursive: true })
      await symlink(join(runtimeRoot, 'node_modules', 'removed-runtime-dependency'), link)
      const manager = createManager(layout)
      const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'bundled Runtime fallback without saved roots' })

      await expect(restore(manager, layout, snapshot.archiveName)).resolves.toBeDefined()

      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('drops shared fallback links from an older verified EzDSH installation across launch locations', async () => {
      const layout = await createFixture()
      const application = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-packaged-'))
      temporaryRoots.push(application)
      const oldApplication = join(application, 'EzDSH.app', 'Contents', 'Resources', 'app')
      await mkdir(join(oldApplication, 'out', 'main'), { recursive: true })
      await mkdir(join(oldApplication, 'node_modules', 'retained-package'), { recursive: true })
      await writeFile(join(oldApplication, 'package.json'), '{"name":"ezdsh","main":"./out/main/index.js"}\n')
      await writeFile(join(oldApplication, 'out', 'main', 'index.js'), '// packaged Electron main\n')
      for (const packageName of ['removed-package', 'retained-package']) {
        const link = join(layout.harness, 'profiles', 'node_modules', packageName)
        await mkdir(join(link, '..'), { recursive: true })
        await symlink(join(oldApplication, 'node_modules', packageName), link)
      }
      const manager = createManager(layout, { trustedSymlinkRoots: [layout.root], rescueScriptPath: resolve('recovery/rescue.mjs') })
      const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'old packaged app links restored from development' })

      await expect(restore(manager, layout, snapshot.archiveName)).resolves.toBeDefined()

      for (const packageName of ['removed-package', 'retained-package']) {
        await expect(lstat(join(layout.harness, 'profiles', 'node_modules', packageName))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await expect(lstat(join(oldApplication, 'node_modules', 'retained-package'))).resolves.toSatisfy((entry) => entry.isDirectory())
    })

    it('discards orphan package-manager bin links only when the target package is absent', async () => {
      const layout = await createFixture()
      const modules = join(layout.harness, 'profiles', 'web', 'node_modules')
      const bins = {
        'pi-ai': '../@earendil-works/pi-ai/dist/cli.js',
        cordis: '../@deepseek-ai/cordis/bin.js',
        'dsh-chat-import': '../dsh-chat-import/bin/dsh-chat-import.mjs',
        'anthropic-ai-sdk': '../@anthropic-ai/sdk/bin/cli',
        openai: '../openai/bin/cli',
      }
      await mkdir(join(modules, '.bin'), { recursive: true })
      for (const [name, target] of Object.entries(bins)) await symlink(target, join(modules, '.bin', name))
      await mkdir(join(modules, 'working-plugin'), { recursive: true })
      await writeFile(join(modules, 'working-plugin', 'cli.js'), '// retain installed plugin\n')
      await symlink('../working-plugin/cli.js', join(modules, '.bin', 'working-plugin'))
      const manager = createManager(layout)
      const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'old orphan bin links' })

      await expect(restore(manager, layout, snapshot.archiveName)).resolves.toBeDefined()

      for (const name of Object.keys(bins)) await expect(lstat(join(modules, '.bin', name))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(modules, '.bin', 'working-plugin'), 'utf8')).resolves.toContain('retain installed plugin')
      await expect(readlink(join(modules, '.bin', 'working-plugin'))).resolves.toBe('../working-plugin/cli.js')
      await expect(manager.verify(snapshot.archiveName)).resolves.toMatchObject({ ok: true })
    })

    it('preserves an external skill link already present at the same live location and target', async () => {
      const layout = await createFixture()
      const skillRoot = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-existing-skill-'))
      temporaryRoots.push(skillRoot)
      await writeFile(join(skillRoot, 'SKILL.md'), '# Existing user skill\n')
      const link = join(layout.harness, 'skills', 'dbs')
      await mkdir(join(link, '..'), { recursive: true })
      await symlink(skillRoot, link)
      const manager = createManager(layout)
      const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'existing external skill link' })

      await expect(restore(manager, layout, snapshot.archiveName)).resolves.toBeDefined()

      await expect(readlink(link)).resolves.toBe(skillRoot)
      await expect(readFile(join(link, 'SKILL.md'), 'utf8')).resolves.toContain('Existing user skill')
    })

    it.each(['new-location', 'changed-target', 'regular-live-directory', 'nested-location', 'broken-target'] as const)(
      'rejects a %s external skill link without granting new external access', async (kind) => {
        const layout = await createFixture()
        const skillRoot = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-untrusted-skill-'))
        temporaryRoots.push(skillRoot)
        const link = join(layout.harness, 'skills', ...(kind === 'nested-location' ? ['nested', 'dbs'] : ['dbs']))
        const target = kind === 'broken-target' ? join(skillRoot, 'missing') : skillRoot
        await mkdir(join(link, '..'), { recursive: true })
        await symlink(target, link)
        const manager = createManager(layout)
        const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'external skill boundary' })
        if (kind === 'new-location' || kind === 'changed-target' || kind === 'regular-live-directory') await rm(link)
        if (kind === 'changed-target') {
          await mkdir(join(skillRoot, 'other'))
          await symlink(join(skillRoot, 'other'), link)
        } else if (kind === 'regular-live-directory') await mkdir(link)
        await writeFile(join(layout.harness, 'settings.yaml'), 'current: true\n')

        await expect(restore(manager, layout, snapshot.archiveName)).rejects.toThrow(/symbolic link|Symbolic link/u)

        expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toBe('current: true\n')
      },
    )

    it.each(['installed-package', 'absolute-target', 'escaped-target', 'escaped-parent', 'broken-package'] as const)(
      'rejects an invalid %s bin link without deleting data', async (kind) => {
        const layout = await createFixture()
        const outside = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-bin-outside-'))
        temporaryRoots.push(outside)
        const modules = join(layout.harness, 'profiles', 'web', 'node_modules')
        await mkdir(join(modules, '.bin'), { recursive: true })
        if (kind === 'installed-package') {
          await mkdir(join(modules, '@example', 'sdk'), { recursive: true })
          await writeFile(join(modules, '@example', 'sdk', 'package.json'), '{"name":"@example/sdk"}\n')
        } else if (kind === 'escaped-parent') {
          await symlink(outside, join(modules, '@example'))
        } else if (kind === 'broken-package') {
          await mkdir(join(modules, '@example'), { recursive: true })
          await symlink(join(outside, 'missing'), join(modules, '@example', 'sdk'))
        }
        const link = join(modules, '.bin', 'sdk')
        await symlink(kind === 'absolute-target' ? join(modules, '@example', 'sdk', 'bin', 'cli')
          : kind === 'escaped-target' ? '../../../../missing/bin/cli'
          : '../@example/sdk/bin/cli', link)
        const manager = createManager(layout)
        const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'invalid bin boundary' })
        await writeFile(join(layout.harness, 'settings.yaml'), 'current: true\n')

        await expect(restore(manager, layout, snapshot.archiveName)).rejects.toThrow('symbolic link')

        expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toBe('current: true\n')
        await expect(lstat(link)).resolves.toSatisfy((entry) => entry.isSymbolicLink())
      },
    )

    it.each(['outside-app', 'outside-fallback', 'different-package', 'relative-target', 'escaped-parent', 'broken-parent'] as const)(
      'rejects a broken %s link without changing live data', async (kind) => {
        const layout = await createFixture()
        const trustedRoot = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-link-boundary-'))
        const outsideRoot = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-link-outside-'))
        temporaryRoots.push(trustedRoot, outsideRoot)
        const packageName = '@deepseek-ai/dsh-client-runtime'
        const modulesRoot = join(trustedRoot, 'node_modules')
        await mkdir(modulesRoot, { recursive: true })
        if (kind === 'escaped-parent' || kind === 'broken-parent') {
          await symlink(kind === 'escaped-parent' ? outsideRoot : join(outsideRoot, 'missing'), join(modulesRoot, '@deepseek-ai'))
        }
        const link = kind === 'outside-fallback'
          ? join(layout.harness, 'profiles', 'web', 'node_modules', packageName)
          : join(layout.harness, 'profiles', 'node_modules', packageName)
        const target = kind === 'outside-app' ? join(outsideRoot, 'node_modules', packageName)
          : kind === 'different-package' ? join(modulesRoot, '@deepseek-ai', 'another-package')
          : kind === 'relative-target' ? '../../missing'
          : join(modulesRoot, packageName)
        await mkdir(join(link, '..'), { recursive: true })
        await symlink(target, link)
        const manager = createManager(layout, { trustedSymlinkRoots: [trustedRoot], rescueScriptPath: resolve('recovery/rescue.mjs') })
        const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'recovery boundary regression' })
        await writeFile(join(layout.harness, 'settings.yaml'), 'current: true\n')

        await expect(restore(manager, layout, snapshot.archiveName)).rejects.toThrow('Broken symbolic link in recovery archive')

        expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toBe('current: true\n')
        await expect(readlink(link)).resolves.toBe(target)
      },
    )
  })

  it('restores an absolute dependency symlink into a bundled DSH Runtime without a saved root', async () => {
    const layout = await createFixture()
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'ezdsh-bundled-runtime-'))
    temporaryRoots.push(runtimeRoot)
    await mkdir(join(runtimeRoot, 'lib'), { recursive: true })
    await writeFile(join(runtimeRoot, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.1.3"}\n', { mode: 0o600 })
    await writeFile(join(runtimeRoot, 'lib', 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
    const dependencyTarget = join(runtimeRoot, 'node_modules', '@aws-crypto', 'crc32')
    const dependencyLink = join(layout.harness, 'profiles', 'node_modules', '@aws-crypto', 'crc32')
    await mkdir(dependencyTarget, { recursive: true })
    await writeFile(join(dependencyTarget, 'package.json'), '{"name":"@aws-crypto/crc32"}\n', { mode: 0o600 })
    await mkdir(join(dependencyLink, '..'), { recursive: true })
    await symlink(dependencyTarget, dependencyLink)
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'bundled runtime dependency link' })
    await rm(dependencyLink, { force: true })

    await expect(manager.restore(snapshot.archiveName, false)).resolves.toMatchObject({ snapshotName: snapshot.archiveName })
    await expect(lstat(dependencyLink)).resolves.toSatisfy((entry) => entry.isSymbolicLink())
  })

  it('rejects a symbolic link that escapes both the archive and trusted application roots', async () => {
    const layout = await createFixture()
    const untrustedRoot = await mkdtemp(join(tmpdir(), 'ezdsh-untrusted-'))
    temporaryRoots.push(untrustedRoot)
    const dependencyLink = join(layout.harness, 'profiles', 'node_modules', 'outside')
    await writeFile(join(untrustedRoot, 'outside'), 'untrusted\n', { mode: 0o600 })
    await mkdir(join(dependencyLink, '..'), { recursive: true })
    await symlink(join(untrustedRoot, 'outside'), dependencyLink)
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'untrusted dependency link' })

    await expect(manager.restore(snapshot.archiveName, false)).rejects.toThrow('Symbolic link target is outside the recovery boundary')
  })

  it('persists an upgrade transaction and enters recovery-required after boot failure', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    await manager.initialize()

    const pending = await manager.prepareUpdate({ targetAppVersion: '1.8.1537', targetDshRuntimeVersion: '0.2.0' })
    expect(pending).toMatchObject({
      phase: 'prepared',
      fromAppVersion: '1.8.1536',
      targetAppVersion: '1.8.1537',
      targetDshRuntimeVersion: '0.2.0',
    })
    expect(manager.snapshot().phase).toBe('pending-update')

    await manager.markBootFailure('Runtime did not become healthy')

    expect(manager.snapshot()).toMatchObject({
      phase: 'recovery-required',
      lastError: 'Runtime did not become healthy',
      pendingUpdate: { phase: 'failed' },
    })
  })

  it('creates a plugin-change snapshot and records the affected plugin after boot failure', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    await manager.initialize()

    const pending = await manager.preparePluginChange({
      action: 'install',
      entryId: 'agent-teams',
      packageName: '@nanmicoder/dsh-agent-teams',
      profile: 'web',
    })

    expect(pending).toMatchObject({
      kind: 'plugin-change',
      phase: 'prepared',
      affectedPlugin: { entryId: 'agent-teams', action: 'install' },
    })
    expect(pending.snapshotName).toMatch(/^ezdsh-pre-plugin-change-/)
    expect(manager.snapshot().phase).toBe('pending-plugin-change')

    await manager.markBootFailure('Plugin crashed during startup')

    expect(manager.snapshot()).toMatchObject({
      phase: 'recovery-required',
      lastError: 'Plugin crashed during startup',
      pendingTransaction: {
        kind: 'plugin-change',
        phase: 'failed',
        affectedPlugin: { entryId: 'agent-teams', packageName: '@nanmicoder/dsh-agent-teams' },
      },
    })
    await manager.completePendingTransaction()
    expect(manager.snapshot().phase).toBe('idle')
  })

  it('enters recovery for a normal Runtime boot failure and exposes plugin disable choices', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    await manager.initialize()
    await manager.createSnapshot({ kind: 'manual', reason: 'restore test' })

    await expect(manager.markRuntimeFailure('failed to import loader entry (mode-menu-plus)', [
      { packageName: 'mode-menu-plus', profile: 'web', entryId: 'mode-menu-plus', name: 'Mode Menu Plus' },
    ], '/tmp/harness.log')).resolves.toMatchObject({
      phase: 'recovery-required',
      lastError: 'failed to import loader entry (mode-menu-plus)',
      runtimeFailure: {
        logPath: '/tmp/harness.log',
        latestSnapshot: { archiveName: expect.stringMatching(/^ezdsh-manual-/), reason: 'restore test', createdAt: '2026-08-27T01:02:03.004Z' },
        plugins: [{ packageName: 'mode-menu-plus', profile: 'web', entryId: 'mode-menu-plus' }],
      },
    })
    expect(manager.snapshot().pendingTransaction).toBeUndefined()

    await manager.completePendingTransaction()
    expect(manager.snapshot()).toEqual({ phase: 'idle' })
  })

  it('copies the dependency-free rescue channel and launcher into backups', async () => {
    const layout = await createFixture()
    const manager = createManager(layout, { rescueScriptPath: resolve('recovery/rescue.mjs') })

    await manager.createSnapshot({ kind: 'manual', reason: 'rescue channel test' })

    await expect(access(join(layout.backups, 'rescue.mjs'))).resolves.toBeUndefined()
    const launcher = process.platform === 'darwin'
      ? 'EzDSH Recovery.command'
      : process.platform === 'win32' ? 'EzDSH Recovery.bat' : 'EzDSH Recovery.sh'
    await expect(access(join(layout.backups, launcher))).resolves.toBeUndefined()
  })

  it('diagnoses session log damage and only repairs an incomplete final record when requested', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const sessionLog = join(layout.harness, 'sessions', '--root--', 'session-1', 'session.jsonl')
    await mkdir(join(sessionLog, '..'), { recursive: true })
    await writeFile(sessionLog, [
      JSON.stringify({ type: 'session', version: 1, id: 'session-1', createdAt: 1, delegationDepth: 0 }),
      JSON.stringify({ type: 'turn/start', id: 'turn-1' }),
      '{"type":"assistant/message"',
    ].join('\n'), { mode: 0o600 })

    const report = await manager.doctor()

    expect(report.scannedFiles).toBe(1)
    expect(report.issues).toEqual([expect.objectContaining({ kind: 'incomplete-final-record' })])
    expect(report.repairedFiles).toEqual([])

    const repaired = await manager.doctor(true)

    expect(repaired.repairedFiles).toEqual([expect.stringContaining('session.jsonl')])
    expect(await readFile(sessionLog, 'utf8')).not.toContain('assistant/message')
  })

  it('lets the standalone rescue script verify and restore without importing EzDSH', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'standalone rescue test' })
    await writeFile(join(layout.harness, 'settings.yaml'), 'broken: true\n', { mode: 0o600 })

    const verified = await execFileAsync(process.execPath, [resolve('recovery/rescue.mjs'), 'verify', snapshot.archiveName, '--root', layout.root])
    expect(verified.stdout).toContain(`OK ${snapshot.archiveName}`)

    await execFileAsync(process.execPath, [resolve('recovery/rescue.mjs'), 'restore', snapshot.archiveName, '--yes', '--root', layout.root])
    expect(await readFile(join(layout.harness, 'settings.yaml'), 'utf8')).toContain('preference: zh')
  })

  it('lets the standalone rescue script restore trusted dependency symlinks', async () => {
    const layout = await createFixture()
    const trustedRoot = await mkdtemp(join(tmpdir(), 'ezdsh-rescue-runtime-'))
    temporaryRoots.push(trustedRoot)
    const dependencyTarget = join(trustedRoot, 'node_modules', '@agentclientprotocol', 'sdk')
    const dependencyLink = join(layout.harness, 'profiles', 'node_modules', '@agentclientprotocol', 'sdk')
    await mkdir(dependencyTarget, { recursive: true })
    await writeFile(join(dependencyTarget, 'package.json'), '{"name":"@agentclientprotocol/sdk"}\n', { mode: 0o600 })
    await mkdir(join(dependencyLink, '..'), { recursive: true })
    await symlink(dependencyTarget, dependencyLink)
    const manager = createManager(layout, {
      rescueScriptPath: resolve('recovery/rescue.mjs'),
      trustedSymlinkRoots: [trustedRoot],
    })
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'standalone trusted dependency link' })
    await rm(dependencyLink, { force: true })

    await execFileAsync(process.execPath, [resolve('recovery/rescue.mjs'), 'restore', snapshot.archiveName, '--yes', '--root', layout.root])
    await expect(lstat(dependencyLink)).resolves.toSatisfy((entry) => entry.isSymbolicLink())
  })

  it('lets standalone rescue trust the current Electron Resources path when its saved config is stale', async () => {
    const layout = await createFixture()
    const trustedRoot = await mkdtemp(join(tmpdir(), 'ezdsh-rescue-current-runtime-'))
    const staleRoot = await mkdtemp(join(tmpdir(), 'ezdsh-rescue-stale-runtime-'))
    temporaryRoots.push(trustedRoot, staleRoot)
    const dependencyTarget = join(trustedRoot, 'node_modules', '@aws-crypto', 'crc32')
    const dependencyLink = join(layout.harness, 'profiles', 'node_modules', '@aws-crypto', 'crc32')
    await mkdir(dependencyTarget, { recursive: true })
    await writeFile(join(dependencyTarget, 'package.json'), '{"name":"@aws-crypto/crc32"}\n', { mode: 0o600 })
    await mkdir(join(dependencyLink, '..'), { recursive: true })
    await symlink(dependencyTarget, dependencyLink)
    const manager = createManager(layout, {
      rescueScriptPath: resolve('recovery/rescue.mjs'),
      trustedSymlinkRoots: [staleRoot],
    })
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'stale rescue config' })
    await rm(dependencyLink, { force: true })
    const preload = join(layout.backups, 'set-electron-resources-path.mjs')
    await writeFile(preload, `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(trustedRoot)} })\n`, { mode: 0o600 })

    await execFileAsync(process.execPath, [
      '--import', preload,
      resolve('recovery/rescue.mjs'), 'restore', snapshot.archiveName, '--yes', '--root', layout.root,
    ])
    await expect(lstat(dependencyLink)).resolves.toSatisfy((entry) => entry.isSymbolicLink())
  })

  it('rotates snapshots by kind while retaining the newest recovery points', async () => {
    const layout = await createFixture()
    const manager = createManager(layout, { maxSnapshots: 2 })

    await manager.createSnapshot({ kind: 'manual', reason: 'rotation 1' })
    await manager.createSnapshot({ kind: 'manual', reason: 'rotation 2' })
    await manager.createSnapshot({ kind: 'manual', reason: 'rotation 3' })

    const snapshots = await manager.listSnapshots()
    expect(snapshots).toHaveLength(2)
    expect(snapshots.every((snapshot) => snapshot.manifest.kind === 'manual')).toBe(true)
  })

  it('deletes a snapshot with its integrity sidecars and credential vault', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const snapshot = await manager.createSnapshot({ kind: 'manual', reason: 'delete test' })

    await manager.deleteSnapshot(snapshot.archiveName)

    await expect(manager.listSnapshots()).resolves.toEqual([])
    await expect(access(snapshot.archivePath)).rejects.toThrow()
    await expect(access(snapshot.checksumPath)).rejects.toThrow()
    await expect(access(snapshot.manifestPath)).rejects.toThrow()
    await expect(access(join(layout.backups, 'vault', snapshot.archiveName))).rejects.toThrow()
  })

  it('protects the snapshot required by an active recovery transaction', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    await manager.initialize()
    const pending = await manager.prepareUpdate({ targetAppVersion: '1.8.1537' })

    await expect(manager.deleteSnapshot(pending.snapshotName)).rejects.toThrow('required for update recovery')
    await expect(access(join(layout.backups, pending.snapshotName))).resolves.toBeUndefined()
  })

  it('refuses to rewrite a committed middle session record even in repair mode', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const sessionLog = join(layout.harness, 'sessions', '--root--', 'session-2', 'session.jsonl')
    await mkdir(join(sessionLog, '..'), { recursive: true })
    const content = [
      JSON.stringify({ type: 'session', version: 1, id: 'session-2', createdAt: 1, delegationDepth: 0 }),
      '{"type":"broken"',
      JSON.stringify({ type: 'turn/end', id: 'turn-1' }),
    ].join('\n') + '\n'
    await writeFile(sessionLog, content, { mode: 0o600 })

    const report = await manager.doctor(true)

    expect(report.issues).toEqual([expect.objectContaining({ kind: 'invalid-record' })])
    expect(report.repairedFiles).toEqual([])
    expect(await readFile(sessionLog, 'utf8')).toBe(content)
  })

  it('scans concatenated Zstandard Session Log frames instead of only the first frame', async () => {
    const layout = await createFixture()
    const manager = createManager(layout)
    const sessionLog = join(layout.harness, 'sessions', '--root--', 'session-3', 'session.jsonl.zstd')
    await mkdir(join(sessionLog, '..'), { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 1, id: 'session-3', createdAt: 1, delegationDepth: 0 })
    const event = JSON.stringify({ type: 'turn/end', id: 'turn-1' })
    await writeFile(sessionLog, Buffer.concat([
      zstdCompressSync(Buffer.from(`${header}\n`)),
      zstdCompressSync(Buffer.from(`${event}\n`)),
    ]), { mode: 0o600 })

    await expect(manager.doctor()).resolves.toMatchObject({ scannedFiles: 1, healthyFiles: 1, issues: [] })
  })
})
