import { describe, expect, it } from 'vitest'
import { getApplicationMenuTemplate } from '../../src/main/application-menu'

function findMenu(label: string): { label?: string; submenu?: Electron.MenuItemConstructorOptions[] } | undefined {
  return getApplicationMenuTemplate({ locale: 'zh' }).find((item) => item.label === label)
}

describe('application menu navigate section', () => {
  it('exposes the four tabs with CmdOrCtrl+1..4 accelerators in order', () => {
    const navigate = findMenu('前往')
    expect(navigate?.submenu).toBeDefined()
    const items = (navigate?.submenu ?? []).filter((item) => 'accelerator' in item)
    expect(items.map((item) => item.accelerator)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4'])
    expect(items.map((item) => item.label)).toEqual(['DeepSeek Harness', '技能商店', '人设商店', '设置'])
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
    expect(items.length).toBe(4)
    for (const item of items) item.click()
    expect(seen).toEqual(['harness', 'store', 'presets', 'settings'])
  })

  it('keeps locale switching consistent for the English menu', () => {
    const template = getApplicationMenuTemplate({ locale: 'en' })
    const navigate = template.find((item) => item.label === 'Go')
    const labels = (navigate?.submenu ?? []).filter((item) => 'accelerator' in item).map((item) => item.label)
    expect(labels).toEqual(['DeepSeek Harness', 'Skill Store', 'Presets', 'Settings'])
  })
})
