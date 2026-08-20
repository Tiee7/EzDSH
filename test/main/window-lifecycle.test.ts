import { describe, expect, it } from 'vitest'
import { bindWindowClosedCleanup } from '../../src/main/window-lifecycle.js'

describe('bindWindowClosedCleanup', () => {
  it('cleans up using the captured webContents id after the window is destroyed', () => {
    let closed: (() => void) | undefined
    let destroyed = false
    const window = {
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed')
        return { id: 42 }
      },
      on: (_event: 'closed', listener: () => void) => {
        closed = listener
      },
    }
    const watchers = new Set([42])

    bindWindowClosedCleanup(window, watchers, () => {})
    destroyed = true
    closed?.()

    expect(watchers.has(42)).toBe(false)
  })
})
