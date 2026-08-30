/** The persisted workflow document format. Keep this independent from React Flow. */
export const WORKFLOW_SCHEMA_VERSION = 2 as const

export const WORKFLOW_NODE_TYPES = [
  'input',
  'ai-task',
  'employee',
  'skill',
  'mcp',
  'parallel',
  'loop',
  'condition',
  'approval',
  'transform',
  'output',
  'shell',
  'file',
] as const

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number]

export type WorkflowScalar = string | number | boolean | null
export type WorkflowValue = WorkflowScalar | WorkflowValue[] | { [key: string]: WorkflowValue }

export interface WorkflowPosition {
  x: number
  y: number
}

export interface WorkflowNodeBase<T extends WorkflowNodeType, C> {
  id: string
  type: T
  label: string
  config: C
  position: WorkflowPosition
}

export interface InputNodeConfig {
  name?: string
  defaultValue?: WorkflowValue
}

export type AiExecutionMode = 'single' | 'autonomous'
export type WorkflowOutputMode = 'text' | 'json'

export interface AiTaskNodeConfig {
  instruction: string
  systemPrompt?: string
  mode: AiExecutionMode
  skillIds: string[]
  outputMode: WorkflowOutputMode
}

export interface EmployeeNodeConfig {
  employeeId: string
  instruction: string
  outputMode: WorkflowOutputMode
}

export interface SkillNodeConfig {
  skillId: string
  instruction: string
}

export interface McpNodeConfig {
  tool: string
  /** Legacy natural-language instruction retained for existing workflows. */
  instruction?: string
  /** JSON-compatible arguments passed directly to the MCP tool. */
  arguments?: Record<string, WorkflowValue>
}

export interface ParallelNodeConfig {
  instructions: string[]
}

export interface LoopNodeConfig {
  instruction: string
  maxIterations?: number
}

export interface ApprovalNodeConfig {
  message: string
}

export type ConditionOperator = 'truthy' | 'equals' | 'not-equals' | 'contains' | 'greater-than' | 'less-than'

export interface ConditionNodeConfig {
  operator: ConditionOperator
  value?: WorkflowValue
}

export type TransformTemplate = 'identity' | 'json' | 'extract-text' | 'prepend' | 'append'

export interface TransformNodeConfig {
  template: TransformTemplate
  text?: string
}

export interface OutputNodeConfig {
  label?: string
}

export interface ShellNodeConfig {
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
}

export interface FileNodeConfig {
  operation: 'read' | 'write'
  path: string
  content?: string
}

export type WorkflowNode =
  | WorkflowNodeBase<'input', InputNodeConfig>
  | WorkflowNodeBase<'ai-task', AiTaskNodeConfig>
  | WorkflowNodeBase<'employee', EmployeeNodeConfig>
  | WorkflowNodeBase<'skill', SkillNodeConfig>
  | WorkflowNodeBase<'mcp', McpNodeConfig>
  | WorkflowNodeBase<'parallel', ParallelNodeConfig>
  | WorkflowNodeBase<'loop', LoopNodeConfig>
  | WorkflowNodeBase<'condition', ConditionNodeConfig>
  | WorkflowNodeBase<'approval', ApprovalNodeConfig>
  | WorkflowNodeBase<'transform', TransformNodeConfig>
  | WorkflowNodeBase<'output', OutputNodeConfig>
  | WorkflowNodeBase<'shell', ShellNodeConfig>
  | WorkflowNodeBase<'file', FileNodeConfig>

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourcePort?: 'true' | 'false' | 'default'
  targetPort?: string
}

export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION
  id: string
  name: string
  description: string
  revision: number
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunId?: string
}

export type WorkflowCreateInput = Pick<WorkflowDefinition, 'name' | 'description' | 'nodes' | 'edges'> & {
  id?: string
  enabled?: boolean
}

export type WorkflowUpdateInput = WorkflowCreateInput & { revision?: number }

export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled'
export type WorkflowNodeRunStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled'

export interface WorkflowNodeRunState {
  nodeId: string
  status: WorkflowNodeRunStatus
  startedAt?: string
  completedAt?: string
  output?: WorkflowValue
  error?: string
}

export type WorkflowRunEventType = 'run-created' | 'run-started' | 'node-started' | 'node-completed' | 'node-skipped' | 'node-failed' | 'approval-requested' | 'approval-resolved' | 'run-completed' | 'run-failed' | 'run-paused' | 'run-cancelled'

