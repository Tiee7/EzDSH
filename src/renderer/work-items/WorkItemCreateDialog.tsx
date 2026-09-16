import { useEffect, useRef, useState } from 'react'
import { isWorkflowValue } from '../../shared/workflow.js'
import type {
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'
import {
  buildWorkItemCreateSubmission,
  finalizeWorkItemCreateExecution,
  type WorkItemCreateExecutor,
  type WorkItemCreateSubmission,
} from './work-item-create-flow.js'

export interface WorkItemCreateEmployeeCandidate {
  employeeId: string
  label: string
  methodId?: string
  methodVersion?: number
}

export interface WorkItemCreateWorkflowCandidate {
  workflowId: string
  label: string
  workflowRevision?: number
}

export interface WorkItemCreateProjectCandidate {
  projectId: string
  label: string
  cwd?: string
}

export interface WorkItemCreateDialogProps {
  employees: WorkItemCreateEmployeeCandidate[]
  workflows: WorkItemCreateWorkflowCandidate[]
  projects: WorkItemCreateProjectCandidate[]
  locale?: 'zh' | 'en'
  onCreate: (request: WorkTaskCreateRequest) => Promise<WorkTaskSnapshot>
  onExecute: (request: WorkTaskExecuteRequest) => Promise<WorkTaskSnapshot>
  onCreated: (snapshot: WorkTaskSnapshot) => void
  onExecuted: (snapshot: WorkTaskSnapshot) => void
  onClose: () => void
}

interface PendingSubmission {
  signature: string
  submission: WorkItemCreateSubmission
  created?: WorkTaskSnapshot
}

const copy = {
  zh: {
    title: '创建工作项',
    titleField: '标题',
    goal: '目标',
    acceptance: '验收标准',
    project: '项目',
    noProject: '不选择项目',
    executor: '处理方式',
    createOnly: '只创建，稍后处理',
    employee: '员工',
    workflow: 'Workflow',
    employeeInput: '执行说明',
    workflowInput: 'Workflow 输入（JSON）',
    close: '关闭',
    submitCreate: '只创建',
    submitExecute: '创建并执行',
    retryExecute: '重试执行',
    submitting: '正在提交…',
    required: '标题、目标和验收标准均为必填项。',
    chooseEmployee: '请选择员工。',
    chooseWorkflow: '请选择 Workflow。',
    employeeInputRequired: '执行说明为必填项。',
    workflowJson: '请填写有效的 JSON。',
    workflowSafe: 'Workflow 输入必须是有限且安全的 JSON 值。',
    createdRetry: '工作项已创建。你可以用同一请求重试执行，关闭不会再次提交。',
  },
  en: {
    title: 'Create work item',
    titleField: 'Title',
    goal: 'Goal',
    acceptance: 'Acceptance criteria',
    project: 'Project',
    noProject: 'No project',
    executor: 'Processing mode',
    createOnly: 'Create only, handle later',
    employee: 'Employee',
    workflow: 'Workflow',
    employeeInput: 'Execution instructions',
    workflowInput: 'Workflow input (JSON)',
    close: 'Close',
    submitCreate: 'Create only',
    submitExecute: 'Create and execute',
    retryExecute: 'Retry execution',
    submitting: 'Submitting…',
    required: 'Title, goal, and acceptance criteria are required.',
    chooseEmployee: 'Select an employee.',
    chooseWorkflow: 'Select a workflow.',
    employeeInputRequired: 'Execution instructions are required.',
    workflowJson: 'Enter valid JSON.',
    workflowSafe: 'Workflow input must be a finite JSON-safe value.',
    createdRetry: 'The work item was created. You can retry execution with the same request; closing will not submit it again.',
  },
} as const

function requestIds(): { createRequestId: string; executeRequestId: string } {
  const token = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    createRequestId: `work-item-create-${token}`,
    executeRequestId: `work-item-execute-${token}`,
  }
}

