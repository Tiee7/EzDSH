import { Buffer } from 'node:buffer'
import type { RuntimeViewBounds } from '../../shared/runtime-view.js'

export interface RuntimeViewWebContents {
  loadURL(url: string): Promise<void>
  executeJavaScript(script: string): Promise<unknown>
  close(): void
  isDestroyed(): boolean
}

export interface RuntimeViewLike {
  webContents: RuntimeViewWebContents
  setBounds(bounds: RuntimeViewBounds): void
}

export interface RuntimeViewControllerOptions {
  createView(): RuntimeViewLike
  attach(view: RuntimeViewLike): void
  detach(view: RuntimeViewLike): void
  /** Prepare the browser session before a new Runtime authentication URL is loaded. */
  prepareNavigation?(view: RuntimeViewLike, runtimeUrl: string): Promise<void>
  /** Called when DSH's browser boot page reports a plugin-loading failure. */
  onBootFailure?: (message: string) => void
  bootFailurePollMs?: number
}

const RUNTIME_BOOT_FAILURE_PROBE = `(() => {
  const boot = document.querySelector('[data-dsh-boot]')
  if (boot === null) return null
  const text = boot.innerText ?? boot.textContent ?? ''
  return text.includes('Failed to load plugins') ? text.trim() : ''
})()`

function assertLoopbackRuntimeUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Runtime view requires a valid loopback URL')
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === ''
    || url.username !== '' || url.password !== '') {
    throw new Error('Runtime view only accepts an HTTP loopback URL with an explicit port')
  }
  return url.href
}

function normalizeBounds(bounds: RuntimeViewBounds): RuntimeViewBounds {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Runtime view bounds must be finite and visible')
  }
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

/** Owns the first-party Electron surface used by the authenticated DSH Web UI. */
export class RuntimeViewController {
  private view: RuntimeViewLike | undefined
  private attached = false
  private loadedRuntimeUrl: string | undefined
  private navigation: Promise<void> | undefined
  private bootWatchToken = 0

  constructor(private readonly options: RuntimeViewControllerOptions) {}

  async show(url: string, bounds: RuntimeViewBounds): Promise<void> {
    const runtimeUrl = assertLoopbackRuntimeUrl(url)
    const nextBounds = normalizeBounds(bounds)
    const view = this.view ??= this.options.createView()
    if (!this.attached) {
      this.options.attach(view)
      this.attached = true
    }
    view.setBounds(nextBounds)
    if (this.loadedRuntimeUrl === runtimeUrl) {
      await this.navigation
      this.startBootFailureWatch(view, runtimeUrl)
      return
    }

    this.loadedRuntimeUrl = runtimeUrl
    const navigation = (async () => {
      await this.options.prepareNavigation?.(view, runtimeUrl)
      await view.webContents.loadURL(runtimeUrl)
    })()
    this.navigation = navigation
    try {
      await navigation
    } catch (error) {
      if (this.navigation === navigation) {
        this.loadedRuntimeUrl = undefined
        this.navigation = undefined
      }
      throw error
    }
    if (this.navigation === navigation) this.navigation = undefined
    this.startBootFailureWatch(view, runtimeUrl)
  }

  hide(): void {
    this.stopBootFailureWatch()
    if (this.view === undefined || !this.attached) return
    this.options.detach(this.view)
    this.attached = false
  }

  async openSession(sessionId: string): Promise<void> {
    if (this.view === undefined || this.view.webContents.isDestroyed()) {
      throw new Error('Runtime view is not available')
    }
    const message = Buffer.from(JSON.stringify({ type: 'ezdsh:open-session', sessionId }), 'utf8').toString('base64')
    await this.view.webContents.executeJavaScript(
      `window.postMessage(JSON.parse(atob(${JSON.stringify(message)})), window.location.origin)`,
    )
  }

  destroy(): void {
    const view = this.view
    if (view === undefined) return
    this.hide()
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.view = undefined
    this.loadedRuntimeUrl = undefined
    this.navigation = undefined
  }

  private startBootFailureWatch(view: RuntimeViewLike, runtimeUrl: string): void {
    if (this.options.onBootFailure === undefined) return
    this.stopBootFailureWatch()
    const token = this.bootWatchToken
    const pollMs = this.options.bootFailurePollMs ?? 250
    void (async () => {
      while (token === this.bootWatchToken && this.view === view && this.loadedRuntimeUrl === runtimeUrl
        && this.attached && !view.webContents.isDestroyed()) {
        let result: unknown
        try {
          result = await view.webContents.executeJavaScript(RUNTIME_BOOT_FAILURE_PROBE)
        } catch {
          return
        }
        if (token !== this.bootWatchToken || this.view !== view || this.loadedRuntimeUrl !== runtimeUrl || !this.attached) return
        if (typeof result === 'string' && result !== '') {
          this.stopBootFailureWatch()
          this.options.onBootFailure?.(result)
          return
        }
        if (result === null) return
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
      }
    })()
  }

  private stopBootFailureWatch(): void {
    this.bootWatchToken += 1
  }
}
