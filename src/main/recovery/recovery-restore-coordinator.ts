import type { RuntimeMode } from '../runtime/runtime-types.js'
import type { RecoveryRestoreResult } from './recovery-manager.js'

export interface RecoveryRestoreCoordinatorOptions {
  getMode(): RuntimeMode
  stopComponents(): Promise<void>
  restore(selector: string): Promise<RecoveryRestoreResult>
  prepareMode(mode: RuntimeMode): Promise<void>
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
    // Stop/restore callbacks can synchronously publish state and trigger startup.
    // Register the barrier before invoking them so those requests must also wait.
    this.pending = pending
    void this.restoreInternal(selector).then(resolve, reject)
    return pending
  }

  async waitUntilReady(): Promise<void> {
    await this.pending
  }

  private async restoreInternal(selector: string): Promise<RecoveryRestoreResult> {
    const mode = this.options.getMode()
    await this.options.stopComponents()
    const result = await this.options.restore(selector)
    await this.options.prepareMode(mode)
    return result
  }
}
