import { describe, expect, it, vi } from 'vitest'
import { restartApplication, shouldRelaunchWorkspace } from '../../src/main/restart'

describe('restartApplication', () => {
  it('relaunches with the current arguments and then quits gracefully', () => {
    const events: string[] = []
    const app = {
      relaunch: vi.fn(() => { events.push('relaunch') }),
      quit: vi.fn(() => { events.push('quit') }),
    }

    restartApplication(app, ['.', '--dev'])

    expect(app.relaunch).toHaveBeenCalledWith({ args: ['.', '--dev'] })
    expect(app.quit).toHaveBeenCalledOnce()
    expect(events).toEqual(['relaunch', 'quit'])
  })

  it('keeps the electron-vite process alive during development workspace changes', () => {
    expect(shouldRelaunchWorkspace(false)).toBe(false)
    expect(shouldRelaunchWorkspace(true)).toBe(true)
  })
})
