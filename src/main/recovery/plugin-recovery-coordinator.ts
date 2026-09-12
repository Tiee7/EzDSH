import type { RuntimeLaunchContext } from '../runtime/runtime-manager.js'
import type { RuntimeMode, RuntimePhase } from '../runtime/runtime-types.js'
import type { IsolationModeReason } from '../runtime/isolation-mode-home.js'
import type {
  PreparePluginChangeInput,
  RecoveryState,
  RecoveryTransaction,
} from './recovery-manager.js'

export interface PluginRecoveryRuntime {
  snapshot(): { phase: RuntimePhase; mode: RuntimeMode }
  stop(): Promise<void>
  start(context?: RuntimeLaunchContext): Promise<unknown>
}

export interface PluginRecoveryStore {
  preparePluginChange(input: PreparePluginChangeInput): Promise<RecoveryTransaction>
  abortPendingTransaction(): Promise<void>
  completePendingTransaction(): Promise<void>
  markBootFailure(error: string): Promise<RecoveryState>
  hasPendingTransaction?: () => Promise<boolean>
}

export interface PluginRecoveryIsolationMode {
  enable(reason: IsolationModeReason): Promise<{ dshHome: string }>
}

export interface PluginRecoveryCoordinatorOptions {
  runtime: PluginRecoveryRuntime
  recovery: PluginRecoveryStore
  isolationMode: PluginRecoveryIsolationMode
}

export interface PluginRecoveryOutcome<T> {
  value: T
  transactionId: string
}

export interface PluginRecoveryRunOptions {
  /** Keep a running Runtime alive and wait for the user to restart it after a successful install. */
  deferRuntimeRestart?: boolean
}

/**
 * Makes an EzDSH-managed DSH plugin mutation recoverable. By default the
 * previous Runtime is stopped before the backup so the archive contains a
 * stable profile. Install callers can defer the restart: the profile is
 * mutated while Runtime remains usable, and the pending transaction is kept
 * until the user's later restart has booted successfully.
 */
export class PluginRecoveryCoordinator {
  private isolationModeStart: Promise<void> | undefined

  constructor(private readonly options: PluginRecoveryCoordinatorOptions) {}

  async run<T>(
    input: PreparePluginChangeInput,
    mutate: () => Promise<T>,
    persist: (value: T) => Promise<void>,
    options: PluginRecoveryRunOptions = {},
  ): Promise<PluginRecoveryOutcome<T>> {
    if (this.options.recovery.hasPendingTransaction !== undefined && await this.options.recovery.hasPendingTransaction()) {
      throw new Error('Restart Runtime before changing another DSH plugin')
    }
    const wasRunning = this.options.runtime.snapshot().phase === 'ready'
    const deferRuntimeRestart = options.deferRuntimeRestart === true && wasRunning
    if (wasRunning && !deferRuntimeRestart) await this.options.runtime.stop()
    const transaction = await this.options.recovery.preparePluginChange(input)
    let mutationCompleted = false
    try {
      const value = await mutate()
      mutationCompleted = true
      await persist(value)
      if (wasRunning && !deferRuntimeRestart) {
        await this.options.runtime.start({ mode: 'normal' })
        await this.options.recovery.completePendingTransaction()
      } else if (!wasRunning) {
        await this.options.recovery.completePendingTransaction()
      }
      return { value, transactionId: transaction.id }
    } catch (error) {
      if (!mutationCompleted) {
        await this.options.recovery.abortPendingTransaction()
      } else {
        // Keep the failed transaction visible in Recovery; recovery modes are
        // an explicit user choice and must never be entered as a side effect.
        await this.options.recovery.markBootFailure(describe(error))
      }
      throw error
    }
  }

  async startIsolationMode(reason: IsolationModeReason): Promise<void> {
    if (this.isolationModeStart !== undefined) return this.isolationModeStart
    this.isolationModeStart = (async () => {
      const snapshot = this.options.runtime.snapshot()
      if (snapshot.phase === 'ready' || snapshot.phase === 'starting') await this.options.runtime.stop()
      const isolationMode = await this.options.isolationMode.enable(reason)
      await this.options.runtime.start({ mode: 'isolation', dshHome: isolationMode.dshHome })
    })().finally(() => {
      this.isolationModeStart = undefined
    })
    return this.isolationModeStart
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
