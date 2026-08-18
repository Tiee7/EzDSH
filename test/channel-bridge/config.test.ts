import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigStorage } from '../../src/main/channel-bridge/config.js'
import type { ChannelBridgeConfig } from '../../src/shared/channel-bridge.js'

describe('channel bridge config storage', () => {
  it('loads defaults when file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-cb-'))
    const storage = createConfigStorage(dir)
    const config = await storage.loadConfig()
    expect(config.enabled).toBe(false)
    expect(config.allowList).toEqual([])
    expect(config.timeoutMs).toBe(120_000)
    expect(config.sessionTimeoutMs).toBe(300_000)
    expect(config.feishu).toBeUndefined()
  })

  it('round-trips custom config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-cb-'))
    const storage = createConfigStorage(dir)
    const custom: ChannelBridgeConfig = {
      enabled: true,
      feishu: { appId: 'app-id', appSecret: 'app-secret' },
      sessionId: 'session-1',
      allowList: ['user-1', 'user-2'],
      workspace: '/tmp',
      timeoutMs: 60_000,
      sessionTimeoutMs: 120_000,
    }
    await storage.saveConfig(custom)
    const loaded = await storage.loadConfig()
    expect(loaded).toEqual(custom)
    expect(storage.getConfigPath()).toBe(join(dir, 'channel-bridge.json'))
  })

  it('migrates legacy config that contained a port field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-cb-'))
    const storage = createConfigStorage(dir)
    const legacy = {
      enabled: true,
      port: 17891,
      feishu: { appId: 'app-id', appSecret: 'app-secret' },
      allowList: ['user-1'],
      timeoutMs: 60_000,
    }
    await writeFile(storage.getConfigPath(), JSON.stringify(legacy))
    const loaded = await storage.loadConfig()
    expect(loaded.enabled).toBe(true)
    expect(loaded.feishu).toEqual(legacy.feishu)
    expect(loaded.allowList).toEqual(['user-1'])
    expect(loaded.timeoutMs).toBe(60_000)
    expect(loaded.sessionTimeoutMs).toBe(300_000)
  })
})
