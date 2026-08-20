import { EventEmitter } from 'node:events'
import type { AppUpdater } from 'electron-updater'
import { describe, expect, it } from 'vitest'
import { UpdateManager } from '../../src/main/update/update-manager.js'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  installed = false
  feedUrl?: string

  setFeedURL(options: { url: string }) {
    this.feedUrl = options.url
  }

  async checkForUpdates() {
    this.emit('update-available', { version: '0.2.0' })
    return { updateInfo: { version: '0.2.0' } }
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 42 })
    this.emit('update-downloaded', { version: '0.2.0' })
    return ['EzDSH-0.2.0.zip']
  }

  quitAndInstall() {
    this.installed = true
  }
}

describe('UpdateManager', () => {
  it('does not contact an updater in development mode', async () => {
    const manager = new UpdateManager({ currentVersion: '0.1.0', isPackaged: false })

    expect(await manager.check()).toMatchObject({
      phase: 'up-to-date',
      message: '开发模式不检查更新'
    })
  })

  it('checks, downloads, and installs a packaged update', async () => {
    const updater = new FakeUpdater()
    let prepared = false
    const manager = new UpdateManager({
      currentVersion: '0.1.0-beta.1',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      prepareInstall: async () => {
        prepared = true
      }
    })

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.allowPrerelease).toBe(true)
    await manager.check()
    expect(manager.snapshot()).toMatchObject({ phase: 'available', availableVersion: '0.2.0' })

    await manager.download()
    expect(manager.snapshot()).toMatchObject({ phase: 'downloaded', percent: 100 })

    await manager.install()
    expect(prepared).toBe(true)
    expect(updater.installed).toBe(true)
  })

  it('can use a remote generic feed during development when explicitly enabled', async () => {
    const updater = new FakeUpdater()
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      isPackaged: false,
      allowDevUpdates: true,
      updateFeedUrl: 'https://updates.example.test/ezdsh/',
      updater: updater as unknown as AppUpdater
    })

    expect(updater.feedUrl).toBe('https://updates.example.test/ezdsh/')
    await manager.check()
    expect(manager.snapshot()).toMatchObject({ phase: 'available', availableVersion: '0.2.0' })
  })

  it('can switch the feed and prerelease policy at runtime', () => {
    const updater = new FakeUpdater()
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      updateFeedUrl: 'https://updates.example.test/stable/'
    })

    manager.setFeedURL('https://updates.example.test/preview/', true)

    expect(updater.feedUrl).toBe('https://updates.example.test/preview/')
    expect(updater.allowPrerelease).toBe(true)
    expect(manager.snapshot()).toMatchObject({ phase: 'idle', currentVersion: '0.1.0' })
  })
})
