/**
 * Install and remove npm/GitHub packages through the DSH profile plugin
 * command. The catalog describes plugin entries as Skills, but their payload
 * is a package-manager source rather than a downloadable Skill bundle.
 *
 * @module dsh-plugin-installer
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { Document, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import type { InstalledRecord, StoreEntry, StorePluginConfig } from '../../shared/store.js'
import { repairInstalledDshPlugin } from './dsh-plugin-compatibility.js'
import { compareDshVersions } from './compatibility.js'

export interface PluginCommandRunner {
  (profile: string, args: readonly string[]): Promise<void>
  /** Fail before any Runtime reload when the packaged command prerequisites are absent. */
  assertAvailable?: () => void
  /** Output and log path from the most recent command, for the command console. */
  lastOutput?: string
  lastLogPath?: string
  runRaw?: (args: readonly string[]) => Promise<{ output: string; logPath?: string }>
}

export interface DshPluginInstallerOptions {
  readonly dshHome: string
  readonly runCommand: PluginCommandRunner
  /** Report whether the active Runtime must be restarted to load the package. */
  readonly isRuntimeActive?: () => boolean
}

export interface DshPluginInstallResult {
  readonly packageName: string
  readonly profile: string
  readonly runtimeRestartRequired: boolean
}

export interface DshPluginUninstallResult {
  readonly runtimeRestartRequired: boolean
}

export interface DshActivePlugin {
  readonly packageName: string
  readonly profile: string
}

export interface DshInstalledPlugin {
  readonly packageName: string
  readonly profile: string
  readonly version: string
  readonly enabled: boolean
}

export interface DshIncompatiblePlugin {
  readonly packageName: string
  readonly reason: string
}

const PROFILE_NAME = /^[a-z][a-z0-9-]*$/
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const NPM_SOURCE = /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^\s/][^\s]*)?$/
const GITHUB_SOURCE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.\/-]+)?$/

/**
 * pnpm 11 blocks lifecycle scripts by default in a DSH profile. These exact
 * package versions are known transitive DSH dependencies whose lifecycle
 * scripts are compatible with the bundled Runtime and should not turn a
 * catalog install into a manual pnpm configuration task.
 *
 * Keep this list exact and versioned: arbitrary third-party install scripts
 * must remain blocked and visible to the user.
 */
const AUTOMATICALLY_ALLOWED_BUILD_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  '@google/genai': ['1.52.0'],
  protobufjs: ['7.6.5']
}

/** Validate and normalize a catalog plugin source before passing it to pnpm. */
export function validatePluginSource(config: StorePluginConfig): void {
  if (!NPM_SOURCE.test(config.source) && !GITHUB_SOURCE.test(config.source)) {
    throw new Error(`Unsupported DSH plugin source: ${config.source}`)
  }
  if (config.packageName !== undefined && !PACKAGE_NAME.test(config.packageName)) {
    throw new Error(`Invalid DSH plugin package name: ${config.packageName}`)
  }
  if (config.profile !== undefined && !PROFILE_NAME.test(config.profile)) {
    throw new Error(`Invalid DSH plugin profile: ${config.profile}`)
  }
}

/** Convert a supported source into a stable external URL shown by the audit. */
export function pluginSourceUrl(source: string): string {
  if (source.startsWith('npm:')) {
    const packageName = packageNameFromSource(source)
    return `https://www.npmjs.com/package/${packageName}`
  }
  const remainder = source.slice('github:'.length)
  const [repository] = remainder.split('#', 1)
  return `https://github.com/${repository}`
}

/** Manage one DSH profile's package dependencies. */
export class DshPluginInstaller {
  constructor(private readonly options: DshPluginInstallerOptions) {}

