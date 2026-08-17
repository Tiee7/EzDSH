import { useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { RuntimeSnapshot } from '../../main/runtime/runtime-types.js'
import { STORE_API_BASE_URL } from '../../shared/store.js'
import { ProviderSection } from './ProviderSection.js'
import { UpdateSection } from './UpdateSection.js'
import { RuntimeSection } from './RuntimeSection.js'
import './settings.css'

interface SettingsPageProps {
  copy: AppCopy
  locale: AppLocale
  runtime: RuntimeSnapshot | undefined
}

/** Grouped settings surface: providers, runtime, updates, language, about. */
export function SettingsPage({ copy, locale, runtime }: SettingsPageProps): JSX.Element {
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
      <ProviderSection copy={copy} />
      <section className="settings-card">
        <RuntimeSection copy={copy} runtime={runtime} />
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
        <div className="settings-item">
          <p className="settings-label">{copy.settingsStoreSource}</p>
          <code className="settings-value">{STORE_API_BASE_URL}</code>
        </div>
        <div className="settings-item">
          <p className="settings-label">{copy.settingsAbout}</p>
          <p className="settings-value">{window.EzDSH.app.name} v{window.EzDSH.app.version}</p>
        </div>
      </section>
    </div>
  )
}
