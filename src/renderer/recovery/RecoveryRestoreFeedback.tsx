import type { AppCopy } from '../../shared/locale.js'
import type { RecoveryRestoreFlow } from './useRecoveryRestore.js'

interface RecoveryRestoreFeedbackProps {
  copy: AppCopy
  flow: RecoveryRestoreFlow
  onRefresh?: () => Promise<void>
  surface?: 'settings' | 'startup'
}

export function RecoveryRestoreFeedback({ copy, flow, onRefresh, surface = 'settings' }: RecoveryRestoreFeedbackProps): JSX.Element {
  const startup = surface === 'startup'
  return <>
    {flow.message ? <p className={startup ? 'recovery-detail' : 'settings-recovery-message'} role="status">{flow.message}</p> : null}
    {flow.error ? <p className={startup ? 'recovery-error' : 'settings-error settings-recovery-message'} role="alert">{flow.error}</p> : null}
    {flow.pendingRuntimeRestore ? (
      <button className={startup ? 'runtime-failure-action runtime-failure-action-primary' : 'settings-action settings-action-primary'} type="button" disabled={flow.busy} onClick={() => { void flow.retryRuntime(onRefresh) }}>
        {copy.settingsRecoveryRetryRuntime}
      </button>
    ) : null}
  </>
}
