import { describe, expect, it } from 'vitest'
import { shouldKeepTabMounted } from '../../src/renderer/app/page-lifecycle.js'

describe('page lifecycle', () => {
  it('keeps the employee page mounted while navigating between tabs', () => {
    expect(shouldKeepTabMounted('employees')).toBe(true)
    expect(shouldKeepTabMounted('store')).toBe(false)
  })
})
