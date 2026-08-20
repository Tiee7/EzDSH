import { useEffect, useState } from 'react'
import type { CustomNavItem } from '../../shared/navigation.js'
import { RUNTIME_IFRAME_ALLOW, RUNTIME_IFRAME_SANDBOX } from './runtime-frame.js'

interface WebPaneProps {
  item: CustomNavItem
  active: boolean
}

export const WEB_PANE_RETRY_DELAY_MS = 1_000
export const WEB_PANE_MAX_AUTO_RETRIES = 3
export const WEB_PANE_RETRY_DELAYS_MS = [WEB_PANE_RETRY_DELAY_MS, 3_000] as const

export function webPaneRetryDelay(failedAttempts: number): number {
  const index = Math.max(0, Math.min(failedAttempts - 1, WEB_PANE_RETRY_DELAYS_MS.length - 1))
  return WEB_PANE_RETRY_DELAYS_MS[index]
}

export async function probeWebPaneUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { cache: 'no-store', mode: 'no-cors' })
    return response.ok || response.type === 'opaque'
  } catch {
    return false
  }
}

/** Embedded web page for a custom navigation tab; stays mounted across tab switches. */
export function WebPane({ item, active }: WebPaneProps): JSX.Element {
  const [available, setAvailable] = useState(false)
  const [checking, setChecking] = useState(true)
  const [autoRetryExhausted, setAutoRetryExhausted] = useState(false)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0

    const checkUntilReady = async (): Promise<void> => {
      setChecking(true)
      const reachable = await probeWebPaneUrl(item.url)
      if (cancelled) return
      if (reachable) {
        setAvailable(true)
        setChecking(false)
        return
      }
      failedAttempts += 1
      setAvailable(false)
      setChecking(false)
      if (failedAttempts >= WEB_PANE_MAX_AUTO_RETRIES) {
        setAutoRetryExhausted(true)
        return
      }
      retryTimer = setTimeout(() => { void checkUntilReady() }, webPaneRetryDelay(failedAttempts))
    }

    setAvailable(false)
    setAutoRetryExhausted(false)
    void checkUntilReady()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [item.url, retryToken])

  return (
    <div className={`workspace-pane ${active ? 'workspace-pane-active' : ''}`}>
      <div className="web-pane">
        {available ? (
          <iframe
            title={item.label}
            src={item.url}
            allow={RUNTIME_IFRAME_ALLOW}
            sandbox={RUNTIME_IFRAME_SANDBOX}
          />
        ) : (
          <div className="web-pane-status" role="status" aria-live="polite">
            <div className="web-pane-status-card">
              <div className={`web-pane-status-spinner ${autoRetryExhausted ? 'web-pane-status-spinner-stopped' : ''}`} aria-hidden="true" />
              <h2>{autoRetryExhausted ? `${item.label} 暂时无法连接` : `${item.label} 正在启动`}</h2>
              <p>{autoRetryExhausted
                ? '自动检查已停止，请检查页面地址或确认对应服务已启动；需要时可以手动重试。'
                : '服务还没有就绪，自动检查最多 3 次。无需手动刷新此标签页。'}</p>
              <button type="button" onClick={() => { setRetryToken((value) => value + 1) }} disabled={checking}>
                {checking ? '检查中…' : '重试连接'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
