/** Top-level tabs shared by the renderer tab bar, the preload bridge, and the native application menu. */
export const APP_TABS = ['harness', 'store', 'presets', 'docs', 'settings'] as const

/** One top-level navigation target. */
export type AppTab = (typeof APP_TABS)[number]

/** Return whether `value` is a valid {@link AppTab}. */
export function isAppTab(value: unknown): value is AppTab {
  return (APP_TABS as readonly unknown[]).includes(value)
}

/** Built-in tabs that must stay visible and cannot be removed. */
export const LOCKED_NAV_TABS: readonly AppTab[] = ['harness', 'settings']

/** Maximum number of page-position shortcuts; zero is reserved for settings. */
export const NAVIGATION_SHORTCUT_LIMIT = 9

/** A system-provided tab; `locked` tabs can never be hidden. */
export interface BuiltinNavItem {
  kind: 'builtin'
  id: AppTab
  visible: boolean
  locked: boolean
}

/** A user-defined tab that opens an embedded web page. */
export interface CustomNavItem {
  kind: 'custom'
  id: string
  label: string
  url: string
}

export type NavItem = BuiltinNavItem | CustomNavItem

/** Any tab ID that can be selected from the navigation bar. */
export type NavigationTarget = NavItem['id']

/** Ordered list of navigation tabs; array order is display order. */
export interface NavConfig {
  items: NavItem[]
}

export function getDefaultNavConfig(): NavConfig {
  return {
    items: APP_TABS.map((id) => ({
      kind: 'builtin',
      id,
      visible: true,
      locked: LOCKED_NAV_TABS.includes(id)
    }))
  }
}

export function isBuiltinNavItem(item: NavItem): item is BuiltinNavItem {
  return item.kind === 'builtin'
}

export function isCustomNavItem(item: NavItem): item is CustomNavItem {
  return item.kind === 'custom'
}

/** Whether a nav item should be shown in the tab bar. Locked built-ins are always shown. */
export function isVisibleNavItem(item: NavItem): boolean {
  return isCustomNavItem(item) || item.visible || item.locked
}

/** Items that should appear in the tab bar, in display order. */
export function visibleNavItems(config: NavConfig): NavItem[] {
  return config.items.filter(isVisibleNavItem)
}

/** Items that receive CmdOrCtrl+1..9, excluding trailing settings which has CmdOrCtrl+0. */
export function navigationShortcutItems(config: NavConfig): NavItem[] {
  const visibleItems = visibleNavItems(config)
  return visibleItems.slice(0, NAVIGATION_SHORTCUT_LIMIT).filter((item, index) => {
    const isLastVisibleItem = index === visibleItems.length - 1
    return !(isLastVisibleItem && isBuiltinNavItem(item) && item.id === 'settings')
  })
}

/** Ensure fixed tabs stay anchored: harness first, settings last. */
export function pinFixedTabs(items: NavItem[]): NavItem[] {
  const harness = items.find((item) => isBuiltinNavItem(item) && item.id === 'harness')
  const settings = items.find((item) => isBuiltinNavItem(item) && item.id === 'settings')
  const rest = items.filter(
    (item) => !(isBuiltinNavItem(item) && (item.id === 'harness' || item.id === 'settings'))
  )
  const pinned: NavItem[] = []
  if (harness !== undefined) pinned.push(harness)
  pinned.push(...rest)
  if (settings !== undefined) pinned.push(settings)
  return pinned
}

/** Whether `value` is an absolute `http:` or `https:` URL. */
export function isValidWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce raw persisted JSON into a valid {@link NavConfig}, dropping invalid entries and filling missing built-ins. */
export function normalizeNavConfig(raw: unknown): NavConfig {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return getDefaultNavConfig()
  const items: NavItem[] = []
  const seen = new Set<string>()
  for (const entry of raw.items) {
    if (!isRecord(entry)) continue
    if (entry.kind === 'builtin' && isAppTab(entry.id) && !seen.has(entry.id)) {
      seen.add(entry.id)
      const locked = LOCKED_NAV_TABS.includes(entry.id)
      items.push({ kind: 'builtin', id: entry.id, locked, visible: locked || entry.visible !== false })
    } else if (
      entry.kind === 'custom'
      && typeof entry.id === 'string' && entry.id !== '' && !isAppTab(entry.id) && !seen.has(entry.id)
      && typeof entry.label === 'string' && entry.label.trim() !== ''
      && typeof entry.url === 'string' && isValidWebUrl(entry.url)
    ) {
      seen.add(entry.id)
      items.push({ kind: 'custom', id: entry.id, label: entry.label, url: entry.url })
    }
  }
  for (const id of APP_TABS) {
    if (!seen.has(id)) {
      items.push({ kind: 'builtin', id, locked: LOCKED_NAV_TABS.includes(id), visible: true })
    }
  }
  return { items: pinFixedTabs(items) }
}

/** Validate a user-supplied config; returns an error message, or `undefined` when valid. */
export function validateNavConfig(config: NavConfig): string | undefined {
  const ids = new Set<string>()
  const builtinSeen = new Set<string>()
  for (const item of config.items) {
    if (ids.has(item.id)) return 'Duplicate navigation id'
    ids.add(item.id)
    if (item.kind === 'builtin') {
      if (builtinSeen.has(item.id)) return 'Duplicate built-in navigation id'
      builtinSeen.add(item.id)
      const locked = LOCKED_NAV_TABS.includes(item.id)
      if (locked && !item.visible) return `Navigation tab "${item.id}" cannot be hidden`
    } else {
      if (item.label.trim() === '') return 'Custom navigation label is required'
      if (!isValidWebUrl(item.url)) return 'Custom navigation URL must be an absolute http(s) URL'
    }
  }
  for (const id of LOCKED_NAV_TABS) {
    if (!builtinSeen.has(id)) return `Navigation tab "${id}" is required`
  }
  return undefined
}
