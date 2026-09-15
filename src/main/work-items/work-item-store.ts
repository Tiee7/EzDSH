import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { types as utilTypes } from 'node:util'

import {
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  type WorkItemQuery,
  type WorkTask,
  type WorkTaskCreateRequest,
  type WorkTaskExecuteRequest,
  type WorkTaskSnapshot
} from '../../shared/work-items.js'

export class WorkItemStoreConflictError extends Error {
  readonly code: 'REQUEST_ID_CONFLICT' | 'REVISION_CONFLICT' | 'TASK_NOT_FOUND' | 'ATTEMPT_NOT_FOUND'

  constructor(
    code: WorkItemStoreConflictError['code'],
    message: string
  ) {
    super(message)
    this.name = 'WorkItemStoreConflictError'
    this.code = code
  }
}

export class WorkItemStoreInputError extends Error {
  readonly code = 'UNSUPPORTED_INPUT' as const

  constructor(readonly path: string, message: string) {
    super(message)
    this.name = 'WorkItemStoreInputError'
  }
}

export interface WorkItemCreateReceipt {
  requestId: string
  digest: string
  task: WorkTask
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

export type WorkDispatchStage = 'recorded' | 'dispatching' | 'linked' | 'outcome-unknown'

export interface WorkDispatchIntentReceipt {
  requestId: string
  digest: string
  taskId: string
  attemptId: string
  commandId: string
  runId: string
  stage: WorkDispatchStage
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

type StoredReceipt =
  | { kind: 'create'; digest: string; receipt: WorkItemCreateReceipt }
  | { kind: 'dispatch'; digest: string; receipt: WorkDispatchIntentReceipt }

interface WorkItemState {
  version: 1
  tasks: Record<string, WorkTaskSnapshot>
  requests: Record<string, StoredReceipt>
}

interface WorkItemStoreOptions {
  writeFile?: (path: string, data: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

const EMPTY_STATE: WorkItemState = { version: 1, tasks: {}, requests: {} }
const dateGetTime = Date.prototype.getTime
const mapEntries = Map.prototype.entries
const setValues = Set.prototype.values
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get
const regexpFlags = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')?.get

function ownValue<T>(dictionary: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined
}

function setOwnValue<T>(dictionary: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(dictionary, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

function assertExactBuiltin(value: object, prototype: object, allowedOwnKeys: string[], path: string): void {
  if (Object.getPrototypeOf(value) !== prototype) {
    throw new WorkItemStoreInputError(path, `${path} must use the exact built-in prototype`)
  }
  const allowed = new Set<PropertyKey>(allowedOwnKeys)
  if (Reflect.ownKeys(value).some((key) => !allowed.has(key))) {
    throw new WorkItemStoreInputError(path, `${path} cannot override built-in behavior or add properties`)
  }
}

class CanonicalEncoder {
  private readonly references = new Map<object, number>()

  encode(value: unknown, path = '$'): string {
    if (value === undefined) return 'u'
    if (value === null) return 'l'
    if (typeof value === 'string') return `s:${JSON.stringify(value)}`
    if (typeof value === 'boolean') return value ? 'b:1' : 'b:0'
    if (typeof value === 'bigint') return `i:${value.toString()}`
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return 'n:nan'
      if (value === Number.POSITIVE_INFINITY) return 'n:+inf'
      if (value === Number.NEGATIVE_INFINITY) return 'n:-inf'
      if (Object.is(value, -0)) return 'n:-0'
      return `n:${value.toString()}`
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new WorkItemStoreInputError(path, `${path} cannot be encoded for idempotency`)
    }
    if (utilTypes.isProxy(value)) {
      throw new WorkItemStoreInputError(path, `${path} cannot be a Proxy`)
    }

    const previousReference = this.references.get(value)
    if (previousReference !== undefined) return `r:${previousReference}`
    const reference = this.references.size
    this.references.set(value, reference)

    if (Array.isArray(value)) {
      const keys = this.ownStringKeys(value, path)
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
        throw new WorkItemStoreInputError(path, `${path} has an unsupported array length`)
      }
      const ownKeys = new Set(keys)
      const items = Array.from({ length: lengthDescriptor.value }, (_, index) =>
        ownKeys.has(String(index))
          ? `v:${this.propertyValue(value, String(index), `${path}[${index}]`)}`
          : 'h'
      )
      const indexKeys = new Set(Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)))
      const extras = keys.filter((key) => key !== 'length' && !indexKeys.has(key)).sort()
        .map((key) => this.property(value, key, `${path}.${key}`))
      return `a:${reference}:[${items.join(',')}]:{${extras.join(',')}}`
    }
    if (utilTypes.isDate(value)) {
      assertExactBuiltin(value, Date.prototype, [], path)
      return `d:${reference}:${dateGetTime.call(value).toString()}`
    }
    if (utilTypes.isRegExp(value)) {
      assertExactBuiltin(value, RegExp.prototype, ['lastIndex'], path)
      const lastIndex = Object.getOwnPropertyDescriptor(value, 'lastIndex')
      if (!lastIndex || !('value' in lastIndex) || !regexpSource || !regexpFlags) {
        throw new WorkItemStoreInputError(path, `${path} has an unsupported RegExp representation`)
      }
      return `x:${reference}:${JSON.stringify(regexpSource.call(value))}:${JSON.stringify(regexpFlags.call(value))}:${this.encode(lastIndex.value, `${path}.lastIndex`)}`
    }
    if (utilTypes.isMap(value)) {
      assertExactBuiltin(value, Map.prototype, [], path)
      const entries = Array.from(mapEntries.call(value), ([key, item], index) =>
        `${this.encode(key, `${path}.<key:${index}>`)}=>${this.encode(item, `${path}.<value:${index}>`)}`
      )
      return `m:${reference}:[${entries.join(',')}]`
    }
    if (utilTypes.isSet(value)) {
      assertExactBuiltin(value, Set.prototype, [], path)
      return `t:${reference}:[${Array.from(setValues.call(value), (item, index) =>
        this.encode(item, `${path}.<value:${index}>`)
      ).join(',')}]`
    }
    if (utilTypes.isAnyArrayBuffer(value) || ArrayBuffer.isView(value) || utilTypes.isNativeError(value)) {
      throw new WorkItemStoreInputError(path, `${path} has a structured-clone type without safe canonical support`)
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkItemStoreInputError(path, `${path} has an unsupported structured-clone type`)
    }
    const properties = this.ownStringKeys(value, path).sort()
      .map((key) => this.property(value, key, `${path}.${key}`))
    return `o:${reference}:${prototype === null ? 'null' : 'object'}:{${properties.join(',')}}`
  }

