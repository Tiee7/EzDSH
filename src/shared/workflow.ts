/** The persisted workflow document format. Keep this independent from React Flow. */
import { EMPLOYEE_CAPABILITIES, type EmployeeSnapshot } from './employees.js'

export const WORKFLOW_SCHEMA_VERSION = 2 as const
/** Stable envelope identifier for files exchanged through the workflow UI. */
export const WORKFLOW_EXPORT_FORMAT = 'ezdsh.workflow' as const
export const WORKFLOW_EXPORT_FORMAT_VERSION = 1 as const

export const WORKFLOW_NODE_TYPES = [
  'input',
  'ai-task',
  'structured-extract',
  'employee',
  'skill',
  'mcp',
  'sub-workflow',
  'parallel',
  'loop',
  'sleep',
  'condition',
  'switch',
  'approval',
  'wait-input',
  'transform',
  'object-builder',
  'list-operator',
  'merge',
  'text-merge',
  'output',
  'shell',
  'file',
  'http',
  'code',
] as const

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number]

export type WorkflowScalar = string | number | boolean | null
export type WorkflowValue = WorkflowScalar | WorkflowValue[] | { [key: string]: WorkflowValue }

export interface WorkflowPosition {
  x: number
  y: number
}

/** A named value made available to a node from an earlier node's output. */
export interface WorkflowNodeInputBinding {
  id: string
  /** The variable name exposed inside this node, for example `research`. */
  name: string
  sourceNodeId: string
  /** Optional object/array path within the source output, for example `summary` or `items.0`. */
  sourcePath?: string
  required: boolean
  defaultValue?: WorkflowValue
}

/** A user-facing field advertised by a node's structured output. `result` is always implicit. */
export interface WorkflowNodeOutputVariable {
  name: string
  description?: string
}

/**
 * Bounded retry configuration. Deterministic nodes are safe to replay; an
 * external node must opt into the idempotent mode and provide its own effect
 * contract before a connector adapter can use it.
 */
export type WorkflowRetryMode = 'deterministic' | 'idempotent'

export interface WorkflowRetryPolicy {
  mode?: WorkflowRetryMode
  /** Total attempts, including the initial execution. */
  maxAttempts: number
  /** Compatibility name used by the execution-policy module. */
  initialDelayMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Random jitter ratio in [0, 1]; omitted uses a small default. */
  jitterRatio?: number
}

/** Compatibility alias for callers that distinguish node-level policy types. */
export type WorkflowNodeRetryPolicy = WorkflowRetryPolicy

/** Explicit reverse action for an effectful node. Never inferred from a DAG. */
export interface WorkflowCompensationAction {
  type: 'workflow'
  workflowId: string
  input?: WorkflowValue
  waitForCompletion?: boolean
}

export interface WorkflowCompensationEntry {
  sourceNodeId: string
  action: WorkflowCompensationAction
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt?: string
  completedAt?: string
  error?: string
}

export interface WorkflowNodeBase<T extends WorkflowNodeType, C> {
  id: string
  type: T
  label: string
  /** Optional human-facing context shown above the node's settings. */
  description?: string
  config: C
  position: WorkflowPosition
  /** Optional bounded retry policy; omitted means fail once. */
  retryPolicy?: WorkflowRetryPolicy
  /** Optional explicit reverse action, executed only through compensation(). */
  compensation?: WorkflowCompensationAction
  /** Variables this node elects to consume. Control-flow edges never implicitly become prompt inputs. */
  inputBindings?: WorkflowNodeInputBinding[]
  /** Optional JSON fields produced by this node, presented to downstream variable pickers. */
  outputVariables?: WorkflowNodeOutputVariable[]
}

export type WorkflowInputFieldType = 'string' | 'number' | 'boolean' | 'json' | 'file' | 'file-list'

/** A named launch parameter exposed by a structured input node. */
export interface WorkflowInputField {
  name: string
  label?: string
  type?: WorkflowInputFieldType
  required?: boolean
  defaultValue?: WorkflowValue
}

export interface InputNodeConfig {
  name?: string
  defaultValue?: WorkflowValue
  /** Multiple launch parameters for workflows that start with an object input. */
  fields?: WorkflowInputField[]
}

export type AiExecutionMode = 'single' | 'autonomous'
export type WorkflowOutputMode = 'text' | 'json'

export interface AiTaskNodeConfig {
  instruction: string
  systemPrompt?: string
  mode: AiExecutionMode
  skillIds: string[]
  outputMode: WorkflowOutputMode
  /** Optional JSON Schema used to validate structured model output. */
  outputSchema?: WorkflowJsonSchema
}

export interface StructuredExtractNodeConfig {
  schema: WorkflowJsonSchema
  maxRetries?: number
}

export interface WorkflowJsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  properties?: Record<string, WorkflowJsonSchema>
  required?: string[]
  items?: WorkflowJsonSchema
  enum?: WorkflowValue[]
  additionalProperties?: boolean
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

export interface SubWorkflowNodeConfig {
  workflowId: string
  /** When false, returns a queued child run reference instead of waiting. */
  waitForCompletion?: boolean
  /** Optional child-input object assembled from the current node context. */
  inputMapping?: Record<string, WorkflowValue>
  /** Reserved selector for a pinned revision or the latest saved revision. */
  version?: number | 'latest'
}

export interface ParallelNodeConfig {
  instructions: string[]
}

export interface LoopNodeConfig {
  /** Legacy per-item AI instruction. New loops execute the node connected to the loop-body port. */
  instruction?: string
  maxIterations?: number
  concurrency?: number
  batchSize?: number
  failureStrategy?: 'stop' | 'continue'
}

export interface SleepNodeConfig {
  /** Milliseconds to wait before passing the input through unchanged. */
  durationMs: number
  /** fixed keeps durationMs; random samples a fresh integer in [minDurationMs, maxDurationMs] per execution. */
  mode?: 'fixed' | 'random'
  minDurationMs?: number
  maxDurationMs?: number
}

export interface ApprovalNodeConfig {
  message: string
}

export interface WaitInputNodeConfig {
  /** approval is the compatibility preset for the old approval node. */
  mode: 'approval' | 'form'
  message: string
  fields?: WorkflowInputField[]
}

export type ConditionOperator = 'truthy' | 'equals' | 'not-equals' | 'contains' | 'greater-than' | 'less-than'

export interface ConditionNodeConfig {
  operator: ConditionOperator
  value?: WorkflowValue
}

export interface SwitchCase {
  id: string
  label?: string
  value: WorkflowValue
}

export interface SwitchNodeConfig {
  cases: SwitchCase[]
}

export interface ObjectBuilderNodeConfig {
  fields: Record<string, WorkflowValue>
}

export type ListOperatorOperation = 'filter' | 'map' | 'pluck' | 'sort' | 'dedupe' | 'slice' | 'group' | 'aggregate'

export interface ListOperatorNodeConfig {
  operation: ListOperatorOperation
  path?: string
  value?: WorkflowValue
  descending?: boolean
  start?: number
  end?: number
  /** For map, the output field/path to extract. */
  outputPath?: string
  groupPath?: string
  aggregateMode?: 'count' | 'sum' | 'average' | 'min' | 'max'
  aggregatePath?: string
}

export type MergeOperation = 'append' | 'object-merge' | 'join' | 'zip' | 'first-non-null'

export interface MergeNodeConfig {
  operation: MergeOperation
  leftKey?: string
  rightKey?: string
}

export type TransformTemplate = 'identity' | 'json' | 'extract-text' | 'prepend' | 'append' | 'replace' | 'text'

export interface TransformNodeConfig {
  template: TransformTemplate
  text?: string
  /** Text to search for when template is replace. Supports workflow variables. */
  find?: string
  /** Replacement text when template is replace. Supports workflow variables. */
  replacement?: string
}

/** Deterministic node for composing several upstream text values into one string. */
export interface TextMergeNodeConfig {
  /** Supports {{variable}} and {{variable.path}} references to this node's input bindings. */
  template: string
  /** Used when template is empty; bound values are joined in declaration order. */
  separator?: string
}

export type WorkflowOutputContentMode = 'variable' | 'text'

export interface OutputNodeConfig {
  label?: string
  /** Legacy nodes omit this field and keep their existing variable-based output behavior. */
  contentMode?: WorkflowOutputContentMode
  /** Text template used when contentMode is text; references output-node input bindings. */
  text?: string
}

export interface ShellNodeConfig {
  command: string
  args: string[]
  cwd?: string
  timeoutMs?: number
}

