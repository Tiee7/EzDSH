/**
 * Shared types for the EzDSH curated store: catalog entries served by the
 * remote curation API, install state snapshots pushed to the renderer, and the
 * installation records kept on disk. The client treats entries as declarative
 * data — it validates, audits, and installs them but never interprets their
 * content beyond the audit rules.
 *
 * @module store
 */

/** Installable entry kinds. Skills and presets land in DSH-owned directories; MCP entries patch the runtime profile. */
export const STORE_KINDS = ['skill', 'preset', 'mcp'] as const

/** One installable entry kind. */
export type StoreKind = (typeof STORE_KINDS)[number]

/** Return whether `value` is a valid {@link StoreKind}. */
export function isStoreKind(value: unknown): value is StoreKind {
  return (STORE_KINDS as readonly unknown[]).includes(value)
}

/** Server-side curation confidence for an entry; the client always re-audits independently. */
export const AUDIT_LEVELS = ['verified', 'basic', 'unaudited'] as const

/** Server-side audit level. */
export type StoreAuditLevel = (typeof AUDIT_LEVELS)[number]

/** Return whether `value` is a valid {@link StoreAuditLevel}. */
export function isAuditLevel(value: unknown): value is StoreAuditLevel {
  return (AUDIT_LEVELS as readonly unknown[]).includes(value)
}

/** Content classification of one downloadable file, declared by the server and re-checked by the audit engine. */
export type StoreFileKind = 'text' | 'script' | 'binary'

/** One downloadable file of a skill or preset bundle. */
export interface StoreFile {
  /** Path relative to the install root; must stay inside it after normalization. */
  readonly path: string
  /** HTTPS download URL for this file. */
  readonly url: string
  /** Expected SHA-256 hex digest of the file bytes. */
  readonly sha256: string
  /** Declared content kind; `script` and `binary` files receive stricter audit treatment. */
  readonly kind: StoreFileKind
}

/** MCP server wiring declared by an `mcp` entry (mirrors the dsh-mcp-client Config union). */
export interface StoreMcpConfig {
  readonly transport: 'stdio' | 'streamable-http'
  /** Stable tool namespace; becomes `mcp__<serverName>__<tool>`. */
  readonly serverName: string
  /** stdio fields. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  /** streamable-http fields. */
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** DSH profile plugin metadata. Plugin entries are exposed as Skill entries with this field. */
export interface StorePluginConfig {
  /** Package-manager source accepted by `dsh plugin`, e.g. npm:pkg@version or github:owner/repo#ref. */
  readonly source: string
  /** Optional package name used for deterministic uninstall and update bookkeeping. */
  readonly packageName?: string
  /** DSH profile receiving the plugin; defaults to web. */
  readonly profile?: string
}

/** One catalog entry served by the remote curation API. */
export interface StoreEntry {
  /** Stable identifier unique within its kind. */
  readonly id: string
  readonly kind: StoreKind
  readonly name: string
  readonly description: string
  readonly category: string
  readonly auditLevel: StoreAuditLevel
  /** Semver-style version string, compared lexically for update detection. */
  readonly version: string
  /** Optional markdown long-form description shown in the detail view. */
  readonly readme?: string
  /** Files for `skill` and `preset` kinds. */
  readonly files?: readonly StoreFile[]
  /** MCP wiring for the `mcp` kind. */
  readonly mcp?: StoreMcpConfig
  /** DSH plugin wiring for a Skill entry in the `plugin` category. */
  readonly plugin?: StorePluginConfig
}

/** One category row from the curation API. */
export interface StoreCategory {
  readonly id: string
  /** Chinese display label for the category. */
  readonly name: string
}

/** Stable Chinese labels for the bundled catalog categories. */
export const STORE_CATEGORY_LABELS_ZH: Readonly<Record<string, string>> = {
  workflow: '工作流程',
  quality: '代码质量',
  docs: '文档',
  git: 'Git',
  research: '研究',
  coding: '编程',
  analysis: '数据分析',
  tools: '工具',
  plugin: '插件'
}

/** List response from `GET /v1/store`. */
export interface StoreListResult {
  readonly entries: readonly StoreEntry[]
  /** Number of entries matching the query, before paging. */
  readonly total?: number
  readonly page: number
  readonly pageCount: number
  /** Present when the list was served by the bundled demo catalog fallback. */
  readonly source?: 'demo'
  /** ISO timestamp of the last successful remote refresh; present once a refresh has succeeded. */
  readonly fetchedAt?: string
}

/** Outcome of one explicit remote catalog refresh. */
export interface StoreRefreshResult {
  /** ISO timestamp of the fetch. */
  readonly fetchedAt: string
  /** Entry counts per kind in the remote snapshot after the refresh. */
  readonly counts: Readonly<Record<StoreKind, number>>
}

/** Verdict of the client-side static audit. */
export type AuditVerdict = 'pass' | 'warn' | 'block'

/** One audit finding, shown verbatim in the install confirmation view. */
export interface AuditFinding {
  readonly severity: 'warn' | 'block'
  /** Stable rule identifier, e.g. `pipe-to-shell`. */
  readonly rule: string
  readonly file?: string
  readonly detail: string
}

/** Result of auditing one entry's downloaded files. */
export interface AuditReport {
  readonly verdict: AuditVerdict
  readonly findings: readonly AuditFinding[]
  /** External URLs collected from text files, listed for the user. */
  readonly externalUrls: readonly string[]
}

/** Phase of an install attempt, pushed to the renderer as state changes. */
export type InstallPhase =
  | 'downloading'
  | 'auditing'
  | 'confirm-wait'
  | 'installing'
  | 'done'
  | 'failed'

/** Why an install attempt ended in `failed` or was aborted. */
export type InstallFailureReason =
  | 'download'
  | 'checksum'
  | 'audit-blocked'
  | 'user-cancelled'
  | 'install'
  | 'conflict'

/** State snapshot of one install/uninstall operation. */
export interface InstallState {
  /** Entry kind + id the operation addresses. */
  readonly kind: StoreKind
  readonly id: string
  readonly phase: InstallPhase
  /** Human-readable progress/error text for the current phase. */
  readonly message?: string
  /** A successful DSH plugin mutation needs a user-approved Runtime restart. */
  readonly runtimeRestartRequired?: boolean
  readonly failureReason?: InstallFailureReason
  /** Present during `confirm-wait` and `failed` phases after an audit ran. */
  readonly audit?: AuditReport
}

/** One row of the on-disk installation registry (`state/installed.json`). */
export interface InstalledRecord {
  readonly kind: StoreKind
  readonly id: string
  readonly version: string
  /** Digest of the installed payload, used for integrity and update checks. */
  readonly sha256: string
  readonly installedAt: string
  /** Remote entry name at install time, for display without network access. */
  readonly name: string
  /** Package name recorded for a DSH plugin install. */
  readonly pluginPackageName?: string
  /** Profile recorded for a DSH plugin install. */
  readonly pluginProfile?: string
}

/** Result of listing installed entries. */
export interface InstalledListResult {
  readonly records: readonly InstalledRecord[]
}

/** Remote curation API base URL; HTTPS-only, enforced by the store client. */
export const STORE_API_BASE_URL = 'https://hub.ezdsh.com'
