import { describe, expect, it } from 'vitest'
import {
  STORE_KINDS,
  isStoreKind,
  isAuditLevel,
  type StoreEntry,
  type StoreFile
} from '../../src/shared/store'

describe('store contract vocabulary', () => {
  it('keeps the four installable kinds in a stable order', () => {
    expect([...STORE_KINDS]).toEqual(['skill', 'preset', 'mcp', 'channel-adapter'])
  })

  it('validates kind strings', () => {
    expect(isStoreKind('skill')).toBe(true)
    expect(isStoreKind('preset')).toBe(true)
    expect(isStoreKind('mcp')).toBe(true)
    expect(isStoreKind('channel-adapter')).toBe(true)
    expect(isStoreKind('scenario')).toBe(false)
    expect(isStoreKind('')).toBe(false)
  })

  it('validates audit levels', () => {
    expect(isAuditLevel('verified')).toBe(true)
    expect(isAuditLevel('basic')).toBe(true)
    expect(isAuditLevel('unaudited')).toBe(true)
    expect(isAuditLevel('trusted')).toBe(false)
  })

  it('accepts a well-formed entry with skill files', () => {
    const file: StoreFile = { path: 'demo/SKILL.md', url: 'https://store.example.com/f.md', sha256: 'ab'.repeat(32), kind: 'text' }
    const entry: StoreEntry = {
      id: 'demo',
      kind: 'skill',
      name: 'Demo',
      description: 'A demo skill',
      category: 'demo',
      auditLevel: 'verified',
      version: '1.0.0',
      files: [file]
    }
    expect(entry.files?.length).toBe(1)
    expect(entry.mcp).toBeUndefined()
  })
})
