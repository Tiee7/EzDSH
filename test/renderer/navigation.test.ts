import { describe, expect, it } from 'vitest'
import { APP_TABS } from '../../src/shared/navigation'

describe('application tabs', () => {
  it('keeps the five top-level tabs in a stable order', () => {
    expect([...APP_TABS]).toEqual(['harness', 'store', 'presets', 'docs', 'settings'])
  })
})
