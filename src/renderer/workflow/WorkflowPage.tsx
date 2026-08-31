import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ControlButton,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type SetCenter,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AppCopy, AppLocale } from '../../shared/locale.js'
import type { EmployeeCreateInput, EmployeeSnapshot } from '../../shared/employees.js'
import { layoutWorkflowNodes } from '../../shared/workflow-layout.js'
import {
  cloneWorkflow,
  createWorkflowExportDocument,
  createDefaultWorkflow,
  isWorkflowValue,
  parseWorkflowExportDocument,
  type AiExecutionMode,
  type ConditionOperator,
  type TransformTemplate,
  type WorkflowDefinition,
  type WorkflowExportDocument,
  type WorkflowExportEmployee,
  type WorkflowNode,
  type WorkflowNodeInputBinding,
  type WorkflowNodeOutputVariable,
  type WorkflowNodeRunState,
  type WorkflowNodeRunStatus,
  type WorkflowNodeType,
  type WorkflowOutputMode,
  type WorkflowPosition,
  type WorkflowModelOption,
  type WorkflowModelSelection,
  type WorkflowRunRecord,
  type WorkflowValue,
} from '../../shared/workflow.js'
import './workflow.css'
import { WorkflowSelectionSurface } from './workflow-selection.js'

export { layoutWorkflowNodes } from '../../shared/workflow-layout.js'

interface WorkflowPageProps {
  copy: AppCopy
  locale: AppLocale
  developerMode?: boolean
  onWorkspaceModeChange?: (active: boolean) => void
}

type FlowNode = Node<{ label: string; nodeType: WorkflowNodeType; status?: WorkflowNodeRunStatus; duration?: string; isRunning?: boolean }>

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
  http: 'HTTP 请求',
  code: '代码执行',
}

const NODE_LIBRARY_GROUPS: Array<{ label: string; types: WorkflowNodeType[] }> = [
  { label: '流程控制', types: ['input', 'output', 'parallel', 'loop', 'condition', 'approval', 'transform'] },
  { label: '智能能力', types: ['ai-task', 'employee', 'skill', 'mcp'] },
  { label: '外部与本地工具', types: ['http', 'code', 'shell', 'file'] },
]

const workflowNodeIconPath: Record<WorkflowNodeType, string> = {
  input: 'M4 12h12m-5-5 5 5-5 5M19 5v14',
  'ai-task': 'm12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z',
  employee: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  skill: 'M8 4h8v4h4v8h-4v4H8v-4H4V8h4V4Z',
  mcp: 'M8.5 15.5 5 19l-2-2 3.5-3.5m9-4L19 6l-2-2-3.5 3.5M8 16l8-8',
  parallel: 'M5 5h4l5 7h5M5 19h4l5-7h5M5 12h4',
  loop: 'M20 11a8 8 0 0 0-14.7-4L3 10m0 0V4m0 6h6m-5 3a8 8 0 0 0 14.7 4L21 14m0 0v6m0-6h-6',
  condition: 'm12 3 8 9-8 9-8-9 8-9Z',
  approval: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 3 3 5-6',
  transform: 'm14 4 6 6m-9-3-7 7a2 2 0 0 0 0 3l1 1a2 2 0 0 0 3 0l7-7M5 20h14',
  output: 'M5 12h12m-5-5 5 5-5 5M5 5v14',
  shell: 'm7 8 4 4-4 4m6 0h4M4 4h16v16H4V4Z',
  file: 'M6 3h8l4 4v14H6V3Zm8 0v5h4',
  http: 'M4 5h16v14H4V5Zm0 4h16M8 14h3m2 0h3',
  code: 'm8 8-4 4 4 4m8-8 4 4-4 4m-5-10-2 12',
}

