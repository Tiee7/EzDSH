import { createHash, randomUUID } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import type { EmployeeDefinition, EmployeeRunResult, EmployeeSessionLock } from '../../shared/employees.js'
import type {
  EmployeeRunContext,
  EmployeeRunEvent,
  EmployeeRunObservationResult,
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

type ObservationCapableEmployeeRunClient = EmployeeRunClient & Required<Pick<EmployeeRunClient,
  'getObservationCursor' | 'submitPrompt' | 'observeTurn'
>>

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
const FORCE_UNLOCK_REASON = 'Employee run was force-unlocked'

export class EmployeeRunService {
  private readonly sessionLocks = new Map<string, EmployeeSessionLock>()
  private readonly sessionLockListeners = new Set<(locks: EmployeeSessionLock[]) => void>()
  private initialized = false
  private startTail: Promise<void> = Promise.resolve()
  private readonly observingRunIds = new Set<string>()
  private readonly runOperationTails = new Map<string, Promise<void>>()

  constructor(private readonly options: EmployeeRunServiceOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.options.store.initialize()
    this.initialized = true
    await this.restoreActiveSessionLocks()
    queueMicrotask(() => { void this.reconcileActiveRuns() })
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

  async findByCommand(commandId: string): Promise<EmployeeRunRecord | undefined> {
    this.assertInitialized()
    return (await this.options.store.findByCommand(commandId))?.run
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
    return this.serializeRunOperation(runId, () => this.cancelOnce(runId, reason))
  }

  private async cancelOnce(runId: string, reason: string): Promise<EmployeeRunRecord> {
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
    if (client.cancelSession === undefined) {
      return (await this.options.store.transition(runId, (current) => {
        if (current.status !== 'cancelling') return undefined
        return {
          cancelRequestState: 'unsupported',
          cancelRequestError: 'Runtime does not support session cancellation',
          updatedAt: new Date().toISOString(),
        }
      })).run
    }
    try {
      const response = client.requestCancelSession === undefined
        ? await client.cancelSession(transition.run.sessionId)
        : await client.requestCancelSession(transition.run.sessionId)
      if (response !== undefined && !response.accepted) {
        return (await this.options.store.transition(runId, (current) => {
          if (current.status !== 'cancelling') return undefined
          return {
            cancelRequestState: 'failed',
            cancelRequestError: 'Runtime did not accept session cancellation',
            updatedAt: new Date().toISOString(),
          }
        })).run
      }
      return (await this.options.store.transition(runId, (current) => {
        if (current.status !== 'cancelling') return undefined
        return {
          cancelRequestState: 'accepted',
          cancelRequestError: undefined,
          updatedAt: new Date().toISOString(),
        }
      })).run
    } catch (error) {
      return (await this.options.store.transition(runId, (current) => {
        if (current.status !== 'cancelling') return undefined
        return {
          cancelRequestState: 'failed',
          cancelRequestError: messageOf(error),
          updatedAt: new Date().toISOString(),
        }
      })).run
    }
  }

  /** Reattach observers to persisted runs without ever submitting their prompt again. */
  async reconcileActiveRuns(): Promise<EmployeeRunRecord[]> {
    this.assertInitialized()
    const runs = (await this.options.store.list()).filter((run) => run.status === 'running' || run.status === 'cancelling')
    for (const run of runs) this.beginObservation(run, this.options.createClient())
    return runs
  }

  async forceUnlockSession(sessionId: string): Promise<void> {
    this.assertInitialized()
    const normalizedSessionId = sessionId.trim()
    if (normalizedSessionId === '') throw new Error('Employee session is required')
    const lock = this.sessionLocks.get(normalizedSessionId)
    if (lock === undefined) return
    await this.serializeRunOperation(lock.runId, () => this.forceUnlockOnce(normalizedSessionId, lock))
  }

  private async forceUnlockOnce(sessionId: string, lock: EmployeeSessionLock): Promise<void> {
    const now = new Date().toISOString()
    const transition = await this.options.store.transition(lock.runId, (current) => {
      if (current.status === 'interrupted' && current.dispatchStage === 'outcome-unknown') {
        if (current.cancelReason === FORCE_UNLOCK_REASON) return undefined
        return {
          cancelReason: FORCE_UNLOCK_REASON,
          cancelRequestedAt: now,
          updatedAt: now,
        }
      }
      if (TERMINAL_STATUSES.has(current.status)) return undefined
      if (current.status === 'queued' && current.dispatchStage === 'recorded') {
        return {
          status: 'cancelled',
          dispatchStage: 'cancelled-before-dispatch',
          cancelReason: FORCE_UNLOCK_REASON,
          cancelRequestedAt: now,
          completedAt: now,
          updatedAt: now,
        }
      }
      if (current.status === 'cancelling' && current.cancelReason === FORCE_UNLOCK_REASON) return undefined
      return {
        status: 'cancelling',
        dispatchStage: 'cancel-requested',
        cancelReason: FORCE_UNLOCK_REASON,
        cancelRequestedAt: now,
        updatedAt: now,
      }
    })
    if (!transition.updated) return
    this.releaseSessionLock(sessionId, lock.runId)
    const client = this.options.createClient()
    if (client.cancelSession !== undefined) {
      await client.cancelSession(sessionId).catch(() => undefined)
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
      promptRequestId: randomUUID(),
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
    if (supportsObservation(client)) {
      await this.dispatchObservable(initial, client)
      return
    }
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
        if (current.status === 'cancelling' && current.cancelReason === FORCE_UNLOCK_REASON) {
          return {
            status: 'failed',
            dispatchStage: 'failed',
            error: FORCE_UNLOCK_REASON,
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
      await this.recordDispatchFailure(initial.runId, error)
    } finally {
      this.releaseSessionLock(initial.sessionId, initial.runId)
    }
  }

  private async dispatchObservable(initial: EmployeeRunRecord, client: ObservationCapableEmployeeRunClient): Promise<void> {
    let cursor: number
    try {
      cursor = await client.getObservationCursor(initial.sessionId)
      const claim = await this.options.store.transition(initial.runId, (current) => {
        if (current.status !== 'queued' || current.dispatchStage !== 'recorded') return undefined
        return {
          status: 'running',
          dispatchStage: 'prompt-in-flight',
          observationCursor: cursor,
          observerState: 'pending',
          updatedAt: new Date().toISOString(),
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

    const task = describeTask(initial.task, initial.round)
    const prompt = this.options.buildPrompt
      ? this.options.buildPrompt(initial.employeeSnapshot, task, initial.projectId, initial.sessionId)
      : defaultPrompt(initial.employeeSnapshot, task, initial.projectId, initial.sessionId)
    const submitted = await this.serializeRunOperation(initial.runId, async () => {
      const beforeSubmit = await this.requireRun(initial.runId)
      if (beforeSubmit.status !== 'running' || beforeSubmit.dispatchStage !== 'prompt-in-flight') return false
      try {
        const submission = await client.submitPrompt(initial.sessionId, prompt, initial.promptRequestId)
        if (!submission.accepted) {
          await this.recordDispatchFailure(initial.runId, new Error('DSH Runtime rejected the employee prompt'))
          this.releaseSessionLock(initial.sessionId, initial.runId)
          return false
        }
        await this.options.store.transition(initial.runId, (current) => {
          if (TERMINAL_STATUSES.has(current.status)) return undefined
          return {
            promptAcceptedAt: new Date().toISOString(),
            observerState: 'observing',
            updatedAt: new Date().toISOString(),
          }
        })
        return true
      } catch (error) {
        await this.recordObserverStop(initial.runId, 'disconnected', messageOf(error), cursor)
        return false
      }
    })
    if (!submitted) return

    const current = await this.requireRun(initial.runId)
    this.beginObservation(current, client)
  }

  private beginObservation(run: EmployeeRunRecord, client: EmployeeRunClient): void {
    if (this.observingRunIds.has(run.runId)) return
    this.observingRunIds.add(run.runId)
    void this.observeExisting(run, client).finally(() => {
      this.observingRunIds.delete(run.runId)
    })
  }

  private async observeExisting(initial: EmployeeRunRecord, client: EmployeeRunClient): Promise<void> {
    if (!supportsObservation(client) || initial.observationCursor === undefined) {
      await this.recordObserverStop(
        initial.runId,
        'unsupported',
        initial.observationCursor === undefined
          ? 'Persisted run has no pre-submission history cursor; outcome cannot be reconciled safely'
          : 'Runtime client cannot observe an existing turn',
        initial.observationCursor,
      )
      return
    }
    try {
      await this.options.store.transition(initial.runId, (current) => {
        if (TERMINAL_STATUSES.has(current.status)) return undefined
        return { observerState: 'observing', observationError: undefined, updatedAt: new Date().toISOString() }
      })
      const result = await client.observeTurn(initial.sessionId, {
        afterSeq: initial.observationCursor,
        requestId: initial.promptRequestId,
        onEvent: async ({ cursor, delta }) => {
          await this.options.store.transition(initial.runId, (current) => {
            if (TERMINAL_STATUSES.has(current.status)) return undefined
            return {
              observationCursor: Math.max(current.observationCursor ?? -1, cursor),
              ...(delta === undefined ? {} : { partialOutput: `${current.partialOutput}${delta}` }),
              updatedAt: new Date().toISOString(),
            }
          })
        },
      })
      await this.applyObservationResult(initial.runId, result)
    } catch (error) {
      const current = await this.requireRun(initial.runId)
      await this.recordObserverStop(initial.runId, 'disconnected', messageOf(error), current.observationCursor)
    }
  }

  private async applyObservationResult(runId: string, result: EmployeeRunObservationResult): Promise<void> {
    if (result.outcome === 'timeout' || result.outcome === 'disconnected') {
      await this.recordObserverStop(runId, result.outcome, result.error ?? `Employee run observer ${result.outcome}`, result.cursor, result.output)
      return
    }
    const now = new Date().toISOString()
    const transition = await this.options.store.transition(runId, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) return undefined
      if (current.status === 'cancelling' && current.cancelReason === FORCE_UNLOCK_REASON) {
        return {
          status: 'failed',
          dispatchStage: 'failed',
          observationCursor: Math.max(current.observationCursor ?? -1, result.cursor),
          observerState: 'completed',
          observationError: undefined,
          terminalEvidence: result.terminalEvidence,
          output: current.output,
          error: FORCE_UNLOCK_REASON,
          updatedAt: now,
          completedAt: now,
        }
      }
      const base = {
        observationCursor: Math.max(current.observationCursor ?? -1, result.cursor),
        observerState: 'completed' as const,
        observationError: undefined,
        terminalEvidence: result.terminalEvidence,
        output: result.output.trim(),
        updatedAt: now,
        completedAt: now,
      }
      if (result.outcome === 'completed') return { ...base, status: 'completed' as const, dispatchStage: 'completed' as const }
      if (result.outcome === 'cancelled') return { ...base, status: 'cancelled' as const, dispatchStage: 'cancelled' as const }
      return {
        ...base,
        status: 'failed' as const,
        dispatchStage: 'failed' as const,
        error: result.error ?? `Employee run ended with ${result.terminalEvidence?.reasonKind ?? 'unknown'} reason`,
      }
    })
    if (transition.updated) this.releaseSessionLock(transition.run.sessionId, transition.run.runId)
  }

  private async recordObserverStop(
    runId: string,
    state: 'timeout' | 'disconnected' | 'unsupported',
    error: string,
    cursor?: number,
    output = '',
  ): Promise<void> {
    await this.options.store.transition(runId, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) return undefined
      const now = new Date().toISOString()
      return {
        ...(current.status === 'cancelling' ? {} : { status: 'interrupted' as const }),
        dispatchStage: 'outcome-unknown',
        observerState: state,
        observationError: error,
        ...(cursor === undefined ? {} : { observationCursor: Math.max(current.observationCursor ?? -1, cursor) }),
        ...(output === '' ? {} : { partialOutput: output }),
        updatedAt: now,
      }
    }).catch(() => undefined)
  }

  private async restoreActiveSessionLocks(): Promise<void> {
    const active = (await this.options.store.list())
      .filter((run) => (
        run.status === 'running'
        || run.status === 'cancelling'
        || (run.status === 'interrupted' && run.dispatchStage === 'outcome-unknown')
      ) && run.cancelReason !== FORCE_UNLOCK_REASON)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    for (const run of active) {
      if (this.sessionLocks.has(run.sessionId)) continue
      this.sessionLocks.set(run.sessionId, {
        sessionId: run.sessionId,
        employeeId: run.employeeId,
        runId: run.runId,
        startedAt: run.createdAt,
      })
    }
    if (active.length > 0) this.emitSessionLocks()
  }

  private async recordDispatchFailure(runId: string, error: unknown): Promise<void> {
    const now = new Date().toISOString()
    await this.options.store.transition(runId, (current) => {
      if (TERMINAL_STATUSES.has(current.status)) return undefined
      return {
          status: 'failed',
          dispatchStage: 'failed',
          error: current.status === 'cancelling' && current.cancelReason === FORCE_UNLOCK_REASON
            ? FORCE_UNLOCK_REASON
            : messageOf(error),
          updatedAt: now,
          completedAt: now,
        }
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

  private async serializeRunOperation<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runOperationTails.get(runId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.runOperationTails.set(runId, tail)
    void tail.finally(() => {
      if (this.runOperationTails.get(runId) === tail) this.runOperationTails.delete(runId)
    })
    return result
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
  assertExactKeys(input, ['description', 'taskId', 'attemptId', 'requirementVersion', 'sourceRunId', 'methodId', 'methodVersion', 'methodWorkflowId', 'methodWorkflowRevision'], '$.task')
  return {
    ...optionalStringField(input.description, 'description', '$.task.description'),
    ...optionalStringField(input.taskId, 'taskId', '$.task.taskId'),
    ...optionalStringField(input.attemptId, 'attemptId', '$.task.attemptId'),
    ...(input.requirementVersion === undefined ? {} : {
      requirementVersion: positiveInteger(input.requirementVersion, '$.task.requirementVersion'),
    }),
    ...optionalStringField(input.sourceRunId, 'sourceRunId', '$.task.sourceRunId'),
    ...optionalStringField(input.methodId, 'methodId', '$.task.methodId'),
    ...(input.methodVersion === undefined ? {} : {
      methodVersion: positiveInteger(input.methodVersion, '$.task.methodVersion'),
    }),
    ...optionalStringField(input.methodWorkflowId, 'methodWorkflowId', '$.task.methodWorkflowId'),
    ...(input.methodWorkflowRevision === undefined ? {} : {
      methodWorkflowRevision: positiveInteger(input.methodWorkflowRevision, '$.task.methodWorkflowRevision'),
    }),
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
    task.methodId ? `员工方法：${task.methodId} v${task.methodVersion ?? '?'}` : undefined,
    task.methodWorkflowId ? `方法工作流：${task.methodWorkflowId} v${task.methodWorkflowRevision ?? '?'}` : undefined,
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

function supportsObservation(client: EmployeeRunClient): client is ObservationCapableEmployeeRunClient {
  return client.getObservationCursor !== undefined
    && client.submitPrompt !== undefined
    && client.observeTurn !== undefined
}
