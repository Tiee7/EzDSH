import { createHash } from 'node:crypto'
import { normalizeWorkflow, type WorkflowDefinition } from '../../shared/workflow.js'
import { workflowSnapshotHasStaticHttpHeaders, type WorkflowRelease } from '../../shared/workflow-operations.js'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]))
  }
  return value
}

/** Stable JSON representation used solely for release snapshot integrity. */
export function canonicalizeWorkflowDefinition(workflow: WorkflowDefinition): string {
  const normalized = normalizeWorkflow(workflow)
  if (normalized === undefined) throw new Error('Invalid workflow release snapshot')
  if (workflowSnapshotHasStaticHttpHeaders(normalized)) throw new Error('Workflow release snapshot contains static HTTP headers')
  return JSON.stringify(canonicalize(normalized))
}

export function computeWorkflowDefinitionSha256(workflow: WorkflowDefinition): string {
  return createHash('sha256').update(canonicalizeWorkflowDefinition(workflow), 'utf8').digest('hex')
}

function canonicalizeReleaseWorkflows(
  workflowSnapshot: WorkflowDefinition,
  workflowDependencies: readonly WorkflowDefinition[] = [],
): string {
  if (workflowDependencies.length === 0) return canonicalizeWorkflowDefinition(workflowSnapshot)
  const root = JSON.parse(canonicalizeWorkflowDefinition(workflowSnapshot)) as unknown
  const dependencies = workflowDependencies
    .map((dependency) => normalizeWorkflow(dependency))
    .map((dependency) => {
      if (dependency === undefined) throw new Error('Invalid workflow release dependency snapshot')
      if (workflowSnapshotHasStaticHttpHeaders(dependency)) throw new Error('Workflow release dependency snapshot contains static HTTP headers')
      return dependency
    })
    .sort((left, right) => left.id.localeCompare(right.id) || left.revision - right.revision)
    .map((dependency) => JSON.parse(canonicalizeWorkflowDefinition(dependency)) as unknown)
  return JSON.stringify(canonicalize({ workflowSnapshot: root, workflowDependencies: dependencies }))
}

export function computeWorkflowReleaseSha256(input: Pick<WorkflowRelease, 'workflowSnapshot'> & { workflowDependencies?: readonly WorkflowDefinition[] }): string {
  return createHash('sha256').update(canonicalizeReleaseWorkflows(input.workflowSnapshot, input.workflowDependencies ?? []), 'utf8').digest('hex')
}

/** Confirm that a release's pinned digest still matches its immutable workflow snapshot. */
export function verifyWorkflowReleaseIntegrity(release: WorkflowRelease): boolean {
  try {
    return computeWorkflowReleaseSha256(release) === release.contentSha256
  } catch {
    return false
  }
}
