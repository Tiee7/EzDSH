import { describe, expect, it } from 'vitest'
import { RUNTIME_IFRAME_ALLOW, RUNTIME_IFRAME_SANDBOX } from '../../src/renderer/app/runtime-frame'

describe('Runtime iframe permissions', () => {
  it('delegates clipboard access to the embedded Harness UI', () => {
    expect(RUNTIME_IFRAME_ALLOW).toBe('clipboard-read; clipboard-write')
  })

  it('grants popups so the embedded UI can open external links', () => {
    expect(RUNTIME_IFRAME_SANDBOX).toContain('allow-popups')
  })
})
