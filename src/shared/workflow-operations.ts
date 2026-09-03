import { cloneWorkflow, normalizeWorkflow, type WorkflowConnectorGrant, type WorkflowDefinition, type WorkflowRunEventType } from './workflow.js'

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
  workflowDependencies?: WorkflowDefinition[]
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
  nodeId?: string
  time: string
  kind: 'run' | 'node' | 'effect' | 'deployment'
  action: WorkflowObservationAction
  severity: 'info' | 'warning' | 'error'
  outcome?: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
}

export type WorkflowDeploymentAction = 'release-published' | 'release-superseded' | 'release-rolled-back'
export type WorkflowObservationAction = WorkflowRunEventType | WorkflowDeploymentAction
export type WorkflowHealthReason = 'no-observations' | 'recent-failures' | 'release-rolled-back' | 'healthy'

export interface WorkflowOperationsHealth {
  environmentId: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  observedAt: string
  reason: WorkflowHealthReason
}

export interface WorkflowReleasePublishInput {
  id?: string
  environmentId: string
  workflowId: string
  workflowRevision?: number
}

const environmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const sha256Pattern = /^[a-f0-9]{64}$/iu
const observationActions = new Set<WorkflowObservationAction>([
  'run-created', 'run-started', 'node-started', 'node-retry', 'node-effect-prepared', 'node-effect-dispatched', 'node-effect-confirmed', 'node-completed', 'node-skipped', 'node-failed', 'compensation-started', 'compensation-completed', 'compensation-failed', 'approval-requested', 'approval-resolved', 'run-completed', 'run-failed', 'run-paused', 'run-cancelled',
  'release-published', 'release-superseded', 'release-rolled-back',
])

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

function buildReleasePolicyMap(
  workflow: WorkflowDefinition,
  dependencies: readonly WorkflowDefinition[] = [],
): Map<string, Set<'read' | 'write'>> {
  const policy = new Map<string, Set<'read' | 'write'>>()
  for (const definition of [workflow, ...dependencies]) {
    for (const permission of definition.permissionPolicy?.connectors ?? []) {
      const connectorId = permission.connectorId.trim()
      const operations = policy.get(connectorId) ?? new Set<'read' | 'write'>()
      for (const operation of permission.operations) operations.add(operation)
      if (operations.size > 0) policy.set(connectorId, operations)
    }
  }
  return policy
}

/** True only when every release grant is already permitted by the release snapshots. */
export function workflowConnectorGrantsAreSubsetOfPolicy(
  workflow: WorkflowDefinition,
  grants: readonly WorkflowConnectorGrant[],
  dependencies: readonly WorkflowDefinition[] = [],
): boolean {
  const policy = buildReleasePolicyMap(workflow, dependencies)
  return grants.every((grant) => {
    const allowed = policy.get(grant.connectorId)
    return allowed !== undefined && grant.operations.every((operation) => allowed.has(operation))
  })
}

/** Release snapshots keep static templates only; HTTP headers are injected at execution time. */
export function workflowSnapshotHasStaticHttpHeaders(workflow: WorkflowDefinition): boolean {
  return workflow.nodes.some((node) => node.type === 'http' && Object.keys(node.config.headers).length > 0)
}