export interface FileNodeConfig {
  operation: 'read' | 'write' | 'list' | 'stat' | 'extract-text'
  path: string
  content?: string
  recursive?: boolean
}

export type WorkflowHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type WorkflowHttpResponseMode = 'auto' | 'json' | 'text'

/** HTTP request configuration. Headers, query and body may use {{input}}/{{value}} templates at runtime. */
export interface HttpNodeConfig {
  method: WorkflowHttpMethod
  url: string
  /** Managed connector reference; when present url must not be used for dispatch. */
  connectorId?: string
  /** Relative path inside the managed connector base URL. */
  connectorPath?: string
  headers: Record<string, string>
  query?: Record<string, WorkflowValue>
  body?: WorkflowValue
  responseMode: WorkflowHttpResponseMode
  timeoutMs?: number
}

export type WorkflowConnectorOperation = 'read' | 'write'

export interface WorkflowConnectorPermission {
  connectorId: string
  operations: WorkflowConnectorOperation[]
}

export interface WorkflowPermissionPolicy {
  connectors?: WorkflowConnectorPermission[]
}

/** A one-run grant; it can only narrow the workflow policy and connector scope. */
export interface WorkflowConnectorGrant {
  connectorId: string
  operations: WorkflowConnectorOperation[]
}

export interface WorkflowCredentialScope {
  origin: string
  methods: WorkflowHttpMethod[]
  headerName: string
  prefix?: string
  pathPrefixes?: string[]
}

export type WorkflowCredentialType = 'bearer-token' | 'api-key'

export interface WorkflowCredentialMetadata {
  id: string
  label: string
  type: WorkflowCredentialType
  configured: boolean
  scopes: WorkflowCredentialScope[]
}

/** IPC input for provisioning a credential; secret is accepted only transiently by main. */
export interface WorkflowCredentialUpsertInput {
  id: string
  label: string
  type: WorkflowCredentialType
  scopes: WorkflowCredentialScope[]
  secret?: string
}

/** No secret is ever stored in a workflow definition or connector registry. */
export interface WorkflowHttpConnector {
  id: string
  name: string
  kind: 'http'
  baseUrl: string
  credentialRef?: { id: string }
  allowedPathPrefixes: string[]
}

export type WorkflowCodeLanguage = 'nodejs' | 'python3'

/** A sandboxed-by-default script step. The run dialog must explicitly authorize it. */
export interface CodeNodeConfig {
  language: WorkflowCodeLanguage
  code: string
  timeoutMs?: number
}

export type WorkflowNode =
  | WorkflowNodeBase<'input', InputNodeConfig>
  | WorkflowNodeBase<'ai-task', AiTaskNodeConfig>
  | WorkflowNodeBase<'structured-extract', StructuredExtractNodeConfig>
  | WorkflowNodeBase<'employee', EmployeeNodeConfig>
  | WorkflowNodeBase<'skill', SkillNodeConfig>
  | WorkflowNodeBase<'mcp', McpNodeConfig>
  | WorkflowNodeBase<'sub-workflow', SubWorkflowNodeConfig>
  | WorkflowNodeBase<'parallel', ParallelNodeConfig>
  | WorkflowNodeBase<'loop', LoopNodeConfig>
  | WorkflowNodeBase<'sleep', SleepNodeConfig>
  | WorkflowNodeBase<'condition', ConditionNodeConfig>
  | WorkflowNodeBase<'switch', SwitchNodeConfig>
  | WorkflowNodeBase<'approval', ApprovalNodeConfig>
  | WorkflowNodeBase<'wait-input', WaitInputNodeConfig>
  | WorkflowNodeBase<'transform', TransformNodeConfig>
  | WorkflowNodeBase<'object-builder', ObjectBuilderNodeConfig>
  | WorkflowNodeBase<'list-operator', ListOperatorNodeConfig>
  | WorkflowNodeBase<'merge', MergeNodeConfig>
  | WorkflowNodeBase<'text-merge', TextMergeNodeConfig>
  | WorkflowNodeBase<'output', OutputNodeConfig>
  | WorkflowNodeBase<'shell', ShellNodeConfig>
  | WorkflowNodeBase<'file', FileNodeConfig>
  | WorkflowNodeBase<'http', HttpNodeConfig>
  | WorkflowNodeBase<'code', CodeNodeConfig>

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourcePort?: 'true' | 'false' | 'default' | 'loop-body' | 'loop-next' | `switch:${string}`
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
  /** Original user prompt when this workflow was generated by AI. */
  generationPrompt?: string
  /** Optional least-privilege connector declarations. */
  permissionPolicy?: WorkflowPermissionPolicy
}

/** Employee profile bundled with an exchange document when a workflow references it. */
export type WorkflowExportEmployee = Omit<EmployeeSnapshot, 'schemaVersion' | 'version' | 'createdAt' | 'updatedAt' | 'builtIn'>

/** Versioned, JSON-only interchange document for workflow import/export. */
export interface WorkflowExportDocument {
  format: typeof WORKFLOW_EXPORT_FORMAT
  formatVersion: typeof WORKFLOW_EXPORT_FORMAT_VERSION
  exportedAt: string
  workflow: WorkflowDefinition
  employees?: WorkflowExportEmployee[]
}

export type WorkflowCreateInput = Pick<WorkflowDefinition, 'name' | 'description' | 'nodes' | 'edges'> & {
  id?: string
  enabled?: boolean
  generationPrompt?: string
  permissionPolicy?: WorkflowPermissionPolicy
}

export type WorkflowUpdateInput = WorkflowCreateInput & { revision?: number }

export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled'
export type WorkflowNodeRunStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled'
/** Journal state for an operation that may have reached an external system. */
export type WorkflowNodeEffectState = 'none' | 'prepared' | 'dispatched' | 'confirmed' | 'unknown'

/** A persisted ownership lease for one locally claimed Workflow run. */
export interface WorkflowRunLease {
  ownerId: string
  claimedAt: string
  expiresAt: string
}

/** Durable local-queue metadata. It deliberately contains no process handles or secrets. */
export interface WorkflowRunQueueState {
  enqueuedAt: string
  availableAt: string
  lease?: WorkflowRunLease
  cancellationRequestedAt?: string
}

export interface WorkflowNodeRunState {
  nodeId: string
  status: WorkflowNodeRunStatus
  /** Number of attempts already started for this node. */
  attempt?: number
  /** Next retry eligibility timestamp, if a retry is waiting. */
  nextAttemptAt?: string
  /** An unknown effect is never replayed automatically. */
  effectState?: WorkflowNodeEffectState
  startedAt?: string
  completedAt?: string
  /** Elapsed execution time recorded in milliseconds. Older records omit this and render as 0. */
  elapsedMs?: number
  /** The resolved value passed into this node, retained for run inspection. */
  input?: WorkflowValue
  output?: WorkflowValue
  error?: string
}

export type WorkflowRunEventType = 'run-created' | 'run-started' | 'node-started' | 'node-retry' | 'node-effect-prepared' | 'node-effect-dispatched' | 'node-effect-confirmed' | 'node-completed' | 'node-skipped' | 'node-failed' | 'compensation-started' | 'compensation-completed' | 'compensation-failed' | 'approval-requested' | 'approval-resolved' | 'run-completed' | 'run-failed' | 'run-paused' | 'run-cancelled'

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
  /** Customer execution context; omitted for local ad-hoc runs. */
  environmentId?: string
  /** Immutable release that selected this run's workflow snapshot. */
  releaseId?: string
  /** Correlates this run with redacted operational observations. */
  traceId?: string
  /** Caller-supplied de-duplication key. Omitted runs are never inferred to be equivalent. */
  idempotencyKey?: string
  status: WorkflowRunStatus
  /** Present for records created by the durable local queue; legacy records remain readable. */
  queue?: WorkflowRunQueueState
  input: WorkflowValue
  output?: WorkflowValue
  nodeStates: WorkflowNodeRunState[]
  events: WorkflowRunEvent[]
  compensationStack?: WorkflowCompensationEntry[]
  allowShellFile: boolean
  /** Whether code nodes were explicitly authorized for this run. */
  allowCode?: boolean
  /** One-time connector grants captured at run creation. */
  connectorGrants?: WorkflowConnectorGrant[]
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
  /** Repeated starts with the same workflow revision and this explicit key return the original run. */
  idempotencyKey?: string
  allowShellFile?: boolean
  allowCode?: boolean
  connectorGrants?: WorkflowConnectorGrant[]
  debug?: boolean
  /** Optional model override; omitted to use the configured default model. */
  model?: WorkflowModelSelection
  /** Run an immutable saved workflow revision when supplied. */
  workflowRevision?: number
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
  /** Whether the generator may create missing employees for the workflow. Defaults to true. */
  createEmployees?: boolean
  /** Renderer-owned correlation ID used to stream progress into the generation page. */
  generationId?: string
  /** Optional model override; omitted means the configured workflow model. */
  model?: WorkflowModelSelection
}

