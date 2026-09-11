import { describe, expect, it, vi } from 'vitest'
import { apply, inject, internals } from '../../../plugins/chat-search/src/index.js'

interface RpcResult {
  ok: boolean
  value?: { items: Array<{ seq: number; nodeKey: string }> }
  error?: { code: string }
}

function event(type: string, seq: number, data: Record<string, unknown>): Record<string, unknown> {
  return { type, seq, time: seq + 10, data }
}

function harness(options: { visible?: boolean } = {}) {
  let route: {
    path: string
    methods: string[]
    requestBody: string
    fetch: (request: Request) => Promise<Response>
  } | undefined
  const pages = new Map<unknown, { items: unknown[]; nextCursor?: string }>([
    [undefined, {
      items: [
        { sessionId: 's1', seq: 8, type: 'tool/result', time: 18, surface: 'current', snippet: 'needle result' },
        { sessionId: 's1', seq: 6, type: 'tool/call', time: 16, surface: 'current', snippet: 'needle call' },
        { sessionId: 's1', seq: 5, type: 'assistant/message', time: 15, surface: 'current', snippet: 'needle answer' },
      ],
      nextCursor: 'next',
    }],
    ['next', {
      items: [
        { sessionId: 's1', seq: 2, type: 'user/message', time: 12, surface: 'shadowed', snippet: 'needle prompt' },
        { sessionId: 'other', seq: 1, type: 'user/message', time: 11, surface: 'current', snippet: 'must be rejected' },
      ],
    }],
  ])
  const events = new Map<number, Record<string, unknown>>([
    [2, event('user/message', 2, { id: 'message-2', source: { kind: 'user' } })],
    [5, event('assistant/message', 5, { turn: 1, step: 0 })],
    [6, event('tool/call', 6, { callId: 'call-7' })],
    [8, event('tool/result', 8, { message: { source: { callId: 'call-7' } } })],
  ])
  const searchEvents = vi.fn(async (request: { cursor?: string }) => pages.get(request.cursor) ?? { items: [] })
  const readEvent = vi.fn(async (request: { seq: number }) => ({ target: events.get(request.seq) }))
  const listSessions = vi.fn(async () => options.visible === false
    ? []
    : [{ header: { id: 's1', cwd: '/workspace' } }])
  const ctx = {
    connection: {
      fetch: {
        register: (next: typeof route) => {
          route = next
          return async () => {}
        },
      },
    },
    sessionQuery: { listSessions, searchEvents, readEvent },
  }
  apply(ctx as never)
  return {
    call: (payload: unknown): Promise<RpcResult> => internals.handleSearch(
      ctx,
      payload,
      new AbortController().signal,
    ),
    get route() { return route },
    listSessions,
    readEvent,
    searchEvents,
  }
}

describe('@ezdsh/chat-search Host half', () => {
  it('declares the services used by the Host operation and registers an authenticated API route', () => {
    expect(inject).toEqual(['connection', 'sessionQuery', 'sessions'])
    const runtime = harness()
    expect(runtime.route).toMatchObject({
      path: '/api/ezdsh.chat-search',
      methods: ['POST'],
      requestBody: 'buffered',
    })
  })

  it('exhausts ranked pages, postvalidates hits, maps Chat keys, and returns transcript order', async () => {
    const runtime = harness()
    const result = await runtime.call({ sessionId: 's1', query: ' needle ' })

    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          { seq: 2, type: 'user/message', time: 12, snippet: 'needle prompt', nodeKey: '13:input-messagemessage-2' },
          { seq: 5, type: 'assistant/message', time: 15, snippet: 'needle answer', nodeKey: '14:assistant-step1:0' },
          { seq: 8, type: 'tool/result', time: 18, snippet: 'needle result', nodeKey: '9:tool-callcall-7' },
        ],
      },
    })
    expect(runtime.searchEvents).toHaveBeenCalledTimes(2)
    expect(runtime.searchEvents.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 's1',
      query: 'needle',
      filters: [
        { kind: 'type', values: ['user/message', 'assistant/message', 'tool/call', 'tool/result'] },
        { kind: 'surface', values: ['current', 'shadowed'] },
      ],
    })
    expect(runtime.readEvent).toHaveBeenCalledTimes(4)
  })

  it('rejects malformed requests before touching the search index', async () => {
    const runtime = harness()
    await expect(runtime.call({ sessionId: '', query: 'needle' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/bad-request' },
    })
    expect(runtime.searchEvents).not.toHaveBeenCalled()
  })

  it('does not search a session outside the visible Web corpus', async () => {
    const runtime = harness({ visible: false })
    await expect(runtime.call({ sessionId: 's1', query: 'needle' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/not-found' },
    })
    expect(runtime.searchEvents).not.toHaveBeenCalled()
  })

  it('returns HTTP JSON errors for malformed bodies', async () => {
    const runtime = harness()
    const response = await runtime.route!.fetch(new Request('http://dsh.local/api/ezdsh.chat-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/bad-request' },
    })
  })

  it('restarts a search that races with a changing Session index', async () => {
    const stale = Object.assign(new Error('stale'), { code: 'SESSION_QUERY_STALE_CURSOR' })
    const searchEvents = vi.fn()
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({ items: [] })
    await expect(internals.searchStable(
      { searchEvents },
      's1',
      'needle',
      new AbortController().signal,
    )).resolves.toEqual([])
    expect(searchEvents).toHaveBeenCalledTimes(2)
  })

  it('maps compact checkpoints and malformed events to no Chat node', () => {
    expect(internals.chatNodeKey(event('user/message', 1, {
      id: 'compact', source: { kind: 'plugin', plugin: 'compact' },
    }))).toBeNull()
    expect(internals.chatNodeKey(event('assistant/message', 2, { turn: -1, step: 0 }))).toBeNull()
    expect(internals.chatNodeKey(event('tool/call', 3, { callId: '' }))).toBeNull()
  })
})
