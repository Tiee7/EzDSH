import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelBridgeService } from '../../src/main/channel-bridge/index.js'
import type { FeishuMessageEvent } from '../../src/main/channel-bridge/feishu.js'
import type { ChannelBridgeConfig } from '../../src/shared/channel-bridge.js'

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: class MockClient {
      im = {
        message: {
          create: async () => ({ code: 0, msg: 'ok', data: {} }),
        },
      }
    },
    EventDispatcher: class MockEventDispatcher {
      register() {
        return this
      }
    },
    WSClient: class MockWSClient {
      async start() {}
      close() {}
    },
    LoggerLevel: { warn: 1 },
  }
})

function createEvent(openId: string, text: string, chatType: 'p2p' | 'group' = 'p2p'): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: openId, name: 'Alice' },
      sender_type: 'user',
      tenant_key: 'tenant-key',
    },
    message: {
      message_id: 'msg-1',
      chat_id: 'chat-1',
      chat_type: chatType,
      content: JSON.stringify({ text }),
    },
  }
}

describe('ChannelBridgeService pairing', () => {
  let service: ChannelBridgeService
  let configDir: string

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'ezdsh-cb-'))
    service = new ChannelBridgeService({
      layout: { state: configDir, runtime: configDir, cache: configDir },
      getRuntimeUrl: () => 'http://localhost:8080',
    })
  })

  afterEach(async () => {
    await service.stop().catch(() => {})
    vi.useRealTimers()
  })

  it('startPairing requires the adapter to be running', async () => {
    await expect(service.startPairing()).rejects.toThrow('远程控制未启动')
  })

  it('generates a 6-digit code and expires after the TTL', async () => {
    vi.useFakeTimers()
    const config: ChannelBridgeConfig = {
      enabled: true,
      feishu: { appId: 'cli_xxx', appSecret: 'secret' },
      allowList: [],
      timeoutMs: 120_000,
    }
    await service.setConfig(config)

    const state = await service.startPairing()
    expect(state.active).toBe(true)
    expect(state.code).toMatch(/^\d{6}$/)

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(service.getPairingState().active).toBe(false)
  })

  it('adds the sender to the allowlist when the correct code is sent in a private chat', async () => {
    const config: ChannelBridgeConfig = {
      enabled: true,
      feishu: { appId: 'cli_xxx', appSecret: 'secret' },
      allowList: [],
      timeoutMs: 120_000,
    }
    await service.setConfig(config)

    const state = await service.startPairing()
    const adapter = (service as unknown as { adapter?: { handleReceiveEvent: (event: FeishuMessageEvent) => Promise<unknown> } }).adapter
    expect(adapter).toBeDefined()

    const reply = await adapter!.handleReceiveEvent(createEvent('ou_new_user', state.code!))
    expect((reply as { content: string }).content).toContain('配对成功')

    const savedConfig = JSON.parse(await readFile(join(configDir, 'channel-bridge.json'), 'utf-8')) as ChannelBridgeConfig
    expect(savedConfig.allowList).toContain('ou_new_user')

    const currentConfig = await service.getConfig()
    expect(currentConfig.allowList).toContain('ou_new_user')
  })

  it('ignores correct codes sent in group chats', async () => {
    const config: ChannelBridgeConfig = {
      enabled: true,
      feishu: { appId: 'cli_xxx', appSecret: 'secret' },
      allowList: [],
      timeoutMs: 120_000,
    }
    await service.setConfig(config)

    const state = await service.startPairing()
    const adapter = (service as unknown as { adapter?: { handleReceiveEvent: (event: FeishuMessageEvent) => Promise<unknown> } }).adapter

    const reply = await adapter!.handleReceiveEvent(createEvent('ou_new_user', state.code!, 'group'))
    expect((reply as { content: string }).content).toContain('白名单')

    const currentConfig = await service.getConfig()
    expect(currentConfig.allowList).not.toContain('ou_new_user')
  })

  it('ignores incorrect codes', async () => {
    const config: ChannelBridgeConfig = {
      enabled: true,
      feishu: { appId: 'cli_xxx', appSecret: 'secret' },
      allowList: [],
      timeoutMs: 120_000,
    }
    await service.setConfig(config)

    await service.startPairing()
    const adapter = (service as unknown as { adapter?: { handleReceiveEvent: (event: FeishuMessageEvent) => Promise<unknown> } }).adapter

    const reply = await adapter!.handleReceiveEvent(createEvent('ou_new_user', '000000'))
    expect((reply as { content: string }).content).toContain('白名单')

    const currentConfig = await service.getConfig()
    expect(currentConfig.allowList).not.toContain('ou_new_user')
  })

  it('cancels pairing on request', async () => {
    const config: ChannelBridgeConfig = {
      enabled: true,
      feishu: { appId: 'cli_xxx', appSecret: 'secret' },
      allowList: [],
      timeoutMs: 120_000,
    }
    await service.setConfig(config)

    const state = await service.startPairing()
    expect(state.active).toBe(true)

    await service.cancelPairing()
    expect(service.getPairingState().active).toBe(false)
  })
})
