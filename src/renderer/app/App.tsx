import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppCopy, type AppLocale } from '../../shared/locale.js'
import {
  getDefaultNavConfig,
  isBuiltinNavItem,
  isCustomNavItem,
  visibleNavItems,
  type AppTab,
  type NavConfig
} from '../../shared/navigation.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import type { UpdateState } from '../../shared/update.js'
import { RUNTIME_IFRAME_ALLOW, RUNTIME_IFRAME_SANDBOX } from './runtime-frame.js'
import { WebPane } from './WebPane.js'
import { StorePage } from '../store/StorePage.js'
import { PresetPage } from '../store/PresetPage.js'
import { DocsPage } from '../docs/DocsPage.js'
import { SettingsPage } from '../settings/SettingsPage.js'
import { UpdateCenter } from '../update-center/UpdateCenter.js'
import logoUrl from '../../../assets/logo.png'
import './app.css'

function builtinTabLabel(id: AppTab, copy: AppCopy): string {
  switch (id) {
    case 'harness':
      return copy.tabHarness
    case 'store':
      return copy.tabStore
    case 'presets':
      return copy.tabPresets
    case 'docs':
      return copy.tabDocs
    case 'settings':
      return copy.tabSettings
  }
}

export function App() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_APP_LOCALE)
  const copy = getAppCopy(locale)
  const [runtime, setRuntime] = useState<RuntimeSnapshot>()
  const [update, setUpdate] = useState<UpdateState>()
  const [loading, setLoading] = useState(true)
  const [navConfig, setNavConfig] = useState<NavConfig>(() => getDefaultNavConfig())
  const [activeTab, setActiveTab] = useState<string>('harness')
  const [errorKey, setErrorKey] = useState<'runtime-start' | 'runtime-restart' | 'config-read'>()
  const isMac = window.EzDSH.app.platform === 'darwin'

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
    const unsubscribeUpdate = window.EzDSH.updates.onStateChange((snapshot) => {
      if (active) setUpdate(snapshot)
    })
    const unsubscribeNav = window.EzDSH.navigation.onStateChange((config) => {
      if (active) setNavConfig(config)
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
    void window.EzDSH.updates.getStatus()
      .then((snapshot) => {
        if (active) setUpdate(snapshot)
      })
      .catch(() => {
        // Ignore update status errors; the settings page handles its own error state.
      })
    void window.EzDSH.navigation.getConfig()
      .then((config) => {
        if (active) setNavConfig(config)
      })
      .catch(() => {
        // Keep defaults if navigation config cannot be read.
      })
    return () => {
      active = false
      unsubscribe()
      unsubscribeNavigate()
      unsubscribeLocale()
      unsubscribeUpdate()
      unsubscribeNav()
    }
  }, [ensureRuntime])

  useEffect(() => {
    void ensureRuntime()
  }, [ensureRuntime])

  const visibleItems = useMemo(() => visibleNavItems(navConfig), [navConfig])
  const visibleIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems])

  useEffect(() => {
    if (!visibleIds.includes(activeTab)) {
      setActiveTab(visibleIds[0] ?? 'harness')
    }
  }, [visibleIds, activeTab])

  if (runtime?.phase === 'ready' && runtime.url !== undefined) {
    return (
      <main className="workspace">
        <nav className={`tab-bar ${isMac ? 'tab-bar-mac' : ''}`} aria-label={copy.menuNavigate}>
          <div className="tab-bar-drag-region" aria-hidden="true" />
          <div className="tab-bar-tabs" role="tablist">
            {visibleItems.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={activeTab === item.id}
                className={`tab-bar-item ${activeTab === item.id ? 'tab-bar-item-active' : ''}`}
                onClick={() => setActiveTab(item.id)}
              >
                {isBuiltinNavItem(item) ? builtinTabLabel(item.id, copy) : item.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="workspace-content">
          {visibleItems.map((item) => {
            if (isCustomNavItem(item)) {
              return <WebPane key={item.id} item={item} active={activeTab === item.id} />
            }
            switch (item.id) {
              case 'harness':
                return (
                  <div key="harness" className={`workspace-pane ${activeTab === 'harness' ? 'workspace-pane-active' : ''}`}>
                    <iframe
                      title="EzDSH Runtime"
                      src={runtime.url}
                      allow={RUNTIME_IFRAME_ALLOW}
                      sandbox={RUNTIME_IFRAME_SANDBOX}
                    />
                  </div>
                )
              case 'store':
                return activeTab === 'store'
                  ? <section key="store" className="workspace-pane workspace-pane-active workspace-pane-page" aria-label={copy.tabStore}><StorePage copy={copy} /></section>
                  : null
              case 'presets':
                return activeTab === 'presets'
                  ? <section key="presets" className="workspace-pane workspace-pane-active workspace-pane-page" aria-label={copy.tabPresets}><PresetPage copy={copy} /></section>
                  : null
              case 'docs':
                return (
                  <div key="docs" className={`workspace-pane ${activeTab === 'docs' ? 'workspace-pane-active' : ''}`}>
                    <DocsPage locale={locale} />
                  </div>
                )
              case 'settings':
                return activeTab === 'settings'
                  ? <section key="settings" className="workspace-pane workspace-pane-active workspace-pane-page" aria-label={copy.tabSettings}><SettingsPage copy={copy} locale={locale} runtime={runtime} /></section>
                  : null
            }
          })}
        </div>
        {update ? <UpdateCenter state={update} copy={copy} /> : null}
      </main>
    )
  }

  const statusMessage = loading
    ? copy.loadingConfig
    : errorKey === 'runtime-start'
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

  const isBusy = loading || runtime?.phase === 'starting' || runtime?.phase === 'preparing'

  return (
    <main className="app-shell">
      <section className="welcome-card" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          <img src={logoUrl} alt="" />
        </div>
        <p className="eyebrow">EzDSH</p>
        <h1 id="app-title">{copy.appTitle}</h1>
        <p className="subtitle">{copy.appSubtitle}</p>
        {isBusy ? <div className="loading-spinner" aria-hidden="true" /> : null}
        <div className="status-row" role="status" aria-live="polite">
          <span className={`status-dot ${runtime?.phase === 'ready' ? 'status-dot-ready' : ''}`} />
          <span>{statusMessage}</span>
        </div>
        {runtime?.phase === 'failed' ? <button className="retry-button" onClick={() => void ensureRuntime()}>{copy.retryStart}</button> : null}
      </section>
    </main>
  )
}
