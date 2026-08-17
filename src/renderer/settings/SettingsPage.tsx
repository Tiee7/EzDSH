import { useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import { STORE_API_BASE_URL } from '../../shared/store.js'
import './settings.css'

/** Minimal settings surface: language, data locations, about, store source. */
export function SettingsPage({ copy, locale }: { copy: AppCopy; locale: AppLocale }): JSX.Element {
  const [busy, setBusy] = useState(false)

  const pickLocale = async (next: AppLocale): Promise<void> => {
    if (busy || next === locale) return
    setBusy(true)
    try {
      await window.EzDSH.settings.setLocale(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page">
      <h2 className="settings-title">{copy.tabSettings}</h2>
      <div className="settings-card">
        <section className="settings-item">
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
        </section>
        <section className="settings-item">
          <p className="settings-label">{copy.settingsOpenLog}</p>
          <button className="settings-action" onClick={() => { void window.EzDSH.runtime.openLog() }}>
            {copy.menuOpenLog}
          </button>
        </section>
        <section className="settings-item">
          <p className="settings-label">{copy.settingsOpenHarnessDir}</p>
          <button className="settings-action" onClick={() => { void window.EzDSH.settings.openHarnessDir() }}>
            {copy.menuOpenHarnessDir}
          </button>
        </section>
        <section className="settings-item">
          <p className="settings-label">{copy.settingsStoreSource}</p>
          <code className="settings-value">{STORE_API_BASE_URL}</code>
        </section>
        <section className="settings-item settings-item-last">
          <p className="settings-label">{copy.settingsAbout}</p>
          <p className="settings-value">{window.EzDSH.app.name} v{window.EzDSH.app.version}</p>
        </section>
      </div>
    </div>
  )
}
