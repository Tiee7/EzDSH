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
    const categories = await service.categories()
    expect(categories.length).toBeGreaterThan(0)
    const entry = await service.entry('skill', list.entries[0]!.id)
    expect(entry.kind).toBe('skill')
    expect(calls).toEqual([])
  })

  it('filters the merged catalog locally by category and search', async () => {
    const service = new StoreService({ client: { list: async () => { throw new Error('no network') }, categories: async () => [] } })
    const quality = await service.list('skill', { category: 'quality' })
    expect(quality.entries.length).toBeGreaterThan(0)
    for (const entry of quality.entries) expect(entry.category).toBe('quality')
    const search = await service.list('skill', { search: 'commit' })
    expect(search.entries.map((entry) => entry.id)).toEqual(['conventional-commits'])
  })
})

describe('explicit catalog refresh', () => {
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
    const result = await service.refresh()
    expect(result.counts.skill).toBe(2)

    const list = await service.list('skill')
    expect(list.source).toBeUndefined()
    expect(list.fetchedAt).toBe(result.fetchedAt)
    const byId = new Map(list.entries.map((entry) => [entry.id, entry]))
    expect(byId.get('brainstorming')?.version).toBe('9.9.9')
    expect(byId.get('remote-only')?.name).toBe('Remote Only')
    expect(await service.categories()).toEqual([{ id: 'workflow', name: 'Workflow' }])

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
    await service.refresh()

    const broken = new StoreService({
      catalogCachePath: cachePath,
      client: { list: async () => { throw new Error('network down') }, categories: async () => { throw new Error('network down') } }
    })
    await expect(broken.refresh()).rejects.toThrow(/network down/)
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
