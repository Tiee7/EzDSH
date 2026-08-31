import { useEffect, useMemo, useState } from 'react'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import { WandMagicSparklesIcon } from '../icons/WandMagicSparklesIcon.js'
import type {
  WorkflowDefinition,
  WorkflowGenerationPhase,
  WorkflowGenerationRecord,
  WorkflowModelOption,
  WorkflowModelSelection,
} from '../../shared/workflow.js'
import { WORKFLOW_GENERATION_PHASES } from '../../shared/workflow.js'

export interface WorkflowGenerationPageProps {
  copy: AppCopy
  locale: AppLocale
  onBack: () => void
  onOpenWorkflow: (workflow: WorkflowDefinition) => void
}

const phaseCopyKeys: Record<WorkflowGenerationPhase, keyof AppCopy> = {
  preparing: 'workflowGenerationPhasePreparing',
  'planning-employees': 'workflowGenerationPhasePlanningEmployees',
  'creating-employees': 'workflowGenerationPhaseCreatingEmployees',
  'generating-workflow': 'workflowGenerationPhaseGeneratingWorkflow',
  validating: 'workflowGenerationPhaseValidating',
  completed: 'workflowGenerationPhaseCompleted',
}

export function mergeWorkflowGenerationRecord(records: WorkflowGenerationRecord[], incoming: WorkflowGenerationRecord): WorkflowGenerationRecord[] {
  return [incoming, ...records.filter((record) => record.id !== incoming.id)]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function modelKey(model: WorkflowModelSelection | undefined): string {
  return model === undefined ? '' : `${model.providerId}\u0000${model.modelId}`
}

function formatGenerationTime(value: string, locale: AppLocale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusLabel(record: WorkflowGenerationRecord, copy: AppCopy): string {
  if (record.status === 'completed') return copy.workflowGenerationCompleted
  if (record.status === 'failed') return copy.workflowGenerationFailed
  return copy.workflowGenerationRunning
}

function phaseIndex(phase: WorkflowGenerationRecord['phase']): number {
  if (phase === 'failed') return -1
  return WORKFLOW_GENERATION_PHASES.indexOf(phase)
}

function effectivePhaseIndex(record: WorkflowGenerationRecord): number {
  if (record.phase !== 'failed') return phaseIndex(record.phase)
  const lastWorkingEvent = [...record.events].reverse().find((event) => event.phase !== 'failed')
  return lastWorkingEvent === undefined ? 0 : phaseIndex(lastWorkingEvent.phase)
}

export function WorkflowGenerationProgressView({ copy, locale, record, onOpenWorkflow }: { copy: AppCopy; locale: AppLocale; record?: WorkflowGenerationRecord; onOpenWorkflow: (workflow: WorkflowDefinition) => void }): JSX.Element {
  const phaseDescriptors = WORKFLOW_GENERATION_PHASES.map((phase) => ({ phase, label: copy[phaseCopyKeys[phase]] as string }))
  const selectedPhaseIndex = record === undefined ? -1 : effectivePhaseIndex(record)
  return <div className="workflow-generation-card workflow-generation-progress-card">
    {record ? <div className="workflow-panel-heading"><div><h2>{record.name}</h2></div><span className={`workflow-generation-status workflow-generation-status-${record.status}`}>{statusLabel(record, copy)}</span></div> : null}
    {record === undefined ? <p className="workflow-generation-placeholder">{copy.workflowGenerationChooseHistory}</p> : <>
      <div className="workflow-generation-original-prompt"><strong>{copy.workflowGenerationOriginalPrompt}</strong><p>{record.prompt}</p></div>
      <p className="workflow-generation-current-message">{record.events.at(-1)?.message ?? copy.workflowGenerationChooseHistory}</p>
      <ol className="workflow-generation-steps">
        {phaseDescriptors.map(({ phase, label }, index) => {
          const complete = record.status === 'completed' || (selectedPhaseIndex >= 0 && index < selectedPhaseIndex)
          const current = record.status === 'running' && selectedPhaseIndex === index
          const failed = record.status === 'failed' && selectedPhaseIndex === index
          return <li key={phase} className={`workflow-generation-step ${complete ? 'workflow-generation-step-complete' : ''} ${current ? 'workflow-generation-step-current' : ''} ${failed ? 'workflow-generation-step-failed' : ''}`}><span className="workflow-generation-step-mark">{complete ? '✓' : current ? '·' : failed ? '!' : String(index + 1)}</span><div><strong>{label}</strong>{current || failed ? <small>{record.events.filter((event) => event.phase === phase).at(-1)?.message}</small> : null}</div></li>
        })}
      </ol>
      <div className="workflow-generation-events">{record.events.map((event, index) => <p key={`${event.time}-${index}`}><time>{formatGenerationTime(event.time, locale)}</time><span>{event.message}</span></p>)}</div>
      {record.warnings?.map((warning, index) => <p key={`${warning}-${index}`} className="workflow-generation-warning">{warning}</p>)}
      {record.workflow ? <button type="button" className="workflow-button-primary" onClick={() => onOpenWorkflow(record.workflow!)}>{copy.workflowGenerationOpenDraft}</button> : <p className="workflow-muted">{copy.workflowGenerationNoWorkflow}</p>}
    </>}
  </div>
}

export function WorkflowGenerationPage({ copy, locale, onBack, onOpenWorkflow }: WorkflowGenerationPageProps): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [history, setHistory] = useState<WorkflowGenerationRecord[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [modelOptions, setModelOptions] = useState<WorkflowModelOption[]>([])
  const [modelSelection, setModelSelection] = useState<WorkflowModelSelection>()
  const [modelLoading, setModelLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const selectedRecord = useMemo(() => history.find((record) => record.id === selectedId) ?? history[0], [history, selectedId])

  useEffect(() => {
    let active = true
    const unsubscribe = window.EzDSH.workflows.onGenerationStateChange((record) => {
      if (!active) return
      setHistory((current) => mergeWorkflowGenerationRecord(current, record))
      if (record.status === 'running') setSelectedId(record.id)
    })
    void window.EzDSH.workflows.listGenerationHistory().then((records) => {
      if (!active) return
      setHistory(records)
      setSelectedId((current) => current ?? records[0]?.id)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    })
    void window.EzDSH.providers.listWorkflowModels().then((models) => {
      if (active) setModelOptions(models)
    }).catch(() => {
      // The default provider model is still available when an optional catalog cannot load.
    }).finally(() => {
      if (active) setModelLoading(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [copy.workflowLoadFailed])

  const refreshModels = async (): Promise<void> => {
    if (modelLoading) return
    setModelLoading(true)
    try {
      const models = await window.EzDSH.providers.listWorkflowModels(true)
      setModelOptions(models)
      if (modelSelection !== undefined && !models.some((model) => modelKey(model) === modelKey(modelSelection))) setModelSelection(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setModelLoading(false)
    }
  }

  const startGeneration = async (): Promise<void> => {
    const value = prompt.trim()
    if (value === '' || busy) return
    const generationId = `generation-${crypto.randomUUID()}`
    setBusy(true)
    setError('')
    setSelectedId(generationId)
    try {
      await window.EzDSH.workflows.generate({
        generationId,
        prompt: value,
        name: value.slice(0, 48),
        ...(modelSelection === undefined ? {} : { model: modelSelection }),
      })
      const records = await window.EzDSH.workflows.listGenerationHistory()
      setHistory(records)
      setSelectedId(generationId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }

  return <div className="workflow-generation-page">
    <header className="workflow-generation-header">
      <div className="workflow-generation-heading">
        <button type="button" className="workflow-back-button" onClick={onBack}>‹ {copy.workflowBack}</button>
        <div><p className="workflow-eyebrow">WORKFLOW / AI</p><h1>{copy.workflowGenerationTitle}</h1><p>{copy.workflowGenerationHint}</p></div>
      </div>
    </header>
    <main className="workflow-generation-content">
      <section className="workflow-generation-main">
        <div className="workflow-generation-card workflow-generation-compose">
          <div><span className="workflow-kicker">{copy.workflowGenerate}</span><h2>{copy.workflowGenerationPromptLabel}</h2></div>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={copy.workflowGeneratePlaceholder} disabled={busy} />
          <div className="workflow-generation-model-row">
            <label className="workflow-generation-model"><span>{copy.workflowModel}</span><select value={modelKey(modelSelection)} onChange={(event) => setModelSelection(modelOptions.find((model) => modelKey(model) === event.target.value))} disabled={busy || modelLoading}><option value="">{copy.workflowUseDefaultModel}</option>{modelOptions.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.providerName} · {model.modelName ?? model.modelId}</option>)}</select></label>
            <button type="button" className="workflow-button-quiet" onClick={() => void refreshModels()} disabled={busy || modelLoading}>{modelLoading ? copy.workflowRefreshingModels : copy.workflowRefreshModels}</button>
          </div>
          <p className="workflow-generation-model-hint">{modelOptions.length === 0 ? copy.workflowNoModels : copy.workflowModelHint}</p>
          <button type="button" className="workflow-button-primary workflow-generation-start workflow-ai-action-button" onClick={() => void startGeneration()} disabled={busy || prompt.trim() === ''}><WandMagicSparklesIcon className="workflow-ai-icon" />{busy ? copy.workflowGenerationStarting : copy.workflowGenerationStart}</button>
          {error ? <div className="workflow-error workflow-generation-error" role="alert">{error}</div> : null}
        </div>
        <WorkflowGenerationProgressView copy={copy} locale={locale} record={selectedRecord} onOpenWorkflow={onOpenWorkflow} />
      </section>
      <aside className="workflow-generation-history">
        <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowGenerationHistory}</span><h2>{copy.workflowGenerationHistory}</h2></div><span className="workflow-run-count">{history.length}</span></div>
        {history.length === 0 ? <p className="workflow-muted">{copy.workflowGenerationHistoryEmpty}</p> : <div className="workflow-generation-history-list">{history.map((record) => <button type="button" key={record.id} className={`workflow-generation-history-item ${selectedRecord?.id === record.id ? 'workflow-generation-history-item-active' : ''}`} onClick={() => setSelectedId(record.id)}><span className={`workflow-generation-history-dot workflow-generation-history-dot-${record.status}`} /><span className="workflow-generation-history-copy"><strong>{record.name}</strong><small>{statusLabel(record, copy)} · {record.model?.modelId ?? copy.workflowUseDefaultModel} · {formatGenerationTime(record.startedAt, locale)}</small><span>{record.prompt}</span></span></button>)}</div>}
      </aside>
    </main>
  </div>
}