/** A bridge-independent direct creation dialog with an explicit create/execute boundary. */
export function WorkItemCreateDialog({
  employees,
  workflows,
  projects,
  locale = 'zh',
  onCreate,
  onExecute,
  onCreated,
  onExecuted,
  onClose,
}: WorkItemCreateDialogProps): JSX.Element {
  const text = copy[locale]
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [projectId, setProjectId] = useState('')
  const [mode, setMode] = useState<'none' | 'employee' | 'workflow'>('none')
  const [employeeId, setEmployeeId] = useState(employees[0]?.employeeId ?? '')
  const [workflowId, setWorkflowId] = useState(workflows[0]?.workflowId ?? '')
  const [executionInput, setExecutionInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdSnapshot, setCreatedSnapshot] = useState<WorkTaskSnapshot>()
  const inFlight = useRef(false)
  const pending = useRef<PendingSubmission>()
  const locked = createdSnapshot !== undefined

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.isComposing || busy) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  function selectMode(next: 'none' | 'employee' | 'workflow'): void {
    setMode(next)
    setError('')
    if (next === 'workflow') setExecutionInput('{}')
    else setExecutionInput('')
  }

  function prepare(): { signature: string; submission: WorkItemCreateSubmission } | undefined {
    if (title.trim() === '' || goal.trim() === '' || acceptance.trim() === '') {
      setError(text.required)
      return undefined
    }

    let executor: WorkItemCreateExecutor = { kind: 'none' }
    let parsedInput: unknown = undefined
    if (mode === 'employee') {
      const candidate = employees.find((item) => item.employeeId === employeeId)
      if (candidate === undefined) {
        setError(text.chooseEmployee)
        return undefined
      }
      if (executionInput.trim() === '') {
        setError(text.employeeInputRequired)
        return undefined
      }
      executor = {
        kind: 'employee',
        employeeId: candidate.employeeId,
        ...(candidate.methodId === undefined ? {} : {
          methodId: candidate.methodId,
          ...(candidate.methodVersion === undefined ? {} : { methodVersion: candidate.methodVersion }),
        }),
      }
      parsedInput = executionInput.trim()
    } else if (mode === 'workflow') {
      const candidate = workflows.find((item) => item.workflowId === workflowId)
      if (candidate === undefined) {
        setError(text.chooseWorkflow)
        return undefined
      }
      try {
        parsedInput = JSON.parse(executionInput)
      } catch {
        setError(text.workflowJson)
        return undefined
      }
      if (!isWorkflowValue(parsedInput)) {
        setError(text.workflowSafe)
        return undefined
      }
      executor = {
        kind: 'workflow',
        workflowId: candidate.workflowId,
        ...(candidate.workflowRevision === undefined ? {} : { workflowRevision: candidate.workflowRevision }),
      }
    }

    const project = projectId === '' ? undefined : projects.find((item) => item.projectId === projectId)
    const signature = JSON.stringify({
      title: title.trim(),
      goal: goal.trim(),
      acceptance: acceptance.trim(),
      projectId: project?.projectId,
      cwd: project?.cwd,
      executor,
      executionInput: parsedInput,
    })
    const existing = pending.current
    if (existing?.signature === signature) return existing
    return {
      signature,
      submission: buildWorkItemCreateSubmission({
        title,
        goal,
        acceptance,
        projectId: project?.projectId,
        cwd: project?.cwd,
        executor,
        executionInput: parsedInput,
        ...requestIds(),
      }),
    }
  }

  async function submit(): Promise<void> {
    if (inFlight.current) return
    const prepared = prepare()
    if (prepared === undefined) return
    const current = prepared as PendingSubmission
    pending.current = current
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      let created = current.created
      if (created === undefined) {
        created = await onCreate(current.submission.create)
        current.created = created
        setCreatedSnapshot(created)
        onCreated(created)
      }
      if (current.submission.execute !== undefined) {
        const executed = await onExecute(finalizeWorkItemCreateExecution(current.submission.execute, created))
        onExecuted(executed)
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <div className="work-item-create-backdrop" role="presentation">
    <section className="work-item-create-dialog" role="dialog" aria-modal="true" aria-labelledby="work-item-create-dialog-title">
      <div className="work-item-create-fields">
      <h2 id="work-item-create-dialog-title">{text.title}</h2>
      <label>{text.titleField}
        <input aria-label={text.titleField} aria-required="true" value={title} disabled={busy || locked} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>{text.goal}
        <textarea aria-label={text.goal} aria-required="true" rows={4} value={goal} disabled={busy || locked} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <label>{text.acceptance}
        <textarea aria-label={text.acceptance} aria-required="true" rows={4} value={acceptance} disabled={busy || locked} onChange={(event) => setAcceptance(event.target.value)} />
      </label>
      <label>{text.project}
        <select aria-label={text.project} value={projectId} disabled={busy || locked} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">{text.noProject}</option>
          {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.label}</option>)}
        </select>
      </label>
      <label>{text.executor}
        <select aria-label={text.executor} value={mode} disabled={busy || locked} onChange={(event) => selectMode(event.target.value as 'none' | 'employee' | 'workflow')}>
          <option value="none">{text.createOnly}</option>
          <option value="employee">{text.employee}</option>
          <option value="workflow">{text.workflow}</option>
        </select>
      </label>
      {mode === 'employee' ? <>
        <label>{text.employee}
          <select aria-label={text.employee} value={employeeId} disabled={busy || locked} onChange={(event) => setEmployeeId(event.target.value)}>
            {employees.map((employee) => <option key={`${employee.employeeId}:${employee.methodId ?? ''}:${employee.methodVersion ?? ''}`} value={employee.employeeId}>{employee.label}</option>)}
          </select>
        </label>
        <label>{text.employeeInput}
          <textarea aria-label={text.employeeInput} aria-required="true" rows={4} value={executionInput} disabled={busy || locked} onChange={(event) => setExecutionInput(event.target.value)} />
        </label>
      </> : null}
      {mode === 'workflow' ? <>
        <label>{text.workflow}
          <select aria-label={text.workflow} value={workflowId} disabled={busy || locked} onChange={(event) => setWorkflowId(event.target.value)}>
            {workflows.map((workflow) => <option key={`${workflow.workflowId}:${workflow.workflowRevision ?? ''}`} value={workflow.workflowId}>{workflow.label}</option>)}
          </select>
        </label>
        <label>{text.workflowInput}
          <textarea aria-label={text.workflowInput} aria-required="true" rows={6} value={executionInput} disabled={busy || locked} onChange={(event) => setExecutionInput(event.target.value)} />
        </label>
      </> : null}
      {locked ? <p>{text.createdRetry}</p> : null}
      {error !== '' ? <p role="alert">{error}</p> : null}
      </div>
      <div className="work-item-create-actions">
      <button type="button" className="work-items-button" disabled={busy} onClick={() => { void submit() }}>
        {busy ? text.submitting : locked ? text.retryExecute : mode === 'none' ? text.submitCreate : text.submitExecute}
      </button>
      <button type="button" className="work-items-button work-items-button-quiet" disabled={busy} onClick={onClose}>{text.close}</button>
      </div>
    </section>
  </div>
}
