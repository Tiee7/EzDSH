import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryManager } from '../../src/main/recovery/recovery-manager'
import { IsolationModeController } from '../../src/main/runtime/isolation-mode-home'
import { RuntimeManager, type RuntimeLaunchContext, type RuntimeManagerOptions } from '../../src/main/runtime/runtime-manager'
import { SafeModeProfileController } from '../../src/main/runtime/safe-mode-profile'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data'
import type { UserDataLayout } from '../../src/shared/state'

const roots: string[] = []
const managers: RuntimeManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-persistent-safe-mode-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
  await mkdir(join(layout.harness, 'profiles', 'web'), { recursive: true })
  await mkdir(join(layout.harness, 'sessions'), { recursive: true })
  const sharedFiles = new Map([
    [join(layout.harness, 'settings.yaml'), Buffer.from('# user settings\nagent-presets:\n  default: standard\nmodels:\n  selected: saved-model\n')],
    [join(layout.harness, '.credentials.yaml'), Buffer.from('provider:\n  token: fixture-token\n')],
    [join(layout.harness, 'profiles', 'web', 'package.json'), Buffer.from('{"dependencies":{"normal-only-plugin":"1.0.0"}}\n')],
    [join(layout.harness, 'sessions', 'saved.json'), Buffer.from('{"id":"saved-session","title":"原有会话"}\n')],
    [join(layout.launchRoot, 'notes.md'), Buffer.from('# Existing work\n保留工作内容。\n')],
  ])
  await Promise.all([...sharedFiles].map(([path, content]) => writeFile(path, content)))
  return { layout, sharedFiles, controller: new SafeModeProfileController({ layout }) }
}

function createRuntime(layout: UserDataLayout) {
  const controller = new SafeModeProfileController({ layout })
  const resolveInitialLaunchContext = vi.fn(async (): Promise<RuntimeLaunchContext> => {
    const safe = await controller.restoreIfEnabled()
    return safe === undefined
      ? { mode: 'normal' }
      : { mode: 'safe', dshHome: safe.dshHome, profile: safe.profile }
  })
  const children: Array<ReturnType<typeof makeChild>> = []
  const makeChild = () => Object.assign(new EventEmitter(), {
    pid: 15000 + children.length,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(signal: NodeJS.Signals): boolean {
      this.emit('exit', 0, signal)
      return true
    },
  })
  const spawnProcess = vi.fn<NonNullable<RuntimeManagerOptions['spawnProcess']>>(() => {
    const child = makeChild()
    children.push(child)
    return child as never
  })
  const waitForHealthy = vi.fn(async () => undefined)
  const manager = new RuntimeManager({
    layout,
    runtimeEntryPath: '/fixture/runtime.js',
    command: process.execPath,
    patchPaths: ['/fixture/ordinary.patch.yml'],
    stopTimeoutMs: 1,
    allocatePort: async () => 4567,
    getEnvironment: () => ({}),
    resolveInitialLaunchContext,
    spawnProcess,
    waitForHealthy,
    processKill: (pid, signal) => {
      children.find((child) => child.pid === Math.abs(pid))?.kill(signal)
      return true
    },
  })
  managers.push(manager)
  return { manager, spawnProcess, waitForHealthy, resolveInitialLaunchContext }
}

async function expectSharedFilesUnchanged(files: Map<string, Buffer>): Promise<void> {
  for (const [path, content] of files) await expect(readFile(path)).resolves.toEqual(content)
}

