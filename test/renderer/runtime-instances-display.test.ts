import { describe, expect, it } from 'vitest'
import { runtimeProcessAction, runtimeProcessBadge, runtimeProcessPort } from '../../src/renderer/settings/settings-display'

describe('runtime process display', () => {
  it('distinguishes the current EzDSH Runtime from other instances', () => {
    expect(runtimeProcessBadge(true, true)).toBe('current')
    expect(runtimeProcessBadge(false, true)).toBe('owned')
    expect(runtimeProcessBadge(false, false)).toBe('external')
  })

  it('uses restart for the current Runtime and stop for other instances', () => {
    expect(runtimeProcessAction(true)).toBe('restart')
    expect(runtimeProcessAction(false)).toBe('stop')
  })

  it('shows an unavailable port explicitly when discovery has no listening port', () => {
    expect(runtimeProcessPort(undefined, '未检测到')).toBe('未检测到')
    expect(runtimeProcessPort(50256, '未检测到')).toBe('50256')
  })
})