  async install(entry: StoreEntry): Promise<DshPluginInstallResult> {
    const config = requirePlugin(entry)
    validatePluginSource(config)
    const profile = config.profile ?? 'web'
    this.options.runCommand.assertAvailable?.()
    const before = await readProfileManifest(this.options.dshHome, profile)
    await this.run(profile, ['add', config.source], before, verifiedBuildsFor(config))
    const after = await readProfileManifest(this.options.dshHome, profile)
    const packageName = resolvePackageName(config, before, after)
    if (!hasDependency(after, packageName)) {
      throw new Error(`DSH plugin package ${packageName} was not added to profile ${profile}`)
    }
    await repairInstalledDshPlugin(this.options.dshHome, profile, packageName)
    return {
      packageName,
      profile,
      runtimeRestartRequired: this.options.isRuntimeActive?.() === true
    }
  }

  async uninstall(record: InstalledRecord, entry?: StoreEntry): Promise<DshPluginUninstallResult> {
    const config = entry?.plugin
    if (config !== undefined) validatePluginSource(config)
    const packageName = record.pluginPackageName ?? config?.packageName ?? (config === undefined ? undefined : packageNameFromSourceIfNpm(config.source))
    if (packageName === undefined) {
      throw new Error(`Cannot determine the package name for DSH plugin ${record.id}; reinstall it to repair its registry record`)
    }
    if (!PACKAGE_NAME.test(packageName)) throw new Error(`Invalid recorded DSH plugin package name: ${packageName}`)
    const profile = record.pluginProfile ?? config?.profile ?? 'web'
    if (!PROFILE_NAME.test(profile)) throw new Error(`Invalid recorded DSH plugin profile: ${profile}`)
    this.options.runCommand.assertAvailable?.()
    const before = await readProfileManifest(this.options.dshHome, profile)
    await this.run(profile, ['remove', packageName], before)
    await this.clearDisabledBundle(profile, packageName)
    return { runtimeRestartRequired: this.options.isRuntimeActive?.() === true }
  }

  /** Enable or disable a package layer without changing the installed dependency. */
  async setEnabled(record: InstalledRecord, entry: StoreEntry | undefined, enabled: boolean): Promise<DshPluginUninstallResult> {
    const config = entry?.plugin
    if (config !== undefined) validatePluginSource(config)
    const packageName = record.pluginPackageName ?? config?.packageName ?? (config === undefined ? undefined : packageNameFromSourceIfNpm(config.source))
    if (packageName === undefined) {
      throw new Error(`Cannot determine the package name for DSH plugin ${record.id}; reinstall it to repair its registry record`)
    }
    const profile = record.pluginProfile ?? config?.profile ?? 'web'
    await this.setPackageEnabled(profile, packageName, enabled)
    return { runtimeRestartRequired: this.options.isRuntimeActive?.() === true }
  }

  /** Change one profile layer by package name; used by Runtime recovery for unmanaged plugins. */
  async setPackageEnabled(profile: string, packageName: string, enabled: boolean): Promise<void> {
    if (!PACKAGE_NAME.test(packageName)) throw new Error(`Invalid recorded DSH plugin package name: ${packageName}`)
    if (!PROFILE_NAME.test(profile)) throw new Error(`Invalid recorded DSH plugin profile: ${profile}`)
    const path = join(this.options.dshHome, 'profiles', profile, 'package.json')
    const manifest = await readProfileManifest(this.options.dshHome, profile)
    const patchPath = join(this.options.dshHome, 'profiles', profile, 'cordis.patch.yml')
    const patchChanged = await setPatchPluginEnabled(patchPath, packageName, enabled)
    if (!hasDependency(manifest, packageName) && !patchChanged) {
      throw new Error(`DSH plugin package ${packageName} is not installed in profile ${profile}`)
    }
    if (!hasDependency(manifest, packageName)) return
    const bundles = profileBundles(manifest)
    const disabledBundles = profileDisabledBundles(manifest)
    const nextBundles = enabled
      ? bundles.includes(packageName) ? bundles : [...bundles, packageName]
      : bundles.filter((candidate) => candidate !== packageName)
    const nextDisabledBundles = enabled
      ? disabledBundles.filter((candidate) => candidate !== packageName)
      : disabledBundles.includes(packageName) ? disabledBundles : [...disabledBundles, packageName]
    const bundlesUnchanged = nextBundles.length === bundles.length && nextBundles.every((candidate, index) => candidate === bundles[index])
    const disabledBundlesUnchanged = nextDisabledBundles.length === disabledBundles.length
      && nextDisabledBundles.every((candidate, index) => candidate === disabledBundles[index])
    if (bundlesUnchanged && disabledBundlesUnchanged) return
    await writeProfileManifest(path, withProfileState(manifest, nextBundles, nextDisabledBundles))
  }

