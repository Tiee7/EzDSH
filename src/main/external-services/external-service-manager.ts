import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { normalizeCommandLine } from '../../shared/command-line.js'
import type {
  ExternalServiceCreateInput,
  ExternalServiceDefinition,
  ExternalServiceSnapshot,
  ExternalServiceState,
  ExternalServiceUpdateInput,
} from '../../shared/external-services.js'

export type {
  ExternalServiceCreateInput,
  ExternalServiceDefinition,
  ExternalServiceSnapshot,
  ExternalServiceState,
  ExternalServiceUpdateInput,
} from '../../shared/external-services.js'

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface ExternalServiceManagerOptions {
  configPath: string
  logsDir: string
  spawnProcess?: SpawnProcess
  stopTimeoutMs?: number
}

type SnapshotListener = (snapshots: ExternalServiceSnapshot[]) => void

interface RuntimeState {
  state: ExternalServiceState
  pid?: number
  exitCode?: number | null
  signal?: string
  error?: string
}

interface ManagedChild {
  child: ChildProcess
  stopping: boolean
  closed: boolean
  logStream?: WriteStream
  exitPromise: Promise<void>
  resolveExit: () => void
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

/** Owns user-configured child processes without making them part of EzDSH startup success. */
export class ExternalServiceManager {
  private readonly spawnProcess: SpawnProcess
  private readonly stopTimeoutMs: number
  private readonly definitions = new Map<string, ExternalServiceDefinition>()
  private readonly runtime = new Map<string, RuntimeState>()
  private readonly children = new Map<string, ManagedChild>()
  private readonly listeners = new Set<SnapshotListener>()
  private initialized = false

