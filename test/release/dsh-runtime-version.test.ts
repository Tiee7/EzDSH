import { describe, expect, it } from 'vitest'
import {
  PINNED_DSH_RUNTIME_VERSION,
  assertPinnedDshRuntimeVersion
} from '../../scripts/dsh-runtime-version.mjs'

describe('published DSH Runtime version', () => {
  it('uses the exact published pin', () => {
    expect(PINNED_DSH_RUNTIME_VERSION).toBe('0.1.1-rc.2')
  })

  it('rejects a version that differs from the pin with useful details', () => {
    expect(() => assertPinnedDshRuntimeVersion('fixture', '0.1.0-rc.8'))
      .toThrow(/fixture.*0\.1\.1-rc\.2.*0\.1\.0-rc\.8/)
  })

  it('accepts the pinned version', () => {
    expect(() => assertPinnedDshRuntimeVersion('fixture', '0.1.1-rc.2')).not.toThrow()
  })
})
