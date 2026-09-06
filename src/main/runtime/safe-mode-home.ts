import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'

export type SafeModeReason = 'manual' | 'plugin-recovery' | 'update-recovery' | 'runtime-recovery'

export interface SafeModeStatus {
  readonly active: boolean
  readonly reason?: SafeModeReason
  readonly activatedAt?: string
  readonly excludedPluginCount: number
}

export interface SafeModeControllerOptions {
  readonly layout: UserDataLayout
  readonly now?: () => Date
}

/**
 * Creates a disposable DSH_HOME which intentionally has no profile, session,
 * or credential state. Recovery must remain usable when the normal credential
 * file belongs to another Runtime version or is malformed.
 */
export class SafeModeController {
  private readonly safeRoot: string
  private readonly safeHome: string
  private readonly statusPath: string
  private readonly now: () => Date
  private current: SafeModeStatus = { active: false, excludedPluginCount: 0 }

  constructor(private readonly options: SafeModeControllerOptions) {
    this.safeRoot = join(options.layout.state, 'safe-mode')
    this.safeHome = join(this.safeRoot, 'harness')
    this.statusPath = join(this.safeRoot, 'status.json')
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<SafeModeStatus> {
    this.current = await this.readStatus()
    return this.status()
  }

  status(): SafeModeStatus {
    return { ...this.current }
  }

  homePath(): string {
    return this.safeHome
  }

  async enable(reason: SafeModeReason): Promise<{ status: SafeModeStatus; dshHome: string }> {
    await rm(this.safeHome, { recursive: true, force: true })
    await mkdir(this.safeHome, { recursive: true, mode: 0o700 })
    this.current = {
      active: true,
      reason,
      activatedAt: this.now().toISOString(),
      excludedPluginCount: await this.countManagedPlugins(),
    }
    await writeAtomic(this.statusPath, `${JSON.stringify(this.current, null, 2)}\n`)
    return { status: this.status(), dshHome: this.safeHome }
  }

  async disable(): Promise<SafeModeStatus> {
    await rm(this.safeHome, { recursive: true, force: true })
    await rm(this.statusPath, { force: true })
    this.current = { active: false, excludedPluginCount: 0 }
    return this.status()
  }

  private async countManagedPlugins(): Promise<number> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.options.layout.state, 'installed.json'), 'utf8'))
      if (!Array.isArray(parsed)) return 0
      return parsed.filter((record) => typeof record === 'object' && record !== null && typeof (record as { pluginPackageName?: unknown }).pluginPackageName === 'string').length
    } catch {
      return 0
    }
  }

  private async readStatus(): Promise<SafeModeStatus> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statusPath, 'utf8'))
      if (isSafeModeStatus(parsed)) return parsed
    } catch {
      // Missing or malformed state means Safe Mode is inactive.
    }
    return { active: false, excludedPluginCount: 0 }
  }
}

function isSafeModeStatus(value: unknown): value is SafeModeStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Partial<SafeModeStatus>
  return typeof status.active === 'boolean'
    && typeof status.excludedPluginCount === 'number'
    && (status.reason === undefined || status.reason === 'manual' || status.reason === 'plugin-recovery' || status.reason === 'update-recovery' || status.reason === 'runtime-recovery')
    && (status.activatedAt === undefined || typeof status.activatedAt === 'string')
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}-${String(Date.now())}`)
  await writeFile(temporaryPath, content, { mode: 0o600 })
  await rename(temporaryPath, path)
}
