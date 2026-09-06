import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export interface ProfileModuleRepairOptions {
  readonly dshHome: string
  readonly profile: string
  readonly runtimeEntryPath: string
  /** Override the recoverable quarantine directory in tests or diagnostics. */
  readonly quarantineRoot?: string
  readonly now?: () => Date
}

export interface ProfileModuleRepairResult {
  readonly moved: readonly string[]
}

const DSH_CORE_PACKAGE_PREFIX = '@deepseek-ai/dsh-'

/**
 * Remove stale profile-local copies of DSH core packages from Node's lookup
 * path. Plugin package managers can leave an incomplete or older core copy in
 * `profiles/<profile>/node_modules`; that copy shadows the current Runtime's
 * healed fallback and can make a valid RPC disappear or crash while reading
 * the core package metadata. The old directory is moved, never deleted.
 */
export async function repairProfileModuleDrift(options: ProfileModuleRepairOptions): Promise<ProfileModuleRepairResult> {
  const profileModules = join(options.dshHome, 'profiles', options.profile, 'node_modules', '@deepseek-ai')
  const entries = await readdir(profileModules, { withFileTypes: true }).catch(() => [])
  const requireFromRuntime = createRequire(options.runtimeEntryPath)
  const quarantineRoot = options.quarantineRoot
    ?? join(options.dshHome, 'backups', 'profile-module-repair', `${formatTimestamp((options.now ?? (() => new Date()))())}-${randomUUID()}`)
  const moved: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const packageName = `@deepseek-ai/${entry.name}`
    if (!packageName.startsWith(DSH_CORE_PACKAGE_PREFIX)) continue
    const localDirectory = join(profileModules, entry.name)
    const selectedManifestPath = resolvePackageManifest(requireFromRuntime, packageName)
    if (selectedManifestPath === undefined) continue
    const selected = await readPackageManifest(selectedManifestPath)
    if (selected === undefined) continue
    const local = await readPackageManifest(join(localDirectory, 'package.json'))
    if (local?.name === packageName && local.version === selected.version) continue

    const destination = join(quarantineRoot, options.profile, '@deepseek-ai', entry.name)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await rename(localDirectory, destination)
    moved.push(packageName)
  }

  return { moved }
}

function resolvePackageManifest(requireFromRuntime: NodeRequire, packageName: string): string | undefined {
  try {
    return requireFromRuntime.resolve(`${packageName}/package.json`)
  } catch {
    for (const searchPath of requireFromRuntime.resolve.paths(packageName) ?? []) {
      const candidate = join(searchPath, packageName, 'package.json')
      try {
        requireFromRuntime.resolve(candidate)
        return candidate
      } catch {
        // Try the next Node module lookup root.
      }
    }
    return undefined
  }
}

async function readPackageManifest(path: string): Promise<{ name?: string; version?: string } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const manifest = value as { name?: unknown; version?: unknown }
    return {
      ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    }
  } catch {
    return undefined
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[.:]/g, '-')
}
