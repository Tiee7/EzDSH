import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryManager } from '../../src/main/recovery/recovery-manager'
import { RecoveryRestoreCoordinator } from '../../src/main/recovery/recovery-restore-coordinator'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'
import { registerWorkItemIpc, type WorkItemIpcWorkspaceScope } from '../../src/main/work-items/work-item-ipc'
import {
  initializeWorkItemWorkspaceScope,
  type WorkItemWorkspaceEmployeeRunPort,
  type WorkItemWorkspaceWorkflowRunPort,
} from '../../src/main/work-items/work-item-workspace'

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

async function workItemRecoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-recovery-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
  let timestamp = Date.parse('2026-09-15T08:00:00.000Z')
  const recovery = new RecoveryManager({
    layout,
    appVersion: 'test',
    dshRuntimeVersion: 'test',
    dataSchemaVersion: 1,
    now: () => new Date(timestamp += 1000),
  })
  await recovery.initialize()
  const employeeRuns = {
    startWorkItemRun: vi.fn(),
    listWorkItemRuns: vi.fn(async () => []),
    getWorkItemRun: vi.fn(async () => undefined),
    cancelWorkItemRun: vi.fn(),
  } as WorkItemWorkspaceEmployeeRunPort
  const workflowRuns = {
    list: vi.fn(() => []),
    watch: vi.fn(() => vi.fn()),
  } as unknown as WorkItemWorkspaceWorkflowRunPort
  const options = {
    layout,
    employeeRuns,
    workflowRuns,
    assertExecutionAvailable: vi.fn(),
    onChanged: vi.fn(),
    onObserverError: vi.fn(),
  }
  let scope: WorkItemIpcWorkspaceScope | undefined
  const reopen = vi.fn(async () => {
    scope = await initializeWorkItemWorkspaceScope(options)
  })
  const stop = vi.fn(async () => {
    const previous = scope
    scope = undefined
    await previous?.dispose()
  })
  await reopen()
  reopen.mockClear()
  const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<any>>()
  registerWorkItemIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, () => scope)
  const invoke = (channel: string, request?: unknown) => handlers.get(channel)!({}, request)

  await invoke('work-items:create', {
    requestId: 'create-before', title: 'Before snapshot', goal: 'Restore me', acceptance: 'Visible',
    scope: { cwd: '.', resourceRefs: [] },
  })
  const snapshot = await recovery.createSnapshot({ kind: 'manual', reason: 'WorkItem recovery boundary' })
  const after = await invoke('work-items:create', {
    requestId: 'create-after', title: 'After snapshot', goal: 'Remove me', acceptance: 'Absent',
    scope: { cwd: '.', resourceRefs: [] },
  })
  return {
    layout, recovery, snapshot, options, reopen, stop, invoke,
    afterTaskId: after.data.task.id as string,
    currentScope: () => scope,
  }
}

