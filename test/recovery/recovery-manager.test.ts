import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    })

    const archiveText = await readFile(snapshot.archivePath)
    expect(archiveText.includes(Buffer.from('do-not-archive'))).toBe(false)
    expect(await readFile(join(layout.backups, 'vault', snapshot.archiveName, 'harness/.credentials.yaml'), 'utf8'))
      .toContain('do-not-archive')
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
