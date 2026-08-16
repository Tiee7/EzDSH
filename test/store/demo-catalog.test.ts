import { describe, expect, it } from 'vitest'
import { auditBundle, auditMcpConfig } from '../../src/main/store/audit'
import { downloadBundle } from '../../src/main/store/downloader'
import {
  DEMO_FILE_URL_PREFIX,
  createDemoFetch,
  demoCategories,
  demoEntry,
  demoList,
  withDemoFallback
} from '../../src/main/store/demo-catalog'
import type { StoreEntry } from '../../src/shared/store'

const skillEntries = demoList('skill').entries
const mcpEntries = demoList('mcp').entries

describe('demo catalog listing', () => {
  it('serves skill and mcp surfaces marked with the demo source', () => {
    expect(skillEntries.length).toBeGreaterThanOrEqual(5)
    expect(mcpEntries.length).toBeGreaterThanOrEqual(3)
    expect(demoList('skill').source).toBe('demo')
    expect(demoList('mcp').source).toBe('demo')
    expect(demoList('preset').entries).toEqual([])
  })

  it('filters by category and search across name, id, and description', () => {
    expect(demoList('skill', { category: 'quality' }).entries.map((entry) => entry.id))
      .toEqual(['systematic-debugging', 'test-driven-development', 'verification-before-completion'])
    expect(demoList('skill', { search: 'commit' }).entries.map((entry) => entry.id)).toEqual(['conventional-commits'])
    expect(demoList('mcp', { search: 'browser' }).entries.map((entry) => entry.id)).toEqual(['playwright'])
  })

  it('serves categories covering both surfaces', () => {
    expect(demoCategories().map((row) => row.id)).toContain('tools')
  })

  it('returns entry details and rejects unknown ids', async () => {
    const entry = await demoEntry('skill', 'brainstorming')
    expect(entry.kind).toBe('skill')
    expect(entry.files?.[0]?.path).toBe('brainstorming/SKILL.md')
    await expect(demoEntry('skill', 'does-not-exist')).rejects.toThrow(/no entry/)
  })
})

describe('demo catalog install pipeline', () => {
  it('serves every skill file through the demo fetch with matching checksums', async () => {
    expect.assertions(skillEntries.length)
    for (const entry of skillEntries) {
      const bundle = await downloadBundle(entry.files ?? [], { fetchImpl: createDemoFetch(async () => new Response('gone', { status: 410 })) })
      expect(bundle.files[0]?.path).toBe(`${entry.id}/SKILL.md`)
    }
  })

  it('rejects unknown demo file urls', async () => {
    const unknown: StoreEntry = {
      id: 'unknown',
      kind: 'skill',
      name: 'Unknown',
      description: 'Not in the catalog',
      category: 'quality',
      auditLevel: 'basic',
      version: '1.0.0',
      files: [{ path: 'unknown/SKILL.md', url: `${DEMO_FILE_URL_PREFIX}unknown/unknown/SKILL.md`, sha256: '0'.repeat(64), kind: 'text' }]
    }
    await expect(downloadBundle(unknown.files ?? [], { fetchImpl: createDemoFetch() })).rejects.toThrow(/404|Download failed/)
  })

  it('keeps every demo skill bundle clear of blocking audit verdicts', async () => {
    for (const entry of skillEntries) {
      const bundle = await downloadBundle(entry.files ?? [], { fetchImpl: createDemoFetch() })
      const report = auditBundle(entry, bundle)
      expect(report.verdict).not.toBe('block')
    }
  })

  it('keeps every demo MCP config clear of blocking audit verdicts', () => {
    for (const entry of mcpEntries) {
      expect(entry.mcp).toBeDefined()
      const report = auditMcpConfig(entry.mcp!)
      expect(report.verdict).not.toBe('block')
    }
  })
})

describe('withDemoFallback', () => {
  it('delegates to the live client when it succeeds', async () => {
    const client = withDemoFallback({
      list: async () => ({ entries: [], page: 1, pageCount: 0 }),
      entry: async () => { throw new Error('unused') },
      categories: async () => []
    })
    const list = await client.list('skill')
    expect(list.entries).toEqual([])
    expect(list.source).toBeUndefined()
  })

  it('serves the demo catalog when the live client fails', async () => {
    const failing = {
      list: async () => { throw new Error('network down') },
      entry: async () => { throw new Error('network down') },
      categories: async () => { throw new Error('network down') }
    }
    const client = withDemoFallback(failing)
    const list = await client.list('skill')
    expect(list.source).toBe('demo')
    expect(list.entries.length).toBeGreaterThan(0)
    const entry = await client.entry('mcp', 'context7')
    expect(entry.mcp?.serverName).toBe('context7')
    expect(await client.categories()).toContainEqual({ id: 'tools', name: 'Tools (MCP)' })
  })
})