  private property(value: object, key: string, path: string): string {
    return `${JSON.stringify(key)}:${this.propertyValue(value, key, path)}`
  }

  private propertyValue(value: object, key: string, path: string): string {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) {
      throw new WorkItemStoreInputError(path, `${path} cannot use an accessor in idempotency input`)
    }
    return this.encode(descriptor.value, path)
  }

  private assertNoSymbols(value: object, path: string): void {
    this.ownStringKeys(value, path)
  }

  private ownStringKeys(value: object, path: string): string[] {
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new WorkItemStoreInputError(path, `${path} cannot contain symbol properties`)
    }
    return keys as string[]
  }
}

function requestDigest(kind: StoredReceipt['kind'], request: unknown): string {
  return createHash('sha256').update(`${kind}:${new CanonicalEncoder().encode(request)}`).digest('hex')
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

export class WorkItemStore {
  private readonly filePath: string
  private state: WorkItemState = copy(EMPTY_STATE)
  private initialized = false
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(snapshot: WorkTaskSnapshot) => void>()

  constructor(
    private readonly stateDirectory: string,
    private readonly options: WorkItemStoreOptions = {}
  ) {
    this.filePath = join(stateDirectory, 'work-items.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.stateDirectory, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as WorkItemState
      if (parsed.version !== 1 || typeof parsed.tasks !== 'object' || typeof parsed.requests !== 'object') {
        throw new Error('Unsupported work item state')
      }
      this.state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = copy(EMPTY_STATE)
    }
    this.initialized = true
  }

  async create(input: WorkTaskCreateRequest): Promise<WorkItemCreateReceipt> {
    return this.mutate(async () => {
      const request = validateWorkTaskCreateRequest(input)
      const digest = requestDigest('create', request)
      const replay = this.replay<WorkItemCreateReceipt>('create', request.requestId, digest)
      if (replay) return replay

      const now = new Date().toISOString()
      const task: WorkTask = {
        id: randomUUID(),
        revision: 1,
        title: request.title,
        scope: request.scope,
        requirements: [{ version: 1, goal: request.goal, acceptance: request.acceptance, createdAt: now }],
        currentRequirementVersion: 1,
        status: 'open',
        acceptedArtifactIds: [],
        createdAt: now,
        updatedAt: now
      }
      const snapshot: WorkTaskSnapshot = { task, attempts: [], runs: [], artifacts: [], actions: [] }
      const receipt: WorkItemCreateReceipt = {
        requestId: request.requestId, digest, task, snapshot, replayed: false
      }
      const next = copy(this.state)
      setOwnValue(next.tasks, task.id, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'create', digest, receipt })
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
  }

  async recordDispatchIntent(input: WorkTaskExecuteRequest): Promise<WorkDispatchIntentReceipt> {
    return this.mutate(async () => {
      const request = validateWorkTaskExecuteRequest(input)
      const digest = requestDigest('dispatch', request)
      const replay = this.replay<WorkDispatchIntentReceipt>('dispatch', request.requestId, digest)
      if (replay) return replay

      const current = ownValue(this.state.tasks, request.taskId)
      if (!current) {
        throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      }
      if (current.task.revision !== request.expectedRevision) {
        throw new WorkItemStoreConflictError(
          'REVISION_CONFLICT',
          `Expected task revision ${request.expectedRevision}, found ${current.task.revision}`
        )
      }

      const snapshot = copy(current)
      const now = new Date().toISOString()
      let attemptId = snapshot.task.activeAttemptId
      if (request.mode === 'continue-attempt') {
        if (!attemptId || !snapshot.attempts.some((attempt) => attempt.id === attemptId)) {
          throw new WorkItemStoreConflictError('ATTEMPT_NOT_FOUND', 'No active attempt is available to continue')
        }
      } else {
        attemptId = randomUUID()
        snapshot.attempts.push({
          id: attemptId,
          taskId: request.taskId,
          requirementVersion: snapshot.task.currentRequirementVersion,
          reason: request.mode === 'redo' ? 'redo' : 'initial',
          responsibility: request.executor,
          createdAt: now
        })
      }
      const commandId = randomUUID()
      const runId = ''
      snapshot.runs.push({
        taskId: request.taskId,
        attemptId,
        runId,
        executor: request.executor,
        commandId,
        requirementVersion: snapshot.task.currentRequirementVersion,
        ...(request.sourceRunId ? { sourceRunId: request.sourceRunId } : {}),
        status: 'queued',
        rawStatus: 'dispatch-intent-recorded',
        observedAt: now,
        capabilities: { cancel: false, resume: false, append: false }
      })
      snapshot.task.activeAttemptId = attemptId
      snapshot.task.status = 'active'
      snapshot.task.revision += 1
      snapshot.task.updatedAt = now

      const receipt: WorkDispatchIntentReceipt = {
        requestId: request.requestId,
        digest,
        taskId: request.taskId,
        attemptId,
        commandId,
        runId,
        stage: 'recorded',
        snapshot,
        replayed: false
      }
      const next = copy(this.state)
      setOwnValue(next.tasks, request.taskId, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'dispatch', digest, receipt })
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
  }

  async get(taskId: string): Promise<WorkTaskSnapshot | undefined> {
    this.assertInitialized()
    const snapshot = ownValue(this.state.tasks, taskId)
    return snapshot ? copy(snapshot) : undefined
  }

  async claimDispatch(requestId: string, commandId: string): Promise<WorkDispatchIntentReceipt> {
    return this.updateDispatch(requestId, commandId, (receipt, snapshot, run) => {
      if (receipt.stage !== 'recorded') return undefined
      run.rawStatus = 'dispatching'
      run.observedAt = new Date().toISOString()
      return { ...receipt, stage: 'dispatching', snapshot }
    })
  }

  async linkDispatch(
    requestId: string,
    commandId: string,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'runId' | 'status' | 'rawStatus' | 'capabilities'>
  ): Promise<WorkDispatchIntentReceipt> {
    if (execution.runId.trim() === '') throw new Error('Executor run id is required for dispatch linkage')
    return this.updateDispatch(requestId, commandId, (receipt, snapshot, run) => {
      if (receipt.stage === 'linked') {
        if (receipt.runId !== execution.runId) {
          throw new WorkItemStoreConflictError('REQUEST_ID_CONFLICT', `Dispatch ${requestId} is already linked to another run`)
        }
        return undefined
      }
      Object.assign(run, copy(execution), { observedAt: new Date().toISOString() })
      return { ...receipt, runId: execution.runId, stage: 'linked', snapshot }
    })
  }

  async markDispatchOutcomeUnknown(requestId: string, commandId: string, rawStatus: string): Promise<WorkDispatchIntentReceipt> {
    return this.updateDispatch(requestId, commandId, (receipt, snapshot, run) => {
      if (receipt.stage === 'linked') return undefined
      run.status = 'interrupted'
      run.rawStatus = rawStatus
      run.observedAt = new Date().toISOString()
      run.capabilities = { cancel: false, resume: false, append: false }
      return { ...receipt, stage: 'outcome-unknown', snapshot }
    })
  }

  async list(query: WorkItemQuery = {}): Promise<WorkTaskSnapshot[]> {
    this.assertInitialized()
    return Object.values(this.state.tasks).filter((snapshot) => {
      if (query.projectId && snapshot.task.scope.projectId !== query.projectId) return false
      if (query.employeeId && !snapshot.attempts.some((attempt) =>
        attempt.responsibility.kind === 'employee' && attempt.responsibility.employeeId === query.employeeId
      )) return false
      if (query.workflowId && !snapshot.attempts.some((attempt) =>
        attempt.responsibility.kind === 'workflow' && attempt.responsibility.workflowId === query.workflowId
      )) return false
      return true
    }).map(copy)
  }

  onChanged(listener: (snapshot: WorkTaskSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async updateDispatch(
    requestId: string,
    commandId: string,
    decide: (
      receipt: WorkDispatchIntentReceipt,
      snapshot: WorkTaskSnapshot,
      run: WorkTaskSnapshot['runs'][number]
    ) => WorkDispatchIntentReceipt | undefined
  ): Promise<WorkDispatchIntentReceipt> {
    return this.mutate(async () => {
      const stored = ownValue(this.state.requests, requestId)
      if (stored?.kind !== 'dispatch' || stored.receipt.commandId !== commandId) {
        throw new WorkItemStoreConflictError('REQUEST_ID_CONFLICT', `Dispatch ${requestId} does not match command ${commandId}`)
      }
      const snapshot = copy(ownValue(this.state.tasks, stored.receipt.taskId))
      if (snapshot === undefined) throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${stored.receipt.taskId} was not found`)
      const run = snapshot.runs.find((candidate) => candidate.commandId === commandId)
      if (run === undefined) throw new Error(`Dispatch ${requestId} has no durable run reference`)
      const current = { ...copy(stored.receipt), snapshot }
      const decided = decide(current, snapshot, run)
      if (decided === undefined) return copy(current)
      const receipt = { ...decided, snapshot }
      const next = copy(this.state)
      setOwnValue(next.tasks, receipt.taskId, snapshot)
      setOwnValue(next.requests, requestId, { kind: 'dispatch', digest: stored.digest, receipt })
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
  }

  private replay<T extends WorkItemCreateReceipt | WorkDispatchIntentReceipt>(
    kind: StoredReceipt['kind'],
    requestId: string,
    digest: string
  ): T | undefined {
    const stored = ownValue(this.state.requests, requestId)
    if (!stored) return undefined
    if (stored.kind !== kind || stored.digest !== digest) {
      throw new WorkItemStoreConflictError(
        'REQUEST_ID_CONFLICT',
        `Request id ${requestId} was already used with different content`
      )
    }
    return { ...copy(stored.receipt), replayed: true } as T
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized()
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(next: WorkItemState): Promise<void> {
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

  private emit(snapshot: WorkTaskSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(copy(snapshot))
      } catch {
        // Persistence has committed; one observer must not alter the mutation result or starve other observers.
      }
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkItemStore must be initialized before use')
  }
}
