import { describe, expect, it } from 'vitest'
import {
  auditLabel,
  auditTone,
  compareVersions,
  phaseLabel,
  updateAvailable
} from '../../src/renderer/store/display'
import type { InstalledRecord, StoreEntry } from '../../src/shared/store'
import { getAppCopy } from '../../src/shared/locale'

function record(version: string): InstalledRecord {
  return { kind: 'skill', id: 'demo', version, sha256: '0'.repeat(32), installedAt: 't', name: 'Demo' }
}

function entry(version: string): StoreEntry {
  return {
    id: 'demo', kind: 'skill', name: 'Demo', description: '', category: 'c',
    auditLevel: 'verified', version
  }
}

describe('compareVersions', () => {
  it('orders numeric parts', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })
})

describe('updateAvailable', () => {
  it('flags only strictly newer catalog versions', () => {
    expect(updateAvailable(record('1.0.0'), entry('1.1.0'))).toBe(true)
    expect(updateAvailable(record('1.1.0'), entry('1.0.0'))).toBe(false)
    expect(updateAvailable(record('1.0.0'), entry('1.0.0'))).toBe(false)
    expect(updateAvailable(undefined, entry('1.0.0'))).toBe(false)
  })
})

describe('badges and phase labels', () => {
  it('maps audit levels to tones and labels', () => {
    expect(auditTone('verified')).toBe('badge-verified')
    expect(auditTone('basic')).toBe('badge-basic')
    expect(auditTone('unaudited')).toBe('badge-unaudited')
    const zh = getAppCopy('zh')
    expect(auditLabel(zh, 'verified')).toBe('已验证')
    expect(auditLabel(zh, 'unaudited')).toBe('未审计')
  })

  it('labels every install phase', () => {
    const en = getAppCopy('en')
    expect(phaseLabel(en, 'downloading')).toBe('Downloading…')
    expect(phaseLabel(en, 'done')).toBe('Installed')
    expect(phaseLabel(en, 'failed')).toBe('Operation failed')
  })
})
