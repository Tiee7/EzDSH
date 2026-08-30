import { describe, expect, it, vi } from 'vitest'
import * as app from '../../src/renderer/app/App.js'
import { builtinLabel, isNavItemMovable } from '../../src/renderer/settings/NavigationSection.js'
import { getAppCopy } from '../../src/shared/locale.js'
import {
  APP_TABS,
  getDefaultNavConfig,
  isBuiltinNavItem,
  isCustomNavItem,
  isVisibleNavItem,
  isValidWebUrl,
  normalizeNavConfig,
  pinFixedTabs,
  validateNavConfig,
  visibleNavItems
} from '../../src/shared/navigation'

describe('application tabs', () => {
  it('keeps the seven top-level tabs in a stable order', () => {
    expect([...APP_TABS]).toEqual(['harness', 'workflow', 'store', 'presets', 'docs', 'employees', 'settings'])
  })

  it('shows the Workflow title in the navigation settings list', () => {
    expect(builtinLabel('workflow', getAppCopy('zh'))).toBe('Workflow')
  })

  it('allows employees to be reordered while keeping core tabs fixed', () => {
    const config = getDefaultNavConfig()
    const employee = config.items.find((item) => item.id === 'employees')
    const harness = config.items.find((item) => item.id === 'harness')
    const settings = config.items.find((item) => item.id === 'settings')

    expect(employee).toBeDefined()
    expect(harness).toBeDefined()
    expect(settings).toBeDefined()
    expect(isNavItemMovable(employee, undefined)).toBe(true)
    expect(isNavItemMovable(harness, undefined)).toBe(false)
    expect(isNavItemMovable(settings, undefined)).toBe(false)
  })

  it('keeps system navigation visible while Workflow is in workspace focus mode', () => {
    const markup = app.SystemNavigation({
      copy: getAppCopy('zh'),
      locale: 'zh',
      isMac: true,
      visibleItems: getDefaultNavConfig().items,
      activeTab: 'workflow',
      languageTagVisible: false,
      onSelectTab: vi.fn(),
      onSelectLocale: vi.fn(async () => undefined),
    })

    expect(markup.props.className).toContain('tab-bar')
    expect(markup.props.children[1].type).toBe('div')
    expect(markup.props.children[1].props.className).toBe('tab-bar-tabs')
  })
})

describe('navigation config', () => {
  it('defaults to seven built-in tabs with harness, employees, and settings locked', () => {
    const config = getDefaultNavConfig()
    expect(config.items.map((i) => i.id)).toEqual([...APP_TABS])
    for (const item of config.items) expect(isBuiltinNavItem(item)).toBe(true)
    const locked = config.items.filter((i) => isBuiltinNavItem(i) && i.locked).map((i) => i.id)
    expect(locked).toEqual(['harness', 'employees', 'settings'])
  })

  it('hides Workflow and employees unless developer mode is enabled', () => {
    const config = getDefaultNavConfig()
    const visible = visibleNavItems as (config: typeof config, developerMode?: boolean) => typeof config.items

    expect(visible(config).map((i) => i.id)).toEqual(['harness', 'store', 'presets', 'docs', 'settings'])
    expect(visible(config, true).map((i) => i.id)).toEqual([...APP_TABS])
  })

  it('guards built-in and custom item kinds', () => {
    const builtin = getDefaultNavConfig().items[0]
    expect(isBuiltinNavItem(builtin)).toBe(true)
    expect(isCustomNavItem(builtin)).toBe(false)
    const custom = { kind: 'custom' as const, id: 'c1', label: 'X', url: 'https://example.com', visible: true }
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

  it('defaults custom links to visible and filters hidden custom links', () => {
    const config = normalizeNavConfig({
      items: [
        { kind: 'builtin', id: 'harness', visible: true },
        { kind: 'custom', id: 'hidden', label: 'Hidden', url: 'https://hidden.example', visible: false },
        { kind: 'custom', id: 'shown', label: 'Shown', url: 'https://shown.example' },
        { kind: 'builtin', id: 'settings', visible: true }
      ]
    })
    const hidden = config.items.find((item) => item.id === 'hidden')
    const shown = config.items.find((item) => item.id === 'shown')
    expect(hidden).toMatchObject({ kind: 'custom', visible: false })
    expect(shown).toMatchObject({ kind: 'custom', visible: true })
    const visibleIds = visibleNavItems(config).map((item) => item.id)
    expect(visibleIds).toContain('harness')
    expect(visibleIds).toContain('shown')
    expect(visibleIds).toContain('settings')
    expect(visibleIds).not.toContain('hidden')
    expect(visibleIds).not.toContain('workflow')
    expect(visibleIds).not.toContain('employees')
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
        { kind: 'custom', id: 'c1', label: 'Web', url: 'https://example.com', visible: true },
        { kind: 'custom', id: '', label: 'Bad', url: 'https://x.com', visible: true },
        { kind: 'custom', id: 'c2', label: 'Bad URL', url: 'ftp://x.com', visible: true },
        { kind: 'builtin', id: 'not-a-tab', visible: true }
      ]
    })
    const ids = normalized.items.map((i) => i.id)
    expect(ids).toEqual(['harness', 'store', 'c1', 'workflow', 'presets', 'docs', 'employees', 'settings'])
    expect(isVisibleNavItem(normalized.items[1])).toBe(false)
    expect(isVisibleNavItem(normalized.items[0])).toBe(true) // harness pinned first and locked visible
  })

  it('pins only harness first and settings last so employees can be reordered', () => {
    const config = getDefaultNavConfig()
    const scrambled = [config.items[6], config.items[2], config.items[3], config.items[0], config.items[5], config.items[4], config.items[1]]
    const pinned = pinFixedTabs(scrambled)
    expect(pinned.map((i) => i.id)).toEqual(['harness', 'store', 'presets', 'employees', 'docs', 'workflow', 'settings'])
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
      items: [...ok.items, { kind: 'custom' as const, id: 'harness', label: 'X', url: 'https://example.com', visible: true }]
    }
    expect(validateNavConfig(dup)).toBe('Duplicate navigation id')
    const badUrl = {
      items: [...ok.items, { kind: 'custom' as const, id: 'c1', label: 'X', url: 'ftp://x.com', visible: true }]
    }
    expect(validateNavConfig(badUrl)).toContain('http(s)')
    const removedLocked = { items: ok.items.filter((i) => isBuiltinNavItem(i) && i.id !== 'harness') }
    expect(validateNavConfig(removedLocked)).toContain('required')
  })
})
