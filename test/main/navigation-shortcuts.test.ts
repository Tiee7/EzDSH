import { describe, expect, it } from 'vitest'
import { getDefaultNavConfig } from '../../src/shared/navigation'
import { getNavigationTargetForInput } from '../../src/main/navigation/navigation-shortcuts'

function input(overrides: Partial<Parameters<typeof getNavigationTargetForInput>[0]> = {}) {
  return {
    type: 'keyDown',
    key: '2',
    code: 'Digit2',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: true,
    ...overrides
  }
}

describe('navigation shortcuts', () => {
  it('maps macOS Command-number input to the visible page target', () => {
    expect(getNavigationTargetForInput(input(), getDefaultNavConfig(), 'darwin')).toBe('store')
  })

  it('keeps CmdOrCtrl+0 on settings and does not number trailing settings', () => {
    const config = getDefaultNavConfig()
    expect(getNavigationTargetForInput(input({ key: '5', code: 'Digit5' }), config, 'darwin')).toBeUndefined()
    expect(getNavigationTargetForInput(input({ key: '0', code: 'Digit0' }), config, 'darwin')).toBe('settings')
  })

  it('ignores input that is not the platform shortcut keydown', () => {
    const config = getDefaultNavConfig()
    expect(getNavigationTargetForInput(input({ type: 'keyUp' }), config, 'darwin')).toBeUndefined()
    expect(getNavigationTargetForInput(input({ meta: false }), config, 'darwin')).toBeUndefined()
    expect(getNavigationTargetForInput(input({ key: '2', code: 'Digit2', meta: false, control: true }), config, 'darwin')).toBeUndefined()
    expect(getNavigationTargetForInput(input({ key: '2', code: 'Digit2', meta: false, control: true }), config, 'win32')).toBe('store')
  })
})
