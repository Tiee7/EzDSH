import type { AppCopy } from '../../shared/locale.js'
import type { InstallState } from '../../shared/store.js'

/** Shared operation failure details for catalog and installed-plugin surfaces. */
export function InstallFailureNotice({ copy, state }: { copy: AppCopy; state: InstallState }): JSX.Element {
  const diagnostic = state.diagnostic
  return (
    <div className="install-failure" role="alert">
      <p className="install-failure-title">{diagnostic?.code === 'pending-plugin-verification' ? copy.storePluginChangeWaiting : copy.storeInstallFailed}</p>
      {diagnostic !== undefined
        ? (
          <>
            <p className="install-failure-cause">{copy.storeInstallCause(diagnostic.code)}</p>
            {diagnostic.packageSpec !== undefined ? <p className="install-failure-package"><code>{copy.storeInstallPackage(diagnostic.packageSpec)}</code></p> : null}
            <p className="install-failure-detail">{diagnostic.detail}</p>
            <p className="install-failure-action">{copy.storeInstallAction(diagnostic.code)}</p>
            {state.message !== undefined
              ? (
                <details className="install-failure-technical">
                  <summary>{copy.storeInstallTechnicalDetails}</summary>
                  <pre className="install-failure-message">{state.message}</pre>
                </details>
                )
              : null}
          </>
          )
        : state.message !== undefined ? <pre className="install-failure-message">{state.message}</pre> : null}
      {state.logPath !== undefined ? <p className="install-failure-log">{copy.storeInstallLogPath(state.logPath)}</p> : null}
    </div>
  )
}
