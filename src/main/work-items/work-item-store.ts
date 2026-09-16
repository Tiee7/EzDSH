import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { types as utilTypes } from 'node:util'

import {
  validateWorkActionAnswerRequest,
  validateWorkArtifactAcceptRequest,
  validateWorkRunControlRequest,
  validateWorkTaskArchiveRequest,
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  validateWorkTaskRevisionRequest,
  type WorkAction,
  type WorkActionAnswerRequest,
  type WorkArtifact,
  type WorkArtifactAcceptRequest,
  type WorkItemQuery,
  type WorkRunControlRequest,
  type WorkTask,
  type WorkTaskArchiveRequest,
  type WorkTaskCreateRequest,
  type WorkTaskExecuteRequest,
  type WorkTaskRevisionRequest,
  type WorkTaskSnapshot,
  type WorkExecutor
} from '../../shared/work-items.js'

export class WorkItemStoreConflictError extends Error {
  readonly code: 'REQUEST_ID_CONFLICT' | 'REVISION_CONFLICT' | 'ARCHIVE_CONFLICT' | 'TASK_NOT_FOUND' | 'ATTEMPT_NOT_FOUND' | 'RUN_NOT_FOUND' | 'ACTION_NOT_FOUND' | 'ACTION_CONFLICT' | 'ARTIFACT_NOT_FOUND' | 'ARTIFACT_CONFLICT'

  constructor(
    code: WorkItemStoreConflictError['code'],
    message: string
  ) {
    super(message)
    this.name = 'WorkItemStoreConflictError'
    this.code = code
  }
}

