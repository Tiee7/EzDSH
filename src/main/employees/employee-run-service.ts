import { createHash, randomUUID } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import type { EmployeeDefinition, EmployeeRunResult, EmployeeSessionLock } from '../../shared/employees.js'
import type {
  EmployeeRunContext,
  EmployeeRunEvent,
  EmployeeRunRecord,
  EmployeeRunRoundInput,
  EmployeeRunStartReceipt,
  EmployeeRunStartRequest,
  EmployeeRunTaskInput,
} from '../../shared/employee-runs.js'
import type { EmployeeRunClient } from './employee-service.js'
import { EmployeeRunStore, EmployeeRunStoreConflictError } from './employee-run-store.js'

export interface EmployeeRunServiceOptions {
  store: EmployeeRunStore
  cwd: string
  createClient: () => EmployeeRunClient
  resolveEmployee: (employeeId: string) => EmployeeDefinition | undefined
  buildPrompt?: (employee: EmployeeDefinition, task: string, projectId?: string, sessionId?: string) => string
}

export class EmployeeRunInputError extends Error {
  readonly code = 'UNSUPPORTED_INPUT' as const

  constructor(readonly path: string, message: string) {
    super(message)
    this.name = 'EmployeeRunInputError'
  }
}

const TERMINAL_STATUSES = new Set<EmployeeRunRecord['status']>([
  'completed', 'failed', 'cancelled', 'interrupted',
])

