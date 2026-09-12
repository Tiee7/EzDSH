import type { AppLocale } from '../../shared/locale.js'
import type { WorkflowConnectorHealthReason, WorkflowConnectorHealthState } from '../../shared/workflow-operations.js'
import type { WorkflowDeadLetterItem, WorkflowRecoveryPreview, WorkflowRecoveryReason, WorkflowRecoveryResult } from '../../shared/workflow-dead-letter.js'
import type { WorkflowRunStatus } from '../../shared/workflow.js'

type Label = Record<AppLocale, string>
const stateFallback: Label = { zh: '未知状态', en: 'Unknown state' }
const detailFallback: Label = { zh: '详情不可用', en: 'Details unavailable' }

// IPC types cannot guarantee runtime values. Never echo unknown codes or use
// inherited object properties as display text.
function label<K extends string>(map: Record<K, Label>, value: K, locale: AppLocale, fallback: Label): string {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value][locale] : fallback[locale]
}

const connectorStates: Record<WorkflowConnectorHealthState, Label> = {
  disabled: { zh: '已关闭', en: 'Disabled' }, unchecked: { zh: '尚未检查', en: 'Not checked' },
  checking: { zh: '检查中', en: 'Checking' }, stale: { zh: '已过期', en: 'Expired' },
  reachable: { zh: '可连接', en: 'Reachable' }, failed: { zh: '检查失败', en: 'Failed' }, blocked: { zh: '已阻止', en: 'Blocked' },
}
const connectorReasons: Record<WorkflowConnectorHealthReason, Label> = {
  'probe-disabled': { zh: '健康检查已关闭', en: 'Health check disabled' },
  'not-checked': { zh: '尚未执行检查', en: 'No check has run' },
  checking: { zh: '正在检查', en: 'Check in progress' }, expired: { zh: '检查证据已过期', en: 'Check evidence expired' },
  'status-expected': { zh: '返回预期 HTTP 状态码', en: 'Expected HTTP status received' },
  'unexpected-status': { zh: '返回非预期 HTTP 状态码', en: 'Unexpected HTTP status received' },
  'redirect-blocked': { zh: '重定向已阻止', en: 'Redirect blocked' }, timeout: { zh: '检查超时', en: 'Check timed out' },
  'dns-failed': { zh: '域名解析失败', en: 'DNS lookup failed' }, 'request-failed': { zh: '请求失败', en: 'Request failed' },
  'access-denied': { zh: '访问被拒绝', en: 'Access denied' }, 'configuration-invalid': { zh: '配置无效', en: 'Invalid configuration' },
  'credential-unavailable': { zh: '凭证不可用', en: 'Credential unavailable' },
  'credential-scope-denied': { zh: '凭证权限范围不允许', en: 'Credential scope denied' },
  'egress-blocked': { zh: '对外访问已阻止', en: 'Outbound access blocked' },
  'target-changed': { zh: '检查目标已变化', en: 'Check target changed' },
  'rate-limited': { zh: '检查过于频繁，请稍后重试。', en: 'Too many checks. Please try again later.' },
}
const runStates: Record<WorkflowRunStatus, Label> = {
  queued: { zh: '已排队', en: 'Queued' }, running: { zh: '运行中', en: 'Running' }, paused: { zh: '已暂停', en: 'Paused' },
  'waiting-approval': { zh: '等待审批', en: 'Awaiting approval' }, completed: { zh: '已完成', en: 'Completed' },
  failed: { zh: '已失败', en: 'Failed' }, cancelled: { zh: '已取消', en: 'Cancelled' },
}
const recoveryReasons: Record<WorkflowRecoveryReason, Label> = {
  'safe-to-resume': { zh: '可安全恢复', en: 'Safe to resume' }, 'not-found': { zh: '运行不存在', en: 'Run not found' },
  'not-resumable': { zh: '只有暂停或失败的运行可以恢复', en: 'Not resumable' }, 'run-busy': { zh: '运行正在执行或变更', en: 'Run busy' },
  'service-unavailable': { zh: '运行服务暂不可用', en: 'Service unavailable' },
  'definition-unavailable': { zh: '固定版本或发布不可用', en: 'Fixed revision or release unavailable' },
  'environment-inactive': { zh: '环境未启用', en: 'Environment inactive' }, 'access-revoked': { zh: '执行权限不可用', en: 'Access unavailable' },
  'legacy-loop-uncheckpointed': { zh: '旧版循环缺少逐迭代副作用记录', en: 'Legacy loop requires review' },
  'effect-reconciliation-required': { zh: '副作用需要人工核对', en: 'Effects require reconciliation' },
  'compensation-present': { zh: '补偿栈存在，不能自动恢复', en: 'Compensation requires review' },
  'state-changed': { zh: '状态已变化，请重新预览', en: 'Preview is stale' },
  'request-conflict': { zh: '请求标识与已接受的预览不一致', en: 'Request conflict' },
  'queue-full': { zh: '运行队列已满', en: 'Queue full' },
  'recovery-failed': { zh: '恢复未完成，请重试或检查状态', en: 'Recovery failed' },
  'receipt-capacity': { zh: '恢复审计容量已满', en: 'Recovery receipt capacity reached' },
  'source-deleted-audit-only': { zh: '来源已删除，仅保留审计', en: 'Source deleted; audit only' },
}
const recoveryDecisions: Record<WorkflowRecoveryPreview['decision'], Label> = {
  eligible: { zh: '可恢复', en: 'Eligible' }, blocked: { zh: '已阻止', en: 'Blocked' }, 'not-found': { zh: '未找到', en: 'Not found' },
}
const failureCategories: Record<WorkflowDeadLetterItem['failureCategory'], Label> = {
  'legacy-failure-unclassified': { zh: '旧版失败未分类', en: 'Unclassified legacy failure' },
  paused: { zh: '已暂停', en: 'Paused' }, 'unresolved-audit': { zh: '审计证据待核对', en: 'Unresolved audit evidence' },
}
const recoveryOutcomes: Record<WorkflowRecoveryResult['status'], Label> = {
  queued: { zh: '已排队等待执行，尚未确认完成', en: 'Queued for execution; completion is not confirmed' },
  'already-accepted': { zh: '此请求已接受，请查看运行当前状态', en: 'Already accepted; check the current run state' },
  stale: { zh: '预览已过期', en: 'Preview is stale' }, blocked: { zh: '已阻止', en: 'Blocked' },
  'not-found': { zh: '未找到', en: 'Not found' }, failed: { zh: '恢复失败', en: 'Failed' },
}

export const connectorStateLabel = (value: WorkflowConnectorHealthState, locale: AppLocale): string => label(connectorStates, value, locale, stateFallback)
export const connectorReasonLabel = (value: WorkflowConnectorHealthReason, locale: AppLocale): string => label(connectorReasons, value, locale, detailFallback)
export const runStateLabel = (value: WorkflowRunStatus, locale: AppLocale): string => label(runStates, value, locale, stateFallback)
export const recoveryReasonLabel = (value: WorkflowRecoveryReason, locale: AppLocale): string => label(recoveryReasons, value, locale, detailFallback)
export const recoveryDecisionLabel = (value: WorkflowRecoveryPreview['decision'], locale: AppLocale): string => label(recoveryDecisions, value, locale, { zh: '未知恢复决定', en: 'Unknown decision' })
export const failureCategoryLabel = (value: WorkflowDeadLetterItem['failureCategory'], locale: AppLocale): string => label(failureCategories, value, locale, detailFallback)
export const recoveryOutcomeLabel = (value: WorkflowRecoveryResult['status'], locale: AppLocale): string => label(recoveryOutcomes, value, locale, { zh: '未知恢复结果', en: 'Unknown outcome' })
