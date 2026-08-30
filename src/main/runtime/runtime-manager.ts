import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'
import { ensureUserDataLayout } from '../state/user-data.js'
import { waitForRuntimeHealthy } from './health-check.js'
import type { RuntimeMode, RuntimeSnapshot } from './runtime-types.js'
import {
  EZDSH_RUNTIME_OWNER_ENV,
  EZDSH_RUNTIME_OWNER_VALUE,
  type RuntimeOwnershipStore,
} from './runtime-process-manager.js'

export interface RuntimePathOptions {
  appPath: string
  resourcesPath?: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  developmentSourceRoot?: string
}

const runtimePackageByTarget: Record<string, string> = {
  'darwin-arm64': 'node-bin-darwin-arm64',
  'win32-x64': 'node-win-x64'
}

/** Resolve the published or explicitly selected source Runtime without consulting user PATH. */
export function resolveRuntimeEntryPath(options: RuntimePathOptions): string {
  if (options.isPackaged) {
    return join(options.appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }

  if (options.developmentSourceRoot !== undefined) {
    const sourceEntry = join(resolve(options.developmentSourceRoot), 'lib', 'bin.js')
    if (!existsSync(sourceEntry)) {
      throw new Error(`Development DSH Runtime source is missing lib/bin.js at ${options.developmentSourceRoot}`)
    }
    return sourceEntry
  }

  const publishedEntry = join(options.appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(publishedEntry)) return publishedEntry

  throw new Error(`Published DSH Runtime is missing lib/bin.js at ${publishedEntry}; run npm ci or set EZDSH_DSH_SOURCE for source development`)
}

/** Resolve the standalone Node executable used by Runtime processes. */
export function resolveRuntimeCommandPath(options: RuntimePathOptions): string | undefined {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const executable = platform === 'win32' ? 'node.exe' : 'node'

  if (options.isPackaged) {
    return join(options.appPath, 'out', 'node-runtime', 'bin', executable)
  }

  const runtimePackage = runtimePackageByTarget[`${platform}-${arch}`]
  if (runtimePackage === undefined) return undefined
  const developmentRuntime = join(options.appPath, 'node_modules', runtimePackage, 'bin', executable)
  if (!existsSync(developmentRuntime)) {
    throw new Error(`Standalone Node Runtime is missing at ${developmentRuntime}; run npm ci for ${platform}-${arch}`)
  }
  return developmentRuntime
}

export interface RuntimeManagerOptions {
  layout: UserDataLayout
  runtimeEntryPath: string
  command?: string
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  portRetryCount?: number
  fetchImpl?: typeof fetch
  waitForHealthy?: typeof waitForRuntimeHealthy
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  processKill?: (pid: number, signal: NodeJS.Signals) => boolean
  allocatePort?: () => Promise<number>
  runtimeOwnership?: RuntimeOwnershipStore
  getEnvironment?: () => NodeJS.ProcessEnv
}

export interface RuntimeLaunchContext {
  mode?: RuntimeMode
  dshHome?: string
}

interface ResolvedRuntimeLaunchContext {
  mode: RuntimeMode
  dshHome: string
}

type RuntimeListener = (snapshot: RuntimeSnapshot) => void

const initialSnapshot = (layout: UserDataLayout): RuntimeSnapshot => ({
  phase: 'idle',
  mode: 'normal',
  launchDirectory: layout.launchRoot,
  logPath: join(layout.logs, 'harness.log')
})

class RuntimePortOccupiedError extends Error {
  constructor(public readonly port: number) {
    super(`DSH Runtime port ${String(port)} is already in use`)
    this.name = 'RuntimePortOccupiedError'
  }
}

function resolveLaunchContext(layout: UserDataLayout, context: RuntimeLaunchContext): ResolvedRuntimeLaunchContext {
  const mode = context.mode ?? 'normal'
  if (mode === 'safe' && (context.dshHome === undefined || context.dshHome.trim() === '')) {
    throw new Error('Safe Mode Runtime launch requires an isolated DSH home')
  }
  return { mode, dshHome: context.dshHome ?? layout.harness }
}

function sameLaunchContext(left: ResolvedRuntimeLaunchContext, right: ResolvedRuntimeLaunchContext): boolean {
  return left.mode === right.mode && left.dshHome === right.dshHome
}

function isPortOccupiedMessage(value: unknown): boolean {
  return /EADDRINUSE|address already in use|port\s+\d+\s+is already in use/i.test(String(value))
}

/** Own the DSH child process and keep it isolated from the Electron renderer. */
export class RuntimeManager {
  private readonly options: Required<Pick<RuntimeManagerOptions, 'startupTimeoutMs' | 'stopTimeoutMs' | 'portRetryCount'>>
  private current: RuntimeSnapshot
  private child: ChildProcess | undefined
  private logStream: WriteStream | undefined
  private startPromise: Promise<RuntimeSnapshot> | undefined
  private stopPromise: Promise<void> | undefined
  private listeners = new Set<RuntimeListener>()
  private stopping = false
  private stopRequested = false
  private launchContext: ResolvedRuntimeLaunchContext

  constructor(private readonly config: RuntimeManagerOptions) {
    this.options = {
      startupTimeoutMs: config.startupTimeoutMs ?? 30_000,
      stopTimeoutMs: config.stopTimeoutMs ?? 5_000,
      portRetryCount: config.portRetryCount ?? 20
    }
    this.current = initialSnapshot(config.layout)
    this.launchContext = { mode: 'normal', dshHome: config.layout.harness }
  }

  snapshot(): RuntimeSnapshot {
    return { ...this.current }
  }

  onChange(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(context: RuntimeLaunchContext = {}): Promise<RuntimeSnapshot> {
    const launchContext = resolveLaunchContext(this.config.layout, context)
    if (this.current.phase === 'ready') {
      if (sameLaunchContext(this.launchContext, launchContext)) return this.snapshot()
      throw new Error('Runtime is already ready with a different launch context')
    }
    if (this.startPromise !== undefined) return this.startPromise

    this.launchContext = launchContext
    this.stopRequested = false
    this.stopping = false
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.stopRequested = true

    const startup = this.startPromise
    if (this.child === undefined && startup !== undefined) {
      this.stopPromise = (async () => {
        await startup.catch(() => undefined)
        if (this.child !== undefined) {
          await this.stopInternal()
          return
        }
        if (this.current.phase !== 'idle' && this.current.phase !== 'stopped') {
          this.setSnapshot({ phase: 'stopped', pid: undefined, port: undefined, url: undefined })
        }
      })().finally(() => {
        this.stopPromise = undefined
      })
      return this.stopPromise
    }

    if (this.child === undefined) {
      if (this.current.phase !== 'idle' && this.current.phase !== 'stopped') {
        this.setSnapshot({ phase: 'stopped', pid: undefined, port: undefined, url: undefined })
      }
      return
    }

    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  async restart(context: RuntimeLaunchContext = {}): Promise<RuntimeSnapshot> {
    await this.stop()
    return this.start(context)
  }

  private async startInternal(): Promise<RuntimeSnapshot> {
    await ensureUserDataLayout(this.config.layout)
    if (this.stopRequested) return this.markStopped()
    const firstPort = await (this.config.allocatePort ?? allocateLoopbackPort)()
    if (this.stopRequested) return this.markStopped()
    const logPath = join(this.config.layout.logs, 'harness.log')
    for (let retry = 0; retry <= this.options.portRetryCount; retry += 1) {
      if (this.stopRequested) return this.markStopped()
      const port = firstPort + retry
      try {
        return await this.startOnPort(port, logPath)
      } catch (error) {
        if (this.stopRequested) return this.markStopped()
        if (!(error instanceof RuntimePortOccupiedError) || retry === this.options.portRetryCount) {
          this.fail(error)
          throw error
        }
      }
    }
    throw new Error('DSH Runtime port retry limit reached')
  }

  private async startOnPort(port: number, logPath: string): Promise<RuntimeSnapshot> {
    if (this.stopRequested) return this.markStopped()
    const url = `http://127.0.0.1:${String(port)}`
    this.setSnapshot({
      phase: 'starting',
      mode: this.launchContext.mode,
      pid: undefined,
      port,
      url,
      launchDirectory: this.config.layout.launchRoot,
      logPath,
      startedAt: new Date().toISOString(),
      message: '正在启动 DSH Runtime…'
    })

    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
    this.logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    const processLogStream = this.logStream
    const command = this.config.command ?? process.execPath
    const args = command === process.execPath
      ? ['--expose-internals', this.config.runtimeEntryPath, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
      : [this.config.runtimeEntryPath, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
    const inheritedEnvironment = { ...(this.config.getEnvironment?.() ?? process.env) }
    if (command !== process.execPath) delete inheritedEnvironment.ELECTRON_RUN_AS_NODE
    const spawnOptions: SpawnOptions = {
      cwd: this.config.layout.launchRoot,
      detached: process.platform !== 'win32',
      env: {
        ...inheritedEnvironment,
        DSH_HOME: this.launchContext.dshHome,
        [EZDSH_RUNTIME_OWNER_ENV]: EZDSH_RUNTIME_OWNER_VALUE,
        // Electron's executable can run a child as plain Node when this flag is set.
        ...(command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }

    try {
      this.child = (this.config.spawnProcess ?? spawn)(command, args, spawnOptions)
    } catch (error) {
      this.closeLog()
      throw error
    }

    const child = this.child
    const pid = child.pid
    if (pid !== undefined) this.config.runtimeOwnership?.register(pid)
    let portOccupied = false
    let rejectChildExit: (error: Error) => void = () => undefined
    const childExit = new Promise<never>((_resolve, reject) => {
      rejectChildExit = reject
    })
    const captureOutput = (chunk: Buffer | string): void => {
      if (isPortOccupiedMessage(chunk)) portOccupied = true
      this.writeLog(chunk, processLogStream)
    }
    this.setSnapshot({ pid })
    child.stdout?.on('data', captureOutput)
    child.stderr?.on('data', captureOutput)
    child.once('error', (error) => {
      this.writeLog(`\n[child process error] ${String(error)}\n`, processLogStream)
      if (this.child === child && !this.stopping) rejectChildExit(error)
    })
    child.once('exit', (code, signal) => {
      this.writeLog(`\n[child process exit] code=${String(code)} signal=${String(signal)}\n`, processLogStream)
      if (pid !== undefined) this.config.runtimeOwnership?.unregister(pid)
      if (this.child !== child) return
      this.child = undefined
      const error = portOccupied
        ? new RuntimePortOccupiedError(port)
        : new Error(`Runtime exited before shutdown (code=${String(code)}, signal=${String(signal)})`)
      if (this.stopping) {
        this.setSnapshot({ phase: 'stopped', pid: undefined, port: undefined, url: undefined, message: 'Runtime 已停止' })
      } else if (this.current.phase === 'ready') {
        this.fail(error)
      } else {
        rejectChildExit(error)
      }
      this.closeLog()
    })

    try {
      const healthCheck = this.config.waitForHealthy ?? waitForRuntimeHealthy
      await Promise.race([
        healthCheck(url, {
          timeoutMs: this.options.startupTimeoutMs,
          fetchImpl: this.config.fetchImpl
        }),
        childExit
      ])
      if (this.child === undefined) throw new Error('Runtime exited during startup')
      this.setSnapshot({ phase: 'ready', message: undefined })
      return this.snapshot()
    } catch (error) {
      await this.stopInternal()
      if (this.stopRequested) return this.snapshot()
      if (error instanceof RuntimePortOccupiedError || portOccupied) {
        throw new RuntimePortOccupiedError(port)
      }
      throw error
    }
  }

  private async stopInternal(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    this.setSnapshot({ phase: 'stopping', message: '正在停止 DSH Runtime…' })

    await new Promise<void>((resolveStop) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolveStop()
      }
      child.once('exit', settle)
      try {
        this.signalChild(child, 'SIGTERM')
      } catch {
        settle()
      }
      setTimeout(() => {
        if (settled) return
        try {
          this.signalChild(child, 'SIGKILL')
        } finally {
          settle()
        }
      }, this.options.stopTimeoutMs)
    })

    if (this.child === child) {
      this.child = undefined
      this.closeLog()
      this.setSnapshot({ phase: 'stopped', pid: undefined, port: undefined, url: undefined, message: 'Runtime 已停止' })
    }
    if (!this.stopRequested) this.stopping = false
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        const killProcess = this.config.processKill ?? process.kill
        killProcess(-child.pid, signal)
        return
      } catch {
        // Fall back to the root process if the process group is already gone.
      }
    }
    child.kill(signal)
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.setSnapshot({ phase: 'failed', message })
  }

  private markStopped(): RuntimeSnapshot {
    this.setSnapshot({ phase: 'stopped', pid: undefined, port: undefined, url: undefined, message: 'Runtime 已停止' })
    return this.snapshot()
  }

  private setSnapshot(patch: Partial<RuntimeSnapshot>): void {
    this.current = { ...this.current, ...patch }
    for (const listener of this.listeners) listener(this.snapshot())
  }

  private writeLog(chunk: Buffer | string, stream: WriteStream | undefined = this.logStream): void {
    if (stream !== undefined && !stream.destroyed && !stream.writableEnded) stream.write(chunk)
  }

  private closeLog(): void {
    this.logStream?.end()
    this.logStream = undefined
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  if (port === undefined) throw new Error('Unable to allocate a loopback port')
  return port
}
