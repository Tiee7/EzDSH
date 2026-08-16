import { describe, expect, it, vi } from 'vitest'
import { StoreService } from '../../src/main/store/store-service'
import type { InstallState, StoreEntry } from '../../src/shared/store'

function sampleEntry(): StoreEntry {
  return {
    id: 'demo',
    kind: 'skill',
    name: 'Demo',
    description: 'Demo skill',
    category: 'demo',
    auditLevel: 'verified',
    version: '1.0.0'
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('StoreService read-only delegation', () => {
  it('delegates list, entry, and categories to the client', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/categories') return jsonResponse([{ id: 'office', name: '办公' }])
      if (path === '/v1/store/skill/demo') return jsonResponse(sampleEntry())
      return jsonResponse({ entries: [sampleEntry()], page: 1, pageCount: 1 })
    })
    const service = new StoreService({ client: new (await import('../../src/main/store/store-client')).StoreClient({ fetchImpl }) })
    const list = await service.list('skill')
    expect(list.entries[0]?.id).toBe('demo')
    const entry = await service.entry('skill', 'demo')
    expect(entry.name).toBe('Demo')
    const categories = await service.categories()
    expect(categories[0]?.id).toBe('office')
  })

  it('reports install/uninstall as unavailable without a configured DSH home', async () => {
    const service = new StoreService()
    await expect(service.install('skill', 'demo')).rejects.toThrow(/not available in this build/)
    await expect(service.uninstall('skill', 'demo')).rejects.toThrow(/not available/)
    await expect(service.listInstalled()).rejects.toThrow(/not available/)
  })

  it('publishes state events through the injected sink', () => {
    const seen: InstallState[] = []
    const service = new StoreService({ onStateChange: (state) => seen.push(state) })
    const state: InstallState = { kind: 'skill', id: 'demo', phase: 'downloading' }
    service.publish(state)
    expect(seen).toEqual([state])
  })
})
