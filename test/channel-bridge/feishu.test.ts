import { describe, expect, it, vi } from 'vitest'
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

  it('invokes onUnauthorizedMessage for denied users and uses its reply when provided', async () => {
    const adapter = new FeishuAdapter({
      config: { appId: 'a', appSecret: 'b' },
      allowList: ['allowed-user'],
      onUnauthorizedMessage: async (message) => {
        if (message.content.text === '123456') {
          return { to: { userId: message.from.id }, content: 'paired' }
        }
        return undefined
      },
      logger: { info() {}, error() {}, warn() {} },
    })

    const pairedReply = await adapter.handleReceiveEvent(createEvent('new-user', '123456'))
    expect(pairedReply?.content).toBe('paired')
    expect(pairedReply?.to.userId).toBe('new-user')

    const deniedReply = await adapter.handleReceiveEvent(createEvent('other-user', 'hello'))
    expect(deniedReply?.content).toContain('白名单')
  })

  it('updateAllowList changes the runtime allowlist', async () => {
    const adapter = new FeishuAdapter({
      config: { appId: 'a', appSecret: 'b' },
      allowList: ['allowed-user'],
      logger: { info() {}, error() {}, warn() {} },
    })

    adapter.updateAllowList(['allowed-user', 'new-user'])

    const reply = await adapter.handleReceiveEvent(createEvent('new-user', 'hello'))
    expect(reply).toBeUndefined()

    const handler = vi.fn(async () => ({ to: { userId: 'new-user' }, content: 'ok' }))
    adapter.onMessage(handler)
    await adapter.handleReceiveEvent(createEvent('new-user', 'hello'))
    expect(handler).toHaveBeenCalled()
  })
})
