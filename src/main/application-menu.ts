import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '../shared/app-identity.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../shared/locale.js'
import type { AppTab } from '../shared/navigation.js'

export interface ApplicationMenuOptions {
  onCheckForUpdates?: () => void
  onNavigate?: (tab: AppTab) => void
  onOpenRuntimeLog?: () => void
  onOpenHarnessDir?: () => void
  locale?: AppLocale
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
        { label: copy.tabHarness, accelerator: 'CmdOrCtrl+1', click: () => options.onNavigate?.('harness') },
        { label: copy.tabStore, accelerator: 'CmdOrCtrl+2', click: () => options.onNavigate?.('store') },
        { label: copy.tabPresets, accelerator: 'CmdOrCtrl+3', click: () => options.onNavigate?.('presets') },
        { label: copy.tabSettings, accelerator: 'CmdOrCtrl+4', click: () => options.onNavigate?.('settings') },
        { type: 'separator' },
        { label: copy.menuOpenLog, click: () => options.onOpenRuntimeLog?.() },
        { label: copy.menuOpenHarnessDir, click: () => options.onOpenHarnessDir?.() }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
