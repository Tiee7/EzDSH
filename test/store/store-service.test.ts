import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StoreService } from '../../src/main/store/store-service'
import type { InstallState, StoreEntry } from '../../src/shared/store'

const workdirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-catalog-'))
  workdirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(workdirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function remoteEntry(overrides: Partial<StoreEntry> = {}): StoreEntry {
  return {
    id: 'brainstorming',
    kind: 'skill',
    name: 'Brainstorming (remote)',
    description: 'Remote version',
    category: 'workflow',
    auditLevel: 'verified',
    version: '9.9.9',
    ...overrides
  }
}

describe('offline catalog serving', () => {
  it('serves the bundled demo catalog without touching the remote client', async () => {
    const calls: string[] = []
    const service = new StoreService({
      client: {
        list: async () => { calls.push('list'); throw new Error('no network') },
        categories: async () => { calls.push('categories'); throw new Error('no network') }
      }
    })
    const list = await service.list('skill')
    expect(list.source).toBe('demo')
    expect(list.fetchedAt).toBeUndefined()
    expect(list.entries.length).toBeGreaterThan(0)
    const categories = await service.categories('skill')
    expect(categories.length).toBeGreaterThan(0)
    const entry = await service.entry('skill', list.entries[0]!.id)
    expect(entry.kind).toBe('skill')
    expect(calls).toEqual([])
  })

  it('filters the merged catalog locally by category and search', async () => {
    const service = new StoreService({ client: { list: async () => { throw new Error('no network') }, categories: async () => [] } })
    const quality = await service.list('skill', { category: 'quality' })
    expect(quality.total).toBe(quality.entries.length)
    expect(quality.entries.length).toBeGreaterThan(0)
    for (const entry of quality.entries) expect(entry.category).toBe('quality')
    const search = await service.list('skill', { search: 'commit' })
    expect(search.total).toBe(1)
    expect(search.entries.map((entry) => entry.id)).toEqual(['conventional-commits'])
  })

  it('returns only categories that contain entries for the requested kind', async () => {
    const service = new StoreService({ client: { list: async () => { throw new Error('no network') }, categories: async () => [] } })
    expect((await service.categories('skill')).map((row) => row.id)).toEqual(['workflow', 'quality', 'docs', 'git'])
    expect((await service.categories('preset')).map((row) => row.id)).toEqual(['research', 'coding', 'analysis'])
    expect((await service.categories('mcp')).map((row) => row.id)).toEqual(['tools'])
  })
})

describe('explicit catalog refresh', () => {
  it('refreshes only the requested catalog kind', async () => {
    const calls: string[] = []
    const service = new StoreService({
      client: {
        list: async (kind, query = {}) => {
          calls.push(`${kind}:${String(query.page ?? 1)}`)
          return kind === 'preset'
            ? { entries: [remoteEntry({ id: 'remote-preset', kind: 'preset' })], page: 1, pageCount: 1 }
            : { entries: [], page: 1, pageCount: 1 }
        },
        categories: async () => []
      }
    })

    const result = await service.refresh('preset')

    expect(result.counts.preset).toBe(1)
    expect(calls).toEqual(['preset:1'])
    expect((await service.list('preset')).entries.some((entry) => entry.id === 'remote-preset')).toBe(true)
  })

  it('loads every remote catalog page before serving local pagination', async () => {
    const calls: string[] = []
    const service = new StoreService({
      client: {
        list: async (kind, query = {}) => {
          calls.push(`${kind}:${String(query.page ?? 1)}`)
          if (kind === 'skill') {
            return query.page === 2
              ? { entries: [remoteEntry({ id: 'remote-page-2' })], page: 2, pageCount: 2 }
              : { entries: [remoteEntry()], page: 1, pageCount: 2 }
          }
          return { entries: [], page: 1, pageCount: 1 }
        },
        categories: async () => []
      }
    })

    const result = await service.refresh('skill')
    const list = await service.list('skill')
    expect(result.counts.skill).toBe(2)
    expect(list.entries.some((entry) => entry.id === 'remote-page-2')).toBe(true)
    expect(calls).toContain('skill:2')
  })

  it('serves catalog pages with twelve entries each', async () => {
    const remote = [
      'brainstorming',
      'systematic-debugging',
      'test-driven-development',
      'writing-plans',
      'verification-before-completion',
      'conventional-commits',
      'technical-documentation',
      ...Array.from({ length: 13 }, (_, index) => `remote-${String(index)}`)
    ].map((id) => remoteEntry({ id }))
    const service = new StoreService({
      client: {
        list: async (kind) => kind === 'skill'
          ? { entries: remote, page: 1, pageCount: 1 }
          : { entries: [], page: 1, pageCount: 1 },
        categories: async () => []
      }
    })
    await service.refresh('skill')

    const first = await service.list('skill', { page: 1 })
    const second = await service.list('skill', { page: 2 })
    const third = await service.list('skill', { page: 3 })
    expect(first.total).toBe(20)
    expect(first.pageCount).toBe(2)
    expect(first.entries).toHaveLength(12)
    expect(second.entries).toHaveLength(8)
    expect(third.entries).toHaveLength(0)
  })

  it('refresh() pulls the remote catalog, persists it, and serves it with a timestamp', async () => {
    const dir = await tempDir()
    const cachePath = join(dir, 'store-catalog.json')
    const remote = [remoteEntry(), remoteEntry({ id: 'remote-only', name: 'Remote Only' })]
    const service = new StoreService({
      catalogCachePath: cachePath,
      client: {
        list: async (kind) => kind === 'skill'
          ? { entries: remote, page: 1, pageCount: 1 }
          : { entries: [], page: 1, pageCount: 1 },
        categories: async () => [{ id: 'workflow', name: 'Workflow' }]
      }
    })
    const result = await service.refresh('skill')
    expect(result.counts.skill).toBe(2)

    const list = await service.list('skill')
    expect(list.source).toBeUndefined()
    expect(list.fetchedAt).toBe(result.fetchedAt)
    const byId = new Map(list.entries.map((entry) => [entry.id, entry]))
    expect(byId.get('brainstorming')?.version).toBe('9.9.9')
    expect(byId.get('remote-only')?.name).toBe('Remote Only')
    expect(await service.categories('skill')).toEqual([
      { id: 'workflow', name: '工作流程' },
      { id: 'quality', name: '代码质量' },
      { id: 'git', name: 'Git' },
      { id: 'docs', name: '文档' }
    ])

    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as { fetchedAt: string }
    expect(persisted.fetchedAt).toBe(result.fetchedAt)

    const reopened = new StoreService({
      catalogCachePath: cachePath,
      client: { list: async () => { throw new Error('no network') }, categories: async () => { throw new Error('no network') } }
    })
    const reopenedList = await reopened.list('skill')
    expect(reopenedList.fetchedAt).toBe(result.fetchedAt)
    expect(reopenedList.entries.some((entry) => entry.id === 'remote-only')).toBe(true)
  })

  it('keeps the previous catalog when refresh fails', async () => {
    const dir = await tempDir()
    const cachePath = join(dir, 'store-catalog.json')
    const service = new StoreService({
      catalogCachePath: cachePath,
      client: {
        list: async (kind) => kind === 'skill'
          ? { entries: [remoteEntry()], page: 1, pageCount: 1 }
          : { entries: [], page: 1, pageCount: 1 },
        categories: async () => []
      }
    })
    await service.refresh('skill')

    const broken = new StoreService({
      catalogCachePath: cachePath,
      client: { list: async () => { throw new Error('network down') }, categories: async () => { throw new Error('network down') } }
    })
    await expect(broken.refresh('skill')).rejects.toThrow(/network down/)
    const list = await broken.list('skill')
    expect(list.fetchedAt).toBeDefined()
    expect(list.entries.some((entry) => entry.id === 'brainstorming')).toBe(true)
  })
})

describe('StoreService misc', () => {
  it('reports install/uninstall as unavailable without a configured DSH home', async () => {
    const service = new StoreService()
    await expect(service.install('skill', 'demo')).rejects.toThrow(/not available in this build/)
    await expect(service.uninstall('skill', 'demo')).rejects.toThrow(/not available/)
    await expect(service.listInstalled()).rejects.toThrow(/not configured/)
  })

  it('lists an empty installed registry before any install has run', async () => {
    const dir = await tempDir()
    const service = new StoreService({ registryPath: join(dir, 'installed.json') })
    await expect(service.listInstalled()).resolves.toEqual({ records: [] })
  })

  it('publishes state events through the injected sink', () => {
    const seen: InstallState[] = []
    const service = new StoreService({ onStateChange: (state) => seen.push(state) })
    const state: InstallState = { kind: 'skill', id: 'demo', phase: 'downloading' }
    service.publish(state)
    expect(seen).toEqual([state])
  })
})
