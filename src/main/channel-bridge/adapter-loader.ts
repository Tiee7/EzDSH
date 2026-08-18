import { createRequire } from 'node:module'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdapterRegistry } from './adapter-registry.js'
import type { ChannelAdapterFactory, Logger } from './types.js'

export interface AdapterLoaderOptions {
  /** Registry to register discovered factories into. */
  registry: AdapterRegistry
  /** Optional logger for warnings and diagnostics. */
  logger?: Logger
}

export interface ChannelAdapterManifest {
  /** Adapter identifier, must match a factory name and config key. */
  name: string
  /** Module entry path relative to the package root. */
  entry: string
}

export interface LoadedAdapterPackage {
  /** Package directory on disk. */
  path: string
  /** Parsed package.json contents. */
  packageJson: Record<string, unknown>
  /** Adapter manifest from package.json. */
  manifest: ChannelAdapterManifest
  /** Loaded factory. */
  factory: ChannelAdapterFactory
}

/**
 * Discovers and loads channel-adapter packages from directories.
 *
 * Each package must be a directory containing a package.json with:
 *
 * ```json
 * {
 *   "ezdsh": {
 *     "channelAdapter": {
 *       "name": "feishu",
 *       "entry": "./out/index.js"
 *     }
 *   }
 * }
 * ```
 *
 * The entry module must export a `ChannelAdapterFactory` as either:
 * - a default export, or
 * - a named export whose key ends with `Factory` or matches the adapter name.
 */
export class ChannelAdapterLoader {
  constructor(private readonly options: AdapterLoaderOptions) {}

  /**
   * Scan multiple directories and load all valid adapter packages found.
   * Invalid packages are skipped with a warning; failures do not stop loading.
   */
  async loadFromDirectories(directories: readonly string[]): Promise<LoadedAdapterPackage[]> {
    const loaded: LoadedAdapterPackage[] = []
    for (const dir of directories) {
      try {
        const packages = await this.loadFromDirectory(dir)
        loaded.push(...packages)
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        this.options.logger?.warn(`[channel-bridge:loader] failed to scan ${dir}: ${messageText}`)
      }
    }
    return loaded
  }

  /**
   * Scan one directory and load all valid adapter packages.
   */
  async loadFromDirectory(directory: string): Promise<LoadedAdapterPackage[]> {
    const entries = await readdir(directory).catch(() => [])
    const loaded: LoadedAdapterPackage[] = []

    for (const entry of entries) {
      const packagePath = join(directory, entry)
      try {
        const packageInfo = await this.loadPackage(packagePath)
        if (packageInfo !== undefined) {
          loaded.push(packageInfo)
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        this.options.logger?.warn(`[channel-bridge:loader] failed to load ${packagePath}: ${messageText}`)
      }
    }

    return loaded
  }

  /**
   * Load a single adapter package from its directory.
   * Returns undefined if the directory is not a valid adapter package.
   */
  async loadPackage(packagePath: string): Promise<LoadedAdapterPackage | undefined> {
    const packageStat = await stat(packagePath).catch(() => undefined)
    if (packageStat === undefined || !packageStat.isDirectory()) {
      return undefined
    }

    const packageJsonPath = join(packagePath, 'package.json')
    const raw = await readFile(packageJsonPath, 'utf8').catch(() => undefined)
    if (raw === undefined) {
      return undefined
    }

    const packageJson = JSON.parse(raw) as Record<string, unknown>
    const manifest = this.parseManifest(packageJson, packagePath)
    if (manifest === undefined) {
      return undefined
    }

    const entryPath = join(packagePath, manifest.entry)
    const factory = await this.loadFactory(entryPath, manifest.name)

    if (factory.name !== manifest.name) {
      throw new Error(
        `Adapter factory name mismatch in ${packagePath}: manifest says "${manifest.name}", factory says "${factory.name}"`,
      )
    }

    this.options.registry.register(factory)
    this.options.logger?.info(`[channel-bridge:loader] registered adapter "${factory.name}" from ${packagePath}`)

    return {
      path: packagePath,
      packageJson,
      manifest,
      factory,
    }
  }

  private parseManifest(
    packageJson: Record<string, unknown>,
    packagePath: string,
  ): ChannelAdapterManifest | undefined {
    const ezdsh = packageJson.ezdsh as Record<string, unknown> | undefined
    const channelAdapter = ezdsh?.channelAdapter as Record<string, unknown> | undefined
    if (channelAdapter === undefined) {
      return undefined
    }

    const name = channelAdapter.name
    const entry = channelAdapter.entry
    if (typeof name !== 'string' || name === '') {
      throw new Error(`Invalid channel adapter name in ${packagePath}: ${String(name)}`)
    }
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`Invalid channel adapter entry in ${packagePath}: ${String(entry)}`)
    }

    return { name, entry }
  }

  private async loadFactory(entryPath: string, expectedName: string): Promise<ChannelAdapterFactory> {
    let module: Record<string, unknown>
    try {
      module = (await import(entryPath)) as Record<string, unknown>
    } catch {
      // Fallback to CommonJS require for packages that are not ESM.
      const require = createRequire(import.meta.url)
      module = require(entryPath) as Record<string, unknown>
    }

    // 1. Prefer default export if it looks like a factory.
    if (this.isFactory(module.default)) {
      return module.default
    }

    // 2. Look for a named export ending with Factory or matching the adapter name.
    for (const [key, value] of Object.entries(module)) {
      if (this.isFactory(value) && (key === expectedName || key.endsWith('Factory'))) {
        return value
      }
    }

    throw new Error(`No ChannelAdapterFactory export found in ${entryPath}`)
  }

  private isFactory(value: unknown): value is ChannelAdapterFactory {
    return (
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      typeof (value as Record<string, unknown>).name === 'string' &&
      'create' in value &&
      typeof (value as Record<string, unknown>).create === 'function'
    )
  }
}