export class EmployeeRunService {
  private readonly sessionLocks = new Map<string, EmployeeSessionLock>()
  private readonly sessionLockListeners = new Set<(locks: EmployeeSessionLock[]) => void>()
  private readonly forceUnlockedRunIds = new Set<string>()
  private initialized = false
  private startTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: EmployeeRunServiceOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.options.store.initialize()
    this.initialized = true
  }

  async start(input: EmployeeRunStartRequest): Promise<EmployeeRunStartReceipt> {
    this.assertInitialized()
    const result = this.startTail.then(() => this.startOnce(input))
    this.startTail = result.then(() => undefined, () => undefined)
    return result
  }

  async get(runId: string): Promise<EmployeeRunRecord | undefined> {
    this.assertInitialized()
    return this.options.store.get(runId)
  }

  async list(): Promise<EmployeeRunRecord[]> {
    this.assertInitialized()
    return this.options.store.list()
  }

  watch(listener: (event: EmployeeRunEvent) => void): () => void {
    this.assertInitialized()
    return this.options.store.subscribe(listener)
  }

  listSessionLocks(): EmployeeSessionLock[] {
    return [...this.sessionLocks.values()].map((lock) => ({ ...lock }))
  }

  watchSessionLocks(listener: (locks: EmployeeSessionLock[]) => void): () => void {
    this.sessionLockListeners.add(listener)
    return () => this.sessionLockListeners.delete(listener)
  }

  async cancel(runId: string, reason = 'Employee run cancellation requested'): Promise<EmployeeRunRecord> {
    this.assertInitialized()
    await this.requireRun(runId)
    const now = new Date().toISOString()
    const transition = await this.options.store.transition(runId, (current) => {
      if (TERMINAL_STATUSES.has(current.status) || current.status === 'cancelling') return undefined
      if (current.status === 'queued' && current.dispatchStage === 'recorded') {
        return {
          status: 'cancelled',
          dispatchStage: 'cancelled-before-dispatch',
          cancelReason: reason,
          cancelRequestedAt: now,
          completedAt: now,
          updatedAt: now,
        }
      }
      return {
        status: 'cancelling',
        dispatchStage: 'cancel-requested',
        cancelReason: reason,
        cancelRequestedAt: now,
        updatedAt: now,
      }
    })
    if (transition.run.status === 'cancelled') {
      this.releaseSessionLock(transition.run.sessionId, runId)
      return transition.run
    }
    if (!transition.updated || transition.run.status !== 'cancelling') return transition.run
    const client = this.options.createClient()
    if (client.cancelSession !== undefined) {
      await client.cancelSession(transition.run.sessionId).catch(() => undefined)
    }
    return transition.run
  }

  async forceUnlockSession(sessionId: string): Promise<void> {
    this.assertInitialized()
    const normalizedSessionId = sessionId.trim()
    if (normalizedSessionId === '') throw new Error('Employee session is required')
    const lock = this.sessionLocks.get(normalizedSessionId)
    if (lock === undefined) return
    this.forceUnlockedRunIds.add(lock.runId)
    const run = await this.options.store.get(lock.runId)
    if (run && !TERMINAL_STATUSES.has(run.status)) {
      const now = new Date().toISOString()
      await this.options.store.transition(run.runId, (current) => {
        if (TERMINAL_STATUSES.has(current.status)) return undefined
        return {
          status: 'cancelling',
          dispatchStage: 'cancel-requested',
          cancelReason: 'Employee run was force-unlocked',
          cancelRequestedAt: now,
          updatedAt: now,
        }
      })
    }
    this.releaseSessionLock(normalizedSessionId, lock.runId)
    const client = this.options.createClient()
    if (client.cancelSession !== undefined) {
      await client.cancelSession(normalizedSessionId).catch(() => undefined)
    }
  }

  async waitForTerminal(runId: string): Promise<EmployeeRunRecord> {
    return new Promise<EmployeeRunRecord>((resolve, reject) => {
      let settled = false
      let unsubscribe = (): void => undefined
      const finish = (run: EmployeeRunRecord): void => {
        if (settled) return
        settled = true
        unsubscribe()
        resolve(run)
      }
      unsubscribe = this.watch((event) => {
        if (event.run.runId === runId && TERMINAL_STATUSES.has(event.run.status)) finish(event.run)
      })
      void this.requireRun(runId).then((run) => {
        if (TERMINAL_STATUSES.has(run.status)) finish(run)
      }, (error: unknown) => {
        if (settled) return
        settled = true
        unsubscribe()
        reject(error)
      })
    })
  }

  toLegacyResult(run: EmployeeRunRecord): EmployeeRunResult {
    const completedAt = run.completedAt ?? run.updatedAt
    if (run.status === 'completed') {
      return {
        runId: run.runId,
        employeeId: run.employeeId,
        status: 'completed',
        output: run.output,
        steps: [{ stepId: 'execute-task', name: '执行专业任务', status: 'completed', output: run.output }],
        startedAt: run.createdAt,
        completedAt,
      }
    }
    const error = run.error ?? run.cancelReason ?? `Employee run ended with status ${run.status}`
    return {
      runId: run.runId,
      employeeId: run.employeeId,
      status: 'failed',
      output: run.output,
      steps: [{ stepId: 'execute-task', name: '执行专业任务', status: 'failed', output: run.output, error }],
      startedAt: run.createdAt,
      completedAt,
      error,
    }
  }

  private async startOnce(input: EmployeeRunStartRequest): Promise<EmployeeRunStartReceipt> {
    const request = normalizeStartRequest(input)
    const requestDigest = digestRequest(request)
    const existing = await this.options.store.findByCommand(request.commandId)
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw new EmployeeRunStoreConflictError(
          'COMMAND_ID_CONFLICT',
          `Employee command ${request.commandId} was already used with different content`,
        )
      }
      return { run: existing.run, replayed: true }
    }

    const employee = this.options.resolveEmployee(request.employeeId)
    if (employee === undefined) throw new Error(`Employee "${request.employeeId}" was not found`)
    if (!employee.enabled) throw new Error(`Employee "${request.employeeId}" is disabled`)
    const employeeSnapshot = structuredClone(employee)
    const client = this.options.createClient()
    const session = await this.resolveSession(client, request.context)
    const runId = randomUUID()
    const now = new Date().toISOString()
    this.lockSession(session.sessionId, request.employeeId, runId, now)
    const record: EmployeeRunRecord = {
      runId,
      commandId: request.commandId,
      requestDigest,
      employeeId: request.employeeId,
      employeeVersion: employeeSnapshot.version,
      employeeSnapshot,
      task: request.task,
      ...(request.round === undefined ? {} : { round: request.round }),
      context: request.context,
      ...(request.task.taskId === undefined ? {} : { taskId: request.task.taskId }),
      ...(request.task.attemptId === undefined ? {} : { attemptId: request.task.attemptId }),
      ...(request.task.requirementVersion === undefined ? {} : { requirementVersion: request.task.requirementVersion }),
      ...(request.task.sourceRunId === undefined ? {} : { sourceRunId: request.task.sourceRunId }),
      ...(request.context.projectId === undefined ? {} : { projectId: request.context.projectId }),
      cwd: request.context.cwd,
      sessionId: session.sessionId,
      sessionEvidence: session.evidence,
      status: 'queued',
      dispatchStage: 'recorded',
      partialOutput: '',
      output: '',
      createdAt: now,
      updatedAt: now,
    }
    try {
      const receipt = await this.options.store.create({
        commandId: request.commandId,
        requestDigest,
        record,
      })
      if (!receipt.replayed) {
        this.emitSessionLocks()
        queueMicrotask(() => { void this.dispatch(receipt.run, client) })
      } else {
        this.discardSessionLock(session.sessionId, runId)
      }
      return receipt
    } catch (error) {
      this.discardSessionLock(session.sessionId, runId)
      throw error
    }
  }

  private async dispatch(initial: EmployeeRunRecord, client: EmployeeRunClient): Promise<void> {
    try {
      await this.requireRun(initial.runId)
      const now = new Date().toISOString()
      const claim = await this.options.store.transition(initial.runId, (current) => {
        if (current.status !== 'queued' || current.dispatchStage !== 'recorded') return undefined
        return {
          status: 'running',
          dispatchStage: 'prompt-in-flight',
          updatedAt: now,
        }
      })
      if (!claim.updated) {
        this.releaseSessionLock(initial.sessionId, initial.runId)
        return
      }
    } catch (error) {
      await this.recordDispatchFailure(initial.runId, error)
      this.releaseSessionLock(initial.sessionId, initial.runId)
      return
    }

    try {
      const task = describeTask(initial.task, initial.round)
      const prompt = this.options.buildPrompt
        ? this.options.buildPrompt(initial.employeeSnapshot, task, initial.projectId, initial.sessionId)
        : defaultPrompt(initial.employeeSnapshot, task, initial.projectId, initial.sessionId)
      const response = await client.sendPrompt(initial.sessionId, prompt)
      const now = new Date().toISOString()
      await this.options.store.transition(initial.runId, (current) => {
        if (TERMINAL_STATUSES.has(current.status)) return undefined
        if (this.forceUnlockedRunIds.has(initial.runId)) {
          return {
            status: 'failed',
            dispatchStage: 'failed',
            error: 'Employee run was force-unlocked',
            updatedAt: now,
            completedAt: now,
          }
        }
        return {
          status: 'completed',
          dispatchStage: 'completed',
          output: response.text.trim(),
          updatedAt: now,
          completedAt: now,
        }
      })
    } catch (error) {
      const message = this.forceUnlockedRunIds.has(initial.runId)
        ? 'Employee run was force-unlocked'
        : messageOf(error)
      await this.recordDispatchFailure(initial.runId, new Error(message))
    } finally {
      this.releaseSessionLock(initial.sessionId, initial.runId)
      this.forceUnlockedRunIds.delete(initial.runId)
    }
  }

  private async recordDispatchFailure(runId: string, error: unknown): Promise<void> {
    const now = new Date().toISOString()
    await this.options.store.transition(runId, (current) => TERMINAL_STATUSES.has(current.status)
      ? undefined
      : {
          status: 'failed',
          dispatchStage: 'failed',
          error: messageOf(error),
          updatedAt: now,
          completedAt: now,
        }).catch(() => undefined)
  }

  private async resolveSession(client: EmployeeRunClient, context: EmployeeRunContext): Promise<{
    sessionId: string
    evidence: EmployeeRunRecord['sessionEvidence']
  }> {
    if (context.sessionId === undefined) {
      const created = await client.createSession({
        cwd: context.cwd,
        ...(context.projectId === undefined ? {} : { workspaceId: context.projectId }),
      })
      return { sessionId: created.sessionId, evidence: 'created' }
    }
    if (context.projectId === undefined) {
      throw new Error('Employee project is required for an existing session')
    }
    if (client.listWorkspaces !== undefined) {
      const workspaces = await client.listWorkspaces()
      const workspace = workspaces.find((candidate) => candidate.workspaceId === context.projectId)
      if (workspace === undefined || !workspace.sessionIds.includes(context.sessionId)) {
        throw new Error(`Employee session "${context.sessionId}" does not belong to project "${context.projectId}"`)
      }
      return { sessionId: context.sessionId, evidence: 'runtime-workspace' }
    }
    if (context.sessionVerification !== 'trusted-main') {
      throw new Error('Existing employee session requires trusted Main verification')
    }
    return { sessionId: context.sessionId, evidence: 'trusted-main' }
  }

  private lockSession(sessionId: string, employeeId: string, runId: string, startedAt: string): void {
    const existing = this.sessionLocks.get(sessionId)
    if (existing !== undefined) {
      throw new Error(`Employee session "${sessionId}" is locked by run "${existing.runId}"`)
    }
    this.sessionLocks.set(sessionId, { sessionId, employeeId, runId, startedAt })
  }

  private discardSessionLock(sessionId: string, runId: string): void {
    const current = this.sessionLocks.get(sessionId)
    if (current?.runId === runId) this.sessionLocks.delete(sessionId)
  }

  private releaseSessionLock(sessionId: string, runId: string): void {
    const current = this.sessionLocks.get(sessionId)
    if (current?.runId !== runId) return
    this.sessionLocks.delete(sessionId)
    this.emitSessionLocks()
  }

  private emitSessionLocks(): void {
    const locks = this.listSessionLocks()
    for (const listener of this.sessionLockListeners) {
      try { listener(locks.map((lock) => ({ ...lock }))) } catch { /* An observer cannot affect execution. */ }
    }
  }

  private async requireRun(runId: string): Promise<EmployeeRunRecord> {
    const run = await this.options.store.get(runId)
    if (run === undefined) throw new EmployeeRunStoreConflictError('RUN_NOT_FOUND', `Employee run ${runId} was not found`)
    return run
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('EmployeeRunService must be initialized before use')
  }
}