  constructor(private readonly options: ExternalServiceManagerOptions) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.options.configPath), { recursive: true, mode: 0o700 })
    await mkdir(this.options.logsDir, { recursive: true, mode: 0o700 })

    let parsed: unknown = []
    try {
      parsed = JSON.parse(await readFile(this.options.configPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        try {
          const definition = normalizeDefinition(value)
          if (!this.definitions.has(definition.id)) {
            this.definitions.set(definition.id, definition)
            this.runtime.set(definition.id, { state: 'stopped' })
          }
        } catch {
          // Ignore malformed persisted entries; the settings page can recreate them.
        }
      }
    }
    this.initialized = true
  }

  list(): ExternalServiceSnapshot[] {
    return [...this.definitions.values()].map((definition) => this.snapshot(definition.id))
  }

  async create(input: ExternalServiceCreateInput): Promise<ExternalServiceSnapshot> {
    await this.initialize()
    const definition = normalizeDefinition({ ...input, id: input.id ?? randomUUID() })
    if (this.definitions.has(definition.id)) throw new Error(`External service "${definition.id}" already exists`)
    this.definitions.set(definition.id, definition)
    this.runtime.set(definition.id, { state: 'stopped' })
    await this.persist()
    this.emit()
    return this.snapshot(definition.id)
  }

  async update(id: string, input: ExternalServiceUpdateInput): Promise<ExternalServiceSnapshot> {
    await this.initialize()
    const current = this.requireDefinition(id)
    const next = normalizeDefinition({ ...current, ...input, id })
    const processChanged = current.command !== next.command
      || JSON.stringify(current.args) !== JSON.stringify(next.args)
      || current.cwd !== next.cwd
      || JSON.stringify(current.env) !== JSON.stringify(next.env)
      || (current.enabled && !next.enabled)
    if (processChanged && this.children.has(id)) await this.stop(id)
    this.definitions.set(id, next)
    if (!this.runtime.has(id)) this.runtime.set(id, { state: 'stopped' })
    await this.persist()
    this.emit()
    return this.snapshot(id)
  }

  async remove(id: string): Promise<void> {
    await this.initialize()
    this.requireDefinition(id)
    if (this.children.has(id)) await this.stop(id)
    this.definitions.delete(id)
    this.runtime.delete(id)
    await this.persist()
    this.emit()
  }

  async start(id: string): Promise<ExternalServiceSnapshot> {
    await this.initialize()
    const definition = this.requireDefinition(id)
    if (!definition.enabled) throw new Error(`External service "${id}" is disabled`)
    const existing = this.children.get(id)
    if (existing !== undefined && !existing.closed) return this.snapshot(id)

    this.setRuntime(id, { state: 'starting', error: undefined, exitCode: undefined, signal: undefined })
    let child: ChildProcess
    try {
      child = this.spawnProcess(definition.command, definition.args, {
        cwd: definition.cwd,
        env: { ...process.env, ...definition.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.setRuntime(id, { state: 'failed', error: messageOf(error) })
      throw error
    }

    let resolveExit!: () => void
    const managed: ManagedChild = {
      child,
      stopping: false,
      closed: false,
      exitPromise: new Promise<void>((resolve) => { resolveExit = resolve }),
      resolveExit: () => resolveExit(),
    }
    this.children.set(id, managed)
    managed.logStream = this.createLogStream(id)
    child.stdout?.on('data', (chunk: Buffer | string) => managed.logStream?.write(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => managed.logStream?.write(chunk))
    child.once('error', (error) => this.finishChild(id, managed, undefined, undefined, error))
    child.once('exit', (code, signal) => this.finishChild(id, managed, code, signal ?? undefined))

    if (!managed.closed) {
      this.setRuntime(id, { state: 'running', pid: child.pid })
    }
    return this.snapshot(id)
  }

  async stop(id: string): Promise<ExternalServiceSnapshot> {
    await this.initialize()
    this.requireDefinition(id)
    const managed = this.children.get(id)
    if (managed === undefined || managed.closed) {
      this.setRuntime(id, { state: 'stopped', pid: undefined, error: undefined })
      return this.snapshot(id)
    }

    managed.stopping = true
    this.setRuntime(id, { state: 'stopping', pid: managed.child.pid })
    try {
      managed.child.kill('SIGTERM')
    } catch (error) {
      this.finishChild(id, managed, undefined, undefined, error)
    }
    await this.waitForExit(managed)
    if (!managed.closed) {
      try { managed.child.kill('SIGKILL') } catch { /* The process may have exited between checks. */ }
      await this.waitForExit(managed)
    }
    if (!managed.closed) this.finishChild(id, managed, null, 'SIGKILL')
    return this.snapshot(id)
  }

  async restart(id: string): Promise<ExternalServiceSnapshot> {
    await this.stop(id)
    return this.start(id)
  }

  async startAutoServices(): Promise<void> {
    await this.initialize()
    await Promise.allSettled(
      this.list()
        .filter((service) => service.enabled && service.autoStart)
        .map((service) => this.start(service.id)),
    )
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.children.keys()].map((id) => this.stop(id)))
  }

  watch(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private snapshot(id: string): ExternalServiceSnapshot {
    const definition = this.requireDefinition(id)
    return { ...definition, ...(this.runtime.get(id) ?? { state: 'stopped' }) }
  }

  private requireDefinition(id: string): ExternalServiceDefinition {
    const definition = this.definitions.get(id)
    if (definition === undefined) throw new Error(`External service "${id}" was not found`)
    return definition
  }

  private setRuntime(id: string, state: RuntimeState): void {
    this.runtime.set(id, state)
    this.emit()
  }

  private emit(): void {
    const snapshots = this.list()
    for (const listener of this.listeners) {
      try { listener(snapshots) } catch { /* A renderer listener must not affect process management. */ }
    }
  }

  private finishChild(
    id: string,
    managed: ManagedChild,
    exitCode: number | null | undefined,
    signal: NodeJS.Signals | string | undefined,
    error?: unknown,
  ): void {
    if (managed.closed) return
    managed.closed = true
    this.children.delete(id)
    managed.logStream?.end()
    managed.resolveExit()
    this.setRuntime(id, error !== undefined
      ? { state: 'failed', error: messageOf(error), pid: undefined }
      : managed.stopping
        ? { state: 'stopped', pid: undefined, exitCode, signal }
        : { state: 'exited', pid: undefined, exitCode, signal })
  }

  private async waitForExit(managed: ManagedChild): Promise<void> {
    if (managed.closed) return
    await Promise.race([
      managed.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, this.stopTimeoutMs)),
    ])
  }

  private createLogStream(id: string): WriteStream | undefined {
    try {
      return createWriteStream(join(this.options.logsDir, `${id}.log`), { flags: 'a', mode: 0o600 })
    } catch {
      return undefined
    }
  }

  private async persist(): Promise<void> {
    const tempPath = `${this.options.configPath}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(dirname(this.options.configPath), { recursive: true, mode: 0o700 })
    await writeFile(tempPath, `${JSON.stringify([...this.definitions.values()], null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, this.options.configPath)
  }
}

function normalizeDefinition(value: unknown): ExternalServiceDefinition {
  if (!isRecord(value)) throw new Error('External service must be an object')
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  const command = stringValue(value.command)
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid external service id "${id}"`)
  if (name === '') throw new Error('External service name is required')
  if (command === '') throw new Error('External service command is required')
  const args = value.args === undefined ? [] : arrayOfStrings(value.args, 'args')
  const normalizedCommand = normalizeCommandLine(command, args)
  const env = value.env === undefined ? {} : recordOfStrings(value.env, 'env')
  const cwd = value.cwd === undefined ? undefined : stringValue(value.cwd) || undefined
  return {
    id,
    name,
    command: normalizedCommand.command,
    args: normalizedCommand.args,
    ...(cwd === undefined ? {} : { cwd }),
    env,
    enabled: value.enabled !== false,
    autoStart: value.autoStart === true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function arrayOfStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`External service ${field} must be an array of strings`)
  }
  return value.map((item) => item.trim())
}

function recordOfStrings(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`External service ${field} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof raw !== 'string') {
      throw new Error(`External service ${field} must contain valid string environment variables`)
    }
    result[key] = raw
  }
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
