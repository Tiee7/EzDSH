import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoreClient } from '../../src/main/store/store-client'
import type { StoreEntry } from '../../src/shared/store'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const sampleEntry: StoreEntry = {
  id: 'demo',
  kind: 'skill',
  name: 'Demo',
  description: 'Demo skill',
  category: 'demo',
  auditLevel: 'verified',
  version: '1.0.0',
  files: [{ path: 'demo/SKILL.md', url: 'https://files.example.com/SKILL.md', sha256: 'ab'.repeat(32), kind: 'text' }]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StoreClient list', () => {
  it('queries the store endpoint with kind and paging and returns parsed entries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [sampleEntry], page: 1, pageCount: 3 }))
    const client = new StoreClient({ fetchImpl })
    const result = await client.list('skill', { page: 1 })
    expect(result.pageCount).toBe(3)
    expect(result.entries[0]?.id).toBe('demo')
    const calledUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]))
    expect(calledUrl.pathname).toBe('/v1/hub')
    expect(calledUrl.searchParams.get('kind')).toBe('skill')
    expect(calledUrl.searchParams.get('page')).toBe('1')
    expect(calledUrl.hostname).toBe('hub.ezdsh.com')
    expect(calledUrl.protocol).toBe('https:')
  })

  it('rejects non-200 responses with the status code', async () => {
    const client = new StoreClient({ fetchImpl: async () => jsonResponse({ error: 'boom' }, 503) })
    await expect(client.list('skill')).rejects.toThrow(/503/)
  })

  it('serves a repeat call from cache without refetching', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [], page: 1, pageCount: 1 }))
    const client = new StoreClient({ fetchImpl })
    await client.list('mcp')
    await client.list('mcp')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refetches after the cache entry expires', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entries: [], page: 1, pageCount: 1 }))
    const client = new StoreClient({ fetchImpl, cacheTtlMs: 5 })
    await client.list('mcp')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await client.list('mcp')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('aborts a fetch that exceeds the timeout', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const client = new StoreClient({ fetchImpl, timeoutMs: 20 })
    await expect(client.list('skill')).rejects.toThrow()
  })
})

describe('StoreClient entry detail', () => {
  it('fetches a single entry by kind and id without caching detail pages', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => jsonResponse(String(url).includes('/v1/hub/skill/demo') ? sampleEntry : {}))
    const client = new StoreClient({ fetchImpl })
    const entry = await client.entry('skill', 'demo')
    expect(entry.id).toBe('demo')
    await client.entry('skill', 'demo')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects an entry whose kind mismatches the request', async () => {
    const client = new StoreClient({ fetchImpl: async () => jsonResponse({ ...sampleEntry, kind: 'preset' }) })
    await expect(client.entry('skill', 'demo')).rejects.toThrow(/kind/)
  })
})

describe('StoreClient categories', () => {
  it('returns the parsed category list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 'office', name: '效率办公' }]))
    const client = new StoreClient({ fetchImpl })
    const categories = await client.categories()
    expect(categories[0]).toEqual({ id: 'office', name: '效率办公' })
  })
})
