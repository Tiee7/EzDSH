import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PluginRecoveryCoordinator } from '../../src/main/recovery/plugin-recovery-coordinator'
import { RuntimeManager, type RuntimeLaunchContext } from '../../src/main/runtime/runtime-manager'
import type { RuntimeMode, RuntimePhase } from '../../src/main/runtime/runtime-types'
import { getUserDataLayout } from '../../src/main/state/user-data'

describe('PluginRecoveryCoordinator', () => {
  it('explains that pending plugin changes need normal startup, rather than another recovery-mode restart', async () => {
    const runtime = { snapshot: () => ({ phase: 'ready' as const, mode: 'safe' as const }), stop: vi.fn(), start: vi.fn() }
    const recovery = { hasPendingTransaction: async () => true, preparePluginChange: vi.fn(), abortPendingTransaction: vi.fn(), completePendingTransaction: vi.fn(), markBootFailure: vi.fn() }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, isolationMode: { enable: vi.fn() } })
    await expect(coordinator.run({ action: 'install', entryId: 'plugin', packageName: 'plugin', profile: 'web' }, vi.fn(), vi.fn()))
      .rejects.toThrow('Start Runtime in normal mode to verify the previous plugin change')
    expect(recovery.preparePluginChange).not.toHaveBeenCalled()
  })

  it('waits for an in-flight initial mode resolver before explicitly starting Isolation Mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-isolation-resolver-'))
    let releaseContext!: (context: RuntimeLaunchContext) => void
    const gate = new Promise<RuntimeLaunchContext>((resolve) => { releaseContext = resolve })
    const resolveInitialLaunchContext = vi.fn(() => gate)
    const children: Array<ReturnType<typeof makeChild>> = []
    const makeChild = () => Object.assign(new EventEmitter(), {
      pid: 99000 + children.length, stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill(signal: NodeJS.Signals) { this.emit('exit', 0, signal); return true },
    })
    const spawnProcess = vi.fn(() => { const child = makeChild(); children.push(child); return child as never })
    const runtime = new RuntimeManager({
      layout: getUserDataLayout(root), runtimeEntryPath: '/dev/null', resolveInitialLaunchContext,
      spawnProcess, allocatePort: async () => 4567, waitForHealthy: async () => undefined,
      processKill: (pid, signal) => { children.find((child) => child.pid === Math.abs(pid))?.kill(signal); return true },
    })
    const isolationMode = { enable: vi.fn(async () => ({ dshHome: join(root, 'isolation') })) }
    const coordinator = new PluginRecoveryCoordinator({ runtime, isolationMode, recovery: {
      preparePluginChange: vi.fn(), abortPendingTransaction: vi.fn(), completePendingTransaction: vi.fn(), markBootFailure: vi.fn(),
    } })
    const startup = runtime.start()
    try {
      await vi.waitFor(() => expect(resolveInitialLaunchContext).toHaveBeenCalledOnce())
      const isolation = coordinator.startIsolationMode('manual')
      releaseContext({ mode: 'safe', profile: 'ezdsh-safe' })
      await Promise.all([startup, isolation])
      expect(runtime.snapshot()).toMatchObject({ phase: 'ready', mode: 'isolation' })
      expect(spawnProcess).toHaveBeenCalledOnce()
      expect(isolationMode.enable).toHaveBeenCalledOnce()
    } finally {
      releaseContext({ mode: 'safe', profile: 'ezdsh-safe' })
      await startup.catch(() => undefined)
      await runtime.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([
    { mode: 'normal', phase: 'ready' },
    { mode: 'safe', phase: 'ready' },
    { mode: 'isolation', phase: 'ready' },
    { mode: 'normal', phase: 'stopped' },
    { mode: 'safe', phase: 'stopped' },
    { mode: 'isolation', phase: 'stopped' },
  ] as const)('preserves $mode mode with Runtime $phase and only confirms normal-mode plugin changes', async ({ mode, phase }) => {
    const calls: string[] = []
    let currentMode: RuntimeMode = mode
    let currentPhase: RuntimePhase = phase
    const runtime = {
      snapshot: () => ({ phase: currentPhase, mode: currentMode }),
      stop: vi.fn(async () => { currentPhase = 'stopped'; calls.push('stop') }),
      start: vi.fn(async (context?: RuntimeLaunchContext) => {
        currentMode = context?.mode ?? currentMode
        currentPhase = 'ready'
        calls.push(`start:${currentMode}`)
      }),
    }
    const recovery = {
      preparePluginChange: vi.fn(async () => ({ id: 'txn-mode', kind: 'plugin-change' as const, phase: 'prepared' as const, snapshotName: 'snapshot.tar.gz' })),
      abortPendingTransaction: vi.fn(async () => undefined),
      completePendingTransaction: vi.fn(async () => { calls.push('complete') }),
      markBootFailure: vi.fn(async () => ({ phase: 'recovery-required' as const })),
    }
    const isolationMode = { enable: vi.fn(async () => ({ dshHome: '/isolation' })) }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, isolationMode })

    const outcome = await coordinator.run({
      action: 'uninstall', entryId: 'dsh-codex', packageName: 'dsh-codex', profile: 'web',
    }, async () => { calls.push('mutate'); return 'uninstalled' }, async () => { calls.push('persist') })

    expect(outcome).toEqual({ value: 'uninstalled', transactionId: 'txn-mode' })
    expect(runtime.snapshot()).toEqual({ phase, mode })
    expect(calls).toEqual([
      ...(phase === 'ready' ? ['stop'] : []),
      'mutate', 'persist',
      ...(phase === 'ready' ? [`start:${mode}`] : []),
      ...(mode === 'normal' ? ['complete'] : []),
    ])
    if (phase === 'ready') {
      expect(runtime.start).toHaveBeenCalledTimes(1)
      if (mode === 'normal') expect(runtime.start).toHaveBeenCalledWith({ mode: 'normal' })
      else expect(runtime.start).toHaveBeenCalledWith()
    } else {
      expect(runtime.start).not.toHaveBeenCalled()
    }
    expect(recovery.completePendingTransaction).toHaveBeenCalledTimes(mode === 'normal' ? 1 : 0)
    expect(recovery.abortPendingTransaction).not.toHaveBeenCalled()
    expect(recovery.markBootFailure).not.toHaveBeenCalled()
    expect(isolationMode.enable).not.toHaveBeenCalled()
  })

  it('preserves the plugin snapshot without automatically starting Isolation Mode when normal health fails', async () => {
    const calls: string[] = []
    const runtime = {
      snapshot: () => ({ phase: 'ready', mode: 'normal' }),
      stop: vi.fn(async () => { calls.push('stop') }),
      start: vi.fn(async (context?: { mode?: string }) => {
        calls.push(`start:${context?.mode ?? 'normal'}`)
        if (context?.mode === 'normal') throw new Error('plugin boot failure')
        return { phase: 'ready', mode: 'isolation' }
      }),
    }
    const recovery = {
      preparePluginChange: vi.fn(async () => ({ id: 'txn-1', kind: 'plugin-change', phase: 'prepared', snapshotName: 'snapshot.tar.gz' })),
      abortPendingTransaction: vi.fn(async () => undefined),
      completePendingTransaction: vi.fn(async () => undefined),
      markBootFailure: vi.fn(async () => ({ phase: 'recovery-required' })),
    }
    const isolationMode = {
      enable: vi.fn(async () => ({ dshHome: '/state/isolation-mode/harness', status: { active: true, excludedPluginCount: 1 } })),
    }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, isolationMode })

    await expect(coordinator.run({
      action: 'install', entryId: 'agent-teams', packageName: '@nanmicoder/dsh-agent-teams', profile: 'web',
    }, async () => {
      calls.push('mutate')
      return 'installed'
    }, async () => undefined)).rejects.toThrow('plugin boot failure')

    expect(calls).toEqual(['stop', 'mutate', 'start:normal'])
    expect(recovery.preparePluginChange).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'agent-teams', action: 'install' }))
    expect(recovery.markBootFailure).toHaveBeenCalledWith('plugin boot failure')
    expect(recovery.abortPendingTransaction).not.toHaveBeenCalled()
    expect(isolationMode.enable).not.toHaveBeenCalled()
  })

  it('clears a transaction when the installer command itself fails', async () => {
    const runtime = {
      snapshot: () => ({ phase: 'stopped', mode: 'normal' }),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ phase: 'ready', mode: 'normal' })),
    }
    const recovery = {
      preparePluginChange: vi.fn(async () => ({ id: 'txn-2', kind: 'plugin-change', phase: 'prepared', snapshotName: 'snapshot.tar.gz' })),
      abortPendingTransaction: vi.fn(async () => undefined),
      completePendingTransaction: vi.fn(async () => undefined),
      markBootFailure: vi.fn(async () => ({ phase: 'recovery-required' })),
    }
    const isolationMode = { enable: vi.fn(async () => ({ dshHome: '/isolation', status: { active: true, excludedPluginCount: 0 } })) }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, isolationMode })

    await expect(coordinator.run({
      action: 'uninstall', entryId: 'agent-teams', packageName: '@nanmicoder/dsh-agent-teams', profile: 'web',
    }, async () => { throw new Error('pnpm refused') }, async () => undefined)).rejects.toThrow('pnpm refused')

    expect(recovery.abortPendingTransaction).toHaveBeenCalledTimes(1)
    expect(recovery.markBootFailure).not.toHaveBeenCalled()
    expect(isolationMode.enable).not.toHaveBeenCalled()
  })

  it.each(['normal', 'safe', 'isolation'] as const)('keeps %s Runtime running during plugin installation and persists before deferring restart', async (mode) => {
    const calls: string[] = []
    const runtime = {
      snapshot: () => ({ phase: 'ready', mode }),
      stop: vi.fn(async () => { calls.push('stop') }),
      start: vi.fn(async () => { calls.push('start:normal'); return { phase: 'ready', mode: 'normal' as const } }),
    }
    const recovery = {
      preparePluginChange: vi.fn(async () => ({ id: 'txn-deferred', kind: 'plugin-change' as const, phase: 'prepared' as const, snapshotName: 'snapshot.tar.gz' })),
      abortPendingTransaction: vi.fn(async () => undefined),
      completePendingTransaction: vi.fn(async () => undefined),
      markBootFailure: vi.fn(async () => ({ phase: 'recovery-required' as const })),
    }
    const isolationMode = { enable: vi.fn(async () => ({ dshHome: '/isolation' })) }
    const persist = vi.fn(async (value: string) => { calls.push(`persist:${value}`) })
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, isolationMode })

    const outcome = await coordinator.run({
      action: 'install', entryId: 'dsh-codex', packageName: 'dsh-codex', profile: 'web',
    }, async () => {
      calls.push('mutate')
      return 'installed'
    }, persist, { deferRuntimeRestart: true })

    expect(outcome).toMatchObject({ value: 'installed', transactionId: 'txn-deferred' })
    expect(calls).toEqual(['mutate', 'persist:installed'])
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    expect(recovery.completePendingTransaction).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledWith('installed')
  })

  it('coalesces concurrent explicit Isolation Mode start requests', async () => {
    let releaseEnable: (() => void) | undefined
    const enableGate = new Promise<void>((resolve) => { releaseEnable = resolve })
    const runtime = {
      snapshot: () => ({ phase: 'stopped', mode: 'normal' }),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ phase: 'ready', mode: 'isolation' })),
    }
    const recovery = {
      preparePluginChange: vi.fn(),
      abortPendingTransaction: vi.fn(),
      completePendingTransaction: vi.fn(),
      markBootFailure: vi.fn(),
    }
    const isolationMode = {
      enable: vi.fn(async () => {
        await enableGate
        return { dshHome: '/isolation', status: { active: true, excludedPluginCount: 0 } }
      }),
    }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, isolationMode })

    const first = coordinator.startIsolationMode('plugin-recovery')
    const second = coordinator.startIsolationMode('plugin-recovery')

    await vi.waitFor(() => expect(isolationMode.enable).toHaveBeenCalledTimes(1))
    releaseEnable?.()
    await Promise.all([first, second])
    expect(runtime.start).toHaveBeenCalledTimes(1)
  })
})