/** Result of an AI workflow generation, including any employees created on the way. */
export interface WorkflowGenerateResult {
  workflow: WorkflowDefinition
  createdEmployees: EmployeeSnapshot[]
  /** Non-fatal warnings from the employee planning/creation phase. */
  employeeWarnings?: string[]
}

export interface WorkflowModifyRequest {
  /** The current unsaved or persisted definition being used as the modification baseline. */
  workflow: WorkflowDefinition
  prompt: string
  /** Renderer-owned correlation ID used to persist and stream this modification task. */
  modificationId?: string
  model?: WorkflowModelSelection
}

export type WorkflowModificationChangeType = 'added' | 'removed' | 'updated' | 'rewired'

export interface WorkflowModificationChange {
  type: WorkflowModificationChangeType
  targetId?: string
  targetLabel?: string
  details: string
}

export interface WorkflowModifyResult {
  workflow: WorkflowDefinition
  changes: WorkflowModificationChange[]
  removedNodes: Array<{ id: string; label: string }>
}

export const WORKFLOW_MODIFICATION_PHASES = ['preparing', 'analyzing', 'generating', 'validating', 'completed'] as const
export type WorkflowModificationPhase = (typeof WORKFLOW_MODIFICATION_PHASES)[number]
export type WorkflowModificationStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface WorkflowModificationProgress {
  phase: WorkflowModificationPhase | 'failed' | 'cancelled'
  status: WorkflowModificationStatus
  message: string
  time: string
}

export interface WorkflowModificationRecord {
  id: string
  workflowId: string
  workflowRevision: number
  prompt: string
  status: WorkflowModificationStatus
  phase: WorkflowModificationPhase | 'failed' | 'cancelled'
  model?: WorkflowModelSelection
  events: WorkflowModificationProgress[]
  workflow?: WorkflowDefinition
  changes: WorkflowModificationChange[]
  removedNodes: Array<{ id: string; label: string }>
  startedAt: string
  completedAt?: string
  error?: string
  /** Absolute path of the append-only diagnostic log for the task. */
  diagnosticLogPath?: string
}

export interface WorkflowModificationProgressUpdate {
  phase: WorkflowModificationPhase
  message: string
}

export const WORKFLOW_GENERATION_PHASES = ['preparing', 'planning-employees', 'creating-employees', 'generating-workflow', 'validating', 'completed'] as const
export type WorkflowGenerationPhase = (typeof WORKFLOW_GENERATION_PHASES)[number]
export type WorkflowGenerationStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** One durable progress event emitted by the fixed AI workflow generation pipeline. */
export interface WorkflowGenerationProgress {
  phase: WorkflowGenerationPhase | 'failed' | 'cancelled'
  status: WorkflowGenerationStatus
  message: string
  time: string
}

/** Persisted history entry for one AI-generated workflow draft. */
export interface WorkflowGenerationRecord {
  id: string
  prompt: string
  name: string
  status: WorkflowGenerationStatus
  phase: WorkflowGenerationPhase | 'failed' | 'cancelled'
  model?: WorkflowModelSelection
  createEmployees?: boolean
  events: WorkflowGenerationProgress[]
  workflow?: WorkflowDefinition
  createdEmployees: EmployeeSnapshot[]
  warnings?: string[]
  checkpoint?: WorkflowGenerationCheckpoint
  startedAt: string
  completedAt?: string
  error?: string
  /** Absolute path of the append-only diagnostic log for the task. */
  diagnosticLogPath?: string
}

export interface WorkflowGenerationProgressUpdate {
  phase: WorkflowGenerationPhase
  message: string
}

/** Durable state needed to continue an interrupted AI workflow generation. */
export interface WorkflowGenerationCheckpoint {
  /** The next generation phase that still needs to finish. */
  phase: WorkflowGenerationPhase
  /** Employees already created before the generation stopped. */
  createdEmployees: EmployeeSnapshot[]
  warnings: string[]
  /** Employee IDs already selected for the workflow prompt, when selection ran. */
  selectedEmployeeIds?: string[]
  /** Runtime session used by the generation conversation, when available. */
  sessionId?: string
  /** Last model response, retained only to repair a response after a retry. */
  lastModelOutput?: string
}

export interface WorkflowValidationIssue {
  path: string
  message: string
}

export interface WorkflowValidationResult {
  valid: boolean
  issues: WorkflowValidationIssue[]
}

/** Convert a low-level schema path into an actionable product-facing error. */
export function formatWorkflowValidationIssues(workflow: WorkflowDefinition, issues: WorkflowValidationIssue[], action: string): string {
  return issues.map((issue) => {
    const nodeMatch = issue.path.match(/^nodes\.(\d+)(?:\.|$)/u)
    const nodeIndex = nodeMatch?.[1] === undefined ? undefined : Number(nodeMatch[1])
    const node = nodeIndex === undefined ? undefined : workflow.nodes[nodeIndex]
    if (node !== undefined) return `Workflow「${workflow.name}」· ${action} · 节点「${node.label}」（类型：${node.type}，ID：${node.id}）· 配置路径：${issue.path} · ${issue.message}`
    const target = issue.path === '' ? '工作流文档' : `字段「${issue.path}」`
    return `Workflow「${workflow.name}」· ${action} · ${target} · ${issue.message}`
  }).join('\n')
}

export function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return (WORKFLOW_NODE_TYPES as readonly unknown[]).includes(value)
}

function normalizeWorkflowSourcePort(value: unknown): WorkflowEdge['sourcePort'] {
  if (value === 'true' || value === 'false' || value === 'default' || value === 'loop-body' || value === 'loop-next') return value
  return typeof value === 'string' && /^switch:[A-Za-z_][A-Za-z0-9_-]*$/u.test(value) ? value as `switch:${string}` : undefined
}

function isValidWorkflowSourcePort(value: unknown): boolean {
  return normalizeWorkflowSourcePort(value) !== undefined
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
      { id: inputId, type: 'input', label: '开始', config: { name: 'task' }, position: { x: 80, y: 180 } },
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
        inputBindings: [{ id: 'topic', name: 'topic', sourceNodeId: inputId, required: true }],
      },
      { id: outputId, type: 'output', label: '结束', config: { contentMode: 'variable' }, position: { x: 720, y: 180 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: aiTaskId, required: true }] },
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

function readInputFields(value: unknown): WorkflowInputField[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name.trim() === '') return []
    const type: WorkflowInputFieldType = item.type === 'number' || item.type === 'boolean' || item.type === 'json' || item.type === 'file' || item.type === 'file-list' ? item.type : 'string'
    return [{
      name: item.name.trim(),
      ...(typeof item.label === 'string' && item.label.trim() !== '' ? { label: item.label.trim() } : {}),
      type,
      required: item.required !== false,
      ...(isWorkflowValue(item.defaultValue) ? { defaultValue: item.defaultValue } : {}),
    }]
  })
}

function readInputBindings(value: unknown): WorkflowNodeInputBinding[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.sourceNodeId !== 'string') return []
    return [{
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `input-${index + 1}`,
      name: item.name,
      sourceNodeId: item.sourceNodeId,
      sourcePath: typeof item.sourcePath === 'string' && item.sourcePath !== '' ? item.sourcePath : undefined,
      required: item.required !== false,
      defaultValue: isWorkflowValue(item.defaultValue) ? item.defaultValue : undefined,
    }]
  })
}

function readOutputVariables(value: unknown): WorkflowNodeOutputVariable[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return []
    return [{ name: item.name, description: typeof item.description === 'string' && item.description !== '' ? item.description : undefined }]
  })
}

function readRetryPolicy(value: unknown): WorkflowRetryPolicy | undefined {
  if (!isRecord(value) || typeof value.maxAttempts !== 'number' || !Number.isInteger(value.maxAttempts)) return undefined
  const mode = value.mode === 'idempotent' || value.mode === 'deterministic' ? value.mode : undefined
  return {
    ...(mode === undefined ? {} : { mode }),
    maxAttempts: value.maxAttempts,
    ...(typeof value.initialDelayMs === 'number' ? { initialDelayMs: value.initialDelayMs } : {}),
    ...(typeof value.baseDelayMs === 'number' ? { baseDelayMs: value.baseDelayMs } : {}),
    ...(typeof value.maxDelayMs === 'number' ? { maxDelayMs: value.maxDelayMs } : {}),
    ...(typeof value.jitterRatio === 'number' ? { jitterRatio: value.jitterRatio } : {}),
  }
}

