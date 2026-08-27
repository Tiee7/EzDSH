/**
 * Facade over the store subsystem for the IPC layer. Catalog calls delegate
 * to the remote client; installs run the pipeline
 * download → audit → confirm-wait → install → registry, publishing every
 * phase transition to renderer windows. One in-flight install per kind+id;
 * `block` verdicts abort before anything touches the DSH home unless the user
 * explicitly chooses the one-shot override.
 *
 * @module store-service
 */

import { createHash } from 'node:crypto'
import type {
  AuditReport,
  InstalledListResult,
  InstallState,
  StoreCategory,
  StoreEntry,
  InstalledRecord,
  StoreKind,
  StoreListResult,
  StoreMcpConfig,
  StoreRefreshResult
} from '../../shared/store.js'
import { STORE_KINDS } from '../../shared/store.js'
import { auditBundle, auditMcpConfig, auditPluginSource } from './audit.js'
import { StoreClient, type StoreListQuery } from './store-client.js'
import { downloadBundle, DownloadError, type DownloadedBundle } from './downloader.js'
import { InstallRegistry } from './install-registry.js'
import { readCatalogCache, writeCatalogCache, type CachedCatalog } from './catalog-cache.js'
import { demoCategories, demoEntries } from './demo-catalog.js'
import { webProfilePatchFile } from './install-paths.js'
import { installSkillBundle, SkillConflictError, uninstallSkill } from './skill-installer.js'
import { installPresetBundle, PresetConflictError, uninstallPreset } from './preset-installer.js'
import { installMcpEntry, uninstallMcpEntry } from './mcp-installer.js'
import { InstallErrorReporter, type InstallErrorReport } from './install-reporter.js'
import type { PreparePluginChangeInput } from '../recovery/recovery-manager.js'

/** Client-side adapter for installing a Skill entry backed by a DSH plugin package. */
export interface StorePluginInstaller {
  install(entry: StoreEntry): Promise<{ packageName: string; profile: string; runtimeRestartRequired?: boolean }>
  uninstall(record: InstalledRecord, entry?: StoreEntry): Promise<{ runtimeRestartRequired?: boolean } | void>
}

/** Transaction boundary for Store-managed DSH profile plugin changes. */
export interface StorePluginRecovery {
  run<T>(
    input: PreparePluginChangeInput,
    mutate: () => Promise<T>,
    persist: (value: T) => Promise<void>,
  ): Promise<{ value: T; transactionId: string }>
}

/** Remote catalog source used only by explicit refreshes. */
export interface RemoteCatalogSource {
  list(kind: StoreKind, query?: StoreListQuery, options?: { force?: boolean }): Promise<StoreListResult>
  categories(options?: { force?: boolean }): Promise<StoreCategory[]>
  entry?(kind: StoreKind, id: string): Promise<StoreEntry>
}

export interface StoreServiceOptions {
  client?: RemoteCatalogSource
  /** DSH home directory; required for installs. */
  dshHome?: string
  /** Installation registry file path; defaults alongside the DSH home when omitted. */
  registryPath?: string
  /** Catalog cache file path; enables offline serving of the last refresh. */
  catalogCachePath?: string
  fetchImpl?: typeof fetch
  /** Best-effort Hub reporter; failures never affect the install result. */
  installErrorReporter?: Pick<InstallErrorReporter, 'report'>
  /** Sink for install progress events forwarded to renderer windows. */
  onStateChange?: (state: InstallState) => void
  /** DSH profile plugin installer; omitted in builds that only support bundles. */
  pluginInstaller?: StorePluginInstaller
  /** Recovery boundary for DSH profile plugin mutations. */
  pluginRecovery?: StorePluginRecovery
}

/** One install parked at `confirm-wait` between `install()` and `confirmInstall()`. */
interface PendingInstall {
  readonly entry: StoreEntry
  readonly audit: AuditReport
  readonly bundle?: DownloadedBundle
}

/** Page size of locally filtered catalog lists. */
const CATALOG_PAGE_SIZE = 12

