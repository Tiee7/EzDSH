import { accessSync, constants, createWriteStream, existsSync, lstatSync, statSync, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { normalizeCommandLine } from '../../shared/command-line.js'
import type {
  ExternalServiceCreateInput,
  ExternalServiceDefinition,
  ExternalServiceSnapshot,
  ExternalServiceState,
  ExternalServiceStartupIssue,
  ExternalServiceUpdateInput,
} from '../../shared/external-services.js'

export type {
  ExternalServiceCreateInput,
  ExternalServiceDefinition,
  ExternalServiceSnapshot,
  ExternalServiceState,
  ExternalServiceStartupIssue,
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
  /** Packaged GUI apps need to reconstruct the user's shell PATH. */
  isPackaged?: boolean
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
  startupIssue?: ExternalServiceStartupIssue
}

interface SpawnContext {
  command: string
  args: readonly string[]
  cwd?: string
  environment: NodeJS.ProcessEnv
}

interface ManagedChild {
  spawnContext: SpawnContext
  child: ChildProcess
  stopping: boolean
  closed: boolean
  output: string
  logStream?: WriteStream
  exitPromise: Promise<void>
  resolveExit: () => void
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u
const MAX_CAPTURED_OUTPUT = 16_000

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
    if (processChanged && this.children.has(id)) await this.stop(id)
    this.definitions.set(id, next)
    if (processChanged || !this.runtime.has(id)) this.runtime.set(id, { state: 'stopped' })
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
    const existing = this.children.get(id)
    if (existing !== undefined && !existing.closed) return this.snapshot(id)

    this.setRuntime(id, { state: 'starting', error: undefined, exitCode: undefined, signal: undefined })
    let child: ChildProcess
    const context: SpawnContext = {
      command: definition.command,
      args: [...definition.args],
      environment: { ...process.env, ...definition.env },
    }
    let cwdFailure: ReturnType<typeof inspectWorkingDirectory>
    try {
      // Keep preflight synchronous so concurrent starts cannot pass the child guard
      // while another start is still resolving its directory or executable.
      context.cwd = resolveWorkingDirectory(definition.cwd)
      cwdFailure = inspectWorkingDirectory(context.cwd)
      if (cwdFailure !== undefined) throw cwdFailure.error
      if (this.options.isPackaged === true) {
        context.command = resolveExternalServiceCommand(context.command, context.environment, context.cwd)
      }
      child = this.spawnProcess(context.command, context.args, {
        cwd: definition.cwd === undefined ? undefined : context.cwd,
        env: context.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const reason = formatSpawnError(error, context)
      this.setRuntime(id, {
        state: 'failed',
        error: reason,
        startupIssue: cwdFailure?.issue ?? diagnoseSpawnError(error, context),
      })
      throw new Error(reason, { cause: error })
    }

    let resolveExit!: () => void
    const managed: ManagedChild = {
      spawnContext: context,
      child,
      stopping: false,
      closed: false,
      output: '',
      exitPromise: new Promise<void>((resolve) => { resolveExit = resolve }),
      resolveExit: () => resolveExit(),
    }
    this.children.set(id, managed)
    managed.logStream = this.createLogStream(id)
    const appendOutput = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      managed.output = `${managed.output}${text}`.slice(-MAX_CAPTURED_OUTPUT)
      managed.logStream?.write(chunk)
    }
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
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
        .filter((service) => service.autoStart)
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
    const failed = error !== undefined
      || (!managed.stopping && exitCode !== undefined && exitCode !== null && exitCode !== 0)
      || (!managed.stopping && signal !== undefined)
    if (failed) {
      const reason = error !== undefined
        ? formatSpawnError(error, managed.spawnContext)
        : signal !== undefined
          ? `External service terminated by ${signal}`
          : `External service exited with code ${String(exitCode)}`
      this.setRuntime(id, {
        state: 'failed',
        pid: undefined,
        exitCode,
        signal,
        error: appendOutput(reason, managed.output),
        ...(error === undefined ? {} : { startupIssue: diagnoseSpawnError(error, managed.spawnContext) }),
      })
      return
    }
    this.setRuntime(id, managed.stopping
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

function resolveExternalServiceCommand(command: string, environment: NodeJS.ProcessEnv, cwd: string): string {
  if (command.includes('/') || command.includes('\\')) return command
  const path = environment.PATH ?? ''
  const direct = findOnPath(command, path, cwd, environment)
  if (direct !== undefined) return direct

  // GUI-launched macOS apps do not inherit the user's shell PATH. Ask the
  // login shell for it only when the inherited PATH cannot resolve the command.
  const shellPath = process.platform === 'darwin' ? readLoginShellPath() : undefined
  const fromShell = shellPath === undefined ? undefined : findOnPath(command, shellPath, cwd, environment)
  if (fromShell !== undefined) {
    environment.PATH = [shellPath, path].filter(Boolean).join(':')
    return fromShell
  }

  // Windows package managers are .cmd shims and cannot be spawned by their
  // extensionless name when shell execution is disabled.
  if (process.platform === 'win32') {
    const windowsCommand = findOnPath(`${command}.cmd`, path, cwd, environment)
    if (windowsCommand !== undefined) return windowsCommand
  }
  return command
}

function findOnPath(command: string, path: string, cwd: string, environment: NodeJS.ProcessEnv): string | undefined {
  return commandCandidates(command, path, cwd, environment).find((candidate) => existsSync(candidate))
}

function commandCandidates(command: string, path: string, cwd: string, environment: NodeJS.ProcessEnv): string[] {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) return [resolve(cwd, command)]
  const extensions = process.platform === 'win32' && !/[.]\w+$/u.test(command)
    ? (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  // Empty and relative PATH entries are relative to the child's cwd, not EzDSH's.
  return path.split(delimiter).flatMap((directory) => extensions.map((extension) => resolve(cwd, directory, `${command}${extension}`)))
}

function resolveWorkingDirectory(cwd: string | undefined): string {
  if (cwd === undefined) return process.cwd()
  if (cwd === '~') return homedir()
  const homeRelative = cwd.startsWith('~/') || (process.platform === 'win32' && cwd.startsWith('~\\'))
  return resolve(homeRelative ? join(homedir(), cwd.slice(2)) : cwd)
}

function inspectWorkingDirectory(cwd: string): { issue: ExternalServiceStartupIssue; error: unknown } | undefined {
  try {
    if (!statSync(cwd).isDirectory()) {
      throw Object.assign(new Error(`Working directory is not a directory: ${cwd}`), { code: 'ENOTDIR' })
    }
    accessSync(cwd, constants.X_OK)
    return undefined
  } catch (error) {
    const code = errorObjectCode(error)
    return {
      issue: {
        code: code === 'ENOENT' ? 'cwd-missing'
          : code === 'ENOTDIR' ? 'cwd-not-directory'
            : code === 'EACCES' || code === 'EPERM' ? 'cwd-inaccessible' : 'unknown',
        path: cwd,
      },
      error,
    }
  }
}

function diagnoseSpawnError(error: unknown, context: SpawnContext): ExternalServiceStartupIssue {
  const code = errorObjectCode(error)
  if (context.cwd === undefined || !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? '')) return { code: 'unknown' }
  // A directory may disappear or lose access after preflight; ENOENT alone does
  // not prove that the executable is missing, nor does EACCES prove its permissions.
  const cwdFailure = inspectWorkingDirectory(context.cwd)
  if (cwdFailure !== undefined) return cwdFailure.issue

  const unavailable: ExternalServiceStartupIssue = { code: 'command-unavailable', path: context.command }
  const explicitPath = context.command.includes('/') || (process.platform === 'win32' && context.command.includes('\\'))
  // Windows has extra search locations and implicit executable extensions; its
  // lookup and access rules cannot be proved with this POSIX filesystem check.
  if (process.platform === 'win32' || (!explicitPath && context.environment.PATH === undefined)) return unavailable
  const candidates = commandCandidates(context.command, context.environment.PATH ?? '', context.cwd, context.environment)
  let blockedExecutable: string | undefined
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate)
      if (code === 'ENOENT' || code === 'ENOTDIR') return unavailable // An existing script can have a missing interpreter.
      if (!stat.isFile()) return unavailable
      try {
        accessSync(candidate, constants.X_OK)
        return unavailable
      } catch (accessError) {
        if (['EACCES', 'EPERM'].includes(errorObjectCode(accessError) ?? '')) blockedExecutable = candidate
        else return unavailable
      }
    } catch (statError) {
      if (!['ENOENT', 'ENOTDIR'].includes(errorObjectCode(statError) ?? '')) return unavailable
      try {
        lstatSync(candidate) // A broken symlink still names an existing command entry.
        return unavailable
      } catch (linkError) {
        if (!['ENOENT', 'ENOTDIR'].includes(errorObjectCode(linkError) ?? '')) return unavailable
      }
    }
  }
  if (blockedExecutable !== undefined) return { code: 'command-not-executable', path: blockedExecutable }
  return code === 'ENOENT' || code === 'ENOTDIR' ? { code: 'command-not-found', path: context.command } : unavailable
}

function readLoginShellPath(): string | undefined {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const output = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const path = output.trim()
    return path === '' ? undefined : path
  } catch {
    return undefined
  }
}

function formatSpawnError(error: unknown, context: SpawnContext): string {
  const code = errorObjectCode(error)
  const details = [
    `command: ${[context.command, ...context.args].join(' ')}`,
    `cwd: ${context.cwd ?? '(unavailable)'}`,
    `PATH: ${context.environment.PATH ?? '(empty)'}`,
  ].join('\n')
  return `Unable to start external service${code === undefined ? '' : ` (${code})`}: ${messageOf(error)}.\n${details}`
}

function errorObjectCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
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
    autoStart: value.autoStart === true && value.enabled !== false,
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

function appendOutput(reason: string, output: string): string {
  const trimmed = output.trim()
  return trimmed === '' ? reason : `${reason}\n${trimmed}`
}