function readCompensation(value: unknown): WorkflowCompensationAction | undefined {
  if (!isRecord(value) || value.type !== 'workflow' || typeof value.workflowId !== 'string' || value.workflowId.trim() === '') return undefined
  return {
    type: 'workflow',
    workflowId: value.workflowId.trim(),
    ...(isWorkflowValue(value.input) ? { input: value.input } : {}),
    ...(value.waitForCompletion === false ? { waitForCompletion: false } : {}),
  }
}

function readConnectorOperations(value: unknown): WorkflowConnectorOperation[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is WorkflowConnectorOperation => item === 'read' || item === 'write'))]
}

function readPermissionPolicy(value: unknown): WorkflowPermissionPolicy | undefined {
  if (!isRecord(value) || !Array.isArray(value.connectors)) return undefined
  const connectors = value.connectors.flatMap((item) => {
    if (!isRecord(item) || typeof item.connectorId !== 'string' || item.connectorId.trim() === '') return []
    const operations = readConnectorOperations(item.operations)
    return operations.length === 0 ? [] : [{ connectorId: item.connectorId.trim(), operations }]
  })
  return connectors.length === 0 ? undefined : { connectors }
}

export function isWorkflowJsonSchema(value: unknown): value is WorkflowJsonSchema {
  if (!isRecord(value) || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type as string)) return false
  if (value.properties !== undefined && (!isRecord(value.properties) || Object.values(value.properties).some((item) => !isWorkflowJsonSchema(item)))) return false
  if (value.items !== undefined && !isWorkflowJsonSchema(value.items)) return false
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string'))) return false
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.some((item) => !isWorkflowValue(item)))) return false
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return false
  return true
}

function normalizeNodeType(value: unknown): WorkflowNodeType | undefined {
  if (value === 'agent') return 'ai-task'
  return isWorkflowNodeType(value) ? value : undefined
}

function readNodeConfig(type: WorkflowNodeType, value: unknown): Record<string, unknown> {
  const config = isRecord(value) ? value : {}
  switch (type) {
    case 'input': {
      const fields = readInputFields(config.fields)
      return {
        name: typeof config.name === 'string' ? config.name : undefined,
        defaultValue: isWorkflowValue(config.defaultValue) ? config.defaultValue : undefined,
        ...(fields === undefined ? {} : { fields }),
      }
    }
    case 'ai-task': return {
      instruction: typeof config.instruction === 'string' ? config.instruction : '',
      systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined,
      mode: config.mode === 'autonomous' ? 'autonomous' : 'single',
      skillIds: readStringArray(config.skillIds),
      outputMode: config.outputMode === 'json' ? 'json' : 'text',
      ...(isWorkflowJsonSchema(config.outputSchema) ? { outputSchema: config.outputSchema } : {}),
    }
    case 'structured-extract': return {
      schema: isWorkflowJsonSchema(config.schema) ? config.schema : { type: 'object', properties: {} },
      ...(typeof config.maxRetries === 'number' ? { maxRetries: config.maxRetries } : {}),
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
    case 'sub-workflow': return {
      workflowId: typeof config.workflowId === 'string' ? config.workflowId : '',
      waitForCompletion: config.waitForCompletion !== false,
      ...(isRecord(config.inputMapping) && isWorkflowValue(config.inputMapping) ? { inputMapping: config.inputMapping as Record<string, WorkflowValue> } : {}),
      ...(config.version === 'latest' || (typeof config.version === 'number' && Number.isInteger(config.version) && config.version > 0) ? { version: config.version } : {}),
    }
    case 'parallel': return { instructions: Array.isArray(config.instructions) ? config.instructions.filter((item): item is string => typeof item === 'string') : [] }
    case 'loop': return {
      instruction: typeof config.instruction === 'string' ? config.instruction : undefined,
      maxIterations: typeof config.maxIterations === 'number' ? config.maxIterations : undefined,
      ...(typeof config.concurrency === 'number' ? { concurrency: config.concurrency } : {}),
      ...(typeof config.batchSize === 'number' ? { batchSize: config.batchSize } : {}),
      ...(config.failureStrategy === 'continue' || config.failureStrategy === 'stop' ? { failureStrategy: config.failureStrategy } : {}),
    }
    case 'sleep': return {
      durationMs: typeof config.durationMs === 'number' ? config.durationMs : 0,
      ...(config.mode === 'random' || config.mode === 'fixed' ? { mode: config.mode } : {}),
      ...(typeof config.minDurationMs === 'number' ? { minDurationMs: config.minDurationMs } : {}),
      ...(typeof config.maxDurationMs === 'number' ? { maxDurationMs: config.maxDurationMs } : {}),
    }
    case 'condition': return { operator: config.operator, value: isWorkflowValue(config.value) ? config.value : undefined }
    case 'switch': return {
      cases: Array.isArray(config.cases)
        ? config.cases.flatMap((candidate) => {
          if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isWorkflowValue(candidate.value)) return []
          return [{ id: candidate.id, label: typeof candidate.label === 'string' ? candidate.label : undefined, value: candidate.value }]
        })
        : [],
    }
    case 'approval': return { message: typeof config.message === 'string' ? config.message : '' }
    case 'wait-input': return {
      mode: config.mode === 'form' ? 'form' : 'approval',
      message: typeof config.message === 'string' ? config.message : '',
      ...(readInputFields(config.fields) === undefined ? {} : { fields: readInputFields(config.fields) }),
    }
    case 'transform': return {
      template: config.template,
      text: typeof config.text === 'string' ? config.text : undefined,
      find: typeof config.find === 'string' ? config.find : undefined,
      replacement: typeof config.replacement === 'string' ? config.replacement : undefined,
    }
    case 'object-builder': return { fields: isRecord(config.fields) && isWorkflowValue(config.fields) ? config.fields as Record<string, WorkflowValue> : {} }
    case 'list-operator': return {
      operation: ['filter', 'map', 'pluck', 'sort', 'dedupe', 'slice', 'group', 'aggregate'].includes(config.operation as string) ? config.operation : 'filter',
      path: typeof config.path === 'string' ? config.path : undefined,
      value: isWorkflowValue(config.value) ? config.value : undefined,
      descending: config.descending === true,
      start: typeof config.start === 'number' ? config.start : undefined,
      end: typeof config.end === 'number' ? config.end : undefined,
      outputPath: typeof config.outputPath === 'string' ? config.outputPath : undefined,
      groupPath: typeof config.groupPath === 'string' ? config.groupPath : undefined,
      aggregateMode: ['count', 'sum', 'average', 'min', 'max'].includes(config.aggregateMode as string) ? config.aggregateMode : undefined,
      aggregatePath: typeof config.aggregatePath === 'string' ? config.aggregatePath : undefined,
    }
    case 'merge': return {
      operation: ['append', 'object-merge', 'join', 'zip', 'first-non-null'].includes(config.operation as string) ? config.operation : 'append',
      leftKey: typeof config.leftKey === 'string' ? config.leftKey : undefined,
      rightKey: typeof config.rightKey === 'string' ? config.rightKey : undefined,
    }
    case 'text-merge': return { template: typeof config.template === 'string' ? config.template : '', separator: typeof config.separator === 'string' ? config.separator : undefined }
    case 'output': return {
      label: typeof config.label === 'string' ? config.label : undefined,
      contentMode: config.contentMode === 'text' ? 'text' : 'variable',
      text: typeof config.text === 'string' ? config.text : undefined,
    }
    case 'shell': return { command: typeof config.command === 'string' ? config.command : '', args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [], cwd: typeof config.cwd === 'string' ? config.cwd : undefined, timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined }
    case 'file': return { operation: ['read', 'write', 'list', 'stat', 'extract-text'].includes(config.operation as string) ? config.operation : 'read', path: typeof config.path === 'string' ? config.path : '', content: typeof config.content === 'string' ? config.content : undefined, recursive: config.recursive === true }
    case 'http': return {
      method: config.method === 'POST' || config.method === 'PUT' || config.method === 'PATCH' || config.method === 'DELETE' ? config.method : 'GET',
      url: typeof config.url === 'string' ? config.url : '',
      ...(typeof config.connectorId === 'string' && config.connectorId.trim() !== '' ? { connectorId: config.connectorId.trim() } : {}),
      ...(typeof config.connectorPath === 'string' && config.connectorPath.trim() !== '' ? { connectorPath: config.connectorPath.trim() } : {}),
      headers: isRecord(config.headers) ? Object.fromEntries(Object.entries(config.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
      query: isRecord(config.query) && isWorkflowValue(config.query) ? config.query as Record<string, WorkflowValue> : undefined,
      body: isWorkflowValue(config.body) ? config.body : undefined,
      responseMode: config.responseMode === 'json' || config.responseMode === 'text' ? config.responseMode : 'auto',
      timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
    }
    case 'code': return {
      language: config.language === 'python3' ? 'python3' : 'nodejs',
      code: typeof config.code === 'string' ? config.code : '',
      timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : undefined,
    }
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
    const inputBindings = readInputBindings(rawNode.inputBindings)
    const outputVariables = readOutputVariables(rawNode.outputVariables)
    const retryPolicy = readRetryPolicy(rawNode.retryPolicy)
    const compensation = readCompensation(rawNode.compensation)
    nodes.push({
      id: rawNode.id,
      type,
      label: legacyAgent && (rawLabel === '' || rawLabel === 'Agent') ? '智能处理' : rawLabel || type,
      ...(typeof rawNode.description === 'string' ? { description: rawNode.description } : {}),
      config: readNodeConfig(type, rawNode.config) as never,
      position: readPosition(rawNode.position),
      ...(retryPolicy === undefined ? {} : { retryPolicy }),
      ...(compensation === undefined ? {} : { compensation }),
      ...(inputBindings === undefined ? {} : { inputBindings }),
      ...(outputVariables === undefined ? {} : { outputVariables }),
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
      sourcePort: normalizeWorkflowSourcePort(rawEdge.sourcePort),
      targetPort: typeof rawEdge.targetPort === 'string' ? rawEdge.targetPort : undefined,
    })
  }
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now()
  const permissionPolicy = readPermissionPolicy(raw.permissionPolicy)
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
    ...(typeof raw.generationPrompt === 'string' && raw.generationPrompt.trim() !== '' ? { generationPrompt: raw.generationPrompt.trim() } : {}),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
  }
}

/** Create the canonical JSON envelope used by the workflow editor's export action. */
export function createWorkflowExportDocument(workflow: WorkflowDefinition, exportedAt = new Date().toISOString(), employees: readonly EmployeeSnapshot[] = []): WorkflowExportDocument {
  const referencedEmployeeIds = new Set(workflow.nodes.flatMap((node) => node.type === 'employee' && node.config.employeeId.trim() !== '' ? [node.config.employeeId] : []))
  const bundledEmployees = employees
    .filter((employee) => referencedEmployeeIds.has(employee.id))
    .map(({ id, displayName, name, role, description, businessBoundary, systemPrompt, operatingGuidelines, qualityStandards, capabilities, skillIds, enabled }) => ({
      id,
      ...(displayName === undefined || displayName.trim() === '' ? {} : { displayName }),
      name,
      role,
      description,
      businessBoundary,
      systemPrompt,
      operatingGuidelines: [...operatingGuidelines],
      qualityStandards: [...qualityStandards],
      capabilities: [...capabilities],
      skillIds: [...skillIds],
      enabled,
    }))
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    formatVersion: WORKFLOW_EXPORT_FORMAT_VERSION,
    exportedAt,
    workflow: cloneWorkflow(workflow),
    ...(bundledEmployees.length === 0 ? {} : { employees: bundledEmployees }),
  }
}

