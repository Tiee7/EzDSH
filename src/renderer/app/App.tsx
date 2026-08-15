import { useCallback, useEffect, useState } from 'react'
import type { ProviderDefinition } from '../../shared/providers.js'
import { needsProviderSetup } from '../../shared/providers.js'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../../shared/locale.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import { ProviderSetupPage } from '../onboarding/ProviderSetupPage'
import './app.css'

export function App() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_APP_LOCALE)
  const copy = getAppCopy(locale)
  const [definitions, setDefinitions] = useState<ProviderDefinition[]>([])
  const [runtime, setRuntime] = useState<RuntimeSnapshot>()
  const [setupRequired, setSetupRequired] = useState(true)
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

  const continueToRuntime = useCallback(async (): Promise<void> => {
    setSetupRequired(false)
    await ensureRuntime()
  }, [ensureRuntime])

  const saveAndRestartRuntime = useCallback(async (): Promise<void> => {
    setSetupRequired(false)
    setErrorKey(undefined)
    try {
      setRuntime(await window.EzDSH.runtime.restart())
    } catch {
      setErrorKey('runtime-restart')
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
    void window.EzDSH.locale.get().then((nextLocale) => {
      if (active) setLocale(nextLocale)
    })
    void Promise.all([window.EzDSH.providers.listDefinitions(), window.EzDSH.providers.getStatus()])
      .then(([nextDefinitions, statuses]) => {
        if (!active) return
        setDefinitions(nextDefinitions)
        const needsSetup = needsProviderSetup(statuses)
        setSetupRequired(needsSetup)
        setLoading(false)
      })
      .catch((reason: unknown) => {
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

  if (setupRequired) {
    return <ProviderSetupPage locale={locale} definitions={definitions} onSaved={saveAndRestartRuntime} onSkip={continueToRuntime} />
  }

  if (runtime?.phase === 'ready' && runtime.url !== undefined) {
    return (
      <main className="runtime-host">
        <div className="runtime-drag-region" aria-hidden="true" />
        <iframe
          title="EzDSH Runtime"
          src={runtime.url}
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