/** Store facade owning catalog access and the install pipeline. */
export class StoreService {
  private readonly client: RemoteCatalogSource
  private readonly dshHome: string | undefined
  private readonly registryPath: string | undefined
  private readonly catalogCachePath: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly installErrorReporter: Pick<InstallErrorReporter, 'report'>
  private readonly emit: (state: InstallState) => void
  private readonly pluginInstaller: StorePluginInstaller | undefined
  private readonly pluginRecovery: StorePluginRecovery | undefined
  private readonly pending = new Map<string, PendingInstall>()
  private readonly inFlight = new Set<string>()
  private registry: InstallRegistry | undefined
  private remoteCatalog: CachedCatalog | undefined
  private catalogInit: Promise<void> | undefined

  constructor(options: StoreServiceOptions = {}) {
    this.client = options.client ?? new StoreClient()
    this.dshHome = options.dshHome
    this.registryPath = options.registryPath
    this.catalogCachePath = options.catalogCachePath
    this.fetchImpl = options.fetchImpl ?? fetch
    this.installErrorReporter = options.installErrorReporter ?? new InstallErrorReporter({ fetchImpl: this.fetchImpl })
    this.emit = options.onStateChange ?? (() => undefined)
    this.pluginInstaller = options.pluginInstaller
    this.pluginRecovery = options.pluginRecovery
  }

  /** Load the persisted remote snapshot once; catalog reads never touch the network after this. */
  private async ensureCatalog(): Promise<void> {
    if (this.catalogInit === undefined) {
      this.catalogInit = (async () => {
        if (this.catalogCachePath === undefined) return
        try {
          this.remoteCatalog = await readCatalogCache(this.catalogCachePath)
        } catch {
          this.remoteCatalog = undefined
        }
      })()
    }
    return this.catalogInit
  }

  /** Builtin baseline overridden by the last remote refresh (remote wins per kind+id). */
  private mergedEntries(kind: StoreKind): readonly StoreEntry[] {
    const byId = new Map(demoEntries(kind).map((entry) => [entry.id, entry]))
    for (const entry of this.remoteCatalog?.byKind[kind] ?? []) byId.set(entry.id, entry)
    return [...byId.values()]
  }

  /** List catalog entries of one kind from the merged offline catalog. */
  async list(kind: StoreKind, query: StoreListQuery = {}): Promise<StoreListResult> {
    await this.ensureCatalog()
    const search = query.search?.trim().toLowerCase() ?? ''
    let rows = this.mergedEntries(kind)
    if (query.category !== undefined && query.category !== '') {
      rows = rows.filter((entry) => entry.category === query.category)
    }
    if (search !== '') {
      rows = rows.filter((entry) => `${entry.id} ${entry.name} ${entry.description}`.toLowerCase().includes(search))
    }
    const page = Math.max(1, query.page ?? 1)
    const pageCount = Math.max(1, Math.ceil(rows.length / CATALOG_PAGE_SIZE))
    const snapshot = this.remoteCatalog
    return {
      entries: rows.slice((page - 1) * CATALOG_PAGE_SIZE, page * CATALOG_PAGE_SIZE),
      total: rows.length,
      page,
      pageCount,
      ...(snapshot === undefined ? { source: 'demo' as const } : { fetchedAt: snapshot.fetchedAt })
    }
  }

  /** Fetch one entry detail from the merged catalog; falls back to a direct remote lookup. */
  async entry(kind: StoreKind, id: string): Promise<StoreEntry> {
    await this.ensureCatalog()
    const found = this.mergedEntries(kind).find((entry) => entry.id === id)
    if (found !== undefined) return found
    if (this.client.entry !== undefined) return this.client.entry(kind, id)
    throw new Error(`No catalog entry for ${kind}/${id}`)
  }