function normalizeStartRequest(input: EmployeeRunStartRequest): EmployeeRunStartRequest {
  assertSafeJson(input, '$')
  const commandId = requiredString(input.commandId, '$.commandId')
  const employeeId = requiredString(input.employeeId, '$.employeeId')
  const task = normalizeTask(input.task)
  const round = input.round === undefined ? undefined : normalizeRound(input.round)
  if (!task.description && !task.taskId && !round?.description) {
    throw new EmployeeRunInputError('$.task', 'Employee run requires a task description, task reference, or round description')
  }
  const context = normalizeContext(input.context)
  return { commandId, employeeId, task, ...(round === undefined ? {} : { round }), context }
}

function normalizeTask(input: EmployeeRunTaskInput): EmployeeRunTaskInput {
  assertExactKeys(input, ['description', 'taskId', 'attemptId', 'requirementVersion', 'sourceRunId'], '$.task')
  return {
    ...optionalStringField(input.description, 'description', '$.task.description'),
    ...optionalStringField(input.taskId, 'taskId', '$.task.taskId'),
    ...optionalStringField(input.attemptId, 'attemptId', '$.task.attemptId'),
    ...(input.requirementVersion === undefined ? {} : {
      requirementVersion: positiveInteger(input.requirementVersion, '$.task.requirementVersion'),
    }),
    ...optionalStringField(input.sourceRunId, 'sourceRunId', '$.task.sourceRunId'),
  }
}

