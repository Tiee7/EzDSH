import { describe, expect, it, vi } from 'vitest'
import { PluginRecoveryCoordinator } from '../../src/main/recovery/plugin-recovery-coordinator'

describe('PluginRecoveryCoordinator', () => {
  it('preserves the plugin snapshot and starts Safe Mode when normal health fails', async () => {
    const calls: string[] = []
    const runtime = {
      snapshot: () => ({ phase: 'ready', mode: 'normal' }),
      stop: vi.fn(async () => { calls.push('stop') }),
      start: vi.fn(async (context?: { mode?: string }) => {
        calls.push(`start:${context?.mode ?? 'normal'}`)
        if (context?.mode === 'normal') throw new Error('plugin boot failure')
        return { phase: 'ready', mode: 'safe' }
      }),
    }
    const recovery = {
      preparePluginChange: vi.fn(async () => ({ id: 'txn-1', kind: 'plugin-change', phase: 'prepared', snapshotName: 'snapshot.tar.gz' })),
      abortPendingTransaction: vi.fn(async () => undefined),
      completePendingTransaction: vi.fn(async () => undefined),
      markBootFailure: vi.fn(async () => ({ phase: 'recovery-required' })),
    }
    const safeMode = {
      enable: vi.fn(async () => ({ dshHome: '/state/safe-mode/harness', status: { active: true, excludedPluginCount: 1 } })),
    }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, safeMode })

    await expect(coordinator.run({
      action: 'install', entryId: 'agent-teams', packageName: '@nanmicoder/dsh-agent-teams', profile: 'web',
    }, async () => {
      calls.push('mutate')
      return 'installed'
    })).rejects.toThrow('plugin boot failure')

    expect(calls).toEqual(['stop', 'mutate', 'start:normal', 'stop', 'start:safe'])
    expect(recovery.preparePluginChange).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'agent-teams', action: 'install' }))
    expect(recovery.markBootFailure).toHaveBeenCalledWith('plugin boot failure')
    expect(recovery.abortPendingTransaction).not.toHaveBeenCalled()
    expect(safeMode.enable).toHaveBeenCalledWith('plugin-recovery')
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
    const safeMode = { enable: vi.fn(async () => ({ dshHome: '/safe', status: { active: true, excludedPluginCount: 0 } })) }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, safeMode })

    await expect(coordinator.run({
      action: 'uninstall', entryId: 'agent-teams', packageName: '@nanmicoder/dsh-agent-teams', profile: 'web',
    }, async () => { throw new Error('pnpm refused') })).rejects.toThrow('pnpm refused')

    expect(recovery.abortPendingTransaction).toHaveBeenCalledTimes(1)
    expect(recovery.markBootFailure).not.toHaveBeenCalled()
    expect(safeMode.enable).not.toHaveBeenCalled()
  })

  it('coalesces concurrent Safe Mode start requests after the same boot failure', async () => {
    let releaseEnable: (() => void) | undefined
    const enableGate = new Promise<void>((resolve) => { releaseEnable = resolve })
    const runtime = {
      snapshot: () => ({ phase: 'stopped', mode: 'normal' }),
      stop: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ phase: 'ready', mode: 'safe' })),
    }
    const recovery = {
      preparePluginChange: vi.fn(),
      abortPendingTransaction: vi.fn(),
      completePendingTransaction: vi.fn(),
      markBootFailure: vi.fn(),
    }
    const safeMode = {
      enable: vi.fn(async () => {
        await enableGate
        return { dshHome: '/safe', status: { active: true, excludedPluginCount: 0 } }
      }),
    }
    const coordinator = new PluginRecoveryCoordinator({ runtime, recovery, safeMode })

    const first = coordinator.startSafeMode('plugin-recovery')
    const second = coordinator.startSafeMode('plugin-recovery')

    expect(safeMode.enable).toHaveBeenCalledTimes(1)
    releaseEnable?.()
    await Promise.all([first, second])
    expect(runtime.start).toHaveBeenCalledTimes(1)
  })
})
