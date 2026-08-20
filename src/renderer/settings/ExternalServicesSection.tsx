import { useEffect, useState } from 'react'
import type {
  ExternalServiceCreateInput,
  ExternalServiceSnapshot,
  ExternalServiceState,
  ExternalServiceUpdateInput,
} from '../../shared/external-services.js'
import type { AppCopy } from '../../shared/locale.js'
import { normalizeExternalServiceCommand } from './external-services-display.js'

interface ExternalServicesSectionProps {
  copy: AppCopy
}

interface Draft {
  name: string
  command: string
  args: string
  cwd: string
  env: string
  enabled: boolean
  autoStart: boolean
}

const EMPTY_DRAFT: Draft = {
  name: '',
  command: '',
  args: '',
  cwd: '',
  env: '',
  enabled: true,
  autoStart: false,
}

function draftFromService(service: ExternalServiceSnapshot): Draft {
  return {
    name: service.name,
    command: service.command,
    args: service.args.join('\n'),
    cwd: service.cwd ?? '',
    env: Object.entries(service.env).map(([key, value]) => `${key}=${value}`).join('\n'),
    enabled: service.enabled,
    autoStart: service.autoStart,
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
}

function parseEnvironment(value: string): Record<string, string> | string {
  const environment: Record<string, string> = {}
  for (const line of lines(value)) {
    const separator = line.indexOf('=')
    const key = separator < 0 ? '' : line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return key
    environment[key] = line.slice(separator + 1)
  }
  return environment
}

function serviceInput(draft: Draft): ExternalServiceCreateInput | ExternalServiceUpdateInput | string {
  const name = draft.name.trim()
  if (name === '') return 'name'
  const env = parseEnvironment(draft.env)
  if (typeof env === 'string') return 'env'
  let normalizedCommand: ReturnType<typeof normalizeExternalServiceCommand>
  try {
    normalizedCommand = normalizeExternalServiceCommand(draft.command, lines(draft.args))
  } catch {
    return 'command'
  }
  return {
    name,
    command: normalizedCommand.command,
    args: normalizedCommand.args,
    ...(draft.cwd.trim() === '' ? {} : { cwd: draft.cwd.trim() }),
    env,
    enabled: draft.enabled,
    autoStart: draft.autoStart,
  }
}

function stateLabel(copy: AppCopy, state: ExternalServiceState): string {
  switch (state) {
    case 'stopped': return copy.externalServicesStateStopped
    case 'starting': return copy.externalServicesStateStarting
    case 'running': return copy.externalServicesStateRunning
    case 'stopping': return copy.externalServicesStateStopping
    case 'failed': return copy.externalServicesStateFailed
    case 'exited': return copy.externalServicesStateExited
  }
}

function commandLabel(service: ExternalServiceSnapshot): string {
  return [service.command, ...service.args].join(' ')
}

/** Manage user-owned processes after Runtime startup without polling when this page is closed. */
export function ExternalServicesSection({ copy }: ExternalServicesSectionProps): JSX.Element {
  const [services, setServices] = useState<ExternalServiceSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    void window.EzDSH.externalServices.list()
      .then((items) => {
        if (active) setServices(items)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : copy.externalServicesFailed)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    const unsubscribe = window.EzDSH.externalServices.watch((items) => {
      if (active) setServices(items)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [copy.externalServicesFailed])

  const setField = <K extends keyof Draft>(field: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const beginAdd = (): void => {
    setEditingId('new')
    setDraft({ ...EMPTY_DRAFT })
    setError(undefined)
  }

  const beginEdit = (service: ExternalServiceSnapshot): void => {
    setEditingId(service.id)
    setDraft(draftFromService(service))
    setError(undefined)
  }

  const cancelEdit = (): void => {
    setEditingId(undefined)
    setDraft({ ...EMPTY_DRAFT })
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    const input = serviceInput(draft)
    if (typeof input === 'string') {
      setError(input === 'name' ? copy.externalServicesNameRequired : input === 'command' ? copy.externalServicesCommandRequired : copy.externalServicesEnvInvalid)
      return
    }
    setBusyId(editingId ?? 'new')
    setError(undefined)
    try {
      const saved = editingId !== undefined && editingId !== 'new'
        ? await window.EzDSH.externalServices.update(editingId, input)
        : await window.EzDSH.externalServices.create(input)
      setServices((current) => {
        const index = current.findIndex((service) => service.id === saved.id)
        if (index < 0) return [...current, saved]
        return current.map((service) => service.id === saved.id ? saved : service)
      })
      cancelEdit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.externalServicesFailed)
    } finally {
      setBusyId(undefined)
    }
  }

  const runAction = async (id: string, action: () => Promise<ExternalServiceSnapshot>): Promise<void> => {
    setBusyId(id)
    setError(undefined)
    try {
      const next = await action()
      setServices((current) => current.map((service) => service.id === next.id ? next : service))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.externalServicesFailed)
    } finally {
      setBusyId(undefined)
    }
  }

  const remove = async (service: ExternalServiceSnapshot): Promise<void> => {
    if (!window.confirm(`${copy.externalServicesDelete}: ${service.name}?`)) return
    setBusyId(service.id)
    setError(undefined)
    try {
      await window.EzDSH.externalServices.remove(service.id)
      setServices((current) => current.filter((item) => item.id !== service.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.externalServicesFailed)
    } finally {
      setBusyId(undefined)
    }
  }

  const toggle = async (service: ExternalServiceSnapshot, field: 'enabled' | 'autoStart'): Promise<void> => {
    await runAction(service.id, () => window.EzDSH.externalServices.update(service.id, {
      [field]: !service[field],
    }))
  }

  return (
    <section className="settings-card external-services-card">
      <div className="settings-card-header">
        <div className="settings-card-heading-row">
          <div>
            <h2 className="settings-card-title">{copy.settingsExternalServices}</h2>
            <p className="settings-card-description">{copy.settingsExternalServicesHint}</p>
          </div>
          <button type="button" className="settings-action" onClick={beginAdd} disabled={editingId !== undefined}>
            {copy.externalServicesAdd}
          </button>
        </div>
      </div>

      {editingId !== undefined ? (
        <div className="settings-card-content">
          <div className="external-service-form">
            <label>
              {copy.externalServicesName}
              <input value={draft.name} onChange={(event) => { setField('name', event.target.value) }} />
            </label>
            <label>
              {copy.externalServicesCommand}
              <input value={draft.command} onChange={(event) => { setField('command', event.target.value) }} placeholder="node" />
              <span className="external-service-field-hint">{copy.externalServicesCommandHint}</span>
            </label>
            <label>
              {copy.externalServicesArgs}
              <textarea rows={3} value={draft.args} onChange={(event) => { setField('args', event.target.value) }} />
              <span className="external-service-field-hint">{copy.externalServicesArgsHint}</span>
            </label>
            <label>
              {copy.externalServicesCwd}
              <input value={draft.cwd} onChange={(event) => { setField('cwd', event.target.value) }} />
            </label>
            <label>
              {copy.externalServicesEnv}
              <textarea rows={3} value={draft.env} onChange={(event) => { setField('env', event.target.value) }} />
              <span className="external-service-field-hint">{copy.externalServicesEnvHint}</span>
            </label>
            <label className="external-service-check">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => { setField('enabled', event.target.checked) }} />
              {copy.externalServicesEnabled}
            </label>
            <label className="external-service-check">
              <input type="checkbox" checked={draft.autoStart} onChange={(event) => { setField('autoStart', event.target.checked) }} />
              <span>
                {copy.externalServicesAutoStart}
                <span className="external-service-field-hint">{copy.externalServicesAutoStartHint}</span>
              </span>
            </label>
            <p className="external-service-security-hint">{copy.externalServicesSecurityHint}</p>
            {error ? <p className="settings-error">{error}</p> : null}
            <div className="settings-actions">
              <button type="button" className="settings-action" disabled={busyId !== undefined} onClick={() => { void save() }}>
                {copy.externalServicesSave}
              </button>
              <button type="button" className="settings-action" disabled={busyId !== undefined} onClick={cancelEdit}>
                {copy.externalServicesCancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="settings-card-content"><p className="settings-hint">{copy.externalServicesLoading}</p></div>
      ) : services.length === 0 ? (
        <div className="settings-card-content"><p className="settings-hint">{copy.externalServicesEmpty}</p></div>
      ) : (
        <div className="external-service-list">
          {services.map((service) => {
            const busy = busyId === service.id
            const active = service.state === 'running' || service.state === 'starting' || service.state === 'stopping'
            return (
              <article className="external-service-row" key={service.id}>
                <div className="external-service-main">
                  <div className="external-service-title-row">
                    <span className={`settings-dot ${service.state === 'running' ? 'settings-dot-ready' : ''}`} aria-hidden="true" />
                    <strong>{service.name}</strong>
                    <span className="external-service-state">{stateLabel(copy, service.state)}</span>
                    {service.autoStart ? null : <span className="external-service-managed-badge">{copy.externalServicesOnlyManaged}</span>}
                  </div>
                  <code className="external-service-command">{commandLabel(service)}</code>
                  {service.error ? <p className="settings-error">{service.error}</p> : null}
                  {service.pid !== undefined ? <p className="external-service-meta">PID {service.pid}</p> : null}
                </div>
                <div className="external-service-controls">
                  <label className="external-service-toggle">
                    <input type="checkbox" checked={service.enabled} disabled={busy} onChange={() => { void toggle(service, 'enabled') }} />
                    {copy.externalServicesEnabled}
                  </label>
                  <label className="external-service-toggle">
                    <input type="checkbox" checked={service.autoStart} disabled={busy} onChange={() => { void toggle(service, 'autoStart') }} />
                    {copy.externalServicesAutoStart}
                  </label>
                  {active ? <button type="button" className="settings-action" disabled={busy || service.state !== 'running'} onClick={() => { void runAction(service.id, () => window.EzDSH.externalServices.stop(service.id)) }}>{copy.externalServicesStop}</button> : <button type="button" className="settings-action" disabled={busy || !service.enabled} onClick={() => { void runAction(service.id, () => window.EzDSH.externalServices.start(service.id)) }}>{copy.externalServicesStart}</button>}
                  <button type="button" className="settings-action" disabled={busy || service.state !== 'running'} onClick={() => { void runAction(service.id, () => window.EzDSH.externalServices.restart(service.id)) }}>{copy.externalServicesRestart}</button>
                  <button type="button" className="settings-action" disabled={busy} onClick={() => { beginEdit(service) }}>{copy.externalServicesEdit}</button>
                  <button type="button" className="settings-action" disabled={busy} onClick={() => { void remove(service) }}>{copy.externalServicesDelete}</button>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {error && editingId === undefined ? <div className="settings-card-content"><p className="settings-error">{error}</p></div> : null}
    </section>
  )
}
