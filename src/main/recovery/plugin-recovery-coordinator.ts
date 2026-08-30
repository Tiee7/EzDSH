import type { RuntimeLaunchContext } from '../runtime/runtime-manager.js'
import type { RuntimeMode, RuntimePhase } from '../runtime/runtime-types.js'
import type { SafeModeReason } from '../runtime/safe-mode-home.js'
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

export interface PluginRecoverySafeMode {
  enable(reason: SafeModeReason): Promise<{ dshHome: string }>
}

export interface PluginRecoveryCoordinatorOptions {
  runtime: PluginRecoveryRuntime
  recovery: PluginRecoveryStore
  safeMode: PluginRecoverySafeMode
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
  private safeModeStart: Promise<void> | undefined

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
        const state = await this.options.recovery.markBootFailure(describe(error))
        if (state.phase === 'recovery-required') {
          try {
            await this.startSafeMode('plugin-recovery')
          } catch (safeModeError) {
            console.error('[recovery] failed to start plugin Safe Mode:', describe(safeModeError))
          }
        }
      }
      throw error
    }
  }

  async startSafeMode(reason: SafeModeReason): Promise<void> {
    if (this.safeModeStart !== undefined) return this.safeModeStart
    this.safeModeStart = (async () => {
      const snapshot = this.options.runtime.snapshot()
      if (snapshot.phase === 'ready' || snapshot.phase === 'starting') await this.options.runtime.stop()
      const safeMode = await this.options.safeMode.enable(reason)
      await this.options.runtime.start({ mode: 'safe', dshHome: safeMode.dshHome })
    })().finally(() => {
      this.safeModeStart = undefined
    })
    return this.safeModeStart
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
