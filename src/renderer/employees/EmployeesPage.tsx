import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  EmployeeCapability,
  EmployeeCreateInput,
  EmployeeProjectSummary,
  EmployeeRunResult,
  EmployeeSessionLock,
  EmployeeSessionSummary,
  EmployeeSnapshot,
  EmployeeUpdateInput,
} from '../../shared/employees.js'
import { EMPLOYEE_CAPABILITIES, employeeDisplayLabel, employeeDisplayName } from '../../shared/employees.js'
import type { AppCopy } from '../../shared/locale.js'
import { WandMagicSparklesIcon } from '../icons/WandMagicSparklesIcon.js'
import './employees.css'

export const EMPLOYEES_REFRESH_EVENT = 'ezdsh:refresh-employees'

interface EmployeesPageProps {
  copy: AppCopy
}

type EditingId = 'new' | string

interface EmployeeDraft {
  id: string
  displayName: string
  /** Legacy short role label retained for old persisted profiles. */
  name: string
  role: string
  description: string
  businessBoundary: string
  systemPrompt: string
  operatingGuidelines: string[]
  qualityStandards: string[]
  capabilities: EmployeeCapability[]
  skillIds: string[]
  enabled: boolean
}

interface EmployeeExecutionTargetProps {
  copy: AppCopy
  projects: EmployeeProjectSummary[]
  projectSessions: EmployeeSessionSummary[]
  selectedProjectId?: string
  selectedSessionId?: string
  contextLoading: boolean
  creatingSession: boolean
  busy: boolean
  sessionLocks: EmployeeSessionLock[]
  onProjectChange: (projectId: string) => void
  onSessionChange: (sessionId: string) => void
  onCreateSession: () => void
  onRefresh: () => void
  onForceUnlock: (sessionId: string) => void
}

const EMPTY_DRAFT: EmployeeDraft = {
  id: '',
  displayName: '',
  name: '',
  role: '',
  description: '',
  businessBoundary: '',
  systemPrompt: '',
  operatingGuidelines: [],
  qualityStandards: [],
  capabilities: [],
  skillIds: [],
  enabled: true,
}

function capabilityLabels(copy: AppCopy): Record<EmployeeCapability, string> {
  return {
    research: copy.employeeCapabilityResearch,
    copywriting: copy.employeeCapabilityCopywriting,
    'image-generation': copy.employeeCapabilityImageGeneration,
    'file-read': copy.employeeCapabilityFileRead,
    'file-write': copy.employeeCapabilityFileWrite,
    workflow: copy.employeeCapabilityWorkflow,
  }
}

function draftFromEmployee(employee: EmployeeSnapshot): EmployeeDraft {
  return {
    id: employee.id,
    displayName: employeeDisplayName(employee),
    name: employee.name,
    role: employee.role,
    description: employee.description,
    businessBoundary: employee.businessBoundary,
    systemPrompt: employee.systemPrompt,
    operatingGuidelines: [...employee.operatingGuidelines],
    qualityStandards: [...employee.qualityStandards],
    capabilities: [...employee.capabilities],
    skillIds: [...employee.skillIds],
    enabled: employee.enabled,
  }
}

function normalizedLines(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))]
}

function draftInput(draft: EmployeeDraft, editingId: EditingId): EmployeeCreateInput | EmployeeUpdateInput | string {
  if (draft.displayName.trim() === '') return 'displayName'
  if (draft.role.trim() === '') return 'role'
  if (draft.systemPrompt.trim() === '') return 'prompt'

  const common = {
    // Keep the legacy field stable for existing profiles; new profiles use the
    // formal role as the compatibility short name.
    name: draft.name.trim() || draft.role.trim(),
    displayName: draft.displayName.trim(),
    role: draft.role.trim(),
    description: draft.description.trim(),
    businessBoundary: draft.businessBoundary.trim() || draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    operatingGuidelines: normalizedLines(draft.operatingGuidelines),
    qualityStandards: normalizedLines(draft.qualityStandards),
    capabilities: [...draft.capabilities],
    skillIds: normalizedLines(draft.skillIds),
    enabled: draft.enabled,
  }
  return editingId === 'new' ? { ...common, builtIn: false } : common
}

function initialOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || 'AI'
}

export function EmployeeExecutionTarget({
  copy,
  projects,
  projectSessions,
  selectedProjectId,
  selectedSessionId,
  contextLoading,
  creatingSession,
  busy,
  sessionLocks,
  onProjectChange,
  onSessionChange,
  onCreateSession,
  onRefresh,
  onForceUnlock,
}: EmployeeExecutionTargetProps): JSX.Element {
  const selectedLock = selectedSessionId === undefined
    ? undefined
    : sessionLocks.find((lock) => lock.sessionId === selectedSessionId)
  return (
    <>
      <div className="employees-run-target-grid">
        <label>
          <span>{copy.employeesProject}</span>
          <select value={selectedProjectId ?? ''} onChange={(event) => { onProjectChange(event.target.value) }} disabled={busy || contextLoading || creatingSession}>
            <option value="">{contextLoading ? copy.employeesLoadingContext : copy.employeesSelectProject}</option>
            {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.title || project.path}</option>)}
          </select>
        </label>
        <label>
          <span>{copy.employeesSession}</span>
          <select value={selectedSessionId ?? ''} onChange={(event) => { onSessionChange(event.target.value) }} disabled={busy || contextLoading || creatingSession || selectedProjectId === undefined}>
            <option value="">{contextLoading ? copy.employeesLoadingContext : copy.employeesSelectSession}</option>
            {projectSessions.map((session) => {
              const locked = sessionLocks.some((lock) => lock.sessionId === session.sessionId)
              return <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}{locked ? ` · ${copy.employeesSessionLocked}` : ''}</option>
            })}
          </select>
        </label>
        <div className="employees-run-target-actions">
          <button type="button" className="employees-button employees-button-quiet" disabled={busy || contextLoading || creatingSession || selectedProjectId === undefined} onClick={onCreateSession}>
            {creatingSession ? copy.employeesCreatingSession : copy.employeesNewSession}
          </button>
          <button
            type="button"
            className="employees-icon-button"
            disabled={busy || contextLoading || creatingSession}
            onClick={onRefresh}
            aria-label={contextLoading ? copy.employeesRefreshingContext : copy.employeesRefreshContext}
            title={contextLoading ? copy.employeesRefreshingContext : copy.employeesRefreshContext}
          >
            <span aria-hidden="true" className="employees-refresh-icon">↻</span>
          </button>
        </div>
      </div>
      {selectedLock ? (
        <div className="employees-session-lock-notice" role="status">
          <span>{copy.employeesSessionLocked} · {copy.employeesRunId}: {selectedLock.runId}</span>
          <button type="button" className="employees-button employees-button-danger" disabled={busy} onClick={() => { onForceUnlock(selectedLock.sessionId) }}>{copy.employeesForceUnlock}</button>
        </div>
      ) : null}
    </>
  )
}

export function reloadPage(): void {
  window.dispatchEvent(new Event(EMPLOYEES_REFRESH_EVENT))
}

