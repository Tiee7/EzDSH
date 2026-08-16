import { describe, expect, it } from 'vitest'
import { RUNTIME_IFRAME_ALLOW } from '../../src/renderer/app/runtime-frame'

describe('Runtime iframe permissions', () => {
  it('delegates clipboard access to the embedded Harness UI', () => {
    expect(RUNTIME_IFRAME_ALLOW).toBe('clipboard-read; clipboard-write')
  })
})