describe('WorkItem workspace recovery composition', () => {
  it('publishes a fresh production scope whose IPC list reads real non-dry restored state', async () => {
    const setup = await workItemRecoveryFixture()
    const coordinator = new RecoveryRestoreCoordinator({
      preflight: (selector) => setup.recovery.restore(selector, true),
      getMode: () => 'normal',
      stopComponents: setup.stop,
      restore: (selector) => setup.recovery.restore(selector, false),
      prepareMode: async () => undefined,
      resumeComponents: setup.reopen,
    })

    await expect(coordinator.restore(setup.snapshot.archiveName)).resolves.toMatchObject({ dryRun: false })

    expect(setup.stop).toHaveBeenCalledOnce()
    expect(setup.reopen).toHaveBeenCalledOnce()
    await expect(setup.invoke('work-items:list')).resolves.toMatchObject({
      ok: true,
      data: [expect.objectContaining({ task: expect.objectContaining({ title: 'Before snapshot' }) })],
    })
    await expect(setup.invoke('work-items:get', setup.afterTaskId)).resolves.toEqual({ ok: true, data: undefined })
  })

  it('reopens list/get admission after a real post-stop restore verification failure', async () => {
    const setup = await workItemRecoveryFixture()
    let primary: unknown
    const coordinator = new RecoveryRestoreCoordinator({
      preflight: (selector) => setup.recovery.restore(selector, true),
      getMode: () => 'normal',
      stopComponents: async () => {
        await setup.stop()
        await writeFile(setup.snapshot.archivePath, 'changed after preflight')
      },
      restore: async (selector) => {
        try {
          return await setup.recovery.restore(selector, false)
        } catch (error) {
          primary = error
          throw error
        }
      },
      prepareMode: async () => undefined,
      resumeComponents: setup.reopen,
    })

    const rejected = await coordinator.restore(setup.snapshot.archiveName).catch((error: unknown) => error)
    expect(rejected).toBe(primary)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toMatch(/checksum/i)

    expect(setup.reopen).toHaveBeenCalledOnce()
    await expect(setup.invoke('work-items:list')).resolves.toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({ task: expect.objectContaining({ title: 'Before snapshot' }) }),
        expect.objectContaining({ task: expect.objectContaining({ title: 'After snapshot' }) }),
      ],
    })
    await expect(setup.invoke('work-items:get', setup.afterTaskId)).resolves.toMatchObject({
      ok: true,
      data: { task: { id: setup.afterTaskId } },
    })
  })

  it('preserves prepareMode failure and publishes restored list/get state', async () => {
    const setup = await workItemRecoveryFixture()
    const primary = new Error('prepare mode failed')
    const coordinator = new RecoveryRestoreCoordinator({
      preflight: (selector) => setup.recovery.restore(selector, true),
      getMode: () => 'safe',
      stopComponents: setup.stop,
      restore: (selector) => setup.recovery.restore(selector, false),
      prepareMode: async () => { throw primary },
      resumeComponents: setup.reopen,
    })

    await expect(coordinator.restore(setup.snapshot.archiveName)).rejects.toBe(primary)

    expect(setup.reopen).toHaveBeenCalledOnce()
    await expect(setup.invoke('work-items:list')).resolves.toMatchObject({
      ok: true,
      data: [expect.objectContaining({ task: expect.objectContaining({ title: 'Before snapshot' }) })],
    })
    await expect(setup.invoke('work-items:get', setup.afterTaskId)).resolves.toEqual({ ok: true, data: undefined })
  })

  it('does not reopen or replace the admitted scope when stop fails', async () => {
    const setup = await workItemRecoveryFixture()
    const admitted = setup.currentScope()
    const primary = new Error('stop failed')
    const coordinator = new RecoveryRestoreCoordinator({
      preflight: (selector) => setup.recovery.restore(selector, true),
      getMode: () => 'normal',
      stopComponents: async () => { throw primary },
      restore: (selector) => setup.recovery.restore(selector, false),
      prepareMode: async () => undefined,
      resumeComponents: setup.reopen,
    })

    await expect(coordinator.restore(setup.snapshot.archiveName)).rejects.toBe(primary)

    expect(setup.reopen).not.toHaveBeenCalled()
    expect(setup.currentScope()).toBe(admitted)
    await expect(setup.invoke('work-items:get', setup.afterTaskId)).resolves.toMatchObject({ ok: true })
  })

  it('reopens IPC admission when stop closes the old scope before a later component fails', async () => {
    const setup = await workItemRecoveryFixture()
    const primary = new Error('workflow stop failed after WorkItem shutdown')
    const coordinator = new RecoveryRestoreCoordinator({
      preflight: (selector) => setup.recovery.restore(selector, true),
      getMode: () => 'normal',
      stopComponents: async (reportProgress) => {
        await setup.stop()
        reportProgress?.({ workItemScopeClosed: true })
        throw primary
      },
      restore: (selector) => setup.recovery.restore(selector, false),
      prepareMode: async () => undefined,
      resumeComponents: setup.reopen,
    })

    await expect(coordinator.restore(setup.snapshot.archiveName)).rejects.toBe(primary)

    expect(setup.stop).toHaveBeenCalledOnce()
    expect(setup.reopen).toHaveBeenCalledOnce()
    expect(setup.currentScope()).toBeDefined()
    await expect(setup.invoke('work-items:list')).resolves.toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({ task: expect.objectContaining({ title: 'Before snapshot' }) }),
        expect.objectContaining({ task: expect.objectContaining({ title: 'After snapshot' }) }),
      ],
    })
    await expect(setup.invoke('work-items:get', setup.afterTaskId)).resolves.toMatchObject({
      ok: true,
      data: { task: { id: setup.afterTaskId } },
    })
  })
})
