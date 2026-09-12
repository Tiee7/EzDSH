import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'

export type IsolationModeReason = 'manual' | 'plugin-recovery' | 'update-recovery' | 'runtime-recovery'

export interface IsolationModeStatus {
  readonly active: boolean
  readonly reason?: IsolationModeReason
  readonly activatedAt?: string
  readonly excludedPluginCount: number
}

export interface IsolationModeControllerOptions {
  readonly layout: UserDataLayout
  readonly now?: () => Date
}

/**
 * Creates a disposable DSH_HOME with no profile, session, credential, or
 * workspace state. This is the strongest recovery boundary, so the product
 * calls it Isolation Mode rather than Safe Mode.
 */
export class IsolationModeController {
  private readonly isolationRoot: string
  private readonly isolationHome: string
  private readonly statusPath: string
  private readonly now: () => Date
  private current: IsolationModeStatus = { active: false, excludedPluginCount: 0 }

  constructor(private readonly options: IsolationModeControllerOptions) {
    this.isolationRoot = join(options.layout.state, 'isolation-mode')
    this.isolationHome = join(this.isolationRoot, 'harness')
    this.statusPath = join(this.isolationRoot, 'status.json')
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<IsolationModeStatus> {
    this.current = await this.readStatus()
    return this.status()
  }

  status(): IsolationModeStatus {
    return { ...this.current }
  }

  homePath(): string {
    return this.isolationHome
  }

  async enable(reason: IsolationModeReason): Promise<{ status: IsolationModeStatus; dshHome: string }> {
    await rm(this.isolationHome, { recursive: true, force: true })
    await mkdir(this.isolationHome, { recursive: true, mode: 0o700 })
    this.current = {
      active: true,
      reason,
      activatedAt: this.now().toISOString(),
      excludedPluginCount: await this.countManagedPlugins(),
    }
    await writeAtomic(this.statusPath, `${JSON.stringify(this.current, null, 2)}\n`)
    return { status: this.status(), dshHome: this.isolationHome }
  }

  async disable(): Promise<IsolationModeStatus> {
    await rm(this.isolationHome, { recursive: true, force: true })
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

  private async readStatus(): Promise<IsolationModeStatus> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statusPath, 'utf8'))
      if (isIsolationModeStatus(parsed)) return parsed
    } catch {
      // Missing or malformed state means Isolation Mode is inactive.
    }
    return { active: false, excludedPluginCount: 0 }
  }
}

function isIsolationModeStatus(value: unknown): value is IsolationModeStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Partial<IsolationModeStatus>
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