function normalizeRound(input: EmployeeRunRoundInput): EmployeeRunRoundInput {
  assertExactKeys(input, ['description', 'roundId'], '$.round')
  return {
    ...optionalStringField(input.description, 'description', '$.round.description'),
    ...optionalStringField(input.roundId, 'roundId', '$.round.roundId'),
  }
}

function normalizeContext(input: EmployeeRunContext): EmployeeRunContext {
  assertExactKeys(input, ['cwd', 'projectId', 'sessionId', 'sessionVerification'], '$.context')
  const cwd = requiredString(input.cwd, '$.context.cwd')
  const project = optionalStringField(input.projectId, 'projectId', '$.context.projectId')
  const session = optionalStringField(input.sessionId, 'sessionId', '$.context.sessionId')
  if (input.sessionVerification !== undefined && input.sessionVerification !== 'trusted-main') {
    throw new EmployeeRunInputError('$.context.sessionVerification', 'Unsupported session verification evidence')
  }
  return {
    cwd,
    ...project,
    ...session,
    ...(input.sessionVerification === undefined ? {} : { sessionVerification: input.sessionVerification }),
  }
}

function assertSafeJson(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new EmployeeRunInputError(path, `${path} must be a finite JSON number`)
    return
  }
  if (typeof value !== 'object') throw new EmployeeRunInputError(path, `${path} is not JSON serializable`)
  if (utilTypes.isProxy(value)) throw new EmployeeRunInputError(path, `${path} cannot be a Proxy`)
  if (seen.has(value)) throw new EmployeeRunInputError(path, `${path} cannot contain a cycle`)
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new EmployeeRunInputError(path, `${path} must contain only plain JSON values`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new EmployeeRunInputError(path, `${path} cannot contain symbol keys`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw new EmployeeRunInputError(`${path}.${key}`, 'Accessors are not accepted')
    assertSafeJson(descriptor.value, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

function assertExactKeys(value: object, allowed: string[], path: string): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EmployeeRunInputError(path, `${path} must be a plain object`)
  }
  const allowedSet = new Set(allowed)
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unsupported) throw new EmployeeRunInputError(`${path}.${unsupported}`, `Unsupported field ${unsupported}`)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new EmployeeRunInputError(path, `${path} is required`)
  return value.trim()
}

