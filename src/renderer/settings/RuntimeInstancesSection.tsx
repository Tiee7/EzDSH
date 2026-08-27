import { useCallback, useEffect, useState } from 'react'
import type { DshRuntimeProcess } from '../../main/runtime/runtime-types.js'
import type { AppCopy } from '../../shared/locale.js'
import { runtimeProcessAction, runtimeProcessBadge, runtimeProcessPort } from './settings-display.js'

interface RuntimeInstancesSectionProps {
  copy: AppCopy
  currentPid?: number
}

/** Lists every detected DSH Runtime and exposes restart/stop actions according to ownership. */
export function RuntimeInstancesSection({ copy, currentPid }: RuntimeInstancesSectionProps): JSX.Element {
  const [runtimes, setRuntimes] = useState<DshRuntimeProcess[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [stoppingPid, setStoppingPid] = useState<number>()
  const [error, setError] = useState<string>()

  const load = useCallback(async (): Promise<void> => {
    setError(undefined)
    setRefreshing(true)
    try {
      setRuntimes(await window.EzDSH.runtime.listProcesses())
    } catch {
      setError(copy.settingsRuntimeLoadFailed)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [copy.settingsRuntimeLoadFailed])

  useEffect(() => {
    void load()
  }, [load, currentPid])

  const runAction = async (runtime: DshRuntimeProcess, current: boolean): Promise<void> => {
    if (stoppingPid !== undefined) return
    setStoppingPid(runtime.pid)
    setError(undefined)
    try {
      if (runtimeProcessAction(current) === 'restart') {
        await window.EzDSH.runtime.restart()
      } else {
        await window.EzDSH.runtime.stopProcess(runtime.pid)
      }
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.settingsRuntimeLoadFailed)
    } finally {
      setStoppingPid(undefined)
    }
  }

  return (
    <div className="settings-runtime-instances">
      <div className="settings-card-header">
        <div className="settings-card-heading-row">
          <div>
            <p className="settings-label">{copy.settingsRuntimeInstances}</p>
            <p className="settings-hint settings-workspace-hint">{copy.settingsRuntimeInstancesHint}</p>
          </div>
          <button className="settings-action" type="button" disabled={refreshing} onClick={() => void load()}>
            {copy.settingsRuntimeRefresh}
          </button>
        </div>
      </div>
      {error ? <p className="settings-error settings-runtime-instances-error" role="alert">{error}</p> : null}
      {loading ? (
        <p className="settings-runtime-instances-empty">{copy.settingsRuntimeLoading}</p>
      ) : runtimes.length === 0 ? (
        <p className="settings-runtime-instances-empty">{copy.settingsRuntimeEmpty}</p>
      ) : (
        <div className="settings-runtime-instance-list">
          {runtimes.map((runtime) => {
            const isCurrent = runtime.current || runtime.pid === currentPid
            const badge = runtimeProcessBadge(isCurrent, runtime.ownedByEzDSH)
            const action = runtimeProcessAction(isCurrent)
            const badgeLabel = isCurrent
              ? copy.settingsRuntimeCurrent
              : runtime.ownedByEzDSH
                ? copy.settingsRuntimeOwned
                : copy.settingsRuntimeExternal
            return (
              <div className="settings-runtime-instance" key={runtime.pid}>
                <div className="settings-runtime-instance-main">
                  <div className="settings-runtime-instance-title">
                    <span className={`settings-dot ${isCurrent ? 'settings-dot-ready' : ''}`} aria-hidden="true" />
                    <span>DSH Runtime</span>
                    <span className={`settings-runtime-badge settings-runtime-badge-${badge}`}>
                      {badgeLabel}
                    </span>
                  </div>
                  <p className="settings-runtime-instance-meta">
                    {copy.settingsRuntimePid} {runtime.pid}
                    {' · '}
                    {copy.settingsRuntimePort} {runtimeProcessPort(runtime.port, copy.settingsRuntimePortUnavailable)}
                    {runtime.startedAt !== undefined ? ` · ${copy.settingsRuntimeStartedAt} ${runtime.startedAt}` : ''}
                  </p>
                  <code className="settings-runtime-instance-command">{runtime.command}</code>
                </div>
                <button
                  className="settings-action"
                  type="button"
                  disabled={stoppingPid !== undefined}
                  onClick={() => void runAction(runtime, isCurrent)}
                >
                  {stoppingPid === runtime.pid
                    ? action === 'restart' ? copy.starting : copy.settingsRuntimeStopping
                    : action === 'restart' ? copy.settingsRestartRuntime : copy.settingsRuntimeStop}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