  /** List non-empty categories for one kind from the last refresh or bundled catalog. */
  async categories(kind: StoreKind): Promise<StoreCategory[]> {
    await this.ensureCatalog()
    const source = this.remoteCatalog !== undefined ? this.remoteCatalog.categories : demoCategories()
    const present = new Set(this.mergedEntries(kind).map((entry) => entry.category))
    const bundled = new Map(demoCategories().map((row) => [row.id, row]))
    const byId = new Map(source.map((row) => {
      const known = bundled.get(row.id)
      return [row.id, known === undefined ? row : { ...row, name: known.name }] as const
    }))
    for (const id of present) {
      if (!byId.has(id)) byId.set(id, bundled.get(id) ?? { id, name: id })
    }
    return [...byId.values()].filter((row) => present.has(row.id))
  }

  /** Fetch every page for one kind so the offline snapshot can paginate locally. */
  private async fetchAllRemoteEntries(kind: StoreKind): Promise<readonly StoreEntry[]> {
    const first = await this.client.list(kind, {}, { force: true })
    const remaining = await Promise.all(
      Array.from({ length: Math.max(0, first.pageCount - 1) }, (_, index) =>
        this.client.list(kind, { page: index + 2 }, { force: true }))
    )
    return [first.entries, ...remaining.map((page) => page.entries)].flat()
  }

  /**
   * Explicitly refresh one catalog kind from the remote source, persist the
   * snapshot, and start serving it. Other kinds stay at their previous
   * snapshot values. A failure leaves the previous catalog and cache untouched.
   */
  async refresh(kind: StoreKind): Promise<StoreRefreshResult> {
    await this.ensureCatalog()
    const [entries, categories] = await Promise.all([
      this.fetchAllRemoteEntries(kind),
      this.client.categories({ force: true })
    ])
    const byKind: Record<StoreKind, readonly StoreEntry[]> = {
      skill: this.remoteCatalog?.byKind.skill ?? [],
      preset: this.remoteCatalog?.byKind.preset ?? [],
      mcp: this.remoteCatalog?.byKind.mcp ?? []
    }
    byKind[kind] = entries
    const catalog: CachedCatalog = {
      fetchedAt: new Date().toISOString(),
      categories,
      byKind
    }
    if (this.catalogCachePath !== undefined) await writeCatalogCache(this.catalogCachePath, catalog)
    this.remoteCatalog = catalog
    return {
      fetchedAt: catalog.fetchedAt,
      counts: {
        skill: catalog.byKind.skill.length,
        preset: catalog.byKind.preset.length,
        mcp: catalog.byKind.mcp.length,
      }
    }
  }

  /** Installed entries. */
  async listInstalled(): Promise<InstalledListResult> {
    return { records: await this.ensureRegistry().list() }
  }

  /**
   * Resolve an entry by its id across all kinds.
   * @param id - the entry id.
   * @returns the kind + entry, or `undefined` when not found.
   * @throws when the id is ambiguous (matches more than one kind).
   */
  async resolveEntryById(id: string): Promise<{ kind: StoreKind; entry: StoreEntry } | undefined> {
    await this.ensureCatalog()
    const matches: { kind: StoreKind; entry: StoreEntry }[] = []
    for (const kind of STORE_KINDS) {
      const found = this.mergedEntries(kind).find((entry) => entry.id === id)
      if (found !== undefined) {
        matches.push({ kind, entry: found })
        continue
      }
      try {
        const remote = await this.entry(kind, id)
        if (remote.id === id) matches.push({ kind, entry: remote })
      } catch {
        // Not found in this kind.
      }
    }
    if (matches.length === 0) return undefined
    if (matches.length > 1) {
      throw new Error(`Plugin id "${id}" is ambiguous across kinds: ${matches.map((m) => m.kind).join(', ')}`)
    }
    return matches[0]
  }

  /** Start a normal install, stopping when the audit returns a blocking verdict. */
  async install(kind: StoreKind, id: string): Promise<InstallState> {
    return this.installEntry(kind, id, false)
  }

  /** Install once despite a blocking audit verdict, at the user's explicit request. */
  async installAnyway(kind: StoreKind, id: string): Promise<InstallState> {
    return this.installEntry(kind, id, true)
  }