  /** Disable third-party bundles whose DSH peer API range excludes the selected Runtime. */
  async repairIncompatiblePlugins(profile: string, runtimeEntryPath: string): Promise<readonly DshIncompatiblePlugin[]> {
    if (!PROFILE_NAME.test(profile)) throw new Error(`Invalid DSH plugin profile: ${profile}`)
    const manifest = await readProfileManifest(this.options.dshHome, profile)
    const profileRoot = join(this.options.dshHome, 'profiles', profile)
    const runtimeRequire = createRequire(runtimeEntryPath)
    const repaired: DshIncompatiblePlugin[] = []
    for (const packageName of profileBundles(manifest)) {
      if (isCoreDshBundle(packageName) || profileDisabledBundles(manifest).includes(packageName)) continue
      const packageManifest = await readPackageManifest(join(profileRoot, 'node_modules', packageName, 'package.json'))
        ?? await readPackageManifest(join(this.options.dshHome, 'profiles', 'node_modules', packageName, 'package.json'))
      if (packageManifest === undefined) continue
      const reason = await incompatiblePeerReason(packageManifest, runtimeRequire)
      if (reason === undefined) continue
      await this.setPackageEnabled(profile, packageName, false)
      repaired.push({ packageName, reason })
    }
    return repaired
  }

