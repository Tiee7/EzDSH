import { describe, expect, it, vi } from 'vitest'
import { RuntimeViewController } from '../../src/main/runtime/runtime-view-controller'

function makeHarness() {
  const loadURL = vi.fn(async () => undefined)
  const executeJavaScript = vi.fn(async () => undefined)
  const close = vi.fn()
  const view = {
    setBounds: vi.fn(),
    webContents: {
      loadURL,
      executeJavaScript,
      close,
      isDestroyed: () => false,
    },
  }
  return {
    view,
    createView: vi.fn(() => view),
    attach: vi.fn(),
    detach: vi.fn(),
    loadURL,
    executeJavaScript,
    close,
  }
}

describe('RuntimeViewController', () => {
  it('loads the tokenized loopback URL as a top-level WebContents view', async () => {
    const harness = makeHarness()
    const controller = new RuntimeViewController(harness)
    const bounds = { x: 248, y: 44, width: 1032, height: 776 }

    await controller.show('http://127.0.0.1:4567/?token=runtime-token', bounds)

    expect(harness.createView).toHaveBeenCalledTimes(1)
    expect(harness.attach).toHaveBeenCalledWith(harness.view)
    expect(harness.view.setBounds).toHaveBeenCalledWith(bounds)
    expect(harness.loadURL).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=runtime-token')
  })

  it('reports a DSH boot-page plugin failure even when the WebContents navigation succeeds', async () => {
    const harness = makeHarness()
    const failure = 'Failed to load plugins\nfailed to import loader entry 7a2237f2 (mode-menu-plus)'
    harness.executeJavaScript.mockResolvedValue(failure)
    const onBootFailure = vi.fn()
    const controller = new RuntimeViewController({ ...harness, onBootFailure })

    await controller.show('http://127.0.0.1:4567/?token=runtime-token', {
      x: 0, y: 0, width: 800, height: 600,
    })

    await vi.waitFor(() => expect(onBootFailure).toHaveBeenCalledWith(failure))
    controller.destroy()
  })

  it('updates bounds without reloading the Runtime authentication URL', async () => {
    const harness = makeHarness()
    const controller = new RuntimeViewController(harness)
    const url = 'http://127.0.0.1:4567/?token=runtime-token'

    await controller.show(url, { x: 200, y: 40, width: 800, height: 600 })
    await controller.show(url, { x: 220, y: 44, width: 900, height: 650 })

    expect(harness.loadURL).toHaveBeenCalledTimes(1)
    expect(harness.view.setBounds).toHaveBeenLastCalledWith({ x: 220, y: 44, width: 900, height: 650 })
  })

  it('rejects non-loopback navigation requested by the renderer', async () => {
    const harness = makeHarness()
    const controller = new RuntimeViewController(harness)

    await expect(controller.show('https://example.com/?token=stolen', {
      x: 0, y: 0, width: 800, height: 600,
    })).rejects.toThrow(/loopback/i)
    expect(harness.createView).not.toHaveBeenCalled()
  })

  it('detaches the native view when the Harness tab is hidden', async () => {
    const harness = makeHarness()
    const controller = new RuntimeViewController(harness)
    await controller.show('http://127.0.0.1:4567/?token=runtime-token', {
      x: 0, y: 0, width: 800, height: 600,
    })

    controller.hide()

    expect(harness.detach).toHaveBeenCalledWith(harness.view)
  })

  it('opens a requested DSH session without interpolating executable JavaScript', async () => {
    const harness = makeHarness()
    const controller = new RuntimeViewController(harness)
    await controller.show('http://127.0.0.1:4567/?token=runtime-token', {
      x: 0, y: 0, width: 800, height: 600,
    })

    await controller.openSession('session-";globalThis.pwned=true;//')

    const script = String(harness.executeJavaScript.mock.calls[0]?.[0])
    expect(script).toContain('window.postMessage(JSON.parse(')
    expect(script).not.toContain('globalThis.pwned=true')
  })

  it('closes its WebContents when the owner window is destroyed', async () => {
    const harness = makeHarness()
    const controller = new RuntimeViewController(harness)
    await controller.show('http://127.0.0.1:4567/?token=runtime-token', {
      x: 0, y: 0, width: 800, height: 600,
    })

    controller.destroy()

    expect(harness.detach).toHaveBeenCalledWith(harness.view)
    expect(harness.close).toHaveBeenCalledTimes(1)
  })
})
