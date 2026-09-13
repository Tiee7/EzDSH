import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryManager } from '../../src/main/recovery/recovery-manager'
import { RecoveryRestoreCoordinator } from '../../src/main/recovery/recovery-restore-coordinator'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-recovery-preflight-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
  const settingsPath = join(layout.harness, 'settings.yaml')
  const credentialPath = join(layout.harness, '.credentials.yaml')
  await writeFile(settingsPath, 'selected: saved-model\n')
  await writeFile(credentialPath, 'token: fixture-only-saved\n')
  let timestamp = Date.parse('2026-09-13T10:00:00.000Z')
  const recovery = new RecoveryManager({
    layout,
    appVersion: 'test',
    dshRuntimeVersion: 'test',
    dataSchemaVersion: 1,
    now: () => new Date(timestamp += 1000),
  })
  await recovery.initialize()
  const snapshot = await recovery.createSnapshot({ kind: 'manual', reason: 'Selected backup' })
  await writeFile(settingsPath, 'selected: current-model\n')
  await writeFile(credentialPath, 'token: fixture-only-current\n')
  let running = true
  const stopComponents = vi.fn(async () => { running = false })
  const preflight = vi.fn((selector: string) => recovery.restore(selector, true))
  const restore = vi.fn((selector: string) => recovery.restore(selector, false))
  const prepareMode = vi.fn(async () => undefined)
  const options = { getMode: () => 'normal' as const, stopComponents, preflight, restore, prepareMode }
  return {
    layout, snapshot, recovery, settingsPath, credentialPath, options,
    isRunning: () => running,
    coordinator: new RecoveryRestoreCoordinator(options),
  }
}

describe('recovery preflight with real backup files', () => {
  it.each(['empty selector', 'missing snapshot', 'invalid manifest', 'checksum mismatch', 'invalid archive'] as const)(
    'does not stop current services or replace data for %s', async (problem) => {
      const setup = await fixture()
      let selector = setup.snapshot.archiveName
      if (problem === 'empty selector') selector = ''
      if (problem === 'missing snapshot') selector = 'missing-backup'
      if (problem === 'invalid manifest') await writeFile(setup.snapshot.manifestPath, '{broken')
      if (problem === 'checksum mismatch') await writeFile(setup.snapshot.archivePath, 'changed archive')
      if (problem === 'invalid archive') {
        const content = Buffer.from('not a tar archive')
        const sha256 = createHash('sha256').update(content).digest('hex')
        await writeFile(setup.snapshot.archivePath, content)
        await writeFile(setup.snapshot.manifestPath, JSON.stringify({ ...setup.snapshot.manifest, sha256 }))
        await writeFile(setup.snapshot.checksumPath, `${sha256}  ${setup.snapshot.archiveName}\n`)
        // A matching digest alone must not make an unreadable archive pass.
        await expect(setup.recovery.verify(selector)).resolves.toMatchObject({ ok: true })
      }
      const state = setup.recovery.snapshot()

      await expect(setup.coordinator.restore(selector)).rejects.toThrow()

      expect(setup.options.preflight).toHaveBeenCalledWith(selector)
      expect(setup.options.stopComponents).not.toHaveBeenCalled()
      expect(setup.options.restore).not.toHaveBeenCalled()
      expect(setup.options.prepareMode).not.toHaveBeenCalled()
      expect(setup.isRunning()).toBe(true)
      expect(setup.recovery.snapshot()).toEqual(state)
      await expect(readFile(setup.settingsPath, 'utf8')).resolves.toBe('selected: current-model\n')
      await expect(readFile(setup.credentialPath, 'utf8')).resolves.toBe('token: fixture-only-current\n')
      expect((await readdir(setup.layout.backups)).filter((name) => name.startsWith('ezdsh-pre-restore-'))).toEqual([])
      await expect(setup.coordinator.waitUntilReady()).resolves.toBeUndefined()
    },
  )

  it('restores the exact previewed snapshot when a prefix becomes ambiguous during shutdown', async () => {
    const setup = await fixture()
    setup.options.stopComponents.mockImplementation(async () => {
      await setup.recovery.createSnapshot({ kind: 'manual', reason: 'New backup during shutdown' })
    })

    await expect(setup.coordinator.restore('ezdsh-manual-')).resolves.toMatchObject({
      snapshotName: setup.snapshot.archiveName,
      dryRun: false,
    })

    expect(setup.options.preflight).toHaveBeenCalledWith('ezdsh-manual-')
    expect(setup.options.restore).toHaveBeenCalledWith(setup.snapshot.archiveName)
    expect(setup.options.stopComponents).toHaveBeenCalledOnce()
    expect(setup.options.prepareMode).toHaveBeenCalledWith('normal')
    await expect(readFile(setup.settingsPath, 'utf8')).resolves.toBe('selected: saved-model\n')
    await expect(readFile(setup.credentialPath, 'utf8')).resolves.toBe('token: fixture-only-saved\n')
    await expect(setup.recovery.restore('ezdsh-manual-', true)).rejects.toThrow('ambiguous')
  })

  it('keeps real restore verification if the selected archive changes after preflight', async () => {
    const setup = await fixture()
    setup.options.stopComponents.mockImplementation(async () => {
      await writeFile(setup.snapshot.archivePath, 'changed after preflight')
    })

    await expect(setup.coordinator.restore(setup.snapshot.archiveName)).rejects.toThrow('checksum')

    expect(setup.options.preflight).toHaveBeenCalledOnce()
    expect(setup.options.stopComponents).toHaveBeenCalledOnce()
    expect(setup.options.restore).toHaveBeenCalledWith(setup.snapshot.archiveName)
    expect(setup.options.prepareMode).not.toHaveBeenCalled()
    await expect(readFile(setup.settingsPath, 'utf8')).resolves.toBe('selected: current-model\n')
  })
})