  /** List third-party packages present in every DSH profile, including packages not installed by EzDSH. */
  async listInstalledPlugins(): Promise<DshInstalledPlugin[]> {
    const profilesRoot = join(this.options.dshHome, 'profiles')
    let profileEntries: readonly { readonly name: string; isDirectory(): boolean }[] = []
    try {
      profileEntries = await readdir(profilesRoot, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return []
    }

    const installed: DshInstalledPlugin[] = []
    for (const profileEntry of profileEntries) {
      if (!profileEntry.isDirectory() || !PROFILE_NAME.test(profileEntry.name)) continue
      const profile = profileEntry.name
      const profileRoot = join(profilesRoot, profile)
      const manifest = await readProfileManifest(this.options.dshHome, profile)
      const dependencyNamesInProfile = dependencyNames(manifest)
      const candidates = new Set([
        ...dependencyNamesInProfile,
        ...profileBundles(manifest).filter((name) => !isCoreDshBundle(name)),
      ])

      // Some older DSH installs placed bundled plugin packages in the parent
      // profiles/node_modules directory and only referenced them from the
      // profile patch. Include those packages when their manifest declares DSH
      // metadata and the patch names them.
      const patchText = await readOptionalText(join(profileRoot, 'cordis.patch.yml'))
      const patchStates = await readPatchPluginStates(join(profileRoot, 'cordis.patch.yml'))
      for (const packageName of await packageNamesInNodeModules(profilesRoot)) {
        if (!patchText.includes(packageName) || isCoreDshBundle(packageName)) continue
        const packageManifest = await readPackageManifest(join(profilesRoot, 'node_modules', packageName, 'package.json'))
        if (packageManifest?.dsh !== undefined) candidates.add(packageName)
      }

      const disabled = new Set(profileDisabledBundles(manifest))
      for (const packageName of candidates) {
        if (isCoreDshBundle(packageName)) continue
        const packageManifest = await readPackageManifest(join(profileRoot, 'node_modules', packageName, 'package.json'))
          ?? await readPackageManifest(join(profilesRoot, 'node_modules', packageName, 'package.json'))
        const declared = dependencySpec(manifest, packageName)
        installed.push({
          packageName,
          profile,
          version: packageManifest?.version ?? declared ?? 'unknown',
          enabled: patchStates.get(packageName) ?? !disabled.has(packageName),
        })
      }
    }
    return installed
  }

  /** List non-core bundle layers currently selected by every profile. */
  async listActivePlugins(): Promise<DshActivePlugin[]> {
    return (await this.listInstalledPlugins())
      .filter((plugin) => plugin.enabled)
      .map(({ packageName, profile }) => ({ packageName, profile }))
  }

  private async run(profile: string, args: readonly string[], before: ProfileManifest, verifiedBuilds: readonly string[] = []): Promise<void> {
    try {
      await this.options.runCommand(profile, args)
      await this.restoreDisabledBundles(profile)
    } catch (error) {
      const allowBuildArgs = recoverableIgnoredBuildArgs(error, before, verifiedBuilds)
      if (allowBuildArgs.length === 0) throw error
      const command = args[0]
      if (command === undefined) throw error
      await this.options.runCommand(profile, [command, ...allowBuildArgs, ...args.slice(1)])
      await this.restoreDisabledBundles(profile)
    }
  }

  private async restoreDisabledBundles(profile: string): Promise<void> {
    const path = join(this.options.dshHome, 'profiles', profile, 'package.json')
    const manifest = await readProfileManifest(this.options.dshHome, profile)
    const disabledBundles = profileDisabledBundles(manifest)
    if (disabledBundles.length === 0) return
    const bundles = profileBundles(manifest)
    const nextBundles = bundles.filter((candidate) => !disabledBundles.includes(candidate))
    if (nextBundles.length === bundles.length) return
    await writeProfileManifest(path, withProfileState(manifest, nextBundles, disabledBundles))
  }

  private async clearDisabledBundle(profile: string, packageName: string): Promise<void> {
    const path = join(this.options.dshHome, 'profiles', profile, 'package.json')
    const manifest = await readProfileManifest(this.options.dshHome, profile)
    const disabledBundles = profileDisabledBundles(manifest)
    const nextDisabledBundles = disabledBundles.filter((candidate) => candidate !== packageName)
    if (nextDisabledBundles.length === disabledBundles.length) return
    await writeProfileManifest(path, withProfileState(manifest, profileBundles(manifest), nextDisabledBundles))
  }
}

function requirePlugin(entry: StoreEntry): StorePluginConfig {
  if (entry.plugin === undefined) throw new Error(`Entry ${entry.id} declares no DSH plugin config`)
  return entry.plugin
}

interface ProfileManifest {
  readonly dependencies?: Readonly<Record<string, unknown>>
  readonly devDependencies?: Readonly<Record<string, unknown>>
  readonly optionalDependencies?: Readonly<Record<string, unknown>>
  readonly dsh?: {
    readonly profile?: {
      readonly bundles?: readonly string[]
      readonly disabledBundles?: readonly string[]
      readonly [key: string]: unknown
    }
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly dsh?: unknown
  readonly peerDependencies?: Readonly<Record<string, unknown>>
}

async function readProfileManifest(dshHome: string, profile: string): Promise<ProfileManifest> {
  const path = join(dshHome, 'profiles', profile, 'package.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as ProfileManifest : {}
  } catch {
    return {}
  }
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function readPatchPluginStates(path: string): Promise<Map<string, boolean>> {
  const text = await readOptionalText(path)
  if (text === '') return new Map()
  try {
    const document = parseDocument(text)
    const states = new Map<string, boolean>()
    for (const child of insertedPatchEntries(patchRows(document))) {
      const name = child.get('name') as unknown
      if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) continue
      states.set(name, child.get('disabled') !== true)
    }
    return states
  } catch {
    // A malformed patch will be surfaced by Runtime recovery; it should not
    // make the installed list itself disappear.
    return new Map()
  }
}

async function setPatchPluginEnabled(path: string, packageName: string, enabled: boolean): Promise<boolean> {
  const text = await readOptionalText(path)
  if (text === '') return false
  const document = parseDocument(text)
  let touched = false
  for (const child of insertedPatchEntries(patchRows(document))) {
    if ((child.get('name') as unknown) !== packageName) continue
    if (enabled) child.delete('disabled')
    else child.set('disabled', true)
    touched = true
  }
  if (!touched) return false
  const output = document.toString()
  await writeFile(path, output.endsWith('\n') ? output : `${output}\n`, { mode: 0o600 })
  return true
}

function patchRows(document: Document): YAMLSeq<YAMLMap> {
  const contents = document.contents
  if (contents === null || typeof (contents as YAMLSeq).items === 'undefined') {
    document.contents = document.createNode([])
  }
  return document.contents as unknown as YAMLSeq<YAMLMap>
}

function insertedPatchEntries(rows: YAMLSeq<YAMLMap>): YAMLMap[] {
  const entries: YAMLMap[] = []
  for (const row of rows.items) {
    if (row === undefined || !row.has('insert')) continue
    const insert = row.get('insert', true)
    if (insert === null || typeof insert !== 'object' || !('items' in (insert as object))) continue
    for (const child of (insert as unknown as YAMLSeq<YAMLMap>).items) {
      if (child !== undefined) entries.push(child)
    }
  }
  return entries
}

async function readPackageManifest(path: string): Promise<PackageManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = parsed as { name?: unknown; version?: unknown; dsh?: unknown; peerDependencies?: unknown }
    return {
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(value.dsh === undefined ? {} : { dsh: value.dsh }),
      ...(typeof value.peerDependencies === 'object' && value.peerDependencies !== null && !Array.isArray(value.peerDependencies)
        ? { peerDependencies: value.peerDependencies as Readonly<Record<string, unknown>> }
        : {}),
    }
  } catch {
    return undefined
  }
}

