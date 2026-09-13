import { describe, expect, it, vi } from 'vitest'
import { RecoveryRestoreCoordinator } from '../../src/main/recovery/recovery-restore-coordinator'
import type { RecoveryRestoreResult } from '../../src/main/recovery/recovery-manager'
import type { RuntimeMode } from '../../src/main/runtime/runtime-types'

const result: RecoveryRestoreResult = {
  dryRun: false,
  snapshotName: 'selected.tar.gz',
  restoredAt: '2026-09-13T08:00:00.000Z',
  preRestoreSnapshotName: 'before-restore.tar.gz',
  missingCredentials: [],
  entries: ['harness/settings.yaml'],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('RecoveryRestoreCoordinator', () => {
  it('blocks even a synchronous startup request from stopComponents until restore and mode preparation finish', async () => {
    const stopped = deferred<void>()
    const restored = deferred<RecoveryRestoreResult>()
    const prepared = deferred<void>()
    const calls: string[] = []
    const start = vi.fn(() => { calls.push('start') })
    let startup: Promise<void> | undefined
    const options = {
      getMode: vi.fn(() => 'safe' as const),
      stopComponents: vi.fn(() => {
        calls.push('stop')
        startup = coordinator.waitUntilReady().then(start)
        return stopped.promise
      }),
      restore: vi.fn(() => { calls.push('restore'); return restored.promise }),
      prepareMode: vi.fn(() => { calls.push('prepare'); return prepared.promise }),
    }
    const coordinator = new RecoveryRestoreCoordinator(options)

    const restoring = coordinator.restore('selected.tar.gz')
    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    expect(options.restore).not.toHaveBeenCalled()
    stopped.resolve(undefined)
    await vi.waitFor(() => expect(options.restore).toHaveBeenCalledWith('selected.tar.gz'))
    expect(options.prepareMode).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    restored.resolve(result)
    await vi.waitFor(() => expect(options.prepareMode).toHaveBeenCalledWith('safe'))
    expect(start).not.toHaveBeenCalled()

    prepared.resolve(undefined)
    await expect(restoring).resolves.toBe(result)
    await startup
    expect(start).toHaveBeenCalledOnce()
    expect(calls).toEqual(['stop', 'restore', 'prepare', 'start'])
  })

  it.each(['stop', 'restore', 'prepare'] as const)('rejects a waiting startup when %s fails, then permits a complete retry', async (stage) => {
    const failure = new Error(`${stage} failed`)
    const failedStage = deferred<void>()
    let fail = true
    const options = {
      getMode: vi.fn(() => 'isolation' as const),
      stopComponents: vi.fn(async () => { if (stage === 'stop' && fail) await failedStage.promise }),
      restore: vi.fn(async () => { if (stage === 'restore' && fail) await failedStage.promise; return result }),
      prepareMode: vi.fn(async () => { if (stage === 'prepare' && fail) await failedStage.promise }),
    }
    const coordinator = new RecoveryRestoreCoordinator(options)
    const start = vi.fn()
    const restoring = coordinator.restore('selected.tar.gz')
    const startup = coordinator.waitUntilReady().then(start)
    const restoreRejection = expect(restoring).rejects.toBe(failure)
    const startupRejection = expect(startup).rejects.toBe(failure)
    const target = stage === 'stop' ? options.stopComponents : stage === 'restore' ? options.restore : options.prepareMode
    await vi.waitFor(() => expect(target).toHaveBeenCalledOnce())

    failedStage.reject(failure)

    await restoreRejection
    await startupRejection
    expect(start).not.toHaveBeenCalled()
    if (stage === 'stop') expect(options.restore).not.toHaveBeenCalled()
    if (stage !== 'prepare') expect(options.prepareMode).not.toHaveBeenCalled()

    fail = false
    const retry = coordinator.restore('selected.tar.gz')
    const retryStartup = coordinator.waitUntilReady().then(start)
    await expect(retry).resolves.toBe(result)
    await retryStartup
    expect(start).toHaveBeenCalledOnce()
  })

  it('rejects concurrent restores without stopping components twice and releases the gate after success', async () => {
    const stopped = deferred<void>()
    const options = {
      getMode: vi.fn(() => 'safe' as const),
      stopComponents: vi.fn(() => stopped.promise),
      restore: vi.fn(async () => result),
      prepareMode: vi.fn(async () => undefined),
    }
    const coordinator = new RecoveryRestoreCoordinator(options)
    const first = coordinator.restore('selected.tar.gz')

    await expect(coordinator.restore('another.tar.gz')).rejects.toThrow(/already in progress/i)
    expect(options.getMode).toHaveBeenCalledOnce()
    expect(options.stopComponents).toHaveBeenCalledOnce()
    expect(options.restore).not.toHaveBeenCalled()
    stopped.resolve(undefined)
    await first

    await expect(coordinator.restore('another.tar.gz')).resolves.toBe(result)
    expect(options.restore.mock.calls).toEqual([['selected.tar.gz'], ['another.tar.gz']])
    await expect(coordinator.waitUntilReady()).resolves.toBeUndefined()
  })

  it.each(['normal', 'safe', 'isolation'] as const)('prepares the captured %s mode without selecting a different mode after stop', async (mode) => {
    let currentMode: RuntimeMode = mode
    const prepareMode = vi.fn(async () => undefined)
    const coordinator = new RecoveryRestoreCoordinator({
      getMode: () => currentMode,
      stopComponents: async () => { currentMode = mode === 'normal' ? 'safe' : 'normal' },
      restore: async () => result,
      prepareMode,
    })

    await expect(coordinator.restore('selected.tar.gz')).resolves.toBe(result)

    expect(prepareMode).toHaveBeenCalledExactlyOnceWith(mode)
  })

  it('rejects waiting startup when reading the current mode throws and releases the gate for retry', async () => {
    const failure = new Error('Mode unavailable')
    const getMode = vi.fn<() => RuntimeMode>()
      .mockImplementationOnce(() => { throw failure })
      .mockReturnValue('normal')
    const stopComponents = vi.fn(async () => undefined)
    const coordinator = new RecoveryRestoreCoordinator({
      getMode,
      stopComponents,
      restore: async () => result,
      prepareMode: async () => undefined,
    })
    const start = vi.fn()
    const restoring = coordinator.restore('selected.tar.gz')
    const startup = coordinator.waitUntilReady().then(start)

    await expect(restoring).rejects.toBe(failure)
    await expect(startup).rejects.toBe(failure)
    expect(stopComponents).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    await expect(coordinator.restore('selected.tar.gz')).resolves.toBe(result)
  })

  it('allows startup immediately when no restoration is pending', async () => {
    const options = {
      getMode: vi.fn(() => 'normal' as const),
      stopComponents: vi.fn(async () => undefined),
      restore: vi.fn(async () => result),
      prepareMode: vi.fn(async () => undefined),
    }
    const coordinator = new RecoveryRestoreCoordinator(options)

    await expect(coordinator.waitUntilReady()).resolves.toBeUndefined()

    expect(options.getMode).not.toHaveBeenCalled()
    expect(options.stopComponents).not.toHaveBeenCalled()
  })
})