function normalizeWorkflowDependencies(
  value: unknown,
  rootWorkflowId: string,
  rootWorkflowRevision: number,
): WorkflowDefinition[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>([`${rootWorkflowId}@${String(rootWorkflowRevision)}`])
  const dependencies: WorkflowDefinition[] = []
  for (const entry of value) {
    const dependency = normalizeWorkflow(entry)
    if (dependency === undefined || workflowSnapshotHasStaticHttpHeaders(dependency)) return undefined
    const key = `${dependency.id}@${String(dependency.revision)}`
    if (seen.has(key)) return undefined
    seen.add(key)
    dependencies.push(cloneWorkflow(dependency))
  }
  return dependencies
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
  const workflowRevision = input.workflowRevision
  const createdAt = normalizeDate(input.createdAt)
  const publishedAt = normalizeDate(input.publishedAt)
  const workflowSnapshot = normalizeWorkflow(input.workflowSnapshot)
  const workflowDependencies = workflowSnapshot === undefined || typeof workflowRevision !== 'number' || !Number.isInteger(workflowRevision) || workflowRevision < 1
    ? undefined
    : normalizeWorkflowDependencies(input.workflowDependencies, workflowSnapshot.id, workflowRevision)
  const connectorGrants = normalizeConnectorGrants(input.connectorGrants)
  if (id === undefined || !environmentIdPattern.test(id) || environmentId === undefined || !environmentIdPattern.test(environmentId) || workflowId === undefined || !environmentIdPattern.test(workflowId) || contentSha256 === undefined || !sha256Pattern.test(contentSha256) || createdAt === undefined || publishedAt === undefined || workflowSnapshot === undefined || workflowDependencies === undefined || connectorGrants === undefined) return undefined
  if (typeof workflowRevision !== 'number' || !Number.isInteger(workflowRevision) || workflowRevision < 1 || workflowId !== workflowSnapshot.id || workflowRevision !== workflowSnapshot.revision || workflowSnapshotHasStaticHttpHeaders(workflowSnapshot) || !workflowConnectorGrantsAreSubsetOfPolicy(workflowSnapshot, connectorGrants, workflowDependencies)) return undefined
  if (input.status !== 'published' && input.status !== 'superseded' && input.status !== 'rolled-back') return undefined
  return {
    id,
    environmentId,
    workflowId,
    workflowRevision,
    contentSha256: contentSha256.toLowerCase(),
    workflowSnapshot: cloneWorkflow(workflowSnapshot),
    ...(workflowDependencies.length === 0 ? {} : { workflowDependencies: workflowDependencies.map((dependency) => cloneWorkflow(dependency)) }),
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

/** Reject arbitrary event payloads so observation persistence cannot copy runtime data. */
export function normalizeWorkflowObservationEvent(value: unknown): WorkflowObservationEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const knownKeys = new Set(['id', 'environmentId', 'releaseId', 'runId', 'traceId', 'nodeId', 'time', 'kind', 'action', 'severity', 'outcome'])
  if (Object.keys(input).some((key) => !knownKeys.has(key))) return undefined
  const id = normalizeRequiredString(input.id)
  const environmentId = normalizeRequiredString(input.environmentId)
  const time = normalizeDate(input.time)
  if (id === undefined || !environmentIdPattern.test(id) || environmentId === undefined || !environmentIdPattern.test(environmentId) || time === undefined) return undefined
  if (input.kind !== 'run' && input.kind !== 'node' && input.kind !== 'effect' && input.kind !== 'deployment') return undefined
  if (typeof input.action !== 'string' || !observationActions.has(input.action as WorkflowObservationAction)) return undefined
  if (input.severity !== 'info' && input.severity !== 'warning' && input.severity !== 'error') return undefined
  if (input.outcome !== undefined && input.outcome !== 'started' && input.outcome !== 'succeeded' && input.outcome !== 'failed' && input.outcome !== 'unknown' && input.outcome !== 'cancelled') return undefined
  const optionalIds = [input.releaseId, input.runId, input.traceId, input.nodeId].map(normalizeRequiredString)
  if ([input.releaseId, input.runId, input.traceId, input.nodeId].some((value, index) => value !== undefined && (optionalIds[index] === undefined || !environmentIdPattern.test(optionalIds[index])))) return undefined
  return {
    id,
    environmentId,
    ...(optionalIds[0] === undefined ? {} : { releaseId: optionalIds[0] }),
    ...(optionalIds[1] === undefined ? {} : { runId: optionalIds[1] }),
    ...(optionalIds[2] === undefined ? {} : { traceId: optionalIds[2] }),
    ...(optionalIds[3] === undefined ? {} : { nodeId: optionalIds[3] }),
    time,
    kind: input.kind,
    action: input.action as WorkflowObservationAction,
    severity: input.severity,
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
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
