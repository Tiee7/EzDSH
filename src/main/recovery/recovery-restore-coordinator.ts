import type { RuntimeMode } from '../runtime/runtime-types.js'
import type { RecoveryDryRun, RecoveryRestoreResult } from './recovery-manager.js'

export interface RecoveryStopProgress {
  workItemScopeClosed: true
}

export type RecoveryStopProgressReporter = (progress: RecoveryStopProgress) => void

export interface RecoveryRestoreCoordinatorOptions {
  preflight(selector: string): Promise<Pick<RecoveryDryRun, 'snapshotName'>>
  getMode(): RuntimeMode
  stopComponents(reportProgress?: RecoveryStopProgressReporter): Promise<void>
  restore(selector: string): Promise<RecoveryRestoreResult>
  prepareMode(mode: RuntimeMode): Promise<void>
  resumeComponents?(): Promise<void>
}

export class RecoveryRestoreCoordinator {
  private pending: Promise<RecoveryRestoreResult> | undefined

  constructor(private readonly options: RecoveryRestoreCoordinatorOptions) {}

  restore(selector: string): Promise<RecoveryRestoreResult> {
    if (this.pending !== undefined) return Promise.reject(new Error('Backup restoration is already in progress'))

    let resolve!: (result: RecoveryRestoreResult) => void
    let reject!: (error: unknown) => void
    const operation = new Promise<RecoveryRestoreResult>((resolveOperation, rejectOperation) => {
      resolve = resolveOperation
      reject = rejectOperation
    })
    const pending = operation.finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    // Recovery callbacks can synchronously publish state and trigger startup.
    // Register the barrier before invoking them so those requests must also wait.
    this.pending = pending
    void this.restoreInternal(selector).then(resolve, reject)
    return pending
  }

  async waitUntilReady(): Promise<void> {
    await this.pending
  }

  private async restoreInternal(selector: string): Promise<RecoveryRestoreResult> {
    const preflight = await this.options.preflight(selector)
    const mode = this.options.getMode()
    let result: RecoveryRestoreResult
    let stopped = false
    let workItemScopeClosed = false
    try {
      await this.options.stopComponents((progress) => {
        if (progress.workItemScopeClosed) workItemScopeClosed = true
      })
      stopped = true
      result = await this.options.restore(preflight.snapshotName)
      await this.options.prepareMode(mode)
    } catch (error) {
      if (stopped || workItemScopeClosed) await this.resumeAfterFailure(error)
      throw error
    }
    await this.options.resumeComponents?.()
    return result
  }

  private async resumeAfterFailure(primaryError: unknown): Promise<void> {
    try {
      await this.options.resumeComponents?.()
    } catch (resumeError) {
      if ((typeof primaryError === 'object' && primaryError !== null) || typeof primaryError === 'function') {
        try { Object.assign(primaryError, { resumeError }) } catch { /* Preserve the primary restore failure. */ }
      }
    }
  }
}
