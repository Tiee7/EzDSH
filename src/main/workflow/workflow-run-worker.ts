import { randomUUID } from 'node:crypto'
import type { WorkflowRunLease } from '../../shared/workflow.js'
import { WorkflowRunStore } from './workflow-run-store.js'

export interface WorkflowRunWorkerOptions {
  store: WorkflowRunStore
  ownerId?: string
  leaseMs?: number
  pollIntervalMs?: number
  /** The third argument is aborted when the persisted lease can no longer be renewed. */
  executeClaimedRun: (runId: string, lease: WorkflowRunLease, leaseSignal?: AbortSignal) => Promise<void>
  onExecutionError?: (runId: string, error: unknown) => Promise<void> | void
}

/**
 * A single durable local Worker. Queue ownership is persisted by the store;
 * this class only controls polling, lease heartbeats, and graceful shutdown.
 */
export class WorkflowRunWorker {
  private readonly ownerId: string
  private readonly leaseMs: number
  private readonly pollIntervalMs: number
  private readonly executeClaimedRun: WorkflowRunWorkerOptions['executeClaimedRun']
  private readonly onExecutionError: NonNullable<WorkflowRunWorkerOptions['onExecutionError']> | undefined
  private started = false
  private stopping = false
  private drainPromise: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: WorkflowRunWorkerOptions) {
    this.ownerId = options.ownerId ?? `workflow-worker-${randomUUID()}`
    this.leaseMs = Math.max(2_000, options.leaseMs ?? 60_000)
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 1_000)
    this.executeClaimedRun = options.executeClaimedRun
    this.onExecutionError = options.onExecutionError
  }

  async start(): Promise<void> {
    if (this.started && !this.stopping) return
    this.started = true
    this.stopping = false
    this.wake()
  }

  wake(): void {
    if (!this.started || this.stopping || this.drainPromise !== undefined) return
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.started = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.drainPromise
    this.drainPromise = undefined
  }

  private async drain(): Promise<void> {
    while (this.started && !this.stopping) {
      const claimed = await this.options.store.claimNextDue(this.ownerId, this.leaseMs)
      if (claimed === undefined) {
        this.scheduleWake()
        return
      }
      const lease = claimed.queue?.lease
      if (lease === undefined) continue
      const leaseController = new AbortController()
      const heartbeatInterval = Math.max(1_000, Math.floor(this.leaseMs / 2))
      const heartbeat = setInterval(() => {
        void this.options.store.renewLease(claimed.id, this.ownerId, this.leaseMs).then((renewed) => {
          // A missing result means another owner has taken the lease (or the
          // store could not persist the renewal). Abort before the next
          // external dispatch; the service will leave the record for durable
          // recovery instead of writing a stale terminal state.
          if (renewed === undefined && !leaseController.signal.aborted) leaseController.abort()
        }).catch(() => {
          if (!leaseController.signal.aborted) leaseController.abort()
        })
      }, heartbeatInterval)
      try {
        await this.executeClaimedRun(claimed.id, lease, leaseController.signal)
      } catch (error) {
        try {
          await this.onExecutionError?.(claimed.id, error)
        } catch {
          // An observer/error hook must not stop the Worker from draining the
          // remaining durable queue.
        }
      } finally {
        clearInterval(heartbeat)
        // If the heartbeat was lost, hand the still-running record back to
        // durable recovery before releasing ownership. A plain lease release
        // would otherwise leave a running record with no lease forever.
        await this.options.store.releaseLease(claimed.id, this.ownerId, leaseController.signal.aborted).catch(() => undefined)
      }
    }
  }

  private scheduleWake(): void {
    if (!this.started || this.stopping || this.timer !== undefined) return
    const nextDueAt = this.options.store.nextDueAt()
    const dueDelay = nextDueAt === undefined ? this.pollIntervalMs : Math.max(25, Date.parse(nextDueAt) - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.wake()
    }, dueDelay)
    this.timer.unref?.()
  }
}
