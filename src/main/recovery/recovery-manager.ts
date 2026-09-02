import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'
import type { PluginCompatibilityAssessment, PluginCompatibilityRequirements } from '../../shared/store.js'

export const RECOVERY_FORMAT_VERSION = 1
export const CURRENT_DATA_SCHEMA_VERSION = 1
type RecoveryComponent = 'harness' | 'state' | 'workflow'

export type RecoverySnapshotKind = 'manual' | 'pre-update' | 'pre-plugin-change' | 'pre-restore'

export interface RecoveryManifest {
  formatVersion: typeof RECOVERY_FORMAT_VERSION
  kind: RecoverySnapshotKind
  reason: string
  createdAt: string
  appVersion: string
  dshRuntimeVersion: string
  dataSchemaVersion: number
  archiveName: string
  sha256: string
  components: readonly RecoveryComponent[]
  redactedFiles: readonly string[]
  pluginInventory: readonly string[]
  /** Managed DSH plugin evidence captured for compatibility-aware recovery. */
  compatibilityInventory?: readonly RecoveryCompatibilityInventoryItem[]
}

export interface RecoveryCompatibilityInventoryItem {
  entryId: string
  packageName: string
  source?: string
  requirements?: PluginCompatibilityRequirements
  assessment?: PluginCompatibilityAssessment
}

export interface RecoverySnapshot {
  archiveName: string
  archivePath: string
  checksumPath: string
  manifestPath: string
  manifest: RecoveryManifest
}

export interface RecoveryVerifyResult {
  ok: boolean
  snapshotName: string
  expectedSha256: string
  actualSha256?: string
  note?: string
}

export interface RecoveryDryRun {
  dryRun: true
  snapshotName: string
  entries: readonly string[]
  redactedFiles: readonly string[]
  missingCredentials: readonly string[]
  preflight: readonly string[]
}

export interface RecoveryRestoreResult {
  dryRun: false
  snapshotName: string
  restoredAt: string
  preRestoreSnapshotName: string
  missingCredentials: readonly string[]
  entries: readonly string[]
}

export type RecoveryDoctorIssueKind =
  | 'empty-log'
  | 'invalid-header'
  | 'invalid-record'
  | 'incomplete-final-record'
  | 'invalid-compressed-log'
  | 'unsupported-backend'

export interface RecoveryDoctorIssue {
  path: string
  kind: RecoveryDoctorIssueKind
  severity: 'warning' | 'error'
  line?: number
  message: string
  repaired?: boolean
}

export interface RecoveryDoctorResult {
  scannedFiles: number
  healthyFiles: number
  repairedFiles: readonly string[]
  issues: readonly RecoveryDoctorIssue[]
}

export type PluginChangeAction = 'install' | 'update' | 'uninstall'

export interface AffectedPlugin {
  action: PluginChangeAction
  entryId: string
  packageName: string
  profile: string
}

export interface RecoveryTransaction {
  id: string
  kind: 'update' | 'plugin-change'
  phase: 'prepared' | 'failed'
  snapshotName: string
  fromAppVersion: string
  targetAppVersion?: string
  targetDshRuntimeVersion?: string
  preparedAt: string
  affectedPlugin?: AffectedPlugin
  error?: string
}

/** @deprecated Use RecoveryTransaction; retained for updater compatibility. */
export interface PendingUpdate extends RecoveryTransaction {
  kind: 'update'
}

export interface PreparePluginChangeInput extends AffectedPlugin {}

export type RecoveryPhase = 'idle' | 'pending-update' | 'pending-plugin-change' | 'recovery-required' | 'restoring'

export interface RecoveryState {
  phase: RecoveryPhase
  pendingTransaction?: RecoveryTransaction
  /** @deprecated Use pendingTransaction. It is populated only for update transactions. */
  pendingUpdate?: PendingUpdate
  lastError?: string
}

export interface RecoveryCommandOptions {
  cwd: string
}

export interface RecoveryCommandResult {
  stdout: string
  stderr: string
}

export type RecoveryCommandRunner = (
  command: string,
  args: readonly string[],
  options: RecoveryCommandOptions,
) => Promise<RecoveryCommandResult>

export interface RecoveryManagerOptions {
  layout: UserDataLayout
  appVersion: string
  dshRuntimeVersion: string
  dataSchemaVersion?: number
  now?: () => Date
  tarCommand?: string
  runCommand?: RecoveryCommandRunner
  sensitivePaths?: readonly string[]
  maxSnapshots?: number
  rescueScriptPath?: string
  pluginInventory?: () => Promise<readonly string[]>
  compatibilityInventory?: () => Promise<readonly RecoveryCompatibilityInventoryItem[]>
}

export interface CreateSnapshotInput {
  kind: RecoverySnapshotKind
  reason: string
  pluginInventory?: readonly string[]
  compatibilityInventory?: readonly RecoveryCompatibilityInventoryItem[]
}

