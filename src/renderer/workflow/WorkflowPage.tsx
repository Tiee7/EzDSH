import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  addEdge,
  Background,
  ControlButton,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { EmployeeSnapshot } from '../../shared/employees.js'
import { createShortVideoContentWorkflow, SHORT_VIDEO_EMPLOYEE_IDS } from '../../shared/workflow-templates.js'
import {
  cloneWorkflow,
  createDefaultWorkflow,
  isWorkflowValue,
  type AiExecutionMode,
  type ConditionOperator,
  type TransformTemplate,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeRunState,
  type WorkflowNodeRunStatus,
  type WorkflowNodeType,
  type WorkflowOutputMode,
  type WorkflowModelOption,
  type WorkflowModelSelection,
  type WorkflowRunRecord,
  type WorkflowValue,
} from '../../shared/workflow.js'
import './workflow.css'

interface WorkflowPageProps {
  copy: AppCopy
  locale: AppLocale
  developerMode?: boolean
  onWorkspaceModeChange?: (active: boolean) => void
}

type FlowNode = Node<{ label: string; nodeType: WorkflowNodeType; status?: WorkflowNodeRunStatus }>

const NODE_TYPES: WorkflowNodeType[] = ['input', 'ai-task', 'employee', 'skill', 'mcp', 'parallel', 'loop', 'condition', 'approval', 'transform', 'output', 'shell', 'file']

const nodeTypeLabel: Record<WorkflowNodeType, string> = {
  input: 'Input',
  'ai-task': '智能处理',
  employee: '专业员工',
  skill: 'Skill',
  mcp: 'MCP',
  parallel: 'Parallel',
  loop: 'Loop',
  condition: 'Condition',
  approval: 'Approval',
  transform: 'Transform',
  output: 'Output',
  shell: 'Shell',
  file: 'File',
}

