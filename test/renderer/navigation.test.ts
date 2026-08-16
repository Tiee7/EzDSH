import { describe, expect, it } from 'vitest'
import { APP_TABS } from '../../src/shared/navigation'

describe('application tabs', () => {
  it('keeps the four top-level tabs in a stable order', () => {
    expect([...APP_TABS]).toEqual(['harness', 'store', 'presets', 'settings'])
  })
})
