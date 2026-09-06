import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { InstalledRecord, InstallState } from '../../shared/store.js'
import './store.css'

interface InstalledStoreBrowserProps {
  readonly copy: AppCopy
  readonly onBack: () => void
}

interface InstalledOperation {
  readonly key: string
  readonly state: InstallState
}

function recordKey(record: InstalledRecord): string {
  return `${record.kind}:${record.id}:${record.pluginProfile ?? ''}`
}

function isPlugin(record: InstalledRecord): boolean {
  return record.kind === 'skill' && record.pluginPackageName !== undefined
}

function InstalledCard({
  record,
  copy,
  operation,
  onToggle,
  onUninstall,
}: {
  readonly record: InstalledRecord
  readonly copy: AppCopy
  readonly operation?: InstalledOperation
  readonly onToggle: (record: InstalledRecord) => void
  readonly onUninstall: (record: InstalledRecord) => void
}): JSX.Element {
  const plugin = isPlugin(record)
  const key = recordKey(record)
  const busy = operation?.key === key && operation.state.phase === 'installing'
  const failed = operation?.key === key && operation.state.phase === 'failed'
  return (
    <article className="installed-card">
      <div className="installed-card-header">
        <div>
          <h4>{record.name}</h4>
          <p className="installed-card-type">
            {plugin ? copy.storeEntryTypePlugin : copy.storeInstalledSkillType}
            {plugin && record.pluginProfile !== undefined ? ` · ${copy.storeInstalledProfile(record.pluginProfile)}` : ''}
          </p>
        </div>
        <span className={`installed-card-status ${record.enabled === false ? 'installed-card-status-disabled' : ''}`}>
          {plugin
            ? record.enabled === false ? copy.storePluginDisabled : copy.storePluginEnabled
            : copy.storeInstalled}
        </span>
      </div>
      <div className="installed-card-meta">
        <span>v{record.version}</span>
        {plugin && record.pluginPackageName !== undefined ? <code>{record.pluginPackageName}</code> : null}
        {plugin && record.pluginSource === undefined ? <span>{copy.storeInstalledExternal}</span> : null}
      </div>
      {failed
        ? <p className="installed-card-error" role="alert">{operation?.state.message ?? copy.storeLoadFailed}</p>
        : null}
      {operation?.key === key && operation.state.phase === 'installing'
        ? <p className="installed-card-progress" role="status">{operation.state.message ?? copy.storePhaseInstalling}</p>
        : null}
      <div className="installed-card-actions">
        {plugin
          ? (
            <button type="button" className="detail-toggle-plugin" disabled={busy} onClick={() => { onToggle(record) }}>
              {record.enabled === false ? copy.storeEnablePlugin : copy.storeDisablePlugin}
            </button>
            )
          : null}
        <button type="button" className="detail-uninstall" disabled={busy} onClick={() => { onUninstall(record) }}>
          {copy.storeUninstall}
        </button>
      </div>
    </article>
  )
}

/** Read-only-independent view for managing every installed Skill and DSH profile plugin. */
export function InstalledStoreBrowser({ copy, onBack }: InstalledStoreBrowserProps): JSX.Element {
  const [records, setRecords] = useState<readonly InstalledRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [operation, setOperation] = useState<InstalledOperation | undefined>()
  const [runtimeRestarting, setRuntimeRestarting] = useState(false)
  const [runtimeRestartError, setRuntimeRestartError] = useState<string | undefined>()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      setRecords((await window.EzDSH.store.listInstalled()).records)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const plugins = useMemo(
    () => records.filter(isPlugin),
    [records],
  )
  const skills = useMemo(
    () => records.filter((record) => record.kind === 'skill' && !isPlugin(record)),
    [records],
  )

  const operate = useCallback(async (record: InstalledRecord, action: 'toggle' | 'uninstall'): Promise<void> => {
    const key = recordKey(record)
    setRuntimeRestartError(undefined)
    setOperation({
      key,
      state: {
        kind: record.kind,
        id: record.id,
        phase: 'installing',
        message: action === 'uninstall'
          ? copy.storeUninstalling
          : record.enabled === false ? copy.storeEnablingPlugin : copy.storeDisablingPlugin,
      },
    })
    try {
      const state = action === 'uninstall'
        ? await window.EzDSH.store.uninstall(record.kind, record.id)
        : await window.EzDSH.store.setEnabled(record.kind, record.id, record.enabled === false)
      setOperation({ key, state })
      if (state.phase === 'done') await load()
    } catch (reason) {
      setOperation({
        key,
        state: {
          kind: record.kind,
          id: record.id,
          phase: 'failed',
          failureReason: 'install',
          message: reason instanceof Error ? reason.message : String(reason),
        },
      })
    }
  }, [copy, load])

  const restartRuntime = useCallback(async (): Promise<void> => {
    setRuntimeRestarting(true)
    setRuntimeRestartError(undefined)
    try {
      await window.EzDSH.runtime.restart()
    } catch (reason) {
      setRuntimeRestartError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRuntimeRestarting(false)
    }
  }, [])

  return (
    <div className="installed-store">
      <header className="installed-store-header">
        <div>
          <h2>{copy.storeInstalledSection}</h2>
          <p>{copy.storeInstalledHint}</p>
        </div>
        <button type="button" className="store-retry" onClick={onBack}>{copy.storeBackToCatalog}</button>
      </header>
      {loading ? <p className="store-status">{copy.storeLoading}</p> : null}
      {error && !loading
        ? <div className="installed-store-error" role="alert"><span>{copy.storeLoadFailed}</span><button type="button" className="store-retry" onClick={() => { void load() }}>{copy.storeRetry}</button></div>
        : null}
      {!loading && !error && plugins.length === 0 && skills.length === 0
        ? <p className="store-status">{copy.storeInstalledEmpty}</p>
        : null}
      {!loading && !error && plugins.length > 0
        ? (
          <section className="installed-store-group">
            <h3>{copy.storeInstalledPlugins} <span>{plugins.length}</span></h3>
            <div className="installed-store-grid">
              {plugins.map((record) => (
                <InstalledCard
                  key={recordKey(record)}
                  record={record}
                  copy={copy}
                  operation={operation}
                  onToggle={(item) => { void operate(item, 'toggle') }}
                  onUninstall={(item) => { void operate(item, 'uninstall') }}
                />
              ))}
            </div>
          </section>
          )
        : null}
      {!loading && !error && skills.length > 0
        ? (
          <section className="installed-store-group">
            <h3>{copy.storeInstalledSkills} <span>{skills.length}</span></h3>
            <div className="installed-store-grid">
              {skills.map((record) => (
                <InstalledCard
                  key={recordKey(record)}
                  record={record}
                  copy={copy}
                  operation={operation}
                  onToggle={(item) => { void operate(item, 'toggle') }}
                  onUninstall={(item) => { void operate(item, 'uninstall') }}
                />
              ))}
            </div>
          </section>
          )
        : null}
      {operation?.state.phase === 'done' && operation.state.runtimeRestartRequired
        ? (
          <div className="runtime-restart-notice" role="status">
            <p>{copy.storeRuntimeRestartRequired}</p>
            {runtimeRestartError !== undefined ? <p className="runtime-restart-error">{runtimeRestartError}</p> : null}
            <button type="button" className="confirm-accept" disabled={runtimeRestarting} onClick={() => { void restartRuntime() }}>
              {runtimeRestarting ? copy.storeRuntimeRestarting : copy.storeRuntimeRestartNow}
            </button>
          </div>
          )
        : null}
    </div>
  )
}
