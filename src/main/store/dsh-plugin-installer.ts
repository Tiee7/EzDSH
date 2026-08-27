/**
 * Install and remove npm/GitHub packages through the DSH profile plugin
 * command. The catalog describes plugin entries as Skills, but their payload
 * is a package-manager source rather than a downloadable Skill bundle.
 *
 * @module dsh-plugin-installer
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstalledRecord, StoreEntry, StorePluginConfig } from '../../shared/store.js'

export interface PluginCommandRunner {
  (profile: string, args: readonly string[]): Promise<void>
  /** Fail before any Runtime reload when the packaged command prerequisites are absent. */
  assertAvailable?: () => void
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

const PROFILE_NAME = /^[a-z][a-z0-9-]*$/
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const NPM_SOURCE = /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^\s/][^\s]*)?$/
const GITHUB_SOURCE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.\/-]+)?$/

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
    await this.run(profile, ['add', config.source], before)
    const after = await readProfileManifest(this.options.dshHome, profile)
    const packageName = resolvePackageName(config, before, after)
    if (!hasDependency(after, packageName)) {
      throw new Error(`DSH plugin package ${packageName} was not added to profile ${profile}`)
    }
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
    return { runtimeRestartRequired: this.options.isRuntimeActive?.() === true }
  }

  private async run(profile: string, args: readonly string[], before: ProfileManifest): Promise<void> {
    try {
      await this.options.runCommand(profile, args)
    } catch (error) {
      const allowBuildArgs = existingIgnoredBuildArgs(error, before)
      if (allowBuildArgs.length === 0) throw error
      const command = args[0]
      if (command === undefined) throw error
      await this.options.runCommand(profile, [command, ...allowBuildArgs, ...args.slice(1)])
    }
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

function dependencyNames(manifest: ProfileManifest): Set<string> {
  const names = new Set<string>()
  for (const group of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]) {
    for (const name of Object.keys(group ?? {})) names.add(name)
  }
  return names
}

function hasDependency(manifest: ProfileManifest, packageName: string): boolean {
  return dependencyNames(manifest).has(packageName)
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
 * Only approve scripts for dependencies that were already in the profile.
 * A newly introduced plugin must still go through explicit user approval.
 */
function existingIgnoredBuildArgs(error: unknown, before: ProfileManifest): string[] {
  const existing = dependencyNames(before)
  return ignoredBuildSpecs(error)
    .filter((spec) => existing.has(packageNameFromBuildSpec(spec)))
    .map((spec) => `--allow-build=${spec}`)
}

function resolvePackageName(config: StorePluginConfig, before: ProfileManifest, after: ProfileManifest): string {
  const declared = config.packageName ?? packageNameFromSourceIfNpm(config.source)
  if (declared !== undefined) return declared
  const beforeNames = dependencyNames(before)
  const added = [...dependencyNames(after)].filter((name) => !beforeNames.has(name))
  if (added.length === 1) return added[0] as string
  throw new Error(`Cannot determine the package name added by ${config.source}`)
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
