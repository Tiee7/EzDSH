import { describe, expect, it } from 'vitest'
import { catalogAdmission } from '../../src/main/store/catalog-admission'
import type { StoreEntry } from '../../src/shared/store'

function pluginEntry(overrides: Partial<StoreEntry> = {}): StoreEntry {
  return {
    id: 'nihaixia',
    kind: 'skill',
    name: 'Nihaixia',
    description: 'Plugin',
    category: 'plugin',
    auditLevel: 'verified',
    version: '2.3.1',
    plugin: {
      source: 'github:jangviktor-web/nihaixia#v2.3.1',
      packageName: 'nihaixia',
      verification: {
        status: 'passed',
        checkedAt: '2026-09-05T00:00:00.000Z',
        source: 'github:jangviktor-web/nihaixia#v2.3.1',
        dshVersion: '0.1.2-rc.1',
        pnpmVersion: '11.7.0',
        packageName: 'nihaixia'
      }
    },
    ...overrides
  }
}

describe('catalogAdmission', () => {
  it('accepts a plugin only with exact installability evidence', () => {
    expect(catalogAdmission(pluginEntry())).toEqual({ ok: true, reasons: [] })
  })

  it('accepts a third-party plugin without Hub-side preverification', () => {
    const entry = pluginEntry({ plugin: { source: 'npm:nihaixia@2.3.1', packageName: 'nihaixia' } })

    expect(catalogAdmission(entry)).toEqual({ ok: true, reasons: [] })
  })

  it('rejects malformed plugin source and package names', () => {
    const entry = pluginEntry({
      plugin: {
        source: 'file:../nihaixia',
        packageName: 'not a package name'
      }
    })

    expect(catalogAdmission(entry)).toMatchObject({ ok: false })
    expect(catalogAdmission(entry).reasons.join(' ')).toMatch(/source|package name/i)
  })

  it('does not require plugin verification for ordinary file skills', () => {
    expect(catalogAdmission({
      id: 'plain-skill', kind: 'skill', name: 'Plain', description: 'Plain', category: 'quality',
      auditLevel: 'verified', version: '1.0.0', files: []
    })).toEqual({ ok: true, reasons: [] })
  })
})