function id(prefix: string): string {
  const suffix = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${suffix}`
}

const WORKFLOW_FLOW_NODE_WIDTH = 184
const WORKFLOW_FLOW_NODE_HEIGHT = 64

export const WORKFLOW_CANVAS_INTERACTION_PROPS = {
  selectionOnDrag: true,
  selectionMode: SelectionMode.Partial,
  panOnDrag: false,
  panActivationKeyCode: 'Space',
} as const

export const WORKFLOW_MINIMAP_INTERACTION_PROPS = {
  pannable: true,
} as const

/** The minimap is a direct navigation surface: a click pans to that map position without changing zoom. */
export function centerWorkflowFromMiniMap(setCenter: SetCenter, position: XYPosition, zoom: number): void {
  void setCenter(position.x, position.y, { duration: 180, zoom })
}

export interface WorkflowHistoryState {
  past: WorkflowDefinition[]
  present: WorkflowDefinition
  future: WorkflowDefinition[]
}

export function createWorkflowHistory(workflow: WorkflowDefinition): WorkflowHistoryState {
  return { past: [], present: cloneWorkflow(workflow), future: [] }
}

export function recordWorkflowHistory(history: WorkflowHistoryState, workflow: WorkflowDefinition): WorkflowHistoryState {
  if (JSON.stringify(history.present) === JSON.stringify(workflow)) return history
  return {
    past: [...history.past, cloneWorkflow(history.present)],
    present: cloneWorkflow(workflow),
    future: [],
  }
}

export function undoWorkflowHistory(history: WorkflowHistoryState): WorkflowHistoryState {
  const previous = history.past.at(-1)
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: cloneWorkflow(previous),
    future: [cloneWorkflow(history.present), ...history.future],
  }
}

export function redoWorkflowHistory(history: WorkflowHistoryState): WorkflowHistoryState {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: [...history.past, cloneWorkflow(history.present)],
    present: cloneWorkflow(next),
    future: history.future.slice(1),
  }
}

export function workflowFlowNodes(workflow: WorkflowDefinition, run?: WorkflowRunRecord, selectedNodeId?: string): FlowNode[] {
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
      data: { label: `${node.label}${statusMark}`, nodeType: node.type, status, isRunning: status === 'running', ...(run === undefined ? {} : { duration: formatWorkflowNodeDuration(states.get(node.id)?.elapsedMs) }) },
      className: status === undefined ? undefined : `workflow-flow-node-${status}`,
    }
  })
}
/** Keep exported files portable and readable when a workflow name contains punctuation or path separators. */
export function workflowExportFileName(name: string): string {
  const safeName = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)
  return `${safeName || 'workflow'}.json`
}

export function serializeWorkflowExport(workflow: WorkflowDefinition, exportedAt?: string, employees?: readonly EmployeeSnapshot[]): string {
  return `${JSON.stringify(createWorkflowExportDocument(workflow, exportedAt, employees), null, 2)}\n`
}

export function workflowEmployeeCreateInput(employee: WorkflowExportEmployee, id?: string): EmployeeCreateInput {
  return {
    ...(id === undefined ? {} : { id }),
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
    builtIn: false,
  }
}

function workflowEmployeeNameKey(name: string): string {
  return name.trim().toLocaleLowerCase()
}

function parseWorkflowImportText(text: string, invalidMessage: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(invalidMessage)
  }
}

export type WorkflowNodeAlignment = 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom' | 'distribute-horizontal' | 'distribute-vertical'

/** Align or evenly distribute selected nodes while preserving the other axis. */
export function alignWorkflowNodes(workflow: WorkflowDefinition, nodeIds: string[], alignment: WorkflowNodeAlignment): WorkflowDefinition {
  const selectedIds = new Set(nodeIds)
  const selectedNodes = workflow.nodes.filter((node) => selectedIds.has(node.id))
  const minimumNodeCount = alignment === 'distribute-horizontal' || alignment === 'distribute-vertical' ? 3 : 2
  if (selectedNodes.length < minimumNodeCount) return workflow

  const minX = Math.min(...selectedNodes.map((node) => node.position.x))
  const minY = Math.min(...selectedNodes.map((node) => node.position.y))
  const maxX = Math.max(...selectedNodes.map((node) => node.position.x + WORKFLOW_FLOW_NODE_WIDTH))
  const maxY = Math.max(...selectedNodes.map((node) => node.position.y + WORKFLOW_FLOW_NODE_HEIGHT))
  const horizontalCenter = (minX + maxX) / 2 - WORKFLOW_FLOW_NODE_WIDTH / 2
  const verticalCenter = (minY + maxY) / 2 - WORKFLOW_FLOW_NODE_HEIGHT / 2
  const distributedX = new Map<string, number>()
  const distributedY = new Map<string, number>()
  if (alignment === 'distribute-horizontal') {
    const ordered = [...selectedNodes].sort((left, right) => left.position.x - right.position.x || left.position.y - right.position.y || left.id.localeCompare(right.id))
    const start = ordered[0]!.position.x
    const end = ordered.at(-1)!.position.x
    const step = (end - start) / (ordered.length - 1)
    ordered.forEach((node, index) => distributedX.set(node.id, start + step * index))
  }
  if (alignment === 'distribute-vertical') {
    const ordered = [...selectedNodes].sort((top, bottom) => top.position.y - bottom.position.y || top.position.x - bottom.position.x || top.id.localeCompare(bottom.id))
    const start = ordered[0]!.position.y
    const end = ordered.at(-1)!.position.y
    const step = (end - start) / (ordered.length - 1)
    ordered.forEach((node, index) => distributedY.set(node.id, start + step * index))
  }

  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (!selectedIds.has(node.id)) return node
      const x = alignment === 'left' ? minX
        : alignment === 'center-horizontal' ? horizontalCenter
          : alignment === 'right' ? maxX - WORKFLOW_FLOW_NODE_WIDTH
            : alignment === 'distribute-horizontal' ? distributedX.get(node.id) ?? node.position.x
            : node.position.x
      const y = alignment === 'top' ? minY
        : alignment === 'center-vertical' ? verticalCenter
          : alignment === 'bottom' ? maxY - WORKFLOW_FLOW_NODE_HEIGHT
            : alignment === 'distribute-vertical' ? distributedY.get(node.id) ?? node.position.y
            : node.position.y
      return { ...node, position: { x, y } }
    }),
  }
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
  upstreamNodes: WorkflowNode[]
}

/** Join a selected canvas node to the output, error, and events persisted for this run. */
export function getWorkflowNodeRunDetail(workflow: WorkflowDefinition, run: WorkflowRunRecord, nodeId: string | undefined): WorkflowNodeRunDetail | undefined {
  if (nodeId === undefined) return undefined
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
  const state = run.nodeStates.find((candidate) => candidate.nodeId === nodeId)
  if (node === undefined || state === undefined) return undefined
  const upstreamIds = workflow.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source)
  const upstreamNodes = upstreamIds.flatMap((upstreamId) => {
    const upstream = workflow.nodes.find((candidate) => candidate.id === upstreamId)
    return upstream === undefined ? [] : [upstream]
  })
  return { node, state, events: run.events.filter((event) => event.nodeId === nodeId), upstreamNodes }
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
    <div className="workflow-flow-node-content"><WorkflowNodeTypeIcon type={data.nodeType} /><span>{data.label}</span></div>
    {data.isRunning ? <span className="workflow-node-running-indicator" role="status"><i aria-hidden="true" />执行中</span> : null}
    {data.duration !== undefined ? <small className="workflow-flow-node-duration">{data.duration}</small> : null}
    {handles.output === 'right' ? <Handle type="source" position={Position.Right} /> : null}
  </div>
}

function ConditionFlowNode({ data, selected }: NodeProps<FlowNode>): JSX.Element {
  return <div className={`workflow-condition-node ${selected ? 'workflow-condition-node-selected' : ''}`}><Handle type="target" position={Position.Left} id="input" /><div className="workflow-condition-node-content"><WorkflowNodeTypeIcon type={data.nodeType} /><span>{data.label}</span></div>{data.isRunning ? <span className="workflow-node-running-indicator" role="status"><i aria-hidden="true" />执行中</span> : null}{data.duration !== undefined ? <small className="workflow-flow-node-duration">{data.duration}</small> : null}<div className="workflow-condition-ports"><span><Handle type="source" position={Position.Right} id="true" />true</span><span><Handle type="source" position={Position.Right} id="false" />false</span></div></div>
}

/** Compact Dify-style node type marker; the visible node label remains the accessible name. */
export function WorkflowNodeTypeIcon({ type }: { type: WorkflowNodeType }): JSX.Element {
  return <span className={`workflow-node-type-icon workflow-node-type-${type}`} data-node-icon={type} aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d={workflowNodeIconPath[type]} /></svg></span>
}

const nodeTypes = { workflow: WorkflowFlowNode, condition: ConditionFlowNode }

interface WorkflowCanvasToolsProps {
  copy: AppCopy
  showMiniMap: boolean
  onToggleMiniMap: () => void
}

/** Shared, deterministic canvas chrome for editing and execution views. */
export function WorkflowCanvasTools({ copy, showMiniMap, onToggleMiniMap }: WorkflowCanvasToolsProps): JSX.Element {
  const { getZoom, setCenter } = useReactFlow()
  const onMiniMapClick = useCallback((_event: ReactMouseEvent, position: XYPosition): void => {
    centerWorkflowFromMiniMap(setCenter, position, getZoom())
  }, [getZoom, setCenter])

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
    {showMiniMap ? <MiniMap {...WORKFLOW_MINIMAP_INTERACTION_PROPS} onClick={onMiniMapClick} nodeColor={workflowMiniMapNodeColorFromNode} nodeStrokeColor="var(--ezdsh-panel-border-strong)" maskColor="color-mix(in srgb, var(--ezdsh-code-background) 76%, transparent)" /> : null}
  </>
}

export function workflowFlowEdges(workflow: WorkflowDefinition): Edge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    // React Flow's ordinary node output uses an unnamed handle. Persisted
    // `default` is the workflow-level name for that handle, not a React Flow
    // handle id.
    ...(edge.sourcePort === undefined || edge.sourcePort === 'default' ? {} : { sourceHandle: edge.sourcePort }),
    ...(edge.targetPort === undefined || edge.targetPort === 'default' ? {} : { targetHandle: edge.targetPort }),
    label: edge.sourcePort === undefined || edge.sourcePort === 'default' ? undefined : edge.sourcePort,
  }))
}

const flowEdges = workflowFlowEdges

/** Render from the persisted graph and only borrow transient selection state. */
export function workflowCanvasEdges(workflow: WorkflowDefinition, transientEdges: ReadonlyArray<Pick<Edge, 'id' | 'selected'>>): Edge[] {
  const selectedById = new Map(transientEdges.map((edge) => [edge.id, edge.selected]))
  return workflowFlowEdges(workflow).map((edge) => ({ ...edge, selected: selectedById.get(edge.id) ?? false }))
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

export interface WorkflowSelection {
  nodeId?: string
  nodeIds?: string[]
  edgeId?: string
  edgeIds?: string[]
}

/** Read all selected canvas objects so keyboard deletion can preserve React Flow multi-selection. */
export function workflowSelectionFromFlowState(nodes: ReadonlyArray<Pick<Node, 'id' | 'selected'>>, edges: ReadonlyArray<Pick<Edge, 'id' | 'selected'>>): WorkflowSelection {
  return {
    nodeIds: nodes.filter((node) => node.selected === true).map((node) => node.id),
    edgeIds: edges.filter((edge) => edge.selected === true).map((edge) => edge.id),
  }
}

/** Remove exactly the selected canvas objects; deleting an edge must never delete either endpoint. */
export function removeWorkflowSelection(workflow: WorkflowDefinition, selection: WorkflowSelection): WorkflowDefinition {
  const nodeIds = new Set(selection.nodeIds ?? [])
  const edgeIds = new Set(selection.edgeIds ?? [])
  if (selection.nodeId !== undefined) nodeIds.add(selection.nodeId)
  if (selection.edgeId !== undefined) edgeIds.add(selection.edgeId)
  if (nodeIds.size > 0) {
    return {
      ...workflow,
      nodes: workflow.nodes.filter((node) => !nodeIds.has(node.id)),
      edges: workflow.edges.filter((edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)),
    }
  }
  if (edgeIds.size > 0) return { ...workflow, edges: workflow.edges.filter((edge) => !edgeIds.has(edge.id)) }
  return workflow
}

export function isWorkflowFormElement(element: Pick<HTMLElement, 'tagName' | 'isContentEditable'>): boolean {
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName.toUpperCase()) || element.isContentEditable
}

export type WorkflowKeyboardAction = 'undo' | 'redo' | 'select-all' | 'save' | 'copy' | 'paste'

export function workflowKeyboardAction(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): WorkflowKeyboardAction | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && !event.shiftKey) return 'redo'
  if (key === 'a' && !event.shiftKey) return 'select-all'
  if (key === 's' && !event.shiftKey) return 'save'
  if (key === 'c' && !event.shiftKey) return 'copy'
  if (key === 'v' && !event.shiftKey) return 'paste'
  return undefined
}

export function selectAllWorkflowNodes<T extends Node>(nodes: ReadonlyArray<T>): T[] {
  return nodes.map((node) => ({ ...node, selected: true }))
}

export function preserveWorkflowNodeSelection<T extends Node>(nodes: ReadonlyArray<T>, selectedNodeIds: ReadonlyArray<string>): T[] {
  const selectedIds = new Set(selectedNodeIds)
  return nodes.map((node) => ({ ...node, selected: selectedIds.has(node.id) }))
}

function preserveWorkflowEdgeSelection<T extends Edge>(edges: ReadonlyArray<T>, selectedEdgeIds: ReadonlyArray<string>): T[] {
  const selectedIds = new Set(selectedEdgeIds)
  return edges.map((edge) => ({ ...edge, selected: selectedIds.has(edge.id) }))
}

function newNode(type: WorkflowNodeType, index: number): WorkflowNode {
  const base = { id: id(type), type, label: nodeTypeLabel[type], position: { x: 120 + (index % 3) * 300, y: 110 + Math.floor(index / 3) * 180 }, ...(type === 'input' ? {} : { inputBindings: [], outputVariables: [] }) }
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
    case 'http': return { ...base, type, config: { method: 'GET', url: 'https://api.example.com/data', headers: {}, responseMode: 'auto', timeoutMs: 30_000 } }
    case 'code': return { ...base, type, config: { language: 'nodejs', code: "return { value: input };", timeoutMs: 30_000 } }
  }
}

export interface WorkflowVariableOption {
  sourceNodeId: string
  sourcePath?: string
  label: string
}

/** Values that can be selected as a node-local input. `result` denotes the full output. */
export function getWorkflowVariableOptions(workflow: WorkflowDefinition, targetNodeId: string): WorkflowVariableOption[] {
  return workflow.nodes.flatMap((node) => {
    if (node.id === targetNodeId) return []
    if (node.type === 'input') {
      const name = node.config.name?.trim() || node.label
      return [{ sourceNodeId: node.id, label: `${node.label} · ${name}` }]
    }
    const options: WorkflowVariableOption[] = [{ sourceNodeId: node.id, label: `${node.label} · result` }]
    for (const variable of node.outputVariables ?? []) options.push({ sourceNodeId: node.id, sourcePath: variable.name, label: `${node.label} · ${variable.name}` })
    return options
  })
}

/** Copy only node definitions: connections remain untouched, so a paste is safe to wire independently. */
export function duplicateWorkflowNodes(nodes: ReadonlyArray<WorkflowNode>, createId: (node: WorkflowNode) => string, offset: WorkflowPosition = { x: 48, y: 32 }): WorkflowNode[] {
  return nodes.map((node) => {
    const duplicate = cloneWorkflow(node)
    return {
      ...duplicate,
      id: createId(node),
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
    }
  })
}

function formatValue(value: WorkflowValue | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** Present persisted millisecond timing without inventing time for legacy records. */
export function formatWorkflowNodeDuration(elapsedMs?: number): string {
  const totalMilliseconds = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs ?? 0 : 0)
  const hours = Math.floor(totalMilliseconds / 3_600_000)
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000)
  const seconds = (totalMilliseconds % 60_000) / 1_000
  return `${hours > 0 ? `${hours}时` : ''}${minutes > 0 ? `${minutes}分` : ''}${seconds.toFixed(1)}秒`
}

export type WorkflowOutputView = 'markdown' | 'json'

function parseWorkflowJsonText(value: string): WorkflowValue | undefined {
  const candidates = [value.trim()]
  const fenced = value.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isWorkflowValue(parsed)) return parsed
    } catch {
      // A text response is allowed to be invalid JSON; Markdown is the fallback view.
    }
  }
  return undefined
}

/** Prefer a structured JSON view for object/array payloads, otherwise render text as Markdown. */
export function detectWorkflowOutputView(value: WorkflowValue | undefined): WorkflowOutputView {
  if (typeof value !== 'string') return 'json'
  const parsed = parseWorkflowJsonText(value)
  return parsed !== undefined && typeof parsed === 'object' && parsed !== null ? 'json' : 'markdown'
}

function formatWorkflowJson(value: WorkflowValue): string {
  const parsed = typeof value === 'string' ? parseWorkflowJsonText(value) : value
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2)
}

function workflowJsonKind(value: WorkflowValue): string {
  if (Array.isArray(value)) return `数组 · ${value.length}`
  if (value !== null && typeof value === 'object') return `对象 · ${Object.keys(value).length}`
  if (value === null) return 'null'
  return typeof value
}

function WorkflowJsonTree({ value, label = '结果集', depth = 0 }: { value: WorkflowValue; label?: string; depth?: number }): JSX.Element {
  const isContainer = value !== null && typeof value === 'object'
  if (!isContainer) return <div className="workflow-json-value"><span className="workflow-json-key">{label}</span><code>{JSON.stringify(value)}</code></div>
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)
  return <details className="workflow-json-tree" open={depth < 1}>
    <summary><span className="workflow-json-key">{label}</span><span className="workflow-json-kind">{workflowJsonKind(value)}</span></summary>
    <div className="workflow-json-children">
      {entries.length === 0 ? <span className="workflow-json-empty">{Array.isArray(value) ? '[]' : '{}'}</span> : entries.map(([key, child]) => <WorkflowJsonTree key={`${depth}-${key}`} value={child} label={key} depth={depth + 1} />)}
    </div>
  </details>
}

function renderWorkflowMarkdownInline(value: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/gu
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index))
    if (match[1] !== undefined && match[2] !== undefined) {
      nodes.push(<a key={`link-${match.index}`} href={match[2]} target="_blank" rel="noreferrer">{match[1]}</a>)
    } else if (match[3] !== undefined) {
      nodes.push(<code key={`code-${match.index}`}>{match[3]}</code>)
    } else if (match[4] !== undefined || match[5] !== undefined) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[4] ?? match[5]}</strong>)
    } else if (match[6] !== undefined || match[7] !== undefined) {
      nodes.push(<em key={`em-${match.index}`}>{match[6] ?? match[7]}</em>)
    }
    cursor = pattern.lastIndex
  }
  if (cursor < value.length) nodes.push(value.slice(cursor))
  return nodes
}

function markdownTableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
}

function isMarkdownTableSeparator(line: string, columnCount: number): boolean {
  const cells = markdownTableCells(line)
  return cells.length === columnCount && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
}

function renderWorkflowMarkdownBlocks(markdown: string): JSX.Element[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: JSX.Element[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/u)
    if (fence !== null) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(<pre key={`code-block-${index}`} className="workflow-output-markdown-code"><code className={fence[1] === '' ? undefined : `language-${fence[1]}`}>{codeLines.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u)
    if (heading !== null) {
      const level = heading[1]?.length ?? 1
      const Heading = `h${level}` as keyof JSX.IntrinsicElements
      blocks.push(<Heading key={`heading-${index}`}>{renderWorkflowMarkdownInline(heading[2] ?? '')}</Heading>)
      index += 1
      continue
    }
    const headerCells = markdownTableCells(line)
    if (headerCells.length > 1 && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1] ?? '', headerCells.length)) {
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const cells = markdownTableCells(lines[index] ?? '')
        if (cells.length !== headerCells.length || !(lines[index] ?? '').includes('|')) break
        rows.push(cells)
        index += 1
      }
      blocks.push(<div key={`table-${index}`} className="workflow-output-markdown-table-wrap"><table className="workflow-output-markdown-table"><thead><tr>{headerCells.map((cell, cellIndex) => <th key={`header-${cellIndex}`}>{renderWorkflowMarkdownInline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{renderWorkflowMarkdownInline(cell)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    if (/^\s*(?:[-*_]\s*){3,}$/u.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />)
      index += 1
      continue
    }
    const listItem = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/u)
    if (listItem !== null) {
      const ordered = /^\d/u.test(listItem[1] ?? '')
      const items: string[] = []
      while (index < lines.length) {
        const item = (lines[index] ?? '').match(/^\s*([-+*]|\d+[.)])\s+(.+)$/u)
        if (item === null || /^\d/u.test(item[1] ?? '') !== ordered) break
        items.push(item[2] ?? '')
        index += 1
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={`list-${index}`}>{items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{renderWorkflowMarkdownInline(item)}</li>)}</List>)
      continue
    }
    if (/^\s*>/u.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>/u.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''))
        index += 1
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderWorkflowMarkdownInline(quoteLines.join('\n'))}</blockquote>)
      continue
    }
    const paragraphLines: string[] = []
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? ''
      if (paragraphLine.trim() === '' || /^\s*```\s*[\w-]*\s*$/u.test(paragraphLine) || /^\s*(?:#{1,6})\s+/.test(paragraphLine) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(paragraphLine) || /^\s*>/u.test(paragraphLine) || (markdownTableCells(paragraphLine).length > 1 && isMarkdownTableSeparator(lines[index + 1] ?? '', markdownTableCells(paragraphLine).length))) break
      paragraphLines.push(paragraphLine)
      index += 1
    }
    blocks.push(<p key={`paragraph-${index}`}>{renderWorkflowMarkdownInline(paragraphLines.join(' '))}</p>)
  }
  return blocks
}

export interface WorkflowOutputViewerProps {
  copy: AppCopy
  value: WorkflowValue
  label?: string
  onCopy?: () => void | Promise<void>
  onOpenWindow?: () => void
  fontScale?: number
  onIncreaseFont?: () => void
  onDecreaseFont?: () => void
}

/** Readable, safe output rendering with automatic detection and explicit Markdown/JSON overrides. */
export function WorkflowOutputViewer({ copy, value, label, onCopy, onOpenWindow, fontScale = 1, onIncreaseFont, onDecreaseFont }: WorkflowOutputViewerProps): JSX.Element {
  const detectedView = useMemo(() => detectWorkflowOutputView(value), [value])
  const [view, setView] = useState<WorkflowOutputView>(detectedView)
  const [copied, setCopied] = useState(false)
  useEffect(() => setView(detectedView), [detectedView])
  const copyOutput = async (): Promise<void> => {
    try {
      const outputText = formatValue(value)
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(outputText)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = outputText
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.append(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_800)
      await onCopy?.()
    } catch {
      // Clipboard permissions are optional; the output remains available for manual selection.
    }
  }
  const text = formatValue(value)
  return <div className="workflow-output workflow-output-viewer" style={{ '--workflow-output-scale': String(fontScale) } as CSSProperties}>
    <div className="workflow-output-header">
      <strong>{label ?? copy.workflowOutput}</strong>
      <div className="workflow-output-actions">
        <button type="button" className="workflow-output-action-button" onClick={() => void copyOutput()}>{copied ? copy.workflowOutputCopied : copy.workflowCopyOutput}</button>
        {onOpenWindow !== undefined ? <button type="button" className="workflow-output-action-button" onClick={onOpenWindow}>{copy.workflowOpenOutputWindow}</button> : null}
        {onDecreaseFont !== undefined ? <button type="button" className="workflow-output-font-button" aria-label={copy.workflowDecreaseFont} title={copy.workflowDecreaseFont} onClick={onDecreaseFont}>−</button> : null}
        {onIncreaseFont !== undefined ? <button type="button" className="workflow-output-font-button" aria-label={copy.workflowIncreaseFont} title={copy.workflowIncreaseFont} onClick={onIncreaseFont}>+</button> : null}
        <div className="workflow-output-view-switch" role="group" aria-label={copy.workflowOutputViewLabel}>
          <button type="button" className={view === 'markdown' ? 'workflow-output-view-active' : ''} aria-pressed={view === 'markdown'} onClick={() => setView('markdown')}>{copy.workflowOutputMarkdown}</button>
          <button type="button" className={view === 'json' ? 'workflow-output-view-active' : ''} aria-pressed={view === 'json'} onClick={() => setView('json')}>{copy.workflowOutputJson}</button>
        </div>
      </div>
    </div>
    {view === 'json' ? <div className="workflow-output-json"><WorkflowJsonTree value={typeof value === 'string' ? parseWorkflowJsonText(value) ?? value : value} /></div> : <div className="workflow-output-markdown">{renderWorkflowMarkdownBlocks(text)}</div>}
  </div>
}