function isWorkflowBackedExecutor(executor: WorkExecutor): boolean {
  return executor.kind === 'workflow' || (executor.kind === 'employee' && executor.methodId !== undefined)
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

export interface WorkTaskRevisionReceipt {
  requestId: string
  digest: string
  taskId: string
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

export interface WorkTaskArchiveReceipt {
  requestId: string
  digest: string
  taskId: string
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

export interface WorkArtifactAcceptReceipt {
  requestId: string
  digest: string
  taskId: string
  artifactId: string
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

export interface WorkArtifactWriteIntent {
  requestId: string
  artifactId: string
  taskId: string
  attemptId: string
  runId: string
  requirementVersion: number
  contentVersion: number
  contentHash: string
  kind: WorkArtifact['kind']
  name: string
  storedPath: string
  sourceRef?: string
}

export interface WorkArtifactWriteReceipt extends WorkArtifactWriteIntent {
  digest: string
  stage: 'recorded' | 'linked'
  artifact?: WorkArtifact
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

type StoredReceipt =
  | { kind: 'create'; digest: string; receipt: WorkItemCreateReceipt }
  | { kind: 'dispatch'; digest: string; receipt: WorkDispatchIntentReceipt }
  | { kind: 'action-answer'; digest: string; receipt: WorkActionAnswerReceipt }
  | { kind: 'run-control'; digest: string; receipt: WorkRunControlReceipt }
  | { kind: 'revise'; digest: string; receipt: WorkTaskRevisionReceipt }
  | { kind: 'archive'; digest: string; receipt: WorkTaskArchiveReceipt }
  | { kind: 'artifact-accept'; digest: string; receipt: WorkArtifactAcceptReceipt }
  | { kind: 'artifact-write'; digest: string; receipt: WorkArtifactWriteReceipt }

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

function normalizeArtifactWriteIntent(input: WorkArtifactWriteIntent): WorkArtifactWriteIntent {
  const identifier = (value: string, field: string): string => {
    if (typeof value !== 'string') throw new WorkItemStoreInputError(field, `${field} must be a string`)
    const normalized = value.trim()
    if (normalized.length === 0 || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new WorkItemStoreInputError(field, `${field} is invalid`)
    }
    return normalized
  }
  if (!['text', 'json', 'file'].includes(input.kind)) {
    throw new WorkItemStoreInputError('kind', 'kind is not supported')
  }
  if (
    typeof input.name !== 'string'
    || input.name.trim() === ''
    || input.name.length > 255
    || /[\u0000-\u001f\u007f]/u.test(input.name)
  ) {
    throw new WorkItemStoreInputError('name', 'name is invalid')
  }
  if (typeof input.storedPath !== 'string' || input.storedPath.trim() === '' || input.storedPath.length > 4_096) {
    throw new WorkItemStoreInputError('storedPath', 'storedPath is required')
  }
  if (input.sourceRef !== undefined && (typeof input.sourceRef !== 'string' || input.sourceRef.length > 4_096)) {
    throw new WorkItemStoreInputError('sourceRef', 'sourceRef is invalid')
  }
  return {
    ...copy(input),
    requestId: identifier(input.requestId, 'requestId'),
    artifactId: identifier(input.artifactId, 'artifactId'),
    taskId: identifier(input.taskId, 'taskId'),
    attemptId: identifier(input.attemptId, 'attemptId'),
    runId: identifier(input.runId, 'runId'),
    name: input.name.trim(),
  }
}

interface ArtifactReservationEvidence {
  source: 'receipt' | 'artifact'
  requestId?: string
  artifactId: string
  contentHash: string
  linked: boolean
}

function artifactReservationKey(taskId: string, runId: string, contentVersion: number): string {
  return `${JSON.stringify(taskId)}:${JSON.stringify(runId)}:${contentVersion}`
}

function assertArtifactReservationIntegrity(state: WorkItemState): void {
  const reservations = new Map<string, ArtifactReservationEvidence>()
  const add = (key: string, incoming: ArtifactReservationEvidence): void => {
    const existing = reservations.get(key)
    if (existing === undefined) {
      reservations.set(key, incoming)
      return
    }
    const sameReceipt = existing.source === 'receipt'
      && incoming.source === 'receipt'
      && existing.requestId === incoming.requestId
      && existing.artifactId === incoming.artifactId
      && existing.contentHash === incoming.contentHash
    const linkedReceiptArtifactPair = existing.source !== incoming.source
      && existing.linked
      && incoming.linked
      && existing.artifactId === incoming.artifactId
      && existing.contentHash === incoming.contentHash
    const sameStandaloneArtifact = existing.source === 'artifact'
      && incoming.source === 'artifact'
      && existing.artifactId === incoming.artifactId
      && existing.contentHash === incoming.contentHash
    if (!sameReceipt && !linkedReceiptArtifactPair && !sameStandaloneArtifact) {
      throw new WorkItemStoreConflictError(
        'ARTIFACT_CONFLICT',
        `Conflicting artifact reservations exist for ${key}`
      )
    }
  }

  for (const [requestKey, stored] of Object.entries(state.requests)) {
    if (stored.kind !== 'artifact-write') continue
    const receipt = stored.receipt
    if (requestKey !== receipt.requestId) {
      throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact receipt ${requestKey} has mismatched identity`)
    }
    const task = ownValue(state.tasks, receipt.taskId)
    if (task === undefined) {
      throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact receipt ${receipt.requestId} has no task`)
    }
    if (receipt.stage === 'linked') {
      const artifact = receipt.artifact
      const taskArtifact = task.artifacts.find((candidate) => candidate.id === receipt.artifactId)
      if (
        artifact === undefined
        || taskArtifact === undefined
        || artifact.id !== receipt.artifactId
        || artifact.taskId !== receipt.taskId
        || artifact.attemptId !== receipt.attemptId
        || artifact.runId !== receipt.runId
        || artifact.requirementVersion !== receipt.requirementVersion
        || artifact.contentVersion !== receipt.contentVersion
        || artifact.contentHash !== receipt.contentHash
        || artifact.kind !== receipt.kind
        || artifact.name !== receipt.name
        || artifact.storedPath !== receipt.storedPath
        || taskArtifact.taskId !== receipt.taskId
        || taskArtifact.attemptId !== receipt.attemptId
        || taskArtifact.runId !== receipt.runId
        || taskArtifact.requirementVersion !== receipt.requirementVersion
        || taskArtifact.contentVersion !== receipt.contentVersion
        || taskArtifact.contentHash !== receipt.contentHash
        || taskArtifact.kind !== receipt.kind
        || taskArtifact.name !== receipt.name
        || taskArtifact.storedPath !== receipt.storedPath
      ) {
        throw new WorkItemStoreConflictError(
          'ARTIFACT_CONFLICT',
          `Linked artifact receipt ${receipt.requestId} does not match task metadata`
        )
      }
    } else if (receipt.artifact !== undefined) {
      throw new WorkItemStoreConflictError(
        'ARTIFACT_CONFLICT',
        `Recorded artifact receipt ${receipt.requestId} cannot contain linked metadata`
      )
    }
    add(artifactReservationKey(receipt.taskId, receipt.runId, receipt.contentVersion), {
      source: 'receipt',
      requestId: receipt.requestId,
      artifactId: receipt.artifactId,
      contentHash: receipt.contentHash,
      linked: receipt.stage === 'linked',
    })
  }

  for (const [taskId, snapshot] of Object.entries(state.tasks)) {
    for (const artifact of snapshot.artifacts) {
      if (artifact.taskId !== taskId) {
        throw new WorkItemStoreConflictError(
          'ARTIFACT_CONFLICT',
          `Artifact ${artifact.id} is stored under the wrong task`
        )
      }
      add(artifactReservationKey(taskId, artifact.runId, artifact.contentVersion), {
        source: 'artifact',
        artifactId: artifact.id,
        contentHash: artifact.contentHash,
        linked: true,
      })
    }
  }
}

export class WorkItemStore {
  private readonly filePath: string
  private state: WorkItemState = copy(EMPTY_STATE)
  private initialized = false
  private integrityError: WorkItemStoreConflictError | undefined
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(snapshot: WorkTaskSnapshot) => void>()

  constructor(
    private readonly stateDirectory: string,
    private readonly options: WorkItemStoreOptions = {}
  ) {
    this.filePath = join(stateDirectory, 'work-items.json')
  }

  async initialize(): Promise<void> {
    if (this.integrityError !== undefined) throw this.integrityError
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
    try {
      assertArtifactReservationIntegrity(this.state)
    } catch (error) {
      if (error instanceof WorkItemStoreConflictError) this.integrityError = error
      throw error
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

  async revise(input: WorkTaskRevisionRequest): Promise<WorkTaskRevisionReceipt> {
    return this.mutate(async () => {
      const request = validateWorkTaskRevisionRequest(input)
      const digest = requestDigest('revise', request)
      const replay = this.replay<WorkTaskRevisionReceipt>('revise', request.requestId, digest)
      if (replay) return replay

      const current = ownValue(this.state.tasks, request.taskId)
      if (current === undefined) {
        throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      }
      if (current.task.revision !== request.expectedRevision) {
        throw new WorkItemStoreConflictError(
          'REVISION_CONFLICT',
          `Expected task revision ${request.expectedRevision}, found ${current.task.revision}`
        )
      }
      if (current.task.status === 'cancelled') {
        throw new WorkItemStoreConflictError('REVISION_CONFLICT', `Cancelled task ${request.taskId} cannot be revised`)
      }

      const snapshot = copy(current)
      const now = new Date().toISOString()
      const requirementVersion = snapshot.task.currentRequirementVersion + 1
      snapshot.task.requirements.push({
        version: requirementVersion,
        goal: request.goal,
        acceptance: request.acceptance,
        createdAt: now,
      })
      snapshot.task.currentRequirementVersion = requirementVersion
      snapshot.task.activeAttemptId = undefined
      snapshot.task.status = 'open'
      snapshot.task.revision += 1
      snapshot.task.updatedAt = now
      const receipt: WorkTaskRevisionReceipt = {
        requestId: request.requestId,
        digest,
        taskId: request.taskId,
        snapshot,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.tasks, request.taskId, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'revise', digest, receipt })
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
  }

  async archive(input: WorkTaskArchiveRequest): Promise<WorkTaskArchiveReceipt> {
    return this.mutate(async () => {
      const request = validateWorkTaskArchiveRequest(input)
      const digest = requestDigest('archive', request)
      const replay = this.replay<WorkTaskArchiveReceipt>('archive', request.requestId, digest)
      if (replay) return replay

      const current = ownValue(this.state.tasks, request.taskId)
      if (current === undefined) {
        throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      }
      if (current.task.revision !== request.expectedRevision) {
        throw new WorkItemStoreConflictError(
          'REVISION_CONFLICT',
          `Expected task revision ${request.expectedRevision}, found ${current.task.revision}`
        )
      }

      const isArchived = current.task.archivedAt !== undefined
      const snapshot = copy(current)
      if (isArchived !== request.archived) {
        if (request.archived) {
          const activeRun = snapshot.runs.find((run) =>
            ['queued', 'running', 'waiting', 'paused', 'cancelling'].includes(run.status)
          )
          if (activeRun !== undefined) {
            throw new WorkItemStoreConflictError(
              'ARCHIVE_CONFLICT',
              `Task ${request.taskId} has an active ${activeRun.status} run`
            )
          }
          if (snapshot.actions.some((action) => action.status === 'open')) {
            throw new WorkItemStoreConflictError(
              'ARCHIVE_CONFLICT',
              `Task ${request.taskId} has an open action`
            )
          }
        }

        const now = new Date().toISOString()
        if (request.archived) snapshot.task.archivedAt = now
        else delete snapshot.task.archivedAt
        snapshot.task.revision += 1
        snapshot.task.updatedAt = now
      }

      const receipt: WorkTaskArchiveReceipt = {
        requestId: request.requestId,
        digest,
        taskId: request.taskId,
        snapshot,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.tasks, request.taskId, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'archive', digest, receipt })
      await this.commit(next)
      if (isArchived !== request.archived) this.emit(snapshot)
      return copy(receipt)
    })
  }

  async beginArtifactWrite(input: WorkArtifactWriteIntent): Promise<WorkArtifactWriteReceipt> {
    return this.mutate(async () => {
      const request = normalizeArtifactWriteIntent(input)
      const digest = requestDigest('artifact-write', request)
      assertArtifactReservationIntegrity(this.state)
      const replay = this.replay<WorkArtifactWriteReceipt>('artifact-write', request.requestId, digest)
      if (replay) return replay
      const snapshot = copy(ownValue(this.state.tasks, request.taskId))
      if (snapshot === undefined) {
        throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      }
      const run = snapshot.runs.find((candidate) => candidate.runId === request.runId)
      if (run === undefined || run.attemptId !== request.attemptId || run.requirementVersion !== request.requirementVersion) {
        throw new WorkItemStoreConflictError(
          'ARTIFACT_CONFLICT',
          `Artifact ${request.artifactId} does not match its source run and attempt`
        )
      }
      if (!snapshot.attempts.some((attempt) =>
        attempt.id === request.attemptId
        && attempt.taskId === request.taskId
        && attempt.requirementVersion === request.requirementVersion
      )) {
        throw new WorkItemStoreConflictError('ATTEMPT_NOT_FOUND', `Attempt ${request.attemptId} was not found`)
      }
      if (!Number.isSafeInteger(request.requirementVersion) || request.requirementVersion < 1) {
        throw new WorkItemStoreInputError('requirementVersion', 'requirementVersion must be a positive safe integer')
      }
      if (!Number.isSafeInteger(request.contentVersion) || request.contentVersion < 1) {
        throw new WorkItemStoreInputError('contentVersion', 'contentVersion must be a positive safe integer')
      }
      if (typeof request.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(request.contentHash)) {
        throw new WorkItemStoreInputError('contentHash', 'contentHash must be a lowercase SHA-256 digest')
      }
      if (snapshot.artifacts.some((artifact) => artifact.id === request.artifactId)) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact ${request.artifactId} already exists`)
      }
      const receipt: WorkArtifactWriteReceipt = {
        ...copy(request),
        digest,
        stage: 'recorded',
        snapshot,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.requests, request.requestId, { kind: 'artifact-write', digest, receipt })
      assertArtifactReservationIntegrity(next)
      await this.commit(next)
      return copy(receipt)
    })
  }

  async completeArtifactWrite(
    requestId: string,
    artifactId: string,
    verify: (artifact: WorkArtifact) => Promise<boolean>,
  ): Promise<WorkArtifactWriteReceipt> {
    return this.mutate(async () => {
      assertArtifactReservationIntegrity(this.state)
      const stored = ownValue(this.state.requests, requestId)
      if (stored?.kind !== 'artifact-write' || stored.receipt.artifactId !== artifactId) {
        throw new WorkItemStoreConflictError(
          'REQUEST_ID_CONFLICT',
          `Artifact write ${requestId} does not match artifact ${artifactId}`
        )
      }
      if (stored.receipt.stage === 'linked') return { ...copy(stored.receipt), replayed: true }
      const snapshot = copy(ownValue(this.state.tasks, stored.receipt.taskId))
      if (snapshot === undefined) {
        throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${stored.receipt.taskId} was not found`)
      }
      const receipt = stored.receipt
      const run = snapshot.runs.find((candidate) => candidate.runId === receipt.runId)
      if (run === undefined || run.attemptId !== receipt.attemptId || run.requirementVersion !== receipt.requirementVersion) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact ${artifactId} source run changed`)
      }
      const artifact: WorkArtifact = {
        id: receipt.artifactId,
        taskId: receipt.taskId,
        attemptId: receipt.attemptId,
        runId: receipt.runId,
        requirementVersion: receipt.requirementVersion,
        contentVersion: receipt.contentVersion,
        contentHash: receipt.contentHash,
        kind: receipt.kind,
        name: receipt.name,
        storedPath: receipt.storedPath,
        createdAt: new Date().toISOString(),
      }
      if (!await verify(copy(artifact))) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact ${artifactId} content is missing or invalid`)
      }
      const existing = snapshot.artifacts.find((candidate) => candidate.id === artifactId)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(artifact)) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact ${artifactId} metadata changed`)
      }
      if (existing === undefined) snapshot.artifacts.push(artifact)
      snapshot.task.revision += 1
      snapshot.task.updatedAt = new Date().toISOString()
      const completed: WorkArtifactWriteReceipt = {
        ...copy(receipt),
        stage: 'linked',
        artifact,
        snapshot,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.tasks, receipt.taskId, snapshot)
      setOwnValue(next.requests, requestId, { kind: 'artifact-write', digest: stored.digest, receipt: completed })
      assertArtifactReservationIntegrity(next)
      await this.commit(next)
      this.emit(snapshot)
      return copy(completed)
    })
  }

  async pendingArtifactWrites(): Promise<WorkArtifactWriteReceipt[]> {
    this.assertInitialized()
    return Object.values(this.state.requests)
      .filter((stored): stored is Extract<StoredReceipt, { kind: 'artifact-write' }> =>
        stored.kind === 'artifact-write' && stored.receipt.stage === 'recorded'
      )
      .map((stored) => copy(stored.receipt))
  }

  async getArtifactWrite(requestId: string): Promise<WorkArtifactWriteReceipt | undefined> {
    this.assertInitialized()
    const stored = ownValue(this.state.requests, requestId)
    return stored?.kind === 'artifact-write' ? copy(stored.receipt) : undefined
  }

  async acceptArtifact(
    input: WorkArtifactAcceptRequest,
    verify: (artifact: WorkArtifact) => Promise<boolean>,
  ): Promise<WorkArtifactAcceptReceipt> {
    return this.mutate(async () => {
      assertArtifactReservationIntegrity(this.state)
      const request = validateWorkArtifactAcceptRequest(input)
      const digest = requestDigest('artifact-accept', request)
      const replay = this.replay<WorkArtifactAcceptReceipt>('artifact-accept', request.requestId, digest)
      if (replay) return replay
      const snapshot = copy(ownValue(this.state.tasks, request.taskId))
      if (snapshot === undefined) {
        throw new WorkItemStoreConflictError('TASK_NOT_FOUND', `Task ${request.taskId} was not found`)
      }
      if (snapshot.task.revision !== request.expectedRevision) {
        throw new WorkItemStoreConflictError(
          'REVISION_CONFLICT',
          `Expected task revision ${request.expectedRevision}, found ${snapshot.task.revision}`
        )
      }
      if (snapshot.task.status === 'cancelled') {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Cancelled task ${request.taskId} cannot accept artifacts`)
      }
      if (snapshot.task.currentRequirementVersion !== request.requirementVersion) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', 'Artifact requirement version is stale')
      }
      const artifact = snapshot.artifacts.find((candidate) => candidate.id === request.artifactId)
      if (artifact === undefined) {
        throw new WorkItemStoreConflictError('ARTIFACT_NOT_FOUND', `Artifact ${request.artifactId} was not found`)
      }
      if (
        artifact.taskId !== request.taskId
        || artifact.requirementVersion !== request.requirementVersion
        || artifact.contentVersion !== request.contentVersion
      ) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact ${request.artifactId} version is stale`)
      }
      const run = snapshot.runs.find((candidate) => candidate.runId === artifact.runId)
      if (
        run === undefined
        || run.taskId !== request.taskId
        || run.attemptId !== artifact.attemptId
        || run.requirementVersion !== artifact.requirementVersion
      ) {
        throw new WorkItemStoreConflictError('ARTIFACT_CONFLICT', `Artifact ${request.artifactId} source is invalid`)
      }
      if (!await verify(copy(artifact))) {
        throw new WorkItemStoreConflictError(
          'ARTIFACT_CONFLICT',
          `Artifact ${request.artifactId} stored content is missing or invalid`
        )
      }
      const changesBusinessState = !snapshot.task.acceptedArtifactIds.includes(artifact.id) || snapshot.task.status !== 'completed'
      if (!snapshot.task.acceptedArtifactIds.includes(artifact.id)) {
        snapshot.task.acceptedArtifactIds.push(artifact.id)
      }
      // A successful explicit acceptance is the business decision that completes this task.
      // Executor completion and artifact registration never change the task to completed.
      snapshot.task.status = 'completed'
      if (changesBusinessState) {
        snapshot.task.revision += 1
        snapshot.task.updatedAt = new Date().toISOString()
      }
      const receipt: WorkArtifactAcceptReceipt = {
        requestId: request.requestId,
        digest,
        taskId: request.taskId,
        artifactId: artifact.id,
        snapshot,
        replayed: false,
      }
      const next = copy(this.state)
      setOwnValue(next.tasks, request.taskId, snapshot)
      setOwnValue(next.requests, request.requestId, { kind: 'artifact-accept', digest, receipt })
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
      if (request.mode === 'handoff') {
        if (snapshot.attempts.length === 0) {
          throw new WorkItemStoreConflictError('ATTEMPT_NOT_FOUND', 'No prior attempt is available to hand off')
        }
        if (request.sourceRunId && !snapshot.runs.some((run) => run.runId === request.sourceRunId)) {
          throw new WorkItemStoreConflictError('RUN_NOT_FOUND', 'The handoff source run does not belong to this task')
        }
      }
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
          reason: request.mode === 'redo' ? 'redo' : request.mode === 'handoff' ? 'handoff' : 'initial',
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
      if (!query.includeArchived && snapshot.task.archivedAt !== undefined) return false
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
      if (run === undefined || !isWorkflowBackedExecutor(run.executor)) {
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

  /**
   * Project a newer Employee run state into its durable Work Item reference.
   * Employee runs are observed outside this store, so this update is deliberately
   * idempotent and does not bump the task revision for an unchanged projection.
   */
  async syncRun(
    taskId: string,
    runId: string,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>,
  ): Promise<WorkTaskSnapshot | undefined> {
    return this.mutate(async () => {
      const current = ownValue(this.state.tasks, taskId)
      if (current === undefined) return undefined
      const snapshot = copy(current)
      const run = snapshot.runs.find((candidate) => candidate.runId === runId)
      if (run === undefined) return undefined
      if (JSON.stringify({ status: run.status, rawStatus: run.rawStatus, capabilities: run.capabilities })
        === JSON.stringify(execution)) return snapshot
      Object.assign(run, copy(execution), { observedAt: new Date().toISOString() })
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
      if (run === undefined || !isWorkflowBackedExecutor(run.executor) || run.requirementVersion !== action.requirementVersion) {
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

  private replay<T extends
    | WorkItemCreateReceipt
    | WorkDispatchIntentReceipt
    | WorkActionAnswerReceipt
    | WorkRunControlReceipt
    | WorkTaskRevisionReceipt
    | WorkTaskArchiveReceipt
    | WorkArtifactAcceptReceipt
    | WorkArtifactWriteReceipt
  >(
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
    assertArtifactReservationIntegrity(next)
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
    if (this.integrityError !== undefined) throw this.integrityError
    if (!this.initialized) throw new Error('WorkItemStore must be initialized before use')
  }
}