/** Management surface for reusable professional employee profiles. */
export function EmployeesPage({ copy }: EmployeesPageProps): JSX.Element {
  const [employees, setEmployees] = useState<EmployeeSnapshot[]>([])
  const [projects, setProjects] = useState<EmployeeProjectSummary[]>([])
  const [sessions, setSessions] = useState<EmployeeSessionSummary[]>([])
  const [sessionLocks, setSessionLocks] = useState<EmployeeSessionLock[]>([])
  const [loading, setLoading] = useState(true)
  const [contextLoading, setContextLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [editingId, setEditingId] = useState<EditingId>()
  const [draft, setDraft] = useState<EmployeeDraft>(EMPTY_DRAFT)
  const [generationPrompt, setGenerationPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generatedProfile, setGeneratedProfile] = useState(false)
  const [newEmployeeMode, setNewEmployeeMode] = useState<'ai' | 'manual'>('ai')
  const [task, setTask] = useState('')
  const [runResult, setRunResult] = useState<EmployeeRunResult>()
  const [busy, setBusy] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [unlockingSessionId, setUnlockingSessionId] = useState<string>()
  const [activeRunCount, setActiveRunCount] = useState(0)
  const [error, setError] = useState<string>()
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const contextRequestRef = useRef(0)
  const selectedProjectIdRef = useRef<string>()
  selectedProjectIdRef.current = selectedProjectId

  const loadEmployees = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const items = await window.EzDSH.employees.list()
      setEmployees(items)
      setSelectedId((current) => current !== undefined && items.some((employee) => employee.id === current) ? current : items[0]?.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setLoading(false)
    }
  }, [copy.employeesFailed])

  const loadExecutionContext = useCallback(async (): Promise<void> => {
    const requestId = ++contextRequestRef.current
    setContextLoading(true)
    try {
      const [nextProjects, nextLocks] = await Promise.all([
        window.EzDSH.employees.listProjects(),
        window.EzDSH.employees.listSessionLocks(),
      ])
      const nextProjectId = nextProjects.find((project) => project.projectId === selectedProjectIdRef.current)?.projectId ?? nextProjects[0]?.projectId
      const nextSessions = nextProjectId === undefined ? [] : await window.EzDSH.employees.listSessions(nextProjectId)
      if (requestId !== contextRequestRef.current) return
      setProjects(nextProjects)
      setSessions(nextSessions)
      setSessionLocks(nextLocks)
      setSelectedProjectId(nextProjectId)
      setSelectedSessionId((current) => current !== undefined && nextSessions.some((session) => session.sessionId === current) ? current : nextSessions[0]?.sessionId)
    } catch (reason) {
      if (requestId === contextRequestRef.current) setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      if (requestId === contextRequestRef.current) setContextLoading(false)
    }
  }, [copy.employeesFailed])

  const loadProjectSessions = useCallback(async (projectId?: string): Promise<void> => {
    const requestId = ++contextRequestRef.current
    setContextLoading(true)
    try {
      const nextSessions = projectId === undefined ? [] : await window.EzDSH.employees.listSessions(projectId)
      if (requestId !== contextRequestRef.current) return
      setSessions(nextSessions)
      setSelectedSessionId((current) => current !== undefined && nextSessions.some((session) => session.sessionId === current) ? current : nextSessions[0]?.sessionId)
    } catch (reason) {
      if (requestId === contextRequestRef.current) setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      if (requestId === contextRequestRef.current) setContextLoading(false)
    }
  }, [copy.employeesFailed])

  useEffect(() => {
    let active = true
    void loadEmployees()
    const unsubscribe = window.EzDSH.employees.onStateChange((items) => {
      if (!active) return
      setEmployees(items)
      setSelectedId((current) => current !== undefined && items.some((employee) => employee.id === current) ? current : items[0]?.id)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [loadEmployees])

  useEffect(() => {
    void loadExecutionContext()
  }, [loadExecutionContext])

  useEffect(() => window.EzDSH.employees.onLockChange((locks) => { setSessionLocks(locks) }), [])

  const selectedEmployee = useMemo(
    () => employees.find((employee) => employee.id === selectedId),
    [employees, selectedId],
  )
  const labels = useMemo(() => capabilityLabels(copy), [copy])

  const setDraftField = <K extends keyof EmployeeDraft>(field: K, value: EmployeeDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const beginAdd = (): void => {
    setEditingId('new')
    setDraft({ ...EMPTY_DRAFT })
    setGenerationPrompt('')
    setGeneratedProfile(false)
    setNewEmployeeMode('ai')
    setRunResult(undefined)
    setError(undefined)
  }

  const beginEdit = (employee: EmployeeSnapshot): void => {
    setSelectedId(employee.id)
    setEditingId(employee.id)
    setDraft(draftFromEmployee(employee))
    setGenerationPrompt('')
    setGeneratedProfile(false)
    setNewEmployeeMode('ai')
    setRunResult(undefined)
    setError(undefined)
  }

  const cancelEdit = (): void => {
    setEditingId(undefined)
    setDraft({ ...EMPTY_DRAFT })
    setGenerationPrompt('')
    setGeneratedProfile(false)
    setNewEmployeeMode('ai')
    setError(undefined)
  }

  const openAssignment = (): void => {
    setAssignmentOpen(true)
    setTask('')
    setRunResult(undefined)
    setError(undefined)
  }

  const closeAssignment = (): void => {
    setAssignmentOpen(false)
    setTask('')
    setRunResult(undefined)
    setError(undefined)
  }

  const generateEmployee = async (): Promise<void> => {
    const prompt = generationPrompt.trim()
    if (prompt === '') {
      setError(copy.employeesGenerationRequired)
      return
    }
    setGenerating(true)
    setError(undefined)
    try {
      const generated = await window.EzDSH.employees.generate({ prompt })
      setDraft({
        id: '',
        displayName: generated.displayName?.trim() || generated.name,
        name: generated.name,
        role: generated.role,
        description: generated.description,
        businessBoundary: generated.businessBoundary,
        systemPrompt: generated.systemPrompt,
        operatingGuidelines: [...generated.operatingGuidelines],
        qualityStandards: [...generated.qualityStandards],
        capabilities: [...generated.capabilities],
        skillIds: [...generated.skillIds],
        enabled: generated.enabled,
      })
      setGeneratedProfile(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setGenerating(false)
    }
  }

  const useManualInput = (): void => {
    setNewEmployeeMode('manual')
    setError(undefined)
  }

  const useAiGeneration = (): void => {
    setNewEmployeeMode('ai')
    setGeneratedProfile(false)
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    if (editingId === undefined) return
    if (editingId === 'new' && newEmployeeMode === 'ai' && !generatedProfile) {
      setError(copy.employeesGenerationRequired)
      return
    }
    const input = draftInput(draft, editingId)
    if (typeof input === 'string') {
      setError(input === 'displayName' ? copy.employeesNameRequired : input === 'role' ? copy.employeesRoleRequired : copy.employeesPromptRequired)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const saved = editingId === 'new'
        ? await window.EzDSH.employees.create(input)
        : await window.EzDSH.employees.update(editingId, input)
      setEmployees((current) => {
        const index = current.findIndex((employee) => employee.id === saved.id)
        return index < 0 ? [...current, saved] : current.map((employee) => employee.id === saved.id ? saved : employee)
      })
      setSelectedId(saved.id)
      cancelEdit()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setBusy(false)
    }
  }

  const setEnabled = async (employee: EmployeeSnapshot): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await window.EzDSH.employees.setEnabled(employee.id, !employee.enabled)
      setEmployees((current) => current.map((item) => item.id === next.id ? next : item))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (employee: EmployeeSnapshot): Promise<void> => {
    if (!window.confirm(`${copy.employeesDelete}: ${employeeDisplayLabel(employee)}?`)) return
    setBusy(true)
    setError(undefined)
    try {
      await window.EzDSH.employees.remove(employee.id)
      const nextSelectedId = employees.find((item) => item.id !== employee.id)?.id
      setEmployees((current) => current.filter((item) => item.id !== employee.id))
      setSelectedId((current) => current === employee.id ? nextSelectedId : current)
      setRunResult(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (selectedEmployee === undefined) return
    if (task.trim() === '') {
      setError(copy.employeesTaskRequired)
      return
    }
    if (selectedProjectId === undefined) {
      setError(copy.employeesProjectRequired)
      return
    }
    if (selectedSessionId === undefined) {
      setError(copy.employeesSessionRequired)
      return
    }
    setActiveRunCount((current) => current + 1)
    setError(undefined)
    setRunResult(undefined)
    try {
      const result = await window.EzDSH.employees.run(selectedEmployee.id, {
        task: task.trim(),
        projectId: selectedProjectId,
        sessionId: selectedSessionId,
      })
      setRunResult(result)
      if (result.status === 'failed' && result.error !== undefined) setError(result.error)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setActiveRunCount((current) => Math.max(0, current - 1))
    }
  }

  const toggleCapability = (capability: EmployeeCapability): void => {
    setDraft((current) => ({
      ...current,
      capabilities: current.capabilities.includes(capability)
        ? current.capabilities.filter((item) => item !== capability)
        : [...current.capabilities, capability],
    }))
  }

  const selectProject = (projectId: string): void => {
    const nextProjectId = projectId || undefined
    setSelectedProjectId(nextProjectId)
    setSelectedSessionId(undefined)
    setSessions([])
    setRunResult(undefined)
    setError(undefined)
    void loadProjectSessions(nextProjectId)
  }

  const createSession = async (): Promise<void> => {
    const projectId = selectedProjectId
    if (projectId === undefined) {
      setError(copy.employeesProjectRequired)
      return
    }
    setCreatingSession(true)
    setError(undefined)
    try {
      const title = window.prompt(copy.employeesSessionTitlePrompt, '')
      if (title === null) return
      const created = await window.EzDSH.employees.createSession(projectId, title)
      setSessions((current) => current.some((session) => session.sessionId === created.sessionId) ? current : [...current, created])
      setProjects((current) => current.map((project) => project.projectId === projectId && !project.sessionIds.includes(created.sessionId)
        ? { ...project, sessionIds: [...project.sessionIds, created.sessionId] }
        : project))
      setSelectedSessionId(created.sessionId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setCreatingSession(false)
    }
  }

  useEffect(() => {
    if (!assignmentOpen) return undefined
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && activeRunCount === 0) closeAssignment()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeRunCount, assignmentOpen])

  const forceUnlockSession = async (sessionId: string): Promise<void> => {
    setUnlockingSessionId(sessionId)
    setError(undefined)
    try {
      await window.EzDSH.employees.forceUnlockSession(sessionId)
      setSessionLocks((current) => current.filter((lock) => lock.sessionId !== sessionId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    } finally {
      setUnlockingSessionId(undefined)
    }
  }

  const renderForm = (): JSX.Element => (
    <section className="employees-panel employees-editor" aria-label={copy.employeesEdit}>
      <div className="employees-panel-header">
        <div>
          <p className="employees-section-kicker">{editingId === 'new' ? copy.employeesAdd : copy.employeesEdit}</p>
          <h2>{editingId === 'new' ? copy.employeesAdd : employeeDisplayLabel({ name: draft.name, displayName: draft.displayName, role: draft.role }) || copy.employeesEdit}</h2>
        </div>
        <div className="employees-actions">
          <button type="button" className="employees-button employees-button-quiet" disabled={busy || generating} onClick={cancelEdit}>{copy.employeesCancel}</button>
          {editingId === 'new' && newEmployeeMode === 'ai' ? (
            <button type="button" className="employees-button employees-button-quiet" disabled={busy || generating} onClick={useManualInput}>{copy.employeesManualInput}</button>
          ) : editingId === 'new' ? (
            <button type="button" className="employees-icon-button employees-ai-button" disabled={busy || generating} onClick={useAiGeneration} aria-label={copy.employeesUseAiGeneration} title={copy.employeesUseAiGeneration}>
              <WandMagicSparklesIcon className="employees-ai-icon" size={17} />
            </button>
          ) : null}
          <button type="button" className="employees-button employees-button-primary" disabled={busy || generating || (editingId === 'new' && newEmployeeMode === 'ai' && !generatedProfile)} onClick={() => { void save() }}>{copy.employeesSave}</button>
        </div>
      </div>
      {editingId === 'new' && newEmployeeMode === 'ai' ? (
        <section className="employees-generation-card" aria-label={copy.employeesDescribeNeed}>
          <div className="employees-generation-copy">
            <p className="employees-section-kicker">{copy.employeesGenerate}</p>
            <h3>{copy.employeesDescribeNeed}</h3>
            <p>{copy.employeesDescribeNeedHint}</p>
          </div>
          <label className="employees-generation-input">
            <span>{copy.employeesDescribeNeed}</span>
            <textarea
              rows={5}
              value={generationPrompt}
              onChange={(event) => { setGenerationPrompt(event.target.value) }}
              placeholder={copy.employeesDescribeNeedPlaceholder}
              disabled={generating || busy}
              autoFocus
            />
          </label>
          <div className="employees-generation-actions">
            <button type="button" className="employees-button employees-button-primary employees-ai-action-button" disabled={generating || busy || generationPrompt.trim() === ''} onClick={() => { void generateEmployee() }}>
              <WandMagicSparklesIcon className="employees-ai-icon" />{generating ? copy.employeesGenerating : copy.employeesGenerate}
            </button>
            {generatedProfile ? <span className="employees-generation-status">{copy.employeesGeneratedHint}</span> : null}
          </div>
        </section>
      ) : null}
      {editingId !== 'new' || newEmployeeMode === 'manual' || generatedProfile ? <>
      <div className="employees-form-grid">
        <label>
          <span>{copy.employeesName}</span>
          <input value={draft.displayName} onChange={(event) => { setDraftField('displayName', event.target.value) }} autoFocus />
        </label>
        <label>
          <span>{copy.employeesRole}</span>
          <input value={draft.role} onChange={(event) => { setDraftField('role', event.target.value) }} />
        </label>
        <label className="employees-form-wide">
          <span>{copy.employeesDescription}</span>
          <input value={draft.description} onChange={(event) => { setDraftField('description', event.target.value) }} />
        </label>
        <label className="employees-form-wide">
          <span>{copy.employeesBusinessBoundary}</span>
          <textarea rows={3} value={draft.businessBoundary} onChange={(event) => { setDraftField('businessBoundary', event.target.value) }} />
        </label>
        <label className="employees-form-wide">
          <span>{copy.employeesSystemPrompt}</span>
          <textarea rows={6} value={draft.systemPrompt} onChange={(event) => { setDraftField('systemPrompt', event.target.value) }} />
        </label>
        <label>
          <span>{copy.employeesOperatingGuidelines}</span>
          <textarea rows={6} value={draft.operatingGuidelines.join('\n')} onChange={(event) => { setDraftField('operatingGuidelines', event.target.value.split('\n')) }} placeholder={copy.employeesOperatingGuidelinesHint} />
        </label>
        <label>
          <span>{copy.employeesQualityStandards}</span>
          <textarea rows={6} value={draft.qualityStandards.join('\n')} onChange={(event) => { setDraftField('qualityStandards', event.target.value.split('\n')) }} placeholder={copy.employeesQualityStandardsHint} />
        </label>
        <label className="employees-form-wide">
          <span>{copy.employeesSkillIds}</span>
          <textarea rows={3} value={draft.skillIds.join('\n')} onChange={(event) => { setDraftField('skillIds', event.target.value.split('\n')) }} placeholder={copy.employeesSkillIdsHint} />
        </label>
      </div>

      <div className="employees-form-section">
        <div className="employees-section-heading">
          <div><h3>{copy.employeesCapabilities}</h3></div>
        </div>
        <div className="employees-capability-grid">
          {EMPLOYEE_CAPABILITIES.map((capability) => (
            <label className={`employees-capability-option ${draft.capabilities.includes(capability) ? 'employees-capability-option-active' : ''}`} key={capability}>
              <input type="checkbox" checked={draft.capabilities.includes(capability)} onChange={() => { toggleCapability(capability) }} />
              <span>{labels[capability]}</span>
            </label>
          ))}
        </div>
      </div>
      </> : null}

      {error ? <p className="employees-error" role="alert">{error}</p> : null}
    </section>
  )

  const renderDetail = (): JSX.Element => {
    if (selectedEmployee === undefined) {
      return <section className="employees-panel employees-detail-empty"><p>{copy.employeesEmpty}</p></section>
    }
    return (
      <div className="employees-detail-stack">
        <section className="employees-panel employees-profile-panel">
          <div className="employees-profile-header">
            <div className="employees-avatar employees-avatar-large">{initialOf(employeeDisplayName(selectedEmployee))}</div>
            <div className="employees-profile-copy">
              <div className="employees-title-line">
                <h2>{employeeDisplayLabel(selectedEmployee)}</h2>
                <span className={`employees-status ${selectedEmployee.enabled ? 'employees-status-enabled' : 'employees-status-disabled'}`}>
                  {selectedEmployee.enabled ? copy.employeesEnabled : copy.employeesDisabled}
                </span>
                {selectedEmployee.builtIn ? <span className="employees-built-in">{copy.employeesBuiltIn}</span> : null}
              </div>
              <p className="employees-description">{selectedEmployee.description || selectedEmployee.systemPrompt}</p>
            </div>
            <div className="employees-actions employees-profile-actions">
              <button type="button" className="employees-button employees-button-primary" disabled={busy} onClick={openAssignment}>{copy.employeesAssignTask}</button>
              <button type="button" className="employees-button employees-button-quiet" disabled={busy} onClick={() => { void setEnabled(selectedEmployee) }}>{selectedEmployee.enabled ? copy.employeesDisable : copy.employeesEnable}</button>
              <button type="button" className="employees-button employees-button-quiet" disabled={busy} onClick={() => { beginEdit(selectedEmployee) }}>{copy.employeesEdit}</button>
              <button type="button" className="employees-button employees-button-danger" disabled={busy} onClick={() => { void remove(selectedEmployee) }}>{copy.employeesDelete}</button>
            </div>
          </div>
          <div className="employees-profile-meta">
            <div><span>{copy.employeesCapabilities}</span><p>{selectedEmployee.capabilities.length > 0 ? selectedEmployee.capabilities.map((capability) => labels[capability]).join(' · ') : '—'}</p></div>
            <div><span>{copy.employeesProfileVersion}</span><p>v{selectedEmployee.version}</p></div>
            <div><span>ID</span><code>{selectedEmployee.id}</code></div>
          </div>
        </section>

        <section className="employees-panel employees-profile-sections-panel">
          <div className="employees-panel-header employees-panel-header-compact">
            <div><h3>{copy.employeesProfileSections}</h3></div>
          </div>
          <div className="employees-profile-sections">
            <ProfileSection title={copy.employeesBusinessBoundary} values={[selectedEmployee.businessBoundary]} />
            <ProfileSection title={copy.employeesOperatingGuidelines} values={selectedEmployee.operatingGuidelines} ordered />
            <ProfileSection title={copy.employeesQualityStandards} values={selectedEmployee.qualityStandards} ordered />
            <ProfileSection title={copy.employeesSkillIds} values={selectedEmployee.skillIds} code />
          </div>
        </section>

      </div>
    )
  }

  const renderAssignmentDialog = (): JSX.Element | null => {
    if (!assignmentOpen || selectedEmployee === undefined) return null
    return (
      <div className="employees-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && activeRunCount === 0) closeAssignment() }}>
        <section className="employees-task-dialog" role="dialog" aria-modal="true" aria-labelledby="employees-task-dialog-title">
          <div className="employees-dialog-header">
            <div>
              <p className="employees-section-kicker">{copy.employeesAssignTask}</p>
              <h2 id="employees-task-dialog-title">{employeeDisplayLabel(selectedEmployee)}</h2>
              <p>{copy.employeesTaskHint}</p>
            </div>
            <button type="button" className="employees-dialog-close" aria-label={copy.employeesCancel} disabled={activeRunCount > 0} onClick={closeAssignment}>×</button>
          </div>
          <div className="employees-run-content">
            <EmployeeExecutionTarget
              copy={copy}
              projects={projects}
              projectSessions={sessions}
              selectedProjectId={selectedProjectId}
              selectedSessionId={selectedSessionId}
              contextLoading={contextLoading}
              creatingSession={creatingSession}
              busy={busy}
              sessionLocks={sessionLocks}
              onProjectChange={selectProject}
              onSessionChange={(sessionId) => { setSelectedSessionId(sessionId || undefined); setRunResult(undefined) }}
              onCreateSession={() => { void createSession() }}
              onRefresh={() => { void loadExecutionContext() }}
              onForceUnlock={(sessionId) => { void forceUnlockSession(sessionId) }}
            />
            <label>
              <span>{copy.employeesTask}</span>
              <textarea rows={5} value={task} onChange={(event) => { setTask(event.target.value) }} placeholder={employeeDisplayLabel(selectedEmployee)} disabled={busy || creatingSession || !selectedEmployee.enabled} autoFocus />
            </label>
            <div className="employees-run-actions">
              <button type="button" className="employees-button employees-button-primary" disabled={busy || creatingSession || contextLoading || unlockingSessionId !== undefined || !selectedEmployee.enabled || selectedProjectId === undefined || selectedSessionId === undefined || sessionLocks.some((lock) => lock.sessionId === selectedSessionId)} onClick={() => { void run() }}>
                {activeRunCount > 0 ? `${copy.employeesRun} · ${activeRunCount}` : copy.employeesRun}
              </button>
              <button type="button" className="employees-button employees-button-quiet" disabled={activeRunCount > 0} onClick={closeAssignment}>{copy.employeesCancel}</button>
              {activeRunCount > 0 ? <span className="employees-muted">{copy.employeesRunning}</span> : null}
              {!selectedEmployee.enabled ? <span className="employees-muted">{copy.employeesDisabled}</span> : null}
            </div>
            {error ? <p className="employees-error" role="alert">{error}</p> : null}
            {runResult ? <RunResult copy={copy} result={runResult} /> : null}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="employees-page">
      <header className="employees-header">
        <div>
          <span className="employees-eyebrow">{copy.employeesPreviewBadge}</span>
          <h1>{copy.employeesTitle}</h1>
          <p>{copy.employeesHint}</p>
        </div>
        <div className="employees-header-actions">
          <button type="button" className="employees-button employees-button-quiet employees-reload-button" disabled={busy} onClick={reloadPage}>
            {copy.employeesRefresh}
          </button>
          <button type="button" className="employees-button employees-button-primary employees-add-button" disabled={loading || editingId !== undefined} onClick={beginAdd}>{copy.employeesAdd}</button>
        </div>
      </header>

      <div className="employees-layout">
        <aside className="employees-panel employees-list-panel" aria-label={copy.employeesList}>
          <div className="employees-panel-header employees-panel-header-compact">
            <h2>{copy.employeesList}</h2>
            <span className="employees-count">{employees.length}</span>
          </div>
          {loading ? <p className="employees-muted employees-panel-content">{copy.employeesLoading}</p> : employees.length === 0 ? <p className="employees-muted employees-panel-content">{copy.employeesEmpty}</p> : (
            <div className="employees-list">
              {employees.map((employee) => (
                <button type="button" className={`employees-list-item ${selectedId === employee.id ? 'employees-list-item-active' : ''}`} key={employee.id} onClick={() => { setSelectedId(employee.id); setEditingId(undefined); setError(undefined); setRunResult(undefined) }}>
                  <span className="employees-avatar">{initialOf(employeeDisplayName(employee))}</span>
                  <span className="employees-list-copy"><strong>{employeeDisplayLabel(employee)}</strong></span>
                  <span className={`employees-list-dot ${employee.enabled ? 'employees-list-dot-enabled' : ''}`} aria-label={employee.enabled ? copy.employeesEnabled : copy.employeesDisabled} />
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="employees-main" aria-live="polite">
          {editingId !== undefined ? renderForm() : renderDetail()}
        </main>
      </div>
      {renderAssignmentDialog()}
    </div>
  )
}

function ProfileSection({ title, values, ordered = false, code = false }: { title: string; values: string[]; ordered?: boolean; code?: boolean }): JSX.Element {
  const content = values.filter(Boolean)
  return (
    <section className="employees-profile-section">
      <h4>{title}</h4>
      {content.length === 0 ? <p>—</p> : ordered ? (
        <ol>{content.map((value) => <li key={value}>{value}</li>)}</ol>
      ) : code ? (
        <div className="employees-skill-id-list">{content.map((value) => <code key={value}>{value}</code>)}</div>
      ) : <p>{content.join('\n')}</p>}
    </section>
  )
}

function RunResult({ copy, result }: { copy: AppCopy; result: EmployeeRunResult }): JSX.Element {
  return (
    <div className="employees-run-result">
      <div className="employees-run-result-header">
        <strong>{copy.employeesRunResults}</strong>
        <span className={`employees-status ${result.status === 'completed' ? 'employees-status-enabled' : 'employees-status-disabled'}`}>
          {result.status === 'completed' ? copy.employeesRunCompleted : copy.employeesRunFailed}
        </span>
      </div>
      <ol className="employees-run-step-list">
        {result.steps.map((step) => (
          <li key={step.stepId}>
            <div><strong>{step.name}</strong><span className="employees-step-state">{step.status === 'completed' ? copy.employeesRunCompleted : copy.employeesRunFailed}</span></div>
            <p>{step.output || step.error || '—'}</p>
          </li>
        ))}
      </ol>
      <div className="employees-final-output"><span>{copy.employeesOutput}</span><p>{result.output || result.error || '—'}</p></div>
    </div>
  )
}
