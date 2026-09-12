import { workflowAllNodeRunStates, type WorkflowRunRecord, type WorkflowRunStatus } from './workflow.js'

export type WorkflowRecoveryReason = 'safe-to-resume' | 'not-found' | 'not-resumable' | 'run-busy' | 'service-unavailable'
  | 'definition-unavailable' | 'environment-inactive' | 'access-revoked' | 'legacy-loop-uncheckpointed'
  | 'effect-reconciliation-required' | 'compensation-present' | 'state-changed' | 'request-conflict'
  | 'queue-full' | 'recovery-failed' | 'receipt-capacity'

export interface WorkflowRecoveryPreview {
  runId: string
  expectedStateToken: string
  decision: 'eligible' | 'blocked' | 'not-found'
  reason: WorkflowRecoveryReason
}
export interface WorkflowRecoveryPreviewRequest { runIds: string[] }
export interface WorkflowRecoveryExecuteRequest {
  requestId: string
  items: Array<{ runId: string; expectedStateToken: string }>
}
export interface WorkflowRecoveryResult {
  runId: string
  status: 'queued' | 'already-accepted' | 'stale' | 'blocked' | 'not-found' | 'failed'
  reason: WorkflowRecoveryReason
}
export interface WorkflowDeadLetterQuery {
  workflowId?: string
  environmentId?: string
  status?: WorkflowRunStatus
  offset?: number
  limit?: number
}
export interface WorkflowDeadLetterItem extends WorkflowRecoveryPreview {
  workflowId: string
  workflowRevision: number
  environmentId?: string
  releaseId?: string
  traceId?: string
  status: WorkflowRunStatus
  failureCategory: 'legacy-failure-unclassified' | 'paused' | 'unresolved-audit'
  retentionHold: boolean
}
export interface WorkflowDeadLetterPage { items: WorkflowDeadLetterItem[]; total: number; offset: number; limit: number }

/** No inference from private error strings. Retain every unresolved journal. */
export function workflowRunHasUnresolvedAudit(record: WorkflowRunRecord): boolean {
  return workflowAllNodeRunStates(record.nodeStates).some((state) => (
    state.effectState === 'prepared' || state.effectState === 'dispatched' || state.effectState === 'unknown'
    || state.effectState === 'confirmed' && (state.status !== 'completed' || state.output === undefined)
  )) || (record.compensationStack ?? []).some((entry) => entry.status !== 'completed'
    || entry.effectState === 'prepared' || entry.effectState === 'dispatched' || entry.effectState === 'unknown')
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery request')
  return value as Record<string, unknown>
}
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f]/u.test(value) }
function runIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 || !value.every(identifier) || new Set(value).size !== value.length) throw new Error('Invalid recovery selection: select 1 to 20 unique run IDs')
  return [...value] as string[]
}
export function validateWorkflowRecoveryPreview(value: unknown): WorkflowRecoveryPreviewRequest {
  return { runIds: runIds(object(value).runIds) }
}
export function validateWorkflowRecoveryExecute(value: unknown): WorkflowRecoveryExecuteRequest {
  const raw = object(value)
  if (!identifier(raw.requestId) || !Array.isArray(raw.items)) throw new Error('Invalid recovery execution')
  const items = raw.items.map((value) => {
    const item = object(value)
    if (!identifier(item.runId) || typeof item.expectedStateToken !== 'string' || !/^[a-f0-9]{64}$/u.test(item.expectedStateToken)) throw new Error('Invalid recovery item')
    return { runId: item.runId, expectedStateToken: item.expectedStateToken }
  })
  runIds(items.map((item) => item.runId))
  return { requestId: raw.requestId, items }
}
export function validateWorkflowDeadLetterQuery(value: unknown): WorkflowDeadLetterQuery {
  const raw = object(value ?? {})
  if (raw.workflowId !== undefined && !identifier(raw.workflowId) || raw.environmentId !== undefined && !identifier(raw.environmentId)
    || raw.status !== undefined && !['failed', 'paused', 'queued', 'running', 'waiting-approval', 'completed', 'cancelled'].includes(String(raw.status))
    || raw.offset !== undefined && (!Number.isSafeInteger(raw.offset) || (raw.offset as number) < 0)
    || raw.limit !== undefined && (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 100)) throw new Error('Invalid dead-letter query')
  return { ...(raw.workflowId === undefined ? {} : { workflowId: raw.workflowId as string }), ...(raw.environmentId === undefined ? {} : { environmentId: raw.environmentId as string }),
    ...(raw.status === undefined ? {} : { status: raw.status as WorkflowRunStatus }), offset: (raw.offset as number | undefined) ?? 0, limit: (raw.limit as number | undefined) ?? 50 }
}

/** Fixed public errors only; never carry provider messages or configuration. */
export const workflowRecoveryReasonText: Record<WorkflowRecoveryReason, string> = {
  'safe-to-resume': '可安全恢复 / Safe to resume', 'not-found': '运行不存在 / Run not found', 'not-resumable': '只有暂停或失败的运行可以恢复 / Not resumable',
  'run-busy': '运行正在执行或变更 / Run busy', 'service-unavailable': '运行服务暂不可用 / Service unavailable',
  'definition-unavailable': 'Workflow revision unavailable / 固定版本或发布不可用', 'environment-inactive': 'Workflow environment must be active / 环境未启用',
  'access-revoked': '执行权限不可用 / Access unavailable', 'legacy-loop-uncheckpointed': '旧版循环缺少逐迭代副作用记录 / Legacy loop requires review',
  'effect-reconciliation-required': '副作用需要人工核对 / Effects require reconciliation', 'compensation-present': '补偿栈存在，不能自动恢复 / Compensation requires review',
  'state-changed': '状态已变化，请重新预览 / Preview is stale', 'request-conflict': '请求标识与已接受的预览不一致 / Request conflict',
  'queue-full': '运行队列已满 / Queue full', 'recovery-failed': '恢复未完成，请重试或检查状态 / Recovery failed', 'receipt-capacity': '恢复审计容量已满 / Recovery receipt capacity reached',
}