async function incompatiblePeerReason(manifest: PackageManifest, runtimeRequire: NodeRequire): Promise<string | undefined> {
  for (const [peerName, peerRangeValue] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!peerName.startsWith('@deepseek-ai/dsh-') || typeof peerRangeValue !== 'string') continue
    const peerRange = peerRangeValue.trim()
    const runtimeManifestPath = resolveRuntimePackageManifest(runtimeRequire, peerName)
    if (runtimeManifestPath === undefined) {
      return `${peerName} ${peerRange} is required, but the selected Runtime does not provide this package`
    }
    const runtimeManifest = await readPackageManifest(runtimeManifestPath)
    if (runtimeManifest?.version === undefined) {
      return `${peerName} ${peerRange} is required, but the selected Runtime package has no version`
    }
    const compatible = versionSatisfiesRange(runtimeManifest.version, peerRange)
    if (compatible === false) {
      return `${peerName} ${peerRange} is required, but the selected Runtime provides ${runtimeManifest.version}`
    }
  }
  return undefined
}

function resolveRuntimePackageManifest(runtimeRequire: NodeRequire, packageName: string): string | undefined {
  try {
    return runtimeRequire.resolve(`${packageName}/package.json`)
  } catch {
    return undefined
  }
}

function versionSatisfiesRange(version: string, range: string): boolean | undefined {
  const candidate = parseVersion(version)
  if (candidate === undefined) return undefined
  let understood = false
  for (const arm of range.split(/\s*\|\|\s*/u)) {
    const normalized = arm.trim()
    if (normalized === '' || normalized === '*') return true
    const operatorMatch = /^(\^|~|>=|<=|>|<|=)?\s*/u.exec(normalized)
    const operator = operatorMatch?.[1] ?? '='
    const minimum = parseVersion(normalized.slice(operatorMatch?.[0].length ?? 0).trim())
    if (minimum === undefined) continue
    understood = true
    if (candidate.prerelease !== undefined && (minimum.prerelease === undefined || !sameNumericVersion(candidate, minimum))) continue
    const minimumComparison = compareDshVersions(version, formatVersion(minimum))
    if (operator === '=' && minimumComparison === 0) return true
    if (operator === '>' && minimumComparison > 0) return true
    if (operator === '>=' && minimumComparison >= 0) return true
    if (operator === '<' && minimumComparison < 0) return true
    if (operator === '<=' && minimumComparison <= 0) return true
    if (operator === '^' || operator === '~') {
      const upper = operator === '^' ? caretUpperBound(minimum) : tildeUpperBound(minimum)
      if (minimumComparison >= 0 && compareDshVersions(version, formatVersion(upper)) < 0) return true
    }
  }
  return understood ? false : undefined
}

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: string
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  }
}

