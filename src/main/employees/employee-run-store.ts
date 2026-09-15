import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  EmployeeRunCommandReceipt,
  EmployeeRunEvent,
  EmployeeRunRecord,
  EmployeeRunStartReceipt,
  EmployeeRunUpdate,
} from '../../shared/employee-runs.js'

interface EmployeeRunState {
  version: 1
  runs: Record<string, EmployeeRunRecord>
  commands: Record<string, { requestDigest: string; runId: string }>
}

export interface EmployeeRunStoreOptions {
  writeFile?: (path: string, data: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

export interface EmployeeRunCreateInput {
  commandId: string
  requestDigest: string
  record: EmployeeRunRecord
}

export class EmployeeRunStoreConflictError extends Error {
  readonly code: 'COMMAND_ID_CONFLICT' | 'RUN_NOT_FOUND'

  constructor(code: EmployeeRunStoreConflictError['code'], message: string) {
    super(message)
    this.name = 'EmployeeRunStoreConflictError'
    this.code = code
  }
}

const EMPTY_STATE: EmployeeRunState = { version: 1, runs: {}, commands: {} }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}

export class EmployeeRunStore {
  private readonly filePath: string
  private state: EmployeeRunState = clone(EMPTY_STATE)
  private initialized = false
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(event: EmployeeRunEvent) => void>()

  constructor(
    private readonly stateDirectory: string,
    private readonly options: EmployeeRunStoreOptions = {},
  ) {
    this.filePath = join(stateDirectory, 'employee-runs.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as EmployeeRunState
      if (parsed.version !== 1 || !isObject(parsed.runs) || !isObject(parsed.commands)) {
        throw new Error('Unsupported employee run state')
      }
      this.state = clone(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = clone(EMPTY_STATE)
    }
    this.initialized = true
  }

  async get(runId: string): Promise<EmployeeRunRecord | undefined> {
    this.assertInitialized()
    const run = ownValue(this.state.runs, runId)
    return run === undefined ? undefined : clone(run)
  }

  async list(): Promise<EmployeeRunRecord[]> {
    this.assertInitialized()
    return Object.values(this.state.runs).map(clone)
  }

  async findByCommand(commandId: string): Promise<EmployeeRunCommandReceipt | undefined> {
    this.assertInitialized()
    const receipt = ownValue(this.state.commands, commandId)
    if (receipt === undefined) return undefined
    const run = ownValue(this.state.runs, receipt.runId)
    if (run === undefined) throw new Error(`Employee run receipt ${commandId} refers to a missing run`)
    return clone({ commandId, requestDigest: receipt.requestDigest, run })
  }

  async create(input: EmployeeRunCreateInput): Promise<EmployeeRunStartReceipt> {
    return this.mutate(async () => {
      const existing = ownValue(this.state.commands, input.commandId)
      if (existing !== undefined) {
        if (existing.requestDigest !== input.requestDigest) {
          throw new EmployeeRunStoreConflictError(
            'COMMAND_ID_CONFLICT',
            `Employee command ${input.commandId} was already used with different content`,
          )
        }
        const run = ownValue(this.state.runs, existing.runId)
        if (run === undefined) throw new Error(`Employee run receipt ${input.commandId} refers to a missing run`)
        return { run: clone(run), replayed: true }
      }
      if (
        input.record.commandId !== input.commandId
        || input.record.requestDigest !== input.requestDigest
        || ownValue(this.state.runs, input.record.runId) !== undefined
      ) {
        throw new Error('Employee run create input is inconsistent')
      }

      const next = clone(this.state)
      setOwnValue(next.runs, input.record.runId, clone(input.record))
      setOwnValue(next.commands, input.commandId, {
        requestDigest: input.requestDigest,
        runId: input.record.runId,
      })
      await this.commit(next)
      const run = clone(input.record)
      this.emit({ kind: 'created', run })
      return { run, replayed: false }
    })
  }

  async update(runId: string, update: EmployeeRunUpdate): Promise<EmployeeRunRecord> {
    return this.mutate(async () => {
      const current = ownValue(this.state.runs, runId)
      if (current === undefined) {
        throw new EmployeeRunStoreConflictError('RUN_NOT_FOUND', `Employee run ${runId} was not found`)
      }
      const nextRun: EmployeeRunRecord = { ...clone(current), ...clone(update) }
      const next = clone(this.state)
      setOwnValue(next.runs, runId, nextRun)
      await this.commit(next)
      const result = clone(nextRun)
      this.emit({ kind: 'updated', run: result })
      return result
    })
  }

  subscribe(listener: (event: EmployeeRunEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized()
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(next: EmployeeRunState): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const serialized = `${JSON.stringify(next, null, 2)}\n`
      if (this.options.writeFile) await this.options.writeFile(temporaryPath, serialized)
      else await writeFile(temporaryPath, serialized, { mode: 0o600 })
      if (this.options.rename) await this.options.rename(temporaryPath, this.filePath)
      else await rename(temporaryPath, this.filePath)
      this.state = next
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private emit(event: EmployeeRunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(clone(event))
      } catch {
        // The durable mutation already succeeded; observers cannot alter its result.
      }
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('EmployeeRunStore must be initialized before use')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