export interface PrepareUpdateInput {
  targetAppVersion?: string
  targetDshRuntimeVersion?: string
}

type RecoveryListener = (state: RecoveryState) => void

const SNAPSHOT_PATTERN = /^ezdsh-(manual|pre-update|pre-plugin-change|pre-restore)-[^/]+\.tar\.gz$/u
const LEGACY_COMPONENTS = ['harness', 'state'] as const
const COMPONENTS = ['harness', 'state', 'workflow'] as const
const DEFAULT_SENSITIVE_PATHS = [
  'harness/.credentials.yaml',
  'harness/.env',
  'harness/qq-bridge/config.json',
  'state/.workflow-credentials.json',
  'state/.workflow-credentials.json.key',
] as const
const UPDATE_TRANSACTION_FILE = '.ezdsh-update-transaction.json'

/**
 * Native data-safety coordinator. It deliberately owns only user data and
 * recovery metadata; application binaries remain the updater's responsibility.
 */
export class RecoveryManager {
  private readonly options: Required<Pick<RecoveryManagerOptions, 'dataSchemaVersion' | 'now' | 'tarCommand' | 'maxSnapshots'>>
  private readonly runCommand: RecoveryCommandRunner
  private readonly sensitivePaths: readonly string[]
  private readonly listeners = new Set<RecoveryListener>()
  private current: RecoveryState = { phase: 'idle' }

  constructor(private readonly config: RecoveryManagerOptions) {
    this.options = {
      dataSchemaVersion: config.dataSchemaVersion ?? CURRENT_DATA_SCHEMA_VERSION,
      now: config.now ?? (() => new Date()),
      tarCommand: config.tarCommand ?? 'tar',
      maxSnapshots: config.maxSnapshots ?? 7,
    }
    this.runCommand = config.runCommand ?? runSystemCommand
    this.sensitivePaths = [...(config.sensitivePaths ?? DEFAULT_SENSITIVE_PATHS)].map(normalizeRelativePath)
  }

  snapshot(): RecoveryState {
    return cloneRecoveryState(this.current)
  }