export interface WorkflowOutputWindowState {
  id: string
  title: string
  value: WorkflowValue
  position?: WorkflowPosition
  zIndex?: number
}

/** New result windows start at the left, and their initial placement never changes after another window closes. */
export function createWorkflowOutputWindowState(id: string, title: string, value: WorkflowValue, index: number): Required<WorkflowOutputWindowState> {
  return { id, title, value, position: { x: 18 + index * 36, y: 96 + index * 24 }, zIndex: index + 1 }
}

/** Focusing changes only stacking order, never the manually chosen window coordinates. */
export function focusWorkflowOutputWindow(windows: ReadonlyArray<WorkflowOutputWindowState>, id: string): WorkflowOutputWindowState[] {
  const zIndex = Math.max(0, ...windows.map((window, index) => window.zIndex ?? index + 1)) + 1
  return windows.map((window) => window.id === id ? { ...window, zIndex } : window)
}

/** Opened result windows always receive a stacking order above every existing window. */
export function openWorkflowOutputWindow(windows: ReadonlyArray<WorkflowOutputWindowState>, id: string, title: string, value: WorkflowValue): WorkflowOutputWindowState[] {
  const existing = windows.find((window) => window.id === id)
  const next = existing === undefined
    ? [...windows, createWorkflowOutputWindowState(id, title, value, windows.length)]
    : windows.map((window) => window.id === id ? { ...window, title, value } : window)
  return focusWorkflowOutputWindow(next, id)
}

function WorkflowOutputFloatingWindow({ copy, item, index, fontScale, onClose, onCopy, onMove, onFocus, onIncreaseFont, onDecreaseFont }: WorkflowOutputFloatingWindowsProps & { item: WorkflowOutputWindowState; index: number }): JSX.Element {
  const defaultPosition = useMemo(() => createWorkflowOutputWindowState(item.id, item.title, item.value, index).position, [index, item.id, item.title, item.value])
  const [fallbackPosition, setFallbackPosition] = useState(defaultPosition)
  const position = item.position ?? fallbackPosition
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number }>()
  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === undefined || drag.pointerId !== event.pointerId) return
      const next = { x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY }
      if (onMove === undefined) setFallbackPosition(next)
      else onMove(item.id, next)
    }
    const end = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end) }
  }, [item.id, onMove])
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    onFocus?.(item.id)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  return <section className="workflow-output-window" onPointerDown={() => onFocus?.(item.id)} style={{ left: position.x, top: position.y, zIndex: item.zIndex ?? index + 1 } as CSSProperties}>
    <div className="workflow-output-window-header workflow-output-window-drag-handle" onPointerDown={startDrag} title={copy.workflowDragOutputWindow}><strong>{item.title}</strong><button type="button" aria-label={copy.workflowCloseOutputWindow} title={copy.workflowCloseOutputWindow} onPointerDown={(event) => event.stopPropagation()} onClick={() => onClose(item.id)}>×</button></div>
    <WorkflowOutputViewer copy={copy} value={item.value} fontScale={fontScale} onCopy={() => onCopy(item.value)} onIncreaseFont={onIncreaseFont} onDecreaseFont={onDecreaseFont} />
  </section>
}

export function clampWorkflowExecutionDetailHeight(height: number, containerHeight: number): number {
  const maximum = Math.max(180, containerHeight - 240)
  return Math.min(Math.max(height, 180), maximum)
}

export interface WorkflowRunSummary {
  count: number
  unviewedCount: number
  firstUnviewedRun?: WorkflowRunRecord
}

export function summarizeWorkflowRuns(runs: WorkflowRunRecord[], viewedRunIds: ReadonlySet<string>): WorkflowRunSummary {
  const unviewed = runs.filter((run) => !viewedRunIds.has(run.id))
  return {
    count: runs.length,
    unviewedCount: unviewed.length,
    ...(unviewed[0] === undefined ? {} : { firstUnviewedRun: unviewed[0] }),
  }
}

const WORKFLOW_VIEWED_RUNS_STORAGE_KEY = 'ezdsh.workflow.viewed-run-ids'

function readViewedWorkflowRunIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(WORKFLOW_VIEWED_RUNS_STORAGE_KEY)
    const parsed = raw === null ? [] : JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

function persistViewedWorkflowRunIds(ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORKFLOW_VIEWED_RUNS_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Viewing remains a valid in-memory action when local storage is unavailable.
  }
}

interface WorkflowOutputFloatingWindowsProps {
  copy: AppCopy
  windows: WorkflowOutputWindowState[]
  fontScale: number
  onClose: (id: string) => void
  onCopy: (value: WorkflowValue) => void | Promise<void>
  onMove?: (id: string, position: WorkflowPosition) => void
  onFocus?: (id: string) => void
  onIncreaseFont: () => void
  onDecreaseFont: () => void
}

export function WorkflowOutputFloatingWindows({ copy, windows, fontScale, onClose, onCopy, onMove, onFocus, onIncreaseFont, onDecreaseFont }: WorkflowOutputFloatingWindowsProps): JSX.Element {
  return <div className="workflow-output-windows" aria-label={copy.workflowOutputWindow}>
    {windows.map((item, index) => <WorkflowOutputFloatingWindow key={item.id} copy={copy} item={item} index={index} fontScale={fontScale} onClose={onClose} onCopy={onCopy} onMove={onMove} onFocus={onFocus} onIncreaseFont={onIncreaseFont} onDecreaseFont={onDecreaseFont} />)}
  </div>
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
  label = copy.workflowMcpArguments,
  hint = copy.workflowMcpArgumentsHint,
}: {
  copy: AppCopy
  value: Record<string, WorkflowValue> | undefined
  onCommit: (value: Record<string, WorkflowValue>) => void
  label?: string
  hint?: string
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
  return <label>{label}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} spellCheck={false} /><small>{error === '' ? hint : error}</small></label>
}

function WorkflowJsonValueField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: WorkflowValue | undefined
  onCommit: (value: WorkflowValue | undefined) => void
}): JSX.Element {
  const [draft, setDraft] = useState(() => value === undefined ? '' : formatValue(value))
  const [error, setError] = useState('')
  useEffect(() => { setDraft(value === undefined ? '' : formatValue(value)); setError('') }, [value])
  const commit = (): void => {
    if (draft.trim() === '') { onCommit(undefined); setError(''); return }
    try {
      const parsed = JSON.parse(draft) as unknown
      if (!isWorkflowValue(parsed)) throw new Error('值必须是 JSON-safe 数据。')
      onCommit(parsed)
      setError('')
    } catch {
      onCommit(draft)
      setError('')
    }
  }
  return <label>{label}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} spellCheck={false} /><small>{error}</small></label>
}

export function userFacingWorkflowText(value: string, locale: AppLocale): string {
  if (locale === 'zh') return value.replace(/\bDSH\s+Agent\b/giu, '智能处理').replace(/\bAgent\b/giu, '智能处理')
  return value.replace(/\bDSH\s+Agent\b/giu, 'AI Processing').replace(/\bAgent\b/giu, 'AI Processing')
}

interface WorkflowToastProps {
  message: string
  copy: AppCopy
  actionLabel?: string
  onAction?: () => void
  onDismiss: () => void
}

export function WorkflowToast({ message, copy, actionLabel, onAction, onDismiss }: WorkflowToastProps): JSX.Element {
  return <div className="workflow-toast" role="status"><span>{message}</span>{actionLabel !== undefined && onAction !== undefined ? <button type="button" className="workflow-toast-action" onClick={onAction}>{actionLabel}</button> : null}<button type="button" aria-label={copy.workflowDismiss} onClick={onDismiss}>×</button></div>
}

export interface WorkflowEditorActionsProps {
  copy: AppCopy
  draft: boolean
  busy: boolean
  runDisabled: boolean
  runLabel: string
  onCancel: () => void
  onSave: () => void
  onExport?: () => void
  onExportFile?: () => void
  onExportClipboard?: () => void
  onRun: () => void
}

export function WorkflowEditorActions({ copy, draft, busy, runDisabled, runLabel, onCancel, onSave, onExport, onExportFile, onExportClipboard, onRun }: WorkflowEditorActionsProps): JSX.Element {
  const exportFile = onExportFile ?? onExport
  const exportClipboard = onExportClipboard ?? onExport
  return <>
    <button type="button" className="workflow-button-quiet" onClick={onCancel} disabled={busy}>{draft ? copy.workflowCancelCreate : copy.workflowCancelEdit}</button>
    <details className="workflow-export-menu">
      <summary className="workflow-button-quiet workflow-export-menu-trigger">{copy.workflowExport}</summary>
      <div className="workflow-export-menu-panel" role="menu">
        <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); exportFile?.() }} disabled={busy || exportFile === undefined}>{copy.workflowExportToFile}</button>
        <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); exportClipboard?.() }} disabled={busy || exportClipboard === undefined}>{copy.workflowExportToClipboard}</button>
      </div>
    </details>
    <button type="button" className="workflow-button-primary workflow-save-button" onClick={onSave} disabled={busy}>{copy.workflowSave}</button>
    <button type="button" className="workflow-button-primary" onClick={onRun} disabled={runDisabled}>{runLabel}</button>
  </>
}

interface WorkflowMetadataDialogProps {
  copy: AppCopy
  name: string
  description: string
  onChangeName: (name: string) => void
  onChangeDescription: (description: string) => void
  onClose: () => void
  onSave: () => void
}

/** Metadata lives behind a focused dialog so the canvas toolbar stays dedicated to graph work. */
export function WorkflowMetadataDialog({ copy, name, description, onChangeName, onChangeDescription, onClose, onSave }: WorkflowMetadataDialogProps): JSX.Element {
  return <div className="workflow-metadata-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="workflow-metadata-dialog" role="dialog" aria-modal="true" aria-label="编辑工作流信息" onMouseDown={(event) => event.stopPropagation()}>
      <div className="workflow-metadata-dialog-header"><div><span className="workflow-kicker">{copy.workflowEditor}</span><h2>编辑工作流信息</h2></div><button type="button" aria-label={copy.workflowDismiss} onClick={onClose}>×</button></div>
      <div className="workflow-metadata-dialog-fields"><label>{copy.workflowName}<input autoFocus value={name} onChange={(event) => onChangeName(event.target.value)} /></label><label>{copy.workflowDescription}<textarea value={description} onChange={(event) => onChangeDescription(event.target.value)} /></label></div>
      <div className="workflow-metadata-dialog-actions"><button type="button" className="workflow-button-quiet" onClick={onClose}>{copy.workflowCancelEdit}</button><button type="button" className="workflow-button-primary workflow-save-button" onClick={onSave}>{copy.workflowSave}</button></div>
    </section>
  </div>
}

function WorkflowNodeLibrary({ onAdd }: { onAdd: (type: WorkflowNodeType) => void }): JSX.Element {
  return <details className="workflow-node-library"><summary>＋ 添加节点</summary><div className="workflow-node-library-menu">{NODE_LIBRARY_GROUPS.map((group) => <section key={group.label}><strong>{group.label}</strong><div>{group.types.map((type) => <button key={type} type="button" onClick={() => onAdd(type)}><WorkflowNodeTypeIcon type={type} /><span>{nodeTypeLabel[type]}</span></button>)}</div></section>)}</div></details>
}

export type WorkflowContextMenuTarget = 'canvas' | 'node' | 'edge' | 'selection'

export interface WorkflowContextMenuProps {
  copy: AppCopy
  target: WorkflowContextMenuTarget
  x: number
  y: number
  canUndo: boolean
  canRedo: boolean
  busy: boolean
  selectedNodeCount?: number
  runDisabled?: boolean
  cancelLabel?: string
  onUndo: () => void
  onRedo: () => void
  onDelete: () => void
  onCopy?: () => void
  onPaste?: () => void
  canPaste?: boolean
  onAlign?: (alignment: WorkflowNodeAlignment) => void
  onFitView: () => void
  onSave: () => void
  onRun: () => void
  onCancel: () => void
}

export function clampWorkflowContextMenuPosition(x: number, y: number, menuWidth: number, menuHeight: number, viewportWidth: number, viewportHeight: number, gutter = 8): { left: number; top: number } {
  const maxLeft = Math.max(gutter, viewportWidth - menuWidth - gutter)
  const maxTop = Math.max(gutter, viewportHeight - menuHeight - gutter)
  return {
    left: Math.min(Math.max(gutter, x), maxLeft),
    top: Math.min(Math.max(gutter, y), maxTop),
  }
}

