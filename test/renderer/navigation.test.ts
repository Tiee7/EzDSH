import { describe, expect, it } from 'vitest'
import {
  APP_TABS,
  getDefaultNavConfig,
  isBuiltinNavItem,
  isCustomNavItem,
  isVisibleNavItem,
  isValidWebUrl,
  normalizeNavConfig,
  validateNavConfig,
  visibleNavItems
} from '../../src/shared/navigation'

describe('application tabs', () => {
  it('keeps the five top-level tabs in a stable order', () => {
    expect([...APP_TABS]).toEqual(['harness', 'store', 'presets', 'docs', 'settings'])
  })
})

describe('navigation config', () => {
  it('defaults to five visible built-in tabs with harness and settings locked', () => {
    const config = getDefaultNavConfig()
    expect(config.items.map((i) => i.id)).toEqual([...APP_TABS])
    for (const item of config.items) expect(isBuiltinNavItem(item)).toBe(true)
    const locked = config.items.filter((i) => isBuiltinNavItem(i) && i.locked).map((i) => i.id)
    expect(locked).toEqual(['harness', 'settings'])
  })

  it('guards built-in and custom item kinds', () => {
    const builtin = getDefaultNavConfig().items[0]
    expect(isBuiltinNavItem(builtin)).toBe(true)
    expect(isCustomNavItem(builtin)).toBe(false)
    const custom = { kind: 'custom' as const, id: 'c1', label: 'X', url: 'https://example.com' }
    expect(isCustomNavItem(custom)).toBe(true)
    expect(isBuiltinNavItem(custom)).toBe(false)
  })

  it('filters hidden built-ins and keeps custom items', () => {
    const config = getDefaultNavConfig()
    config.items = config.items.map((i) =>
      isBuiltinNavItem(i) && i.id === 'docs' ? { ...i, visible: false } : i
    )
    const ids = visibleNavItems(config).map((i) => i.id)
    expect(ids).not.toContain('docs')
    expect(ids).toContain('harness')
  })

  it('validates http(s) URLs only', () => {
    expect(isValidWebUrl('https://example.com')).toBe(true)
    expect(isValidWebUrl('http://example.com')).toBe(true)
    expect(isValidWebUrl('ftp://example.com')).toBe(false)
    expect(isValidWebUrl('not a url')).toBe(false)
    expect(isValidWebUrl('javascript:alert(1)')).toBe(false)
  })

  it('normalizes persisted JSON, dropping bad entries and restoring missing built-ins', () => {
    const normalized = normalizeNavConfig({
      items: [
        { kind: 'builtin', id: 'store', visible: false },
        { kind: 'custom', id: 'c1', label: 'Web', url: 'https://example.com' },
        { kind: 'custom', id: '', label: 'Bad', url: 'https://x.com' },
        { kind: 'custom', id: 'c2', label: 'Bad URL', url: 'ftp://x.com' },
        { kind: 'builtin', id: 'not-a-tab', visible: true }
      ]
    })
    const ids = normalized.items.map((i) => i.id)
    expect(ids).toEqual(['store', 'c1', 'harness', 'presets', 'docs', 'settings'])
    expect(isVisibleNavItem(normalized.items[0])).toBe(false)
    expect(isVisibleNavItem(normalized.items[2])).toBe(true) // harness restored and locked visible
  })

  it('rejects invalid set-config payloads', () => {
    const ok = getDefaultNavConfig()
    expect(validateNavConfig(ok)).toBeUndefined()
    const hiddenSettings = {
      items: ok.items.map((i) =>
        isBuiltinNavItem(i) && i.id === 'settings' ? { ...i, visible: false } : i
      )
    }
    expect(validateNavConfig(hiddenSettings)).toContain('cannot be hidden')
    const dup = {
      items: [...ok.items, { kind: 'custom' as const, id: 'harness', label: 'X', url: 'https://example.com' }]
    }
    expect(validateNavConfig(dup)).toBe('Duplicate navigation id')
    const badUrl = {
      items: [...ok.items, { kind: 'custom' as const, id: 'c1', label: 'X', url: 'ftp://x.com' }]
    }
    expect(validateNavConfig(badUrl)).toContain('http(s)')
    const removedLocked = { items: ok.items.filter((i) => isBuiltinNavItem(i) && i.id !== 'harness') }
    expect(validateNavConfig(removedLocked)).toContain('required')
  })
})
