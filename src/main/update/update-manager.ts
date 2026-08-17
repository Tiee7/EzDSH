import type { AppUpdater } from 'electron-updater'
import type { UpdateState } from '../../shared/update.js'

export interface UpdateManagerOptions {
  currentVersion: string
  isPackaged: boolean
  updater?: AppUpdater
  allowDevUpdates?: boolean
  updateFeedUrl?: string
  prepareInstall?: () => Promise<void>
}

type UpdateListener = (state: UpdateState) => void

/** Coordinates signed whole-application updates without exposing updater APIs to Renderer. */
export class UpdateManager {
  private readonly options: UpdateManagerOptions
  private readonly updater?: AppUpdater
  private readonly listeners = new Set<UpdateListener>()
  private current: UpdateState
  private checkPromise?: Promise<UpdateState>
  private downloadPromise?: Promise<UpdateState>

  constructor(options: UpdateManagerOptions) {
    this.options = options
    const updateChecksEnabled = options.isPackaged || options.allowDevUpdates === true
    this.updater = updateChecksEnabled ? options.updater : undefined
    this.current = {
      phase: updateChecksEnabled ? 'idle' : 'up-to-date',
      currentVersion: options.currentVersion,
      message: updateChecksEnabled ? undefined : '开发模式不检查更新'
    }

    if (this.updater === undefined) return

    if (options.updateFeedUrl !== undefined) {
      this.updater.setFeedURL({ provider: 'generic', url: options.updateFeedUrl })
    }

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
    this.updater.allowPrerelease = options.currentVersion.includes('-')
    this.updater.on('checking-for-update', () => {
      this.publish({ phase: 'checking', message: '正在检查更新' })
    })
    this.updater.on('update-available', (info) => {
      this.publish({
        phase: 'available',
        availableVersion: info.version,
        percent: undefined,
        message: `发现新版本 ${info.version}`,
        lastCheckedAt: new Date().toISOString()
      })
    })
    this.updater.on('update-not-available', () => {
      this.publish({ phase: 'up-to-date', message: '已是最新版本', lastCheckedAt: new Date().toISOString() })
    })
    this.updater.on('download-progress', (progress) => {
      this.publish({
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, progress.percent)),
        message: `正在下载更新 ${Math.round(progress.percent)}%`
      })
    })
    this.updater.on('update-downloaded', (info) => {
      this.publish({
        phase: 'downloaded',
        availableVersion: info.version,
        percent: 100,
        message: '更新已下载，重启后安装'
      })
    })
    this.updater.on('error', (error) => {
      this.publish({
        phase: 'failed',
        message: error.message,
        lastCheckedAt: this.current.phase === 'checking' ? new Date().toISOString() : this.current.lastCheckedAt
      })
    })
  }

  snapshot(): UpdateState {
    return { ...this.current }
  }

  onChange(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async check(): Promise<UpdateState> {
    if (this.updater === undefined) return this.snapshot()
    if (this.checkPromise !== undefined) return this.checkPromise

    this.checkPromise = (async () => {
      this.publish({ phase: 'checking', message: '正在检查更新' })
      try {
        const result = await this.updater?.checkForUpdates()
        if (this.current.phase === 'checking') {
          const version = result?.updateInfo?.version
          const now = new Date().toISOString()
          this.publish(version === undefined
            ? { phase: 'up-to-date', message: '已是最新版本', lastCheckedAt: now }
            : { phase: 'available', availableVersion: version, message: `发现新版本 ${version}`, lastCheckedAt: now })
        }
      } catch (error) {
        this.publish({ phase: 'failed', message: error instanceof Error ? error.message : '检查更新失败', lastCheckedAt: new Date().toISOString() })
      } finally {
        this.checkPromise = undefined
      }
      return this.snapshot()
    })()

    return this.checkPromise
  }

  async download(): Promise<UpdateState> {
    if (this.updater === undefined || this.current.availableVersion === undefined) return this.snapshot()
    if (this.downloadPromise !== undefined) return this.downloadPromise

    this.downloadPromise = (async () => {
      this.publish({ phase: 'downloading', percent: 0, message: '正在准备下载更新' })
      try {
        await this.updater?.downloadUpdate()
        if (this.current.phase === 'downloading') {
          this.publish({ phase: 'downloaded', percent: 100, message: '更新已下载，重启后安装' })
        }
      } catch (error) {
        this.publish({ phase: 'failed', message: error instanceof Error ? error.message : '下载更新失败' })
      } finally {
        this.downloadPromise = undefined
      }
      return this.snapshot()
    })()

    return this.downloadPromise
  }

  async install(): Promise<UpdateState> {
    if (this.updater === undefined || this.current.phase !== 'downloaded') return this.snapshot()

    this.publish({ phase: 'installing', message: '正在准备安装更新' })
    try {
      await this.options.prepareInstall?.()
      this.updater.quitAndInstall(false, true)
    } catch (error) {
      this.publish({ phase: 'failed', message: error instanceof Error ? error.message : '安装更新失败' })
    }
    return this.snapshot()
  }

  private publish(patch: Omit<UpdateState, 'currentVersion'> & { currentVersion?: string }): void {
    this.current = {
      ...this.current,
      ...patch,
      currentVersion: patch.currentVersion ?? this.options.currentVersion
    }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