/** Context actions are deliberately on-demand so the canvas remains uncluttered during normal editing. */
export function WorkflowContextMenu({ copy, target, x, y, canUndo, canRedo, busy, selectedNodeCount = 0, runDisabled = false, cancelLabel, onUndo, onRedo, onDelete, onCopy, onPaste, canPaste = false, onAlign, onFitView, onSave, onRun, onCancel }: WorkflowContextMenuProps): JSX.Element {
  const deleteLabel = target === 'edge' ? copy.workflowDeleteEdge : target === 'selection' ? copy.workflowDeleteSelection : copy.workflowDeleteNode
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState({ left: x, top: y })
  const [menuPositioned, setMenuPositioned] = useState(false)

  useEffect(() => {
    setMenuPositioned(false)
    const updatePosition = (): void => {
      const menu = menuRef.current
      if (menu === null) return
      setMenuPosition(clampWorkflowContextMenuPosition(x, y, menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight))
      setMenuPositioned(true)
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [x, y])

  return <div ref={menuRef} className="workflow-context-menu" role="menu" aria-label={copy.workflowContextMenu} style={{ left: menuPosition.left, top: menuPosition.top, visibility: menuPositioned ? 'visible' : 'hidden' }}>
    <button type="button" role="menuitem" onClick={onUndo} disabled={!canUndo || busy}>{copy.workflowUndo}<kbd>⌘Z</kbd></button>
    <button type="button" role="menuitem" onClick={onRedo} disabled={!canRedo || busy}>{copy.workflowRedo}<kbd>⇧⌘Z</kbd></button>
    {target !== 'canvas' && onCopy !== undefined ? <button type="button" role="menuitem" onClick={onCopy} disabled={busy}>复制节点<kbd>⌘C</kbd></button> : null}
    {onPaste !== undefined ? <button type="button" role="menuitem" onClick={onPaste} disabled={busy || !canPaste}>粘贴节点<kbd>⌘V</kbd></button> : null}
    {target !== 'canvas' ? <button type="button" role="menuitem" className="workflow-context-menu-danger" onClick={onDelete} disabled={busy}>{deleteLabel}<kbd>Delete</kbd></button> : null}
    {selectedNodeCount >= 2 && onAlign !== undefined ? <><div className="workflow-context-menu-divider" role="separator" /><div className="workflow-context-menu-align-label">{copy.workflowAlign}</div><div className="workflow-context-menu-align-grid">
      <button type="button" role="menuitem" onClick={() => onAlign('left')} disabled={busy}>{copy.workflowAlignLeft}</button>
      <button type="button" role="menuitem" onClick={() => onAlign('center-horizontal')} disabled={busy}>{copy.workflowAlignCenterHorizontal}</button>
      <button type="button" role="menuitem" onClick={() => onAlign('right')} disabled={busy}>{copy.workflowAlignRight}</button>
      <button type="button" role="menuitem" onClick={() => onAlign('top')} disabled={busy}>{copy.workflowAlignTop}</button>
      <button type="button" role="menuitem" onClick={() => onAlign('center-vertical')} disabled={busy}>{copy.workflowAlignCenterVertical}</button>
      <button type="button" role="menuitem" onClick={() => onAlign('bottom')} disabled={busy}>{copy.workflowAlignBottom}</button>
    </div>{selectedNodeCount >= 3 ? <><div className="workflow-context-menu-divider" role="separator" /><div className="workflow-context-menu-align-label">{copy.workflowDistribute}</div><div className="workflow-context-menu-distribute-grid">
      <button type="button" role="menuitem" onClick={() => onAlign('distribute-horizontal')} disabled={busy}>{copy.workflowDistributeHorizontal}</button>
      <button type="button" role="menuitem" onClick={() => onAlign('distribute-vertical')} disabled={busy}>{copy.workflowDistributeVertical}</button>
    </div></> : null}</> : null}
    <div className="workflow-context-menu-divider" role="separator" />
    <button type="button" role="menuitem" onClick={onFitView} disabled={busy}>{copy.workflowFitView}</button>
    <button type="button" role="menuitem" onClick={onSave} disabled={busy}>{copy.workflowSave}<kbd>⌘S</kbd></button>
    <button type="button" role="menuitem" onClick={onRun} disabled={busy || runDisabled}>{copy.workflowRun}</button>
    <button type="button" role="menuitem" onClick={onCancel} disabled={busy}>{cancelLabel ?? copy.workflowCancelEdit}</button>
  </div>
}

function WorkflowFitViewBridge({ onReady }: { onReady: (fitView: (() => Promise<boolean>) | undefined) => void }): JSX.Element {
  const { fitView } = useReactFlow()
  useEffect(() => {
    onReady(fitView)
    return () => onReady(undefined)
  }, [fitView, onReady])
  return <></>
}

interface WorkflowRunLaunchDialogProps {
  copy: AppCopy
  fields: WorkflowLaunchField[]
  values: Record<string, string>
  modelOptions: WorkflowModelOption[]
  modelSelection: WorkflowModelSelection | undefined
  allowShellFile: boolean
  allowCode: boolean
  debug: boolean
  busy: boolean
  modelLoading: boolean
  onChangeValue: (key: string, value: string) => void
  onChangeModel: (value: WorkflowModelSelection | undefined) => void
  onRefreshModels: () => void
  onChangeAllowShellFile: (value: boolean) => void
  onChangeAllowCode: (value: boolean) => void
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
  allowCode,
  debug,
  busy,
  modelLoading,
  onChangeValue,
  onChangeModel,
  onRefreshModels,
  onChangeAllowShellFile,
  onChangeAllowCode,
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
        <label className="workflow-launch-field"><span>{copy.workflowModel}</span><div className="workflow-model-control"><select value={modelSelection === undefined ? '' : workflowModelOptionKey(modelSelection)} onChange={(event) => onChangeModel(modelOptions.find((option) => workflowModelOptionKey(option) === event.target.value))}><option value="">{copy.workflowUseDefaultModel}</option>{modelOptions.map((option) => <option key={workflowModelOptionKey(option)} value={workflowModelOptionKey(option)}>{option.providerName} · {option.modelName ?? option.modelId}</option>)}</select><button type="button" className="workflow-button-quiet workflow-model-refresh" onClick={onRefreshModels} disabled={busy || modelLoading}>{modelLoading ? copy.workflowRefreshingModels : copy.workflowRefreshModels}</button></div><small className="workflow-launch-note">{modelOptions.length === 0 ? copy.workflowNoModels : copy.workflowModelHint}</small></label>
        <label className="workflow-checkbox"><input type="checkbox" checked={allowShellFile} onChange={(event) => onChangeAllowShellFile(event.target.checked)} /> <span>{copy.workflowAllowShellFile}<small className="workflow-launch-note">{copy.workflowAllowShellFileHint}</small></span></label>
        <label className="workflow-checkbox"><input type="checkbox" checked={allowCode} onChange={(event) => onChangeAllowCode(event.target.checked)} /> <span>{copy.workflowAllowCode}<small className="workflow-launch-note">{copy.workflowAllowCodeHint}</small></span></label>
        <label className="workflow-checkbox"><input type="checkbox" checked={debug} onChange={(event) => onChangeDebug(event.target.checked)} /> <span>{copy.workflowDebugRun}<small className="workflow-launch-note">{copy.workflowDebugRunHint}</small></span></label>
      </div>
      <div className="workflow-launch-dialog-actions"><button type="button" className="workflow-button-quiet" onClick={onClose} disabled={busy}>{copy.workflowCancelSetup}</button><button type="button" className="workflow-button-primary" onClick={onStart} disabled={busy}>{busy ? copy.workflowRunning : copy.workflowStartRun}</button></div>
    </section>
  </div>
}

interface WorkflowExecutionReviewProps {
  copy: AppCopy
  run: WorkflowRunRecord | undefined
  nodeDetail?: WorkflowNodeRunDetail
  selectedNode?: WorkflowNode
  statusLabel: (status: WorkflowRunRecord['status']) => string
  onCancel: () => void
  onApprove: () => void
  onReject: () => void
  onResume: () => void
  onSelectNode?: (nodeId: string) => void
  onCopyOutput?: (value: WorkflowValue) => void | Promise<void>
  onOpenOutputWindow?: (key: string, title: string, value: WorkflowValue) => void
  outputFontScale?: number
  onIncreaseOutputFont?: () => void
  onDecreaseOutputFont?: () => void
}

function WorkflowInputPreview({ copy, value, derived, upstreamNodes, onSelectNode }: { copy: AppCopy; value: WorkflowValue | undefined; derived: boolean; upstreamNodes: WorkflowNode[]; onSelectNode?: (nodeId: string) => void }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (value === undefined) return <p className="workflow-muted">{copy.workflowNodeNoInput}</p>
  const text = formatValue(value)
  const long = text.split('\n').length > 2 || text.length > 180
  return <div className="workflow-node-input">
    <div className="workflow-node-data-heading"><strong>{copy.workflowNodeInput}</strong><span className="workflow-input-source">{derived ? copy.workflowInputFromUpstream : copy.workflowManualInput}</span></div>
    <pre className={`workflow-node-input-preview ${long && !expanded ? 'workflow-node-input-preview-collapsed' : ''}`}><code>{text}</code></pre>
    {long ? <button type="button" className="workflow-inline-button" onClick={() => setExpanded((current) => !current)}>{expanded ? copy.workflowCollapseInput : copy.workflowExpandInput}</button> : null}
    {derived && onSelectNode !== undefined ? <div className="workflow-upstream-actions">{upstreamNodes.map((upstream) => <button key={upstream.id} type="button" className="workflow-inline-button" onClick={() => onSelectNode(upstream.id)}>{copy.workflowGoUpstream}{upstreamNodes.length > 1 ? `：${upstream.label}` : ''}</button>)}</div> : null}
  </div>
}

/** Read-only run-history inspector. All launch configuration stays in WorkflowRunLaunchDialog. */
export function WorkflowExecutionReview({ copy, run, nodeDetail, selectedNode, statusLabel, onCancel, onApprove, onReject, onResume, onSelectNode, onCopyOutput, onOpenOutputWindow, outputFontScale = 1, onIncreaseOutputFont, onDecreaseOutputFont }: WorkflowExecutionReviewProps): JSX.Element {
  const inspectedNode = nodeDetail?.node ?? selectedNode
  const inspectedState = nodeDetail?.state ?? (selectedNode === undefined ? undefined : { nodeId: selectedNode.id, status: 'pending' as const })
  const inspectedEvents = nodeDetail?.events ?? []
  const outputViewerProps = (key: string, title: string, value: WorkflowValue): WorkflowOutputViewerProps => ({
    copy,
    value,
    label: title,
    onCopy: onCopyOutput === undefined ? undefined : () => onCopyOutput(value),
    onOpenWindow: onOpenOutputWindow === undefined ? undefined : () => onOpenOutputWindow(key, title, value),
    fontScale: outputFontScale,
    onIncreaseFont: onIncreaseOutputFont,
    onDecreaseFont: onDecreaseOutputFont,
  })
  return <section className="workflow-execution-detail">
    <div className="workflow-execution-compact-heading">{run ? <><span className={`workflow-status-pill workflow-status-${run.status}`}>{statusLabel(run.status)}</span><span className="workflow-run-id">{run.id}</span></> : <span className="workflow-muted">{copy.workflowChooseRun}</span>}</div>
    {run === undefined ? <p className="workflow-muted">{copy.workflowChooseRun}</p> : <>
      <div className="workflow-execution-actions">
        {run.status === 'running' || run.status === 'queued' || run.status === 'waiting-approval' ? <button type="button" className="workflow-danger-button" onClick={onCancel}>{copy.workflowCancel}</button> : null}
        {run.status === 'waiting-approval' ? <><button type="button" onClick={onApprove}>{copy.workflowApprove}</button><button type="button" className="workflow-danger-button" onClick={onReject}>{copy.workflowReject}</button></> : null}
        {run.status === 'paused' || run.status === 'failed' ? <button type="button" onClick={onResume}>{copy.workflowResume}</button> : null}
      </div>
      {inspectedNode === undefined || inspectedState === undefined ? <>
        <WorkflowOutputViewer {...outputViewerProps('input', copy.workflowInput, run.input)} />
        {run.output !== undefined ? <WorkflowOutputViewer {...outputViewerProps('final', copy.workflowOutput, run.output)} /> : null}
        {run.error !== undefined ? <div className="workflow-error">{run.error}</div> : null}
        <p className="workflow-node-result-hint">{copy.workflowNodeResultHint}</p>
      </> : <section className="workflow-node-result">
        <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowNodeResult}</span><strong>{inspectedNode.label}</strong></div><span className={`workflow-status-pill workflow-status-${inspectedState.status}`}>{nodeStatusLabel(inspectedState.status, copy)}</span></div>
        <div className="workflow-node-result-meta">{inspectedState.startedAt ? <span>{copy.workflowNodeStartedAt}: {inspectedState.startedAt}</span> : null}{inspectedState.completedAt ? <span>{copy.workflowNodeCompletedAt}: {inspectedState.completedAt}</span> : null}</div>
        <WorkflowInputPreview copy={copy} value={inspectedState.input ?? (inspectedNode.type === 'input' ? run.input : undefined)} derived={(nodeDetail?.upstreamNodes.length ?? 0) > 0} upstreamNodes={nodeDetail?.upstreamNodes ?? []} onSelectNode={onSelectNode} />
        {inspectedState.output === undefined ? <p className="workflow-muted">{copy.workflowNodeNoOutput}</p> : <WorkflowOutputViewer {...outputViewerProps(inspectedNode.id, `${inspectedNode.label} · ${copy.workflowNodeOutput}`, inspectedState.output)} />}
        {inspectedState.error !== undefined ? <div className="workflow-error">{inspectedState.error}</div> : null}
        {inspectedEvents.length > 0 ? <div className="workflow-node-events"><strong>{copy.workflowNodeEvents}</strong>{inspectedEvents.map((event) => <p key={event.id}><time>{event.time}</time><span>{event.message ?? event.type}</span></p>)}</div> : null}
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
  allowCode: boolean
  debug: boolean
  modelLoading: boolean
}

interface WorkflowContextMenuState {
  x: number
  y: number
  target: WorkflowContextMenuTarget
  nodeId?: string
  edgeId?: string
}

interface WorkflowMetadataDraft {
  name: string
  description: string
}

export function WorkflowPage({ copy, locale, developerMode: _developerMode = false, onWorkspaceModeChange }: WorkflowPageProps): JSX.Element {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [employees, setEmployees] = useState<EmployeeSnapshot[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [selected, setSelected] = useState<WorkflowDefinition>()
  const [draft, setDraft] = useState(false)
  const [history, setHistory] = useState<WorkflowHistoryState>()
  const [workspaceView, setWorkspaceView] = useState<WorkflowWorkspaceView>('editor')
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>()
  const [nodes, setNodes] = useNodesState<FlowNode>([])
  const [edges, setEdges] = useEdgesState([])
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [workflowRunSummaries, setWorkflowRunSummaries] = useState<Record<string, WorkflowRunSummary>>({})
  const [viewedRunIds, setViewedRunIds] = useState<Set<string>>(() => readViewedWorkflowRunIds())
  const [currentRun, setCurrentRun] = useState<WorkflowRunRecord>()
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string>()
  const [showRunSidebar, setShowRunSidebar] = useState(true)
  const [outputFontScale, setOutputFontScale] = useState(1)
  const [outputWindows, setOutputWindows] = useState<WorkflowOutputWindowState[]>([])
  const [metadataDraft, setMetadataDraft] = useState<WorkflowMetadataDraft>()
  const [executionDetailHeight, setExecutionDetailHeight] = useState(280)
  const [showMiniMap, setShowMiniMap] = useState(true)
  const [runSetup, setRunSetup] = useState<WorkflowRunSetup>()
  const [generationPrompt, setGenerationPrompt] = useState('')
  const [deletedWorkflow, setDeletedWorkflow] = useState<WorkflowDefinition>()
  const [contextMenu, setContextMenu] = useState<WorkflowContextMenuState>()
  const workflowPageRef = useRef<HTMLDivElement>(null)
  const workflowCanvasRef = useRef<HTMLDivElement>(null)
  const workflowImportInputRef = useRef<HTMLInputElement>(null)
  const executionMainRef = useRef<HTMLDivElement>(null)
  const executionResizeRef = useRef<{ startY: number; startHeight: number }>()
  const fitViewRef = useRef<(() => Promise<boolean>)>()
  const copiedWorkflowNodesRef = useRef<WorkflowNode[]>([])
  const workflowPasteCountRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const rememberFitView = useCallback((fitView: (() => Promise<boolean>) | undefined): void => {
    fitViewRef.current = fitView
  }, [])

  useEffect(() => {
    if (contextMenu === undefined) return
    const dismissOutside = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.workflow-context-menu') !== null) return
      setContextMenu(undefined)
    }
    const dismissWithEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(undefined)
    }
    window.addEventListener('mousedown', dismissOutside)
    window.addEventListener('keydown', dismissWithEscape)
    return () => {
      window.removeEventListener('mousedown', dismissOutside)
      window.removeEventListener('keydown', dismissWithEscape)
    }
  }, [contextMenu])

  useEffect(() => {
    if (message === '') return
    const timeout = window.setTimeout(() => setMessage(''), 3_000)
    return () => window.clearTimeout(timeout)
  }, [message])

  useEffect(() => {
    if (message === '') setDeletedWorkflow(undefined)
  }, [message])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const list = await window.EzDSH.workflows.list()
      setWorkflows(list)
      const summaries = await Promise.all(list.map(async (workflow) => {
        try {
          const workflowRuns = await window.EzDSH.workflows.listRuns(workflow.id)
          return [workflow.id, summarizeWorkflowRuns(workflowRuns, viewedRunIds)] as const
        } catch {
          return [workflow.id, { count: 0, unviewedCount: 0 }] as const
        }
      }))
      setWorkflowRunSummaries(Object.fromEntries(summaries))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }, [copy.workflowLoadFailed, viewedRunIds])

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

  const updateRunSummary = useCallback((workflowId: string, workflowRuns: WorkflowRunRecord[], viewed = viewedRunIds): void => {
    setWorkflowRunSummaries((current) => ({ ...current, [workflowId]: summarizeWorkflowRuns(workflowRuns, viewed) }))
  }, [viewedRunIds])

  const markRunViewed = useCallback((run: WorkflowRunRecord, knownRuns?: WorkflowRunRecord[]): void => {
    setViewedRunIds((current) => {
      if (current.has(run.id)) return current
      const next = new Set(current)
      next.add(run.id)
      persistViewedWorkflowRunIds(next)
      const sourceRuns = knownRuns ?? (selected?.id === run.workflowId ? runs : undefined)
      if (sourceRuns !== undefined) updateRunSummary(run.workflowId, sourceRuns, next)
      return next
    })
  }, [runs, selected?.id, updateRunSummary])

  useEffect(() => {
    const unsubscribe = window.EzDSH.workflows.onStateChange((record) => {
      setRuns((current) => {
        const next = [record, ...current.filter((item) => item.id !== record.id)]
        updateRunSummary(record.workflowId, next)
        return next.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      })
      if (currentRun?.id === record.id) setCurrentRun(record)
    })
    return unsubscribe
  }, [currentRun?.id, updateRunSummary])

  const selectedNode = useMemo(() => selected?.nodes.find((node) => node.id === selectedNodeId), [selected, selectedNodeId])
  const currentRunNodeDetail = useMemo(
    () => selected === undefined || currentRun === undefined ? undefined : getWorkflowNodeRunDetail(selected, currentRun, selectedRunNodeId),
    [currentRun, selected, selectedRunNodeId],
  )

  const currentDefinition = (): WorkflowDefinition | undefined => selected === undefined
    ? undefined
    : mergeFlowStateIntoWorkflow(selected, nodes, edges)

  const applyDefinition = (next: WorkflowDefinition, recordHistory = true): void => {
    const selectedNodeIds = nodes.filter((node) => node.selected === true).map((node) => node.id)
    const selectedEdgeIds = edges.filter((edge) => edge.selected === true).map((edge) => edge.id)
    if (selectedNodeId !== undefined && !selectedNodeIds.includes(selectedNodeId)) selectedNodeIds.push(selectedNodeId)
    if (selectedEdgeId !== undefined && !selectedEdgeIds.includes(selectedEdgeId)) selectedEdgeIds.push(selectedEdgeId)
    if (recordHistory) setHistory((current) => current === undefined ? createWorkflowHistory(next) : recordWorkflowHistory(current, next))
    setSelected(next)
    setNodes(preserveWorkflowNodeSelection(workflowFlowNodes(next, currentRun), selectedNodeIds))
    setEdges(preserveWorkflowEdgeSelection(flowEdges(next), selectedEdgeIds))
    setSelectedNodeId((current) => next.nodes.some((node) => node.id === current) ? current : undefined)
    setSelectedEdgeId((current) => next.edges.some((edge) => edge.id === current) ? current : undefined)
  }

  const open = async (workflow: WorkflowDefinition, isDraft = false): Promise<void> => {
    const userFacingWorkflow = { ...cloneWorkflow(workflow), description: userFacingWorkflowText(workflow.description, locale) }
    setSelected(userFacingWorkflow)
    setHistory(createWorkflowHistory(userFacingWorkflow))
    setDraft(isDraft)
    setWorkspaceView('editor')
    onWorkspaceModeChange?.(true)
    setSelectedNodeId(undefined)
    setSelectedEdgeId(undefined)
    setContextMenu(undefined)
    setNodes(workflowFlowNodes(userFacingWorkflow))
    setEdges(flowEdges(userFacingWorkflow))
    setCurrentRun(undefined)
    setSelectedRunNodeId(undefined)
    if (isDraft) {
      setRuns([])
      return
    }
    try {
      const workflowRuns = await window.EzDSH.workflows.listRuns(workflow.id)
      setRuns(workflowRuns)
      updateRunSummary(workflow.id, workflowRuns)
    } catch {
      setRuns([])
      updateRunSummary(workflow.id, [])
    }
  }

  const exitWorkspace = (): void => {
    setSelected(undefined)
    setDraft(false)
    setHistory(undefined)
    setWorkspaceView('editor')
    setSelectedNodeId(undefined)
    setSelectedEdgeId(undefined)
    setContextMenu(undefined)
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
      setHistory((current) => current === undefined ? createWorkflowHistory(saved) : {
        past: current.past.map((item) => ({ ...cloneWorkflow(item), revision: saved.revision, updatedAt: saved.updatedAt })),
        present: cloneWorkflow(saved),
        future: current.future.map((item) => ({ ...cloneWorkflow(item), revision: saved.revision, updatedAt: saved.updatedAt })),
      })
      setWorkflows((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      const selectedNodeIds = nodes.filter((node) => node.selected === true).map((node) => node.id)
      const selectedEdgeIds = edges.filter((edge) => edge.selected === true).map((edge) => edge.id)
      if (selectedNodeId !== undefined && !selectedNodeIds.includes(selectedNodeId)) selectedNodeIds.push(selectedNodeId)
      if (selectedEdgeId !== undefined && !selectedEdgeIds.includes(selectedEdgeId)) selectedEdgeIds.push(selectedEdgeId)
      setNodes(preserveWorkflowNodeSelection(workflowFlowNodes(saved, currentRun), selectedNodeIds))
      setEdges(preserveWorkflowEdgeSelection(flowEdges(saved), selectedEdgeIds))
      setSelectedNodeId((current) => saved.nodes.some((node) => node.id === current) ? current : undefined)
      setMessage(copy.workflowSaved)
      return saved
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const exportWorkflowToFile = (): void => {
    const workflow = currentDefinition()
    if (workflow === undefined) return
    try {
      const blob = new Blob([serializeWorkflowExport(workflow, undefined, employees)], { type: 'application/json' })
      if (typeof URL.createObjectURL !== 'function') throw new Error('当前环境不支持下载 Workflow JSON。')
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = workflowExportFileName(workflow.name)
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      setMessage(copy.workflowExported)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    }
  }

  const exportWorkflowToClipboard = async (): Promise<void> => {
    const workflow = currentDefinition()
    if (workflow === undefined) return
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error(copy.workflowClipboardExportFailed)
      await navigator.clipboard.writeText(serializeWorkflowExport(workflow, undefined, employees))
      setMessage(copy.workflowExported)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowClipboardExportFailed)
    }
  }

  const importWorkflowDocument = async (document: WorkflowExportDocument): Promise<void> => {
    const employeeNodes = document.workflow.nodes.filter((node): node is Extract<WorkflowNode, { type: 'employee' }> => node.type === 'employee')
    const referencedEmployeeIds = [...new Set(employeeNodes.map((node) => node.config.employeeId.trim()).filter(Boolean))]
    const bundledEmployees = new Map((document.employees ?? []).map((employee) => [employee.id, employee]))
    const employeeIdMap = new Map<string, string>()
    const employeesToCreate: WorkflowExportEmployee[] = []

    for (const employeeId of referencedEmployeeIds) {
      const bundledEmployee = bundledEmployees.get(employeeId)
      const exactEmployee = employees.find((employee) => employee.id === employeeId && employee.enabled)
      const sameNameEmployee = bundledEmployee === undefined
        ? undefined
        : employees.find((employee) => employee.enabled && workflowEmployeeNameKey(employee.name) === workflowEmployeeNameKey(bundledEmployee.name))
      if (sameNameEmployee !== undefined) {
        if (window.confirm(copy.workflowImportEmployeeReuseConfirm(sameNameEmployee.name))) {
          employeeIdMap.set(employeeId, sameNameEmployee.id)
          continue
        }
        if (bundledEmployee === undefined || !window.confirm(copy.workflowImportEmployeeCreateConfirm(bundledEmployee.name))) {
          throw new Error(copy.workflowImportCancelled)
        }
        employeesToCreate.push(bundledEmployee)
        continue
      }
      if (exactEmployee !== undefined) {
        employeeIdMap.set(employeeId, exactEmployee.id)
        continue
      }
      if (bundledEmployee === undefined) throw new Error(copy.workflowImportEmployeeMissing(employeeId))
      if (!window.confirm(copy.workflowImportEmployeeCreateConfirm(bundledEmployee.name))) throw new Error(copy.workflowImportCancelled)
      employeesToCreate.push(bundledEmployee)
    }

    const createdEmployees: EmployeeSnapshot[] = []
    for (const employee of employeesToCreate) {
      const conflictingId = employees.some((candidate) => candidate.id === employee.id)
      const created = await window.EzDSH.employees.create(workflowEmployeeCreateInput(employee, conflictingId ? undefined : employee.id))
      createdEmployees.push(created)
      employeeIdMap.set(employee.id, created.id)
    }
    if (createdEmployees.length > 0) setEmployees((current) => [...createdEmployees, ...current])

    const remappedWorkflow: WorkflowDefinition = {
      ...document.workflow,
      nodes: document.workflow.nodes.map((node) => {
        if (node.type !== 'employee') return node
        const mappedEmployeeId = employeeIdMap.get(node.config.employeeId.trim())
        return mappedEmployeeId === undefined ? node : { ...node, config: { ...node.config, employeeId: mappedEmployeeId } }
      }),
    }
    const imported = await window.EzDSH.workflows.create({
      name: remappedWorkflow.name,
      description: remappedWorkflow.description,
      nodes: remappedWorkflow.nodes,
      edges: remappedWorkflow.edges,
      enabled: remappedWorkflow.enabled,
    })
    setWorkflows((current) => [imported, ...current.filter((workflow) => workflow.id !== imported.id)])
    await open(imported)
    setMessage(copy.workflowImported)
  }

  const importWorkflowFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file === undefined) return
    setBusy(true)
    setError('')
    try {
      await importWorkflowDocument(parseWorkflowExportDocument(parseWorkflowImportText(await file.text(), copy.workflowImportInvalidJson)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }

  const importWorkflowClipboard = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (navigator.clipboard?.readText === undefined) throw new Error(copy.workflowClipboardReadFailed)
      const text = await navigator.clipboard.readText()
      await importWorkflowDocument(parseWorkflowExportDocument(parseWorkflowImportText(text, copy.workflowClipboardInvalid)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      await open(createDefaultWorkflow(copy.workflowNew), true)
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
      const removedWorkflow = workflows.find((item) => item.id === selected.id) ?? selected
      await window.EzDSH.workflows.remove(selected.id)
      const remaining = workflows.filter((item) => item.id !== selected.id)
      setWorkflows(remaining)
      setDeletedWorkflow(cloneWorkflow(removedWorkflow))
      setSelected(undefined)
      setNodes([])
      setEdges([])
      setRuns([])
      setCurrentRun(undefined)
      setSelectedRunNodeId(undefined)
      setRunSetup(undefined)
      onWorkspaceModeChange?.(false)
      setMessage(copy.workflowDeleted)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed) } finally { setBusy(false) }
  }

  const restoreDeletedWorkflow = async (): Promise<void> => {
    const candidate = deletedWorkflow
    if (candidate === undefined) return
    setBusy(true)
    setError('')
    try {
      const restored = await window.EzDSH.workflows.create(candidate)
      setWorkflows((current) => [restored, ...current.filter((item) => item.id !== restored.id)])
      setDeletedWorkflow(undefined)
      setMessage(copy.workflowRestored)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setBusy(false)
    }
  }

  const addNode = (type: WorkflowNodeType): void => {
    const current = currentDefinition()
    if (current === undefined) return
    const node = newNode(type, current.nodes.length)
    const next = { ...current, nodes: [...current.nodes, node] }
    applyDefinition(next)
    setSelectedNodeId(node.id)
  }

  const copySelectedNodes = (): void => {
    const current = currentDefinition()
    if (current === undefined) return
    const selectedIds = new Set(nodes.filter((node) => node.selected === true).map((node) => node.id))
    if (selectedNodeId !== undefined) selectedIds.add(selectedNodeId)
    const copied = current.nodes.filter((node) => selectedIds.has(node.id)).map((node) => cloneWorkflow(node))
    if (copied.length === 0) return
    copiedWorkflowNodesRef.current = copied
    workflowPasteCountRef.current = 0
    setMessage(`已复制 ${copied.length} 个节点`)
  }

  const pasteCopiedNodes = (): void => {
    const current = currentDefinition()
    const copied = copiedWorkflowNodesRef.current
    if (current === undefined || copied.length === 0) return
    workflowPasteCountRef.current += 1
    const offset = { x: 48 * workflowPasteCountRef.current, y: 32 * workflowPasteCountRef.current }
    const pasted = duplicateWorkflowNodes(copied, (node) => id(node.type), offset)
    const next = { ...current, nodes: [...current.nodes, ...pasted] }
    applyDefinition(next)
    setNodes(workflowFlowNodes(next, currentRun).map((node) => ({ ...node, selected: pasted.some((candidate) => candidate.id === node.id) })))
    setSelectedNodeId(pasted.at(-1)?.id)
    setSelectedEdgeId(undefined)
    setMessage(`已粘贴 ${pasted.length} 个节点`)
  }

  const updateNode = (update: (node: WorkflowNode) => WorkflowNode): void => {
    const current = currentDefinition()
    if (current === undefined || selectedNodeId === undefined) return
    const next = { ...current, nodes: current.nodes.map((node) => node.id === selectedNodeId ? update(cloneWorkflow(node)) : node) }
    applyDefinition(next)
  }

  const deleteSelection = (selection?: WorkflowSelection): void => {
    const current = currentDefinition()
    const flowSelection = workflowSelectionFromFlowState(nodes, edges)
    const resolvedSelection: WorkflowSelection = selection ?? {
      nodeIds: [...(flowSelection.nodeIds ?? []), ...(selectedNodeId === undefined ? [] : [selectedNodeId])],
      edgeIds: [...(flowSelection.edgeIds ?? []), ...(selectedEdgeId === undefined ? [] : [selectedEdgeId])],
    }
    if (current === undefined || ((resolvedSelection.nodeIds?.length ?? 0) === 0 && (resolvedSelection.edgeIds?.length ?? 0) === 0)) return
    const next = removeWorkflowSelection(current, resolvedSelection)
    applyDefinition(next)
    setSelectedNodeId(undefined)
    setSelectedEdgeId(undefined)
  }

  const alignSelectedNodes = (alignment: WorkflowNodeAlignment): void => {
    const current = currentDefinition()
    const selectedNodeIds = nodes.filter((node) => node.selected === true).map((node) => node.id)
    if (current === undefined || selectedNodeIds.length < 2) return
    applyDefinition(alignWorkflowNodes(current, selectedNodeIds, alignment))
    setContextMenu(undefined)
    focusWorkflowCanvas()
  }

  const autoLayout = (): void => {
    const current = currentDefinition()
    if (current === undefined) return
    applyDefinition(layoutWorkflowNodes(current))
    setMessage('已按流程依赖自动优化排版。')
    requestAnimationFrame(() => { void fitViewRef.current?.() })
  }

  const undo = (): void => {
    if (history === undefined) return
    const next = undoWorkflowHistory(history)
    if (next === history) return
    setHistory(next)
    applyDefinition(next.present, false)
  }

  const redo = (): void => {
    if (history === undefined) return
    const next = redoWorkflowHistory(history)
    if (next === history) return
    setHistory(next)
    applyDefinition(next.present, false)
  }

  useEffect(() => {
    if (selected === undefined || workspaceView !== 'editor') return
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      const page = workflowPageRef.current
      const pane = page?.closest('.workspace-pane')
      if (pane !== null && pane !== undefined && !pane.classList.contains('workspace-pane-active')) return
      const target = event.target
      if (target instanceof HTMLElement && isWorkflowFormElement(target)) return
      const action = workflowKeyboardAction(event)
      if (action === undefined || action === 'select-all' || action === 'save' || action === 'copy' || action === 'paste') return
      event.preventDefault()
      event.stopPropagation()
      if (action === 'redo') redo()
      else undo()
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [history, selected, workspaceView])

  const focusWorkflowCanvas = (): void => {
    workflowCanvasRef.current?.focus({ preventScroll: true })
  }

  const selectAllNodes = (): void => {
    setNodes((current) => selectAllWorkflowNodes(current))
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })))
    setSelectedNodeId(nodes.at(-1)?.id)
    setSelectedEdgeId(undefined)
  }

  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target
    if (target instanceof HTMLElement && isWorkflowFormElement(target)) return
    const action = workflowKeyboardAction(event)
    if (action !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      if (action === 'redo') redo()
      else if (action === 'undo') undo()
      else if (action === 'select-all') selectAllNodes()
      else if (action === 'copy') copySelectedNodes()
      else if (action === 'paste') pasteCopiedNodes()
      else if (!busy) void save()
      return
    }
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const flowSelection = workflowSelectionFromFlowState(nodes, edges)
    if (selectedNodeId === undefined && selectedEdgeId === undefined && (flowSelection.nodeIds?.length ?? 0) === 0 && (flowSelection.edgeIds?.length ?? 0) === 0) return
    event.preventDefault()
    event.stopPropagation()
    deleteSelection()
  }

  const onNodesChange = (changes: NodeChange<FlowNode>[]): void => {
    const nextNodes = applyNodeChanges(changes, nodes)
    setNodes(nextNodes)
    if (changes.some((change) => change.type === 'select')) {
      const selectedNodeIds = nextNodes.filter((node) => node.selected === true).map((node) => node.id)
      setSelectedNodeId(selectedNodeIds.at(-1))
      if (selectedNodeIds.length > 0) {
        setSelectedEdgeId(undefined)
      }
    }
    const shouldRecord = changes.some((change) => change.type === 'remove' || change.type === 'add' || change.type === 'replace' || (change.type === 'position' && change.dragging !== true))
    if (!shouldRecord || selected === undefined) return
    applyDefinition(mergeFlowStateIntoWorkflow(selected, nextNodes, edges))
  }

  const onWorkflowCanvasSelectionChange = useCallback((selectedNodeIds: string[]): void => {
    const selectedIds = new Set(selectedNodeIds)
    setNodes((current) => current.map((node) => ({ ...node, selected: selectedIds.has(node.id) })))
    setEdges((current) => current.map((edge) => ({ ...edge, selected: selectedIds.has(edge.source) || selectedIds.has(edge.target) })))
    setSelectedNodeId(selectedNodeIds.at(-1))
    setSelectedEdgeId(undefined)
  }, [setEdges, setNodes])

  const onEdgesChange = (changes: EdgeChange[]): void => {
    const nextEdges = applyEdgeChanges(changes, edges)
    setEdges(nextEdges)
    if (changes.some((change) => change.type === 'select')) {
      const selectedEdgeIds = nextEdges.filter((edge) => edge.selected === true).map((edge) => edge.id)
      setSelectedEdgeId(selectedEdgeIds.at(-1))
      if (selectedEdgeIds.length > 0) {
        setSelectedNodeId(undefined)
      }
    }
    const shouldRecord = changes.some((change) => change.type === 'remove' || change.type === 'add' || change.type === 'replace')
    if (!shouldRecord || selected === undefined) return
    applyDefinition(mergeFlowStateIntoWorkflow(selected, nodes, nextEdges))
  }

  const onConnect = useCallback((connection: Connection): void => {
    if (selected === undefined) return
    const nextEdges = addEdge({ ...connection, id: id('edge') }, edges)
    applyDefinition(mergeFlowStateIntoWorkflow(selected, nodes, nextEdges))
  }, [edges, nodes, selected])

  const openRunSetup = async (): Promise<void> => {
    if (selected === undefined) return
    const saved = await save()
    if (saved === undefined) return
    let modelOptions: WorkflowModelOption[] = []
    try { modelOptions = await window.EzDSH.providers.listWorkflowModels() } catch { /* The default model remains available if the optional catalog cannot load. */ }
    const fields = getWorkflowLaunchFields(saved)
    setRunSetup({ workflowId: saved.id, fields, values: createWorkflowLaunchValues(fields), modelOptions, modelSelection: undefined, allowShellFile: false, allowCode: false, debug: false, modelLoading: false })
  }

  const refreshRunModels = async (): Promise<void> => {
    if (runSetup === undefined || runSetup.modelLoading) return
    setRunSetup((current) => current === undefined ? current : { ...current, modelLoading: true })
    try {
      const modelOptions = await window.EzDSH.providers.listWorkflowModels(true)
      setRunSetup((current) => {
        if (current === undefined) return current
        const selectedModel = current.modelSelection
        const modelSelection = selectedModel !== undefined
          && modelOptions.some((option) => workflowModelOptionKey(option) === workflowModelOptionKey(selectedModel))
          ? selectedModel
          : undefined
        return { ...current, modelOptions, modelSelection }
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.workflowLoadFailed)
    } finally {
      setRunSetup((current) => current === undefined ? current : { ...current, modelLoading: false })
    }
  }

  const startRun = async (): Promise<void> => {
    if (runSetup === undefined) return
    setBusy(true)
    setError('')
    try {
      const record = await window.EzDSH.workflows.start(runSetup.workflowId, buildWorkflowLaunchInput(runSetup.fields, runSetup.values), { allowShellFile: runSetup.allowShellFile, allowCode: runSetup.allowCode, debug: runSetup.debug, ...(runSetup.modelSelection === undefined ? {} : { model: runSetup.modelSelection }) })
      setCurrentRun(record)
      setSelectedRunNodeId(undefined)
      setRuns((current) => [record, ...current.filter((item) => item.id !== record.id)])
      updateRunSummary(record.workflowId, [record, ...runs.filter((item) => item.id !== record.id)])
      setWorkspaceView('executions')
      setRunSetup(undefined)
    } catch (reason) { setError(reason instanceof Error ? reason.message : copy.workflowRunFailed) } finally { setBusy(false) }
  }

  const applyRunRecord = (record: WorkflowRunRecord): void => {
    setCurrentRun(record)
    setRuns((current) => [record, ...current.filter((item) => item.id !== record.id)])
    updateRunSummary(record.workflowId, [record, ...runs.filter((item) => item.id !== record.id)])
  }

  const selectRun = (record: WorkflowRunRecord): void => {
    setCurrentRun(record)
    setSelectedRunNodeId(undefined)
    markRunViewed(record)
  }

  const openUnreadRun = (): void => {
    const workflow = selected
    const unread = workflow === undefined ? undefined : workflowRunSummaries[workflow.id]?.firstUnviewedRun
    if (unread === undefined) return
    setCurrentRun(unread)
    setSelectedRunNodeId(undefined)
    setWorkspaceView('executions')
    markRunViewed(unread)
  }

  const openWorkflowUnreadRun = async (workflow: WorkflowDefinition, run: WorkflowRunRecord): Promise<void> => {
    await open(workflow)
    setCurrentRun(run)
    setSelectedRunNodeId(undefined)
    setWorkspaceView('executions')
    markRunViewed(run)
  }

  const openOutputWindow = (key: string, title: string, value: WorkflowValue): void => {
    const windowId = `${currentRun?.id ?? 'run'}:${key}`
    setOutputWindows((current) => openWorkflowOutputWindow(current, windowId, title, value))
  }

  const copyOutput = (): void => setMessage(copy.workflowOutputCopied)

  const saveWorkflowMetadata = (): void => {
    const current = currentDefinition()
    const nextMetadata = metadataDraft
    if (current === undefined || nextMetadata === undefined) return
    applyDefinition({ ...current, name: nextMetadata.name, description: nextMetadata.description })
    setMetadataDraft(undefined)
  }

  const beginExecutionResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const container = executionMainRef.current
    if (container === null) return
    event.preventDefault()
    executionResizeRef.current = { startY: event.clientY, startHeight: executionDetailHeight }
    container.setPointerCapture?.(event.pointerId)
  }

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const start = executionResizeRef.current
      const container = executionMainRef.current
      if (start === undefined || container === null) return
      setExecutionDetailHeight(clampWorkflowExecutionDetailHeight(start.startHeight + start.startY - event.clientY, container.getBoundingClientRect().height))
    }
    const end = (): void => { executionResizeRef.current = undefined }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
  }, [])

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
      await open(generated.workflow, true)
      if (generated.createdEmployees.length > 0) {
        setMessage(copy.workflowGeneratedWithEmployees(generated.createdEmployees.map((employee) => employee.name).join('、')))
        void refreshEmployees()
      } else {
        setMessage(copy.workflowGenerated)
      }
      if ((generated.employeeWarnings?.length ?? 0) > 0) {
        setError(copy.workflowGeneratedEmployeeWarnings(generated.employeeWarnings!.join('；')))
      }
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

  const statusLabel = (status: WorkflowRunRecord['status']): string => ({ queued: copy.workflowNodePending, running: copy.workflowRunning, paused: copy.workflowRunPaused, 'waiting-approval': copy.workflowWaitingApproval, completed: copy.workflowRunCompleted, failed: copy.workflowRunFailed, cancelled: copy.workflowRunCancelled })[status]

  const dismissContextMenu = (): void => setContextMenu(undefined)
  const deleteContextMenuSelection = (): void => {
    const target = contextMenu
    setContextMenu(undefined)
    if (target === undefined) return
    if (target.target === 'selection') {
      deleteSelection()
      focusWorkflowCanvas()
      return
    }
    deleteSelection({ nodeId: target.nodeId, edgeId: target.edgeId })
    focusWorkflowCanvas()
  }
  const runFromContextMenu = (): void => { setContextMenu(undefined); void openRunSetup() }
  const saveFromContextMenu = (): void => { setContextMenu(undefined); focusWorkflowCanvas(); void save() }
  const fitViewFromContextMenu = (): void => { setContextMenu(undefined); focusWorkflowCanvas(); void fitViewRef.current?.() }

  return (
    <div ref={workflowPageRef} className={`workflow-page ${selected === undefined ? 'workflow-page-browser' : 'workflow-page-workspace'}`}>
      {selected === undefined ? <>
        <header className="workflow-browser-header">
          <div>
            <p className="workflow-eyebrow">EZDSH / AUTOMATION</p>
            <h1>{copy.workflowTitle}</h1>
            <p>{copy.workflowHint}</p>
          </div>
          <div className="workflow-browser-actions">
            <button type="button" className="workflow-button-primary" onClick={() => void create()} disabled={busy}>{copy.workflowNew}</button>
            <div className="workflow-import-split" role="group" aria-label={copy.workflowImport}>
              <button type="button" className="workflow-button-primary workflow-import-main" onClick={() => workflowImportInputRef.current?.click()} disabled={busy}>{copy.workflowImport}</button>
              <button type="button" className="workflow-button-quiet workflow-import-clipboard-button" onClick={() => void importWorkflowClipboard()} disabled={busy} aria-label={copy.workflowImportClipboard} title={copy.workflowImportClipboard}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5h6m-5-2h4a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v12H4V8a2 2 0 0 1 2-2h2V5a2 2 0 0 1 2-2Zm-1 9 3 3 5-5" /></svg>
              </button>
            </div>
            <input ref={workflowImportInputRef} className="workflow-file-input" type="file" accept="application/json,.json" aria-label={copy.workflowImport} onChange={(event) => void importWorkflowFile(event)} />
          </div>
        </header>
        <main className="workflow-browser-content">
          <div className="workflow-browser-heading">
            <div><span className="workflow-kicker">{copy.workflowWorkspace}</span><h2>{copy.workflowChoose}</h2></div>
            <button type="button" className="workflow-button-quiet" onClick={() => void refresh()} disabled={busy}>{copy.workflowRefresh}</button>
          </div>
          {workflows.length === 0 && !busy ? <div className="workflow-empty-card"><h3>{copy.workflowEmpty}</h3><button type="button" className="workflow-button-primary" onClick={() => void create()}>{copy.workflowNew}</button></div> : null}
          {workflows.length > 0 ? <div className="workflow-browser-grid">{workflows.map((workflow) => {
            const summary = workflowRunSummaries[workflow.id] ?? { count: 0, unviewedCount: 0 }
            return <article key={workflow.id} className="workflow-file-card">
              <button type="button" className="workflow-file-card-main" onClick={() => void open(workflow)}><span className="workflow-file-card-mark">WF</span><span className="workflow-file-card-content"><strong>{workflow.name}</strong><span>{workflow.description ? userFacingWorkflowText(workflow.description, locale) : copy.workflowHint}</span><small>v{workflow.revision} · {workflow.nodes.length} nodes · {copy.workflowHistoryCount(summary.count)}</small></span><span className="workflow-file-card-open">打开</span></button>
              {summary.firstUnviewedRun !== undefined ? <button type="button" className="workflow-unviewed-run-button" onClick={() => void openWorkflowUnreadRun(workflow, summary.firstUnviewedRun!)}>{copy.workflowUnviewedRuns(summary.unviewedCount)} · {copy.workflowViewUnviewedRun}</button> : null}
            </article>
          })}</div> : null}
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
            <div><div className="workflow-workspace-title-row"><strong>{selected.name}</strong><button type="button" className="workflow-metadata-edit-button" aria-label="编辑工作流信息" title="编辑工作流信息" onClick={() => setMetadataDraft({ name: selected.name, description: selected.description })}>✎</button></div><span>v{selected.revision} · {copy.workflowWorkspace}</span></div>
          </div>
          <div className="workflow-view-switch" role="tablist" aria-label={copy.workflowWorkspace}>
            <button type="button" role="tab" aria-selected={workspaceView === 'editor'} className={workspaceView === 'editor' ? 'workflow-view-active' : ''} onClick={() => setWorkspaceView('editor')}>{copy.workflowEditor}</button>
            <button type="button" role="tab" aria-selected={workspaceView === 'executions'} className={workspaceView === 'executions' ? 'workflow-view-active' : ''} onClick={() => setWorkspaceView('executions')}>{copy.workflowExecutions}</button>
          </div>
          <div className="workflow-workspace-actions">
            {workflowRunSummaries[selected.id]?.firstUnviewedRun !== undefined ? <button type="button" className="workflow-unviewed-run-button workflow-unviewed-run-header" onClick={openUnreadRun}>{copy.workflowUnviewedRuns(workflowRunSummaries[selected.id]?.unviewedCount ?? 0)} · {copy.workflowViewUnviewedRun}</button> : null}
            {!draft ? <>
              <button type="button" className="workflow-button-quiet" onClick={() => void duplicate()} disabled={busy}>{copy.workflowDuplicate}</button>
              <button type="button" className="workflow-button-quiet workflow-danger-button" onClick={() => void remove()} disabled={busy}>{copy.workflowDelete}</button>
            </> : null}
            {workspaceView === 'editor' ? <WorkflowEditorActions
              copy={copy}
              draft={draft}
              busy={busy}
              runDisabled={busy || currentRun?.status === 'running'}
              runLabel={currentRun?.status === 'running' ? copy.workflowRunning : copy.workflowRun}
              onCancel={exitWorkspace}
              onSave={() => void save()}
              onExportFile={exportWorkflowToFile}
              onExportClipboard={() => void exportWorkflowToClipboard()}
              onRun={() => void openRunSetup()}
            /> : <>
              <button type="button" className="workflow-button-primary workflow-save-button" onClick={() => void save()} disabled={busy}>{copy.workflowSave}</button>
              <button type="button" className="workflow-button-primary" onClick={() => void openRunSetup()} disabled={busy || currentRun?.status === 'running'}>{currentRun?.status === 'running' ? copy.workflowRunning : copy.workflowRun}</button>
            </>}
          </div>
        </header>
        <div className="workflow-workspace-body">
          {workspaceView === 'editor' ? <>
            <section className="workflow-editor-panel">
              <div className="workflow-editor-toolbar">
                <WorkflowNodeLibrary onAdd={addNode} />
                <button type="button" className="workflow-button-quiet workflow-auto-layout-button" onClick={autoLayout} disabled={busy}>自动排版</button>
                <p className="workflow-editor-flow-hint">一个节点可连接多个下游；多路输入会等待所有可用上游完成，并按节点 ID 汇聚传入。</p>
              </div>
              <WorkflowSelectionSurface ref={workflowCanvasRef} nodes={nodes} onSelectionChange={onWorkflowCanvasSelectionChange} className="workflow-canvas" tabIndex={0} onPointerDownCapture={focusWorkflowCanvas} onKeyDown={onCanvasKeyDown}>
                <ReactFlow
                  {...WORKFLOW_CANVAS_INTERACTION_PROPS}
                  nodes={nodes}
                  edges={workflowCanvasEdges(selected, edges)}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={(_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(undefined) }}
                  onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(undefined) }}
                  onPaneClick={() => { setSelectedNodeId(undefined); setSelectedEdgeId(undefined); focusWorkflowCanvas() }}
                  onNodeContextMenu={(event, node) => { event.preventDefault(); event.stopPropagation(); setSelectedNodeId(node.id); setSelectedEdgeId(undefined); setContextMenu({ x: event.clientX, y: event.clientY, target: 'node', nodeId: node.id }) }}
                  onEdgeContextMenu={(event, edge) => { event.preventDefault(); event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedNodeId(undefined); setContextMenu({ x: event.clientX, y: event.clientY, target: 'edge', edgeId: edge.id }) }}
                  onSelectionContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setContextMenu({ x: event.clientX, y: event.clientY, target: 'selection' }) }}
                  onPaneContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, target: 'canvas' }) }}
                  deleteKeyCode={null}
                  fitView
                >
                  <Background gap={20} size={1} />
                  <WorkflowFitViewBridge onReady={rememberFitView} />
                  <WorkflowCanvasTools copy={copy} showMiniMap={showMiniMap} onToggleMiniMap={() => setShowMiniMap((current) => !current)} />
                </ReactFlow>
              </WorkflowSelectionSurface>
            </section>
            <aside className="workflow-inspector">
              <section className="workflow-panel-card workflow-inspector-card">
                <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowEditor}</span><h2>{copy.workflowInspector}</h2></div>{selectedNode ? <span className="workflow-type-badge"><WorkflowNodeTypeIcon type={selectedNode.type} />{nodeTypeLabel[selectedNode.type]}</span> : null}</div>
                {selectedNode === undefined ? <p className="workflow-muted">{copy.workflowNodeSelectHint}</p> : <>
                  <label>{copy.workflowNodeLabel}<input value={selectedNode.label} onChange={(event) => updateNode((node) => ({ ...node, label: event.target.value }))} /></label>
                  {selectedNode.type === 'input' ? null : <WorkflowNodeVariablesEditor workflow={selected} node={selectedNode} onChange={(update) => updateNode((node) => update(node))} />}
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
                  {selectedNode.type === 'http' ? <><label>{copy.workflowHttpMethod}<select value={selectedNode.config.method} onChange={(event) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, method: event.target.value as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' } } : node)}>{(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => <option key={method} value={method}>{method}</option>)}</select></label><label>{copy.workflowHttpUrl}<input value={selectedNode.config.url} placeholder="https://api.example.com/data" onChange={(event) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, url: event.target.value } } : node)} /></label><McpArgumentsField key={selectedNode.id + '-headers'} copy={copy} value={selectedNode.config.headers} label={copy.workflowHttpHeaders} hint={copy.workflowHttpHeadersHint} onCommit={(headers) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, WorkflowValue] => typeof entry[1] === 'string').map(([key, value]) => [key, value as string])) } } : node)} /><McpArgumentsField key={selectedNode.id + '-query'} copy={copy} value={selectedNode.config.query} label={copy.workflowHttpQuery} hint={copy.workflowMcpArgumentsHint} onCommit={(query) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, query } } : node)} /><WorkflowJsonValueField key={selectedNode.id + '-body'} label={copy.workflowHttpBody} value={selectedNode.config.body} onCommit={(body) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, body } } : node)} /><label>{copy.workflowHttpResponseMode}<select value={selectedNode.config.responseMode} onChange={(event) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, responseMode: event.target.value as 'auto' | 'json' | 'text' } } : node)}><option value="auto">auto</option><option value="json">json</option><option value="text">text</option></select></label><label>{copy.workflowHttpTimeout}<input type="number" min="1000" max="600000" step="1000" value={selectedNode.config.timeoutMs ?? 120000} onChange={(event) => updateNode((node) => node.type === 'http' ? { ...node, config: { ...node.config, timeoutMs: Number(event.target.value) } } : node)} /></label></> : null}
                  {selectedNode.type === 'code' ? <><label>{copy.workflowCodeLanguage}<select value={selectedNode.config.language} onChange={(event) => updateNode((node) => node.type === 'code' ? { ...node, config: { ...node.config, language: event.target.value as 'nodejs' | 'python3' } } : node)}><option value="nodejs">Node.js</option><option value="python3">Python3</option></select></label><label>{copy.workflowCode}<textarea className="workflow-code-editor" value={selectedNode.config.code} spellCheck={false} onChange={(event) => updateNode((node) => node.type === 'code' ? { ...node, config: { ...node.config, code: event.target.value } } : node)} /></label><p className="workflow-muted">Node.js 可使用 input、previous 并 return 结果；Python3 可使用 input、previous 并给 result 赋值。</p><label>{copy.workflowCodeTimeout}<input type="number" min="1000" max="600000" step="1000" value={selectedNode.config.timeoutMs ?? 120000} onChange={(event) => updateNode((node) => node.type === 'code' ? { ...node, config: { ...node.config, timeoutMs: Number(event.target.value) } } : node)} /></label></> : null}
                </>}
              </section>
            </aside>
          </> : <section className={`workflow-executions ${showRunSidebar ? '' : 'workflow-executions-sidebar-hidden'}`}>
            {showRunSidebar ? <aside className="workflow-run-sidebar">
              <div className="workflow-panel-heading"><div><span className="workflow-kicker">{copy.workflowExecutions}</span><h2>{copy.workflowRunHistory}</h2></div><div className="workflow-run-sidebar-heading-actions"><span className="workflow-run-count">{runs.length}</span><button type="button" className="workflow-sidebar-toggle" aria-label={copy.workflowHideRunSidebar} title={copy.workflowHideRunSidebar} onClick={() => setShowRunSidebar(false)}>‹</button></div></div>
              {runs.length === 0 ? <p className="workflow-muted">{copy.workflowNoRuns}</p> : <div className="workflow-run-list">{runs.map((runRecord) => <button key={runRecord.id} type="button" className={`workflow-run-item ${currentRun?.id === runRecord.id ? 'workflow-run-item-active' : ''}`} onClick={() => selectRun(runRecord)}><strong>{statusLabel(runRecord.status)}</strong><span>{runRecord.id.slice(-12)} · {runRecord.startedAt ?? 'queued'}</span></button>)}</div>}
            </aside> : <button type="button" className="workflow-sidebar-toggle workflow-sidebar-toggle-floating" aria-label={copy.workflowShowRunSidebar} title={copy.workflowShowRunSidebar} onClick={() => setShowRunSidebar(true)}>›</button>}
            <div ref={executionMainRef} className="workflow-execution-main" style={{ '--workflow-execution-detail-height': `${executionDetailHeight}px` } as CSSProperties}>
              <div className="workflow-execution-canvas"><ReactFlow {...WORKFLOW_CANVAS_INTERACTION_PROPS} nodes={workflowFlowNodes(selected, currentRun, selectedRunNodeId)} edges={flowEdges(selected)} nodeTypes={nodeTypes} onNodeClick={(_event, node) => setSelectedRunNodeId(node.id)} onPaneClick={() => setSelectedRunNodeId(undefined)} fitView><Background gap={20} size={1} /><WorkflowCanvasTools copy={copy} showMiniMap={showMiniMap} onToggleMiniMap={() => setShowMiniMap((current) => !current)} /></ReactFlow></div>
              <div className="workflow-execution-resize-handle" role="separator" aria-orientation="horizontal" aria-label={copy.workflowResizeExecutionPanel} onPointerDown={beginExecutionResize}><span /></div>
              <WorkflowExecutionReview copy={copy} run={currentRun} nodeDetail={currentRunNodeDetail} selectedNode={selected?.nodes.find((node) => node.id === selectedRunNodeId)} statusLabel={statusLabel} onCancel={() => void cancel()} onApprove={() => void approve(true)} onReject={() => void approve(false)} onResume={() => void resume()} onSelectNode={setSelectedRunNodeId} onCopyOutput={copyOutput} onOpenOutputWindow={openOutputWindow} outputFontScale={outputFontScale} onIncreaseOutputFont={() => setOutputFontScale((current) => Math.min(1.8, Number((current + .1).toFixed(1))))} onDecreaseOutputFont={() => setOutputFontScale((current) => Math.max(.7, Number((current - .1).toFixed(1))))} />
            </div>
          </section>}
        </div>
      </>}
      {outputWindows.length > 0 ? <WorkflowOutputFloatingWindows copy={copy} windows={outputWindows} fontScale={outputFontScale} onClose={(id) => setOutputWindows((current) => current.filter((item) => item.id !== id))} onCopy={copyOutput} onMove={(id, position) => setOutputWindows((current) => current.map((item) => item.id === id ? { ...item, position } : item))} onFocus={(id) => setOutputWindows((current) => focusWorkflowOutputWindow(current, id))} onIncreaseFont={() => setOutputFontScale((current) => Math.min(1.8, Number((current + .1).toFixed(1))))} onDecreaseFont={() => setOutputFontScale((current) => Math.max(.7, Number((current - .1).toFixed(1))))} /> : null}
      {metadataDraft ? <WorkflowMetadataDialog copy={copy} name={metadataDraft.name} description={metadataDraft.description} onChangeName={(name) => setMetadataDraft((current) => current === undefined ? current : { ...current, name })} onChangeDescription={(description) => setMetadataDraft((current) => current === undefined ? current : { ...current, description })} onClose={() => setMetadataDraft(undefined)} onSave={saveWorkflowMetadata} /> : null}
      {runSetup ? <WorkflowRunLaunchDialog copy={copy} fields={runSetup.fields} values={runSetup.values} modelOptions={runSetup.modelOptions} modelSelection={runSetup.modelSelection} allowShellFile={runSetup.allowShellFile} allowCode={runSetup.allowCode} debug={runSetup.debug} busy={busy} modelLoading={runSetup.modelLoading} onChangeValue={(key, value) => setRunSetup((current) => current === undefined ? current : { ...current, values: { ...current.values, [key]: value } })} onChangeModel={(modelSelection) => setRunSetup((current) => current === undefined ? current : { ...current, modelSelection })} onRefreshModels={() => void refreshRunModels()} onChangeAllowShellFile={(allowShellFile) => setRunSetup((current) => current === undefined ? current : { ...current, allowShellFile })} onChangeAllowCode={(allowCode) => setRunSetup((current) => current === undefined ? current : { ...current, allowCode })} onChangeDebug={(debug) => setRunSetup((current) => current === undefined ? current : { ...current, debug })} onClose={() => setRunSetup(undefined)} onStart={() => void startRun()} /> : null}
      {contextMenu ? <WorkflowContextMenu copy={copy} target={contextMenu.target} x={contextMenu.x} y={contextMenu.y} selectedNodeCount={(contextMenu.target === 'canvas' || contextMenu.target === 'selection' || (contextMenu.nodeId !== undefined && nodes.some((node) => node.id === contextMenu.nodeId && node.selected === true))) ? nodes.filter((node) => node.selected === true).length : 0} canUndo={(history?.past.length ?? 0) > 0} canRedo={(history?.future.length ?? 0) > 0} busy={busy} runDisabled={currentRun?.status === 'running'} cancelLabel={draft ? copy.workflowCancelCreate : copy.workflowCancelEdit} onUndo={() => { dismissContextMenu(); undo(); focusWorkflowCanvas() }} onRedo={() => { dismissContextMenu(); redo(); focusWorkflowCanvas() }} onCopy={() => { copySelectedNodes(); dismissContextMenu(); focusWorkflowCanvas() }} onPaste={() => { pasteCopiedNodes(); dismissContextMenu(); focusWorkflowCanvas() }} canPaste={copiedWorkflowNodesRef.current.length > 0} onDelete={deleteContextMenuSelection} onAlign={alignSelectedNodes} onFitView={fitViewFromContextMenu} onSave={saveFromContextMenu} onRun={runFromContextMenu} onCancel={() => { dismissContextMenu(); exitWorkspace() }} /> : null}
      {message ? <WorkflowToast message={message} copy={copy} actionLabel={deletedWorkflow === undefined ? undefined : copy.workflowUndoDelete} onAction={deletedWorkflow === undefined ? undefined : () => void restoreDeletedWorkflow()} onDismiss={() => setMessage('')} /> : null}
      {error ? <WorkflowErrorBanner message={error} copy={copy} onDismiss={() => setError('')} /> : null}
    </div>
  )
}

