import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

export interface WorkItemCreateReceipt {
  requestId: string
  digest: string
  task: WorkTask
  snapshot: WorkTaskSnapshot
  replayed: boolean
}

export type WorkDispatchStage = 'recorded' | 'outcome-unknown'

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

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return '"__undefined__"'
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`
  ).join(',')}}`
}

function requestDigest(kind: StoredReceipt['kind'], request: unknown): string {
  return createHash('sha256').update(`${kind}:${canonicalize(request)}`).digest('hex')
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
      next.tasks[task.id] = snapshot
      next.requests[request.requestId] = { kind: 'create', digest, receipt }
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

      const current = this.state.tasks[request.taskId]
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
      const runId = randomUUID()
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
      next.tasks[request.taskId] = snapshot
      next.requests[request.requestId] = { kind: 'dispatch', digest, receipt }
      await this.commit(next)
      this.emit(snapshot)
      return copy(receipt)
    })
  }

  async get(taskId: string): Promise<WorkTaskSnapshot | undefined> {
    this.assertInitialized()
    const snapshot = this.state.tasks[taskId]
    return snapshot ? copy(snapshot) : undefined
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

  private replay<T extends WorkItemCreateReceipt | WorkDispatchIntentReceipt>(
    kind: StoredReceipt['kind'],
    requestId: string,
    digest: string
  ): T | undefined {
    const stored = this.state.requests[requestId]
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
    for (const listener of this.listeners) listener(copy(snapshot))
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkItemStore must be initialized before use')
  }
}