function parseWorkflowExportEmployees(value: unknown): WorkflowExportEmployee[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Workflow 文件的 employees 必须是数组。')
  const ids = new Set<string>()
  return value.map((rawEmployee, index) => {
    if (!isRecord(rawEmployee)) throw new Error(`Workflow 文件的 employees.${index} 不是有效的员工档案。`)
    const requiredTextFields = ['id', 'name', 'role', 'systemPrompt'] as const
    for (const field of requiredTextFields) {
      if (typeof rawEmployee[field] !== 'string' || rawEmployee[field].trim() === '') throw new Error(`Workflow 文件的 employees.${index}.${field} 不能为空。`)
    }
    if (typeof rawEmployee.description !== 'string' || typeof rawEmployee.businessBoundary !== 'string') throw new Error(`Workflow 文件的 employees.${index}.description 或 businessBoundary 无效。`)
    const employeeId = rawEmployee.id as string
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(employeeId)) throw new Error(`Workflow 文件的 employees.${index}.id 无效。`)
    if (ids.has(employeeId)) throw new Error(`Workflow 文件的 employees.${index}.id 重复。`)
    ids.add(employeeId)
    const operatingGuidelines = rawEmployee.operatingGuidelines
    const qualityStandards = rawEmployee.qualityStandards
    const capabilities = rawEmployee.capabilities
    const skillIds = rawEmployee.skillIds
    if (!Array.isArray(operatingGuidelines) || operatingGuidelines.some((item) => typeof item !== 'string')) throw new Error(`Workflow 文件的 employees.${index}.operatingGuidelines 无效。`)
    if (!Array.isArray(qualityStandards) || qualityStandards.some((item) => typeof item !== 'string')) throw new Error(`Workflow 文件的 employees.${index}.qualityStandards 无效。`)
    if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string' || !(EMPLOYEE_CAPABILITIES as readonly string[]).includes(item))) throw new Error(`Workflow 文件的 employees.${index}.capabilities 无效。`)
    if (!Array.isArray(skillIds) || skillIds.some((item) => typeof item !== 'string')) throw new Error(`Workflow 文件的 employees.${index}.skillIds 无效。`)
    if (typeof rawEmployee.enabled !== 'boolean') throw new Error(`Workflow 文件的 employees.${index}.enabled 无效。`)
    return {
      id: employeeId,
      ...(typeof rawEmployee.displayName === 'string' && rawEmployee.displayName.trim() !== '' ? { displayName: rawEmployee.displayName.trim() } : {}),
      name: rawEmployee.name as string,
      role: rawEmployee.role as string,
      description: rawEmployee.description as string,
      businessBoundary: rawEmployee.businessBoundary as string,
      systemPrompt: rawEmployee.systemPrompt as string,
      operatingGuidelines: [...operatingGuidelines] as string[],
      qualityStandards: [...qualityStandards] as string[],
      capabilities: [...capabilities] as WorkflowExportEmployee['capabilities'],
      skillIds: [...skillIds] as string[],
      enabled: rawEmployee.enabled,
    }
  })
}

/** Parse and validate a canonical workflow export before it is persisted. */
export function parseWorkflowExportDocument(raw: unknown): WorkflowExportDocument {
  if (!isRecord(raw)) throw new Error('Workflow JSON 必须是对象。')
  if (raw.format !== WORKFLOW_EXPORT_FORMAT) throw new Error(`Workflow JSON 的 format 无效，应为「${WORKFLOW_EXPORT_FORMAT}」。`)
  if (raw.formatVersion !== WORKFLOW_EXPORT_FORMAT_VERSION) throw new Error(`不支持的 Workflow 文件版本：${String(raw.formatVersion)}。`)
  if (typeof raw.exportedAt !== 'string' || Number.isNaN(Date.parse(raw.exportedAt))) throw new Error('Workflow 文件缺少有效的 exportedAt 时间。')
  if (!isRecord(raw.workflow) || raw.workflow.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new Error(`不支持的 Workflow Schema 版本，应为 ${WORKFLOW_SCHEMA_VERSION}。`)
  const rawNodes = raw.workflow.nodes
  const rawEdges = raw.workflow.edges
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw new Error('Workflow 文件必须包含 nodes 和 edges 数组。')
  rawNodes.forEach((rawNode, index) => {
    if (!isRecord(rawNode) || typeof rawNode.id !== 'string' || !isWorkflowNodeType(rawNode.type)) throw new Error(`Workflow 文件的 nodes.${index} 不是有效的 Schema V2 节点。`)
    if (!isRecord(rawNode.config) || !isRecord(rawNode.position) || typeof rawNode.position.x !== 'number' || !Number.isFinite(rawNode.position.x) || typeof rawNode.position.y !== 'number' || !Number.isFinite(rawNode.position.y)) throw new Error(`Workflow 文件的 nodes.${index} 缺少有效的 config 或 position。`)
  })
  rawEdges.forEach((rawEdge, index) => {
    if (!isRecord(rawEdge) || typeof rawEdge.id !== 'string' || typeof rawEdge.source !== 'string' || typeof rawEdge.target !== 'string') throw new Error(`Workflow 文件的 edges.${index} 不是有效的连线。`)
    if (rawEdge.sourcePort !== undefined && !isValidWorkflowSourcePort(rawEdge.sourcePort)) throw new Error(`Workflow 文件的 edges.${index}.sourcePort 无效。`)
    if (rawEdge.targetPort !== undefined && typeof rawEdge.targetPort !== 'string') throw new Error(`Workflow 文件的 edges.${index}.targetPort 无效。`)
  })
  const workflow = normalizeWorkflow(raw.workflow)
  if (workflow === undefined) throw new Error('Workflow 文件缺少有效的 workflow、nodes 或 edges 字段。')
  if (workflow.nodes.length !== rawNodes.length || workflow.edges.length !== rawEdges.length) throw new Error('Workflow 文件包含无法解析的节点或连线，未导入任何内容。')
  const result = validateWorkflow(workflow)
  if (!result.valid) throw new Error(formatWorkflowValidationIssues(workflow, result.issues, '导入工作流'))
  const employees = parseWorkflowExportEmployees(raw.employees)
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    formatVersion: WORKFLOW_EXPORT_FORMAT_VERSION,
    exportedAt: raw.exportedAt,
    workflow,
    ...(employees.length === 0 ? {} : { employees }),
  }
}

