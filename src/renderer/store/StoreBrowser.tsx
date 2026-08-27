import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type {
  AuditReport,
  InstalledRecord,
  InstallState,
  StoreCategory,
  StoreEntry,
  StoreKind
} from '../../shared/store.js'
import { auditLabel, auditTone, categoryLabel, phaseLabel, updateAvailable } from './display.js'
import { MarkdownContent } from './MarkdownContent.js'
import './store.css'

interface StoreBrowserProps {
  readonly kind: StoreKind
  /** Keep this browser scoped to one catalog category, e.g. the plugin surface. */
  readonly fixedCategory?: string
  readonly copy: AppCopy
  readonly locale: AppLocale
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

export function AuditOverrideActions({ copy, disabled, onInstallAnyway }: {
  copy: AppCopy
  disabled: boolean
  onInstallAnyway: () => void
}): JSX.Element {
  return (
    <div className="confirm-row">
      <button type="button" className="confirm-accept" disabled={disabled} onClick={onInstallAnyway}>
        {copy.storeInstallAnyway}
      </button>
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
      {installed !== undefined
        ? <span className="entry-installed">{updateAvailable(installed, entry) ? copy.storeUpdate : copy.storeInstalled}</span>
        : null}
      <div className="entry-card-head">
        <span className="entry-name">{entry.name}</span>
        <AuditBadge entry={entry} copy={copy} />
      </div>
      <p className="entry-description">{entry.description}</p>
      <div className="entry-meta">
        <span>v{entry.version}</span>
      </div>
    </button>
  )
}

function Pagination({ page, pageCount, copy, onPageChange }: {
  page: number
  pageCount: number
  copy: AppCopy
  onPageChange: (page: number) => void
}): JSX.Element {
  return (
    <nav className="store-pagination" aria-label={copy.storePagination}>
      <button
        type="button"
        className="store-page-button"
        disabled={page <= 1}
        onClick={() => { onPageChange(page - 1) }}
      >
        {copy.storePreviousPage}
      </button>
      <span className="store-page-indicator">{copy.storePage(page, pageCount)}</span>
      <button
        type="button"
        className="store-page-button"
        disabled={page >= pageCount}
        onClick={() => { onPageChange(page + 1) }}
      >
        {copy.storeNextPage}
      </button>
    </nav>
  )
}

/** Generic catalog browser shared by the skill, preset, and MCP surfaces. */
export function StoreBrowser({ kind, fixedCategory, copy, locale, deepLinkTarget }: StoreBrowserProps): JSX.Element {
  const [categories, setCategories] = useState<readonly StoreCategory[]>([])
  const [category, setCategory] = useState<string>(fixedCategory ?? '')
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<readonly StoreEntry[]>([])
  const [totalCount, setTotalCount] = useState<number | undefined>()
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [installed, setInstalled] = useState<readonly InstalledRecord[]>([])
  const [selected, setSelected] = useState<StoreEntry | undefined>()
  const [installState, setInstallState] = useState<InstallState | undefined>()
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [demoSource, setDemoSource] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)
  const [runtimeRestartDeferred, setRuntimeRestartDeferred] = useState(false)
  const [runtimeRestarting, setRuntimeRestarting] = useState(false)
  const [runtimeRestartError, setRuntimeRestartError] = useState<string | undefined>()

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledRecord>()
    for (const record of installed) map.set(record.id, record)
    return map
  }, [installed])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(false)
    setTotalCount(undefined)
    setPageCount(1)
    try {
      const [list, installedList] = await Promise.all([
        window.EzDSH.store.list(kind, { category: category || undefined, search: search || undefined, page }),
        window.EzDSH.store.listInstalled()
      ])
      setEntries(list.entries)
      setTotalCount(list.total ?? list.entries.length)
      setPageCount(Math.max(1, list.pageCount))
      setDemoSource(list.source === 'demo')
      setFetchedAt(list.fetchedAt)
      setInstalled(installedList.records)
      setSelected(undefined)
      setInstallState(undefined)
      setRuntimeRestartDeferred(false)
      setRuntimeRestartError(undefined)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [kind, fixedCategory, category, search, page])

  const refreshInstalled = useCallback(async (): Promise<void> => {
    try {
      setInstalled((await window.EzDSH.store.listInstalled()).records)
    } catch {
      // The install result remains authoritative even if the list refresh is delayed.
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError(false)
    try {
      await window.EzDSH.store.refresh(kind)
      await reload()
    } catch {
      setRefreshError(true)
    } finally {
      setRefreshing(false)
    }
  }, [reload, refreshing])

  useEffect(() => {
    if (fixedCategory !== undefined) {
      setCategories([])
      return
    }
    void window.EzDSH.store.categories(kind)
      .then((rows) => { setCategories(rows) })
      .catch(() => { setCategories([]) })
  }, [kind, fixedCategory])

  const installById = useCallback(async (id: string, allowAuditBlock = false): Promise<void> => {
    setInstallState(undefined)
    setRuntimeRestartDeferred(false)
    setRuntimeRestartError(undefined)
    try {
      const detail = await window.EzDSH.store.entry(kind, id)
      setSelected(detail)
      setInstallState({ kind, id, phase: 'downloading' })
      const state = allowAuditBlock
        ? await window.EzDSH.store.installAnyway(kind, id)
        : await window.EzDSH.store.install(kind, id)
      setInstallState(state)
      if (state.phase === 'done') void refreshInstalled()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id, phase: 'failed', message })
    }
  }, [kind, refreshInstalled])

  const startInstall = useCallback(async (entry: StoreEntry): Promise<void> => {
    await installById(entry.id)
  }, [installById])

  const installAnyway = useCallback(async (entry: StoreEntry): Promise<void> => {
    await installById(entry.id, true)
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

  const restartRuntime = useCallback(async (): Promise<void> => {
    setRuntimeRestarting(true)
    setRuntimeRestartError(undefined)
    try {
      await window.EzDSH.runtime.restart()
      setRuntimeRestartDeferred(true)
    } catch (reason) {
      setRuntimeRestartError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRuntimeRestarting(false)
    }
  }, [])

  const confirmInstall = useCallback(async (accepted: boolean): Promise<void> => {
    if (selected === undefined || installState === undefined) return
    try {
      const state = await window.EzDSH.store.confirmInstall(kind, selected.id, accepted)
      setInstallState(state)
      if (state.phase === 'done') void refreshInstalled()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id: selected.id, phase: 'failed', message })
    }
  }, [kind, selected, installState, refreshInstalled])

  const uninstall = useCallback(async (entry: StoreEntry): Promise<void> => {
    setRuntimeRestartDeferred(false)
    setRuntimeRestartError(undefined)
    try {
      setInstallState({ kind, id: entry.id, phase: 'installing', message: copy.storeUninstall })
      const state = await window.EzDSH.store.uninstall(kind, entry.id)
      setInstallState(state)
      if (state.phase === 'done') void refreshInstalled()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id: entry.id, phase: 'failed', message })
    }
  }, [kind, copy, refreshInstalled])

  const update = useCallback(async (entry: StoreEntry): Promise<void> => {
    setRuntimeRestartDeferred(false)
    setRuntimeRestartError(undefined)
    try {
      setInstallState({ kind, id: entry.id, phase: 'installing', message: copy.storeUpdate })
      const state = await window.EzDSH.store.update(kind, entry.id)
      setInstallState(state)
      if (state.phase === 'done') void refreshInstalled()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setInstallState({ kind, id: entry.id, phase: 'failed', message })
    }
  }, [kind, copy, refreshInstalled])

  const busy = installState !== undefined
    && installState.id === selected?.id
    && (installState.phase === 'downloading' || installState.phase === 'auditing' || installState.phase === 'installing' || runtimeRestarting)

  return (
    <div className="store-layout">
      <aside className="store-sidebar">
        <button
          className={`category-item ${category === '' ? 'category-item-active' : ''}`}
          onClick={() => { setCategory(''); setPage(1) }}
        >
          {copy.storeAllCategories}
        </button>
        {fixedCategory === undefined
          ? categories.map((row) => (
            <button
              key={row.id}
              className={`category-item ${category === row.id ? 'category-item-active' : ''}`}
              onClick={() => { setCategory(row.id); setPage(1) }}
            >
              {categoryLabel(row, locale)}
            </button>
            ))
          : <span className="category-item category-item-active">{categoryLabel({ id: fixedCategory, name: fixedCategory }, locale)}</span>}
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
            onChange={(event) => { setSearch(event.target.value); setPage(1) }}
          />
          {demoSource ? <span className="store-demo-badge">{copy.storeDemoBadge}</span> : null}
          {totalCount !== undefined
            ? <span className="store-count">{copy.storeTotalCount(totalCount)}</span>
            : null}
          {refreshing
            ? <span className="store-meta">{copy.storeRefreshing}</span>
            : (
              <span className="store-meta">
                {fetchedAt !== undefined ? copy.storeLastUpdated(new Date(fetchedAt).toLocaleString()) : copy.storeNeverRefreshed}
              </span>
              )}
          <button type="button" className="store-refresh" disabled={refreshing} onClick={() => { void refreshCatalog() }}>
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
              onSelect={() => {
                setSelected(entry)
                setInstallState(undefined)
                setRuntimeRestartDeferred(false)
                setRuntimeRestartError(undefined)
              }}
            />
          ))}
        </div>
        {!loading && !error && pageCount > 1
          ? <Pagination page={page} pageCount={pageCount} copy={copy} onPageChange={setPage} />
          : null}
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
            ? <div className="detail-readme"><MarkdownContent markdown={selected.readme} /></div>
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
          {selected.plugin !== undefined
            ? (
              <div className="detail-files">
                <p>{copy.storeDetailPlugin}</p>
                <pre>{selected.plugin.source}</pre>
              </div>
              )
            : null}
          {installState?.audit !== undefined && installState.id === selected.id
            ? <AuditReportView report={installState.audit} copy={copy} />
            : null}
          {installState?.compatibility?.status === 'unknown' && installState.id === selected.id
            ? <p className="compatibility-warning" role="status">DSH 兼容性尚未由目录声明；已记录当前版本，建议先在安全模式验证。</p>
            : null}
          {installState?.compatibility?.status === 'incompatible' && installState.id === selected.id
            ? <p className="compatibility-error" role="alert">{installState.compatibility.reason}</p>
            : null}
          {installState !== undefined && installState.id === selected.id
            ? <p className={`install-phase phase-${installState.phase}`}>
                {phaseLabel(copy, installState.phase)}
                {installState.message !== undefined ? ` — ${installState.message}` : ''}
              </p>
            : null}
          {installState?.phase === 'done' && installState.id === selected.id && installState.runtimeRestartRequired && !runtimeRestartDeferred
            ? (
              <div className="runtime-restart-notice" role="status">
                <p>{copy.storeRuntimeRestartRequired}</p>
                {runtimeRestartError !== undefined ? <p className="runtime-restart-error">{runtimeRestartError || copy.storeRuntimeRestartFailed}</p> : null}
                <div className="runtime-restart-actions">
                  <button type="button" className="confirm-accept" disabled={runtimeRestarting} onClick={() => { void restartRuntime() }}>
                    {runtimeRestarting ? copy.storeRuntimeRestarting : copy.storeRuntimeRestartNow}
                  </button>
                  <button type="button" className="confirm-cancel" disabled={runtimeRestarting} onClick={() => { setRuntimeRestartDeferred(true) }}>
                    {copy.storeRuntimeRestartLater}
                  </button>
                </div>
              </div>
              )
            : null}
          {installState?.phase === 'done' && installState.id === selected.id && installState.runtimeRestartRequired && runtimeRestartDeferred
            ? <p className="runtime-restart-deferred" role="status">{copy.storeRuntimeRestartDeferred}</p>
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
          {installState !== undefined && installState.id === selected.id && installState.phase === 'failed' && installState.failureReason === 'audit-blocked'
            ? (
              <AuditOverrideActions copy={copy} disabled={busy} onInstallAnyway={() => { void installAnyway(selected) }} />
              )
            : null}
          <div className="detail-actions">
            {installedById.get(selected.id) === undefined
              ? (
                <button
                  className="detail-install"
                  disabled={busy || runtimeRestarting}
                  onClick={() => { void startInstall(selected) }}
                >
                  {copy.storeInstall}
                </button>
                )
              : (
                <>
                  {updateAvailable(installedById.get(selected.id), selected)
                    ? (
                      <button className="detail-install" disabled={busy || runtimeRestarting} onClick={() => { void update(selected) }}>
                        {copy.storeUpdate}
                      </button>
                      )
                    : null}
                  <button className="detail-uninstall" disabled={busy || runtimeRestarting} onClick={() => { void uninstall(selected) }}>
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