export interface WorkflowRunEvent {
  id: string
  time: string
  type: WorkflowRunEventType
  nodeId?: string
  message?: string
}

export interface WorkflowRunRecord {
  id: string
  workflowId: string
  workflowRevision: number
  status: WorkflowRunStatus
  input: WorkflowValue
  output?: WorkflowValue
  nodeStates: WorkflowNodeRunState[]
  events: WorkflowRunEvent[]
  allowShellFile: boolean
  /** Optional model override selected for this run; omitted means provider default. */
  model?: WorkflowModelSelection
  /** Debug runs retain diagnostic history for longer than normal runs. */
  debug?: boolean
  /** Terminal workflow history is eligible for cleanup after this timestamp. */
  retentionExpiresAt?: string
  waitingApprovalNodeId?: string
  startedAt?: string
  completedAt?: string
  error?: string
}

export interface WorkflowRunOptions {
  allowShellFile?: boolean
  debug?: boolean
  /** Optional model override; omitted to use the configured default model. */
  model?: WorkflowModelSelection
}

export interface WorkflowModelSelection {
  providerId: string
  modelId: string
}

/** Safe model choices exposed to the renderer; credentials remain main-process only. */
export interface WorkflowModelOption extends WorkflowModelSelection {
  providerName: string
  modelName?: string
}

export interface WorkflowGenerateRequest {
  prompt: string
  name?: string
}

export interface WorkflowValidationIssue {
  path: string
  message: string
}

export interface WorkflowValidationResult {
  valid: boolean
  issues: WorkflowValidationIssue[]
}

export function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return (WORKFLOW_NODE_TYPES as readonly unknown[]).includes(value)
}

export function isWorkflowValue(value: unknown): value is WorkflowValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isWorkflowValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isWorkflowValue)
}

