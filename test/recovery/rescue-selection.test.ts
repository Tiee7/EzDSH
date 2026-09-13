import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { RecoveryManager, type RecoverySnapshotKind } from '../../src/main/recovery/recovery-manager.js'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)
const rescueScript = resolve('recovery/rescue.mjs')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-rescue-selection-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
  const settingsPath = join(layout.harness, 'settings.yaml')
  await writeFile(settingsPath, 'fixture: current\n')
  let timestamp = Date.parse('2026-09-13T12:00:00.000Z')
  const manager = new RecoveryManager({
    layout,
    appVersion: 'test',
    dshRuntimeVersion: 'test',
    now: () => new Date(timestamp += 1000),
  })
  return {
    root,
    layout,
    settingsPath,
    createSnapshot: (kind: RecoverySnapshotKind, reason: string) => manager.createSnapshot({ kind, reason }),
  }
}

async function rescue(root: string, ...args: string[]) {
  try {
    const output = await execFileAsync(process.execPath, [rescueScript, ...args, '--root', root])
    return { ...output, code: 0 }
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string }
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }
  }
}

describe('standalone rescue snapshot selection', () => {
  it('uses the newest non-pre-restore backup for latest and omitted selectors', async () => {
    const setup = await fixture()
    await setup.createSnapshot('manual', 'older manual backup')
    const selected = await setup.createSnapshot('pre-update', 'newest eligible backup')
    await setup.createSnapshot('pre-restore', 'newer restore safety backup')
    await writeFile(setup.settingsPath, 'fixture: keep-current\n')

    for (const args of [['verify', 'latest'], ['verify'], ['restore', 'latest'], ['restore']]) {
      const output = await rescue(setup.root, ...args)
      expect(output.code, output.stderr).toBe(0)
      expect(output.stdout).toContain(selected.archiveName)
      if (args[0] === 'restore') expect(output.stdout).toContain('Dry run only')
    }

    expect(await readFile(setup.settingsPath, 'utf8')).toBe('fixture: keep-current\n')
    expect((await readdir(setup.root)).filter((name) => name.startsWith('.ezdsh-rescue-'))).toEqual([])
  })

  it('lists, verifies, previews, and restores a plugin-change backup by its exact name', async () => {
    const setup = await fixture()
    await setup.createSnapshot('manual', 'older backup')
    await writeFile(setup.settingsPath, 'fixture: before-plugin-change\n')
    const selected = await setup.createSnapshot('pre-plugin-change', 'before plugin change')
    await setup.createSnapshot('pre-restore', 'newer restore safety backup')
    await writeFile(setup.settingsPath, 'fixture: changed\n')

    const listed = await rescue(setup.root, 'list')
    expect(listed.code, listed.stderr).toBe(0)
    expect(listed.stdout).toContain(selected.archiveName)
    const verified = await rescue(setup.root, 'verify', selected.archiveName)
    expect(verified.code, verified.stderr).toBe(0)
    expect(verified.stdout).toContain(`OK ${selected.archiveName}`)
    const latest = await rescue(setup.root, 'verify', 'latest')
    expect(latest.code, latest.stderr).toBe(0)
    expect(latest.stdout).toContain(`OK ${selected.archiveName}`)
    const preview = await rescue(setup.root, 'restore', selected.archiveName)
    expect(preview.code, preview.stderr).toBe(0)
    expect(preview.stdout).toContain(`Snapshot: ${selected.archiveName}`)
    expect(preview.stdout).toContain('Dry run only')
    expect(await readFile(setup.settingsPath, 'utf8')).toBe('fixture: changed\n')

    const restored = await rescue(setup.root, 'restore', selected.archiveName, '--yes')

    expect(restored.code, restored.stderr).toBe(0)
    expect(restored.stdout).toContain(`Restored ${selected.archiveName}`)
    expect(await readFile(setup.settingsPath, 'utf8')).toBe('fixture: before-plugin-change\n')
    const preserved = (await readdir(setup.root)).filter((name) => name.startsWith('.ezdsh-rescue-pre-restore-'))
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(setup.root, preserved[0], 'harness', 'settings.yaml'), 'utf8')).toBe('fixture: changed\n')
  })

  it.each(['empty backups', 'only pre-restore backups', 'empty selector'] as const)(
    'refuses to choose a restore target with %s', async (problem) => {
      const setup = await fixture()
      if (problem === 'only pre-restore backups') await setup.createSnapshot('pre-restore', 'safety backup only')
      const output = await rescue(setup.root, 'restore', problem === 'empty selector' ? '' : 'latest', '--yes')

      expect(output.code).not.toBe(0)
      expect(output.stderr).toContain(problem === 'empty selector' ? 'Snapshot selector cannot be empty' : 'Snapshot not found: latest')
      expect(await readFile(setup.settingsPath, 'utf8')).toBe('fixture: current\n')
      expect((await readdir(setup.root)).filter((name) => name.startsWith('.ezdsh-rescue-'))).toEqual([])
    },
  )

  it('continues to reject an ordinary prefix that matches multiple backups', async () => {
    const setup = await fixture()
    await setup.createSnapshot('manual', 'first matching backup')
    await setup.createSnapshot('manual', 'second matching backup')

    const output = await rescue(setup.root, 'restore', 'ezdsh-manual-', '--yes')

    expect(output.code).not.toBe(0)
    expect(output.stderr).toContain('Snapshot selector is ambiguous: ezdsh-manual-')
    expect(await readFile(setup.settingsPath, 'utf8')).toBe('fixture: current\n')
    expect((await readdir(setup.root)).filter((name) => name.startsWith('.ezdsh-rescue-'))).toEqual([])
  })

  it('reports a corrupt latest backup instead of silently restoring an older valid backup', async () => {
    const setup = await fixture()
    await setup.createSnapshot('manual', 'older valid backup')
    const selected = await setup.createSnapshot('manual', 'newest eligible backup')
    await setup.createSnapshot('pre-restore', 'newer restore safety backup')
    await writeFile(selected.archivePath, 'corrupt archive')
    await writeFile(setup.settingsPath, 'fixture: keep-current\n')

    const verified = await rescue(setup.root, 'verify', 'latest')
    expect(verified.code).toBe(2)
    expect(verified.stdout).toContain(`FAILED ${selected.archiveName}`)
    expect(verified.stdout).toContain('checksum mismatch')
    const restored = await rescue(setup.root, 'restore', 'latest', '--yes')
    expect(restored.code).not.toBe(0)
    expect(restored.stderr).toContain(`checksum verification failed for ${selected.archiveName}`)
    expect(await readFile(setup.settingsPath, 'utf8')).toBe('fixture: keep-current\n')
    expect((await readdir(setup.root)).filter((name) => name.startsWith('.ezdsh-rescue-'))).toEqual([])
  })
})
