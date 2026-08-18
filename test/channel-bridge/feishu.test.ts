import { describe, expect, it } from 'vitest'
import { FeishuAdapter, type FeishuMessageEvent } from '../../src/main/channel-bridge/feishu.js'

function createEvent(openId: string, text: string): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: openId, name: 'Alice' },
      sender_type: 'user',
      tenant_key: 'tenant-key',
    },
    message: {
      message_id: 'msg-1',
      chat_id: 'chat-1',
      chat_type: 'p2p',
      content: JSON.stringify({ text }),
    },
  }
}

describe('FeishuAdapter event handling', () => {
  it('rejects users not in allowlist', async () => {
    const adapter = new FeishuAdapter({
      config: { appId: 'a', appSecret: 'b' },
      allowList: ['allowed-user'],
      logger: { info() {}, error() {}, warn() {} },
    })

    const reply = await adapter.handleReceiveEvent(createEvent('denied-user', 'hello'))
    expect(reply?.content).toContain('白名单')
    expect(reply?.to.userId).toBe('denied-user')
  })

  it('invokes handler for allowed users', async () => {
    const adapter = new FeishuAdapter({
      config: { appId: 'a', appSecret: 'b' },
      allowList: ['allowed-user'],
      logger: { info() {}, error() {}, warn() {} },
    })
    adapter.onMessage(async (message) => {
      expect(message.from.id).toBe('allowed-user')
      expect(message.content.text).toBe('hello')
      return { to: { userId: 'allowed-user' }, content: 'got it' }
    })

    const reply = await adapter.handleReceiveEvent(createEvent('allowed-user', 'hello'))
    expect(reply?.content).toBe('got it')
  })

  it('skips non-text messages', async () => {
    const adapter = new FeishuAdapter({
      config: { appId: 'a', appSecret: 'b' },
      allowList: ['allowed-user'],
      logger: { info() {}, error() {}, warn() {} },
    })

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: 'allowed-user' } },
      message: {
        message_id: 'msg-2',
        chat_id: 'chat-1',
        chat_type: 'p2p',
        content: JSON.stringify({ image_key: 'img-1' }),
      },
    }

    const reply = await adapter.handleReceiveEvent(event)
    expect(reply).toBeUndefined()
  })

  it('skips events with missing sender or message', async () => {
    const adapter = new FeishuAdapter({
      config: { appId: 'a', appSecret: 'b' },
      allowList: ['allowed-user'],
      logger: { info() {}, error() {}, warn() {} },
    })

    expect(await adapter.handleReceiveEvent({})).toBeUndefined()
    expect(await adapter.handleReceiveEvent({ sender: {} })).toBeUndefined()
  })
})
