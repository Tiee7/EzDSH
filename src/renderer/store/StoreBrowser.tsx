import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppCopy } from '../../shared/locale.js'
import type {
  AuditReport,
  InstalledRecord,
  InstallState,
  StoreCategory,
  StoreEntry,
  StoreKind
} from '../../shared/store.js'
import { auditLabel, auditTone, phaseLabel, updateAvailable } from './display.js'
import './store.css'

interface StoreBrowserProps {
  readonly kind: StoreKind
  readonly copy: AppCopy
  readonly deepLinkTarget?: import('../../shared/contracts.js').DeepLinkInstallTarget
}

function AuditBadge({ entry, copy }: { entry: StoreEntry; copy: AppCopy }): JSX.Element {
  return <span className={`badge ${auditTone(entry.auditLevel)}`}>{auditLabel(copy, entry.auditLevel)}</span>
}

function AuditReportView({ report, copy }: { report: AuditReport; copy: AppCopy }): JSX.Element {
  return (
    <div className="audit-report">
      <p className="audit-title">{copy.storeAuditReport}</p>
      {report.findings.length === 0
        ? <p className="audit-clean">{copy.storeAuditFindingsNone}</p>
        : (
          <ul className="audit-findings">
            {report.findings.map((finding, index) => (
              <li key={index} className={`finding finding-${finding.severity}`}>
                <span className="finding-rule">{finding.rule}</span>
                {finding.file !== undefined ? <span className="finding-file">{finding.file}</span> : null}
                <span className="finding-detail">{finding.detail}</span>
              </li>
            ))}
          </ul>
          )}
      {report.externalUrls.length > 0
        ? (
          <div className="audit-urls">
            <p>{copy.storeAuditExternalUrls}</p>
            <ul>{report.externalUrls.map((url) => <li key={url}>{url}</li>)}</ul>
          </div>
          )
        : null}
    </div>
  )
}

/** One selectable entry card. */
function EntryCard({ entry, installed, copy, selected, onSelect }: {
  entry: StoreEntry
  installed: InstalledRecord | undefined
  copy: AppCopy
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button className={`entry-card ${selected ? 'entry-card-selected' : ''}`} onClick={onSelect}>
      <div className="entry-card-head">
        <span className="entry-name">{entry.name}</span>
        <AuditBadge entry={entry} copy={copy} />
      </div>
      <p className="entry-description">{entry.description}</p>
      <div className="entry-meta">
        <span>v{entry.version}</span>
        {installed !== undefined
          ? <span className="entry-installed">{updateAvailable(installed, entry) ? copy.storeUpdate : copy.storeInstalled}</span>
          : null}
      </div>
    </button>
  )
}

