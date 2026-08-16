import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppLocale } from '../../shared/locale.js'
import type { AppTab } from '../../shared/navigation.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import { RUNTIME_IFRAME_ALLOW } from './runtime-frame.js'
import { StorePage } from '../store/StorePage.js'
import { PresetPage } from '../store/PresetPage.js'
import { SettingsPage } from '../settings/SettingsPage.js'
import logoUrl from '../../../assets/logo.png'
import './app.css'

export function App() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_APP_LOCALE)
  const copy = getAppCopy(locale)
  const [runtime, setRuntime] = useState<RuntimeSnapshot>()
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<AppTab>('harness')
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
    const unsubscribeNavigate = window.EzDSH.ui.onNavigate((tab) => {
      if (active) setActiveTab(tab)
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
      unsubscribeNavigate()
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
    const tabs: Array<{ id: AppTab; label: string }> = [
      { id: 'harness', label: copy.tabHarness },
      { id: 'store', label: copy.tabStore },
      { id: 'presets', label: copy.tabPresets },
      { id: 'settings', label: copy.tabSettings }
    ]
    return (
      <main className="workspace">
        <nav className="tab-bar" aria-label={copy.menuNavigate}>
          <div className="tab-bar-drag-region" aria-hidden="true" />
          <div className="tab-bar-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`tab-bar-item ${activeTab === tab.id ? 'tab-bar-item-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="workspace-content">
          <div className={`workspace-pane ${activeTab === 'harness' ? 'workspace-pane-active' : ''}`}>
            <iframe
              title="EzDSH Runtime"
              src={runtime.url}
              allow={RUNTIME_IFRAME_ALLOW}
              sandbox="allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
            />
          </div>
          {activeTab === 'store' ? <section className="workspace-pane workspace-pane-page" aria-label={copy.tabStore}><StorePage copy={copy} /></section> : null}
          {activeTab === 'presets' ? <section className="workspace-pane workspace-pane-page" aria-label={copy.tabPresets}><PresetPage copy={copy} /></section> : null}
          {activeTab === 'settings' ? <section className="workspace-pane workspace-pane-page" aria-label={copy.tabSettings}><SettingsPage copy={copy} locale={locale} /></section> : null}
        </div>
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
          <img src={logoUrl} alt="" />
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
