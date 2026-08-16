/**
 * Facade over the store subsystem for the IPC layer. Catalog calls delegate
 * to the remote client; installs run the pipeline
 * download → audit → confirm-wait → install → registry, publishing every
 * phase transition to renderer windows. One in-flight install per kind+id;
 * `block` verdicts abort before anything touches the DSH home.
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
  StoreKind,
  StoreListResult,
  StoreMcpConfig
} from '../../shared/store.js'
import { auditBundle, auditMcpConfig } from './audit.js'
import { StoreClient, type StoreListQuery } from './store-client.js'
import { downloadBundle, DownloadError, type DownloadedBundle } from './downloader.js'
import { InstallRegistry } from './install-registry.js'
import { webProfilePatchFile } from './install-paths.js'
import { installSkillBundle, SkillConflictError, uninstallSkill } from './skill-installer.js'
import { installPresetBundle, PresetConflictError, uninstallPreset } from './preset-installer.js'
import { installMcpEntry, uninstallMcpEntry } from './mcp-installer.js'

export interface StoreServiceOptions {
  client?: Pick<StoreClient, 'list' | 'entry' | 'categories'>
  /** DSH home directory; required for installs. */
  dshHome?: string
  /** Installation registry file path; defaults alongside the DSH home when omitted. */
  registryPath?: string
  fetchImpl?: typeof fetch
  /** Sink for install progress events forwarded to renderer windows. */
  onStateChange?: (state: InstallState) => void
}

/** One install parked at `confirm-wait` between `install()` and `confirmInstall()`. */
interface PendingInstall {
  readonly entry: StoreEntry
  readonly audit: AuditReport
  readonly bundle?: DownloadedBundle
}

/** Store facade owning catalog access and the install pipeline. */
export class StoreService {
  private readonly client: Pick<StoreClient, 'list' | 'entry' | 'categories'>
  private readonly dshHome: string | undefined
  private readonly registryPath: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly emit: (state: InstallState) => void
  private readonly pending = new Map<string, PendingInstall>()
  private readonly inFlight = new Set<string>()
  private registry: InstallRegistry | undefined

  constructor(options: StoreServiceOptions = {}) {
    this.client = options.client ?? new StoreClient()
    this.dshHome = options.dshHome
    this.registryPath = options.registryPath
    this.fetchImpl = options.fetchImpl ?? fetch
    this.emit = options.onStateChange ?? (() => undefined)
  }

  /** List catalog entries of one kind. */
  list(kind: StoreKind, query: StoreListQuery = {}): Promise<StoreListResult> {
    return this.client.list(kind, query)
  }

  /** Fetch one entry detail. */
  entry(kind: StoreKind, id: string): Promise<StoreEntry> {
    return this.client.entry(kind, id)
  }

  /** List categories. */
  categories(): Promise<StoreCategory[]> {
    return this.client.categories()
  }

  /** Installed entries. */
  async listInstalled(): Promise<InstalledListResult> {
    if (this.registry === undefined) throw new Error('Installed list is not available in this build')
    return { records: await this.registry.list() }
  }

  /**
   * Start an install: fetch, download, and audit the entry, then park at
   * `confirm-wait` for the user's decision on the audit report.
   * @param kind - the entry kind.
   * @param id - the entry id.
   * @returns the `confirm-wait` state with the audit report, or a `failed` state.
   */
  async install(kind: StoreKind, id: string): Promise<InstallState> {
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
        entry = await this.client.entry(kind, id)
      } catch (error) {
        return this.finish({ kind, id, phase: 'failed', failureReason: 'download', message: describe(error) })
      }

      let bundle: DownloadedBundle | undefined
      let audit: AuditReport
      if (kind === 'mcp') {
        this.publish({ kind, id, phase: 'auditing', message: 'Auditing MCP wiring…' })
        audit = auditMcpConfig(requireMcp(entry))
      } else {
        try {
          bundle = await downloadBundle(entry.files ?? [], { fetchImpl: this.fetchImpl })
        } catch (error) {
          const reason = error instanceof DownloadError && /checksum/i.test(error.message) ? 'checksum' : 'download'
          return this.finish({ kind, id, phase: 'failed', failureReason: reason, message: describe(error) })
        }
        this.publish({ kind, id, phase: 'auditing', message: 'Auditing bundle…' })
        audit = auditBundle(entry, bundle)
      }

      if (audit.verdict === 'block') {
        return this.finish({ kind, id, phase: 'failed', failureReason: 'audit-blocked', audit, message: 'The audit blocked this entry' })
      }
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
    try {
      if (kind === 'skill') await uninstallSkill(this.dshHome, id)
      else if (kind === 'preset') await uninstallPreset(this.dshHome, id)
      else await uninstallMcpEntry(webProfilePatchFile(this.dshHome), id)
      await registry.remove(kind, id)
    } catch (error) {
      return this.finish({ kind, id, phase: 'failed', failureReason: 'install', message: describe(error) })
    }
    return this.finish({ kind, id, phase: 'done' })
  }

  /** Emit an install state event to renderer windows. */
  publish(state: InstallState): void {
    this.emit(state)
  }

  private async runInstall(entry: StoreEntry, audit: AuditReport, bundle: DownloadedBundle | undefined): Promise<InstallState> {
    const { kind, id } = entry
    this.publish({ kind, id, phase: 'installing', message: 'Installing…' })
    try {
      const registry = this.ensureRegistry()
      if (this.dshHome === undefined) throw new Error('DSH home is not configured')
      if (kind === 'skill') await installSkillBundle(this.dshHome, entry, bundle ?? [])
      else if (kind === 'preset') await installPresetBundle(this.dshHome, entry, bundle ?? [])
      else await installMcpEntry(webProfilePatchFile(this.dshHome), requireMcp(entry))
      await registry.upsert({
        kind,
        id,
        version: entry.version,
        sha256: bundleSha256(entry, bundle),
        installedAt: new Date().toISOString(),
        name: entry.name
      })
    } catch (error) {
      const reason = error instanceof SkillConflictError || error instanceof PresetConflictError ? 'conflict' : 'install'
      return this.finish({ kind, id, phase: 'failed', failureReason: reason, audit, message: describe(error) })
    }
    return this.finish({ kind, id, phase: 'done', audit })
  }

  private finish(state: InstallState): InstallState {
    this.publish(state)
    return state
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

/** Digest stamped into the install registry: concatenated file digests, or the config JSON for MCP. */
function bundleSha256(entry: StoreEntry, bundle: DownloadedBundle | undefined): string {
  if (bundle === undefined) return createHash('sha256').update(JSON.stringify(entry.mcp ?? {})).digest('hex')
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