function id(prefix: string): string {
  const suffix = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${suffix}`
}

const WORKFLOW_FLOW_NODE_WIDTH = 184
const WORKFLOW_FLOW_NODE_HEIGHT = 64

function flowNodes(workflow: WorkflowDefinition, run?: WorkflowRunRecord, selectedNodeId?: string): FlowNode[] {
  const states = new Map(run?.nodeStates.map((state) => [state.nodeId, state]))
  return workflow.nodes.map((node) => {
    const status = states.get(node.id)?.status
    const statusMark = status === undefined || status === 'pending' ? '' : ` · ${status}`
    return {
      id: node.id,
      type: node.type === 'condition' ? 'condition' : 'workflow',
      position: node.position,
      width: WORKFLOW_FLOW_NODE_WIDTH,
      height: WORKFLOW_FLOW_NODE_HEIGHT,
      selected: node.id === selectedNodeId,
      data: { label: `${node.label}${statusMark}`, nodeType: node.type, status },
      className: status === undefined ? undefined : `workflow-flow-node-${status}`,
    }
  })
}

export function workflowMiniMapNodeColor(status: WorkflowNodeRunStatus | undefined): string {
  switch (status) {
    case 'completed': return '#1f8a5c'
    case 'running': return '#b06e14'
    case 'failed': return '#c2453a'
    case 'cancelled': return '#c2453a'
    case 'skipped': return '#9ca3af'
    default: return '#9ca3af'
  }
}

function workflowMiniMapNodeColorFromNode(node: Node): string {
  return workflowMiniMapNodeColor((node.data as { status?: WorkflowNodeRunStatus }).status)
}

export interface WorkflowNodeRunDetail {
  node: WorkflowNode
  state: WorkflowNodeRunState
  events: WorkflowRunRecord['events']
}

/** Join a selected canvas node to the output, error, and events persisted for this run. */
export function getWorkflowNodeRunDetail(workflow: WorkflowDefinition, run: WorkflowRunRecord, nodeId: string | undefined): WorkflowNodeRunDetail | undefined {
  if (nodeId === undefined) return undefined
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
  const state = run.nodeStates.find((candidate) => candidate.nodeId === nodeId)
  if (node === undefined || state === undefined) return undefined
  return { node, state, events: run.events.filter((event) => event.nodeId === nodeId) }
}

export function workflowNodeHandleLayout(nodeType: WorkflowNodeType): { input?: 'left'; output?: 'right' } {
  return {
    ...(nodeType === 'input' ? {} : { input: 'left' as const }),
    ...(nodeType === 'output' ? {} : { output: 'right' as const }),
  }
}

function WorkflowFlowNode({ data, selected }: NodeProps<FlowNode>): JSX.Element {
  const handles = workflowNodeHandleLayout(data.nodeType)
  return <div className={`workflow-flow-node ${selected ? 'workflow-flow-node-selected' : ''}`}>
    {handles.input === 'left' ? <Handle type="target" position={Position.Left} /> : null}
    <span>{data.label}</span>
    {handles.output === 'right' ? <Handle type="source" position={Position.Right} /> : null}
  </div>
}

function ConditionFlowNode({ data, selected }: NodeProps<FlowNode>): JSX.Element {
  return <div className={`workflow-condition-node ${selected ? 'workflow-condition-node-selected' : ''}`}><Handle type="target" position={Position.Left} id="input" /><span>{data.label}</span><div className="workflow-condition-ports"><span><Handle type="source" position={Position.Right} id="true" />true</span><span><Handle type="source" position={Position.Right} id="false" />false</span></div></div>
}

const nodeTypes = { workflow: WorkflowFlowNode, condition: ConditionFlowNode }

interface WorkflowCanvasToolsProps {
  copy: AppCopy
  showMiniMap: boolean
  onToggleMiniMap: () => void
}

/** Shared, deterministic canvas chrome for editing and execution views. */
export function WorkflowCanvasTools({ copy, showMiniMap, onToggleMiniMap }: WorkflowCanvasToolsProps): JSX.Element {
  return <>
    <Controls>
      <ControlButton
        className="workflow-minimap-control-button"
        title={showMiniMap ? copy.workflowHideMap : copy.workflowShowMap}
        aria-label={showMiniMap ? copy.workflowHideMap : copy.workflowShowMap}
        aria-pressed={showMiniMap}
        onClick={onToggleMiniMap}
      >
        <span className="workflow-minimap-control-glyph" aria-hidden="true">{showMiniMap ? '▧' : '▦'}</span>
      </ControlButton>
    </Controls>
    {showMiniMap ? <MiniMap nodeColor={workflowMiniMapNodeColorFromNode} nodeStrokeColor="var(--ezdsh-panel-border-strong)" maskColor="color-mix(in srgb, var(--ezdsh-code-background) 76%, transparent)" /> : null}
  </>
}

function flowEdges(workflow: WorkflowDefinition): Edge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort,
    targetHandle: edge.targetPort,
    label: edge.sourcePort === undefined || edge.sourcePort === 'default' ? undefined : edge.sourcePort,
  }))
}

function toWorkflowNodes(nodes: FlowNode[], source: WorkflowNode[]): WorkflowNode[] {
  const sourceMap = new Map(source.map((node) => [node.id, node]))
  return nodes.flatMap((node) => {
    const original = sourceMap.get(node.id)
    return original === undefined ? [] : [{ ...original, position: { x: node.position.x, y: node.position.y } }]
  })
}

function toWorkflowEdges(edges: Edge[]): WorkflowDefinition['edges'] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourcePort: edge.sourceHandle === 'true' || edge.sourceHandle === 'false' || edge.sourceHandle === 'default' ? edge.sourceHandle : undefined,
    targetPort: edge.targetHandle ?? undefined,
  }))
}

export function mergeFlowStateIntoWorkflow(workflow: WorkflowDefinition, nodes: FlowNode[], edges: Edge[]): WorkflowDefinition {
  return {
    ...workflow,
    nodes: toWorkflowNodes(nodes, workflow.nodes),
    edges: toWorkflowEdges(edges),
  }
}

export function removeWorkflowNode(workflow: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.id !== nodeId),
    edges: workflow.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  }
}

export function isWorkflowFormElement(element: Pick<HTMLElement, 'tagName' | 'isContentEditable'>): boolean {
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName.toUpperCase()) || element.isContentEditable
}

function newNode(type: WorkflowNodeType, index: number): WorkflowNode {
  const base = { id: id(type), type, label: nodeTypeLabel[type], position: { x: 120 + (index % 3) * 300, y: 110 + Math.floor(index / 3) * 180 } }
  switch (type) {
    case 'input': return { ...base, type, config: { name: 'task' } }
    case 'ai-task': return { ...base, type, config: { instruction: '请完成上游输入交代的任务，并输出清晰结果。', mode: 'single', skillIds: [], outputMode: 'text' } }
    case 'employee': return { ...base, type, config: { employeeId: '', instruction: '请在岗位业务边界内完成上游任务。', outputMode: 'text' } }
    case 'skill': return { ...base, type, config: { skillId: '', instruction: '请使用这个 Skill 完成任务。' } }
    case 'mcp': return { ...base, type, config: { tool: '', arguments: {} } }
    case 'parallel': return { ...base, type, config: { instructions: ['处理输入的第一方面。', '处理输入的第二方面。'] } }
    case 'loop': return { ...base, type, config: { instruction: '逐项处理输入，并为每项给出结果。', maxIterations: 20 } }
    case 'condition': return { ...base, type, config: { operator: 'truthy' } }
    case 'approval': return { ...base, type, config: { message: '请确认是否继续执行后续步骤。' } }
    case 'transform': return { ...base, type, config: { template: 'identity' } }
    case 'output': return { ...base, type, config: {} }
    case 'shell': return { ...base, type, config: { command: 'echo', args: ['{{value}}'] } }
    case 'file': return { ...base, type, config: { operation: 'read', path: 'README.md' } }
  }
}

function formatValue(value: WorkflowValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export interface WorkflowLaunchField {
  id: string
  key: string
  label: string
  defaultValue?: WorkflowValue
}

function workflowModelOptionKey(option: WorkflowModelSelection): string {
  return `${option.providerId}\u0000${option.modelId}`
}

/** Derive the launch form from the actual Input nodes instead of a generic run textarea. */
export function getWorkflowLaunchFields(workflow: WorkflowDefinition): WorkflowLaunchField[] {
  const usedKeys = new Set<string>()
  return workflow.nodes.flatMap((node) => {
    if (node.type !== 'input') return []
    const configuredKey = node.config.name?.trim()
    const key = configuredKey === undefined || configuredKey === '' || usedKeys.has(configuredKey) ? node.id : configuredKey
    usedKeys.add(key)
    return [{
      id: node.id,
      key,
      label: node.label.trim() || key,
      ...(node.config.defaultValue === undefined ? {} : { defaultValue: node.config.defaultValue }),
    }]
  })
}

/** Keep the launch payload JSON-safe while using the configured Input-node names as keys. */
export function buildWorkflowLaunchInput(fields: WorkflowLaunchField[], values: Record<string, string>): Record<string, WorkflowValue> {
  return Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? formatValue(field.defaultValue)])) as Record<string, WorkflowValue>
}

function createWorkflowLaunchValues(fields: WorkflowLaunchField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.key, formatValue(field.defaultValue)]))
}

function McpArgumentsField({
  copy,
  value,
  onCommit,
}: {
  copy: AppCopy
  value: Record<string, WorkflowValue> | undefined
  onCommit: (value: Record<string, WorkflowValue>) => void
}): JSX.Element {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [error, setError] = useState('')
  useEffect(() => { setDraft(JSON.stringify(value ?? {}, null, 2)); setError('') }, [value])
  const commit = (): void => {
    try {
      const parsed = JSON.parse(draft) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !isWorkflowValue(parsed)) throw new Error('MCP 参数必须是 JSON 对象。')
      onCommit(parsed as Record<string, WorkflowValue>)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'MCP 参数必须是 JSON 对象。')
    }
  }
  return <label>{copy.workflowMcpArguments}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} spellCheck={false} /><small>{error === '' ? copy.workflowMcpArgumentsHint : error}</small></label>
}

export function userFacingWorkflowText(value: string, locale: AppLocale): string {
  if (locale === 'zh') return value.replace(/\bDSH\s+Agent\b/giu, '智能处理').replace(/\bAgent\b/giu, '智能处理')
  return value.replace(/\bDSH\s+Agent\b/giu, 'AI Processing').replace(/\bAgent\b/giu, 'AI Processing')
}

interface WorkflowToastProps {
  message: string
  copy: AppCopy
  onDismiss: () => void
}

export function WorkflowToast({ message, copy, onDismiss }: WorkflowToastProps): JSX.Element {
  return <div className="workflow-toast" role="status"><span>{message}</span><button type="button" aria-label={copy.workflowDismiss} onClick={onDismiss}>×</button></div>
}

interface WorkflowRunLaunchDialogProps {
  copy: AppCopy
  fields: WorkflowLaunchField[]
  values: Record<string, string>
  modelOptions: WorkflowModelOption[]
  modelSelection: WorkflowModelSelection | undefined
  allowShellFile: boolean
  debug: boolean
  busy: boolean
  onChangeValue: (key: string, value: string) => void
  onChangeModel: (value: WorkflowModelSelection | undefined) => void
  onChangeAllowShellFile: (value: boolean) => void
  onChangeDebug: (value: boolean) => void
  onClose: () => void
  onStart: () => void
}

export function WorkflowRunLaunchDialog({
  copy,
  fields,
  values,
  modelOptions,
  modelSelection,
  allowShellFile,
  debug,
  busy,
  onChangeValue,
  onChangeModel,
  onChangeAllowShellFile,
  onChangeDebug,
  onClose,
  onStart,
}: WorkflowRunLaunchDialogProps): JSX.Element {
  return <div className="workflow-launch-dialog-backdrop">
    <section className="workflow-launch-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-run-setup-title">
      <div className="workflow-launch-dialog-header">
        <div><span className="workflow-kicker">{copy.workflowRun}</span><h2 id="workflow-run-setup-title">{copy.workflowRunSetup}</h2><p>{copy.workflowRunSetupHint}</p></div>
        <button type="button" className="workflow-button-quiet" onClick={onClose} disabled={busy}>{copy.workflowCancelSetup}</button>
      </div>
      <div className="workflow-launch-fields">
        {fields.length === 0 ? <p className="workflow-muted">{copy.workflowNoLaunchInputs}</p> : fields.map((field) => <label key={field.id} className="workflow-launch-field"><span>{field.label}</span><textarea aria-label={field.label} value={values[field.key] ?? ''} onChange={(event) => onChangeValue(field.key, event.target.value)} placeholder={field.defaultValue === undefined ? copy.workflowInputHint : undefined} /></label>)}
        <label className="workflow-launch-field"><span>{copy.workflowModel}</span><select value={modelSelection === undefined ? '' : workflowModelOptionKey(modelSelection)} onChange={(event) => onChangeModel(modelOptions.find((option) => workflowModelOptionKey(option) === event.target.value))}><option value="">{copy.workflowUseDefaultModel}</option>{modelOptions.map((option) => <option key={workflowModelOptionKey(option)} value={workflowModelOptionKey(option)}>{option.providerName} · {option.modelName ?? option.modelId}</option>)}</select><small>{copy.workflowModelHint}</small></label>
        <label className="workflow-checkbox"><input type="checkbox" checked={allowShellFile} onChange={(event) => onChangeAllowShellFile(event.target.checked)} /> <span>{copy.workflowAllowShellFile}<small>{copy.workflowAllowShellFileHint}</small></span></label>
        <label className="workflow-checkbox"><input type="checkbox" checked={debug} onChange={(event) => onChangeDebug(event.target.checked)} /> <span>{copy.workflowDebugRun}<small>{copy.workflowDebugRunHint}</small></span></label>
      </div>
      <div className="workflow-launch-dialog-actions"><button type="button" className="workflow-button-quiet" onClick={onClose} disabled={busy}>{copy.workflowCancelSetup}</button><button type="button" className="workflow-button-primary" onClick={onStart} disabled={busy}>{busy ? copy.workflowRunning : copy.workflowStartRun}</button></div>
    </section>
  </div>
}

interface WorkflowExecutionReviewProps {
  copy: AppCopy
  run: WorkflowRunRecord | undefined
  nodeDetail?: WorkflowNodeRunDetail
  statusLabel: (status: WorkflowRunRecord['status']) => string
  onCancel: () => void
  onApprove: () => void
  onReject: () => void
  onResume: () => void
}

/** Read-only run-history inspector. All launch configuration stays in WorkflowRunLaunchDialog. */
export function WorkflowExecutionReview({ copy, run, nodeDetail, statusLabel, onCancel, onApprove, onReject, onResume }: WorkflowExecutionReviewProps): JSX.Element {
  return <section className="workflow-execution-detail">
    <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowExecutions}</span><h2>{run ? statusLabel(run.status) : copy.workflowChooseRun}</h2>{run ? <p className="workflow-run-meta">{run.id} · {run.startedAt ?? copy.workflowNodePending}</p> : null}</div>{run ? <span className={`workflow-status-pill workflow-status-${run.status}`}>{statusLabel(run.status)}</span> : null}</div>
    {run === undefined ? <p className="workflow-muted">{copy.workflowChooseRun}</p> : <>
      <div className="workflow-execution-actions">
        {run.status === 'running' || run.status === 'queued' || run.status === 'waiting-approval' ? <button type="button" className="workflow-danger-button" onClick={onCancel}>{copy.workflowCancel}</button> : null}
        {run.status === 'waiting-approval' ? <><button type="button" onClick={onApprove}>{copy.workflowApprove}</button><button type="button" className="workflow-danger-button" onClick={onReject}>{copy.workflowReject}</button></> : null}
        {run.status === 'paused' || run.status === 'failed' ? <button type="button" onClick={onResume}>{copy.workflowResume}</button> : null}
      </div>
      {run.output !== undefined ? <div className="workflow-output"><strong>{copy.workflowOutput}</strong><pre>{formatValue(run.output)}</pre></div> : null}
      {run.error !== undefined ? <div className="workflow-error">{run.error}</div> : null}
      {nodeDetail === undefined ? <p className="workflow-node-result-hint">{copy.workflowNodeResultHint}</p> : <section className="workflow-node-result">
        <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowNodeResult}</span><strong>{nodeDetail.node.label}</strong></div><span className={`workflow-status-pill workflow-status-${nodeDetail.state.status}`}>{nodeStatusLabel(nodeDetail.state.status, copy)}</span></div>
        <div className="workflow-node-result-meta">{nodeDetail.state.startedAt ? <span>{copy.workflowNodeStartedAt}: {nodeDetail.state.startedAt}</span> : null}{nodeDetail.state.completedAt ? <span>{copy.workflowNodeCompletedAt}: {nodeDetail.state.completedAt}</span> : null}</div>
        {nodeDetail.state.output === undefined ? <p className="workflow-muted">{copy.workflowNodeNoOutput}</p> : <div className="workflow-output"><strong>{copy.workflowOutput}</strong><pre>{formatValue(nodeDetail.state.output)}</pre></div>}
        {nodeDetail.state.error !== undefined ? <div className="workflow-error">{nodeDetail.state.error}</div> : null}
        {nodeDetail.events.length > 0 ? <div className="workflow-node-events"><strong>{copy.workflowNodeEvents}</strong>{nodeDetail.events.map((event) => <p key={event.id}><time>{event.time}</time><span>{event.message ?? event.type}</span></p>)}</div> : null}
      </section>}
    </>}
  </section>
}

function nodeStatusLabel(status: WorkflowNodeRunStatus, copy: AppCopy): string {
  return ({ pending: copy.workflowNodePending, running: copy.workflowNodeRunning, completed: copy.workflowNodeCompleted, skipped: copy.workflowNodeSkipped, failed: copy.workflowNodeFailed, cancelled: copy.workflowNodeCancelled })[status]
}

type WorkflowWorkspaceView = 'editor' | 'executions'

interface WorkflowRunSetup {
  workflowId: string
  fields: WorkflowLaunchField[]
  values: Record<string, string>
  modelOptions: WorkflowModelOption[]
  modelSelection?: WorkflowModelSelection
  allowShellFile: boolean
  debug: boolean
}

export function WorkflowPage({ copy, locale, developerMode: _developerMode = false, onWorkspaceModeChange }: WorkflowPageProps): JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [employees, setEmployees] = useState<EmployeeSnapshot[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [selected, setSelected] = useState<WorkflowDefinition>()
  const [draft, setDraft] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<WorkflowWorkspaceView>('editor')
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [currentRun, setCurrentRun] = useState<WorkflowRunRecord>()
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string>()
  const [showMiniMap, setShowMiniMap] = useState(true)
  const [runSetup, setRunSetup] = useState<WorkflowRunSetup>()
  const [generationPrompt, setGenerationPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (message === '') return
    const timeout = window.setTimeout(() => setMessage(''), 3_000)
    return () => window.clearTimeout(timeout)
  }, [message])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const list = await window.EzDSH.workflows.list()
      setWorkflows(list)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }, [copy.workflowLoadFailed])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => () => onWorkspaceModeChange?.(false), [onWorkspaceModeChange])

  const refreshEmployees = useCallback(async (): Promise<void> => {
    try {
      const items = await window.EzDSH.employees.list()
      setEmployees(items)
      setEmployeeId((current) => current !== '' && items.some((employee) => employee.id === current) ? current : items[0]?.id ?? '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.employeesFailed)
    }
  }, [copy.employeesFailed])

  useEffect(() => { void refreshEmployees() }, [refreshEmployees])

  useEffect(() => {
    const unsubscribe = window.EzDSH.workflows.onStateChange((record) => {
      setRuns((current) => {
        const next = [record, ...current.filter((item) => item.id !== record.id)]
        return next.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      })
      if (currentRun?.id === record.id) setCurrentRun(record)
    })
    return unsubscribe
  }, [currentRun?.id])

  const selectedNode = useMemo(() => selected?.nodes.find((node) => node.id === selectedNodeId), [selected, selectedNodeId])
  const currentRunNodeDetail = useMemo(
    () => selected === undefined || currentRun === undefined ? undefined : getWorkflowNodeRunDetail(selected, currentRun, selectedRunNodeId),
    [currentRun, selected, selectedRunNodeId],
  )

  const currentDefinition = (): WorkflowDefinition | undefined => selected === undefined
    ? undefined
    : mergeFlowStateIntoWorkflow(selected, nodes, edges)

  const applyDefinition = (next: WorkflowDefinition): void => {
    setSelected(next)
    setNodes(flowNodes(next, currentRun))
    setEdges(flowEdges(next))
  }

  const open = async (workflow: WorkflowDefinition): Promise<void> => {
    const userFacingWorkflow = { ...cloneWorkflow(workflow), description: userFacingWorkflowText(workflow.description, locale) }
    setSelected(userFacingWorkflow)
    setDraft(false)
    setWorkspaceView('editor')
    onWorkspaceModeChange?.(true)
    setSelectedNodeId(undefined)
    setNodes(flowNodes(userFacingWorkflow))
    setEdges(flowEdges(userFacingWorkflow))
    setCurrentRun(undefined)
    setSelectedRunNodeId(undefined)
    try { setRuns(await window.EzDSH.workflows.listRuns(workflow.id)) } catch { setRuns([]) }
  }

  const exitWorkspace = (): void => {
    setSelected(undefined)
    setDraft(false)
    setWorkspaceView('editor')
    setSelectedNodeId(undefined)
    setCurrentRun(undefined)
    setSelectedRunNodeId(undefined)
    setRunSetup(undefined)
    setRuns([])
    setNodes([])
    setEdges([])
    onWorkspaceModeChange?.(false)
  }

  const save = async (): Promise<WorkflowDefinition | undefined> => {
    const next = currentDefinition()
    if (next === undefined) return undefined
    setBusy(true)
    setError('')
    try {
      const saved = draft ? await window.EzDSH.workflows.create(next) : await window.EzDSH.workflows.update(next.id, next)
      setSelected(saved)
      setDraft(false)
      setWorkflows((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      setNodes(flowNodes(saved, currentRun))
      setEdges(flowEdges(saved))
      setMessage(copy.workflowSaved)
      return saved
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const workflow = await window.EzDSH.workflows.create(createDefaultWorkflow(copy.workflowNew))
      setWorkflows((current) => [workflow, ...current])
      await open(workflow)
      setMessage(copy.workflowSaved)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally { setBusy(false) }
  }

  const duplicate = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    try {
      const workflow = await window.EzDSH.workflows.duplicate(selected.id)
      setWorkflows((current) => [workflow, ...current])
      await open(workflow)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed) } finally { setBusy(false) }
  }

  const remove = async (): Promise<void> => {
    if (selected === undefined || !window.confirm(copy.workflowDeleteConfirm(selected.name))) return
    setBusy(true)
    try {
      await window.EzDSH.workflows.remove(selected.id)
      const remaining = workflows.filter((item) => item.id !== selected.id)
      setWorkflows(remaining)
      setSelected(undefined)
      setNodes([])
      setEdges([])
      setRuns([])
      setCurrentRun(undefined)
      setSelectedRunNodeId(undefined)
      setRunSetup(undefined)
      onWorkspaceModeChange?.(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed) } finally { setBusy(false) }
  }

  const addNode = (type: WorkflowNodeType): void => {
    const current = currentDefinition()
    if (current === undefined) return
    const node = newNode(type, current.nodes.length)
    const next = { ...current, nodes: [...current.nodes, node] }
    applyDefinition(next)
    setSelectedNodeId(node.id)
  }

  const updateNode = (update: (node: WorkflowNode) => WorkflowNode): void => {
    const current = currentDefinition()
    if (current === undefined || selectedNodeId === undefined) return
    const next = { ...current, nodes: current.nodes.map((node) => node.id === selectedNodeId ? update(cloneWorkflow(node)) : node) }
    applyDefinition(next)
  }

  const deleteSelectedNode = (): void => {
    const current = currentDefinition()
    if (current === undefined || selectedNodeId === undefined) return
    applyDefinition(removeWorkflowNode(current, selectedNodeId))
    setSelectedNodeId(undefined)
  }

  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const target = event.target
    if (target instanceof HTMLElement && isWorkflowFormElement(target)) return
    if (selectedNodeId === undefined) return
    event.preventDefault()
    deleteSelectedNode()
  }

  const onConnect = useCallback((connection: Connection): void => {
    setEdges((current) => addEdge({ ...connection, id: id('edge') }, current))
  }, [setEdges])

  const openRunSetup = async (): Promise<void> => {
    if (selected === undefined) return
    const saved = await save()
    if (saved === undefined) return
    let modelOptions: WorkflowModelOption[] = []
    try { modelOptions = await window.EzDSH.providers.listWorkflowModels() } catch { /* The default model remains available if the optional catalog cannot load. */ }
    const fields = getWorkflowLaunchFields(saved)
    setRunSetup({ workflowId: saved.id, fields, values: createWorkflowLaunchValues(fields), modelOptions, modelSelection: undefined, allowShellFile: false, debug: false })
  }

  const startRun = async (): Promise<void> => {
    if (runSetup === undefined) return
    setBusy(true)
    setError('')
    try {
      const record = await window.EzDSH.workflows.start(runSetup.workflowId, buildWorkflowLaunchInput(runSetup.fields, runSetup.values), { allowShellFile: runSetup.allowShellFile, debug: runSetup.debug, ...(runSetup.modelSelection === undefined ? {} : { model: runSetup.modelSelection }) })
      setCurrentRun(record)
      setSelectedRunNodeId(undefined)
      setRuns((current) => [record, ...current.filter((item) => item.id !== record.id)])
      setWorkspaceView('executions')
      setRunSetup(undefined)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowRunFailed) } finally { setBusy(false) }
  }

  const applyRunRecord = (record: WorkflowRunRecord): void => {
    setCurrentRun(record)
    setRuns((current) => [record, ...current.filter((item) => item.id !== record.id)])
  }

  const cancel = async (): Promise<void> => {
    if (currentRun === undefined) return
    try { applyRunRecord(await window.EzDSH.workflows.cancel(currentRun.id)) } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowRunFailed) }
  }

  const resume = async (): Promise<void> => {
    if (currentRun === undefined) return
    try { applyRunRecord(await window.EzDSH.workflows.resume(currentRun.id)) } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowRunFailed) }
  }

  const approve = async (approved: boolean): Promise<void> => {
    if (currentRun === undefined) return
    try { applyRunRecord(await window.EzDSH.workflows.approve(currentRun.id, approved)) } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowRunFailed) }
  }

  const generate = async (): Promise<void> => {
    if (generationPrompt.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const generated = await window.EzDSH.workflows.generate({ prompt: generationPrompt, name: generationPrompt.slice(0, 48) })
      setSelected(generated)
      setDraft(true)
      setWorkspaceView('editor')
      onWorkspaceModeChange?.(true)
      setNodes(flowNodes(generated))
      setEdges(flowEdges(generated))
      setSelectedNodeId(undefined)
      setMessage(copy.workflowGenerated)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed) } finally { setBusy(false) }
  }

  const importEmployee = async (): Promise<void> => {
    const normalizedEmployeeId = employeeId.trim()
    if (normalizedEmployeeId === '') return
    setBusy(true)
    try {
      const imported = await window.EzDSH.workflows.importEmployee(normalizedEmployeeId)
      setWorkflows((current) => [imported, ...current])
      await open(imported)
      setMessage(copy.workflowImportedEmployee)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed) } finally { setBusy(false) }
  }

  const createContentTemplate = async (): Promise<void> => {
    const missing = Object.values(SHORT_VIDEO_EMPLOYEE_IDS).filter(
      (requiredId) => !employees.some((employee) => employee.id === requiredId && employee.enabled),
    )
    if (missing.length > 0) {
      setError(copy.workflowTemplateMissingEmployees(missing.join(', ')))
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = await window.EzDSH.workflows.create(createShortVideoContentWorkflow())
      setWorkflows((current) => [created, ...current.filter((workflow) => workflow.id !== created.id)])
      await open(created)
      setMessage(copy.workflowContentTemplateCreated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = (status: WorkflowRunRecord['status']): string => ({ queued: copy.workflowNodePending, running: copy.workflowRunning, paused: copy.workflowRunPaused, 'waiting-approval': copy.workflowWaitingApproval, completed: copy.workflowRunCompleted, failed: copy.workflowRunFailed, cancelled: copy.workflowRunCancelled })[status]

  return (
    <div className={`workflow-page ${selected === undefined ? 'workflow-page-browser' : 'workflow-page-workspace'}`}>
      {selected === undefined ? <>
        <header className="workflow-browser-header">
          <div>
            <p className="workflow-eyebrow">EZDSH / AUTOMATION</p>
            <h1>{copy.workflowTitle}</h1>
            <p>{copy.workflowHint}</p>
          </div>
          <div className="workflow-browser-actions">
            <button type="button" className="workflow-button-primary" onClick={() => void create()} disabled={busy}>{copy.workflowNew}</button>
            <button type="button" className="workflow-template-button" onClick={() => void createContentTemplate()} disabled={busy}>{copy.workflowContentTemplate}</button>
          </div>
        </header>
        <main className="workflow-browser-content">
          <div className="workflow-browser-heading">
            <div><span className="workflow-kicker">{copy.workflowWorkspace}</span><h2>{copy.workflowChoose}</h2></div>
            <button type="button" className="workflow-button-quiet" onClick={() => void refresh()} disabled={busy}>{copy.workflowRefresh}</button>
          </div>
          {workflows.length === 0 && !busy ? <div className="workflow-empty-card"><h3>{copy.workflowEmpty}</h3><button type="button" className="workflow-button-primary" onClick={() => void create()}>{copy.workflowNew}</button></div> : null}
          {workflows.length > 0 ? <div className="workflow-browser-grid">{workflows.map((workflow) => <button key={workflow.id} type="button" className="workflow-file-card" onClick={() => void open(workflow)}><span className="workflow-file-card-mark">WF</span><span className="workflow-file-card-content"><strong>{workflow.name}</strong><span>{workflow.description ? userFacingWorkflowText(workflow.description, locale) : copy.workflowHint}</span><small>v{workflow.revision} · {workflow.nodes.length} nodes</small></span><span className="workflow-file-card-open">打开</span></button>)}</div> : null}
          <div className="workflow-browser-tools">
            <section className="workflow-tool-card workflow-generate-card">
              <div><span className="workflow-kicker">{copy.workflowGenerate}</span><h3>{copy.workflowGenerate}</h3><p>{copy.workflowGenerateHint}</p></div>
              <textarea value={generationPrompt} onChange={(event) => setGenerationPrompt(event.target.value)} placeholder={copy.workflowGeneratePlaceholder} />
              <button type="button" className="workflow-button-primary" onClick={() => void generate()} disabled={busy || generationPrompt.trim() === ''}>{busy ? copy.workflowGenerating : copy.workflowGenerate}</button>
            </section>
            <section className="workflow-tool-card">
              <div><span className="workflow-kicker">{copy.workflowImportEmployee}</span><h3>{copy.workflowImportEmployee}</h3><p>把一个专业员工快速转换为可编辑的工作流。</p></div>
              <div className="workflow-import-row"><select id="workflow-employee-select" className="workflow-employee-select" aria-label={copy.workflowImportEmployee} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} disabled={busy || employees.length === 0}><option value="">{copy.workflowSelectEmployee}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.id}</option>)}</select><button type="button" onClick={() => void importEmployee()} disabled={busy || employeeId === ''}>{copy.workflowImportEmployee}</button></div>
            </section>
          </div>
        </main>
      </> : <>
        <header className="workflow-workspace-header">
          <div className="workflow-workspace-identity">
            <button type="button" className="workflow-back-button" onClick={exitWorkspace}>{copy.workflowBack}</button>
            <div><strong>{selected.name}</strong><span>v{selected.revision} · {copy.workflowWorkspace}</span></div>
          </div>
          <div className="workflow-view-switch" role="tablist" aria-label={copy.workflowWorkspace}>
            <button type="button" role="tab" aria-selected={workspaceView === 'editor'} className={workspaceView === 'editor' ? 'workflow-view-active' : ''} onClick={() => setWorkspaceView('editor')}>{copy.workflowEditor}</button>
            <button type="button" role="tab" aria-selected={workspaceView === 'executions'} className={workspaceView === 'executions' ? 'workflow-view-active' : ''} onClick={() => setWorkspaceView('executions')}>{copy.workflowExecutions}</button>
          </div>
          <div className="workflow-workspace-actions">
            <button type="button" className="workflow-button-quiet" onClick={() => void duplicate()} disabled={busy}>{copy.workflowDuplicate}</button>
            <button type="button" className="workflow-button-quiet workflow-danger-button" onClick={() => void remove()} disabled={busy}>{copy.workflowDelete}</button>
            <button type="button" className="workflow-button-quiet" onClick={() => void save()} disabled={busy}>{copy.workflowSave}</button>
            <button type="button" className="workflow-button-primary" onClick={() => void openRunSetup()} disabled={busy || currentRun?.status === 'running'}>{currentRun?.status === 'running' ? copy.workflowRunning : copy.workflowRun}</button>
          </div>
        </header>
        <div className="workflow-workspace-body">
          {workspaceView === 'editor' ? <>
            <section className="workflow-editor-panel">
              <div className="workflow-editor-toolbar">
                <div className="workflow-editor-fields"><input aria-label={copy.workflowName} value={selected.name} onChange={(event) => { const current = currentDefinition(); if (current !== undefined) applyDefinition({ ...current, name: event.target.value }) }} /><input aria-label={copy.workflowDescription} className="workflow-description-input" value={selected.description} onChange={(event) => { const current = currentDefinition(); if (current !== undefined) applyDefinition({ ...current, description: event.target.value }) }} /></div>
                <div className="workflow-node-buttons">{NODE_TYPES.map((type) => <button key={type} type="button" onClick={() => addNode(type)}>{nodeTypeLabel[type]}</button>)}</div>
              </div>
              <div className="workflow-canvas" onKeyDown={onCanvasKeyDown}>
                <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_event, node) => setSelectedNodeId(node.id)} fitView>
                  <Background gap={20} size={1} />
                  <WorkflowCanvasTools copy={copy} showMiniMap={showMiniMap} onToggleMiniMap={() => setShowMiniMap((current) => !current)} />
                </ReactFlow>
              </div>
            </section>
            <aside className="workflow-inspector">
              <section className="workflow-panel-card workflow-inspector-card">
                <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowEditor}</span><h2>{copy.workflowInspector}</h2></div>{selectedNode ? <span className="workflow-type-badge">{nodeTypeLabel[selectedNode.type]}</span> : null}</div>
                {selectedNode === undefined ? <p className="workflow-muted">{copy.workflowNodeSelectHint}</p> : <>
                  <label>{copy.workflowNodeLabel}<input value={selectedNode.label} onChange={(event) => updateNode((node) => ({ ...node, label: event.target.value }))} /></label>
                  {selectedNode.type === 'input' ? <label>{copy.workflowName}<input value={selectedNode.config.name ?? ''} onChange={(event) => updateNode((node) => node.type === 'input' ? { ...node, config: { ...node.config, name: event.target.value } } : node)} /></label> : null}
                  {selectedNode.type === 'ai-task' ? <>
                    <label>{copy.workflowInstruction}<textarea value={selectedNode.config.instruction} onChange={(event) => updateNode((node) => node.type === 'ai-task' ? { ...node, config: { ...node.config, instruction: event.target.value } } : node)} /></label>
                    <label>{copy.workflowSystemPrompt}<textarea value={selectedNode.config.systemPrompt ?? ''} onChange={(event) => updateNode((node) => node.type === 'ai-task' ? { ...node, config: { ...node.config, systemPrompt: event.target.value } } : node)} /></label>
                    <label>{copy.workflowAiMode}<select value={selectedNode.config.mode} onChange={(event) => updateNode((node) => node.type === 'ai-task' ? { ...node, config: { ...node.config, mode: event.target.value as AiExecutionMode } } : node)}><option value="single">{copy.workflowAiModeSingle}</option><option value="autonomous">{copy.workflowAiModeAutonomous}</option></select></label>
                    <label>{copy.workflowSkillIds}<textarea value={selectedNode.config.skillIds.join('\n')} onChange={(event) => updateNode((node) => node.type === 'ai-task' ? { ...node, config: { ...node.config, skillIds: event.target.value.split('\n').map((value) => value.trim()).filter(Boolean) } } : node)} /></label>
                    <OutputModeField copy={copy} value={selectedNode.config.outputMode} onChange={(outputMode) => updateNode((node) => node.type === 'ai-task' ? { ...node, config: { ...node.config, outputMode } } : node)} />
                  </> : null}
                  {selectedNode.type === 'employee' ? <>
                    <label>{copy.workflowSelectEmployee}<select value={selectedNode.config.employeeId} onChange={(event) => updateNode((node) => node.type === 'employee' ? { ...node, config: { ...node.config, employeeId: event.target.value } } : node)}><option value="">{copy.workflowSelectEmployee}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.role}</option>)}</select></label>
                    <EmployeeProfileContext copy={copy} employee={employees.find((employee) => employee.id === selectedNode.config.employeeId)} />
                    <label>{copy.workflowInstruction}<textarea value={selectedNode.config.instruction} onChange={(event) => updateNode((node) => node.type === 'employee' ? { ...node, config: { ...node.config, instruction: event.target.value } } : node)} /></label>
                    <OutputModeField copy={copy} value={selectedNode.config.outputMode} onChange={(outputMode) => updateNode((node) => node.type === 'employee' ? { ...node, config: { ...node.config, outputMode } } : node)} />
                  </> : null}
                  {selectedNode.type === 'skill' ? <><label>{copy.workflowSkillId}<input value={selectedNode.config.skillId} onChange={(event) => updateNode((node) => node.type === 'skill' ? { ...node, config: { ...node.config, skillId: event.target.value } } : node)} /></label><label>{copy.workflowInstruction}<textarea value={selectedNode.config.instruction} onChange={(event) => updateNode((node) => node.type === 'skill' ? { ...node, config: { ...node.config, instruction: event.target.value } } : node)} /></label></> : null}
                  {selectedNode.type === 'mcp' ? <><label>{copy.workflowMcpTool}<input value={selectedNode.config.tool} placeholder="server::tool" onChange={(event) => updateNode((node) => node.type === 'mcp' ? { ...node, config: { ...node.config, tool: event.target.value } } : node)} /></label><McpArgumentsField key={selectedNode.id} copy={copy} value={selectedNode.config.arguments} onCommit={(argumentsValue) => updateNode((node) => node.type === 'mcp' ? { ...node, config: { ...node.config, arguments: argumentsValue } } : node)} /></> : null}
                  {selectedNode.type === 'parallel' ? <label>{copy.workflowInstruction}<textarea value={selectedNode.config.instructions.join('\n')} onChange={(event) => updateNode((node) => node.type === 'parallel' ? { ...node, config: { ...node.config, instructions: event.target.value.split('\n').filter(Boolean) } } : node)} /></label> : null}
                  {selectedNode.type === 'loop' ? <><label>{copy.workflowInstruction}<textarea value={selectedNode.config.instruction} onChange={(event) => updateNode((node) => node.type === 'loop' ? { ...node, config: { ...node.config, instruction: event.target.value } } : node)} /></label><label>{copy.workflowMaxIterations}<input type="number" min="1" max="100" value={selectedNode.config.maxIterations ?? 20} onChange={(event) => updateNode((node) => node.type === 'loop' ? { ...node, config: { ...node.config, maxIterations: Number(event.target.value) } } : node)} /></label></> : null}
                  {selectedNode.type === 'condition' ? <><label>{copy.workflowConditionOperator}<select value={selectedNode.config.operator} onChange={(event) => updateNode((node) => node.type === 'condition' ? { ...node, config: { ...node.config, operator: event.target.value as ConditionOperator } } : node)}>{(['truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'] as ConditionOperator[]).map((operator) => <option key={operator} value={operator}>{operator}</option>)}</select></label><label>{copy.workflowConditionValue}<input value={formatValue(selectedNode.config.value)} onChange={(event) => updateNode((node) => node.type === 'condition' ? { ...node, config: { ...node.config, value: event.target.value } } : node)} /></label></> : null}
                  {selectedNode.type === 'approval' ? <label>Approval message<textarea value={selectedNode.config.message} onChange={(event) => updateNode((node) => node.type === 'approval' ? { ...node, config: { ...node.config, message: event.target.value } } : node)} /></label> : null}
                  {selectedNode.type === 'transform' ? <><label>{copy.workflowTransformTemplate}<select value={selectedNode.config.template} onChange={(event) => updateNode((node) => node.type === 'transform' ? { ...node, config: { ...node.config, template: event.target.value as TransformTemplate } } : node)}>{(['identity', 'json', 'extract-text', 'prepend', 'append'] as TransformTemplate[]).map((template) => <option key={template} value={template}>{template}</option>)}</select></label><label>{copy.workflowTransformText}<input value={selectedNode.config.text ?? ''} onChange={(event) => updateNode((node) => node.type === 'transform' ? { ...node, config: { ...node.config, text: event.target.value } } : node)} /></label></> : null}
                  {selectedNode.type === 'shell' ? <><label>{copy.workflowShellCommand}<input value={selectedNode.config.command} onChange={(event) => updateNode((node) => node.type === 'shell' ? { ...node, config: { ...node.config, command: event.target.value } } : node)} /></label><label>{copy.workflowShellArgs}<textarea value={selectedNode.config.args.join('\n')} onChange={(event) => updateNode((node) => node.type === 'shell' ? { ...node, config: { ...node.config, args: event.target.value.split('\n').filter(Boolean) } } : node)} /></label></> : null}
                  {selectedNode.type === 'file' ? <><label>{copy.workflowFileOperation}<select value={selectedNode.config.operation} onChange={(event) => updateNode((node) => node.type === 'file' ? { ...node, config: { ...node.config, operation: event.target.value as 'read' | 'write' } } : node)}><option value="read">read</option><option value="write">write</option></select></label><label>{copy.workflowFilePath}<input value={selectedNode.config.path} onChange={(event) => updateNode((node) => node.type === 'file' ? { ...node, config: { ...node.config, path: event.target.value } } : node)} /></label>{selectedNode.config.operation === 'write' ? <label>{copy.workflowFileContent}<textarea value={selectedNode.config.content ?? ''} onChange={(event) => updateNode((node) => node.type === 'file' ? { ...node, config: { ...node.config, content: event.target.value } } : node)} /></label> : null}</> : null}
                </>}
              </section>
            </aside>
          </> : <section className="workflow-executions">
            <aside className="workflow-run-sidebar">
              <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowExecutions}</span><h2>{copy.workflowRunHistory}</h2></div><span className="workflow-run-count">{runs.length}</span></div>
              {runs.length === 0 ? <p className="workflow-muted">{copy.workflowNoRuns}</p> : <div className="workflow-run-list">{runs.map((runRecord) => <button key={runRecord.id} type="button" className={`workflow-run-item ${currentRun?.id === runRecord.id ? 'workflow-run-item-active' : ''}`} onClick={() => { setCurrentRun(runRecord); setSelectedRunNodeId(undefined) }}><strong>{statusLabel(runRecord.status)}</strong><span>{runRecord.id.slice(-12)} · {runRecord.startedAt ?? 'queued'}</span></button>)}</div>}
            </aside>
            <div className="workflow-execution-main">
              <div className="workflow-execution-canvas"><ReactFlow nodes={flowNodes(selected, currentRun, selectedRunNodeId)} edges={flowEdges(selected)} nodeTypes={nodeTypes} onNodeClick={(_event, node) => setSelectedRunNodeId(node.id)} fitView><Background gap={20} size={1} /><WorkflowCanvasTools copy={copy} showMiniMap={showMiniMap} onToggleMiniMap={() => setShowMiniMap((current) => !current)} /></ReactFlow></div>
              <WorkflowExecutionReview copy={copy} run={currentRun} nodeDetail={currentRunNodeDetail} statusLabel={statusLabel} onCancel={() => void cancel()} onApprove={() => void approve(true)} onReject={() => void approve(false)} onResume={() => void resume()} />
            </div>
          </section>}
        </div>
      </>}
      {runSetup ? <WorkflowRunLaunchDialog copy={copy} fields={runSetup.fields} values={runSetup.values} modelOptions={runSetup.modelOptions} modelSelection={runSetup.modelSelection} allowShellFile={runSetup.allowShellFile} debug={runSetup.debug} busy={busy} onChangeValue={(key, value) => setRunSetup((current) => current === undefined ? current : { ...current, values: { ...current.values, [key]: value } })} onChangeModel={(modelSelection) => setRunSetup((current) => current === undefined ? current : { ...current, modelSelection })} onChangeAllowShellFile={(allowShellFile) => setRunSetup((current) => current === undefined ? current : { ...current, allowShellFile })} onChangeDebug={(debug) => setRunSetup((current) => current === undefined ? current : { ...current, debug })} onClose={() => setRunSetup(undefined)} onStart={() => void startRun()} /> : null}
      {message ? <WorkflowToast message={message} copy={copy} onDismiss={() => setMessage('')} /> : null}
      {error ? <div className="workflow-error-banner" role="alert">{error}</div> : null}
    </div>
  )
}

function OutputModeField({ copy, value, onChange }: { copy: AppCopy; value: WorkflowOutputMode; onChange: (value: WorkflowOutputMode) => void }): JSX.Element {
  return <label>{copy.workflowOutputMode}<select value={value} onChange={(event) => onChange(event.target.value as WorkflowOutputMode)}><option value="text">{copy.workflowOutputText}</option><option value="json">{copy.workflowOutputJson}</option></select></label>
}

function EmployeeProfileContext({ copy, employee }: { copy: AppCopy; employee: EmployeeSnapshot | undefined }): JSX.Element | null {
  if (employee === undefined) return null
  return <div className="workflow-employee-context"><strong>{copy.workflowEmployeeProfile} · v{employee.version}</strong><p>{employee.businessBoundary || employee.description}</p></div>
}
