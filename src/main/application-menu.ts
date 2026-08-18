import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '../shared/app-identity.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppCopy, type AppLocale } from '../shared/locale.js'
import {
  APP_TABS,
  type AppTab,
  isBuiltinNavItem,
  isVisibleNavItem,
  type NavConfig
} from '../shared/navigation.js'

export interface ApplicationMenuOptions {
  onCheckForUpdates?: () => void
  onNavigate?: (tab: AppTab) => void
  onOpenRuntimeLog?: () => void
  onOpenHarnessDir?: () => void
  locale?: AppLocale
  /** Current navigation config; hidden built-in tabs have their menu items disabled. */
  navConfig?: NavConfig
}

const TAB_LABELS: Record<AppTab, (copy: AppCopy) => string> = {
  harness: (c) => c.tabHarness,
  store: (c) => c.tabStore,
  presets: (c) => c.tabPresets,
  docs: (c) => c.tabDocs,
  settings: (c) => c.tabSettings
}

function isTabVisible(options: ApplicationMenuOptions, id: AppTab): boolean {
  if (options.navConfig === undefined) return true
  const item = options.navConfig.items.find((candidate) => isBuiltinNavItem(candidate) && candidate.id === id)
  return item === undefined ? true : isVisibleNavItem(item)
}

export function getApplicationMenuTemplate(options: ApplicationMenuOptions = {}): MenuItemConstructorOptions[] {
  const copy = getAppCopy(options.locale ?? DEFAULT_APP_LOCALE)
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: copy.menuAbout },
        { type: 'separator' },
        { label: copy.menuCheckForUpdates, click: () => options.onCheckForUpdates?.() },
        { type: 'separator' },
        { role: 'quit', label: copy.menuQuit }
      ]
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: copy.menuNavigate,
      submenu: [
        ...APP_TABS.map((id, index) => ({
          label: TAB_LABELS[id](copy),
          accelerator: `CmdOrCtrl+${index + 1}`,
          enabled: isTabVisible(options, id),
          click: () => options.onNavigate?.(id)
        })),
        { type: 'separator' },
        { label: copy.menuOpenLog, click: () => options.onOpenRuntimeLog?.() },
        { label: copy.menuOpenHarnessDir, click: () => options.onOpenHarnessDir?.() }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}