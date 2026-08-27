import { execFile as execFileCallback } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DshRuntimeProcess } from './runtime-types.js'

const execFile = promisify(execFileCallback)
const COMMAND_BUFFER_SIZE = 10 * 1024 * 1024
export const EZDSH_RUNTIME_OWNER_ENV = 'EZDSH_RUNTIME_OWNER'
export const EZDSH_RUNTIME_OWNER_VALUE = 'EzDSH'

type CommandRunner = (command: string, args: readonly string[]) => Promise<string>
type ProcessKill = (pid: number, signal: NodeJS.Signals) => boolean

export interface RuntimeOwnershipStore {
  register(pid: number): void
  unregister(pid: number): void
  listOwnedPids(): Set<number>
  prune(activePids: ReadonlySet<number>): void
}

export interface DshRuntimeProcessManagerOptions {
  platform?: NodeJS.Platform
  getCurrentPid: () => number | undefined
  stopCurrent?: () => Promise<void>
  runCommand?: CommandRunner
  processKill?: ProcessKill
  processAlive?: (pid: number) => boolean
  stopTimeoutMs?: number
  ownershipStore?: RuntimeOwnershipStore
  listOwnedPids?: () => ReadonlySet<number>
}

interface RawProcess {
  pid: number
  ppid: number
  pgid?: number
  startedAt?: string
  command: string
}

/** Discovers and safely stops DSH Runtime web processes, including orphaned instances. */
export class DshRuntimeProcessManager {
  private readonly platform: NodeJS.Platform
  private readonly runCommand: CommandRunner
  private readonly processKill: ProcessKill
  private readonly processAlive: (pid: number) => boolean
  private readonly stopTimeoutMs: number

  constructor(private readonly options: DshRuntimeProcessManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.runCommand = options.runCommand ?? runCommand
    this.processKill = options.processKill ?? ((pid, signal) => process.kill(pid, signal))
    this.processAlive = options.processAlive ?? isProcessAlive
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
  }

  async list(): Promise<DshRuntimeProcess[]> {
    const processes = this.platform === 'win32'
      ? await this.listWindowsProcesses()
      : await this.listPosixProcesses()
    const listeningPorts = await this.listeningPorts()
    const currentPid = this.options.getCurrentPid()
    const activePids = new Set(processes.map((process) => process.pid))
    this.options.ownershipStore?.prune(activePids)
    const ownedPids = this.options.ownershipStore?.listOwnedPids()
      ?? new Set(this.options.listOwnedPids?.() ?? [])

    return processes
      .filter((process) => isDshRuntimeCommand(process.command))
      .map((process) => {
        const requestedPort = readPort(process.command)
        const port = requestedPort === 0
          ? listeningPorts.get(process.pid)
          : requestedPort
        return {
          ...process,
          ...(port === undefined ? {} : { port }),
          current: process.pid === currentPid,
          ownedByEzDSH: process.pid === currentPid || ownedPids.has(process.pid),
        }
      })
      .sort((left, right) => left.pid - right.pid)
  }