function sameNumericVersion(left: ParsedVersion, right: ParsedVersion): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch
}

function caretUpperBound(version: ParsedVersion): ParsedVersion {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 }
  return { major: 0, minor: 0, patch: version.patch + 1 }
}

function tildeUpperBound(version: ParsedVersion): ParsedVersion {
  return { major: version.major, minor: version.minor + 1, patch: 0 }
}

function formatVersion(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease === undefined ? '' : `-${version.prerelease}`}`
}

async function packageNamesInNodeModules(nodeModulesRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(nodeModulesRoot, { withFileTypes: true })
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      if (entry.name.startsWith('@')) {
        const scoped = await readdir(join(nodeModulesRoot, entry.name), { withFileTypes: true }).catch(() => [])
        for (const child of scoped) {
          if (child.isDirectory()) names.push(`${entry.name}/${child.name}`)
        }
      } else names.push(entry.name)
    }
    return names.sort()
  } catch {
    return []
  }
}

function dependencyNames(manifest: ProfileManifest): Set<string> {
  const names = new Set<string>()
  for (const group of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]) {
    for (const name of Object.keys(group ?? {})) names.add(name)
  }
  return names
}

function dependencySpec(manifest: ProfileManifest, packageName: string): string | undefined {
  for (const group of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]) {
    const value = group?.[packageName]
    if (typeof value === 'string') return value
  }
  return undefined
}

function hasDependency(manifest: ProfileManifest, packageName: string): boolean {
  return dependencyNames(manifest).has(packageName)
}

function profileBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles.filter((value): value is string => typeof value === 'string') : []
}

function profileDisabledBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.disabledBundles
  return Array.isArray(bundles) ? bundles.filter((value): value is string => typeof value === 'string') : []
}

function withProfileState(manifest: ProfileManifest, bundles: readonly string[], disabledBundles: readonly string[]): ProfileManifest {
  return {
    ...manifest,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: [...bundles],
        disabledBundles: [...disabledBundles],
      },
    },
  }
}

async function writeProfileManifest(path: string, manifest: ProfileManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}-${String(Date.now())}`)
  try {
    await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function isCoreDshBundle(packageName: string): boolean {
  return packageName.startsWith('@deepseek-ai/dsh-')
}

const IGNORED_BUILDS_PATTERN = /Ignored build scripts:\s*([^\r\n]+)/i

/**
 * Return pnpm's exact package specs for build scripts it refused to run.
 * The full spec is required for GitHub tarballs because the workspace policy
 * key is version/source-specific rather than just the package name.
 */
function ignoredBuildSpecs(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const match = IGNORED_BUILDS_PATTERN.exec(message)
  if (match?.[1] === undefined) return []
  return match[1].split(',').map((value) => value.trim()).filter(Boolean)
}

function packageNameFromBuildSpec(spec: string): string {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const versionAt = slash === -1 ? -1 : spec.indexOf('@', slash + 1)
    return versionAt === -1 ? spec : spec.slice(0, versionAt)
  }
  const versionAt = spec.indexOf('@')
  return versionAt === -1 ? spec : spec.slice(0, versionAt)
}

