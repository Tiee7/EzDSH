import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '../shared/app-identity.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppCopy, type AppLocale } from '../shared/locale.js'
import {
  getDefaultNavConfig,
  type AppTab,
  isBuiltinNavItem,
  navigationShortcutItems,
  type NavConfig,
  type NavItem,
  type NavigationTarget,
} from '../shared/navigation.js'

export interface ApplicationMenuOptions {
  onCheckForUpdates?: () => void
  onNavigate?: (tab: NavigationTarget) => void
  onOpenRuntimeLog?: () => void
  onOpenHarnessDir?: () => void
  locale?: AppLocale
  /** Current navigation config; numeric shortcuts follow its visible item order. */
  navConfig?: NavConfig
}

const TAB_LABELS: Record<AppTab, (copy: AppCopy) => string> = {
  harness: (c) => c.tabHarness,
  store: (c) => c.tabStore,
  presets: (c) => c.tabPresets,
  docs: (c) => c.tabDocs,
  settings: (c) => c.tabSettings
}

function tabLabel(item: NavItem, copy: AppCopy): string {
  return isBuiltinNavItem(item) ? TAB_LABELS[item.id](copy) : item.label
}

function getNavigateItems(options: ApplicationMenuOptions, copy: AppCopy): MenuItemConstructorOptions[] {
  const navConfig = options.navConfig ?? getDefaultNavConfig()
  const numberedItems = navigationShortcutItems(navConfig).map((item, index) => ({
    label: tabLabel(item, copy),
    accelerator: `CmdOrCtrl+${index + 1}`,
    click: () => options.onNavigate?.(item.id)
  }))

  return [
    ...numberedItems,
    {
      label: TAB_LABELS.settings(copy),
      accelerator: 'CmdOrCtrl+0',
      click: () => options.onNavigate?.('settings')
    }
  ]
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
        ...getNavigateItems(options, copy),
        { type: 'separator' },
        { label: copy.menuOpenLog, click: () => options.onOpenRuntimeLog?.() },
        { label: copy.menuOpenHarnessDir, click: () => options.onOpenHarnessDir?.() }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