/** Validate a workflow before it enters persistence or execution. */
export function validateWorkflow(workflow: WorkflowDefinition): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []
  if (workflow.schemaVersion !== WORKFLOW_SCHEMA_VERSION) issues.push({ path: 'schemaVersion', message: '不支持的 Workflow Schema 版本。' })
  if (workflow.name.trim() === '') issues.push({ path: 'name', message: '工作流名称不能为空。' })
  if (workflow.name.length > 120) issues.push({ path: 'name', message: '工作流名称不能超过 120 个字符。' })
  const connectorPermissionIds = new Set<string>()
  for (const [index, permission] of (workflow.permissionPolicy?.connectors ?? []).entries()) {
    const connectorId = permission.connectorId.trim()
    if (connectorId === '') issues.push({ path: `permissionPolicy.connectors.${index}.connectorId`, message: '连接器 ID 不能为空。' })
    if (connectorPermissionIds.has(connectorId)) issues.push({ path: `permissionPolicy.connectors.${index}.connectorId`, message: '连接器权限不能重复声明。' })
    connectorPermissionIds.add(connectorId)
    const operations = permission.operations
    if (operations.length === 0 || operations.some((operation) => operation !== 'read' && operation !== 'write') || new Set(operations).size !== operations.length) issues.push({ path: `permissionPolicy.connectors.${index}.operations`, message: '连接器权限必须声明不重复的 read 或 write。' })
  }

  const nodeIds = new Set<string>()
  for (const [index, node] of workflow.nodes.entries()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(node.id)) issues.push({ path: `nodes.${index}.id`, message: '节点 ID 只能包含字母、数字、点、下划线和短横线。' })
    if (nodeIds.has(node.id)) issues.push({ path: `nodes.${index}.id`, message: '节点 ID 重复。' })
    nodeIds.add(node.id)
    if (node.label.trim() === '') issues.push({ path: `nodes.${index}.label`, message: '节点名称不能为空。' })
    validateNodeBindings(node, `nodes.${index}`, issues)
    validateNodeConfig(node, `nodes.${index}.config`, issues)
  }

  const startNodeCount = workflow.nodes.filter((node) => node.type === 'input').length
  const endNodeCount = workflow.nodes.filter((node) => node.type === 'output').length
  if (startNodeCount === 0) issues.push({ path: 'nodes', message: '工作流必须包含固定的开始节点。' })
  else if (startNodeCount > 1) issues.push({ path: 'nodes', message: '工作流只能包含一个开始节点。' })
  if (endNodeCount === 0) issues.push({ path: 'nodes', message: '工作流必须包含固定的结束节点。' })
  else if (endNodeCount > 1) issues.push({ path: 'nodes', message: '工作流只能包含一个结束节点。' })

  for (const [index, node] of workflow.nodes.entries()) {
    if (node.type === 'switch') {
      const caseIds = new Set<string>()
      if (node.config.cases.length === 0) issues.push({ path: `nodes.${index}.config.cases`, message: 'Switch 至少需要一个 case。' })
      for (const [caseIndex, entry] of node.config.cases.entries()) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(entry.id)) issues.push({ path: `nodes.${index}.config.cases.${caseIndex}.id`, message: 'Switch case ID 只能使用字母、数字、下划线和短横线，且不能以数字开头。' })
        if (entry.id === 'default' || entry.id === 'switch-default' || entry.id === '__default__') issues.push({ path: `nodes.${index}.config.cases.${caseIndex}.id`, message: 'Switch case ID 不能使用保留名称 default。' })
        if (caseIds.has(entry.id)) issues.push({ path: `nodes.${index}.config.cases.${caseIndex}.id`, message: 'Switch case ID 不能重复。' })
        caseIds.add(entry.id)
      }
      const outgoing = workflow.edges.filter((edge) => edge.source === node.id)
      const defaultEdges = outgoing.filter((edge) => edge.sourcePort === 'default')
      if (defaultEdges.length !== 1) issues.push({ path: `nodes.${index}.config`, message: 'Switch 必须连接一条 default 默认分支。' })
      for (const caseId of caseIds) {
        const edges = outgoing.filter((edge) => edge.sourcePort === `switch:${caseId}`)
        if (edges.length !== 1) issues.push({ path: `nodes.${index}.config`, message: `Switch case「${caseId}」必须连接且只能连接一条分支。` })
      }
      if (outgoing.some((edge) => edge.sourcePort === undefined || (edge.sourcePort !== 'default' && (!/^switch:[A-Za-z_][A-Za-z0-9_-]*$/u.test(edge.sourcePort) || !caseIds.has(edge.sourcePort.replace(/^switch:/u, '')))))) issues.push({ path: `nodes.${index}.config`, message: 'Switch 存在未声明的 case 分支或未标记端口。' })
    }
    for (const [bindingIndex, binding] of (node.inputBindings ?? []).entries()) {
      if (!nodeIds.has(binding.sourceNodeId)) issues.push({ path: `nodes.${index}.inputBindings.${bindingIndex}.sourceNodeId`, message: '输入变量必须引用现有节点。' })
      if (binding.sourceNodeId === node.id) issues.push({ path: `nodes.${index}.inputBindings.${bindingIndex}.sourceNodeId`, message: '节点不能引用自己的输出。' })
    }
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
  for (const node of workflow.nodes) {
    for (const binding of node.inputBindings ?? []) {
      const targets = adjacency.get(binding.sourceNodeId) ?? []
      targets.push(node.id)
      adjacency.set(binding.sourceNodeId, targets)
    }
  }

  for (const [index, node] of workflow.nodes.entries()) {
    if (node.type !== 'loop') continue
    const outgoing = workflow.edges.filter((edge) => edge.source === node.id)
    const bodyEdges = outgoing.filter((edge) => edge.sourcePort === 'loop-body')
    const nextEdges = outgoing.filter((edge) => edge.sourcePort === 'loop-next' || edge.sourcePort === undefined || edge.sourcePort === 'default')
    if (bodyEdges.length === 0) {
      if ((node.config.instruction ?? '').trim() === '') issues.push({ path: `nodes.${index}.config`, message: '循环节点必须连接一个下方的循环体节点。' })
      continue
    }
    if (bodyEdges.length !== 1) issues.push({ path: `nodes.${index}.config`, message: '循环节点只能连接一个下方的循环体节点。' })
    if (nextEdges.length !== 1) issues.push({ path: `nodes.${index}.config`, message: '循环节点必须连接一个右侧的后续节点。' })
    const bodyTarget = bodyEdges[0]?.target
    if (bodyTarget === undefined) continue
    const bodyNode = workflow.nodes.find((candidate) => candidate.id === bodyTarget)
    if (bodyNode?.type === 'input' || bodyNode?.type === 'output' || bodyNode?.type === 'loop') issues.push({ path: `nodes.${index}.config`, message: '循环体必须是可执行的普通节点，不能是开始、结束或另一个循环节点。' })
    const bodyChain = workflowLoopBodyNodeIds(workflow, node.id)
    if (bodyChain.length === 0) continue
    const bodyChainSet = new Set(bodyChain)
    if (bodyChain.some((bodyNodeId) => ['input', 'output', 'loop'].includes(workflow.nodes.find((candidate) => candidate.id === bodyNodeId)?.type ?? ''))) issues.push({ path: `nodes.${index}.config`, message: '循环体必须是可执行的普通节点，不能包含开始、结束或另一个循环节点。' })
    if (workflow.edges.some((edge) => bodyChainSet.has(edge.source) && workflow.edges.filter((candidate) => candidate.source === edge.source).length > 1)) issues.push({ path: `nodes.${index}.config`, message: '循环体子流程必须是一条线性节点链，不能分支。' })
    if (workflow.edges.some((edge) => bodyChainSet.has(edge.target) && edge.source !== node.id && !bodyChainSet.has(edge.source))) issues.push({ path: `nodes.${index}.config`, message: '循环体节点只能从循环体链路接收控制流，不能接入外部节点。' })
    if (workflow.nodes.some((candidate) => candidate.inputBindings?.some((binding) => bodyChainSet.has(binding.sourceNodeId) && !bodyChainSet.has(candidate.id)))) issues.push({ path: `nodes.${index}.config`, message: '循环体结果不能被其他节点直接绑定；请使用循环节点右侧的结果数组。' })
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

function validateNodeBindings(node: WorkflowNode, path: string, issues: WorkflowValidationIssue[]): void {
  const names = new Set<string>()
  for (const [index, binding] of (node.inputBindings ?? []).entries()) {
    const bindingPath = `${path}.inputBindings.${index}`
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(binding.name)) issues.push({ path: `${bindingPath}.name`, message: '输入变量名只能使用字母、数字和下划线，且不能以数字开头。' })
    if (names.has(binding.name)) issues.push({ path: `${bindingPath}.name`, message: '输入变量名不能重复。' })
    names.add(binding.name)
    if (binding.sourcePath !== undefined && !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/u.test(binding.sourcePath)) issues.push({ path: `${bindingPath}.sourcePath`, message: '输出字段路径只能使用点号分隔的字母、数字和下划线。' })
  }
  const outputNames = new Set<string>(['result'])
  for (const [index, output] of (node.outputVariables ?? []).entries()) {
    const outputPath = `${path}.outputVariables.${index}.name`
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(output.name)) issues.push({ path: outputPath, message: '输出变量名只能使用字母、数字和下划线，且不能以数字开头。' })
    if (outputNames.has(output.name)) issues.push({ path: outputPath, message: '输出变量名不能重复，也不能覆盖 result。' })
    outputNames.add(output.name)
  }
}