  onChange(listener: RecoveryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<RecoveryState> {
    await mkdir(this.config.layout.backups, { recursive: true, mode: 0o700 })
    await this.writeRescueAssets()
    const pending = await this.readPendingTransaction()
    if (pending === undefined) {
      this.publish({ phase: 'idle' })
    } else {
      this.publish(stateForPendingTransaction(pending))
    }
    return this.snapshot()
  }

  async createSnapshot(input: CreateSnapshotInput): Promise<RecoverySnapshot> {
    await mkdir(this.config.layout.backups, { recursive: true, mode: 0o700 })
    const createdAt = this.options.now().toISOString()
    const archiveName = `ezdsh-${input.kind}-${formatTimestamp(createdAt)}-${randomUUID().slice(0, 8)}.tar.gz`
    const archivePath = join(this.config.layout.backups, archiveName)
    const checksumPath = `${archivePath}.sha256`
    const manifestPath = `${archivePath}.manifest.json`
    const vaultRoot = join(this.config.layout.backups, 'vault', archiveName)
    const redactedFiles = await this.saveCredentialVault(vaultRoot)
    const excludes = redactedFiles.map((path) => `--exclude=${path}`)

    try {
      await this.runCommand(
        this.options.tarCommand,
        ['-czf', archivePath, ...excludes, '-C', this.config.layout.root, ...COMPONENTS],
        { cwd: this.config.layout.root },
      )
      const sha256 = await sha256File(archivePath)
      const pluginInventory = input.pluginInventory
        ?? await this.config.pluginInventory?.()
        ?? await readPluginInventory(this.config.layout)
      const compatibilityInventory = input.compatibilityInventory
        ?? await this.config.compatibilityInventory?.()
        ?? await readCompatibilityInventory(this.config.layout)
      const manifest: RecoveryManifest = {
        formatVersion: RECOVERY_FORMAT_VERSION,
        kind: input.kind,
        reason: input.reason,
        createdAt,
        appVersion: this.config.appVersion,
        dshRuntimeVersion: this.config.dshRuntimeVersion,
        dataSchemaVersion: this.options.dataSchemaVersion,
        archiveName,
        sha256,
        components: COMPONENTS,
        redactedFiles,
        pluginInventory: [...pluginInventory],
        compatibilityInventory: compatibilityInventory.map(cloneCompatibilityInventoryItem),
      }
      await writeAtomic(checksumPath, `${sha256}  ${archiveName}\n`, 0o600)
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
      await this.writeRescueAssets()
      await this.rotate(input.kind)
      return { archiveName, archivePath, checksumPath, manifestPath, manifest }
    } catch (error) {
      await Promise.allSettled([
        rm(archivePath, { force: true }),
        rm(checksumPath, { force: true }),
        rm(manifestPath, { force: true }),
        rm(vaultRoot, { recursive: true, force: true }),
      ])
      throw error
    }
  }

  async listSnapshots(): Promise<RecoverySnapshot[]> {
    let names: string[]
    try {
      names = await readdir(this.config.layout.backups)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }

    const snapshots: RecoverySnapshot[] = []
    for (const name of names.filter((candidate) => SNAPSHOT_PATTERN.test(candidate))) {
      try {
        snapshots.push(await this.readSnapshot(name))
      } catch {
        // Ignore incomplete snapshots; verify can only operate on complete sidecars.
      }
    }
    return snapshots.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt))
  }

  async deleteSnapshot(selector: string): Promise<void> {
    const snapshot = await this.resolveSnapshot(selector)
    if (this.current.pendingTransaction?.snapshotName === snapshot.archiveName) {
      throw new Error(`Cannot delete the snapshot required for ${this.current.pendingTransaction.kind} recovery`)
    }

    await Promise.all([
      rm(snapshot.archivePath, { force: true }),
      rm(snapshot.checksumPath, { force: true }),
      rm(snapshot.manifestPath, { force: true }),
      rm(join(this.config.layout.backups, 'vault', snapshot.archiveName), { recursive: true, force: true }),
    ])
  }

  async verify(selector: string): Promise<RecoveryVerifyResult> {
    const snapshot = await this.resolveSnapshot(selector)
    try {
      const actualSha256 = await sha256File(snapshot.archivePath)
      return {
        ok: actualSha256 === snapshot.manifest.sha256,
        snapshotName: snapshot.archiveName,
        expectedSha256: snapshot.manifest.sha256,
        actualSha256,
        ...(actualSha256 === snapshot.manifest.sha256 ? {} : { note: 'checksum mismatch' }),
      }
    } catch (error) {
      return {
        ok: false,
        snapshotName: snapshot.archiveName,
        expectedSha256: snapshot.manifest.sha256,
        note: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async restore(selector: string, dryRun: true): Promise<RecoveryDryRun>
  async restore(selector: string, dryRun: false): Promise<RecoveryRestoreResult>
  async restore(selector: string, dryRun: boolean): Promise<RecoveryDryRun | RecoveryRestoreResult> {
    const snapshot = await this.resolveSnapshot(selector)
    const verification = await this.verify(snapshot.archiveName)
    if (!verification.ok) throw new Error(`checksum verification failed for ${snapshot.archiveName}`)
    const entries = await this.archiveEntries(snapshot)
    const missingCredentials = await this.findMissingCredentials(snapshot.manifest)
    const preflight = buildPreflight(snapshot.manifest, missingCredentials)

    if (dryRun) {
      return {
        dryRun: true,
        snapshotName: snapshot.archiveName,
        entries,
        redactedFiles: snapshot.manifest.redactedFiles,
        missingCredentials,
        preflight,
      }
    }

    this.publish({
      phase: 'restoring',
      ...(this.current.pendingTransaction === undefined ? {} : { pendingTransaction: this.current.pendingTransaction }),
    })
    try {
      const preRestore = await this.createSnapshot({ kind: 'pre-restore', reason: `Before restoring ${snapshot.archiveName}` })
      const staging = join(this.config.layout.backups, `.ezdsh-restore-${randomUUID()}`)
      const aside = join(this.config.layout.root, `.ezdsh-pre-restore-${formatTimestamp(this.options.now().toISOString())}`)
      await mkdir(staging, { recursive: true, mode: 0o700 })
      try {
        await this.runCommand(this.options.tarCommand, ['-xzf', snapshot.archivePath, '-C', staging], { cwd: this.config.layout.backups })
        await validateExtractedTree(staging)
        for (const component of snapshot.manifest.components) {
          if (!(await isDirectory(join(staging, component)))) {
            throw new Error(`archive is missing component ${component}`)
          }
        }

        await mkdir(aside, { recursive: true, mode: 0o700 })
        const touched: string[] = []
        try {
          for (const component of snapshot.manifest.components) {
            const target = join(this.config.layout.root, component)
            const saved = join(aside, component)
            if (await pathExists(target)) await rename(target, saved)
            touched.push(component)
            await rename(join(staging, component), target)
          }
          await restoreCredentials(snapshot.manifest, this.config.layout, this.config.layout.backups)
        } catch (error) {
          for (const component of [...touched].reverse()) {
            const target = join(this.config.layout.root, component)
            const saved = join(aside, component)
            await rm(target, { recursive: true, force: true })
            if (await pathExists(saved)) await rename(saved, target)
          }
          throw error
        }
        await rm(aside, { recursive: true, force: true })
      } finally {
        await rm(staging, { recursive: true, force: true })
      }

      const result: RecoveryRestoreResult = {
        dryRun: false,
        snapshotName: snapshot.archiveName,
        restoredAt: this.options.now().toISOString(),
        preRestoreSnapshotName: preRestore.archiveName,
        missingCredentials,
        entries,
      }
      this.publish({
        phase: this.current.pendingTransaction === undefined ? 'idle' : 'recovery-required',
        ...(this.current.pendingTransaction === undefined ? {} : { pendingTransaction: this.current.pendingTransaction }),
      })
      return result
    } catch (error) {
      this.publish({
        phase: this.current.pendingTransaction === undefined ? 'idle' : 'recovery-required',
        ...(this.current.pendingTransaction === undefined ? {} : { pendingTransaction: this.current.pendingTransaction }),
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async prepareUpdate(input: PrepareUpdateInput = {}): Promise<PendingUpdate> {
    const snapshot = await this.createSnapshot({
      kind: 'pre-update',
      reason: input.targetAppVersion === undefined
        ? 'Before application update'
        : `Before updating to ${input.targetAppVersion}`,
    })
    const pending: PendingUpdate = {
      id: randomUUID(),
      kind: 'update',
      phase: 'prepared',
      snapshotName: snapshot.archiveName,
      fromAppVersion: this.config.appVersion,
      ...(input.targetAppVersion === undefined ? {} : { targetAppVersion: input.targetAppVersion }),
      ...(input.targetDshRuntimeVersion === undefined ? {} : { targetDshRuntimeVersion: input.targetDshRuntimeVersion }),
      preparedAt: this.options.now().toISOString(),
    }
    await this.writePendingTransaction(pending)
    this.publish(stateForPendingTransaction(pending))
    return pending
  }

  async preparePluginChange(input: PreparePluginChangeInput): Promise<RecoveryTransaction> {
    const snapshot = await this.createSnapshot({
      kind: 'pre-plugin-change',
      reason: `Before ${input.action} plugin ${input.packageName} in ${input.profile}`,
    })
    const pending: RecoveryTransaction = {
      id: randomUUID(),
      kind: 'plugin-change',
      phase: 'prepared',
      snapshotName: snapshot.archiveName,
      fromAppVersion: this.config.appVersion,
      preparedAt: this.options.now().toISOString(),
      affectedPlugin: { ...input },
    }
    await this.writePendingTransaction(pending)
    this.publish(stateForPendingTransaction(pending))
    return pending
  }

  async hasPendingTransaction(): Promise<boolean> {
    return this.current.pendingTransaction !== undefined
  }

  async abortPendingTransaction(): Promise<void> {
    if (this.current.pendingTransaction === undefined) return
    await this.clearPendingTransaction()
    this.publish({ phase: 'idle' })
  }

  async markBootFailure(error: string): Promise<RecoveryState> {
    if (this.current.pendingTransaction === undefined) return this.snapshot()
    const pending: RecoveryTransaction = { ...this.current.pendingTransaction, phase: 'failed', error }
    await this.writePendingTransaction(pending)
    this.publish({ phase: 'recovery-required', pendingTransaction: pending, lastError: error })
    return this.snapshot()
  }

  async completePendingTransaction(): Promise<void> {
    if (this.current.pendingTransaction === undefined) return
    await this.clearPendingTransaction()
    this.publish({ phase: 'idle' })
  }

  async completeUpdate(): Promise<void> {
    if (this.current.pendingTransaction?.kind !== 'update') return
    await this.completePendingTransaction()
  }

  async resolveRecovery(): Promise<void> {
    await this.completePendingTransaction()
  }

  /** Inspect persisted sessions without starting DSH; repair is opt-in and tail-only. */
  async doctor(repair = false): Promise<RecoveryDoctorResult> {
    const sessionRoot = join(this.config.layout.harness, 'sessions')
    const files = await collectSessionLogFiles(sessionRoot)
    const issues: RecoveryDoctorIssue[] = []
    const repairedFiles: string[] = []
    let healthyFiles = 0

    for (const file of files) {
      const fileIssues = await inspectSessionLog(file, repair)
      if (fileIssues.length === 0) healthyFiles += 1
      for (const issue of fileIssues) {
        issues.push({ ...issue, path: relative(this.config.layout.root, file).split(sep).join('/') })
        if (issue.repaired === true) repairedFiles.push(relative(this.config.layout.root, file).split(sep).join('/'))
      }
    }

    return { scannedFiles: files.length, healthyFiles, repairedFiles, issues }
  }

  private async readSnapshot(name: string): Promise<RecoverySnapshot> {
    if (!SNAPSHOT_PATTERN.test(name) || basename(name) !== name) throw new Error(`Invalid snapshot name: ${name}`)
    const archivePath = join(this.config.layout.backups, name)
    const checksumPath = `${archivePath}.sha256`
    const manifestPath = `${archivePath}.manifest.json`
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (manifest.archiveName !== name) throw new Error(`Snapshot manifest does not match ${name}`)
    return { archiveName: name, archivePath, checksumPath, manifestPath, manifest }
  }

  private async resolveSnapshot(selector: string): Promise<RecoverySnapshot> {
    if (selector.trim() === '') throw new Error('Snapshot selector cannot be empty')
    const snapshots = await this.listSnapshots()
    const candidates = selector === 'latest'
      ? snapshots.filter((snapshot) => snapshot.manifest.kind !== 'pre-restore')
      : snapshots.filter((snapshot) => snapshot.archiveName === selector || snapshot.archiveName.startsWith(selector))
    if (candidates.length === 0) throw new Error(`Snapshot not found: ${selector}`)
    if (candidates.length > 1) throw new Error(`Snapshot selector is ambiguous: ${selector}`)
    return candidates[0]
  }

  private async archiveEntries(snapshot: RecoverySnapshot): Promise<readonly string[]> {
    const result = await this.runCommand(this.options.tarCommand, ['-tzf', snapshot.archivePath], { cwd: this.config.layout.backups })
    const entries = result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)
    for (const entry of entries) validateArchiveEntry(entry)
    return entries
  }

  private async saveCredentialVault(vaultRoot: string): Promise<string[]> {
    const saved: string[] = []
    for (const relativePath of this.sensitivePaths) {
      const source = safeJoin(this.config.layout.root, relativePath)
      if (!(await isFile(source))) continue
      const destination = safeJoin(vaultRoot, relativePath)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(source, destination)
      await chmod(destination, 0o600).catch(() => undefined)
      saved.push(relativePath)
    }
    if (saved.length > 0) await chmod(vaultRoot, 0o700).catch(() => undefined)
    return saved
  }

  private async findMissingCredentials(manifest: RecoveryManifest): Promise<string[]> {
    const vaultRoot = join(this.config.layout.backups, 'vault', manifest.archiveName)
    const missing: string[] = []
    for (const relativePath of manifest.redactedFiles) {
      if (!(await isFile(safeJoin(vaultRoot, relativePath)))) missing.push(relativePath)
    }
    return missing
  }

  private async writeRescueAssets(): Promise<void> {
    const source = this.config.rescueScriptPath
    if (source === undefined || !(await isFile(source))) return
    const target = join(this.config.layout.backups, 'rescue.mjs')
    await copyFile(source, target)
    await chmod(target, 0o700).catch(() => undefined)
    const nodeCommand = process.execPath
    if (process.platform === 'win32') {
      const launcher = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${nodeCommand.replaceAll('"', '""')}" "%~dp0rescue.mjs" serve\r\n pause\r\n`
      await writeAtomic(join(this.config.layout.backups, 'EzDSH Recovery.bat'), launcher, 0o600)
    } else {
      const launcher = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec '${nodeCommand.replaceAll("'", "'\\''")}' "$(dirname "$0")/rescue.mjs" serve\n`
      const launcherPath = process.platform === 'darwin' ? 'EzDSH Recovery.command' : 'EzDSH Recovery.sh'
      const fullPath = join(this.config.layout.backups, launcherPath)
      await writeAtomic(fullPath, launcher, 0o700)
      await chmod(fullPath, 0o700).catch(() => undefined)
    }
  }

  private async rotate(kind: RecoverySnapshotKind): Promise<void> {
    const snapshots = await this.listSnapshots()
    const keep = kind === 'pre-update' ? 2 : kind === 'pre-restore' ? 1 : this.options.maxSnapshots
    const sameKind = snapshots.filter((snapshot) => snapshot.manifest.kind === kind)
    for (const snapshot of sameKind.slice(keep)) {
      await Promise.all([
        rm(snapshot.archivePath, { force: true }),
        rm(snapshot.checksumPath, { force: true }),
        rm(snapshot.manifestPath, { force: true }),
        rm(join(this.config.layout.backups, 'vault', snapshot.archiveName), { recursive: true, force: true }),
      ])
    }
  }

  private async readPendingTransaction(): Promise<RecoveryTransaction | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.config.layout.root, UPDATE_TRANSACTION_FILE), 'utf8'))
      if (isRecoveryTransaction(value)) return value
      if (isLegacyPendingUpdate(value)) {
        return {
          id: `legacy-${value.snapshotName}`,
          kind: 'update',
          phase: value.phase,
          snapshotName: value.snapshotName,
          fromAppVersion: value.fromAppVersion,
          ...(value.targetAppVersion === undefined ? {} : { targetAppVersion: value.targetAppVersion }),
          ...(value.targetDshRuntimeVersion === undefined ? {} : { targetDshRuntimeVersion: value.targetDshRuntimeVersion }),
          preparedAt: value.preparedAt,
          ...(value.error === undefined ? {} : { error: value.error }),
        }
      }
      return undefined
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      return undefined
    }
  }

  private async writePendingTransaction(pending: RecoveryTransaction): Promise<void> {
    await writeAtomic(join(this.config.layout.root, UPDATE_TRANSACTION_FILE), `${JSON.stringify(pending, null, 2)}\n`, 0o600)
  }

  private async clearPendingTransaction(): Promise<void> {
    await rm(join(this.config.layout.root, UPDATE_TRANSACTION_FILE), { force: true })
  }

  private publish(next: RecoveryState): void {
    this.current = stateWithLegacyUpdate(next)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export function validateArchiveEntry(entry: string): void {
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '')
  const segments = normalized.split('/').filter(Boolean)
  if (
    normalized === ''
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.includes('..')
    || !COMPONENTS.includes(segments[0] as (typeof COMPONENTS)[number])
  ) {
    throw new Error(`Unsafe recovery archive entry: ${entry}`)
  }
}

function parseManifest(value: unknown): RecoveryManifest {
  const components = isRecord(value) && value.components !== undefined ? value.components : LEGACY_COMPONENTS
  if (!isRecord(value)
    || value.formatVersion !== RECOVERY_FORMAT_VERSION
    || !isRecoveryKind(value.kind)
    || typeof value.reason !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.appVersion !== 'string'
    || typeof value.dshRuntimeVersion !== 'string'
    || typeof value.dataSchemaVersion !== 'number'
    || typeof value.archiveName !== 'string'
    || typeof value.sha256 !== 'string'
    || !Array.isArray(value.redactedFiles)
    || !Array.isArray(value.pluginInventory)
    || !isRecoveryComponents(components)
    || !value.redactedFiles.every((item) => typeof item === 'string')
    || !value.pluginInventory.every((item) => typeof item === 'string')
    || (value.compatibilityInventory !== undefined && (!Array.isArray(value.compatibilityInventory) || !value.compatibilityInventory.every(isCompatibilityInventoryItem)))) {
    throw new Error('Invalid recovery manifest')
  }
  return {
    formatVersion: RECOVERY_FORMAT_VERSION,
    kind: value.kind,
    reason: value.reason,
    createdAt: value.createdAt,
    appVersion: value.appVersion,
    dshRuntimeVersion: value.dshRuntimeVersion,
    dataSchemaVersion: value.dataSchemaVersion,
    archiveName: value.archiveName,
    sha256: value.sha256,
    components: [...components],
    redactedFiles: [...value.redactedFiles],
    pluginInventory: [...value.pluginInventory],
    ...(value.compatibilityInventory === undefined ? {} : { compatibilityInventory: value.compatibilityInventory.map(cloneCompatibilityInventoryItem) }),
  }
}

function isRecoveryComponents(value: unknown): value is readonly RecoveryComponent[] {
  return Array.isArray(value)
    && value[0] === 'harness'
    && value[1] === 'state'
    && (value.length === 2 || value.length === 3 && value[2] === 'workflow')
}

function isCompatibilityInventoryItem(value: unknown): value is RecoveryCompatibilityInventoryItem {
  if (!isRecord(value) || typeof value.entryId !== 'string' || typeof value.packageName !== 'string') return false
  if (value.source !== undefined && typeof value.source !== 'string') return false
  if (value.requirements !== undefined && !isCompatibilityRequirements(value.requirements)) return false
  return value.assessment === undefined || isCompatibilityAssessment(value.assessment)
}

function isCompatibilityRequirements(value: unknown): value is PluginCompatibilityRequirements {
  return isRecord(value)
    && (value.minDshVersion === undefined || typeof value.minDshVersion === 'string')
    && (value.maxDshVersion === undefined || typeof value.maxDshVersion === 'string')
}

function isCompatibilityAssessment(value: unknown): value is PluginCompatibilityAssessment {
  return isRecord(value)
    && (value.status === 'compatible' || value.status === 'incompatible' || value.status === 'unknown')
    && typeof value.runtimeVersion === 'string'
    && typeof value.reason === 'string'
}

function cloneCompatibilityInventoryItem(item: RecoveryCompatibilityInventoryItem): RecoveryCompatibilityInventoryItem {
  return {
    entryId: item.entryId,
    packageName: item.packageName,
    ...(item.source === undefined ? {} : { source: item.source }),
    ...(item.requirements === undefined ? {} : { requirements: { ...item.requirements } }),
    ...(item.assessment === undefined ? {} : { assessment: { ...item.assessment } }),
  }
}

function isRecoveryKind(value: unknown): value is RecoverySnapshotKind {
  return value === 'manual' || value === 'pre-update' || value === 'pre-plugin-change' || value === 'pre-restore'
}

function isRecoveryTransaction(value: unknown): value is RecoveryTransaction {
  return isRecord(value)
    && typeof value.id === 'string'
    && (value.kind === 'update' || value.kind === 'plugin-change')
    && (value.phase === 'prepared' || value.phase === 'failed')
    && typeof value.snapshotName === 'string'
    && typeof value.fromAppVersion === 'string'
    && typeof value.preparedAt === 'string'
    && (value.targetAppVersion === undefined || typeof value.targetAppVersion === 'string')
    && (value.targetDshRuntimeVersion === undefined || typeof value.targetDshRuntimeVersion === 'string')
    && (value.affectedPlugin === undefined || isAffectedPlugin(value.affectedPlugin))
    && (value.error === undefined || typeof value.error === 'string')
}

function isAffectedPlugin(value: unknown): value is AffectedPlugin {
  return isRecord(value)
    && (value.action === 'install' || value.action === 'update' || value.action === 'uninstall')
    && typeof value.entryId === 'string'
    && typeof value.packageName === 'string'
    && typeof value.profile === 'string'
}

function isLegacyPendingUpdate(value: unknown): value is Omit<PendingUpdate, 'id' | 'kind'> {
  return isRecord(value)
    && (value.phase === 'prepared' || value.phase === 'failed')
    && typeof value.snapshotName === 'string'
    && typeof value.fromAppVersion === 'string'
    && typeof value.preparedAt === 'string'
    && (value.targetAppVersion === undefined || typeof value.targetAppVersion === 'string')
    && (value.targetDshRuntimeVersion === undefined || typeof value.targetDshRuntimeVersion === 'string')
    && (value.error === undefined || typeof value.error === 'string')
}

function stateForPendingTransaction(transaction: RecoveryTransaction): RecoveryState {
  return {
    phase: transaction.phase === 'failed'
      ? 'recovery-required'
      : transaction.kind === 'update' ? 'pending-update' : 'pending-plugin-change',
    pendingTransaction: transaction,
    ...(transaction.error === undefined ? {} : { lastError: transaction.error }),
  }
}

function stateWithLegacyUpdate(next: RecoveryState): RecoveryState {
  const pendingTransaction = next.pendingTransaction === undefined ? undefined : { ...next.pendingTransaction, ...(next.pendingTransaction.affectedPlugin === undefined ? {} : { affectedPlugin: { ...next.pendingTransaction.affectedPlugin } }) }
  return {
    ...next,
    ...(pendingTransaction === undefined ? {} : { pendingTransaction }),
    ...(pendingTransaction?.kind === 'update' ? { pendingUpdate: pendingTransaction as PendingUpdate } : {}),
  }
}

function cloneRecoveryState(state: RecoveryState): RecoveryState {
  return stateWithLegacyUpdate({
    ...state,
    ...(state.pendingTransaction === undefined ? {} : { pendingTransaction: state.pendingTransaction }),
  })
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (normalized === '' || isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Invalid sensitive path: ${value}`)
  }
  return normalized
}

function safeJoin(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const candidate = resolve(root, normalized)
  const parent = resolve(root)
  if (candidate !== parent && !candidate.startsWith(`${parent}${sep}`)) {
    throw new Error(`Recovery path escapes root: ${relativePath}`)
  }
  return candidate
}

function formatTimestamp(value: string): string {
  return value.replace(/[-:.TZ]/gu, '').slice(0, 17)
}

function buildPreflight(manifest: RecoveryManifest, missingCredentials: readonly string[]): string[] {
  const lines = [
    `Snapshot from EzDSH ${manifest.appVersion} with DSH Runtime ${manifest.dshRuntimeVersion}`,
    `Data schema version ${String(manifest.dataSchemaVersion)}`,
  ]
  if (manifest.redactedFiles.length > 0) {
    lines.push(`Credentials are excluded from the archive: ${String(manifest.redactedFiles.length)} file(s)`)
  }
  if (missingCredentials.length > 0) {
    lines.push(`Credentials requiring re-entry: ${missingCredentials.join(', ')}`)
  }
  return lines
}

async function restoreCredentials(
  manifest: RecoveryManifest,
  layout: UserDataLayout,
  backupsRoot: string,
): Promise<void> {
  const vaultRoot = join(backupsRoot, 'vault', manifest.archiveName)
  for (const relativePath of manifest.redactedFiles) {
    const source = safeJoin(vaultRoot, relativePath)
    if (!(await isFile(source))) continue
    const destination = safeJoin(layout.root, relativePath)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    await chmod(destination, 0o600).catch(() => undefined)
  }
}

async function validateExtractedTree(root: string, archiveRoot = root): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = join(root, entry.name)
    const relativePath = relative(archiveRoot, candidate).split(sep).join('/')
    validateArchiveEntry(relativePath)
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in recovery archives: ${relativePath}`)
    if (entry.isDirectory()) await validateExtractedTree(candidate, archiveRoot)
  }
}

interface ZstdFrameRange {
  start: number
  end: number
}

interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  tornStart?: number
}

/** Scan concatenated Zstandard frames without relying on DSH packages. */
function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  const magic = 0xFD2FB528
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== magic) throw new Error(`invalid Zstandard frame magic at byte ${String(offset)}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`invalid Zstandard frame header at byte ${String(offset - 1)}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const hasChecksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`invalid Zstandard block type at byte ${String(offset - 3)}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (hasChecksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

async function collectSessionLogFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return
      throw error
    }
    for (const entry of entries) {
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(candidate)
      } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd') || entry.name === 'sessions.db')) {
        files.push(candidate)
      }
    }
  }
  await visit(root)
  return files.sort()
}

async function inspectSessionLog(path: string, repair: boolean): Promise<RecoveryDoctorIssue[]> {
  if (path.endsWith('sessions.db')) {
    return [{
      path,
      kind: 'unsupported-backend',
      severity: 'warning',
      message: 'SQLite session logs require the DSH Runtime backend for a full integrity check',
    }]
  }

  const content = await readFile(path)
  if (path.endsWith('.jsonl.zstd')) {
    try {
      const frames = scanZstdFrames(content)
      if (frames.tornStart !== undefined) {
        return [{
          path,
          kind: 'invalid-compressed-log',
          severity: 'warning',
          message: `Session log ends inside a Zstandard frame at byte ${String(frames.tornStart)}`,
        }]
      }
      const plainFrames = frames.frames.map((frame) => zstdDecompressSync(content.subarray(frame.start, frame.end)))
      return inspectJsonlBuffer(path, Buffer.concat(plainFrames), false)
    } catch (error) {
      return [{
        path,
        kind: 'invalid-compressed-log',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      }]
    }
  }
  return inspectJsonlBuffer(path, content, repair)
}

async function inspectJsonlBuffer(path: string, content: Buffer, repair: boolean): Promise<RecoveryDoctorIssue[]> {
  if (content.length === 0) {
    return [{ path, kind: 'empty-log', severity: 'error', message: 'Session log is empty' }]
  }

  const text = content.toString('utf8')
  const hasTrailingNewline = content.at(-1) === 0x0A
  const lines = text.split('\n')
  if (hasTrailingNewline) lines.pop()
  const header = parseJsonRecord(lines[0] ?? '')
  if (header === undefined || header.type !== 'session' || typeof header.version !== 'number' || typeof header.id !== 'string') {
    return [{ path, kind: 'invalid-header', severity: 'error', line: 1, message: 'First JSONL record is not a valid session header' }]
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (parseJsonRecord(line) !== undefined) continue

    const isTornFinalRecord = !hasTrailingNewline && index === lines.length - 1
    if (isTornFinalRecord) {
      const issue: RecoveryDoctorIssue = {
        path,
        kind: 'incomplete-final-record',
        severity: 'warning',
        line: index + 1,
        message: 'The final JSONL record is incomplete; the committed prefix is still readable',
      }
      if (repair) {
        const newlineOffset = content.lastIndexOf(0x0A)
        if (newlineOffset >= 0) {
          await writeAtomicBuffer(path, content.subarray(0, newlineOffset + 1), 0o600)
          issue.repaired = true
        }
      }
      return [issue]
    }

    return [{
      path,
      kind: 'invalid-record',
      severity: 'error',
      line: index + 1,
      message: 'A committed JSONL record cannot be parsed; automatic repair is refused',
    }]
  }
  return []
}

function parseJsonRecord(line: string): Record<string, any> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function readPluginInventory(layout: UserDataLayout): Promise<readonly string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(layout.state, 'installed.json'), 'utf8'))
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!isRecord(item) || typeof item.kind !== 'string' || typeof item.id !== 'string' || typeof item.version !== 'string') return []
      return [`${item.kind}:${item.id}@${item.version}`]
    })
  } catch {
    return []
  }
}