export function WorkflowErrorBanner({ message, copy, onDismiss }: { message: string; copy: AppCopy; onDismiss: () => void }): JSX.Element {
  return <div className="workflow-error-banner" role="alert"><span>{message}</span><button type="button" aria-label={copy.workflowDismiss} title={copy.workflowDismiss} onClick={onDismiss}>×</button></div>
}

function workflowVariableOptionKey(option: WorkflowVariableOption): string {
  return `${option.sourceNodeId}\u0000${option.sourcePath ?? ''}`
}

function workflowBindingFromOption(option: WorkflowVariableOption, name: string): WorkflowNodeInputBinding {
  return { id: id('variable'), name, sourceNodeId: option.sourceNodeId, ...(option.sourcePath === undefined ? {} : { sourcePath: option.sourcePath }), required: true }
}

/** Dify-style per-node bindings keep variable selection separate from graph connections. */
function WorkflowNodeVariablesEditor({ workflow, node, onChange }: { workflow: WorkflowDefinition; node: WorkflowNode; onChange: (update: (node: WorkflowNode) => WorkflowNode) => void }): JSX.Element {
  const options = getWorkflowVariableOptions(workflow, node.id)
  const optionsByKey = new Map(options.map((option) => [workflowVariableOptionKey(option), option]))
  const bindings = node.inputBindings ?? []
  const outputVariables = node.outputVariables ?? []
  const updateBinding = (index: number, update: (binding: WorkflowNodeInputBinding) => WorkflowNodeInputBinding): void => onChange((current) => ({ ...current, inputBindings: (current.inputBindings ?? []).map((binding, currentIndex) => currentIndex === index ? update(binding) : binding) }))
  const removeBinding = (index: number): void => onChange((current) => ({ ...current, inputBindings: (current.inputBindings ?? []).filter((_binding, currentIndex) => currentIndex !== index) }))
  const addBinding = (): void => {
    const option = options[0]
    if (option === undefined) return
    onChange((current) => ({ ...current, inputBindings: [...(current.inputBindings ?? []), workflowBindingFromOption(option, `input_${(current.inputBindings?.length ?? 0) + 1}`)] }))
  }
  const updateOutput = (index: number, update: (variable: WorkflowNodeOutputVariable) => WorkflowNodeOutputVariable): void => onChange((current) => ({ ...current, outputVariables: (current.outputVariables ?? []).map((variable, currentIndex) => currentIndex === index ? update(variable) : variable) }))
  return <>
    <details className="workflow-variable-editor" open>
      <summary>输入变量</summary>
      <p>选择本节点实际使用的上游变量；在提示词中使用 <code>{'{{变量名}}'}</code>。</p>
      {bindings.map((binding, index) => <div key={binding.id} className="workflow-variable-editor-row">
        <input aria-label="变量名" value={binding.name} onChange={(event) => updateBinding(index, (current) => ({ ...current, name: event.target.value }))} />
        <select aria-label="变量来源" value={workflowVariableOptionKey({ sourceNodeId: binding.sourceNodeId, sourcePath: binding.sourcePath, label: '' })} onChange={(event) => {
          const option = optionsByKey.get(event.target.value)
          if (option !== undefined) updateBinding(index, (current) => ({ ...current, sourceNodeId: option.sourceNodeId, ...(option.sourcePath === undefined ? { sourcePath: undefined } : { sourcePath: option.sourcePath }) }))
        }}>{options.map((option) => <option key={workflowVariableOptionKey(option)} value={workflowVariableOptionKey(option)}>{option.label}</option>)}</select>
        <label className="workflow-variable-required"><input type="checkbox" checked={binding.required} onChange={(event) => updateBinding(index, (current) => ({ ...current, required: event.target.checked }))} />必填</label>
        <button type="button" className="workflow-variable-remove" onClick={() => removeBinding(index)} aria-label="删除变量">×</button>
      </div>)}
      <button type="button" className="workflow-variable-add" onClick={addBinding} disabled={options.length === 0}>添加输入变量</button>
    </details>
    <details className="workflow-variable-editor">
      <summary>输出变量</summary>
      <p><code>result</code> 始终代表整个节点结果；为 JSON 输出补充字段名，供下游选择。</p>
      {outputVariables.map((variable, index) => <div key={`${variable.name}-${index}`} className="workflow-variable-editor-row"><input aria-label="输出变量名" value={variable.name} onChange={(event) => updateOutput(index, (current) => ({ ...current, name: event.target.value }))} /><input aria-label="输出变量说明" value={variable.description ?? ''} placeholder="说明（可选）" onChange={(event) => updateOutput(index, (current) => ({ ...current, description: event.target.value }))} /><button type="button" className="workflow-variable-remove" aria-label="删除输出变量" onClick={() => onChange((current) => ({ ...current, outputVariables: (current.outputVariables ?? []).filter((_variable, currentIndex) => currentIndex !== index) }))}>×</button></div>)}
      <button type="button" className="workflow-variable-add" onClick={() => onChange((current) => ({ ...current, outputVariables: [...(current.outputVariables ?? []), { name: `output_${(current.outputVariables?.length ?? 0) + 1}` }] }))}>添加输出变量</button>
    </details>
  </>
}

function OutputModeField({ copy, value, onChange }: { copy: AppCopy; value: WorkflowOutputMode; onChange: (value: WorkflowOutputMode) => void }): JSX.Element {
  return <label>{copy.workflowOutputMode}<select value={value} onChange={(event) => onChange(event.target.value as WorkflowOutputMode)}><option value="text">{copy.workflowOutputText}</option><option value="json">{copy.workflowOutputJson}</option></select></label>
}

function EmployeeProfileContext({ copy, employee }: { copy: AppCopy; employee: EmployeeSnapshot | undefined }): JSX.Element | null {
  if (employee === undefined) return null
  return <div className="workflow-employee-context"><strong>{copy.workflowEmployeeProfile} · v{employee.version}</strong><p>{employee.businessBoundary || employee.description}</p></div>
}
