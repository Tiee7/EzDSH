import { describe, expect, it, vi } from 'vitest'
import { DshRuntimeProcessManager } from '../../src/main/runtime/runtime-process-manager'

const psFixture = [
  ' 101     1   99 Thu Aug 20 02:01:51 2026 node out/dsh-runtime/lib/bin.js web --host 127.0.0.1 --port 0',
  ' 202     1  200 Wed Aug 26 10:55:29 2026 node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 60682 --no-open',
  ' 303     1  300 Wed Aug 26 10:55:29 2026 node node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 60683 --no-open',
].join('\n')

const lsofFixture = [
  'p101',
  'f15',
  'n127.0.0.1:50256',
  'p202',
  'f16',
  'n127.0.0.1:60682',
  'p303',
  'f17',
  'n127.0.0.1:60683',
].join('\n')

function createManager(options: Partial<ConstructorParameters<typeof DshRuntimeProcessManager>[0]> = {}) {
  return new DshRuntimeProcessManager({
    platform: 'darwin',
    runCommand: vi.fn(async (command: string) => command === 'ps' ? psFixture : lsofFixture),
    getCurrentPid: () => 202,
    listOwnedPids: () => new Set([101]),
    ...options,
  })
}

describe('DshRuntimeProcessManager', () => {
  it('lists only DSH web runtimes and resolves an ephemeral port from listening sockets', async () => {
    const runtimes = await createManager().list()

    expect(runtimes).toHaveLength(3)
    expect(runtimes[0]).toMatchObject({
      pid: 101,
      ppid: 1,
      pgid: 99,
      port: 50256,
      command: expect.stringContaining('out/dsh-runtime/lib/bin.js'),
      current: false,
      ownedByEzDSH: true,
    })
    expect(runtimes[0]?.startedAt).toBe('Thu Aug 20 02:01:51 2026')
    expect(runtimes[1]).toMatchObject({
      pid: 202,
      port: 60682,
      current: true,
      ownedByEzDSH: true,
    })
    expect(runtimes[2]).toMatchObject({ pid: 303, port: 60683, current: false, ownedByEzDSH: false })
  })

  it('stops a validated non-current runtime process group and escalates when it stays alive', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    const manager = createManager({
      processKill: (pid, signal) => {
        signals.push([pid, signal])
        return true
      },
      processAlive: () => true,
      stopTimeoutMs: 1,
    })

    await manager.stop(101)

    expect(signals).toEqual([
      [-99, 'SIGTERM'],
      [-99, 'SIGKILL'],
    ])
  })

  it('rejects stopping the current Runtime because it must be restarted instead', async () => {
    const stopCurrent = vi.fn(async () => undefined)
    const manager = createManager({ stopCurrent })

    await expect(manager.stop(202)).rejects.toThrow(/must be restarted/i)
    expect(stopCurrent).not.toHaveBeenCalled()
  })

  it('falls back to the process PID instead of ever signalling process group 1', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    const manager = createManager({
      runCommand: vi.fn(async (command: string) => command === 'ps'
        ? psFixture.replace('  99 ', '   1 ')
        : lsofFixture),
      processKill: (pid, signal) => {
        signals.push([pid, signal])
        return true
      },
      processAlive: () => false,
    })

    await manager.stop(101)

    expect(signals).toContainEqual([-101, 'SIGTERM'])
    expect(signals).not.toContainEqual([-1, 'SIGTERM'])
  })

  it('stops the current manager and every remaining DSH runtime during shutdown', async () => {
    let currentPid: number | undefined = 202
    const stopCurrent = vi.fn(async () => { currentPid = undefined })
    const signals: Array<[number, NodeJS.Signals]> = []
    const manager = createManager({
      getCurrentPid: () => currentPid,
      stopCurrent,
      processKill: (pid, signal) => {
        signals.push([pid, signal])
        return true
      },
      processAlive: () => false,
    })

    await manager.stopAll()

    expect(stopCurrent).toHaveBeenCalledOnce()
    expect(signals).toContainEqual([-99, 'SIGTERM'])
    expect(signals).not.toContainEqual([-202, 'SIGTERM'])
    expect(signals).not.toContainEqual([-300, 'SIGTERM'])
  })
})
