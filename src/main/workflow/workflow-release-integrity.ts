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

/** Confirm that a release's pinned digest still matches its immutable workflow snapshot. */
export function verifyWorkflowReleaseIntegrity(release: WorkflowRelease): boolean {
  try {
    return computeWorkflowDefinitionSha256(release.workflowSnapshot) === release.contentSha256
  } catch {
    return false
  }
}