describe('persistent Safe Mode integration', () => {
  it('keeps the enabled safe profile and shared DSH home through an implicit Runtime restart', async () => {
    const { layout, sharedFiles, controller } = await createFixture()
    const safe = await controller.enable()
    const { manager, spawnProcess, resolveInitialLaunchContext } = createRuntime(layout)

    await expect(manager.start({ mode: 'safe', dshHome: safe.dshHome, profile: safe.profile })).resolves.toMatchObject({ phase: 'ready', mode: 'safe' })
    await expect(manager.restart()).resolves.toMatchObject({ phase: 'ready', mode: 'safe' })

    expect(resolveInitialLaunchContext).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledTimes(2)
    for (const [, args, options] of spawnProcess.mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--profile', safe.profile]))
      expect(args).not.toContain('--patch')
      expect(options.env?.DSH_HOME).toBe(layout.harness)
    }
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('restores safe mode after settings edits and a cold start, then starts normal only after disabling', async () => {
    const { layout, sharedFiles, controller } = await createFixture()
    const safe = await controller.enable()
    const first = createRuntime(layout)
    await first.manager.start({ mode: 'safe', dshHome: safe.dshHome, profile: safe.profile })
    const edits = new Map([
      [join(layout.harness, 'settings.yaml'), Buffer.from('# changed while using Safe Mode\nagent-presets:\n  default: custom-agent\nmodels:\n  selected: changed-model\n')],
      [join(layout.harness, '.credentials.yaml'), Buffer.from('provider:\n  token: changed-fixture-token\n')],
    ])
    for (const [path, content] of edits) {
      sharedFiles.set(path, content)
      await writeFile(path, content)
    }
    await first.manager.stop()

    const cold = createRuntime(layout)
    await expect(cold.manager.start()).resolves.toMatchObject({ phase: 'ready', mode: 'safe' })
    expect(cold.resolveInitialLaunchContext).toHaveBeenCalledOnce()
    expect(cold.spawnProcess.mock.calls[0][1]).toEqual(expect.arrayContaining(['--profile', 'ezdsh-safe']))
    expect(cold.spawnProcess.mock.calls[0][2].env?.DSH_HOME).toBe(layout.harness)
    await expect(readFile(join(layout.harness, 'profiles', safe.profile, 'cordis.patch.yml'), 'utf8')).resolves.toContain('default: "custom-agent"')
    await expectSharedFilesUnchanged(sharedFiles)
    await cold.manager.stop()

    await new SafeModeProfileController({ layout }).disable()
    const normal = createRuntime(layout)
    await expect(normal.manager.start()).resolves.toMatchObject({ phase: 'ready', mode: 'normal' })
    expect(normal.spawnProcess.mock.calls[0][1]).toEqual(expect.arrayContaining(['web', '--patch', '/fixture/ordinary.patch.yml']))
    expect(normal.spawnProcess.mock.calls[0][1]).not.toContain('ezdsh-safe')
    expect(normal.spawnProcess.mock.calls[0][2].env?.DSH_HOME).toBe(layout.harness)
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('keeps the saved safe choice through a temporary isolation session and restores it on the next cold start', async () => {
    const { layout, sharedFiles, controller } = await createFixture()
    await controller.enable()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    const selection = await readFile(selectionPath)
    const isolation = new IsolationModeController({ layout })
    const isolated = await isolation.enable('manual')
    await expect(readFile(selectionPath)).resolves.toEqual(selection)
    const temporary = createRuntime(layout)
    await expect(temporary.manager.start({ mode: 'isolation', dshHome: isolated.dshHome })).resolves.toMatchObject({ phase: 'ready', mode: 'isolation' })
    await expect(temporary.manager.restart()).resolves.toMatchObject({ mode: 'isolation' })
    expect(temporary.resolveInitialLaunchContext).not.toHaveBeenCalled()
    for (const [, args, options] of temporary.spawnProcess.mock.calls) {
      expect(options.env?.DSH_HOME).toBe(isolated.dshHome)
      expect(args).not.toContain('--patch')
    }
    await temporary.manager.stop()
    await isolation.disable()
    await expect(readFile(selectionPath)).resolves.toEqual(selection)

    const cold = createRuntime(layout)
    await expect(cold.manager.start()).resolves.toMatchObject({ phase: 'ready', mode: 'safe' })
    expect(cold.spawnProcess.mock.calls[0][2].env?.DSH_HOME).toBe(layout.harness)
    expect(cold.spawnProcess.mock.calls[0][1]).toContain('ezdsh-safe')
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it.each(['safe', 'isolation'] as const)('rebuilds missing %s resources after restoring a snapshot from before the mode was enabled', async (mode) => {
    const { layout, sharedFiles, controller } = await createFixture()
    const recovery = new RecoveryManager({ layout, appVersion: '1.8.1556', dshRuntimeVersion: '0.1.5-rc.1' })
    await recovery.initialize()
    const snapshot = await recovery.createSnapshot({ kind: 'manual', reason: 'Before entering a recovery mode' })
    const isolation = new IsolationModeController({ layout })
    const context: RuntimeLaunchContext = mode === 'safe'
      ? { mode, ...await controller.enable() }
      : { mode, dshHome: (await isolation.enable('manual')).dshHome }
    const modeResources = mode === 'safe'
      ? [
          join(layout.harness, 'profiles', 'ezdsh-safe', 'package.json'),
          join(layout.harness, 'profiles', 'ezdsh-safe', 'cordis.patch.yml'),
          join(layout.state, 'safe-mode-profile', 'presets', 'standard', 'agent.cordis.yml'),
          join(layout.state, 'safe-mode-selection.json'),
        ]
      : [isolation.homePath(), join(layout.state, 'isolation-mode', 'status.json')]
    for (const path of modeResources) await expect(stat(path)).resolves.toBeDefined()
    const { manager, spawnProcess, resolveInitialLaunchContext } = createRuntime(layout)
    await manager.start(context)
    await writeFile(join(layout.harness, 'settings.yaml'), 'models:\n  selected: changed-after-backup\n')
    await writeFile(join(layout.harness, '.credentials.yaml'), 'provider:\n  token: changed-after-backup\n')
    await writeFile(join(layout.harness, 'sessions', 'saved.json'), '{"id":"changed-after-backup"}\n')
    await manager.stop()
    const modeBeforeRestore = manager.snapshot().mode

    await recovery.restore(snapshot.archiveName, false)

    // A fake child would otherwise report ready even with a missing profile or home.
    // Verify the actual filesystem loss before exercising the Main restore sequence.
    for (const path of modeResources) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expectSharedFilesUnchanged(sharedFiles)
    if (modeBeforeRestore === 'safe') await controller.enable()
    else if (modeBeforeRestore === 'isolation') await isolation.enable('manual')
    for (const path of modeResources) await expect(stat(path)).resolves.toBeDefined()
    if (mode === 'isolation') await expect(readdir(isolation.homePath())).resolves.toEqual([])
    await expectSharedFilesUnchanged(sharedFiles)

    await expect(manager.start()).resolves.toMatchObject({ phase: 'ready', mode })
    expect(resolveInitialLaunchContext).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledTimes(2)
    const [, args, options] = spawnProcess.mock.calls[1]
    expect(options.env?.DSH_HOME).toBe(context.dshHome)
    expect(args).not.toContain('--patch')
    expect(args).toContain(mode === 'safe' ? 'ezdsh-safe' : 'web')
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it('keeps a normal restore session normal and only reads a historical safe choice on the next cold start', async () => {
    const { layout, sharedFiles, controller } = await createFixture()
    await controller.enable()
    const recovery = new RecoveryManager({ layout, appVersion: '1.8.1556', dshRuntimeVersion: '0.1.5-rc.1' })
    await recovery.initialize()
    const snapshot = await recovery.createSnapshot({ kind: 'manual', reason: 'Historical Safe Mode selection' })
    await controller.disable()
    const current = createRuntime(layout)
    await current.manager.start({ mode: 'normal' })
    await writeFile(join(layout.harness, 'settings.yaml'), 'models:\n  selected: changed-after-backup\n')
    await current.manager.stop()

    await recovery.restore(snapshot.archiveName, false)

    await expect(readFile(join(layout.state, 'safe-mode-selection.json'), 'utf8')).resolves.toBe('{"version":1,"mode":"safe"}\n')
    await expect(current.manager.start()).resolves.toMatchObject({ phase: 'ready', mode: 'normal' })
    expect(current.resolveInitialLaunchContext).not.toHaveBeenCalled()
    expect(current.spawnProcess.mock.calls[1][1]).toContain('--patch')
    expect(current.spawnProcess.mock.calls[1][1]).not.toContain('ezdsh-safe')
    await expectSharedFilesUnchanged(sharedFiles)
    await current.manager.stop()

    const cold = createRuntime(layout)
    await expect(cold.manager.start()).resolves.toMatchObject({ phase: 'ready', mode: 'safe' })
    expect(cold.resolveInitialLaunchContext).toHaveBeenCalledOnce()
    expect(cold.spawnProcess.mock.calls[0][1]).toContain('ezdsh-safe')
    await expectSharedFilesUnchanged(sharedFiles)
  })

  it.each(['repair saved choice', 'explicit normal'] as const)('does not spawn from a corrupt choice and recovers with %s', async (recovery) => {
    const { layout, sharedFiles, controller } = await createFixture()
    await controller.enable()
    const selectionPath = join(layout.state, 'safe-mode-selection.json')
    await writeFile(selectionPath, '{')
    const { manager, spawnProcess, waitForHealthy, resolveInitialLaunchContext } = createRuntime(layout)

    await expect(manager.start()).rejects.toThrow('Cannot restore Safe Mode selection: invalid JSON')
    expect(manager.snapshot()).toMatchObject({ phase: 'failed' })
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(waitForHealthy).not.toHaveBeenCalled()
    await expect(readFile(selectionPath, 'utf8')).resolves.toBe('{')
    await expectSharedFilesUnchanged(sharedFiles)

    if (recovery === 'repair saved choice') {
      await controller.enable()
      await expect(manager.start()).resolves.toMatchObject({ phase: 'ready', mode: 'safe' })
      expect(resolveInitialLaunchContext).toHaveBeenCalledTimes(2)
      expect(spawnProcess.mock.calls[0][1]).toContain('ezdsh-safe')
    } else {
      await controller.disable()
      await expect(manager.start({ mode: 'normal' })).resolves.toMatchObject({ phase: 'ready', mode: 'normal' })
      expect(resolveInitialLaunchContext).toHaveBeenCalledOnce()
      expect(spawnProcess.mock.calls[0][1]).toContain('--patch')
    }
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(spawnProcess.mock.calls[0][2].env?.DSH_HOME).toBe(layout.harness)
    await expectSharedFilesUnchanged(sharedFiles)
  })
})
