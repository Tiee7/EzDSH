import { describe, expect, it, vi } from 'vitest'
import { DshSessionClient } from '../../src/main/channel-bridge/dsh-session.js'

function ok<T>(value: T): { result: { ok: true; value: T } } {
  return { result: { ok: true, value } }
}

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
    const mockFetch = createMockFetch([ok({ sessionId: 'session-1' })])()
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })
    vi.stubGlobal('fetch', mockFetch)

    const session = await client.createSession({ cwd: '/work' })
    expect(session.sessionId).toBe('session-1')

    vi.unstubAllGlobals()
  })

  it('exchanges a tokenized Runtime URL once before calling the RC1 model catalog route with its auth cookie', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      if (requests.length === 1) {
        return {
          ok: false,
          status: 303,
          headers: new Headers({ 'set-cookie': 'dsh-auth-session=authenticated; HttpOnly; Path=/' }),
          json: async () => undefined,
          text: async () => '',
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ok({ groups: [], failures: [] }),
        text: async () => '',
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://127.0.0.1:4567/?token=runtime-token', timeoutMs: 1000 })

    await expect(client.getModelCatalog()).resolves.toEqual({ groups: [], failures: [] })

    expect(requests).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:4567/?token=runtime-token', init: expect.objectContaining({ method: 'GET' }) }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/modelCatalog',
        init: expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Cookie: 'dsh-auth-session=authenticated' }),
        }),
      }),
    ])
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(expect.objectContaining({
      type: 'client-request',
      method: 'session/modelCatalog',
      payload: { args: {} },
    }))

    vi.unstubAllGlobals()
  })

  it('maps RC1 session and workspace commands to slash routes with named request arguments', async () => {
    const requests: Array<{ url: string; body?: { method: string; payload: { args: Record<string, unknown> } } }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'GET') {
        return {
          ok: false,
          status: 303,
          headers: new Headers({ 'set-cookie': 'dsh-auth-session=authenticated; HttpOnly; Path=/' }),
          text: async () => '',
        } as Response
      }
      const body = JSON.parse(String(init?.body)) as { method: string; payload: { args: Record<string, unknown> } }
      requests.push({ url, body })
      const value = body.method === 'session/create'
        ? { sessionId: 'session-1' }
        : body.method === 'session/list'
          ? { items: [] }
          : body.method === 'session/selectModel'
            ? { selected: { provider: 'deepseek', model: 'deepseek-v4-pro' } }
            : body.method === 'session/rename'
              ? { title: 'Renamed session', seq: 1 }
        : body.method === 'workspace/create'
          ? { workspace: { workspaceId: 'workspace-1', path: '/work', title: 'Work', sessionIds: [], createdAt: 'now', updatedAt: 'now' }, created: true }
          : body.method === 'workspace/rename'
            ? { workspace: { workspaceId: 'workspace-1', path: '/work', title: 'Renamed', sessionIds: [], createdAt: 'now', updatedAt: 'now' } }
            : { accepted: true }
      return { ok: true, status: 200, json: async () => ok(value), text: async () => '' } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://127.0.0.1:4567/?token=runtime-token', timeoutMs: 1000 })

    await client.createSession({ sessionId: 'session-1', cwd: '/work' })
    await client.queuePrompt('session-1', 'hello')
    await client.renameSession('session-1', 'Renamed session')
    await client.selectSessionModel('session-1', { provider: 'deepseek', model: 'deepseek-v4-pro' })
    await client.listSessions()
    await client.cancelSession('session-1')
    await client.archiveSession('session-1')
    await client.createWorkspace('/work')
    await client.renameWorkspace('workspace-1', 'Renamed')

    expect(requests).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/create',
        body: expect.objectContaining({ method: 'session/create', payload: { args: { request: { sessionId: 'session-1', cwd: '/work' } } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/prompt',
        body: expect.objectContaining({ method: 'session/prompt', payload: { args: { request: expect.objectContaining({ sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }], requestId: expect.any(String) }) } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/rename',
        body: expect.objectContaining({ method: 'session/rename', payload: { args: { request: { sessionId: 'session-1', title: 'Renamed session' } } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/selectModel',
        body: expect.objectContaining({ method: 'session/selectModel', payload: { args: { request: { sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-v4-pro' } } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/list',
        body: expect.objectContaining({ method: 'session/list', payload: { args: { _request: {} } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/cancel',
        body: expect.objectContaining({ method: 'session/cancel', payload: { args: { request: { sessionId: 'session-1' } } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/workspace/archiveSession',
        body: expect.objectContaining({ method: 'workspace/archiveSession', payload: { args: { request: { sessionId: 'session-1' } } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/workspace/create',
        body: expect.objectContaining({ method: 'workspace/create', payload: { args: { request: { path: '/work' } } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/workspace/rename',
        body: expect.objectContaining({ method: 'workspace/rename', payload: { args: { request: { workspaceId: 'workspace-1', title: 'Renamed' } } } }),
      }),
    ])
    vi.unstubAllGlobals()
  })

  it('maps RC1 history through the session-list projection cursor to a session page', async () => {
    const requests: Array<{ url: string; body?: { method: string; payload: { args: Record<string, unknown> } } }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'GET') return {
        ok: false,
        status: 303,
        headers: new Headers({ 'set-cookie': 'dsh-auth-session=authenticated; HttpOnly; Path=/' }),
        text: async () => '',
      } as Response
      const body = JSON.parse(String(init?.body)) as { method: string; payload: { args: Record<string, unknown> } }
      requests.push({ url, body })
      if (body.method === 'session/list') {
        return {
          ok: true,
          status: 200,
          json: async () => ok({
            items: [{
              sessionId: 'session-1',
              updatedAt: 1,
              running: false,
              projections: { asOfSeq: 7, values: {} },
            }],
          }),
          text: async () => '',
        } as Response
      }
      return { ok: true, status: 200, json: async () => ok({ records: [{ type: 'event', event: { type: 'turn/end', seq: 7, time: 1, data: {} } }], hasMore: false }), text: async () => '' } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://127.0.0.1:4567/?token=runtime-token', timeoutMs: 1000 })

    await expect(client.getSessionHistory('session-1', { beforeSeq: 3, maxMessages: 20 })).resolves.toMatchObject({
      events: [{ event: { type: 'turn/end', seq: 7 } }],
      hasMore: false,
    })
    expect(requests).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/list',
        body: expect.objectContaining({ method: 'session/list', payload: { args: { _request: {} } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/page',
        body: expect.objectContaining({ method: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 7, beforeSeq: 3, maxMessages: 20 } } } }),
      }),
    ])
    vi.unstubAllGlobals()
  })

  it('completes an RC1 prompt by polling the session-list cursor and pages', async () => {
    const requests: Array<{ url: string; body?: { method: string; payload: { args: Record<string, unknown> } } }> = []
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'GET') return {
        ok: false,
        status: 303,
        headers: new Headers({ 'set-cookie': 'dsh-auth-session=authenticated; HttpOnly; Path=/' }),
        text: async () => '',
      } as Response
      const body = JSON.parse(String(init?.body)) as { method: string; payload: { args: Record<string, unknown> } }
      requests.push({ url, body })
      if (body.method === 'session/list') {
        listCalls++
        return {
          ok: true,
          status: 200,
          json: async () => ok({
            items: [{
              sessionId: 'session-1',
              updatedAt: listCalls,
              running: listCalls > 1,
              projections: { asOfSeq: listCalls === 1 ? 1 : 5, values: {} },
            }],
          }),
          text: async () => '',
        } as Response
      }
      if (body.method === 'session/prompt') {
        return { ok: true, status: 200, json: async () => ok({ accepted: true }), text: async () => '' } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ok({
          records: [
            {
              type: 'event',
              event: {
                type: 'assistant/message',
                seq: 4,
                time: 4,
                data: { message: { role: 'assistant', content: [{ type: 'text', text: 'rc1 answer' }] } },
              },
            },
            { type: 'event', event: { type: 'turn/end', seq: 5, time: 5, data: {} } },
          ],
          hasMore: false,
        }), text: async () => '',
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://127.0.0.1:4567/?token=runtime-token', timeoutMs: 1000, pollIntervalMs: 1 })
    const deltas: string[] = []
    const completed: string[] = []

    await client.sendPromptAsync(
      'session-1',
      'hi',
      {
        onAcknowledged: () => {},
        onDelta: (text) => deltas.push(text),
        onProgress: () => {},
        onComplete: (text) => completed.push(text),
        onError: (error) => { throw new Error(error) },
      },
      { timeoutMs: 1000, statusIntervalMs: 1000 },
    )

    expect(deltas).toEqual(['rc1 answer'])
    expect(completed).toEqual(['rc1 answer'])
    expect(requests).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/list',
        body: expect.objectContaining({ method: 'session/list', payload: { args: { _request: {} } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/prompt',
        body: expect.objectContaining({
          method: 'session/prompt',
          payload: { args: { request: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }], requestId: expect.any(String) } } },
        }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/list',
        body: expect.objectContaining({ method: 'session/list', payload: { args: { _request: {} } } }),
      }),
      expect.objectContaining({
        url: 'http://127.0.0.1:4567/api/session/page',
        body: expect.objectContaining({ method: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 5 } } } }),
      }),
    ])
    vi.unstubAllGlobals()
  })

  it('fails clearly for RC1 operations that still have no compatible endpoint', async () => {
    const client = new DshSessionClient({ baseUrl: 'http://127.0.0.1:4567/?token=runtime-token', timeoutMs: 1000 })

    await expect(client.unarchiveSession('session-1')).rejects.toThrow(/does not provide.*unarchive/i)
    await expect(client.getSessionModels('session-1')).rejects.toThrow(/does not provide.*per-session model/i)
  })

  it('lists native DSH workspaces', async () => {
    const mockFetch = createMockFetch([
      ok({
        items: [
          {
            workspaceId: 'workspace-1',
            path: '/work',
            title: 'Work',
            sessionIds: ['session-1', 'session-archived'],
            createdAt: '2026-01-01',
            updatedAt: '2026-01-02',
          },
        ],
        archivedSessionIds: ['session-archived'],
      }),
    ])()
    vi.stubGlobal('fetch', mockFetch)
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.listWorkspaces()).resolves.toEqual([
      {
        workspaceId: 'workspace-1',
        path: '/work',
        title: 'Work',
        sessionIds: ['session-1'],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
      },
    ])

    vi.unstubAllGlobals()
  })

  it('creates a session inside a DSH workspace and queues a prompt', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    let responseIndex = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
      requests.push(request)
      const body = [
        ok({ sessionId: 'session-2' }),
        ok({ accepted: true }),
      ][Math.min(responseIndex++, 1)]
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.createSession({ cwd: '/work', workspaceId: 'workspace-1' })).resolves.toEqual({ sessionId: 'session-2' })
    expect(requests[0]?.payload).toEqual({ workspaceId: 'workspace-1' })
    await expect(client.queuePrompt('session-2', '完成任务')).resolves.toEqual({ accepted: true })

    vi.unstubAllGlobals()
  })

  it('renames a session through the DSH session API', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
      requests.push(request)
      const response = ok({ title: '新会话', seq: 1 })
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.renameSession('session-1', '新会话')).resolves.toBeUndefined()
    expect(requests).toEqual([expect.objectContaining({ method: 'session.rename', payload: { sessionId: 'session-1', title: '新会话' } })])

    vi.unstubAllGlobals()
  })

  it('loads and selects a session model', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
      requests.push(request)
      const value = request.method === 'session.models'
        ? {
            current: { provider: 'deepseek', model: 'deepseek-v4-flash' },
            routable: true,
            groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }],
            failures: [],
          }
        : { selected: { provider: 'deepseek', model: 'deepseek-v4-pro' } }
      const response = ok(value)
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.getSessionModels('session-1')).resolves.toMatchObject({
      current: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      groups: [{ models: [{ id: 'deepseek-v4-pro' }] }],
    })
    await expect(client.selectSessionModel('session-1', { provider: 'deepseek', model: 'deepseek-v4-pro' })).resolves.toEqual({
      selected: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    })
    expect(requests).toEqual([
      expect.objectContaining({ method: 'session.models', payload: { sessionId: 'session-1' } }),
      expect.objectContaining({ method: 'session.selectModel', payload: { sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-v4-pro' } }),
    ])

    vi.unstubAllGlobals()
  })

  it('loads the host-wide Runtime model catalog without creating a session', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
      requests.push(request)
      const response = ok({
        groups: [{ id: 'openai-codex', name: 'OpenAI Codex', models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }] }],
        failures: [],
      })
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.getModelCatalog()).resolves.toEqual({
      groups: [{ id: 'openai-codex', name: 'OpenAI Codex', models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }] }],
      failures: [],
    })
    expect(requests).toEqual([expect.objectContaining({ method: 'llm.models', payload: {} })])

    vi.unstubAllGlobals()
  })

  it('cancels a running DSH session', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
      requests.push(request)
      const body = ok({ accepted: true })
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response
    })
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.cancelSession('session-1')).resolves.toBeUndefined()
    expect(requests).toEqual([expect.objectContaining({ method: 'session.cancel', payload: { sessionId: 'session-1' } })])

    vi.unstubAllGlobals()
  })

  it('unarchives a session through the DSH workspace API', async () => {
    const mockFetch = createMockFetch([
      ok({ archivedSessionIds: [] }),
    ])()
    vi.stubGlobal('fetch', mockFetch)
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.unarchiveSession('session-2')).resolves.toEqual({ archivedSessionIds: [] })

    vi.unstubAllGlobals()
  })

  it('lists only sessions that are in the workspace archive set', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string }
      methods.push(body.method)

      if (body.method === 'workspace.list') {
        return {
          ok: true,
          status: 200,
          json: async () => ok({
            items: [],
            archivedSessionIds: ['session-archived'],
          }),
        } as Response
      }

      if (body.method === 'session.list') {
        return {
          ok: true,
          status: 200,
          json: async () => ok({
            items: [
              {
                sessionId: 'session-visible',
                updatedAt: 2,
                running: false,
                projections: { values: { title: 'Visible' } },
              },
              {
                sessionId: 'session-archived',
                updatedAt: 1,
                running: false,
                projections: { values: { title: 'Archived' } },
              },
            ],
          }),
        } as Response
      }

      throw new Error(`unexpected request: ${body.method}`)
    })
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })

    await expect(client.listArchivedSessions()).resolves.toEqual([
      { sessionId: 'session-archived', updatedAt: 1, running: false, title: 'Archived' },
    ])
    expect(methods).toEqual(['workspace.list', 'session.list'])

    vi.unstubAllGlobals()
  })

  it('lists sessions with titles', async () => {
    const mockFetch = createMockFetch([
      ok({
        items: [
          { sessionId: 'session-1', updatedAt: 1, running: true },
          { sessionId: 'session-2', updatedAt: 2, running: false, blank: true },
        ],
      }),
      ok({
        events: [
          { event: { type: 'session/title', seq: 1, time: 1, data: { title: 'Project Alpha' } } },
        ],
        hasMore: false,
      }),
      ok({
        events: [
          { event: { type: 'session/title', seq: 2, time: 2, data: { title: 'Old' } } },
          { event: { type: 'session/title', seq: 5, time: 5, data: { title: 'Project Beta' } } },
        ],
        hasMore: false,
      }),
    ])()
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })
    vi.stubGlobal('fetch', mockFetch)

    const sessions = await client.listSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toEqual({ sessionId: 'session-1', updatedAt: 1, running: true, title: 'Project Alpha' })
    expect(sessions[1]).toEqual({ sessionId: 'session-2', updatedAt: 2, running: false, blank: true, title: 'Project Beta' })

    vi.unstubAllGlobals()
  })

  it('uses session list title projections without loading session history', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      const body = JSON.parse(String(init?.body)) as { method: string; payload: { sessionId?: string } }

      if (body.method === 'session.list') {
        return {
          ok: true,
          status: 200,
          json: async () => ok({
            items: [
              {
                sessionId: 'session-projected',
                updatedAt: 1,
                running: false,
                projections: { values: { title: '来自 projection 的标题' } },
              },
              {
                sessionId: 'session-projected-without-title',
                updatedAt: 2,
                running: false,
                projections: { values: { title: null } },
              },
              { sessionId: 'session-fallback', updatedAt: 3, running: false },
            ],
          }),
        } as Response
      }

      if (body.method === 'session.history' && body.payload.sessionId === 'session-fallback') {
        return {
          ok: true,
          status: 200,
          json: async () => ok({
            events: [
              { event: { type: 'session/title', seq: 1, time: 1, data: { title: '来自 history 的标题' } } },
            ],
            hasMore: false,
          }),
        } as Response
      }

      throw new Error(`unexpected request: ${body.method} ${body.payload.sessionId ?? ''}`)
    })

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000 })
    await expect(client.listSessions()).resolves.toEqual([
      { sessionId: 'session-projected', updatedAt: 1, running: false, title: '来自 projection 的标题' },
      { sessionId: 'session-projected-without-title', updatedAt: 2, running: false, title: undefined },
      { sessionId: 'session-fallback', updatedAt: 3, running: false, title: '来自 history 的标题' },
    ])
    expect(requests.filter((url) => url.endsWith('/api/session.history'))).toHaveLength(1)

    vi.unstubAllGlobals()
  })

  it('sends a prompt and extracts assistant text', async () => {
    const historyBefore = ok({ events: [] })
    const promptResponse = ok({ accepted: true })
    const historyDuring = ok({
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
    })

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    const result = await client.sendPrompt('session-1', 'hi')
    expect(result.text).toBe('hello world')

    vi.unstubAllGlobals()
  })

  it('reports assistant text deltas while a turn is running', async () => {
    const historyBefore = ok({ events: [] })
    const promptResponse = ok({ accepted: true })
    const historyDuring = ok({
      events: [
        {
          event: {
            type: 'assistant/message',
            seq: 1,
            time: 1,
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '第一段' }],
              },
            },
          },
        },
        {
          event: {
            type: 'assistant/message',
            seq: 2,
            time: 2,
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '第二段' }],
              },
            },
          },
        },
        { event: { type: 'turn/end', seq: 3, time: 3, data: {} } },
      ],
      hasMore: false,
    })

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const deltas: string[] = []
    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    await client.sendPromptAsync(
      'session-1',
      'hi',
      {
        onAcknowledged: () => {},
        onDelta: (text) => deltas.push(text),
        onProgress: () => {},
        onComplete: (text) => expect(text).toBe('第一段第二段'),
        onError: (error) => { throw new Error(error) },
      },
      { timeoutMs: 1000, statusIntervalMs: 1000 },
    )

    expect(deltas).toEqual(['第一段', '第二段'])
    vi.unstubAllGlobals()
  })

  it('filters out reasoning blocks', async () => {
    const historyBefore = ok({ events: [] })
    const promptResponse = ok({ accepted: true })
    const historyDuring = ok({
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
    })

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    const result = await client.sendPrompt('session-1', 'hi')
    expect(result.text).toBe('final answer')

    vi.unstubAllGlobals()
  })

  it('ignores assistant messages from previous turns', async () => {
    const historyBefore = ok({
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
    })
    const promptResponse = ok({ accepted: true })
    const historyDuring = ok({
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
    })

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 1000, pollIntervalMs: 10 })
    const result = await client.sendPrompt('session-1', 'hi')
    expect(result.text).toBe('new answer')

    vi.unstubAllGlobals()
  })

  it('throws when the turn times out', async () => {
    const historyBefore = ok({ events: [] })
    const promptResponse = ok({ accepted: true })
    const historyDuring = ok({ events: [] })

    const mockFetch = createMockFetch([historyBefore, promptResponse, historyDuring])()
    vi.stubGlobal('fetch', mockFetch)

    const client = new DshSessionClient({ baseUrl: 'http://localhost', timeoutMs: 50, pollIntervalMs: 10 })
    await expect(client.sendPrompt('session-1', 'hi')).rejects.toThrow('DSH session turn timed out')

    vi.unstubAllGlobals()
  })
})
