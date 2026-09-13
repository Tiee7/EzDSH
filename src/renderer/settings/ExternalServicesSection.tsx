import { useEffect, useRef, useState } from 'react'
import type {
  ExternalServiceCreateInput,
  ExternalServiceSnapshot,
  ExternalServiceState,
  ExternalServiceUpdateInput,
} from '../../shared/external-services.js'
import type { AppCopy } from '../../shared/locale.js'
import { describeExternalServiceStartupIssue, normalizeExternalServiceCommand } from './external-services-display.js'

interface ExternalServicesSectionProps {
  copy: AppCopy
}

interface Draft {
  name: string
  command: string
  args: string
  cwd: string
  env: string
  autoStart: boolean
}

const EMPTY_DRAFT: Draft = {
  name: '',
  command: '',
  args: '',
  cwd: '',
  env: '',
  autoStart: false,
}

function draftFromService(service: ExternalServiceSnapshot): Draft {
  return {
    name: service.name,
    command: service.command,
    args: service.args.join('\n'),
    cwd: service.cwd ?? '',
    env: Object.entries(service.env).map(([key, value]) => `${key}=${value}`).join('\n'),
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
    cwd: draft.cwd.trim(),
    env,
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
  const [repairField, setRepairField] = useState<'cwd' | 'command'>()
  const [selectingDirectory, setSelectingDirectory] = useState(false)
  const operationPending = useRef(false)
  const editGeneration = useRef(0)
  const commandInput = useRef<HTMLInputElement>(null)
  const cwdInput = useRef<HTMLInputElement>(null)
  const formBusy = busyId !== undefined || selectingDirectory

  useEffect(() => {
    if (editingId !== undefined && repairField !== undefined) {
      const target = repairField === 'cwd' ? cwdInput.current : commandInput.current
      target?.focus()
    }
  }, [editingId, repairField])

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
      editGeneration.current += 1
      unsubscribe()
    }
  }, [copy.externalServicesFailed])

  const setField = <K extends keyof Draft>(field: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const beginAdd = (): void => {
    if (operationPending.current || editingId !== undefined) return
    editGeneration.current += 1
    setEditingId('new')
    setRepairField(undefined)
    setDraft({ ...EMPTY_DRAFT })
    setError(undefined)
  }

  const beginEdit = (service: ExternalServiceSnapshot, field?: 'cwd' | 'command'): void => {
    if (operationPending.current || editingId !== undefined) return
    editGeneration.current += 1
    setEditingId(service.id)
    setRepairField(field)
    setDraft(draftFromService(service))
    setError(undefined)
  }

  const cancelEdit = (): void => {
    editGeneration.current += 1
    setEditingId(undefined)
    setRepairField(undefined)
    setDraft({ ...EMPTY_DRAFT })
    setError(undefined)
  }

  const selectDirectory = async (): Promise<void> => {
    if (operationPending.current || editingId === undefined) return
    operationPending.current = true
    const generation = editGeneration.current
    setSelectingDirectory(true)
    setError(undefined)
    try {
      const selected = await window.EzDSH.externalServices.selectDirectory()
      if (generation === editGeneration.current && selected !== undefined) setField('cwd', selected)
    } catch {
      if (generation === editGeneration.current) setError(copy.externalServicesSelectDirectoryFailed)
    } finally {
      operationPending.current = false
      setSelectingDirectory(false)
    }
  }

  const updateSnapshot = (next: ExternalServiceSnapshot): void => {
    setServices((current) => current.some((service) => service.id === next.id)
      ? current.map((service) => service.id === next.id ? next : service)
      : [...current, next])
  }

  const save = async (): Promise<void> => {
    if (operationPending.current || editingId === undefined) return
    const input = serviceInput(draft)
    if (typeof input === 'string') {
      setError(input === 'name' ? copy.externalServicesNameRequired : input === 'command' ? copy.externalServicesCommandRequired : copy.externalServicesEnvInvalid)
      return
    }
    operationPending.current = true
    setBusyId(editingId)
    setError(undefined)
    let retrying = false
    try {
      const saved = editingId !== 'new'
        ? await window.EzDSH.externalServices.update(editingId, input as ExternalServiceUpdateInput)
        : await window.EzDSH.externalServices.create(input as ExternalServiceCreateInput)
      updateSnapshot(saved)
      if (repairField !== undefined) {
        retrying = true
        const next = await window.EzDSH.externalServices.start(saved.id)
        updateSnapshot(next)
        if (next.state === 'failed') {
          setError(copy.externalServicesStartFailed)
          return
        }
      }
      cancelEdit()
    } catch {
      setError(retrying ? copy.externalServicesStartFailed : copy.externalServicesSaveFailed)
    } finally {
      operationPending.current = false
      setBusyId(undefined)
    }
  }

  const runAction = async (id: string, action: () => Promise<ExternalServiceSnapshot>, failureMessage = copy.externalServicesFailed): Promise<void> => {
    if (operationPending.current || editingId !== undefined) return
    operationPending.current = true
    setBusyId(id)
    setError(undefined)
    try {
      const next = await action()
      updateSnapshot(next)
    } catch {
      setError(failureMessage)
    } finally {
      operationPending.current = false
      setBusyId(undefined)
    }
  }

  const remove = async (service: ExternalServiceSnapshot): Promise<void> => {
    if (operationPending.current || editingId !== undefined) return
    if (!window.confirm(`${copy.externalServicesDelete}: ${service.name}?`)) return
    operationPending.current = true
    setBusyId(service.id)
    setError(undefined)
    try {
      await window.EzDSH.externalServices.remove(service.id)
      setServices((current) => current.filter((item) => item.id !== service.id))
    } catch {
      setError(copy.externalServicesFailed)
    } finally {
      operationPending.current = false
      setBusyId(undefined)
    }
  }

  const toggleAutoStart = async (service: ExternalServiceSnapshot): Promise<void> => {
    await runAction(service.id, () => window.EzDSH.externalServices.update(service.id, {
      autoStart: !service.autoStart,
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
          <button type="button" className="settings-action" onClick={beginAdd} disabled={editingId !== undefined || formBusy}>
            {copy.externalServicesAdd}
          </button>
        </div>
      </div>

      {editingId !== undefined ? (
        <div className="settings-card-content">
          <div className="external-service-form">
            <label>
              {copy.externalServicesName}
              <input disabled={formBusy} aria-label={copy.externalServicesName} value={draft.name} onChange={(event) => { setField('name', event.target.value) }} />
            </label>
            <label>
              {copy.externalServicesCommand}
              <input ref={commandInput} disabled={formBusy} aria-label={copy.externalServicesCommand} value={draft.command} onChange={(event) => { setField('command', event.target.value) }} placeholder="node" />
              <span className="external-service-field-hint">{copy.externalServicesCommandHint}</span>
            </label>
            <label>
              {copy.externalServicesArgs}
              <textarea disabled={formBusy} rows={3} value={draft.args} onChange={(event) => { setField('args', event.target.value) }} />
              <span className="external-service-field-hint">{copy.externalServicesArgsHint}</span>
            </label>
            <label>
              {copy.externalServicesCwd}
              <input ref={cwdInput} disabled={formBusy} aria-label={copy.externalServicesCwd} value={draft.cwd} onChange={(event) => { setField('cwd', event.target.value) }} />
            </label>
            <button type="button" className="settings-action" disabled={formBusy} onClick={() => { void selectDirectory() }}>
              {copy.externalServicesChooseFolder}
            </button>
            <label>
              {copy.externalServicesEnv}
              <textarea disabled={formBusy} rows={3} value={draft.env} onChange={(event) => { setField('env', event.target.value) }} />
              <span className="external-service-field-hint">{copy.externalServicesEnvHint}</span>
            </label>
            <label className="external-service-check">
              <input disabled={formBusy} type="checkbox" checked={draft.autoStart} onChange={(event) => { setField('autoStart', event.target.checked) }} />
              {copy.externalServicesAutoStart}
            </label>
            <p className="external-service-security-hint">{copy.externalServicesSecurityHint}</p>
            {error ? <p className="settings-error">{error}</p> : null}
            <div className="settings-actions">
              <button type="button" className="settings-action" disabled={formBusy} onClick={() => { void save() }}>
                {repairField !== undefined ? copy.externalServicesSaveAndRetry : copy.externalServicesSave}
              </button>
              <button type="button" className="settings-action" disabled={formBusy} onClick={cancelEdit}>
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
            const busy = formBusy || editingId !== undefined
            const issue = service.state === 'failed'
              ? describeExternalServiceStartupIssue(copy, service.startupIssue ?? { code: 'unknown' })
              : undefined
            const active = service.state === 'running' || service.state === 'starting' || service.state === 'stopping'
            return (
              <article className="external-service-row" key={service.id}>
                <div className="external-service-main">
                  <div className="external-service-title-row">
                    <span className={`settings-dot ${service.state === 'running' ? 'settings-dot-ready' : ''}`} aria-hidden="true" />
                    <strong>{service.name}</strong>
                    <span className="external-service-state">{stateLabel(copy, service.state)}</span>
                  </div>
                  <code className="external-service-command">{commandLabel(service)}</code>
                  {issue ? (
                    <div>
                      <p className="settings-error external-service-error" role="alert">{issue.summary}</p>
                      {issue.field ? <button type="button" className="settings-action" disabled={busy} onClick={() => { beginEdit(service, issue.field) }}>
                        {issue.field === 'cwd' ? copy.externalServicesChangeCwd : copy.externalServicesChangeCommand}
                      </button> : null}
                    </div>
                  ) : null}
                  {service.error ? <details>
                    <summary>{copy.externalServicesFailureDetails}</summary>
                    <pre className="external-service-error">{service.error}</pre>
                  </details> : null}
                  {service.pid !== undefined ? <p className="external-service-meta">PID {service.pid}</p> : null}
                </div>
                <div className="external-service-controls">
                  <label className="external-service-toggle">
                    <input type="checkbox" checked={service.autoStart} disabled={busy} onChange={() => { void toggleAutoStart(service) }} />
                    {copy.externalServicesAutoStart}
                  </label>
                  {active ? <button type="button" className="settings-action external-service-process-action" disabled={busy || service.state !== 'running'} onClick={() => { void runAction(service.id, () => window.EzDSH.externalServices.stop(service.id)) }}>{copy.externalServicesStop}<span className="external-service-action-icon external-service-action-icon-stop" aria-hidden="true">■</span></button> : <button type="button" className="settings-action external-service-process-action" disabled={busy} onClick={() => { void runAction(service.id, () => window.EzDSH.externalServices.start(service.id), copy.externalServicesStartFailed) }}>{copy.externalServicesStart}<span className="external-service-action-icon external-service-action-icon-start" aria-hidden="true">▶</span></button>}
                  <button type="button" className="settings-action" disabled={busy || service.state !== 'running'} onClick={() => { void runAction(service.id, () => window.EzDSH.externalServices.restart(service.id), copy.externalServicesStartFailed) }}>{copy.externalServicesRestart}</button>
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