/** Explicit variable references add an execution dependency even without a visible control-flow edge. */
export function workflowNodeDependencyIds(workflow: WorkflowDefinition, node: WorkflowNode): string[] {
  return [...new Set([
    ...workflow.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source),
    ...(node.inputBindings ?? []).map((binding) => binding.sourceNodeId),
  ])]
}

/** Return the linear node chain connected to a loop's downward body port. */
export function workflowLoopBodyNodeIds(workflow: WorkflowDefinition, loopNodeId: string): string[] {
  const first = workflow.edges.find((edge) => edge.source === loopNodeId && edge.sourcePort === 'loop-body')
  if (first === undefined) return []
  const nodeIds: string[] = []
  const visited = new Set<string>()
  let current = first.target
  while (!visited.has(current)) {
    visited.add(current)
    nodeIds.push(current)
    const outgoing = workflow.edges.filter((edge) => edge.source === current)
    if (outgoing.length !== 1) break
    current = outgoing[0]!.target
  }
  return nodeIds
}

/** Resolve a dotted field path from a JSON-compatible workflow value. */
export function resolveWorkflowValuePath(value: WorkflowValue, path?: string): WorkflowValue | undefined {
  if (path === undefined || path === '') return value
  let current: WorkflowValue | undefined = value
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(part)
      current = Number.isInteger(index) && index >= 0 ? current[index] : undefined
    } else if (current !== null && typeof current === 'object') {
      current = current[part]
    } else {
      current = undefined
    }
    if (current === undefined) return undefined
  }
  return current
}

function renderWorkflowVariable(value: WorkflowValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Interpolate only a node's declared input variables, including nested JSON fields. */
export function interpolateWorkflowVariables(template: string, variables: Record<string, WorkflowValue>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/gu, (token, path: string) => {
    const [name, ...parts] = path.split('.')
    const root = name === undefined ? undefined : variables[name]
    const value = root === undefined ? undefined : resolveWorkflowValuePath(root, parts.join('.'))
    return value === undefined ? token : renderWorkflowVariable(value)
  })
}

