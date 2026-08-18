import { describe, expect, it } from 'vitest'
import { FeishuAdapter } from '../../src/main/channel-bridge/feishu.js'

describe('FeishuAdapter webhook parsing', () => {
  it('returns challenge for URL verification', async () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b' }, [])
    const result = await adapter.handleWebhook({ challenge: 'hello-feishu' })
    expect(result.challenge).toBe('hello-feishu')
  })

  it('rejects users not in allowlist', async () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b' }, ['allowed-user'])
    const payload = {
      event: {
        sender: {
          sender_id: { open_id: 'denied-user' },
        },
        message: {
          message_id: 'msg-1',
          chat_id: 'chat-1',
          chat_type: 'p2p',
          content: JSON.stringify({ text: 'hello' }),
        },
      },
    }
    const result = await adapter.handleWebhook(payload)
    expect(result.reply?.content).toContain('白名单')
  })

  it('invokes handler for allowed users', async () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b' }, ['allowed-user'])
    adapter.onMessage(async (message) => {
      expect(message.from.id).toBe('allowed-user')
      expect(message.content.text).toBe('hello')
      return { to: { userId: 'allowed-user' }, content: 'got it' }
    })

    const payload = {
      event: {
        sender: {
          sender_id: { open_id: 'allowed-user', name: 'Alice' },
        },
        message: {
          message_id: 'msg-1',
          chat_id: 'chat-1',
          chat_type: 'p2p',
          content: JSON.stringify({ text: 'hello' }),
        },
      },
    }
    const result = await adapter.handleWebhook(payload)
    expect(result.reply?.content).toBe('got it')
  })
})
