import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveRuntimeCommandPath,
  resolveRuntimeEntryPath,
  RuntimeManager
} from '../../src/main/runtime/runtime-manager'
import { getUserDataLayout } from '../../src/main/state/user-data'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RuntimeManager', () => {
  it('uses the staged Runtime during development when it is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-path-'))
    roots.push(root)
    const stagedEntry = join(root, 'out', 'dsh-runtime', 'lib', 'bin.js')
    await mkdir(join(root, 'out', 'dsh-runtime', 'lib'), { recursive: true })
    await writeFile(stagedEntry, '')

    expect(resolveRuntimeEntryPath({
      appPath: root,
      isPackaged: false
    })).toBe(stagedEntry)
  })

  it('resolves the packaged Runtime inside the Electron app resources', () => {
    expect(resolveRuntimeEntryPath({
      appPath: '/Applications/EzDSH.app/Contents/Resources/app',
      resourcesPath: '/Applications/EzDSH.app/Contents/Resources',
      isPackaged: true
    })).toBe('/Applications/EzDSH.app/Contents/Resources/app.asar.unpacked/out/dsh-runtime/lib/bin.js')
  })

  it('resolves the packaged Node executable inside the Electron app resources', () => {
    expect(resolveRuntimeCommandPath({
      appPath: '/Applications/EzDSH.app/Contents/Resources/app',
      resourcesPath: '/Applications/EzDSH.app/Contents/Resources',
      isPackaged: true,
      platform: 'darwin'
    })).toBe('/Applications/EzDSH.app/Contents/Resources/app.asar.unpacked/out/node-runtime/bin/node')
  })

  it('starts, reports ready, and stops without removing the harness directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal: NodeJS.Signals): boolean {
        this.emit('exit', 0, signal)
        return true
      }
    })
    let spawnedArgs: readonly string[] = []
    let spawnedOptions: import('node:child_process').SpawnOptions | undefined
    const processSignals: Array<[number, NodeJS.Signals]> = []
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 1_000,
      allocatePort: async () => 4567,
      waitForHealthy: async () => undefined,
      spawnProcess: (_command, args, options) => {
        spawnedArgs = args
        spawnedOptions = options
        return child as never
      },
      processKill: (pid, signal) => {
        processSignals.push([pid, signal as NodeJS.Signals])
        child.emit('exit', 0, signal)
        return true
      }
    })

    const ready = await manager.start()
    expect(ready.phase).toBe('ready')
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(spawnedArgs[0]).toBe('--expose-internals')
    expect(spawnedOptions?.detached).toBe(process.platform !== 'win32')

    await manager.stop()
    expect(manager.snapshot().phase).toBe('stopped')
    if (process.platform !== 'win32') expect(processSignals).toContainEqual([-12345, 'SIGTERM'])
    await expect(import('node:fs/promises').then(({ access }) => access(layout.harness))).resolves.toBeUndefined()
  })

  it('increments the port and starts a new Runtime when the selected port is occupied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-port-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const makeChild = (pid: number) => Object.assign(new EventEmitter(), {
      pid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal: NodeJS.Signals): boolean {
        this.emit('exit', 0, signal)
        return true
      }
    })
    const firstChild = makeChild(10001)
    const secondChild = makeChild(10002)
    const attemptedPorts: number[] = []
    let spawnCount = 0
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 1_000,
      allocatePort: async () => 4567,
      waitForHealthy: async (url) => {
        if (url.endsWith(':4567')) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new Error('health check interrupted by occupied port')
        }
      },
      spawnProcess: (_command, args) => {
        const portIndex = args.indexOf('--port')
        attemptedPorts.push(Number(args[portIndex + 1]))
        spawnCount += 1
        if (spawnCount === 1) {
          queueMicrotask(() => {
            firstChild.stderr.emit('data', 'Error: listen EADDRINUSE: address already in use')
            firstChild.emit('exit', 1, null)
          })
          return firstChild as never
        }
        return secondChild as never
      }
    })

    const ready = await manager.start()

    expect(attemptedPorts).toEqual([4567, 4568])
    expect(ready.phase).toBe('ready')
    expect(ready.port).toBe(4568)
    await manager.stop()
  })
})