function optionalStringField<K extends string>(value: unknown, key: K, path: string): Partial<Record<K, string>> {
  if (value === undefined) return {}
  return { [key]: requiredString(value, path) } as Record<K, string>
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new EmployeeRunInputError(path, `${path} must be a positive integer`)
  }
  return value
}

function digestRequest(request: EmployeeRunStartRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function describeTask(task: EmployeeRunTaskInput, round?: EmployeeRunRoundInput): string {
  return [
    task.description,
    task.taskId ? `任务引用：${task.taskId}` : undefined,
    task.attemptId ? `执行轮次：${task.attemptId}` : undefined,
    task.requirementVersion ? `要求版本：${task.requirementVersion}` : undefined,
    task.sourceRunId ? `来源运行：${task.sourceRunId}` : undefined,
    round?.description,
    round?.roundId ? `轮次引用：${round.roundId}` : undefined,
  ].filter((value): value is string => value !== undefined).join('\n')
}

function defaultPrompt(
  employee: EmployeeDefinition,
  task: string,
  projectId?: string,
  sessionId?: string,
): string {
  return [
    employee.systemPrompt,
    `业务边界：${employee.businessBoundary}`,
    `任务：${task}`,
    projectId ? `项目：${projectId}` : '',
    sessionId ? `会话：${sessionId}` : '',
  ].filter(Boolean).join('\n\n')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