async function readCompatibilityInventory(layout: UserDataLayout): Promise<readonly RecoveryCompatibilityInventoryItem[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(layout.state, 'installed.json'), 'utf8'))
    if (!Array.isArray(value)) return []
    return value.flatMap((item): RecoveryCompatibilityInventoryItem[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || typeof item.pluginPackageName !== 'string') return []
      const candidate: RecoveryCompatibilityInventoryItem = {
        entryId: item.id,
        packageName: item.pluginPackageName,
        ...(typeof item.pluginSource === 'string' ? { source: item.pluginSource } : {}),
        ...(isCompatibilityRequirements(item.pluginCompatibilityRequirements) ? { requirements: item.pluginCompatibilityRequirements } : {}),
        ...(isCompatibilityAssessment(item.pluginCompatibility) ? { assessment: item.pluginCompatibility } : {}),
      }
      return [candidate]
    })
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, content, { mode })
  await rename(tempPath, path)
}

async function writeAtomicBuffer(path: string, content: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, content, { mode })
  await rename(tempPath, path)
}

async function runSystemCommand(
  command: string,
  args: readonly string[],
  options: RecoveryCommandOptions,
): Promise<RecoveryCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveResult({ stdout, stderr })
      } else {
        reject(new Error(`Recovery command failed: ${command} ${args.join(' ')} (code=${String(code)}, signal=${String(signal)}): ${stderr || stdout}`))
      }
    })
  })
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
