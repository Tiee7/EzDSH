import { cloneWorkflow, normalizeWorkflow, type WorkflowConnectorGrant, type WorkflowDefinition } from './workflow.js'

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
  contentSha256: string
  workflowSnapshot: WorkflowDefinition
  status: 'published' | 'superseded' | 'rolled-back'
  connectorGrants: WorkflowConnectorGrant[]
  createdAt: string
  publishedAt: string
}

/** Renderer-safe release metadata. The immutable definition remains Main-only. */
export interface WorkflowReleaseSummary {
  id: string
  environmentId: string
  workflowId: string
  workflowRevision: number
  contentSha256: string
  status: WorkflowRelease['status']
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
  kind: 'run' | 'node' | 'effect' | 'deployment'
  action: string
  severity: 'info' | 'warning' | 'error'
  outcome?: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
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

const environmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const sha256Pattern = /^[a-f0-9]{64}$/iu

function normalizeRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function normalizeDate(value: unknown): string | undefined {
  const date = normalizeRequiredString(value)
  return date === undefined || Number.isNaN(Date.parse(date)) ? undefined : date
}

function normalizeConnectorGrants(value: unknown): WorkflowConnectorGrant[] | undefined {
  if (!Array.isArray(value)) return undefined
  const grants = new Map<string, Set<'read' | 'write'>>()
  for (const grant of value) {
    if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) return undefined
    const input = grant as Record<string, unknown>
    const connectorId = normalizeRequiredString(input.connectorId)
    if (connectorId === undefined || !environmentIdPattern.test(connectorId) || !Array.isArray(input.operations)) return undefined
    const operations = grants.get(connectorId) ?? new Set<'read' | 'write'>()
    for (const operation of input.operations) {
      if (operation !== 'read' && operation !== 'write') return undefined
      operations.add(operation)
    }
    if (operations.size === 0) return undefined
    grants.set(connectorId, operations)
  }
  return [...grants.entries()].map(([connectorId, operations]) => ({ connectorId, operations: [...operations] }))
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

export function normalizeWorkflowRelease(value: unknown): WorkflowRelease | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const id = normalizeRequiredString(input.id)
  const environmentId = normalizeRequiredString(input.environmentId)
  const workflowId = normalizeRequiredString(input.workflowId)
  const contentSha256 = normalizeRequiredString(input.contentSha256)
  const createdAt = normalizeDate(input.createdAt)
  const publishedAt = normalizeDate(input.publishedAt)
  const workflowSnapshot = normalizeWorkflow(input.workflowSnapshot)
  const connectorGrants = normalizeConnectorGrants(input.connectorGrants)
  if (id === undefined || !environmentIdPattern.test(id) || environmentId === undefined || !environmentIdPattern.test(environmentId) || workflowId === undefined || !environmentIdPattern.test(workflowId) || contentSha256 === undefined || !sha256Pattern.test(contentSha256) || createdAt === undefined || publishedAt === undefined || workflowSnapshot === undefined || connectorGrants === undefined) return undefined
  if (!Number.isInteger(input.workflowRevision) || input.workflowRevision < 1 || workflowId !== workflowSnapshot.id || input.workflowRevision !== workflowSnapshot.revision) return undefined
  if (input.status !== 'published' && input.status !== 'superseded' && input.status !== 'rolled-back') return undefined
  return {
    id,
    environmentId,
    workflowId,
    workflowRevision: input.workflowRevision,
    contentSha256: contentSha256.toLowerCase(),
    workflowSnapshot: cloneWorkflow(workflowSnapshot),
    status: input.status,
    connectorGrants,
    createdAt,
    publishedAt,
  }
}

export function workflowReleaseSummary(release: WorkflowRelease): WorkflowReleaseSummary {
  return {
    id: release.id,
    environmentId: release.environmentId,
    workflowId: release.workflowId,
    workflowRevision: release.workflowRevision,
    contentSha256: release.contentSha256,
    status: release.status,
    createdAt: release.createdAt,
    publishedAt: release.publishedAt,
  }
}

/** Intersect saved workflow connector policy with the environment's connector allowlist. */
export function deriveEnvironmentConnectorGrants(workflow: WorkflowDefinition, environment: WorkflowCustomerEnvironment): WorkflowConnectorGrant[] {
  const allowedConnectors = new Set(environment.connectorIds)
  const grants = new Map<string, Set<'read' | 'write'>>()
  for (const permission of workflow.permissionPolicy?.connectors ?? []) {
    const connectorId = permission.connectorId.trim()
    if (!allowedConnectors.has(connectorId)) continue
    const operations = grants.get(connectorId) ?? new Set<'read' | 'write'>()
    for (const operation of permission.operations) if (operation === 'read' || operation === 'write') operations.add(operation)
    if (operations.size > 0) grants.set(connectorId, operations)
  }
  return [...grants.entries()].map(([connectorId, operations]) => ({ connectorId, operations: [...operations] }))
}
