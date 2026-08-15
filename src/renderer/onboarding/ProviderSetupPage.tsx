import { useMemo, useState } from 'react'
import type { ProviderDefinition } from '../../shared/providers.js'
import { getAppCopy, type AppLocale } from '../../shared/locale.js'
import './provider-setup.css'

interface ProviderSetupPageProps {
  locale: AppLocale
  definitions: ProviderDefinition[]
  onSaved(): Promise<void>
  onSkip(): Promise<void>
}

export function ProviderSetupPage({ locale, definitions, onSaved, onSkip }: ProviderSetupPageProps) {
  const copy = getAppCopy(locale)
  const firstDefinition = definitions[0]
  const [providerId, setProviderId] = useState(firstDefinition?.id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(firstDefinition?.defaultBaseUrl ?? '')
  const [status, setStatus] = useState<string>()
  const [testMessage, setTestMessage] = useState<string>()
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const definition = useMemo(
    () => definitions.find((candidate) => candidate.id === providerId),
    [definitions, providerId]
  )

  const selectProvider = (nextId: string): void => {
    const next = definitions.find((candidate) => candidate.id === nextId)
    setProviderId(nextId)
    setBaseUrl(next?.defaultBaseUrl ?? '')
    setStatus(undefined)
    setTestMessage(undefined)
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestMessage(undefined)
    try {
      const result = await window.EzDSH.providers.testConnection({
        providerId,
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
      })
      setTestMessage(result.message)
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : copy.connectionTestFailed)
    } finally {
      setTesting(false)
    }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setStatus(undefined)
    try {
      await window.EzDSH.providers.save({
        providerId,
        apiKey,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {})
      })
      setApiKey('')
      await onSaved()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : copy.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="setup-page">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-mark">E</div>
        <p className="eyebrow">{copy.setupEyebrow}</p>
        <h1 id="setup-title">{copy.setupTitle}</h1>
        <p className="setup-lede">{copy.setupLede}</p>
        <form onSubmit={submit}>
          <label>
            {copy.provider}
            <select value={providerId} onChange={(event) => selectProvider(event.target.value)} disabled={saving}>
              {definitions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={copy.apiKeyPlaceholder}
              autoComplete="off"
              required
              disabled={saving}
            />
          </label>
          <label>
            {copy.baseUrl} <span className="optional">{copy.optional}</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={definition?.defaultBaseUrl ?? copy.baseUrlPlaceholder}
              disabled={saving}
            />
          </label>
          <button className="primary-button" type="submit" disabled={saving || providerId === ''}>
            {saving ? copy.saving : copy.saveAndEnter}
          </button>
          <button className="secondary-button" type="button" onClick={() => void testConnection()} disabled={saving || testing || apiKey.trim() === ''}>
            {testing ? copy.testing : copy.testConnection}
          </button>
          <button className="skip-button" type="button" onClick={() => void onSkip()} disabled={saving || testing}>
            {copy.skip}
          </button>
          {status ? <p className="setup-error" role="alert">{status}</p> : null}
          {testMessage ? <p className="setup-test-result" role="status">{testMessage}</p> : null}
        </form>
      </section>
    </main>
  )
}
