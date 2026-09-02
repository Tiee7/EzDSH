import type { WorkflowNodeType, WorkflowNodeRetryPolicy, WorkflowNodeRunState } from '../../shared/workflow.js'
import { isDeterministicWorkflowNode, planWorkflowRetry } from './workflow-retry.js'

const EXTERNAL_EFFECT_NODE_TYPES = new Set<WorkflowNodeType>(['http', 'mcp', 'shell', 'file', 'code', 'sub-workflow'])

/** Whether a node type can reach an external system or mutate local state. */
export function isExternalEffectNodeType(type: WorkflowNodeType): boolean {
  return EXTERNAL_EFFECT_NODE_TYPES.has(type)
}

/** Retry is opt-in and only allowed for non-effectful node types. */
export function canAutomaticallyRetryNode(type: WorkflowNodeType, policy?: WorkflowNodeRetryPolicy): boolean {
  if (policy === undefined || policy.maxAttempts <= 1 || isExternalEffectNodeType(type)) return false
  return isDeterministicWorkflowNode({ id: 'policy-check', type, label: type, config: {} as never, position: { x: 0, y: 0 } } as never)
}

/** Exponential backoff with bounded jitter, exposed for deterministic tests. */
export function retryDelayMs(policy: WorkflowNodeRetryPolicy, completedAttempts: number, random: () => number = Math.random): number {
  const base = Math.max(0, Math.min(600_000, Math.round(policy.baseDelayMs ?? policy.initialDelayMs ?? 250)))
  const ceiling = Math.max(base, Math.min(600_000, Math.round(policy.maxDelayMs ?? 10_000)))
  const exponential = Math.min(ceiling, base * (2 ** Math.max(0, completedAttempts - 1)))
  const jitterRatio = Math.max(0, Math.min(1, policy.jitterRatio ?? 0.2))
  const jitter = jitterRatio === 0 ? 0 : (random() * 2 - 1) * jitterRatio
  return Math.max(0, Math.min(ceiling, Math.round(exponential * (1 + jitter))))
}

/** Recover a node checkpoint without fabricating an output after an interruption. */
export function recoverInterruptedNodeState(state: WorkflowNodeRunState): WorkflowNodeRunState {
  const next = { ...state }
  if (state.effectState === 'prepared' || state.effectState === 'dispatched' || state.effectState === 'unknown' || state.effectState === 'confirmed' && state.status !== 'completed') {
    next.status = 'cancelled'
    next.effectState = 'unknown'
    next.completedAt = undefined
    next.output = undefined
    next.error = '外部副作用可能已发出，未自动重放。'
    return next
  }
  if (state.status === 'running') {
    next.status = 'pending'
    next.startedAt = undefined
    next.completedAt = undefined
  }
  return next
}

export function hasUncertainExternalEffect(states: readonly WorkflowNodeRunState[]): boolean {
  return states.some((state) => state.effectState === 'prepared' || state.effectState === 'dispatched' || state.effectState === 'unknown' || state.effectState === 'confirmed' && state.status !== 'completed')
}

/** Planner-compatible façade used by the service and external integrations. */
export { planWorkflowRetry }
