import type { WorkflowDefinition, WorkflowRunOptions } from './workflow.js'

export type WorkflowEnvironmentKind = 'development' | 'staging' | 'production'

export interface WorkflowCustomerEnvironment {
  id: string
  customerName: string
  name: string
  kind: WorkflowEnvironmentKind
  status: 'active' | 'disabled' | 'archived'
  connectorIds: string[]
  allowShellFile: boolean
  allowCode: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkflowRelease {
  id: string
  environmentId: string
  workflowId: string
  workflowRevision: number
  workflowSnapshot: WorkflowDefinition
  createdAt: string
  publishedAt: string
}

export interface WorkflowObservationEvent {
  id: string
  environmentId: string
  releaseId?: string
  runId?: string
  traceId?: string
  time: string
  type: string
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface WorkflowOperationsHealth {
  environmentId: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  observedAt: string
  message?: string
}

export interface WorkflowReleasePublishInput {
  id?: string
  environmentId: string
  workflowId: string
  workflowRevision?: number
}

/** Main-process-only options for starting an immutable release snapshot. */
export interface WorkflowReleaseStartOptions extends WorkflowRunOptions {
  environmentId: string
  releaseId: string
  workflowSnapshot: WorkflowDefinition
}

const environmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

function normalizeRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function normalizeDate(value: unknown): string | undefined {
  const date = normalizeRequiredString(value)
  return date === undefined || Number.isNaN(Date.parse(date)) ? undefined : date
}

export function normalizeWorkflowCustomerEnvironment(value: unknown): WorkflowCustomerEnvironment | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const id = normalizeRequiredString(input.id)
  const customerName = normalizeRequiredString(input.customerName)
  const name = normalizeRequiredString(input.name)
  const createdAt = normalizeDate(input.createdAt)
  const updatedAt = normalizeDate(input.updatedAt)
  if (id === undefined || !environmentIdPattern.test(id) || customerName === undefined || name === undefined || createdAt === undefined || updatedAt === undefined) return undefined
  if (input.kind !== 'development' && input.kind !== 'staging' && input.kind !== 'production') return undefined
  if (input.status !== 'active' && input.status !== 'disabled' && input.status !== 'archived') return undefined
  if (typeof input.allowShellFile !== 'boolean' || typeof input.allowCode !== 'boolean') return undefined
  if (!Array.isArray(input.connectorIds)) return undefined
  const connectorIds = input.connectorIds.map(normalizeRequiredString)
  if (connectorIds.some((connectorId) => connectorId === undefined || !environmentIdPattern.test(connectorId))) return undefined
  if (input.kind === 'production' && (input.allowShellFile || input.allowCode)) return undefined
  return {
    id,
    customerName,
    name,
    kind: input.kind,
    status: input.status,
    connectorIds: [...new Set(connectorIds as string[])],
    allowShellFile: input.allowShellFile,
    allowCode: input.allowCode,
    createdAt,
    updatedAt,
  }
}
