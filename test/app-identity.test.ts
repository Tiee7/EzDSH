import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { APP_NAME } from '../src/shared/app-identity'
import { APP_VERSION } from '../src/shared/app-identity'
import { getApplicationMenuTemplate } from '../src/main/application-menu'

describe('application identity', () => {
  it('uses the human-facing application name', () => {
    expect(APP_NAME).toBe('EzDSH')
  })

  it('keeps the project and displayed application version aligned', () => {
    expect(packageJson.version).toBe('0.8.15.1')
    expect(APP_VERSION).toBe(packageJson.version)
  })

  it('uses the same name for the macOS application menu', () => {
    expect(getApplicationMenuTemplate()[0]?.label).toBe(APP_NAME)
  })

  it('exposes an update check action in the application menu', () => {
    const template = getApplicationMenuTemplate({ onCheckForUpdates: () => undefined })
    const appMenu = template[0]
    expect(appMenu && 'submenu' in appMenu
      ? appMenu.submenu?.some((item) => 'label' in item && item.label === '检查更新…')
      : false).toBe(true)
  })

  it('localizes the application menu from the DSH locale', () => {
    const template = getApplicationMenuTemplate({ locale: 'en' })
    const appMenu = template[0]
    expect(appMenu && 'submenu' in appMenu
      ? appMenu.submenu?.some((item) => 'label' in item && item.label === 'Check for Updates…')
      : false).toBe(true)
  })
})
