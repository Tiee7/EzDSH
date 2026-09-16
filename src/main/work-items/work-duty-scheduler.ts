import { createHash } from 'node:crypto'

import type { WorkTaskExecuteRequest, WorkTaskSnapshot } from '../../shared/work-items.js'
import { occurrenceId, type WorkDuty, type WorkDutyOccurrenceClaimReceipt } from '../../shared/work-duty.js'
import type { NotificationSignal } from '../../shared/notifications.js'
import { WorkDutyStore } from './work-duty-store.js'

export interface WorkDutySchedulerOptions {
  store: WorkDutyStore
  getTask(taskId: string): Promise<WorkTaskSnapshot | undefined>
  execute(request: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot>
  /** Returns false while the Runtime or durable execution worker is offline. */
  canExecute(): boolean
  pollIntervalMs?: number
  now?: () => string
  onClaim?: (receipt: WorkDutyOccurrenceClaimReceipt) => void
  notify?: (signal: NotificationSignal) => void
  onError?: (error: unknown, duty?: WorkDuty) => void
}

/**
 * Bridges durable WorkDuty occurrences to the existing Work Item execution
 * service. It never executes Employee or Workflow code itself: the Store
 * claims one occurrence, then this worker submits a normal Work Item request.
 */
export class WorkDutyScheduler {
  private readonly pollIntervalMs: number
  private readonly now: () => string
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private tickPromise: Promise<void> | undefined

  constructor(private readonly options: WorkDutySchedulerOptions) {
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 15_000)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.tickPromise
  }

  /** Executes one polling pass; useful for startup and deterministic callers. */
  async runOnce(): Promise<void> {
    if (this.tickPromise !== undefined) return this.tickPromise
    const pending = this.poll()
    this.tickPromise = pending
    try {
      await pending
    } finally {
      if (this.tickPromise === pending) this.tickPromise = undefined
    }
  }

  private async tick(): Promise<void> {
    await this.runOnce()
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, this.pollIntervalMs)
  }

  private async poll(): Promise<void> {
    if (!this.options.canExecute()) return
    let duties: WorkDuty[]
    try {
      duties = await this.options.store.list()
    } catch (error) {
      this.options.onError?.(error)
      return
    }
    for (const duty of duties) {
      if (!this.running) return
      if (duty.paused || Date.parse(duty.nextOccurrenceAt) > Date.parse(this.now())) continue
      await this.claimAndDispatch(duty)
    }
  }

  private async claimAndDispatch(duty: WorkDuty): Promise<void> {
    let task: WorkTaskSnapshot | undefined
    try {
      task = await this.options.getTask(duty.taskId)
    } catch (error) {
      this.options.onError?.(error, duty)
      return
    }
    if (task === undefined) {
      await this.pauseTerminalDuty(duty, 'work-item-missing')
      return
    }
    if (task.task.archivedAt !== undefined || task.task.status === 'cancelled') {
      await this.pauseTerminalDuty(duty, task.task.status === 'cancelled' ? 'work-item-cancelled' : 'work-item-archived')
      return
    }
    const occurrence = occurrenceId(duty.id, duty.nextOccurrenceAt)
    const claimRequestId = stableRequestId('claim', occurrence)
    let claim: WorkDutyOccurrenceClaimReceipt | undefined
    try {
      claim = await this.options.store.claimDueOccurrence({
        requestId: claimRequestId,
        dutyId: duty.id,
        occurrenceAt: duty.nextOccurrenceAt,
        now: this.now(),
      })
    } catch (error) {
      this.options.onError?.(error, duty)
      return
    }
    if (claim === undefined) return
    this.options.onClaim?.(claim)
    if (!this.options.canExecute()) return

    try {
      task = await this.options.getTask(duty.taskId)
      if (task === undefined) throw new Error(`Work item task ${duty.taskId} was not found`)
      if (task.task.archivedAt !== undefined || task.task.status === 'cancelled') {
        await this.pauseTerminalDuty(duty, task.task.status === 'cancelled' ? 'work-item-cancelled' : 'work-item-archived')
        return
      }
      const knownCommands = new Set(task.runs.map((run) => run.commandId))
      const submitted = await this.options.execute({
        requestId: stableRequestId('execute', occurrence),
        taskId: duty.taskId,
        expectedRevision: task.task.revision,
        executor: duty.executor,
        mode: 'initial',
        input: duty.input,
      })
      const linkedRun = submitted.runs.find((run) => run.runId !== '' && !knownCommands.has(run.commandId))
      try {
        await this.options.store.recordExecution({
          requestId: stableRequestId('result', occurrence),
          dutyId: duty.id,
          occurrenceId: claim.occurrenceId,
          taskId: duty.taskId,
          status: 'submitted',
          ...(linkedRun?.runId === undefined ? {} : { runId: linkedRun.runId }),
          ...(linkedRun?.commandId === undefined ? {} : { commandId: linkedRun.commandId }),
        })
      } catch (resultError) {
        this.options.onError?.(resultError, duty)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await this.options.store.recordExecution({
          requestId: stableRequestId('result', occurrence),
          dutyId: duty.id,
          occurrenceId: claim.occurrenceId,
          taskId: duty.taskId,
          status: 'failed',
          error: detail.slice(0, 4_000),
        })
      } catch (resultError) {
        this.options.onError?.(resultError, duty)
      }
      this.options.notify?.({
        event: 'error',
        sessionId: `work-duty:${duty.id}`,
        dedupeKey: stableRequestId('notification', occurrence),
        detail,
        workItemId: duty.taskId,
        dutyId: duty.id,
        occurrenceId: claim.occurrenceId,
      })
      this.options.onError?.(error, duty)
    }
  }

  private async pauseTerminalDuty(duty: WorkDuty, reason: string): Promise<void> {
    if (duty.paused) return
    try {
      await this.options.store.pause({
        requestId: stableRequestId('auto-pause', `${duty.id}:${reason}:${duty.revision}`),
        dutyId: duty.id,
        expectedRevision: duty.revision,
      })
      this.options.notify?.({
        event: 'error',
        sessionId: `work-duty:${duty.id}`,
        dedupeKey: stableRequestId('notification', `${duty.id}:${reason}:${duty.revision}`),
        detail: `周期职责已暂停：${reason}`,
        workItemId: duty.taskId,
        dutyId: duty.id,
      })
    } catch (error) {
      this.options.onError?.(error, duty)
    }
  }
}

function stableRequestId(kind: 'claim' | 'execute' | 'result' | 'notification' | 'auto-pause', occurrence: string): string {
  const digest = createHash('sha256').update(occurrence).digest('hex')
  return `work-duty-${kind}-${digest}`
}
