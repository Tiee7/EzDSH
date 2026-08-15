import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'
import { ensureUserDataLayout } from '../state/user-data.js'
import { waitForRuntimeHealthy } from './health-check.js'
import type { RuntimeSnapshot } from './runtime-types.js'

export interface RuntimePathOptions {
  appPath: string
  resourcesPath?: string
  isPackaged: boolean
}

/** Resolve the source-built or staged Runtime entry without consulting user PATH. */
export function resolveRuntimeEntryPath(options: RuntimePathOptions): string {
  return options.isPackaged
    ? join(options.resourcesPath ?? resolve(options.appPath, '..'), 'dsh-runtime', 'lib', 'bin.js')
    : join(options.appPath, 'vendor', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
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
  allocatePort?: () => Promise<number>
}

type RuntimeListener = (snapshot: RuntimeSnapshot) => void

const initialSnapshot = (layout: UserDataLayout): RuntimeSnapshot => ({
  phase: 'idle',
  launchDirectory: layout.launchRoot,
  logPath: join(layout.logs, 'harness.log')
})

class RuntimePortOccupiedError extends Error {
  constructor(public readonly port: number) {
    super(`DSH Runtime port ${String(port)} is already in use`)
    this.name = 'RuntimePortOccupiedError'
  }
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

  constructor(private readonly config: RuntimeManagerOptions) {
    this.options = {
      startupTimeoutMs: config.startupTimeoutMs ?? 30_000,
      stopTimeoutMs: config.stopTimeoutMs ?? 5_000,
      portRetryCount: config.portRetryCount ?? 20
    }
    this.current = initialSnapshot(config.layout)
  }

  snapshot(): RuntimeSnapshot {
    return { ...this.current }
  }

  onChange(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<RuntimeSnapshot> {
    if (this.current.phase === 'ready') return this.snapshot()
    if (this.startPromise !== undefined) return this.startPromise

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
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

  async restart(): Promise<RuntimeSnapshot> {
    await this.stop()
    return this.start()
  }

  private async startInternal(): Promise<RuntimeSnapshot> {
    await ensureUserDataLayout(this.config.layout)
    const firstPort = await (this.config.allocatePort ?? allocateLoopbackPort)()
    const logPath = join(this.config.layout.logs, 'harness.log')
    for (let retry = 0; retry <= this.options.portRetryCount; retry += 1) {
      const port = firstPort + retry
      try {
        return await this.startOnPort(port, logPath)
      } catch (error) {
        if (!(error instanceof RuntimePortOccupiedError) || retry === this.options.portRetryCount) {
          this.fail(error)
          throw error
        }
      }
    }
    throw new Error('DSH Runtime port retry limit reached')
  }

  private async startOnPort(port: number, logPath: string): Promise<RuntimeSnapshot> {
    const url = `http://127.0.0.1:${String(port)}`
    this.stopping = false
    this.setSnapshot({
      phase: 'starting',
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
    const command = this.config.command ?? process.execPath
    const args = command === process.execPath
      ? ['--expose-internals', this.config.runtimeEntryPath, 'web', '--host', '127.0.0.1', '--port', String(port)]
      : [this.config.runtimeEntryPath, 'web', '--host', '127.0.0.1', '--port', String(port)]
    const spawnOptions: SpawnOptions = {
      cwd: this.config.layout.launchRoot,
      env: {
        ...process.env,
        DSH_HOME: this.config.layout.harness,
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
    let portOccupied = false
    let rejectChildExit: (error: Error) => void = () => undefined
    const childExit = new Promise<never>((_resolve, reject) => {
      rejectChildExit = reject
    })
    const captureOutput = (chunk: Buffer | string): void => {
      if (isPortOccupiedMessage(chunk)) portOccupied = true
      this.writeLog(chunk)
    }
    this.setSnapshot({ pid })
    child.stdout?.on('data', captureOutput)
    child.stderr?.on('data', captureOutput)
    child.once('error', (error) => {
      this.writeLog(`\n[child process error] ${String(error)}\n`)
      if (!this.stopping) rejectChildExit(error)
    })
    child.once('exit', (code, signal) => {
      this.writeLog(`\n[child process exit] code=${String(code)} signal=${String(signal)}\n`)
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
      await this.stop()
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
        child.kill('SIGTERM')
      } catch {
        settle()
      }
      setTimeout(() => {
        if (settled) return
        try {
          child.kill('SIGKILL')
        } finally {
          settle()
        }
      }, this.options.stopTimeoutMs)
    })

    this.child = undefined
    this.closeLog()
    this.setSnapshot({ phase: 'stopped', pid: undefined, port: undefined, url: undefined, message: 'Runtime 已停止' })
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.setSnapshot({ phase: 'failed', message })
  }

  private setSnapshot(patch: Partial<RuntimeSnapshot>): void {
    this.current = { ...this.current, ...patch }
    for (const listener of this.listeners) listener(this.snapshot())
  }

  private writeLog(chunk: Buffer | string): void {
    this.logStream?.write(chunk)
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