  /**
   * Fetch, download, and audit an entry. Normal installs park at `confirm-wait`;
   * the explicit override proceeds directly to installation after the same audit.
   */
  private async installEntry(kind: StoreKind, id: string, allowAuditBlock: boolean): Promise<InstallState> {
    const key = `${kind}:${id}`
    if (this.inFlight.has(key)) {
      throw new Error(`An install for ${key} is already in progress`)
    }
    if (this.dshHome === undefined || this.registryPath === undefined) {
      throw new Error('Store install is not available in this build')
    }
    this.inFlight.add(key)
    try {
      const registry = this.ensureRegistry()
      if (await registry.find(kind, id)) {
        return this.finish({ kind, id, phase: 'failed', failureReason: 'conflict', message: `${id} is already installed` })
      }
      this.publish({ kind, id, phase: 'downloading', message: 'Fetching entry…' })
      let entry: StoreEntry
      try {
        entry = await this.entry(kind, id)
      } catch (error) {
        const message = describe(error)
        this.reportInstallError(kind, id, 'fetch_entry_failed', message, { stage: 'entry' })
        return this.finish({ kind, id, phase: 'failed', failureReason: 'download', message })
      }

      let bundle: DownloadedBundle | undefined
      let audit: AuditReport
      if (kind === 'mcp') {
        this.publish({ kind, id, phase: 'auditing', message: 'Auditing MCP wiring…' })
        audit = auditMcpConfig(requireMcp(entry))
      } else if (entry.plugin !== undefined) {
        this.publish({ kind, id, phase: 'auditing', message: 'Auditing DSH plugin source…' })
        audit = auditPluginSource(entry)
      } else {
        try {
          bundle = await downloadBundle(entry.files ?? [], { fetchImpl: this.fetchImpl })
        } catch (error) {
          const reason = error instanceof DownloadError && /checksum/i.test(error.message) ? 'checksum' : 'download'
          const errorCode = classifyDownloadError(error)
          const message = describe(error)
          this.reportInstallError(kind, id, errorCode, message, { stage: 'download', failureReason: reason })
          return this.finish({ kind, id, phase: 'failed', failureReason: reason, message })
        }
        this.publish({ kind, id, phase: 'auditing', message: 'Auditing bundle…' })
        audit = auditBundle(entry, bundle)
      }

      if (audit.verdict === 'block') {
        this.reportInstallError(kind, id, 'audit_blocked', 'The audit blocked this entry', {
          stage: 'audit',
          findings: audit.findings.map(({ severity, rule, file }) => ({ severity, rule, ...(file === undefined ? {} : { file }) }))
        })
      }
      if (audit.verdict === 'block' && !allowAuditBlock) {
        return this.finish({ kind, id, phase: 'failed', failureReason: 'audit-blocked', audit, message: 'The audit blocked this entry' })
      }
      if (allowAuditBlock && audit.verdict === 'block') return this.runInstall(entry, audit, bundle)
      this.pending.set(key, { entry, audit, bundle })
      const state: InstallState = { kind, id, phase: 'confirm-wait', audit }
      this.publish(state)
      return state
    } finally {
      this.inFlight.delete(key)
    }
  }

  /**
   * Answer a parked `confirm-wait` install.
   * @param kind - the entry kind.
   * @param id - the entry id.
   * @param accepted - whether the user accepted the audit report.
   * @returns the `done` state after installing, or `failed` when declined.
   */
  async confirmInstall(kind: StoreKind, id: string, accepted: boolean): Promise<InstallState> {
    const key = `${kind}:${id}`
    const parked = this.pending.get(key)
    if (parked === undefined) {
      throw new Error(`There is no pending install for ${key}`)
    }
    this.pending.delete(key)
    if (!accepted) {
      return this.finish({ kind, id, phase: 'failed', failureReason: 'user-cancelled', audit: parked.audit, message: 'Cancelled' })
    }
    return this.runInstall(parked.entry, parked.audit, parked.bundle)
  }

