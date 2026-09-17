import { useEffect, useRef, useState } from 'react'
import { isWorkflowValue } from '../../shared/workflow.js'
import type {
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'
import {
  buildWorkItemCreateSubmission,
  buildLocalMaterialRefs,
  finalizeWorkItemCreateExecution,
  parseLocalMaterialPaths,
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
  unavailableCatalogs?: Array<'employees' | 'workflows' | 'projects'>
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
    intro: '先写清要完成什么，再决定是否现在执行。保存后，这项工作会出现在工作台中，执行过程和成果也会跟着它保留。',
    flowDefine: '1. 定义工作',
    flowDefineHelp: '标题、目标、验收标准说明要做什么，以及什么算完成。',
    flowContext: '2. 补充上下文（可选）',
    flowContextHelp: '项目用于归类；选择员工时还会作为员工会话的项目上下文。资料只引用你明确输入的本地文件。',
    flowExecute: '3. 选择执行',
    flowExecuteHelp: '只创建会先保存；选择员工或 Workflow 会在保存后立即开始一次执行。',
    flowReview: '4. 查看结果',
    flowReviewHelp: '执行后在工作项详情查看运行记录和成果，验收通过或重做；失败可以重试。',
    titleField: '标题',
    titleHelp: '用一句话命名这项工作，方便之后在列表中找到它。',
    goal: '目标',
    goalHelp: '写最终想得到的结果；它会和执行说明一起交给执行者。',
    acceptance: '验收标准',
    acceptanceHelp: '写判断结果是否合格的条件；后续验收和重做都会依据它。',
    project: '项目',
    projectHelp: '用于归类；选择员工时会作为员工会话的项目上下文，但不会把外部项目路径写成本地工作目录。',
    noProject: '不选择项目',
    executor: '处理方式',
    executorHelp: '只创建：先保存，稍后从工作项详情执行。员工或 Workflow：保存后立即开始一次执行。',
    createOnly: '只创建，稍后处理',
    employee: '员工',
    employeeHelp: '选择负责本次执行的员工。',
    workflow: 'Workflow',
    workflowHelp: '选择要运行的固定流程版本。',
    employeeInput: '执行说明',
    employeeInputHelp: '写这一次要完成的具体动作；它会和目标、验收标准一起发送。',
    workflowInput: 'Workflow 输入（JSON）',
    workflowInputHelp: '传给流程的结构化输入；没有额外参数时保留 {}。',
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
    catalogUnavailable: '部分目录暂时不可用：',
    catalogEmployees: '员工',
    catalogWorkflows: 'Workflow',
    catalogProjects: '项目',
    catalogFallback: '仍可不选项目并只创建工作项。',
    materials: '资料',
    materialsPlaceholder: '每行输入一个工作项工作目录内的相对本地文件路径，例如 docs/brief.md',
    materialsHelp: '可选。每行写一个当前工作区内的本地文件路径；创建或执行前会检查文件是否存在并确认权限。',
    materialsNone: '尚未选择资料。',
    materialsInvalid: '资料路径必须是工作项工作目录内的相对路径，每行一个文件；不能使用绝对路径或 ..。',
  },
  en: {
    title: 'Create work item',
    intro: 'Describe the outcome first, then decide whether to run it now. Once saved, the work item keeps its execution history and deliverables in the Workbench.',
    flowDefine: '1. Define the work',
    flowDefineHelp: 'Title, goal, and acceptance criteria say what to do and what counts as done.',
    flowContext: '2. Add context (optional)',
    flowContextHelp: 'A project groups the item and provides employee session context; materials reference only local files you enter explicitly.',
    flowExecute: '3. Choose execution',
    flowExecuteHelp: 'Create only saves it; choosing an employee or workflow starts one attempt after saving.',
    flowReview: '4. Review the result',
    flowReviewHelp: 'Open the work item to review runs and deliverables, accept or redo the result, and retry failures.',
    titleField: 'Title',
    titleHelp: 'Name the work in one sentence so you can find it later.',
    goal: 'Goal',
    goalHelp: 'Describe the result you want; it is sent with the execution instructions.',
    acceptance: 'Acceptance criteria',
    acceptanceHelp: 'State how you will decide whether the result is good enough; review and redo use this.',
    project: 'Project',
    projectHelp: 'Used for grouping and employee session context; an external project path is never written as the local working directory.',
    noProject: 'No project',
    executor: 'Processing mode',
    executorHelp: 'Create only saves it for later. Employee or workflow saves it and starts one execution immediately.',
    createOnly: 'Create only, handle later',
    employee: 'Employee',
    employeeHelp: 'Choose who will perform this execution.',
    workflow: 'Workflow',
    workflowHelp: 'Choose the fixed workflow version to run.',
    employeeInput: 'Execution instructions',
    employeeInputHelp: 'Describe the concrete action for this attempt; it is sent with the goal and criteria.',
    workflowInput: 'Workflow input (JSON)',
    workflowInputHelp: 'Structured input for the workflow; keep {} when there are no extra parameters.',
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
    catalogUnavailable: 'Some catalogs are unavailable: ',
    catalogEmployees: 'employees',
    catalogWorkflows: 'workflows',
    catalogProjects: 'projects',
    catalogFallback: 'You can still create the work item without a project.',
    materials: 'Materials',
    materialsPlaceholder: 'One work-item-working-directory-relative local file per line, for example docs/brief.md',
    materialsHelp: 'Optional. Enter one local file path inside the current workspace per line; existence and permission are checked before creation or execution.',
    materialsNone: 'No materials selected.',
    materialsInvalid: 'Material paths must stay within the work item working directory, one file per line; absolute paths and .. are not allowed.',
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
  unavailableCatalogs = [],
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
  const [materialPaths, setMaterialPaths] = useState('')
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
    let normalizedMaterialPaths: string[]
    try {
      normalizedMaterialPaths = parseLocalMaterialPaths(materialPaths)
    } catch {
      setError(text.materialsInvalid)
      return undefined
    }
    const materialRefs = buildLocalMaterialRefs(normalizedMaterialPaths)
    const signature = JSON.stringify({
      title: title.trim(),
      goal: goal.trim(),
      acceptance: acceptance.trim(),
      projectId: project?.projectId,
      cwd: project?.cwd,
      materialRefs,
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
        materialPaths: normalizedMaterialPaths,
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
      <p className="work-item-create-intro">{text.intro}</p>
      <ol className="work-item-create-flow" aria-label={locale === 'en' ? 'Creation flow' : '创建流程'}>
        <li><strong>{text.flowDefine}</strong><span>{text.flowDefineHelp}</span></li>
        <li><strong>{text.flowContext}</strong><span>{text.flowContextHelp}</span></li>
        <li><strong>{text.flowExecute}</strong><span>{text.flowExecuteHelp}</span></li>
        <li><strong>{text.flowReview}</strong><span>{text.flowReviewHelp}</span></li>
      </ol>
      {unavailableCatalogs.length === 0 ? null : <p className="work-item-create-catalog-notice" role="status">
        {text.catalogUnavailable}{unavailableCatalogs.map((catalog) => catalog === 'employees'
          ? text.catalogEmployees
          : catalog === 'workflows'
            ? text.catalogWorkflows
            : text.catalogProjects).join(locale === 'en' ? ', ' : '、')}{locale === 'en' ? '. ' : '。'}{text.catalogFallback}
      </p>}
      <label><span>{text.titleField}</span>
        <input aria-label={text.titleField} aria-required="true" value={title} disabled={busy || locked} onChange={(event) => setTitle(event.target.value)} />
        <small className="work-item-create-field-help">{text.titleHelp}</small>
      </label>
      <label><span>{text.goal}</span>
        <textarea aria-label={text.goal} aria-required="true" rows={4} value={goal} disabled={busy || locked} onChange={(event) => setGoal(event.target.value)} />
        <small className="work-item-create-field-help">{text.goalHelp}</small>
      </label>
      <label><span>{text.acceptance}</span>
        <textarea aria-label={text.acceptance} aria-required="true" rows={4} value={acceptance} disabled={busy || locked} onChange={(event) => setAcceptance(event.target.value)} />
        <small className="work-item-create-field-help">{text.acceptanceHelp}</small>
      </label>
      <label><span>{text.project}</span>
        <select aria-label={text.project} value={projectId} disabled={busy || locked} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">{text.noProject}</option>
          {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.label}</option>)}
        </select>
        <small className="work-item-create-field-help">{text.projectHelp}</small>
      </label>
      <section className="work-item-create-materials" data-material-selection="manual-local-file" aria-label={text.materials}>
        <label><span>{text.materials}</span>
          <textarea
            aria-label={text.materials}
            aria-describedby="work-item-create-material-help"
            placeholder={text.materialsPlaceholder}
            rows={3}
            value={materialPaths}
            disabled={busy || locked}
            onChange={(event) => setMaterialPaths(event.target.value)}
          />
        </label>
        <p id="work-item-create-material-help">{text.materialsHelp}</p>
        {(() => {
          try {
            const paths = parseLocalMaterialPaths(materialPaths)
            if (paths.length === 0) return <p className="work-item-create-material-empty">{text.materialsNone}</p>
            const refs = buildLocalMaterialRefs(paths)
            return <ul className="work-item-create-material-list">
              {refs.map((ref) => <li key={ref.materialId}>
                <code>{ref.kind === 'local-file' ? ref.path : ref.materialId}</code>
                <small>{ref.materialId}</small>
              </li>)}
            </ul>
          } catch {
            return null
          }
        })()}
      </section>
      <label><span>{text.executor}</span>
        <select aria-label={text.executor} value={mode} disabled={busy || locked} onChange={(event) => selectMode(event.target.value as 'none' | 'employee' | 'workflow')}>
          <option value="none">{text.createOnly}</option>
          <option value="employee" disabled={employees.length === 0}>{text.employee}</option>
          <option value="workflow" disabled={workflows.length === 0}>{text.workflow}</option>
        </select>
        <small className="work-item-create-field-help">{text.executorHelp}</small>
      </label>
      {mode === 'employee' ? <>
        <label><span>{text.employee}</span>
          <select aria-label={text.employee} value={employeeId} disabled={busy || locked} onChange={(event) => setEmployeeId(event.target.value)}>
            {employees.map((employee) => <option key={`${employee.employeeId}:${employee.methodId ?? ''}:${employee.methodVersion ?? ''}`} value={employee.employeeId}>{employee.label}</option>)}
          </select>
          <small className="work-item-create-field-help">{text.employeeHelp}</small>
        </label>
        <label><span>{text.employeeInput}</span>
          <textarea aria-label={text.employeeInput} aria-required="true" rows={4} value={executionInput} disabled={busy || locked} onChange={(event) => setExecutionInput(event.target.value)} />
          <small className="work-item-create-field-help">{text.employeeInputHelp}</small>
        </label>
      </> : null}
      {mode === 'workflow' ? <>
        <label><span>{text.workflow}</span>
          <select aria-label={text.workflow} value={workflowId} disabled={busy || locked} onChange={(event) => setWorkflowId(event.target.value)}>
            {workflows.map((workflow) => <option key={`${workflow.workflowId}:${workflow.workflowRevision ?? ''}`} value={workflow.workflowId}>{workflow.label}</option>)}
          </select>
          <small className="work-item-create-field-help">{text.workflowHelp}</small>
        </label>
        <label><span>{text.workflowInput}</span>
          <textarea aria-label={text.workflowInput} aria-required="true" rows={6} value={executionInput} disabled={busy || locked} onChange={(event) => setExecutionInput(event.target.value)} />
          <small className="work-item-create-field-help">{text.workflowInputHelp}</small>
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
