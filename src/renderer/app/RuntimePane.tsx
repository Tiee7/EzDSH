import { useEffect, useRef } from 'react'
import type { RuntimeViewBounds } from '../../shared/runtime-view.js'

interface RuntimePaneProps {
  url: string
  active: boolean
  sessionId?: string
}

type BoundsInput = Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>

export function toRuntimeViewBounds(bounds: BoundsInput): RuntimeViewBounds | undefined {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return undefined
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  }
}

/** DOM anchor for the first-party WebContentsView owned by Electron Main. */
export function RuntimePane({ url, active, sessionId }: RuntimePaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const lastOpenedSession = useRef<string | undefined>(undefined)
  const lastRuntimeUrl = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (lastRuntimeUrl.current !== url) {
      lastRuntimeUrl.current = url
      lastOpenedSession.current = undefined
    }
    if (!active) {
      void window.EzDSH.runtimeView.hide()
      return
    }

    let disposed = false
    const sync = (): void => {
      const host = hostRef.current
      if (host === null || disposed) return
      const bounds = toRuntimeViewBounds(host.getBoundingClientRect())
      if (bounds === undefined) return
      void window.EzDSH.runtimeView.show(url, bounds).then(async () => {
        if (disposed || sessionId === undefined || lastOpenedSession.current === sessionId) return
        await window.EzDSH.runtimeView.openSession(sessionId)
        lastOpenedSession.current = sessionId
      }).catch(() => {
        // Runtime lifecycle errors are reported by the Main process status surface.
      })
    }

    sync()
    const observer = new ResizeObserver(sync)
    if (hostRef.current !== null) observer.observe(hostRef.current)
    window.addEventListener('resize', sync)
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', sync)
      void window.EzDSH.runtimeView.hide()
    }
  }, [active, sessionId, url])

  return <div ref={hostRef} className="runtime-view-host" data-runtime-view-host="true" aria-label="EzDSH Runtime" />
}