  async stop(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid Runtime process PID: ${String(pid)}`)

    if (pid === this.options.getCurrentPid()) {
      throw new Error('The current Runtime must be restarted instead of stopped')
    }

    const runtime = (await this.list()).find((process) => process.pid === pid)
    if (runtime === undefined) throw new Error(`DSH Runtime process ${String(pid)} was not found`)
    await this.stopValidatedPid(runtime.pid, runtime.pgid)
  }

  async stopAll(): Promise<void> {
    const currentPid = this.options.getCurrentPid()
    let currentStopped = false
    if (currentPid !== undefined && this.options.stopCurrent !== undefined) {
      try {
        await this.options.stopCurrent()
        currentStopped = true
      } catch {
        // Continue with the process scan so stale runtimes are still cleaned up.
      }
    }

    const runtimes = await this.list()
    const remaining = runtimes.filter((runtime) => runtime.ownedByEzDSH && !(currentStopped && runtime.pid === currentPid))
    await Promise.allSettled(remaining.map((runtime) => this.stopValidatedPid(runtime.pid, runtime.pgid)))
  }

  async stopOwnedOrphans(): Promise<void> {
    const runtimes = await this.list()
    const orphans = runtimes.filter((runtime) => runtime.ownedByEzDSH && !runtime.current)
    await Promise.allSettled(orphans.map((runtime) => this.stopValidatedPid(runtime.pid, runtime.pgid)))
  }

  private async listPosixProcesses(): Promise<RawProcess[]> {
    const output = await this.runCommand('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='])
    return parsePosixProcesses(output)
  }

  private async listWindowsProcesses(): Promise<RawProcess[]> {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress'
    const output = await this.runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return parseWindowsProcesses(output)
  }

  private async listeningPorts(): Promise<Map<number, number>> {
    try {
      const output = this.platform === 'win32'
        ? await this.runCommand('netstat', ['-ano', '-p', 'tcp'])
        : await this.runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
      return this.platform === 'win32' ? parseWindowsPorts(output) : parsePosixPorts(output)
    } catch {
      return new Map()
    }
  }

  private async stopValidatedPid(pid: number, pgid?: number): Promise<void> {
    this.sendSignal(pid, pgid, 'SIGTERM')
    await this.waitForExit(pid)
    if (!this.processAlive(pid)) return
    this.sendSignal(pid, pgid, 'SIGKILL')
    await this.waitForExit(pid)
  }

  private sendSignal(pid: number, pgid: number | undefined, signal: NodeJS.Signals): void {
    if (this.platform !== 'win32') {
      const groupId = pgid !== undefined && pgid > 1 ? pgid : pid
      try {
        this.processKill(-groupId, signal)
        return
      } catch {
        // A process may not be a group leader; fall back to its individual PID.
      }
    }
    this.processKill(pid, signal)
  }

  private async waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + this.stopTimeoutMs
    while (this.processAlive(pid) && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
    }
  }
}

export function isDshRuntimeCommand(command: string): boolean {
  return /(?:@deepseek-ai[\\/]dsh|dsh-runtime)[\\/]lib[\\/]bin\.js(?:\s|$)/iu.test(command)
    && /(?:^|\s)web(?:\s|$)/u.test(command)
    && /(?:^|\s)--port(?:=|\s+)\d+(?:\s|$)/u.test(command)
}

function readPort(command: string): number | undefined {
  const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/u.exec(command)
  if (match === null) return undefined
  return Number(match[1])
}

function parsePosixProcesses(output: string): RawProcess[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S.*)\s*$/u.exec(line)
    if (match === null) return []
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4]?.trim(),
      command: match[5]?.trim() ?? '',
    }]
  })
}

function parseWindowsProcesses(output: string): RawProcess[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => {
    if (!isRecord(row)) return []
    const pid = numberValue(row.ProcessId)
    const ppid = numberValue(row.ParentProcessId)
    const command = typeof row.CommandLine === 'string' ? row.CommandLine.trim() : ''
    if (pid === undefined || ppid === undefined || command === '') return []
    return [{
      pid,
      ppid,
      command,
      ...(typeof row.CreationDate === 'string' ? { startedAt: row.CreationDate } : {}),
    }]
  })
}

function parsePosixPorts(output: string): Map<number, number> {
  const ports = new Map<number, number>()
  let pid: number | undefined
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('p')) {
      const parsedPid = Number(line.slice(1))
      pid = Number.isSafeInteger(parsedPid) ? parsedPid : undefined
      continue
    }
    if (pid === undefined || !line.startsWith('n')) continue
    const matches = [...line.matchAll(/:(\d+)(?:$|\s)/gu)]
    const port = matches.at(-1)?.[1]
    if (port !== undefined) ports.set(pid, Number(port))
  }
  return ports
}

function parseWindowsPorts(output: string): Map<number, number> {
  const ports = new Map<number, number>()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line)
    if (match !== null) ports.set(Number(match[2]), Number(match[1]))
  }
  return ports
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(number) ? number : undefined
}

async function runCommand(command: string, args: readonly string[]): Promise<string> {
  const result = await execFile(command, [...args], { encoding: 'utf8', maxBuffer: COMMAND_BUFFER_SIZE })
  return result.stdout
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stores ownership outside the active workspace so orphaned processes survive workspace changes. */
export function createRuntimeOwnershipStore(directory: string): RuntimeOwnershipStore {
  const markerPath = (pid: number): string => join(directory, `${String(pid)}.json`)
  const readOwnedPids = (): Set<number> => {
    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      return new Set()
    }
    const result = new Set<number>()
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const value = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as { pid?: unknown; owner?: unknown }
        if (value.owner !== EZDSH_RUNTIME_OWNER_VALUE) continue
        const pid = typeof value.pid === 'number' ? value.pid : Number(value.pid)
        if (Number.isSafeInteger(pid) && pid > 0) result.add(pid)
      } catch {
        // Ignore malformed or partially-written records; the next start can recreate them.
      }
    }
    return result
  }

  return {
    register(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const path = markerPath(pid)
      const tempPath = `${path}.${process.pid}.tmp`
      writeFileSync(tempPath, `${JSON.stringify({ pid, owner: EZDSH_RUNTIME_OWNER_VALUE })}\n`, { mode: 0o600 })
      renameSync(tempPath, path)
    },
    unregister(pid) {
      try {
        unlinkSync(markerPath(pid))
      } catch {
        // The record may already have been removed by a later process.
      }
    },
    listOwnedPids: readOwnedPids,
    prune(activePids) {
      for (const pid of readOwnedPids()) {
        if (!activePids.has(pid)) {
          try { unlinkSync(markerPath(pid)) } catch { /* The marker may have been removed concurrently. */ }
        }
      }
    },
  }
}
