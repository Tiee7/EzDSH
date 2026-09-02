import type { WorkflowNode, WorkflowNodeRunState, WorkflowRetryPolicy } from '../../shared/workflow.js'

export type WorkflowRetryClassification = 'transient' | 'permanent' | 'ambiguous'

export interface WorkflowRetryPlan {
  decision: 'retry' | 'fail' | 'pause'
  nextAttempt: number
  delayMs: number
  classification: WorkflowRetryClassification
}

const DETERMINISTIC_NODE_TYPES = new Set<WorkflowNode['type']>([
  'ai-task',
  'structured-extract',
  'parallel',
  'loop',
  'sleep',
  'condition',
  'switch',
  'transform',
  'text-merge',
  'object-builder',
  'list-operator',
  'merge',
  'output',
])

/** Nodes whose output depends only on persisted input and workflow definition. */
export function isDeterministicWorkflowNode(node: WorkflowNode): boolean {
  return DETERMINISTIC_NODE_TYPES.has(node.type)
}

export function classifyWorkflowError(error: unknown): WorkflowRetryClassification {
  if (error instanceof Error && error.name === 'AbortError') return 'permanent'
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:权限|授权|forbidden|unauthori[sz]ed|not found|不存在|invalid|无效|不允许|需要运行时显式授权)/iu.test(message)) return 'permanent'
  return 'transient'
}

/**
 * Decide whether a failed node may be run again. External effects are
 * deliberately paused until their connector supplies an idempotency contract;
 * blindly replaying HTTP/MCP/Shell/Code is unsafe even for a transient error.
 */
export function planWorkflowRetry(
  node: WorkflowNode,
  state: WorkflowNodeRunState,
  error: unknown,
  random: () => number = Math.random,
): WorkflowRetryPlan {
  const classification = classifyWorkflowError(error)
  const nextAttempt = Math.max(1, (state.attempt ?? 1) + 1)
  const policy = node.retryPolicy
  if (classification === 'permanent') return { decision: 'fail', nextAttempt, delayMs: 0, classification }
  if (policy === undefined) return { decision: 'fail', nextAttempt, delayMs: 0, classification }
  // A managed HTTP connector can provide a stable Idempotency-Key. Only this
  // adapter is eligible for automatic external retry; Shell/Code/MCP and
  // sub-workflows remain paused because their effect contract is unknown.
  const managedIdempotentHttp = node.type === 'http' && node.config.connectorId !== undefined && policy.mode === 'idempotent'
  if (!isDeterministicWorkflowNode(node) && !managedIdempotentHttp) return { decision: 'pause', nextAttempt, delayMs: 0, classification: 'ambiguous' }
  if (nextAttempt > policy.maxAttempts) return { decision: 'fail', nextAttempt, delayMs: 0, classification }
  const baseDelayMs = clampDelay(policy.baseDelayMs ?? policy.initialDelayMs ?? 250)
  const maxDelayMs = Math.max(baseDelayMs, clampDelay(policy.maxDelayMs ?? 10_000))
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, nextAttempt - 2)))
  const jitterRatio = Math.max(0, Math.min(1, policy.jitterRatio ?? 0.2))
  const jitter = jitterRatio === 0 ? 0 : (random() * 2 - 1) * jitterRatio
  const delayMs = Math.max(0, Math.round(Math.min(maxDelayMs, exponential * (1 + jitter))))
  return { decision: 'retry', nextAttempt, delayMs, classification }
}

export function normalizeRetryPolicy(value: unknown): WorkflowRetryPolicy | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.maxAttempts !== 'number' || !Number.isInteger(raw.maxAttempts)) return undefined
  const mode = raw.mode === 'idempotent' || raw.mode === 'deterministic' ? raw.mode : undefined
  return {
    ...(mode === undefined ? {} : { mode }),
    maxAttempts: raw.maxAttempts,
    ...(typeof raw.baseDelayMs === 'number' ? { baseDelayMs: raw.baseDelayMs } : {}),
    ...(typeof raw.maxDelayMs === 'number' ? { maxDelayMs: raw.maxDelayMs } : {}),
    ...(typeof raw.jitterRatio === 'number' ? { jitterRatio: raw.jitterRatio } : {}),
  }
}

function clampDelay(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(600_000, Math.round(value))) : 0
}