  /**
   * Uninstall an installed entry.
   * @param kind - the entry kind.
   * @param id - the entry id.
   * @returns the `done` state after removal, or `failed`.
   */
  async uninstall(kind: StoreKind, id: string): Promise<InstallState> {
    if (this.dshHome === undefined || this.registryPath === undefined) {
      throw new Error('Store uninstall is not available in this build')
    }
    const registry = this.ensureRegistry()
    const record = await registry.find(kind, id)
    if (record === undefined) {
      return this.finish({ kind, id, phase: 'failed', failureReason: 'conflict', message: `${id} is not installed` })
    }
    this.publish({ kind, id, phase: 'installing', message: 'Removing…' })
    let pluginUninstall: { runtimeRestartRequired?: boolean } | void = undefined
    let recoveryTransactionId: string | undefined
    try {
      if (kind === 'skill' && record.pluginPackageName !== undefined) {
        if (this.pluginInstaller === undefined) throw new Error('DSH plugin installer is not available in this build')
        let entry: StoreEntry | undefined
        try {
          entry = await this.entry(kind, id)
        } catch {
          // The registry keeps the package name so uninstall remains possible offline.
        }
        if (this.pluginRecovery === undefined) {
          pluginUninstall = await this.pluginInstaller.uninstall(record, entry)
        } else {
          const outcome = await this.pluginRecovery.run(
            pluginChangeInput(entry, 'uninstall', record),
            () => this.pluginInstaller?.uninstall(record, entry) ?? Promise.reject(new Error('DSH plugin installer is not available in this build')),
            async () => { await registry.remove(kind, id) },
          )
          pluginUninstall = outcome.value
          recoveryTransactionId = outcome.transactionId
        }
      } else if (kind === 'skill') await uninstallSkill(this.dshHome, id)
      else if (kind === 'preset') await uninstallPreset(this.dshHome, id)
      else await uninstallMcpEntry(webProfilePatchFile(this.dshHome), id)
      if (recoveryTransactionId === undefined) await registry.remove(kind, id)
    } catch (error) {
      return this.finish({ kind, id, phase: 'failed', failureReason: 'install', message: describe(error) })
    }
    return this.finish({
      kind,
      id,
      phase: 'done',
      ...(recoveryTransactionId === undefined ? {} : { recoveryTransactionId }),
      ...(pluginUninstall?.runtimeRestartRequired === true ? { runtimeRestartRequired: true } : {})
    })
  }

  /** Emit an install state event to renderer windows. */
  publish(state: InstallState): void {
    this.emit(state)
  }

  private async runInstall(entry: StoreEntry, audit: AuditReport, bundle: DownloadedBundle | undefined): Promise<InstallState> {
    const { kind, id } = entry
    this.publish({ kind, id, phase: 'installing', message: 'Installing…' })
    let pluginInstall: { packageName: string; profile: string; runtimeRestartRequired?: boolean } | undefined
    let recoveryTransactionId: string | undefined
    try {
      const registry = this.ensureRegistry()
      if (this.dshHome === undefined) throw new Error('DSH home is not configured')
      if (kind === 'skill' && entry.plugin !== undefined) {
        if (this.pluginInstaller === undefined) throw new Error('DSH plugin installer is not available in this build')
        if (this.pluginRecovery === undefined) {
          pluginInstall = await this.pluginInstaller.install(entry)
        } else {
          const outcome = await this.pluginRecovery.run(
            pluginChangeInput(entry, 'install'),
            () => this.pluginInstaller?.install(entry) ?? Promise.reject(new Error('DSH plugin installer is not available in this build')),
            async (result) => registry.upsert(installedRecord(entry, bundle, result)),
          )
          pluginInstall = outcome.value
          recoveryTransactionId = outcome.transactionId
        }
      } else if (kind === 'skill') await installSkillBundle(this.dshHome, entry, bundle ?? [])
      else if (kind === 'preset') await installPresetBundle(this.dshHome, entry, bundle ?? [])
      else await installMcpEntry(webProfilePatchFile(this.dshHome), requireMcp(entry))
      if (recoveryTransactionId === undefined) await registry.upsert(installedRecord(entry, bundle, pluginInstall))
    } catch (error) {
      const reason =
        error instanceof SkillConflictError ||
        error instanceof PresetConflictError
          ? 'conflict'
          : 'install'
      if (reason !== 'conflict') {
        this.reportInstallError(entry.kind, entry.id, 'write_failed', describe(error), { stage: 'install', failureReason: reason })
      }
      return this.finish({ kind, id, phase: 'failed', failureReason: reason, audit, message: describe(error) })
    }
    return this.finish({
      kind,
      id,
      phase: 'done',
      audit,
      ...(recoveryTransactionId === undefined ? {} : { recoveryTransactionId }),
      ...(pluginInstall?.runtimeRestartRequired === true ? { runtimeRestartRequired: true } : {})
    })
  }