/** Generic catalog browser shared by the skill, preset, and MCP surfaces. */
export function StoreBrowser({ kind, copy, deepLinkTarget }: StoreBrowserProps): JSX.Element {
  const [categories, setCategories] = useState<readonly StoreCategory[]>([])
  const [category, setCategory] = useState<string>('')
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<readonly StoreEntry[]>([])
  const [installed, setInstalled] = useState<readonly InstalledRecord[]>([])
  const [selected, setSelected] = useState<StoreEntry | undefined>()
  const [installState, setInstallState] = useState<InstallState | undefined>()
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [demoSource, setDemoSource] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledRecord>()
    for (const record of installed) map.set(record.id, record)
    return map
  }, [installed])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      const [list, installedList] = await Promise.all([
        window.EzDSH.store.list(kind, { category: category || undefined, search: search || undefined, page: 1 }),
        window.EzDSH.store.listInstalled()
      ])
      setEntries(list.entries)
      setDemoSource(list.source === 'demo')
      setFetchedAt(list.fetchedAt)
      setInstalled(installedList.records)
      setSelected(undefined)
      setInstallState(undefined)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [kind, category, search])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError(false)
    try {
      await window.EzDSH.store.refresh()
      await reload()
    } catch {
      setRefreshError(true)
    } finally {
      setRefreshing(false)
    }
  }, [reload, refreshing])

  useEffect(() => {
    void window.EzDSH.store.categories()
      .then((rows) => { setCategories(rows) })
      .catch(() => { setCategories([]) })
  }, [kind])

  const installById = useCallback(async (id: string): Promise<void> => {
    setInstallState(undefined)
    try {
      const detail = await window.EzDSH.store.entry(kind, id)
      setSelected(detail)
      setInstallState({ kind, id, phase: 'downloading' })
      const state = await window.EzDSH.store.install(kind, id)
      setInstallState(state)
      if (state.phase === 'done') void reload()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id, phase: 'failed', message })
    }
  }, [kind, reload])

  const startInstall = useCallback(async (entry: StoreEntry): Promise<void> => {
    await installById(entry.id)
  }, [installById])

  useEffect(() => {
    const unsubscribe = window.EzDSH.store.onStateChange((state) => {
      if (state.kind !== kind) return
      setInstallState((current) => (current !== undefined ? state : current))
    })
    return unsubscribe
  }, [kind])

  useEffect(() => {
    if (deepLinkTarget === undefined || deepLinkTarget.kind !== kind) return
    void installById(deepLinkTarget.id)
  }, [deepLinkTarget, kind, installById])

  const confirmInstall = useCallback(async (accepted: boolean): Promise<void> => {
    if (selected === undefined || installState === undefined) return
    try {
      const state = await window.EzDSH.store.confirmInstall(kind, selected.id, accepted)
      setInstallState(state)
      if (state.phase === 'done') void reload()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id: selected.id, phase: 'failed', message })
    }
  }, [kind, selected, installState, reload])

  const uninstall = useCallback(async (entry: StoreEntry): Promise<void> => {
    try {
      setInstallState({ kind, id: entry.id, phase: 'installing', message: copy.storeUninstall })
      const state = await window.EzDSH.store.uninstall(kind, entry.id)
      setInstallState(state)
      if (state.phase === 'done') void reload()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id: entry.id, phase: 'failed', message })
    }
  }, [kind, copy, reload])

  const busy = installState !== undefined
    && installState.id === selected?.id
    && (installState.phase === 'downloading' || installState.phase === 'auditing' || installState.phase === 'installing')

  return (
    <div className="store-layout">
      <aside className="store-sidebar">
        <button
          className={`category-item ${category === '' ? 'category-item-active' : ''}`}
          onClick={() => { setCategory('') }}
        >
          {copy.storeAllCategories}
        </button>
        {categories.map((row) => (
          <button
            key={row.id}
            className={`category-item ${category === row.id ? 'category-item-active' : ''}`}
            onClick={() => { setCategory(row.id) }}
          >
            {row.name}
          </button>
        ))}
      </aside>
      <section className="store-list">
        <form
          className="store-search"
          onSubmit={(event) => {
            event.preventDefault()
            void reload()
          }}
        >
          <input
            value={search}
            placeholder={copy.storeSearchPlaceholder}
            onChange={(event) => { setSearch(event.target.value) }}
          />
          {demoSource ? <span className="store-demo-badge">{copy.storeDemoBadge}</span> : null}
          {refreshing
            ? <span className="store-meta">{copy.storeRefreshing}</span>
            : (
              <span className="store-meta">
                {fetchedAt !== undefined ? copy.storeLastUpdated(new Date(fetchedAt).toLocaleString()) : copy.storeNeverRefreshed}
              </span>
              )}
          <button className="store-refresh" disabled={refreshing} onClick={() => { void refreshCatalog() }}>
            {copy.storeRefresh}
          </button>
          {refreshError ? <span className="store-error" role="alert">{copy.storeRefreshFailed}</span> : null}
          {error ? <span className="store-error" role="alert">{copy.storeLoadFailed}</span> : null}
        </form>
        {loading ? <p className="store-status">{copy.storeLoading}</p> : null}
        {!loading && entries.length === 0 && !error ? <p className="store-status">{copy.storeEmpty}</p> : null}
        {error && !loading
          ? <button className="store-retry" onClick={() => { void reload() }}>{copy.storeRetry}</button>
          : null}
        <div className="entry-grid">
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              installed={installedById.get(entry.id)}
              copy={copy}
              selected={selected?.id === entry.id}
              onSelect={() => { setSelected(entry); setInstallState(undefined) }}
            />
          ))}
        </div>
      </section>
      {selected === undefined ? <aside className="store-detail store-detail-empty" /> : (
        <aside className="store-detail">
          <h2 className="detail-name">{selected.name}</h2>
          <div className="detail-meta">
            <AuditBadge entry={selected} copy={copy} />
            <span>v{selected.version}</span>
          </div>
          <p className="detail-description">{selected.description}</p>
          {selected.readme !== undefined
            ? <pre className="detail-readme">{selected.readme}</pre>
            : null}
          {selected.files !== undefined && selected.files.length > 0
            ? (
              <div className="detail-files">
                <p>{copy.storeDetailFiles}</p>
                <ul>
                  {selected.files.map((file) => (
                    <li key={file.path} className={`file-kind-${file.kind}`}>{file.path}</li>
                  ))}
                </ul>
              </div>
              )
            : null}
          {selected.mcp !== undefined
            ? (
              <div className="detail-files">
                <p>{copy.storeDetailMcp}</p>
                <pre>{JSON.stringify(selected.mcp, null, 2)}</pre>
              </div>
              )
            : null}
          {installState?.audit !== undefined && installState.id === selected.id
            ? <AuditReportView report={installState.audit} copy={copy} />
            : null}
          {installState !== undefined && installState.id === selected.id
            ? <p className={`install-phase phase-${installState.phase}`}>
                {phaseLabel(copy, installState.phase)}
                {installState.message !== undefined ? ` — ${installState.message}` : ''}
              </p>
            : null}
          {installState?.phase === 'confirm-wait' && installState.id === selected.id
            ? (
              <div className="confirm-row">
                <button className="confirm-accept" disabled={busy} onClick={() => { void confirmInstall(true) }}>
                  {copy.storeConfirmInstall}
                </button>
                <button className="confirm-cancel" disabled={busy} onClick={() => { void confirmInstall(false) }}>
                  {copy.storeCancel}
                </button>
              </div>
              )
            : null}
          {installState !== undefined && installState.id === selected.id && installState.phase === 'failed' && installState.failureReason === 'audit-blocked'
            ? <p className="install-blocked">{copy.storeAuditBlocked}</p>
            : null}
          <div className="detail-actions">
            {installedById.get(selected.id) === undefined
              ? (
                <button
                  className="detail-install"
                  disabled={busy}
                  onClick={() => { void startInstall(selected) }}
                >
                  {copy.storeInstall}
                </button>
                )
              : (
                <>
                  {updateAvailable(installedById.get(selected.id), selected)
                    ? (
                      <button className="detail-install" disabled={busy} onClick={() => {
                        void (async () => {
                          await window.EzDSH.store.uninstall(kind, selected.id)
                          await startInstall(selected)
                        })()
                      }}>
                        {copy.storeUpdate}
                      </button>
                      )
                    : null}
                  <button className="detail-uninstall" disabled={busy} onClick={() => { void uninstall(selected) }}>
                    {copy.storeUninstall}
                  </button>
                </>
                )}
          </div>
        </aside>
      )}
    </div>
  )
}
