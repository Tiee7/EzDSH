import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('does not spawn a Runtime after shutdown is requested during startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-start-stop-race-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    let releasePort: (() => void) | undefined
    const portReady = new Promise<void>((resolve) => { releasePort = resolve })
    const spawnProcess = vi.fn(() => {
      throw new Error('Runtime must not be spawned after shutdown is requested')
    })
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      allocatePort: async () => {
        await portReady
        return 4567
      },
      spawnProcess,
    })

    const startPromise = manager.start()
    const stopPromise = manager.stop()
    releasePort?.()

    await expect(startPromise).resolves.toMatchObject({ phase: 'stopped' })
    await stopPromise
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('records an early startup failure in the Runtime log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-early-failure-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      allocatePort: async () => {
        throw new Error('Unable to allocate a loopback port')
      }
    })

    await expect(manager.start()).rejects.toThrow('Unable to allocate a loopback port')
    expect(manager.snapshot()).toMatchObject({
      phase: 'failed',
      message: 'Unable to allocate a loopback port',
      logPath: join(layout.logs, 'harness.log')
    })
    await expect(readFile(join(layout.logs, 'harness.log'), 'utf8')).resolves.toContain('Unable to allocate a loopback port')
  })

  it('runs the compatibility hook before every Runtime startup attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-before-start-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const beforeStart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      allocatePort: async () => {
        throw new Error('startup blocked for test')
      },
      beforeStart,
    })

    await expect(manager.start()).rejects.toThrow('startup blocked for test')
    expect(beforeStart).toHaveBeenCalledOnce()
  })

  it('includes the child Runtime output in a startup failure for recovery diagnosis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-child-failure-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 12347,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      allocatePort: async () => 4567,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr.emit('data', 'failed to import loader entry 2bf082d6 (mode-menu-plus): client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')
          child.emit('exit', 1, null)
        })
        return child as never
      },
    })

    await expect(manager.start()).rejects.toThrow(/mode-menu-plus.*missed the module table/i)
    expect(manager.snapshot().message).toMatch(/mode-menu-plus.*missed the module table/i)
  })

  it('uses the published Runtime during development when it is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-path-'))
    roots.push(root)
    const publishedEntry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(publishedEntry, '')

    expect(resolveRuntimeEntryPath({
      appPath: root,
      isPackaged: false
    })).toBe(publishedEntry)
  })

  it('requires an explicit source override when the published Runtime is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-source-'))
    roots.push(root)

    expect(() => resolveRuntimeEntryPath({
      appPath: root,
      isPackaged: false
    })).toThrow(/published DSH Runtime is missing/i)

    await mkdir(join(root, 'source-runtime', 'lib'), { recursive: true })
    await writeFile(join(root, 'source-runtime', 'lib', 'bin.js'), '')
    expect(resolveRuntimeEntryPath({
      appPath: root,
      isPackaged: false,
      developmentSourceRoot: join(root, 'source-runtime')
    })).toBe(join(root, 'source-runtime', 'lib', 'bin.js'))
  })

  it('uses the built vendored Runtime during development when it is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-vendored-source-'))
    roots.push(root)
    const sourceEntry = join(root, 'vendor', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
    await mkdir(join(root, 'vendor', 'deepseek-harness', 'apps', 'cli', 'lib'), { recursive: true })
    await writeFile(sourceEntry, '')
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')

    expect(resolveRuntimeEntryPath({
      appPath: root,
      isPackaged: false
    })).toBe(sourceEntry)
  })

  it('resolves the staged source Runtime inside packaged Electron app resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-packaged-source-'))
    roots.push(root)
    const stagedEntry = join(root, 'out', 'dsh-runtime', 'lib', 'bin.js')
    await mkdir(join(root, 'out', 'dsh-runtime', 'lib'), { recursive: true })
    await writeFile(stagedEntry, '')

    expect(resolveRuntimeEntryPath({
      appPath: root,
      resourcesPath: join(root, 'resources'),
      isPackaged: true
    })).toBe(stagedEntry)
  })

  it('falls back to the published Runtime when packaged source staging is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-packaged-published-'))
    roots.push(root)
    const publishedEntry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(publishedEntry, '')

    expect(resolveRuntimeEntryPath({
      appPath: root,
      isPackaged: true
    })).toBe(publishedEntry)
  })

  it('resolves the packaged Node executable inside the Electron app resources', () => {
    expect(resolveRuntimeCommandPath({
      appPath: '/Applications/EzDSH.app/Contents/Resources/app',
      resourcesPath: '/Applications/EzDSH.app/Contents/Resources',
      isPackaged: true,
      platform: 'darwin'
    })).toBe('/Applications/EzDSH.app/Contents/Resources/app/out/node-runtime/bin/node')
  })

  it('resolves the standalone Node executable during development', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-dev-node-'))
    roots.push(root)
    const executable = join(root, 'node_modules', 'node-bin-darwin-arm64', 'bin', 'node')
    await mkdir(join(root, 'node_modules', 'node-bin-darwin-arm64', 'bin'), { recursive: true })
    await writeFile(executable, '')

    expect(resolveRuntimeCommandPath({
      appPath: root,
      isPackaged: false,
      platform: 'darwin',
      arch: 'arm64'
    })).toBe(executable)
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
    const ownership = {
      register: vi.fn(),
      unregister: vi.fn(),
    }
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      appVersion: '1.8.1540',
      runtimeVersion: '0.1.3-alpha.1',
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 1_000,
      allocatePort: async () => 4567,
      waitForHealthy: async () => undefined,
      runtimeOwnership: ownership,
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
    expect(spawnedArgs).toContain('--no-open')
    expect(spawnedOptions?.detached).toBe(process.platform !== 'win32')
    expect(spawnedOptions?.env?.EZDSH_RUNTIME_OWNER).toBe('EzDSH')
    expect(ownership.register).toHaveBeenCalledWith(12345)

    await manager.stop()
    expect(manager.snapshot().phase).toBe('stopped')
    expect(ownership.unregister).toHaveBeenCalledWith(12345)
    if (process.platform !== 'win32') expect(processSignals).toContainEqual([-12345, 'SIGTERM'])
    await expect(import('node:fs/promises').then(({ access }) => access(layout.harness))).resolves.toBeUndefined()
    const runtimeLog = await readFile(join(layout.logs, 'harness.log'), 'utf8')
    expect(runtimeLog).toContain('appVersion=1.8.1540')
    expect(runtimeLog).toContain('runtimeVersion=0.1.3-alpha.1')
    expect(runtimeLog).toContain('runtimeEntryPath=/dev/null')
    expect(runtimeLog).toContain(`DSH_HOME=${layout.harness}`)
  })

  it('uses the tokenized Runtime URL announced by dsh web for its default health check and ready snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-token-url-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 12346,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal: NodeJS.Signals): boolean {
        this.emit('exit', 0, signal)
        return true
      }
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('manifest', { status: 200 }))
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      allocatePort: async () => 4567,
      fetchImpl,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.emit('data', 'dsh web: http://127.0.0.1:4567/?token=runtime-token\n')
        })
        return child as never
      },
      processKill: (_pid, signal) => {
        child.emit('exit', 0, signal)
        return true
      }
    })

    const ready = await manager.start()

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/manifest.webmanifest',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(ready.url).toBe('http://127.0.0.1:4567/?token=runtime-token')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await manager.stop()
    const runtimeLog = await readFile(join(layout.logs, 'harness.log'), 'utf8')
    expect(runtimeLog).not.toContain('token=runtime-token')
    expect(runtimeLog).toContain('token=[REDACTED]')
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

  it('ignores a late exit from the previous Runtime after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-restart-race-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const makeChild = (pid: number) => Object.assign(new EventEmitter(), {
      pid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(): boolean {
        return true
      }
    })
    const firstChild = makeChild(11001)
    const secondChild = makeChild(11002)
    let spawnCount = 0
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      startupTimeoutMs: 2_000,
      stopTimeoutMs: 10,
      allocatePort: async () => 4567,
      waitForHealthy: async () => undefined,
      processKill: () => true,
      spawnProcess: () => {
        spawnCount += 1
        return (spawnCount === 1 ? firstChild : secondChild) as never
      }
    })

    await manager.start()
    const restarted = await manager.restart()
    expect(restarted.pid).toBe(11002)

    firstChild.emit('exit', 0, 'SIGTERM')

    expect(manager.snapshot().phase).toBe('ready')
    expect(manager.snapshot().pid).toBe(11002)
  })

  it('starts a Safe Mode Runtime against its isolated DSH home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-safe-mode-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 12001,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal: NodeJS.Signals): boolean {
        this.emit('exit', 0, signal)
        return true
      }
    })
    let spawnedOptions: import('node:child_process').SpawnOptions | undefined
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      allocatePort: async () => 4567,
      waitForHealthy: async () => undefined,
      spawnProcess: (_command, _args, options) => {
        spawnedOptions = options
        return child as never
      }
    })

    const ready = await manager.start({ mode: 'safe', dshHome: join(root, 'safe-mode-home') } as never)

    expect(spawnedOptions?.env?.DSH_HOME).toBe(join(root, 'safe-mode-home'))
    expect((ready as { mode?: string }).mode).toBe('safe')
    await manager.stop()
  })

  it('uses the current environment provider on every Runtime launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-environment-'))
    roots.push(root)
    const layout = getUserDataLayout(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 13001,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal: NodeJS.Signals): boolean {
        this.emit('exit', 0, signal)
        return true
      }
    })
    let environment = { HTTP_PROXY: 'http://first.invalid' }
    const spawnedEnvironments: Array<NodeJS.ProcessEnv | undefined> = []
    const manager = new RuntimeManager({
      layout,
      runtimeEntryPath: '/dev/null',
      command: process.execPath,
      allocatePort: async () => 4567,
      waitForHealthy: async () => undefined,
      getEnvironment: () => environment,
      spawnProcess: (_command, _args, options) => {
        spawnedEnvironments.push(options.env)
        return child as never
      }
    })

    await manager.start()
    await manager.stop()
    environment = { HTTP_PROXY: 'http://second.invalid' }
    await manager.start()

    expect(spawnedEnvironments).toEqual([
      expect.objectContaining({ HTTP_PROXY: 'http://first.invalid' }),
      expect.objectContaining({ HTTP_PROXY: 'http://second.invalid' }),
    ])
    await manager.stop()
  })
})
