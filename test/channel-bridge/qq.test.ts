import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { QQAdapter } from '../../plugins/channel-qq/src/index.js'

class MockWebSocket {
  static lastInstance?: MockWebSocket
  url?: string
  protocols?: string[]
  options?: { headers?: Record<string, string> }
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: (error: { message: string }) => void
  sent: string[] = []
  closed = false

  constructor(url: string, protocols: string[] = [], options: { headers?: Record<string, string> } = {}) {
    this.url = url
    this.protocols = protocols
    this.options = options
    MockWebSocket.lastInstance = this
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
  }
}

function createMessageEvent(userId: number, text: string, messageType: 'private' | 'group' = 'private', groupId?: number) {
  return {
    post_type: 'message',
    message_type: messageType,
    user_id: userId,
    message_id: 1000 + userId,
    message: text,
    group_id: groupId,
  }
}

describe('QQAdapter', () => {
  let originalWebSocket: typeof WebSocket
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalWebSocket = global.WebSocket as unknown as typeof WebSocket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.WebSocket = MockWebSocket as any
    fetchMock = vi.fn()
    global.fetch = fetchMock
  })

  afterEach(() => {
    global.WebSocket = originalWebSocket
    MockWebSocket.lastInstance = undefined
    vi.useRealTimers()
  })

  it('connects to the configured websocket URL', async () => {
    const adapter = new QQAdapter({
      config: { wsUrl: 'ws://localhost:3001', httpUrl: 'http://localhost:3001' },
      allowList: [],
      logger: { info() {}, error() {}, warn() {} },
    })

    const startPromise = adapter.start()
    const ws = MockWebSocket.lastInstance
    expect(ws).toBeDefined()
    expect(ws?.url).toBe('ws://localhost:3001')
    ws?.onopen?.()
    await startPromise
    adapter.stop()
  })

  it('uses access token in websocket headers when configured', async () => {
    const adapter = new QQAdapter({
      config: { wsUrl: 'ws://localhost:3001', httpUrl: 'http://localhost:3001', accessToken: 'secret' },
      allowList: [],
      logger: { info() {}, error() {}, warn() {} },
    })

    const startPromise = adapter.start()
    const ws = MockWebSocket.lastInstance
    expect(ws?.options?.headers?.Authorization).toBe('Bearer secret')
    ws?.onopen?.()
    await startPromise
    adapter.stop()
  })

  it('invokes handler for allowed users and sends replies', async () => {
    const adapter = new QQAdapter({
      config: { wsUrl: 'ws://localhost:3001', httpUrl: 'http://localhost:3001' },
      allowList: ['12345'],
      logger: { info() {}, error() {}, warn() {} },
    })

    adapter.onMessage(async (message) => {
      expect(message.from.id).toBe('12345')
      expect(message.content.text).toBe('hello')
      return { to: { userId: '12345' }, content: 'got it' }
    })

    const startPromise = adapter.start()
    const ws = MockWebSocket.lastInstance
    ws?.onopen?.()
    await startPromise

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', data: { message_id: 2000 } }),
    })

    ws?.onmessage?.({ data: JSON.stringify(createMessageEvent(12345, 'hello')) })

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/send_private_msg',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ user_id: 12345, message: 'got it' }),
      })
    )
    adapter.stop()
  })

  it('rejects users not in allowlist', async () => {
    const onUnauthorizedMessage = vi.fn(async () => ({ to: { userId: '99999' }, content: 'not allowed' }))
    const adapter = new QQAdapter({
      config: { wsUrl: 'ws://localhost:3001', httpUrl: 'http://localhost:3001' },
      allowList: ['12345'],
      logger: { info() {}, error() {}, warn() {} },
      onUnauthorizedMessage,
    })

    const startPromise = adapter.start()
    const ws = MockWebSocket.lastInstance
    ws?.onopen?.()
    await startPromise

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', data: { message_id: 2001 } }),
    })

    ws?.onmessage?.({ data: JSON.stringify(createMessageEvent(99999, 'hello')) })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(onUnauthorizedMessage).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/send_private_msg',
      expect.objectContaining({
        body: JSON.stringify({ user_id: 99999, message: 'not allowed' }),
      })
    )
    adapter.stop()
  })

  it('sends group replies', async () => {
    const adapter = new QQAdapter({
      config: { wsUrl: 'ws://localhost:3001', httpUrl: 'http://localhost:3001' },
      allowList: ['12345'],
      logger: { info() {}, error() {}, warn() {} },
    })

    adapter.onMessage(async () => ({ to: { chatId: '98765' }, content: 'group reply' }))

    const startPromise = adapter.start()
    const ws = MockWebSocket.lastInstance
    ws?.onopen?.()
    await startPromise

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', data: { message_id: 2002 } }),
    })

    ws?.onmessage?.({ data: JSON.stringify(createMessageEvent(12345, 'hello', 'group', 98765)) })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/send_group_msg',
      expect.objectContaining({
        body: JSON.stringify({ group_id: 98765, message: 'group reply' }),
      })
    )
    adapter.stop()
  })

  it('updateAllowList changes the runtime allowlist', async () => {
    const adapter = new QQAdapter({
      config: { wsUrl: 'ws://localhost:3001', httpUrl: 'http://localhost:3001' },
      allowList: ['12345'],
      logger: { info() {}, error() {}, warn() {} },
    })

    const handler = vi.fn(async () => ({ to: { userId: '67890' }, content: 'ok' }))
    adapter.onMessage(handler)
    adapter.updateAllowList(['12345', '67890'])

    const startPromise = adapter.start()
    const ws = MockWebSocket.lastInstance
    ws?.onopen?.()
    await startPromise

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    })

    ws?.onmessage?.({ data: JSON.stringify(createMessageEvent(67890, 'hello')) })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalled()
    adapter.stop()
  })
})
