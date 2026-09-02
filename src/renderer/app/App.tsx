import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_APP_LOCALE, getAppCopy, type AppCopy, type AppLocale } from '../../shared/locale.js'
import {
  getDefaultNavConfig,
  isBuiltinNavItem,
  isCustomNavItem,
  visibleNavItems,
  type AppTab,
  type NavConfig,
  type NavItem,
  type NavigationTarget
} from '../../shared/navigation.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import type { UpdateState } from '../../shared/update.js'
import type { DeepLinkInstallTarget, DeepLinkSessionTarget } from '../../shared/contracts.js'
import type { WorkspaceOperationState } from '../../shared/state.js'
import type { RecoveryState } from '../../main/recovery/recovery-manager.js'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '../../shared/notifications.js'
import { RUNTIME_IFRAME_ALLOW, RUNTIME_IFRAME_SANDBOX } from './runtime-frame.js'
import { WebPane } from './WebPane.js'
import { StorePage } from '../store/StorePage.js'
import { PresetPage } from '../store/PresetPage.js'
import { EMPLOYEES_REFRESH_EVENT, EmployeesPage } from '../employees/EmployeesPage.js'
import { WorkflowPage } from '../workflow/WorkflowPage.js'
import { DocsPage } from '../docs/DocsPage.js'
import { SettingsPage } from '../settings/SettingsPage.js'
import { UpdateCenter } from '../update-center/UpdateCenter.js'
import { shouldKeepTabMounted } from './page-lifecycle.js'
import { RecoveryPanel } from '../recovery/RecoveryPanel.js'
import logoUrl from '../../../assets/logo.png'
import { ensureAudio, playNotificationSound } from '../notifications/audio.js'
import './app.css'

function builtinTabLabel(id: AppTab, copy: AppCopy): string {
  switch (id) {
    case 'harness':
      return copy.tabHarness
    case 'workflow':
      return copy.tabWorkflow
    case 'store':
      return copy.tabStore
    case 'presets':
      return copy.tabPresets
    case 'docs':
      return copy.tabDocs
    case 'employees':
      return copy.tabEmployees
    case 'settings':
      return copy.tabSettings
  }
}

interface LanguageTagProps {
  locale: AppLocale
  copy: AppCopy
  onSelect: (locale: AppLocale) => Promise<void>
}

