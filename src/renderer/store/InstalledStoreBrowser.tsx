import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type { InstalledRecord, InstallState, StoreEntry } from '../../shared/store.js'
import { updateAvailable } from './display.js'
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
  onUpdate,
  entry,
}: {
  readonly record: InstalledRecord
  readonly copy: AppCopy
  readonly operation?: InstalledOperation
  readonly entry?: StoreEntry
  readonly onToggle: (record: InstalledRecord) => void
  readonly onUninstall: (record: InstalledRecord) => void
  readonly onUpdate: (record: InstalledRecord) => void
}): JSX.Element {
  const plugin = isPlugin(record)
  const key = recordKey(record)
  const busy = operation?.key === key && operation.state.phase === 'installing'
  const failed = operation?.key === key && operation.state.phase === 'failed'
  const updateReady = entry !== undefined && updateAvailable(record, entry)
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
         <button type="button" className="detail-update" disabled={busy || !updateReady} onClick={() => { onUpdate(record) }}>
           {copy.storeUpdate}{updateReady ? ` · v${entry?.version}` : ''}
         </button>
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
  const [catalogEntries, setCatalogEntries] = useState<readonly StoreEntry[]>([])
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | undefined>()

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

  const entriesById = useMemo(() => new Map(catalogEntries.map((entry) => [entry.id, entry])), [catalogEntries])

  const checkUpdates = useCallback(async (): Promise<void> => {
    setCheckingUpdates(true)
    setUpdateMessage(undefined)
    try {
      await window.EzDSH.store.refresh('skill')
      const first = await window.EzDSH.store.list('skill', { page: 1 })
      const pages = await Promise.all(Array.from({ length: Math.max(0, first.pageCount - 1) }, (_, index) => window.EzDSH.store.list('skill', { page: index + 2 })))
      const nextEntries = [first.entries, ...pages.map((page) => page.entries)].flat()
      setCatalogEntries(nextEntries)
      const count = records.filter((record) => {
        const entry = nextEntries.find((candidate) => candidate.id === record.id)
        return entry !== undefined && updateAvailable(record, entry)
      }).length
      setUpdateMessage(count > 0 ? copy.storeUpdatesAvailable(count) : copy.storeNoUpdates)
    } catch (reason) {
      setUpdateMessage(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCheckingUpdates(false)
    }
  }, [copy, records])

  const plugins = useMemo(
    () => records.filter(isPlugin),
    [records],
  )
  const skills = useMemo(
    () => records.filter((record) => record.kind === 'skill' && !isPlugin(record)),
    [records],
  )

  const operate = useCallback(async (record: InstalledRecord, action: 'toggle' | 'uninstall' | 'update'): Promise<void> => {
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
          : action === 'update' ? copy.storeUpdate
          : record.enabled === false ? copy.storeEnablingPlugin : copy.storeDisablingPlugin,
      },
    })
    try {
      const state = action === 'uninstall'
        ? await window.EzDSH.store.uninstall(record.kind, record.id)
        : action === 'update'
          ? await window.EzDSH.store.update(record.kind, record.id)
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
        <div className="installed-store-header-actions">
          <button type="button" className="store-retry" disabled={checkingUpdates} onClick={() => { void checkUpdates }}>
            {checkingUpdates ? copy.storeCheckingUpdates : copy.storeCheckUpdates}
          </button>
          <button type="button" className="store-retry" onClick={onBack}>{copy.storeBackToCatalog}</button>
        </div>
      </header>
      {loading ? <p className="store-status">{copy.storeLoading}</p> : null}
      {updateMessage !== undefined ? <p className="store-status" role="status">{updateMessage}</p> : null}
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
                  entry={entriesById.get(record.id)}
                   onToggle={(item) => { void operate(item, 'toggle') }}
                   onUpdate={(item) => { void operate(item, 'update') }}
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
                  entry={entriesById.get(record.id)}
                   onToggle={(item) => { void operate(item, 'toggle') }}
                   onUpdate={(item) => { void operate(item, 'update') }}
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
