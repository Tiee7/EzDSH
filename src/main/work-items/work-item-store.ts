import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { types as utilTypes } from 'node:util'

import {
  validateWorkActionAnswerRequest,
  validateWorkRunControlRequest,
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  type WorkAction,
  type WorkActionAnswerRequest,
  type WorkItemQuery,
  type WorkRunControlRequest,
  type WorkTask,
  type WorkTaskCreateRequest,
  type WorkTaskExecuteRequest,
  type WorkTaskSnapshot
} from '../../shared/work-items.js'

export class WorkItemStoreConflictError extends Error {
  readonly code: 'REQUEST_ID_CONFLICT' | 'REVISION_CONFLICT' | 'TASK_NOT_FOUND' | 'ATTEMPT_NOT_FOUND' | 'RUN_NOT_FOUND' | 'ACTION_NOT_FOUND' | 'ACTION_CONFLICT'

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

export interface WorkActionAnswerReceipt {
  requestId: string
  digest: string
  taskId: string
  actionId: string
  stage: 'recorded' | 'resolved' | 'rejected'
  rejectionReason?: string
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

export interface WorkRunControlReceipt {
  requestId: string
  digest: string
  taskId: string
  runId: string
  action: WorkRunControlRequest['action']
  stage: 'recorded' | 'processed'
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

type StoredReceipt =
  | { kind: 'create'; digest: string; receipt: WorkItemCreateReceipt }
  | { kind: 'dispatch'; digest: string; receipt: WorkDispatchIntentReceipt }
  | { kind: 'action-answer'; digest: string; receipt: WorkActionAnswerReceipt }
  | { kind: 'run-control'; digest: string; receipt: WorkRunControlReceipt }

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

function strongerActionStatus(current: WorkAction['status'], incoming: WorkAction['status']): WorkAction['status'] {
  const precedence: Record<WorkAction['status'], number> = { open: 0, superseded: 1, resolved: 2 }
  return precedence[incoming] > precedence[current] ? incoming : current
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

  async syncWorkflowActions(taskId: string, runId: string, actions: WorkAction[]): Promise<WorkTaskSnapshot> {
    return this.mutate(async () => {
      const current = ownValue(this.state.tasks, taskId)
      if (current === undefined) throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${taskId} was not found`)
      const snapshot = copy(current)
      const run = snapshot.runs.find((candidate) => candidate.runId === runId)
      if (run === undefined || run.executor.kind !== 'workflow') {
        throw new WorkItemStoreConflictError('RUN_NOT_FOUND', `Workflow run ${runId} was not found on task ${taskId}`)
      }
      for (const action of actions) {
        if (action.taskId !== taskId || action.runId !== runId || action.requirementVersion !== run.requirementVersion) {
          throw new WorkItemStoreConflictError('ACTION_CONFLICT', `Action ${action.id} does not match its WorkTask run`)
        }
      }
      const incomingById = new Map(actions.map((action) => [action.id, action]))
      const nextActions = snapshot.actions.map((existing) => {
        if (existing.runId !== runId) return existing
        const incoming = incomingById.get(existing.id)
        if (incoming === undefined) return existing
        incomingById.delete(existing.id)
        return { ...copy(incoming), status: strongerActionStatus(existing.status, incoming.status) }
      })
      for (const action of actions) {
        const added = incomingById.get(action.id)
        if (added !== undefined) {
          nextActions.push(copy(added))
          incomingById.delete(action.id)
        }
      }
      if (JSON.stringify(nextActions) === JSON.stringify(snapshot.actions)) return snapshot
      snapshot.actions = nextActions
      snapshot.task.revision += 1
      snapshot.task.updatedAt = new Date().toISOString()
      const next = copy(this.state)
      setOwnValue(next.tasks, taskId, snapshot)
      await this.commit(next)
      this.emit(snapshot)
      return copy(snapshot)
    })
  }

  async beginActionAnswer(input: WorkActionAnswerRequest): Promise<WorkActionAnswerReceipt> {
    return this.mutate(async () => {
      const request = validateWorkActionAnswerRequest(input)
      const digest = requestDigest('action-answer', request)
      const replay = this.replay<WorkActionAnswerReceipt>('action-answer', request.requestId, digest)
      if (replay) return replay
      const snapshot = copy(ownValue(this.state.tasks, request.taskId))
      if (snapshot === undefined) throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      const action = snapshot.actions.find((candidate) => candidate.id === request.actionId)
      if (action === undefined) throw new WorkItemStoreConflictError('ACTION_NOT_FOUND', `Action ${request.actionId} was not found on task ${request.taskId}`)
      if (action.status !== 'open') throw new WorkItemStoreConflictError('ACTION_CONFLICT', `Action ${request.actionId} is no longer open`)
      if (action.sourceEventId !== request.expectedSourceEventId) throw new WorkItemStoreConflictError('ACTION_CONFLICT', `Action ${request.actionId} source event is stale`)
      if (action.requirementVersion !== request.expectedRequirementVersion) throw new WorkItemStoreConflictError('ACTION_CONFLICT', `Action ${request.actionId} requirement version is stale`)
      const run = snapshot.runs.find((candidate) => candidate.runId === action.runId)
      if (run === undefined || run.executor.kind !== 'workflow' || run.requirementVersion !== action.requirementVersion) {
        throw new WorkItemStoreConflictError('RUN_NOT_FOUND', `Workflow run ${action.runId} no longer matches action ${action.id}`)
      }
      const activeClaim = Object.values(this.state.requests).find((stored): stored is Extract<StoredReceipt, { kind: 'action-answer' }> =>
        stored.kind === 'action-answer'
        && stored.receipt.taskId === request.taskId
        && stored.receipt.actionId === request.actionId
        && stored.receipt.stage === 'recorded')
      if (activeClaim !== undefined) {
        throw new WorkItemStoreConflictError('ACTION_CONFLICT', `Action ${request.actionId} is claimed by another request`)
      }
      const receipt: WorkActionAnswerReceipt = {
        requestId: request.requestId, digest, taskId: request.taskId, actionId: request.actionId,
        stage: 'recorded', snapshot, replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.requests, request.requestId, { kind: 'action-answer', digest, receipt })
      await this.commit(next)
      return copy(receipt)
    })
  }

  async rejectActionAnswer(input: WorkActionAnswerRequest, reason: string): Promise<WorkActionAnswerReceipt> {
    return this.mutate(async () => {
      const request = validateWorkActionAnswerRequest(input)
      const digest = requestDigest('action-answer', request)
      const stored = ownValue(this.state.requests, request.requestId)
      if (stored?.kind !== 'action-answer' || stored.digest !== digest) {
        throw new WorkItemStoreConflictError('REQUEST_ID_CONFLICT', `Action answer ${request.requestId} was not recorded with this content`)
      }
      if (stored.receipt.stage !== 'recorded') return { ...copy(stored.receipt), replayed: true }
      const receipt: WorkActionAnswerReceipt = {
        ...copy(stored.receipt),
        stage: 'rejected',
        rejectionReason: reason,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.requests, request.requestId, { kind: 'action-answer', digest, receipt })
      await this.commit(next)
      return copy(receipt)
    })
  }

  async completeActionAnswer(
    input: WorkActionAnswerRequest,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>,
  ): Promise<WorkActionAnswerReceipt> {
    return this.mutate(async () => {
      const request = validateWorkActionAnswerRequest(input)
      const digest = requestDigest('action-answer', request)
      const stored = ownValue(this.state.requests, request.requestId)
      if (stored?.kind !== 'action-answer' || stored.digest !== digest) {
        throw new WorkItemStoreConflictError('REQUEST_ID_CONFLICT', `Action answer ${request.requestId} was not recorded with this content`)
      }
      if (stored.receipt.stage === 'resolved') return { ...copy(stored.receipt), replayed: true }
      const snapshot = copy(ownValue(this.state.tasks, request.taskId))
      if (snapshot === undefined) throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      const action = snapshot.actions.find((candidate) => candidate.id === request.actionId)
      if (action === undefined) throw new WorkItemStoreConflictError('ACTION_NOT_FOUND', `Action ${request.actionId} was not found on task ${request.taskId}`)
      if (action.status === 'superseded' || action.sourceEventId !== request.expectedSourceEventId || action.requirementVersion !== request.expectedRequirementVersion) {
        throw new WorkItemStoreConflictError('ACTION_CONFLICT', `Action ${request.actionId} changed before the answer was saved`)
      }
      const run = snapshot.runs.find((candidate) => candidate.runId === action.runId)
      if (run === undefined) throw new WorkItemStoreConflictError('RUN_NOT_FOUND', `Run ${action.runId} was not found on task ${request.taskId}`)
      action.status = 'resolved'
      Object.assign(run, copy(execution), { observedAt: new Date().toISOString() })
      snapshot.task.revision += 1
      snapshot.task.updatedAt = new Date().toISOString()
      const receipt: WorkActionAnswerReceipt = { ...copy(stored.receipt), stage: 'resolved', snapshot, replayed: false }
      const next = copy(this.state)
      setOwnValue(next.tasks, request.taskId, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'action-answer', digest, receipt })
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
  }

  async beginRunControl(input: WorkRunControlRequest): Promise<WorkRunControlReceipt> {
    return this.mutate(async () => {
      const request = validateWorkRunControlRequest(input)
      const digest = requestDigest('run-control', request)
      const replay = this.replay<WorkRunControlReceipt>('run-control', request.requestId, digest)
      if (replay) return replay
      const snapshot = copy(ownValue(this.state.tasks, request.taskId))
      if (snapshot === undefined) throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      if (snapshot.task.revision !== request.expectedRevision) {
        throw new WorkItemStoreConflictError('REVISION_CONFLICT', `Expected task revision ${request.expectedRevision}, found ${snapshot.task.revision}`)
      }
      const run = snapshot.runs.find((candidate) => candidate.runId === request.runId)
      if (run === undefined) throw new WorkItemStoreConflictError('RUN_NOT_FOUND', `Run ${request.runId} was not found on task ${request.taskId}`)
      if (!run.capabilities[request.action]) throw new WorkItemStoreConflictError('ACTION_CONFLICT', `${run.executor.kind} run ${request.runId} does not support ${request.action}`)
      const receipt: WorkRunControlReceipt = {
        requestId: request.requestId, digest, taskId: request.taskId, runId: request.runId,
        action: request.action, stage: 'recorded', snapshot, replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.requests, request.requestId, { kind: 'run-control', digest, receipt })
      await this.commit(next)
      return copy(receipt)
    })
  }

  async completeRunControl(
    input: WorkRunControlRequest,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>,
  ): Promise<WorkRunControlReceipt> {
    return this.mutate(async () => {
      const request = validateWorkRunControlRequest(input)
      const digest = requestDigest('run-control', request)
      const stored = ownValue(this.state.requests, request.requestId)
      if (stored?.kind !== 'run-control' || stored.digest !== digest) {
        throw new WorkItemStoreConflictError('REQUEST_ID_CONFLICT', `Run control ${request.requestId} was not recorded with this content`)
      }
      if (stored.receipt.stage === 'processed') return { ...copy(stored.receipt), replayed: true }
      const snapshot = copy(ownValue(this.state.tasks, request.taskId))
      if (snapshot === undefined) throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      const run = snapshot.runs.find((candidate) => candidate.runId === request.runId)
      if (run === undefined) throw new WorkItemStoreConflictError('RUN_NOT_FOUND', `Run ${request.runId} was not found on task ${request.taskId}`)
      Object.assign(run, copy(execution), { observedAt: new Date().toISOString() })
      snapshot.task.revision += 1
      snapshot.task.updatedAt = new Date().toISOString()
      const receipt: WorkRunControlReceipt = { ...copy(stored.receipt), stage: 'processed', snapshot, replayed: false }
      const next = copy(this.state)
      setOwnValue(next.tasks, request.taskId, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'run-control', digest, receipt })
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
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

  private replay<T extends WorkItemCreateReceipt | WorkDispatchIntentReceipt | WorkActionAnswerReceipt | WorkRunControlReceipt>(
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
