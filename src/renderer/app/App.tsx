import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../../shared/locale.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import { RUNTIME_IFRAME_ALLOW } from './runtime-frame.js'
import './app.css'

export function App() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_APP_LOCALE)
  const copy = getAppCopy(locale)
  const [runtime, setRuntime] = useState<RuntimeSnapshot>()
  const [loading, setLoading] = useState(true)
  const [errorKey, setErrorKey] = useState<'runtime-start' | 'runtime-restart' | 'config-read'>()

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
  }, [locale])

  const ensureRuntime = useCallback(async (): Promise<void> => {
    setErrorKey(undefined)
    try {
      setRuntime(await window.EzDSH.runtime.start())
    } catch (reason) {
      setErrorKey('runtime-start')
    }
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = window.EzDSH.runtime.onStateChange((snapshot) => {
      if (active) setRuntime(snapshot)
    })
    const unsubscribeLocale = window.EzDSH.locale.onChange((nextLocale) => {
      if (active) setLocale(nextLocale)
    })
    void window.EzDSH.locale.get()
      .then((nextLocale) => {
        if (!active) return
        setLocale(nextLocale)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setErrorKey('config-read')
        setLoading(false)
      })
    return () => {
      active = false
      unsubscribe()
      unsubscribeLocale()
    }
  }, [ensureRuntime])

  useEffect(() => {
    void ensureRuntime()
  }, [ensureRuntime])

  if (loading) {
    return <main className="app-shell"><p>{copy.loadingConfig}</p></main>
  }

  if (runtime?.phase === 'ready' && runtime.url !== undefined) {
    return (
      <main className="runtime-host">
        <div className="runtime-drag-region" aria-hidden="true" />
        <iframe
          title="EzDSH Runtime"
          src={runtime.url}
          allow={RUNTIME_IFRAME_ALLOW}
          sandbox="allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
        />
      </main>
    )
  }

  const statusMessage = errorKey === 'runtime-start'
    ? copy.runtimeStartFailed
    : errorKey === 'runtime-restart'
      ? copy.runtimeRestartFailed
      : errorKey === 'config-read'
        ? copy.configReadFailed
        : runtime?.phase === 'ready'
          ? copy.ready
          : runtime?.phase === 'failed'
            ? copy.runtimeFailed
            : runtime?.phase === 'starting'
              ? copy.starting
              : copy.preparing

  return (
    <main className="app-shell">
      <section className="welcome-card" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          <span>Ez</span>
          <span>DSH</span>
        </div>
        <p className="eyebrow">EzDSH</p>
        <h1 id="app-title">{copy.appTitle}</h1>
        <p className="subtitle">{copy.appSubtitle}</p>
        <div className="status-row" role="status" aria-live="polite">
          <span className={`status-dot ${runtime?.phase === 'ready' ? 'status-dot-ready' : ''}`} />
          <span>{statusMessage}</span>
        </div>
        {runtime?.phase === 'failed' ? <button className="retry-button" onClick={() => void ensureRuntime()}>{copy.retryStart}</button> : null}
      </section>
    </main>
  )
}
