import { useEffect, useRef, useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import { STORE_API_BASE_URL } from '../../shared/store.js'
import { ProviderSection } from './ProviderSection.js'
import { UpdateSection } from './UpdateSection.js'
import { RuntimeSection } from './RuntimeSection.js'
import { RuntimeInstancesSection } from './RuntimeInstancesSection.js'
import { ChannelBridgePage } from './ChannelBridgePage.js'
import { NavigationSection } from './NavigationSection.js'
import { ExternalServicesSection } from './ExternalServicesSection.js'
import { NotificationsSection } from './NotificationsSection.js'
import { RecoverySection } from './RecoverySection.js'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.js'
import { ProxySection } from './ProxySection.js'
import { MobileRemoteSection } from './MobileRemoteSection.js'
import { SETTINGS_TAB_IDS, type SettingsTab } from './settings-navigation.js'
import './settings.css'

interface SettingsPageProps {
  copy: AppCopy
  locale: AppLocale
  runtime: RuntimeSnapshot | undefined
  onOpenSession?: (sessionId: string) => void
}

/** Settings page with a left-hand navigation sidebar. */
export function SettingsPage({ copy, locale, runtime, onOpenSession }: SettingsPageProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [busy, setBusy] = useState(false)
  const [languageTagVisible, setLanguageTagVisible] = useState(true)
  const [languageTagBusy, setLanguageTagBusy] = useState(false)
  const [languageTagError, setLanguageTagError] = useState<string>()
  const [workspaceRoot, setWorkspaceRoot] = useState<string>()
  const [workspaceTarget, setWorkspaceTarget] = useState<string>()
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [developerMode, setDeveloperMode] = useState(false)
  const [developerModeBusy, setDeveloperModeBusy] = useState(false)
  const [developerModeError, setDeveloperModeError] = useState<string>()
  const aboutClickCount = useRef(0)
  const aboutClickResetTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    let active = true
    void window.EzDSH.settings.getWorkspace()
      .then((workspace) => {
        if (active) setWorkspaceRoot(workspace.root)
      })
      .catch(() => {
        if (active) setWorkspaceError(copy.settingsWorkspaceError)
      })
    return () => { active = false }
  }, [copy.settingsWorkspaceError])

  useEffect(() => {
    let active = true
    void window.EzDSH.settings.getDeveloperMode()
      .then((enabled) => {
        if (active) setDeveloperMode(enabled)
      })
      .catch(() => {
        if (active) setDeveloperModeError(copy.settingsDeveloperModeError)
      })
    const unsubscribe = window.EzDSH.settings.onDeveloperModeChange((enabled) => {
      if (active) setDeveloperMode(enabled)
    })
    return () => {
      active = false
      unsubscribe()
      if (aboutClickResetTimer.current !== undefined) clearTimeout(aboutClickResetTimer.current)
    }
  }, [copy.settingsDeveloperModeError])

  useEffect(() => {
    let active = true
    void window.EzDSH.settings.getLanguageTagVisible()
      .then((visible) => {
        if (active) setLanguageTagVisible(visible)
      })
      .catch(() => {
        if (active) setLanguageTagError(copy.settingsLanguageTagError)
      })
    const unsubscribe = window.EzDSH.settings.onLanguageTagVisibilityChange((visible) => {
      if (active) setLanguageTagVisible(visible)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [copy.settingsLanguageTagError])

  const pickLocale = async (next: AppLocale): Promise<void> => {
    if (busy || next === locale) return
    setBusy(true)
    try {
      await window.EzDSH.settings.setLocale(next)
    } finally {
      setBusy(false)
    }
  }

  const toggleLanguageTag = async (visible: boolean): Promise<void> => {
    if (languageTagBusy) return
    setLanguageTagBusy(true)
    setLanguageTagError(undefined)
    try {
      setLanguageTagVisible(await window.EzDSH.settings.setLanguageTagVisible(visible))
    } catch {
      setLanguageTagError(copy.settingsLanguageTagError)
    } finally {
      setLanguageTagBusy(false)
    }
  }

  const chooseWorkspace = async (): Promise<void> => {
    if (workspaceBusy) return
    setWorkspaceError(undefined)
    try {
      const selected = await window.EzDSH.settings.selectWorkspace()
      if (selected !== undefined) setWorkspaceTarget(selected)
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : copy.settingsWorkspaceError)
    }
  }

  const applyWorkspace = async (kind: 'migrate' | 'switch'): Promise<void> => {
    if (workspaceBusy || workspaceTarget === undefined) return
    setWorkspaceBusy(true)
    setWorkspaceError(undefined)
    try {
      if (kind === 'migrate') {
        await window.EzDSH.settings.migrateWorkspace(workspaceTarget)
      } else {
        await window.EzDSH.settings.switchWorkspace(workspaceTarget)
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : copy.settingsWorkspaceError)
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const changeDeveloperMode = async (enabled: boolean): Promise<void> => {
    if (developerModeBusy) return
    setDeveloperModeError(undefined)
    setDeveloperModeBusy(true)
    try {
      setDeveloperMode(await window.EzDSH.settings.setDeveloperMode(enabled))
    } catch {
      setDeveloperModeError(copy.settingsDeveloperModeError)
    } finally {
      setDeveloperModeBusy(false)
    }
  }

  const handleAboutClick = (): void => {
    if (developerMode || developerModeBusy) return
    aboutClickCount.current += 1
    if (aboutClickResetTimer.current !== undefined) clearTimeout(aboutClickResetTimer.current)

    if (aboutClickCount.current >= 5) {
      aboutClickCount.current = 0
      void changeDeveloperMode(true)
      return
    }

    aboutClickResetTimer.current = setTimeout(() => {
      aboutClickCount.current = 0
    }, 1500)
  }

  const tabLabels: Record<SettingsTab, string> = {
    general: copy.settingsTabGeneral,
    proxy: copy.settingsProxy,
    notifications: copy.settingsTabNotifications,
    recovery: copy.settingsRecovery,
    sessions: copy.settingsSessionManagement,
    'remote-control': copy.settingsTabRemoteControl,
    navigation: copy.settingsTabNavigation,
    'external-services': copy.settingsExternalServices,
  }
  const tabs = SETTINGS_TAB_IDS.map((id) => ({ id, label: tabLabels[id] }))

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label={copy.tabSettings}>
        <p className="settings-nav-title">{copy.tabSettings}</p>
        <div className="settings-nav-list" role="tablist" aria-label={copy.tabSettings}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`settings-nav-item ${activeTab === tab.id ? 'settings-nav-item-active' : ''}`}
              onClick={() => { setActiveTab(tab.id) }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </aside>

      <div className="settings-content">
        {activeTab === 'general' ? (
          <>
            <ProviderSection copy={copy} />
            <section className="settings-card">
              <div className="settings-card-header">
                <div className="settings-card-heading-row">
                  <div>
                    <p className="settings-label">{copy.settingsWorkspace}</p>
                    <p className="settings-hint settings-workspace-hint">{copy.settingsWorkspaceHint}</p>
                  </div>
                </div>
              </div>
              <div className="settings-item settings-workspace-item">
                <div className="settings-item-text">
                  <code className="settings-value settings-workspace-path">{workspaceRoot ?? copy.loading}</code>
                  {workspaceTarget !== undefined ? (
                    <p className="settings-workspace-target">{workspaceTarget}</p>
                  ) : null}
                  {workspaceError ? <p className="settings-error" role="alert">{workspaceError}</p> : null}
                </div>
                <div className="settings-actions settings-workspace-actions">
                  <button className="settings-action" type="button" onClick={() => void chooseWorkspace()} disabled={workspaceBusy}>
                    {copy.settingsWorkspaceSelect}
                  </button>
                  {workspaceTarget !== undefined ? (
                    <>
                      <button className="settings-action" type="button" onClick={() => void applyWorkspace('switch')} disabled={workspaceBusy}>
                        {copy.settingsWorkspaceSwitch}
                      </button>
                      <button className="settings-action settings-action-primary" type="button" onClick={() => void applyWorkspace('migrate')} disabled={workspaceBusy}>
                        {copy.settingsWorkspaceMigrate}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </section>
            <section className="settings-card">
              <RuntimeSection copy={copy} runtime={runtime} />
            </section>
            <section className="settings-card">
              <RuntimeInstancesSection copy={copy} currentPid={runtime?.pid} />
            </section>
            <section className="settings-card">
              <UpdateSection copy={copy} />
            </section>
            <section className="settings-card">
              <div className="settings-item">
                <div className="settings-item-text">
                  <p className="settings-label">{copy.settingsLanguage}</p>
                  <p className="settings-hint">{copy.settingsLanguageHint}</p>
                </div>
                <div className="settings-segment" role="radiogroup" aria-label={copy.settingsLanguage}>
                  <button
                    role="radio"
                    aria-checked={locale === 'zh'}
                    className={`segment-option ${locale === 'zh' ? 'segment-option-active' : ''}`}
                    disabled={busy}
                    onClick={() => { void pickLocale('zh') }}
                  >
                    简体中文
                  </button>
                  <button
                    role="radio"
                    aria-checked={locale === 'en'}
                    className={`segment-option ${locale === 'en' ? 'segment-option-active' : ''}`}
                    disabled={busy}
                    onClick={() => { void pickLocale('en') }}
                  >
                    English
                  </button>
                </div>
              </div>
              <div className="settings-item settings-language-tag-item">
                <div className="settings-item-text">
                  <p className="settings-label">{copy.settingsLanguageTag}</p>
                  <p className="settings-hint">{copy.settingsLanguageTagHint}</p>
                  {languageTagError ? <p className="settings-error" role="alert">{languageTagError}</p> : null}
                </div>
                <label className="settings-language-tag-toggle">
                  <input
                    type="checkbox"
                    checked={languageTagVisible}
                    disabled={languageTagBusy}
                    aria-label={copy.settingsLanguageTagToggle}
                    onChange={(event) => { void toggleLanguageTag(event.target.checked) }}
                  />
                  <span>{copy.settingsLanguageTagToggle}</span>
                </label>
              </div>
              <div className="settings-item">
                <p className="settings-label">{copy.settingsStoreSource}</p>
                <code className="settings-value">{STORE_API_BASE_URL}</code>
              </div>
              {developerMode ? (
                <div className="settings-item settings-developer-mode-item">
                  <div className="settings-item-text">
                    <p className="settings-label">{copy.settingsDeveloperMode}</p>
                    <p className="settings-hint settings-workspace-hint">{copy.settingsDeveloperModeHint}</p>
                    {developerModeError ? <p className="settings-error" role="alert">{developerModeError}</p> : null}
                  </div>
                  <button className="settings-action" type="button" disabled={developerModeBusy} onClick={() => void changeDeveloperMode(false)}>
                    {copy.settingsDeveloperModeExit}
                  </button>
                </div>
              ) : developerModeError ? (
                <p className="settings-error settings-developer-mode-error" role="alert">{developerModeError}</p>
              ) : null}
              <div className="settings-item">
                <button className="settings-label settings-about-trigger" type="button" onClick={handleAboutClick}>
                  {copy.settingsAbout}
                </button>
                <span className="settings-value">{window.EzDSH.app.name} v{window.EzDSH.app.version}</span>
              </div>
            </section>
          </>
        ) : activeTab === 'proxy' ? (
          <ProxySection copy={copy} />
        ) : activeTab === 'notifications' ? (
          <NotificationsSection copy={copy} />
        ) : activeTab === 'recovery' ? (
          <RecoverySection copy={copy} />
        ) : activeTab === 'sessions' ? (
          <ArchivedSessionsSection copy={copy} developerMode={developerMode} onOpenSession={onOpenSession} />
        ) : activeTab === 'remote-control' ? (
          <>
            <MobileRemoteSection copy={copy} />
            <ChannelBridgePage copy={copy} />
          </>
        ) : activeTab === 'navigation' ? (
          <section className="settings-card">
            <NavigationSection copy={copy} developerMode={developerMode} />
          </section>
        ) : (
          <ExternalServicesSection copy={copy} />
        )}
      </div>
    </div>
  )
}
