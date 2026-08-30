import { describe, expect, it } from 'vitest'
import { getApplicationMenuTemplate } from '../../src/main/application-menu'
import { getDefaultNavConfig, isBuiltinNavItem } from '../../src/shared/navigation'

function findMenu(label: string): { label?: string; submenu?: Electron.MenuItemConstructorOptions[] } | undefined {
  return getApplicationMenuTemplate({ locale: 'zh' }).find((item) => item.label === label)
}

describe('application menu navigate section', () => {
  it('assigns numeric shortcuts by visible tab order, including custom tabs', () => {
    const defaults = getDefaultNavConfig()
    const builtin = (id: string) => defaults.items.find((item) => isBuiltinNavItem(item) && item.id === id)
    const navConfig = {
      items: [
        builtin('harness')!,
        builtin('docs')!,
        { kind: 'custom' as const, id: 'external', label: 'External', url: 'https://example.com', visible: true },
        builtin('store')!,
        { ...builtin('presets')!, visible: false },
        builtin('settings')!
      ]
    }
    const seen: string[] = []
    const template = getApplicationMenuTemplate({
      locale: 'zh',
      navConfig,
      onNavigate: (tab) => seen.push(tab)
    })
    const navigate = template.find((item) => item.label === '前往')
    const items = (navigate?.submenu ?? []).filter(
      (item) => 'accelerator' in item && typeof item.click === 'function'
    ) as Array<{ accelerator?: string; label?: string; click: () => void }>
    const pageItems = items.filter((item) => item.accelerator !== 'CmdOrCtrl+0')
    const settingsItem = items.find((item) => item.accelerator === 'CmdOrCtrl+0')

    expect(pageItems.map((item) => item.accelerator)).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4'
    ])
    expect(pageItems.map((item) => item.label)).toEqual(['DeepSeek Harness', '使用手册', 'External', 'Skills'])
    expect(settingsItem?.label).toBe('设置')

    for (const item of pageItems) item.click()
    settingsItem?.click()
    expect(seen).toEqual(['harness', 'docs', 'external', 'store', 'settings'])
  })

  it('limits page shortcuts to 1 through 9 while keeping CmdOrCtrl+0 on settings', () => {
    const defaults = getDefaultNavConfig()
    const settings = defaults.items.find((item) => isBuiltinNavItem(item) && item.id === 'settings')!
    const navConfig = {
      items: [
        ...defaults.items.filter((item) => isBuiltinNavItem(item) && item.id !== 'settings'),
        ...Array.from({ length: 7 }, (_, index) => ({
          kind: 'custom' as const,
          id: `custom-${index + 1}`,
          label: `Custom ${index + 1}`,
          url: `https://example.com/${index + 1}`,
          visible: true
        })),
        settings
      ]
    }
    const seen: string[] = []
    const template = getApplicationMenuTemplate({
      locale: 'zh',
      navConfig,
      onNavigate: (tab) => seen.push(tab)
    })
    const navigate = template.find((item) => item.label === '前往')
    const items = (navigate?.submenu ?? []).filter(
      (item) => 'accelerator' in item && typeof item.click === 'function'
    ) as Array<{ accelerator?: string; click: () => void }>

    expect(items.map((item) => item.accelerator)).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4',
      'CmdOrCtrl+5',
      'CmdOrCtrl+6',
      'CmdOrCtrl+7',
      'CmdOrCtrl+8',
      'CmdOrCtrl+9',
      'CmdOrCtrl+0'
    ])
    expect(items.some((item) => item.accelerator === 'CmdOrCtrl+10')).toBe(false)

    for (const item of items) item.click()
    expect(seen).toEqual([
      'harness',
      'store',
      'presets',
      'docs',
      'custom-1',
      'custom-2',
      'custom-3',
      'custom-4',
      'custom-5',
      'settings'
    ])
  })

  it('exposes the ordinary four tabs by page order and keeps CmdOrCtrl+0 on settings', () => {
    const navigate = findMenu('前往')
    expect(navigate?.submenu).toBeDefined()
    const items = (navigate?.submenu ?? []).filter((item) => 'accelerator' in item)
    expect(items.map((item) => item.accelerator)).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4',
      'CmdOrCtrl+0'
    ])
    expect(items.map((item) => item.label)).toEqual(['DeepSeek Harness', 'Skills', 'Preset', '使用手册', '设置'])
  })

  it('invokes onNavigate with the clicked tab', () => {
    const seen: string[] = []
    const template = getApplicationMenuTemplate({
      locale: 'zh',
      onNavigate: (tab) => seen.push(tab)
    })
    const navigate = template.find((item) => item.label === '前往')
    const items = (navigate?.submenu ?? []).filter(
      (item) => 'accelerator' in item && typeof item.click === 'function'
    ) as Array<{ click: () => void }>
    expect(items.length).toBe(5)
    for (const item of items) item.click()
    expect(seen).toEqual(['harness', 'store', 'presets', 'docs', 'settings'])
  })

  it('keeps locale switching consistent for the English menu', () => {
    const template = getApplicationMenuTemplate({ locale: 'en' })
    const navigate = template.find((item) => item.label === 'Go')
    const labels = (navigate?.submenu ?? []).filter((item) => 'accelerator' in item).map((item) => item.label)
    expect(labels).toEqual(['DeepSeek Harness', 'Skills', 'Preset', 'Docs', 'Settings'])
  })

  it('exposes the employees tab only in developer mode', () => {
    const template = getApplicationMenuTemplate({ locale: 'zh', developerMode: true })
    const navigate = template.find((item) => item.label === '前往')
    const items = (navigate?.submenu ?? []).filter((item) => 'accelerator' in item) as Array<{
      label?: string
      accelerator?: string
    }>

    expect(items.map((item) => item.label)).toEqual(['DeepSeek Harness', 'Workflow', 'Skills', 'Preset', '使用手册', '员工', '设置'])
    expect(items.map((item) => item.accelerator)).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4',
      'CmdOrCtrl+5',
      'CmdOrCtrl+6',
      'CmdOrCtrl+0'
    ])
  })

  it('omits hidden tabs while preserving the visible page order', () => {
    const navConfig = getDefaultNavConfig()
    navConfig.items = navConfig.items.map((i) =>
      isBuiltinNavItem(i) && i.id === 'docs' ? { ...i, visible: false } : i
    )
    const template = getApplicationMenuTemplate({ locale: 'zh', navConfig })
    const navigate = template.find((item) => item.label === '前往')
    const items = (navigate?.submenu ?? []).filter((item) => 'accelerator' in item) as Array<{
      label?: string
      accelerator?: string
    }>
    expect(items.map((item) => item.label)).toEqual(['DeepSeek Harness', 'Skills', 'Preset', '设置'])
    expect(items.map((item) => item.accelerator)).toEqual([
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+0'
    ])
  })
})
