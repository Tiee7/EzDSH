const ROUTE = '/api/ezdsh.chat-search'
const QUERY_LIMIT = 500
const PAGE_LIMIT = 100
const SEARCHABLE_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result']
const SEARCHABLE_SURFACES = ['current', 'shadowed']

export const inject = ['connection', 'sessionQuery', 'sessions']

/** Register the authenticated Host route for one-session Chat search. */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let payload
      try {
        payload = await request.json()
      } catch {
        return Response.json(failure('gateway/bad-request', 'Chat search body must be JSON'), { status: 400 })
      }
      const result = await handleSearch(ctx, payload, request.signal)
      return Response.json(result, { status: result.ok ? 200 : statusFor(result.error.code) })
    },
  })
}

async function handleSearch(ctx, payload, signal) {
  const request = parseRequest(payload)
  if (request.error !== undefined) return failure('gateway/bad-request', request.error)

  try {
    signal.throwIfAborted()
    const visible = await ctx.sessionQuery.listSessions(signal)
    const allowed = visible.some((record) =>
      record.header.id === request.sessionId && record.header.cwd !== undefined)
    if (!allowed) return failure('gateway/not-found', 'Session is not available')

    const hits = await searchStable(ctx.sessionQuery, request.sessionId, request.query, signal)
    const mapped = (await Promise.all(hits.map(async (hit) => {
      const observed = await ctx.sessionQuery.readEvent({
        sessionId: request.sessionId,
        seq: hit.seq,
      }, signal)
      const nodeKey = chatNodeKey(observed.target)
      return nodeKey === null ? null : {
        seq: hit.seq,
        type: hit.type,
        time: hit.time,
        snippet: hit.snippet,
        nodeKey,
      }
    }))).filter(Boolean)
    const byNode = new Map()
    for (const item of mapped) {
      const previous = byNode.get(item.nodeKey)
      if (previous === undefined || item.seq > previous.seq) byNode.set(item.nodeKey, item)
    }
    const items = [...byNode.values()].sort((left, right) => left.seq - right.seq)
    return { ok: true, value: { items } }
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') {
      return failure('gateway/cancelled', 'Chat search was cancelled')
    }
    if (error?.code === 'SESSION_QUERY_STALE_CURSOR') {
      return failure('session/search-stale', 'The conversation changed during search')
    }
    if (error?.code === 'SESSION_QUERY_SEARCH_DISABLED') {
      return failure('session/search-unavailable', 'Conversation search is unavailable')
    }
    return failure('gateway/internal', 'Conversation search failed')
  }
}

async function searchStable(sessionQuery, sessionId, query, signal) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await searchAll(sessionQuery, sessionId, query, signal)
    } catch (error) {
      if (error?.code !== 'SESSION_QUERY_STALE_CURSOR' || attempt >= 2) throw error
      signal.throwIfAborted()
    }
  }
}

async function searchAll(sessionQuery, sessionId, query, signal) {
  const items = []
  const cursors = new Set()
  let cursor
  do {
    signal.throwIfAborted()
    const page = await sessionQuery.searchEvents({
      sessionId,
      query,
      filters: [
        { kind: 'type', values: SEARCHABLE_TYPES },
        { kind: 'surface', values: SEARCHABLE_SURFACES },
      ],
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal })
    for (const item of page.items) {
      if (item.sessionId === sessionId
        && SEARCHABLE_TYPES.includes(item.type)
        && SEARCHABLE_SURFACES.includes(item.surface)) items.push(item)
    }
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('session search repeated a cursor')
      cursors.add(cursor)
    }
  } while (cursor !== undefined)
  return items
}

function parseRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'Chat search request must be an object' }
  }
  const sessionId = value.sessionId
  const rawQuery = value.query
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    return { error: 'Chat search sessionId is invalid' }
  }
  if (typeof rawQuery !== 'string') return { error: 'Chat search query must be text' }
  const query = rawQuery.trim().replace(/\s+/gu, ' ')
  if (query.length === 0 || query.length > QUERY_LIMIT || query.includes('\0')) {
    return { error: 'Chat search query is invalid' }
  }
  return { sessionId, query }
}

function chatNodeKey(event) {
  switch (event.type) {
    case 'user/message': {
      const source = event.data?.source
      if (source?.kind === 'plugin' && source.plugin === 'compact') return null
      const id = event.data?.id
      return typeof id === 'string' && id.length > 0
        ? contextKey('input-message', id)
        : null
    }
    case 'assistant/message': {
      const turn = event.data?.turn
      const step = event.data?.step
      return Number.isSafeInteger(turn) && turn >= 0
        && Number.isSafeInteger(step) && step >= 0
        ? contextKey('assistant-step', `${turn}:${step}`)
        : null
    }
    case 'tool/call': {
      const callId = event.data?.callId
      return typeof callId === 'string' && callId.length > 0
        ? contextKey('tool-call', callId)
        : null
    }
    case 'tool/result': {
      const callId = event.data?.message?.source?.callId
      return typeof callId === 'string' && callId.length > 0
        ? contextKey('tool-call', callId)
        : null
    }
    default:
      return null
  }
}

function contextKey(kind, id) {
  return `${kind.length}:${kind}${id}`
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

function statusFor(code) {
  if (code === 'gateway/bad-request') return 400
  if (code === 'gateway/not-found') return 404
  if (code === 'gateway/cancelled') return 499
  if (code === 'session/search-stale') return 409
  if (code === 'session/search-unavailable') return 503
  return 500
}

export const internals = {
  ROUTE,
  chatNodeKey,
  contextKey,
  handleSearch,
  parseRequest,
  searchAll,
  searchStable,
}