function validateNodeConfig(node: WorkflowNode, path: string, issues: WorkflowValidationIssue[]): void {
  const add = (message: string, field?: string): void => { issues.push({ path: field === undefined ? path : `${path}.${field}`, message }) }
  if (node.retryPolicy !== undefined) {
    const policy = node.retryPolicy
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) add('重试总次数必须是 1 到 10 的整数。', 'retryPolicy.maxAttempts')
    if (policy.baseDelayMs !== undefined && (!Number.isInteger(policy.baseDelayMs) || policy.baseDelayMs < 0 || policy.baseDelayMs > 600_000)) add('重试基础等待必须是 0 到 600000 的整数毫秒。', 'retryPolicy.baseDelayMs')
    if (policy.maxDelayMs !== undefined && (!Number.isInteger(policy.maxDelayMs) || policy.maxDelayMs < 0 || policy.maxDelayMs > 600_000)) add('重试最大等待必须是 0 到 600000 的整数毫秒。', 'retryPolicy.maxDelayMs')
    if (policy.baseDelayMs !== undefined && policy.maxDelayMs !== undefined && policy.baseDelayMs > policy.maxDelayMs) add('重试基础等待不能大于最大等待。', 'retryPolicy.maxDelayMs')
    if (policy.jitterRatio !== undefined && (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1)) add('重试抖动比例必须在 0 到 1 之间。', 'retryPolicy.jitterRatio')
    const deterministic = new Set<WorkflowNodeType>(['ai-task', 'structured-extract', 'parallel', 'loop', 'sleep', 'condition', 'switch', 'transform', 'text-merge', 'object-builder', 'list-operator', 'merge', 'output'])
    if (!deterministic.has(node.type) && policy.mode !== 'idempotent') add('带外部副作用的节点只能声明 idempotent 重试模式。', 'retryPolicy.mode')
  }
  if (node.compensation !== undefined) {
    if (node.compensation.type !== 'workflow' || typeof node.compensation.workflowId !== 'string' || node.compensation.workflowId.trim() === '') add('补偿动作需要有效的 Workflow ID。', 'compensation.workflowId')
    if (node.compensation.input !== undefined && !isWorkflowValue(node.compensation.input)) add('补偿输入必须是 JSON 兼容值。', 'compensation.input')
    const canProduceExternalEffect = node.type === 'file'
      ? node.config.operation === 'write'
      : node.type === 'http'
        ? node.config.method !== 'GET'
        : ['mcp', 'shell', 'code', 'employee', 'skill', 'sub-workflow'].includes(node.type)
    if (!canProduceExternalEffect) add('补偿动作只能附加到可能产生外部副作用的节点。', 'compensation')
  }
  switch (node.type) {
    case 'ai-task':
      if (node.config.instruction.trim() === '') add('智能处理指令不能为空。', 'instruction')
      if (node.config.mode !== 'single' && node.config.mode !== 'autonomous') add('智能处理执行模式无效。', 'mode')
      if (node.config.outputMode !== 'text' && node.config.outputMode !== 'json') add('智能处理输出格式无效。', 'outputMode')
      if (node.config.outputSchema !== undefined && (!isWorkflowJsonSchema(node.config.outputSchema) || node.config.outputMode !== 'json')) add('智能处理输出 Schema 必须是有效 JSON Schema，且只能用于 JSON 输出。', 'outputSchema')
      if (node.config.skillIds.some((id) => id.trim() === '' || /\s/u.test(id))) add('技能 ID 不能为空或包含空格。', 'skillIds')
      break
    case 'structured-extract':
      if (!isWorkflowJsonSchema(node.config.schema)) add('结构化提取节点需要有效 JSON Schema。', 'schema')
      if (node.config.maxRetries !== undefined && (!Number.isInteger(node.config.maxRetries) || node.config.maxRetries < 0 || node.config.maxRetries > 5)) add('结构化提取重试次数必须是 0 到 5 的整数。', 'maxRetries')
      break
    case 'employee':
      if (node.config.employeeId.trim() === '' || /\s/u.test(node.config.employeeId)) add('专业员工节点需要有效的员工 ID。', 'employeeId')
      if (node.config.instruction.trim() === '') add('专业员工节点指令不能为空。', 'instruction')
      if (node.config.outputMode !== 'text' && node.config.outputMode !== 'json') add('专业员工输出格式无效。', 'outputMode')
      break
    case 'skill':
      if (node.config.skillId.trim() === '') add('Skill 节点需要 skill ID。', 'skillId')
      if (node.config.instruction.trim() === '') add('Skill 节点需要指令。', 'instruction')
      break
    case 'mcp':
      if (node.config.tool.trim() === '') add('MCP 节点需要工具名。', 'tool')
      if (node.config.arguments !== undefined && !isWorkflowValue(node.config.arguments)) add('MCP 参数必须是 JSON 兼容对象。', 'arguments')
      break
    case 'sub-workflow':
      if (node.config.workflowId.trim() === '') add('子工作流节点需要工作流 ID。', 'workflowId')
      if (node.config.inputMapping !== undefined && !isWorkflowValue(node.config.inputMapping)) add('子工作流输入映射必须是 JSON 兼容对象。', 'inputMapping')
      if (node.config.version !== undefined && node.config.version !== 'latest' && (!Number.isInteger(node.config.version) || node.config.version < 1)) add('子工作流版本必须是正整数或 latest。', 'version')
      break
    case 'parallel': if (node.config.instructions.length === 0 || node.config.instructions.some((instruction) => instruction.trim() === '')) add('并行处理节点至少需要一条非空指令。', 'instructions'); break
    case 'loop': {
      if (node.config.maxIterations !== undefined && (!Number.isInteger(node.config.maxIterations) || node.config.maxIterations < 1 || node.config.maxIterations > 100)) add('循环遍历最大迭代次数必须是 1 到 100。', 'maxIterations')
      if (node.config.concurrency !== undefined && (!Number.isInteger(node.config.concurrency) || node.config.concurrency < 1 || node.config.concurrency > 32)) add('循环并发数必须是 1 到 32 的整数。', 'concurrency')
      if (node.config.batchSize !== undefined && (!Number.isInteger(node.config.batchSize) || node.config.batchSize < 1 || node.config.batchSize > 1000)) add('循环批大小必须是 1 到 1000 的整数。', 'batchSize')
      if (node.config.failureStrategy !== undefined && node.config.failureStrategy !== 'stop' && node.config.failureStrategy !== 'continue') add('循环失败策略无效。', 'failureStrategy')
      break
    }
    case 'sleep': {
      if (node.config.mode !== undefined && node.config.mode !== 'fixed' && node.config.mode !== 'random') add('Sleep 模式必须是 fixed 或 random。', 'mode')
      if (!Number.isInteger(node.config.durationMs) || node.config.durationMs < 0 || node.config.durationMs > 600_000) add('Sleep 固定时长必须是 0 到 600000 之间的整数毫秒。', 'durationMs')
      if (node.config.mode === 'random') {
        const minDurationMs = node.config.minDurationMs ?? -1
        const maxDurationMs = node.config.maxDurationMs ?? -1
        if (!Number.isInteger(minDurationMs) || minDurationMs < 0 || minDurationMs > 600_000) add('Sleep 随机最小时长必须是 0 到 600000 之间的整数毫秒。', 'minDurationMs')
        if (!Number.isInteger(maxDurationMs) || maxDurationMs < 0 || maxDurationMs > 600_000) add('Sleep 随机最大时长必须是 0 到 600000 之间的整数毫秒。', 'maxDurationMs')
        if (Number.isInteger(minDurationMs) && Number.isInteger(maxDurationMs) && minDurationMs > maxDurationMs) add('Sleep 随机最小时长不能大于最大时长。', 'minDurationMs')
      }
      break
    }
    case 'condition': if (!['truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'].includes(node.config.operator)) add('条件判断操作符无效。', 'operator'); break
    case 'switch': break
    case 'approval': if (node.config.message.trim() === '') add('人工审批节点需要审批提示。', 'message'); break
    case 'wait-input':
      if (node.config.message.trim() === '') add('等待输入节点需要提示。', 'message')
      if (node.config.mode !== 'approval' && node.config.mode !== 'form') add('等待输入模式无效。', 'mode')
      break
    case 'transform': if (!['identity', 'json', 'extract-text', 'prepend', 'append', 'replace', 'text'].includes(node.config.template)) add('数据转换模板无效。', 'template'); break
    case 'text-merge': if (node.config.template.trim() === '' && node.config.separator === undefined) add('文本合并节点需要模板或分隔符。', 'template'); break
    case 'object-builder':
      if (Object.keys(node.config.fields).length === 0) add('变量组装节点至少需要一个字段。', 'fields')
      break
    case 'list-operator':
      if (!['filter', 'map', 'pluck', 'sort', 'dedupe', 'slice', 'group', 'aggregate'].includes(node.config.operation)) add('列表处理操作无效。', 'operation')
      if (node.config.operation === 'slice' && (node.config.start !== undefined && !Number.isInteger(node.config.start) || node.config.end !== undefined && !Number.isInteger(node.config.end))) add('列表截取边界必须是整数。', 'start')
      break
    case 'merge': if (!['append', 'object-merge', 'join', 'zip', 'first-non-null'].includes(node.config.operation)) add('数据合并操作无效。', 'operation'); break
    case 'shell':
      if (node.config.command.trim() === '') add('Shell 命令不能为空。', 'command')
      if (/[[\]{}();|&<>`$\\]/u.test(node.config.command)) add('Shell 命令包含不允许的控制字符；执行使用 shell:false。', 'command')
      if (node.config.args.some((arg) => /[\r\n]/u.test(arg))) add('Shell 参数不能包含换行。', 'args')
      break
    case 'file':
      if (node.config.path.trim() === '' || node.config.path.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(node.config.path)) add('File 路径必须是 Workflow 工作目录内的相对路径。', 'path')
      if (!['read', 'write', 'list', 'stat', 'extract-text'].includes(node.config.operation)) add('File 操作无效。', 'operation')
      break
    case 'http': {
      if (node.config.connectorId !== undefined) {
        if (node.config.connectorId.trim() === '') add('托管 HTTP 请求需要连接器 ID。', 'connectorId')
        const pathValue = node.config.connectorPath ?? ''
        let decodedPath: string | undefined
        try { decodedPath = decodeURIComponent(pathValue) } catch { /* reported below */ }
        const decodedUnsafe = decodedPath === undefined || decodedPath.startsWith('//') || decodedPath.includes('\\') || decodedPath.includes('://') || decodedPath.includes('?') || decodedPath.includes('#') || decodedPath.split('/').includes('..')
        if (pathValue.trim() === '' || pathValue.startsWith('//') || pathValue.includes('://') || pathValue.includes('\\') || pathValue.includes('?') || pathValue.includes('#') || pathValue.split('/').includes('..') || decodedUnsafe) add('连接器路径必须是同源的相对路径。', 'connectorPath')
      } else if (node.config.url.trim() === '') add('HTTP 请求 URL 不能为空。', 'url')
      else {
        try {
          const url = new URL(node.config.url)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') add('HTTP 请求只允许 http 或 https URL。', 'url')
        } catch { add('HTTP 请求 URL 无效。', 'url') }
      }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(node.config.method)) add('HTTP 请求方法无效。', 'method')
      if (!['auto', 'json', 'text'].includes(node.config.responseMode)) add('HTTP 响应格式无效。', 'responseMode')
      if (node.config.query !== undefined && (!isWorkflowValue(node.config.query) || Array.isArray(node.config.query))) add('HTTP 查询参数必须是 JSON 对象。', 'query')
      if (node.config.timeoutMs !== undefined && (!Number.isInteger(node.config.timeoutMs) || node.config.timeoutMs < 1_000 || node.config.timeoutMs > 600_000)) add('HTTP 请求超时必须是 1000 到 600000 毫秒。', 'timeoutMs')
      for (const [name, value] of Object.entries(node.config.headers)) {
        if (name.trim() === '' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof value !== 'string') add('HTTP 请求头名称或值无效。', 'headers')
      }
      break
    }
    case 'code':
      if (node.config.language !== 'nodejs' && node.config.language !== 'python3') add('代码语言必须是 nodejs 或 python3。', 'language')
      if (node.config.code.trim() === '') add('代码不能为空。', 'code')
      if (node.config.timeoutMs !== undefined && (!Number.isInteger(node.config.timeoutMs) || node.config.timeoutMs < 1_000 || node.config.timeoutMs > 600_000)) add('代码超时必须是 1000 到 600000 毫秒。', 'timeoutMs')
      break
    case 'output':
      if (node.config.contentMode !== undefined && node.config.contentMode !== 'variable' && node.config.contentMode !== 'text') add('结束节点输出内容来源无效。', 'contentMode')
      break
    case 'input':
      break
  }
}
