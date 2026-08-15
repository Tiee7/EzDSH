import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '../shared/app-identity.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../shared/locale.js'

export interface ApplicationMenuOptions {
  onCheckForUpdates?: () => void
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
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