export function cloneWorkflow<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function newId(prefix: string): string {
  const entropy = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${entropy}`
}

function now(): string {
  return new Date().toISOString()
}

export function createDefaultWorkflow(name = '新工作流'): WorkflowDefinition {
  const inputId = newId('input')
  const aiTaskId = newId('ai-task')
  const outputId = newId('output')
  const createdAt = now()
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: newId('workflow'),
    name,
    description: '从输入开始，交给智能处理节点完成轻量任务，再输出结果。',
    revision: 1,
    nodes: [
      { id: inputId, type: 'input', label: '输入', config: { name: 'task' }, position: { x: 80, y: 180 } },
      {
        id: aiTaskId,
        type: 'ai-task',
        label: '智能处理',
        config: {
          instruction: '请完成输入任务，并给出清晰、可执行的结果。',
          mode: 'single',
          skillIds: [],
          outputMode: 'text',
        },
        position: { x: 380, y: 180 },
      },
      { id: outputId, type: 'output', label: '输出', config: {}, position: { x: 720, y: 180 } },
    ],
    edges: [
      { id: newId('edge'), source: inputId, target: aiTaskId },
      { id: newId('edge'), source: aiTaskId, target: outputId },
    ],
    enabled: true,
    createdAt,
    updatedAt: createdAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPosition(value: unknown): WorkflowPosition {
  if (!isRecord(value)) return { x: 0, y: 0 }
  return {
    x: typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : 0,
    y: typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : 0,
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeNodeType(value: unknown): WorkflowNodeType | undefined {
  if (value === 'agent') return 'ai-task'
  return isWorkflowNodeType(value) ? value : undefined
}

function readNodeConfig(type: WorkflowNodeType, value: unknown): Record<string, unknown> {
  const config = isRecord(value) ? value : {}
  switch (type) {
    case 'input': return { name: typeof config.name === 'string' ? config.name : undefined, defaultValue: isWorkflowValue(config.defaultValue) ? config.defaultValue : undefined }
    case 'ai-task': return {
      instruction: typeof config.instruction === 'string' ? config.instruction : '',
      systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined,
      mode: config.mode === 'autonomous' ? 'autonomous' : 'single',
      skillIds: readStringArray(config.skillIds),
      outputMode: config.outputMode === 'json' ? 'json' : 'text',
    }
    case 'employee': return {
      employeeId: typeof config.employeeId === 'string' ? config.employeeId : '',
      instruction: typeof config.instruction === 'string' ? config.instruction : '',
      outputMode: config.outputMode === 'json' ? 'json' : 'text',
    }
    case 'skill': return { skillId: typeof config.skillId === 'string' ? config.skillId : '', instruction: typeof config.instruction === 'string' ? config.instruction : '' }
    case 'mcp': return {
      tool: typeof config.tool === 'string' ? config.tool : '',
      instruction: typeof config.instruction === 'string' ? config.instruction : undefined,
      arguments: isRecord(config.arguments) && isWorkflowValue(config.arguments) ? config.arguments as Record<string, WorkflowValue> : undefined,
    }
    case 'parallel': return { instructions: Array.isArray(config.instructions) ? config.instructions.filter((item): item is string => typeof item === 'string') : [] }
    case 'loop': return { instruction: typeof config.instruction === 'string' ? config.instruction : '', maxIterations: typeof config.maxIterations === 'number' ? config.maxIterations : undefined }
    case 'condition': return { operator: config.operator, value: isWorkflowValue(config.value) ? config.value : undefined }
    case 'approval': return { message: typeof config.message === 'string' ? config.message : '' }
    case 'transform': return { template: config.template, text: typeof config.text === 'string' ? config.text : undefined }
    case 'output': return { label: typeof config.label === 'string' ? config.label : undefined }
    case 'shell': return { command: typeof config.command === 'string' ? config.command : '', args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [], cwd: typeof config.cwd === 'string' ? config.cwd : undefined, timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined }
    case 'file': return { operation: config.operation, path: typeof config.path === 'string' ? config.path : '', content: typeof config.content === 'string' ? config.content : undefined }
  }
}

/** Normalize untrusted JSON from disk or AI output into the public schema. */
export function normalizeWorkflow(raw: unknown): WorkflowDefinition | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return undefined
  const nodes: WorkflowNode[] = []
  for (const rawNode of raw.nodes) {
    if (!isRecord(rawNode) || typeof rawNode.id !== 'string') continue
    const type = normalizeNodeType(rawNode.type)
    if (type === undefined) continue
    const legacyAgent = rawNode.type === 'agent'
    const rawLabel = typeof rawNode.label === 'string' ? rawNode.label.trim() : ''
    nodes.push({
      id: rawNode.id,
      type,
      label: legacyAgent && (rawLabel === '' || rawLabel === 'Agent') ? '智能处理' : rawLabel || type,
      config: readNodeConfig(type, rawNode.config) as never,
      position: readPosition(rawNode.position),
    } as WorkflowNode)
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges: WorkflowEdge[] = []
  for (const rawEdge of raw.edges) {
    if (!isRecord(rawEdge) || typeof rawEdge.id !== 'string' || typeof rawEdge.source !== 'string' || typeof rawEdge.target !== 'string') continue
    if (!nodeIds.has(rawEdge.source) || !nodeIds.has(rawEdge.target)) continue
    edges.push({
      id: rawEdge.id,
      source: rawEdge.source,
      target: rawEdge.target,
      sourcePort: rawEdge.sourcePort === 'true' || rawEdge.sourcePort === 'false' || rawEdge.sourcePort === 'default' ? rawEdge.sourcePort : undefined,
      targetPort: typeof rawEdge.targetPort === 'string' ? rawEdge.targetPort : undefined,
    })
  }
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now()
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: raw.id,
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
    nodes,
    edges,
    enabled: raw.enabled !== false,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt,
    lastRunId: typeof raw.lastRunId === 'string' ? raw.lastRunId : undefined,
  }
}

/** Validate a workflow before it enters persistence or execution. */
export function validateWorkflow(workflow: WorkflowDefinition): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []
  if (workflow.schemaVersion !== WORKFLOW_SCHEMA_VERSION) issues.push({ path: 'schemaVersion', message: '不支持的 Workflow Schema 版本。' })
  if (workflow.name.trim() === '') issues.push({ path: 'name', message: '工作流名称不能为空。' })
  if (workflow.name.length > 120) issues.push({ path: 'name', message: '工作流名称不能超过 120 个字符。' })

  const nodeIds = new Set<string>()
  for (const [index, node] of workflow.nodes.entries()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(node.id)) issues.push({ path: `nodes.${index}.id`, message: '节点 ID 只能包含字母、数字、点、下划线和短横线。' })
    if (nodeIds.has(node.id)) issues.push({ path: `nodes.${index}.id`, message: '节点 ID 重复。' })
    nodeIds.add(node.id)
    if (node.label.trim() === '') issues.push({ path: `nodes.${index}.label`, message: '节点名称不能为空。' })
    validateNodeConfig(node, `nodes.${index}.config`, issues)
  }

  const edgeIds = new Set<string>()
  const adjacency = new Map<string, string[]>()
  for (const [index, edge] of workflow.edges.entries()) {
    if (edgeIds.has(edge.id)) issues.push({ path: `edges.${index}.id`, message: '连线 ID 重复。' })
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) issues.push({ path: `edges.${index}`, message: '连线必须连接现有节点。' })
    const targets = adjacency.get(edge.source) ?? []
    targets.push(edge.target)
    adjacency.set(edge.source, targets)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      issues.push({ path: 'edges', message: '工作流不能包含循环；请拆成多个工作流或移除回环。' })
      return
    }
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const target of adjacency.get(nodeId) ?? []) visit(target)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const nodeId of nodeIds) visit(nodeId)
  if (workflow.nodes.length === 0) issues.push({ path: 'nodes', message: '至少需要一个节点。' })
  return { valid: issues.length === 0, issues }
}

function validateNodeConfig(node: WorkflowNode, path: string, issues: WorkflowValidationIssue[]): void {
  const add = (message: string): void => { issues.push({ path, message }) }
  switch (node.type) {
    case 'ai-task':
      if (node.config.instruction.trim() === '') add('智能处理指令不能为空。')
      if (node.config.mode !== 'single' && node.config.mode !== 'autonomous') add('智能处理执行模式无效。')
      if (node.config.outputMode !== 'text' && node.config.outputMode !== 'json') add('智能处理输出格式无效。')
      if (node.config.skillIds.some((id) => id.trim() === '' || /\s/u.test(id))) add('技能 ID 不能为空或包含空格。')
      break
    case 'employee':
      if (node.config.employeeId.trim() === '' || /\s/u.test(node.config.employeeId)) add('专业员工节点需要有效的员工 ID。')
      if (node.config.instruction.trim() === '') add('专业员工节点指令不能为空。')
      if (node.config.outputMode !== 'text' && node.config.outputMode !== 'json') add('专业员工输出格式无效。')
      break
    case 'skill': if (node.config.skillId.trim() === '' || node.config.instruction.trim() === '') add('Skill 节点需要 skill ID 和指令。'); break
    case 'mcp':
      if (node.config.tool.trim() === '') add('MCP 节点需要工具名。')
      if (node.config.arguments !== undefined && !isWorkflowValue(node.config.arguments)) add('MCP 参数必须是 JSON 兼容对象。')
      break
    case 'parallel': if (node.config.instructions.length === 0 || node.config.instructions.some((instruction) => instruction.trim() === '')) add('Parallel 节点至少需要一条非空指令。'); break
    case 'loop': if (node.config.instruction.trim() === '') add('Loop 节点指令不能为空。'); if (node.config.maxIterations !== undefined && (!Number.isInteger(node.config.maxIterations) || node.config.maxIterations < 1 || node.config.maxIterations > 100)) add('Loop 最大迭代次数必须是 1 到 100。'); break
    case 'condition': if (!['truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'].includes(node.config.operator)) add('Condition 操作符无效。'); break
    case 'approval': if (node.config.message.trim() === '') add('Approval 节点需要审批提示。'); break
    case 'transform': if (!['identity', 'json', 'extract-text', 'prepend', 'append'].includes(node.config.template)) add('Transform 模板无效。'); break
    case 'shell':
      if (node.config.command.trim() === '') add('Shell 命令不能为空。')
      if (/[[\]{}();|&<>`$\\]/u.test(node.config.command)) add('Shell 命令包含不允许的控制字符；执行使用 shell:false。')
      if (node.config.args.some((arg) => /[\r\n]/u.test(arg))) add('Shell 参数不能包含换行。')
      break
    case 'file':
      if (node.config.path.trim() === '' || node.config.path.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(node.config.path)) add('File 路径必须是工作区内的相对路径。')
      if (node.config.operation !== 'read' && node.config.operation !== 'write') add('File 操作必须是 read 或 write。')
      break
    case 'input':
    case 'output':
      break
  }
}
