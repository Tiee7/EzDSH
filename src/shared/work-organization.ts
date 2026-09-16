import type {
  WorkMaterialRef,
  WorkRunStatus,
  WorkTaskStatus,
} from './work-items.js'

/**
 * Stable links into the Main-owned Work Item model. Organization records do
 * not copy task, run, or artifact state and never become another executor.
 */
export interface WorkOrganizationTaskRef {
  readonly taskId: string
  readonly requirementVersion: number
  readonly status: WorkTaskStatus
}

export interface WorkOrganizationRunRef {
  readonly taskId: string
  readonly attemptId: string
  readonly runId: string
  readonly requirementVersion: number
  readonly status: WorkRunStatus
}

export interface WorkOrganizationArtifactRef {
  readonly taskId: string
  readonly artifactId: string
  readonly contentVersion: number
}

/** Provenance for a projection; source identity is not an authorization grant. */
export interface WorkOrganizationSourceRef {
  readonly kind: 'native' | 'legacy-workbench'
  readonly sourceId: string
  readonly sourceKey: string
  readonly contentHash?: string
}

export interface WorkOrganizationIdeaProjection {
  readonly kind: 'idea'
  readonly ideaId: string
  readonly projectId?: string
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly state: 'captured' | 'considering' | 'converted' | 'dismissed'
  readonly source: WorkOrganizationSourceRef
  /** Explicit relationships only; an idea does not become executable itself. */
  readonly workItems: readonly WorkOrganizationTaskRef[]
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface WorkOrganizationMaterialProjection {
  readonly kind: 'material'
  readonly materialId: string
  readonly projectId?: string
  readonly label: string
  readonly material: WorkMaterialRef
  readonly source?: WorkOrganizationSourceRef
  /** Usage references do not prove that the material was authorized for a Run. */
  readonly usedBy: readonly WorkOrganizationTaskRef[]
}

export type WorkOrganizationSubjectRef =
  | { readonly kind: 'idea'; readonly ideaId: string }
  | { readonly kind: 'material'; readonly materialId: string }
  | { readonly kind: 'work-item'; readonly taskId: string }
  | WorkOrganizationArtifactRef & { readonly kind: 'artifact' }

export interface WorkOrganizationProposalProjection {
  readonly kind: 'proposal'
  readonly proposalId: string
  readonly projectId?: string
  readonly title: string
  readonly summary: string
  readonly state: 'draft' | 'running' | 'ready' | 'conflict' | 'applied' | 'dismissed' | 'failed'
  readonly target: WorkOrganizationSubjectRef
  readonly source: WorkOrganizationSourceRef
  /**
   * Optional links to the authoritative execution and result. Their status is
   * read from Work Items; this projection has no independent Run lifecycle.
   */
  readonly workItem?: WorkOrganizationTaskRef
  readonly run?: WorkOrganizationRunRef
  readonly resultArtifact?: WorkOrganizationArtifactRef
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface WorkOrganizationProjection {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly ideas: readonly WorkOrganizationIdeaProjection[]
  readonly materials: readonly WorkOrganizationMaterialProjection[]
  readonly proposals: readonly WorkOrganizationProposalProjection[]
}

/**
 * Read-only confirmation payload used before an idea or proposal is converted
 * into a real Work Item. A caller still has to create a versioned,
 * idempotent WorkTaskCreateRequest after user confirmation.
 */
export interface WorkOrganizationTaskDraft {
  readonly source:
    | { readonly kind: 'idea'; readonly ideaId: string; readonly sourceHash?: string }
    | { readonly kind: 'proposal'; readonly proposalId: string; readonly sourceHash?: string }
  readonly title: string
  readonly goal: string
  readonly acceptance: string
  readonly projectId?: string
  readonly materialIds: readonly string[]
}
