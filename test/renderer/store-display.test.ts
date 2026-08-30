import { describe, expect, it } from 'vitest'
import {
  auditLabel,
  auditTone,
  categoryLabel,
  entryType,
  entryTypeLabel,
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

describe('entry type labels', () => {
  it('derives plugin and MCP types from their payloads', () => {
    expect(entryType({ ...entry('1.0.0'), plugin: { source: 'npm:@example/plugin' } })).toBe('plugin')
    expect(entryType({ ...entry('1.0.0'), kind: 'mcp', mcp: { transport: 'stdio', serverName: 'example' } })).toBe('mcp')
    expect(entryType(entry('1.0.0'))).toBeUndefined()
  })

  it('localizes the type labels', () => {
    expect(entryTypeLabel(getAppCopy('zh'), 'plugin')).toBe('插件')
    expect(entryTypeLabel(getAppCopy('zh'), 'mcp')).toBe('MCP 服务')
    expect(entryTypeLabel(getAppCopy('en'), 'plugin')).toBe('Plugin')
    expect(entryTypeLabel(getAppCopy('en'), 'mcp')).toBe('MCP server')
  })
})

describe('category labels', () => {
  it('uses the Chinese label in Chinese and the category id in English', () => {
    const category = { id: 'workflow', name: 'Workflow' }
    expect(categoryLabel(category, 'zh')).toBe('工作流程')
    expect(categoryLabel(category, 'en')).toBe('workflow')
    expect(categoryLabel({ id: 'plugin', name: 'Plugin' }, 'zh')).toBe('插件')
  })
})