  private finish(state: InstallState): InstallState {
    this.publish(state)
    return state
  }

  private reportInstallError(kind: StoreKind, entryId: string, errorCode: string, errorMessage: string, detail?: Readonly<Record<string, unknown>>): void {
    const report: InstallErrorReport = { kind, entryId, errorCode, errorMessage, ...(detail === undefined ? {} : { detail }) }
    try {
      void Promise.resolve(this.installErrorReporter.report(report)).catch(() => {})
    } catch {
      // Reporting must never affect the install result.
    }
  }

  private ensureRegistry(): InstallRegistry {
    if (this.registry === undefined) {
      if (this.registryPath === undefined) throw new Error('Install registry path is not configured')
      this.registry = new InstallRegistry(this.registryPath)
    }
    return this.registry
  }
}

function requireMcp(entry: StoreEntry): StoreMcpConfig {
  if (entry.mcp === undefined) throw new Error(`Entry ${entry.id} declares no MCP config`)
  return entry.mcp
}

function pluginChangeInput(entry: StoreEntry | undefined, action: 'install' | 'update' | 'uninstall', record?: InstalledRecord): PreparePluginChangeInput {
  const plugin = entry?.plugin
  const packageName = record?.pluginPackageName ?? plugin?.packageName ?? plugin?.source
  const entryId = entry?.id ?? record?.id
  if (packageName === undefined) throw new Error(`Cannot determine the package name for DSH plugin ${entry?.id ?? record?.id ?? 'unknown'}`)
  if (entryId === undefined) throw new Error('Cannot determine the Store entry id for DSH plugin recovery')
  return {
    action,
    entryId,
    packageName,
    profile: record?.pluginProfile ?? plugin?.profile ?? 'web',
  }
}

function installedRecord(
  entry: StoreEntry,
  bundle: DownloadedBundle | undefined,
  pluginInstall: { packageName: string; profile: string } | undefined,
): InstalledRecord {
  return {
    kind: entry.kind,
    id: entry.id,
    version: entry.version,
    sha256: bundleSha256(entry, bundle),
    installedAt: new Date().toISOString(),
    name: entry.name,
    ...(pluginInstall === undefined ? {} : {
      pluginPackageName: pluginInstall.packageName,
      pluginProfile: pluginInstall.profile,
    }),
  }
}

/** Digest stamped into the install registry: concatenated file digests, or the config JSON for MCP. */
function bundleSha256(entry: StoreEntry, bundle: DownloadedBundle | undefined): string {
  if (bundle === undefined) {
    return createHash('sha256').update(JSON.stringify(entry.plugin ?? entry.mcp ?? {})).digest('hex')
  }
  return createHash('sha256')
    .update(bundle.files.map((file) => `${file.path}:${sha256Of(file.bytes)}`).join('\n'))
    .digest('hex')
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyDownloadError(error: unknown): 'checksum_mismatch' | 'timeout' | 'download_failed' {
  const message = describe(error)
  if (/checksum/i.test(message)) return 'checksum_mismatch'
  if (error instanceof Error && (error.name === 'AbortError' || /abort|timeout/i.test(message))) return 'timeout'
  return 'download_failed'
}
