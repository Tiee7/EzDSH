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
    let prepared: { currentVersion: string; targetVersion?: string } | undefined
    const manager = new UpdateManager({
      currentVersion: '0.1.0-beta.1',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      prepareInstall: async (context) => {
        prepared = context
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
    expect(prepared).toEqual({ currentVersion: '0.1.0-beta.1', targetVersion: '0.2.0' })
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

  it('resolves the dynamic feed with startup and language context before checking', async () => {
    const updater = new FakeUpdater()
    const requests: URL[] = []
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      updateFeedUrl: 'https://updates.example.test/updates/',
      updateResolveUrl: 'https://updates.example.test/api/update/resolve',
      updatePlatform: 'mac',
      updateArch: 'arm64',
      updateChannel: 'stable',
      getUpdateLanguage: () => 'zh',
      fetchImpl: async (input) => {
        requests.push(new URL(String(input)))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            feedUrl: 'https://dynamic.example.test/mac/'
          })
        } as Response
      }
    })

    await manager.check('startup')

    expect(requests[0].searchParams.get('platform')).toBe('mac')
    expect(requests[0].searchParams.get('arch')).toBe('arm64')
    expect(requests[0].searchParams.get('version')).toBe('0.1.0')
    expect(requests[0].searchParams.get('trigger')).toBe('startup')
    expect(requests[0].searchParams.get('language')).toBe('zh')
    expect(updater.feedUrl).toBe('https://dynamic.example.test/mac/')
  })

  it('falls back to the static feed when the dynamic resolver fails', async () => {
    const updater = new FakeUpdater()
    const requests: URL[] = []
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      updateFeedUrl: 'https://updates.example.test/updates/',
      updateResolveUrl: 'https://updates.example.test/api/update/resolve',
      updatePlatform: 'win',
      updateArch: 'x64',
      getUpdateLanguage: () => 'en',
      fetchImpl: async (input) => {
        requests.push(new URL(String(input)))
        throw new Error('resolver unavailable')
      }
    })

    await manager.check('manual')

    expect(requests[0].searchParams.get('trigger')).toBe('manual')
    expect(updater.feedUrl).toBe('https://updates.example.test/updates/')
  })

  it('reads the current update channel when resolving each check', async () => {
    const updater = new FakeUpdater()
    const requests: URL[] = []
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      updateFeedUrl: 'https://updates.example.test/updates/',
      updateResolveUrl: 'https://updates.example.test/api/update/resolve',
      updatePlatform: 'mac',
      updateArch: 'arm64',
      getUpdateChannel: () => 'preview',
      fetchImpl: async (input) => {
        requests.push(new URL(String(input)))
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, feedUrl: 'https://dynamic.example.test/preview/' })
        } as Response
      }
    })

    await manager.check('manual')

    expect(requests[0].searchParams.get('channel')).toBe('preview')
  })

  it('propagates a target DSH Runtime version from the resolver into pre-install recovery', async () => {
    const updater = new FakeUpdater()
    let prepared: { targetVersion?: string; targetDshRuntimeVersion?: string } | undefined
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      isPackaged: true,
      updater: updater as unknown as AppUpdater,
      updateResolveUrl: 'https://updates.example.test/api/update/resolve',
      updatePlatform: 'mac',
      updateArch: 'arm64',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, feedUrl: 'https://dynamic.example.test/mac/', dshRuntimeVersion: '0.2.0' }),
      }) as Response,
      prepareInstall: async (context) => { prepared = context },
    })

    await manager.check()
    await manager.download()
    await manager.install()

    expect(manager.snapshot()).toMatchObject({ targetDshRuntimeVersion: '0.2.0' })
    expect(prepared).toMatchObject({ targetVersion: '0.2.0', targetDshRuntimeVersion: '0.2.0' })
  })
})