/**
 * Approve scripts for dependencies that were already in the profile, plus
 * exact package/version pairs covered by the DSH compatibility policy.
 */
function recoverableIgnoredBuildArgs(error: unknown, before: ProfileManifest, verifiedBuilds: readonly string[] = []): string[] {
  const existing = dependencyNames(before)
  const verified = new Set(verifiedBuilds)
  const seen = new Set<string>()
  return ignoredBuildSpecs(error)
    .filter((spec) => {
      const packageName = packageNameFromBuildSpec(spec)
      const allowed = existing.has(packageName) || isAutomaticallyAllowedBuildSpec(spec) || verified.has(spec)
      if (!allowed || seen.has(spec)) return false
      seen.add(spec)
      return true
    })
    .map((spec) => `--allow-build=${spec}`)
}

function isAutomaticallyAllowedBuildSpec(spec: string): boolean {
  const packageName = packageNameFromBuildSpec(spec)
  const versions = AUTOMATICALLY_ALLOWED_BUILD_VERSIONS[packageName]
  if (versions === undefined) return false
  const versionPrefix = `${packageName}@`
  return spec.startsWith(versionPrefix) && versions.includes(spec.slice(versionPrefix.length))
}

function resolvePackageName(config: StorePluginConfig, before: ProfileManifest, after: ProfileManifest): string {
  const declared = config.packageName ?? packageNameFromSourceIfNpm(config.source)
  if (declared !== undefined) return declared
  const sourceMatch = packageNameFromManifestSource(config.source, after)
  if (sourceMatch !== undefined) return sourceMatch
  const beforeNames = dependencyNames(before)
  const added = [...dependencyNames(after)].filter((name) => !beforeNames.has(name))
  if (added.length === 1) return added[0] as string
  throw new Error(`Cannot determine the package name added by ${config.source}`)
}

/** Only trust build exceptions tied to a passed verification of this exact source. */
function verifiedBuildsFor(config: StorePluginConfig): readonly string[] {
  const verification = config.verification
  if (verification?.status !== 'passed' || verification.source !== config.source) return []
  if (verification.packageName !== undefined && config.packageName !== undefined && verification.packageName !== config.packageName) return []
  return verification.allowBuilds ?? []
}

/** Find the package name recorded by pnpm for a source-backed dependency. */
function packageNameFromManifestSource(source: string, manifest: ProfileManifest): string | undefined {
  for (const group of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]) {
    for (const [packageName, spec] of Object.entries(group ?? {})) {
      if (typeof spec === 'string' && packageSourcesMatch(source, spec)) return packageName
    }
  }
  return undefined
}

/** Match GitHub sources by repository even when pnpm adds or changes a ref. */
function packageSourcesMatch(left: string, right: string): boolean {
  if (left === right) return true
  if (!left.startsWith('github:') || !right.startsWith('github:')) return false
  return githubRepository(left) === githubRepository(right)
}

function githubRepository(source: string): string {
  return source.slice('github:'.length).split('#', 1)[0] ?? ''
}

function packageNameFromSourceIfNpm(source: string): string | undefined {
  return source.startsWith('npm:') ? packageNameFromSource(source) : undefined
}

function packageNameFromSource(source: string): string {
  const raw = source.slice('npm:'.length)
  if (raw.startsWith('@')) {
    const versionAt = raw.indexOf('@', raw.indexOf('/') + 1)
    return versionAt === -1 ? raw : raw.slice(0, versionAt)
  }
  const versionAt = raw.indexOf('@')
  return versionAt === -1 ? raw : raw.slice(0, versionAt)
}
