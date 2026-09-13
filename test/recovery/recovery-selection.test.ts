import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryManager, type RecoverySnapshotKind } from '../../src/main/recovery/recovery-manager'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-selection-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
  const settingsPath = join(layout.harness, 'settings.yaml')
  const credentialPath = join(layout.harness, '.credentials.yaml')
  await writeFile(credentialPath, 'provider: fixture-only\n')
  let clock = Date.parse('2026-09-13T00:00:00.000Z')
  const manager = new RecoveryManager({
    layout, appVersion: '1.8.1556', dshRuntimeVersion: 'fixture', dataSchemaVersion: 1,
    now: () => new Date(clock += 1000),
  })
  const backup = async (kind: RecoverySnapshotKind, content: string) => {
    await writeFile(settingsPath, content)
    return manager.createSnapshot({ kind, reason: 'selection regression' })
  }
  return { layout, manager, backup, settingsPath, credentialPath }
}

describe('RecoveryManager snapshot selection', () => {
  it('verifies, previews and restores the newest ordinary backup even with multiple backups and a newer pre-restore', async () => {
    const h = await fixture()
    await h.backup('manual', 'model: older\n')
    const newest = await h.backup('manual', 'model: newest\n')
    await h.backup('pre-restore', 'model: rescue-copy\n')
    await writeFile(h.settingsPath, 'model: current\n')

    await expect(h.manager.verify('latest')).resolves.toMatchObject({ ok: true, snapshotName: newest.archiveName })
    await expect(h.manager.restore('latest', true)).resolves.toMatchObject({ dryRun: true, snapshotName: newest.archiveName })
    expect(await readFile(h.settingsPath, 'utf8')).toBe('model: current\n')
    await expect(h.manager.restore('latest', false)).resolves.toMatchObject({ dryRun: false, snapshotName: newest.archiveName })
    expect(await readFile(h.settingsPath, 'utf8')).toBe('model: newest\n')
  })

  it.each(['pre-update', 'pre-plugin-change'] as const)('includes the newest %s backup in latest selection', async (kind) => {
    const h = await fixture()
    await h.backup('manual', 'model: older\n')
    const newest = await h.backup(kind, 'model: newest\n')
    await expect(h.manager.restore('latest', true)).resolves.toMatchObject({ snapshotName: newest.archiveName })
  })

  it.each([false, true])('requires an ordinary backup instead of selecting a safety copy (only pre-restore: %s)', async (withSafetyCopy) => {
    const h = await fixture()
    if (withSafetyCopy) await h.backup('pre-restore', 'model: safety\n')
    await writeFile(h.settingsPath, 'model: current\n')
    await expect(h.manager.restore('latest', false)).rejects.toThrow('Snapshot not found: latest')
    expect(await readFile(h.settingsPath, 'utf8')).toBe('model: current\n')
  })

  it('keeps ordinary prefixes ambiguous and allows an explicitly chosen older backup', async () => {
    const h = await fixture()
    const older = await h.backup('manual', 'model: older\n')
    await h.backup('manual', 'model: newest\n')
    await expect(h.manager.restore('ezdsh-manual-', true)).rejects.toThrow('Snapshot selector is ambiguous')
    await expect(h.manager.restore(older.archiveName, true)).resolves.toMatchObject({ snapshotName: older.archiveName })
  })

  it('rejects a corrupt newest archive without silently restoring an older backup', async () => {
    const h = await fixture()
    await h.backup('manual', 'model: older\n')
    const newest = await h.backup('manual', 'model: newest\n')
    await writeFile(newest.archivePath, 'corrupt archive')
    await writeFile(h.settingsPath, 'model: current\n')
    await expect(h.manager.verify('latest')).resolves.toMatchObject({ ok: false, snapshotName: newest.archiveName, note: 'checksum mismatch' })
    await expect(h.manager.restore('latest', false)).rejects.toThrow(`checksum verification failed for ${newest.archiveName}`)
    expect(await readFile(h.settingsPath, 'utf8')).toBe('model: current\n')
    expect((await readdir(h.layout.backups)).filter((name) => name.startsWith('ezdsh-pre-restore-'))).toEqual([])
  })

  it.each(['update', 'plugin-change'] as const)('still protects the pending %s backup when deletion uses latest', async (kind) => {
    const h = await fixture()
    const older = await h.backup('manual', 'model: older\n')
    const pending = kind === 'update'
      ? await h.manager.prepareUpdate({ targetAppVersion: 'next' })
      : await h.manager.preparePluginChange({ action: 'install', entryId: 'fixture', packageName: 'fixture-plugin', profile: 'web' })
    const safety = await h.backup('pre-restore', 'model: safety\n')
    const archive = join(h.layout.backups, pending.snapshotName)
    const protectedPaths = [archive, `${archive}.sha256`, `${archive}.manifest.json`, join(h.layout.backups, 'vault', pending.snapshotName, 'harness', '.credentials.yaml')]
    const original = await Promise.all(protectedPaths.map((path) => readFile(path)))
    await expect(h.manager.deleteSnapshot('latest')).rejects.toThrow(`Cannot delete the snapshot required for ${kind} recovery`)
    expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(original)
    expect((await h.manager.listSnapshots()).map((snapshot) => snapshot.archiveName)).toEqual([safety.archiveName, pending.snapshotName, older.archiveName])
    expect(h.manager.snapshot().pendingTransaction?.snapshotName).toBe(pending.snapshotName)
  })

  it('deletes only the explicitly requested latest ordinary backup and keeps older and safety copies', async () => {
    const h = await fixture()
    const older = await h.backup('manual', 'model: older\n')
    const newest = await h.backup('manual', 'model: newest\n')
    const safety = await h.backup('pre-restore', 'model: safety\n')
    await h.manager.deleteSnapshot('latest')
    expect((await h.manager.listSnapshots()).map((snapshot) => snapshot.archiveName)).toEqual([safety.archiveName, older.archiveName])
    for (const path of [newest.archivePath, newest.checksumPath, newest.manifestPath, join(h.layout.backups, 'vault', newest.archiveName, 'harness', '.credentials.yaml')]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(h.manager.verify(older.archiveName)).resolves.toMatchObject({ ok: true })
    await expect(h.manager.verify(safety.archiveName)).resolves.toMatchObject({ ok: true })
    expect(await readFile(h.settingsPath, 'utf8')).toBe('model: safety\n')
  })

  it.each([true, false])('verifies the manifest it selected even when the file changes before hashing (dry run: %s)', async (dryRun) => {
    const h = await fixture()
    const snapshot = await h.backup('manual', 'model: saved\n')
    await writeFile(h.settingsPath, 'model: current\n')
    await writeFile(snapshot.manifestPath, JSON.stringify({ ...snapshot.manifest, sha256: '0'.repeat(64) }))
    const list = h.manager.listSnapshots.bind(h.manager)
    // A deterministic filesystem race: selection reads the invalid checksum,
    // then the on-disk manifest changes. A second resolution would incorrectly
    // validate the new checksum while restoring with the first manifest.
    vi.spyOn(h.manager, 'listSnapshots').mockImplementationOnce(async () => {
      const selected = await list()
      await writeFile(snapshot.manifestPath, JSON.stringify(snapshot.manifest))
      return selected
    })
    const beforeCredentials = await readFile(h.credentialPath)
    await expect(dryRun ? h.manager.restore(snapshot.archiveName, true) : h.manager.restore(snapshot.archiveName, false))
      .rejects.toThrow(`checksum verification failed for ${snapshot.archiveName}`)
    expect(await readFile(h.settingsPath, 'utf8')).toBe('model: current\n')
    expect(await readFile(h.credentialPath)).toEqual(beforeCredentials)
    expect(h.manager.snapshot().phase).toBe('idle')
    expect((await readdir(h.layout.backups)).filter((name) => name.startsWith('ezdsh-pre-restore-'))).toEqual([])
  })
})