function LanguageTag({ locale, copy, onSelect }: LanguageTagProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: MouseEvent): void => {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const select = async (nextLocale: AppLocale): Promise<void> => {
    if (busy) return
    setOpen(false)
    if (nextLocale === locale) return
    setBusy(true)
    try {
      await onSelect(nextLocale)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="language-tag" ref={containerRef}>
      <button
        type="button"
        className="language-tag-trigger"
        aria-label={copy.languageTagLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="language-tag-glyph" aria-hidden="true">文A</span>
        <span>Language</span>
        <span>{locale === 'zh' ? '简中' : 'EN'}</span>
        <span className="language-tag-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open ? (
        <div className="language-tag-menu" role="menu" aria-label={copy.languageTagLabel}>
          {([
            { id: 'zh', label: copy.languageTagChinese },
            { id: 'en', label: copy.languageTagEnglish },
          ] as const).map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={locale === option.id}
              className={`language-tag-option ${locale === option.id ? 'language-tag-option-active' : ''}`}
              onClick={() => { void select(option.id) }}
            >
              <span>{option.label}</span>
              {locale === option.id ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface SystemNavigationProps {
  copy: AppCopy
  locale: AppLocale
  isMac: boolean
  visibleItems: NavItem[]
  activeTab: string
  languageTagVisible: boolean
  onSelectTab: (tab: NavigationTarget) => void
  onSelectLocale: (locale: AppLocale) => Promise<void>
}

/** The application-level navigation stays mounted even when a page enters workspace focus mode. */
export function SystemNavigation({ copy, locale, isMac, visibleItems, activeTab, languageTagVisible, onSelectTab, onSelectLocale }: SystemNavigationProps): JSX.Element {
  return <nav className={`tab-bar ${isMac ? 'tab-bar-mac' : ''}`} aria-label={copy.menuNavigate}>
    <div className="tab-bar-drag-region" aria-hidden="true" />
    <div className="tab-bar-tabs" role="tablist">
      {visibleItems.map((item) => <button key={item.id} role="tab" aria-selected={activeTab === item.id} className={`tab-bar-item ${activeTab === item.id ? 'tab-bar-item-active' : ''}`} onClick={() => onSelectTab(item.id)}>{isBuiltinNavItem(item) ? builtinTabLabel(item.id, copy) : item.label}</button>)}
    </div>
    {languageTagVisible ? <LanguageTag locale={locale} copy={copy} onSelect={onSelectLocale} /> : null}
  </nav>
}

export function App() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_APP_LOCALE)
  const [languageTagVisible, setLanguageTagVisible] = useState(true)
  const copy = getAppCopy(locale)
  const [runtime, setRuntime] = useState<RuntimeSnapshot>()
  const [update, setUpdate] = useState<UpdateState>()
  const [loading, setLoading] = useState(true)
  const [navConfig, setNavConfig] = useState<NavConfig>(() => getDefaultNavConfig())
  const [developerMode, setDeveloperMode] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('harness')
  const [employeesRefreshKey, setEmployeesRefreshKey] = useState(0)
  const [workflowWorkspaceMode, setWorkflowWorkspaceMode] = useState(false)
  const [errorKey, setErrorKey] = useState<'runtime-start' | 'runtime-restart' | 'config-read'>()
  const [deepLinkTarget, setDeepLinkTarget] = useState<DeepLinkInstallTarget | undefined>()
  const [deepLinkSession, setDeepLinkSession] = useState<DeepLinkSessionTarget | undefined>()
  const [workspaceOperation, setWorkspaceOperation] = useState<WorkspaceOperationState | undefined>()
  const [recovery, setRecovery] = useState<RecoveryState>({ phase: 'idle' })
  const [recoveryLoaded, setRecoveryLoaded] = useState(false)
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({ ...DEFAULT_NOTIFICATION_SETTINGS })
  const notificationSettingsRef = useRef(notificationSettings)
  const harnessFrameRef = useRef<HTMLIFrameElement>(null)
  const isMac = window.EzDSH.app.platform === 'darwin'

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
  }, [locale])

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings
  }, [notificationSettings])

  useEffect(() => {
    const unlock = (): void => ensureAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

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
    const unsubscribeDeepLink = window.EzDSH.ui.onDeepLinkInstall((target) => {
      if (active) setDeepLinkTarget(target)
    })
    const unsubscribeDeepLinkSession = window.EzDSH.ui.onDeepLinkSession((target) => {
      if (active) {
        setActiveTab('harness')
        setDeepLinkSession(target)
      }
    })
    const unsubscribeLocale = window.EzDSH.locale.onChange((nextLocale) => {
      if (active) setLocale(nextLocale)
    })
    const unsubscribeLanguageTag = window.EzDSH.settings.onLanguageTagVisibilityChange((visible) => {
      if (active) setLanguageTagVisible(visible)
    })
    const unsubscribeDeveloperMode = window.EzDSH.settings.onDeveloperModeChange((enabled) => {
      if (active) setDeveloperMode(enabled)
    })
    const unsubscribeUpdate = window.EzDSH.updates.onStateChange((snapshot) => {
      if (active) setUpdate(snapshot)
    })
    const unsubscribeRecovery = window.EzDSH.recovery.onStateChange((snapshot) => {
      if (active) setRecovery(snapshot)
    })
    const unsubscribeNav = window.EzDSH.navigation.onStateChange((config) => {
      if (active) setNavConfig(config)
    })
    const unsubscribeWorkspace = window.EzDSH.settings.onWorkspaceChange((state) => {
      if (active) setWorkspaceOperation(state)
    })
    const unsubscribeNotificationSettings = window.EzDSH.notifications.onSettingsChange((next) => {
      if (active) setNotificationSettings(next)
    })
    const unsubscribeNotificationEvent = window.EzDSH.notifications.onEvent((notification) => {
      if (active) playNotificationSound(notification, notificationSettingsRef.current)
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
    void window.EzDSH.settings.getLanguageTagVisible()
      .then((visible) => {
        if (active) setLanguageTagVisible(visible)
      })
      .catch(() => {
        // Keep the shortcut visible if its optional preference cannot be read.
      })
    void window.EzDSH.settings.getDeveloperMode()
      .then((enabled) => {
        if (active) setDeveloperMode(enabled)
      })
      .catch(() => {
        // Keep developer-only tabs hidden if the optional preference cannot be read.
      })
    void window.EzDSH.updates.getStatus()
      .then((snapshot) => {
        if (active) setUpdate(snapshot)
      })
      .catch(() => {
        // Ignore update status errors; the settings page handles its own error state.
      })
    void window.EzDSH.recovery.getStatus()
      .then((snapshot) => {
        if (active) {
          setRecovery(snapshot)
          setRecoveryLoaded(true)
        }
      })
      .catch(() => {
        // Keep the normal startup screen if recovery status cannot be read.
        if (active) setRecoveryLoaded(true)
      })
    void window.EzDSH.navigation.getConfig()
      .then((config) => {
        if (active) setNavConfig(config)
      })
      .catch(() => {
        // Keep defaults if navigation config cannot be read.
      })
    void window.EzDSH.notifications.getSettings()
      .then((next) => {
        if (active) setNotificationSettings(next)
      })
      .catch(() => {
        // Keep default notification settings if this optional preference cannot be read.
      })
    return () => {
      active = false
      unsubscribe()
      unsubscribeNavigate()
      unsubscribeDeepLink()
      unsubscribeDeepLinkSession()
      unsubscribeLocale()
      unsubscribeLanguageTag()
      unsubscribeDeveloperMode()
      unsubscribeUpdate()
      unsubscribeRecovery()
      unsubscribeNav()
      unsubscribeWorkspace()
      unsubscribeNotificationSettings()
      unsubscribeNotificationEvent()
    }
  }, [ensureRuntime])

  const selectLocale = useCallback(async (nextLocale: AppLocale): Promise<void> => {
    if (nextLocale === locale) return
    await window.EzDSH.settings.setLocale(nextLocale)
  }, [locale])

  const openSessionFromSettings = useCallback((sessionId: string): void => {
    setActiveTab('harness')
    setDeepLinkSession({ sessionId })
  }, [])

  const sendSessionToRuntime = useCallback(() => {
    const frame = harnessFrameRef.current
    const runtimeUrl = runtime?.url
    const sessionId = deepLinkSession?.sessionId
    if (frame === null || runtimeUrl === undefined || sessionId === undefined) return
    let origin = '*'
    try { origin = new URL(runtimeUrl).origin } catch { /* Runtime URL is already validated by the manager. */ }
    frame.contentWindow?.postMessage({ type: 'ezdsh:open-session', sessionId }, origin)
  }, [deepLinkSession, runtime?.url])

  useEffect(() => {
    if (activeTab === 'harness') sendSessionToRuntime()
  }, [activeTab, sendSessionToRuntime])

  useEffect(() => {
    if (!recoveryLoaded || recovery.phase === 'recovery-required') return
    void ensureRuntime()
  }, [ensureRuntime, recovery.phase, recoveryLoaded])

  const visibleItems = useMemo(() => visibleNavItems(navConfig, developerMode), [developerMode, navConfig])
  const visibleIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems])

  useEffect(() => {
    if (!visibleIds.includes(activeTab)) {
      setActiveTab(visibleIds[0] ?? 'harness')
    }
  }, [visibleIds, activeTab])

  useEffect(() => {
    if (activeTab !== 'workflow') setWorkflowWorkspaceMode(false)
  }, [activeTab])

  useEffect(() => {
    const refreshEmployees = (): void => {
      setEmployeesRefreshKey((current) => current + 1)
    }
    window.addEventListener(EMPLOYEES_REFRESH_EVENT, refreshEmployees)
    return () => window.removeEventListener(EMPLOYEES_REFRESH_EVENT, refreshEmployees)
  }, [])

  const workspaceLock = workspaceOperation === undefined ? null : (
    <div className="workspace-operation-lock" role="alert" aria-live="assertive">
      <div className="workspace-operation-card">
        <div className="loading-spinner" aria-hidden="true" />
        <p>{workspaceOperation.message}</p>
      </div>
    </div>
  )

  if (recovery.phase === 'recovery-required') {
    return <RecoveryPanel copy={copy} state={recovery} />
  }

  if (runtime?.phase === 'ready' && runtime.url !== undefined) {
    return (
      <main className={`workspace ${activeTab === 'workflow' && workflowWorkspaceMode ? 'workspace-workflow-focus' : ''}`}>
        <SystemNavigation copy={copy} locale={locale} isMac={isMac} visibleItems={visibleItems} activeTab={activeTab} languageTagVisible={languageTagVisible} onSelectTab={setActiveTab} onSelectLocale={selectLocale} />
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
                      ref={harnessFrameRef}
                      title="EzDSH Runtime"
                      src={runtime.url}
                      allow={RUNTIME_IFRAME_ALLOW}
                      sandbox={RUNTIME_IFRAME_SANDBOX}
                      onLoad={sendSessionToRuntime}
                      onPointerDown={ensureAudio}
                      onKeyDown={ensureAudio}
                    />
                  </div>
                )
              case 'store':
                return activeTab === 'store'
                  ? <section key="store" className="workspace-pane workspace-pane-active workspace-pane-page" aria-label={copy.tabStore}><StorePage copy={copy} locale={locale} deepLinkTarget={deepLinkTarget} /></section>
                  : null
              case 'workflow':
                return shouldKeepTabMounted(item.id) || activeTab === 'workflow'
                  ? <section key="workflow" className={`workspace-pane ${activeTab === 'workflow' ? 'workspace-pane-active' : ''} workspace-pane-page`} aria-label={copy.tabWorkflow}><WorkflowPage copy={copy} locale={locale} developerMode={developerMode} active={activeTab === 'workflow'} onWorkspaceModeChange={setWorkflowWorkspaceMode} /></section>
                  : null
              case 'presets':
                return activeTab === 'presets'
                  ? <section key="presets" className="workspace-pane workspace-pane-active workspace-pane-page" aria-label={copy.tabPresets}><PresetPage copy={copy} locale={locale} /></section>
                  : null
              case 'employees':
                return shouldKeepTabMounted(item.id) || activeTab === 'employees'
                  ? <section key="employees" className={`workspace-pane ${activeTab === 'employees' ? 'workspace-pane-active' : ''} workspace-pane-page`} aria-label={copy.tabEmployees}><EmployeesPage key={employeesRefreshKey} copy={copy} /></section>
                  : null
              case 'docs':
                return (
                  <div key="docs" className={`workspace-pane ${activeTab === 'docs' ? 'workspace-pane-active' : ''}`}>
                    <DocsPage locale={locale} />
                  </div>
                )
              case 'settings':
                return activeTab === 'settings'
                  ? <section key="settings" className="workspace-pane workspace-pane-active workspace-pane-page" aria-label={copy.tabSettings}><SettingsPage copy={copy} locale={locale} runtime={runtime} onOpenSession={openSessionFromSettings} /></section>
                  : null
            }
          })}
        </div>
        {update ? <UpdateCenter state={update} copy={copy} /> : null}
        {workspaceLock}
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
      {workspaceLock}
    </main>
  )
}
