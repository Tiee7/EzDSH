import { describe, expect, it, vi } from 'vitest'
import { DshSessionClient } from '../../src/main/channel-bridge/dsh-session.js'

function createMockFetch(responses: unknown[]): () => typeof fetch {
  return () => {
    let index = 0
    return async (): Promise<Response> => {
      const body = responses[Math.min(index++, responses.length - 1)]
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response
    }
  }
}

describe('DshSessionClient', () => {
  it('creates a session', async () => {
    const mockFetch = createMockFetch([{ sessionId: 'session-1' }])()
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })
    vi.stubGlobal('fetch', mockFetch)

    const session = await client.createSession({ cwd: '/work' })
    expect(session.sessionId).toBe('session-1')

    vi.unstubAllGlobals()
  })

  it('sends a prompt and extracts assistant text', async () => {
    const historyBefore = { events: [] }
    const promptResponse = { accepted: true }
    const historyDuring = {
      events: [
        { event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
        { event: { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } },
        { event: { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } } },
        {
          event: {
            type: 'assistant/message',
            seq: 3,
            time: 4,
            data: {
              turn: 1,
              step: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hello world' }],
              },
            },
          },
        },
        { event: { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } } },
        { event: { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } } },
      ],
      hasMore: false,
    }

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    const result = await client.sendPrompt('session-1', 'hi')
    expect(result.text).toBe('hello world')

    vi.unstubAllGlobals()
  })

  it('filters out reasoning blocks', async () => {
    const historyBefore = { events: [] }
    const promptResponse = { accepted: true }
    const historyDuring = {
      events: [
        {
          event: {
            type: 'assistant/message',
            seq: 3,
            time: 4,
            data: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: 'thinking...' },
                  { type: 'text', text: 'final answer' },
                ],
              },
            },
          },
        },
        { event: { type: 'turn/end', seq: 5, time: 6, data: {} } },
      ],
      hasMore: false,
    }

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    const result = await client.sendPrompt('session-1', 'hi')
    expect(result.text).toBe('final answer')

    vi.unstubAllGlobals()
  })

  it('ignores assistant messages from previous turns', async () => {
    const historyBefore = {
      events: [
        {
          event: {
            type: 'assistant/message',
            seq: 3,
            time: 4,
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'old answer' }],
              },
            },
          },
        },
      ],
    }
    const promptResponse = { accepted: true }
    const historyDuring = {
      events: [
        {
          event: {
            type: 'assistant/message',
            seq: 4,
            time: 5,
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'new answer' }],
              },
            },
          },
        },
        { event: { type: 'turn/end', seq: 5, time: 6, data: {} } },
      ],
      hasMore: false,
    }

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    const result = await client.sendPrompt('session-1', 'hi')
    expect(result.text).toBe('new answer')

    vi.unstubAllGlobals()
  })

  it('throws when the turn times out', async () => {
    const historyBefore = { events: [] }
    const promptResponse = { accepted: true }
    const historyDuring = { events: [] }

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 50, pollIntervalMs: 10 })
    await expect(client.sendPrompt('session-1', 'hi')).rejects.toThrow('DSH session turn timed out')

    vi.unstubAllGlobals()
  })
})
