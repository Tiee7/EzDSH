export type WorkbenchMigrationItemKind = 'project' | 'work-item' | 'idea' | 'material' | 'proposal'
export type WorkbenchMigrationAction = 'create' | 'link' | 'skip' | 'conflict'
export type WorkbenchMigrationReceiptStatus = 'previewed' | 'ready' | 'applying' | 'applied' | 'skipped' | 'conflict' | 'failed' | 'unknown'

export interface WorkbenchMigrationIdentity {
  schemaVersion: 1
  sourceType: 'ezdsh-workbench-v1'
  sourceId: string
  sourceKey: string
  identity: string
  sourceFingerprint: string
}

/** Immutable provenance stored on a Work Item created by the legacy importer. */
export interface WorkbenchMigrationOrigin {
  kind: 'workbench-migration'
  sourceType: 'ezdsh-workbench-v1'
  sourceId: string
  sourceSnapshotHash: string
  mappingHash: string
  identity: string
  sourceFingerprint: string
}

export interface WorkbenchMigrationPlanItem {
  identity: WorkbenchMigrationIdentity
  source: {
    kind: WorkbenchMigrationItemKind
    id: string
    title: string
    goal?: string
    acceptance?: string
    legacyStatus?: string
    proposedStatus?: string
    acceptanceEvidence?: string[]
    projectSourceId?: string
    fileReferences: string[]
  }
  target: {
    kind: 'work-item' | 'project-context'
    action: WorkbenchMigrationAction
    targetId?: string
  }
  conflicts: string[]
}

/**
 * A deterministic, side-effect-free copy plan for legacy Markdown materials.
 * `ready` means the source bytes were read and hashed during preview; it does
 * not grant an executor access to those bytes and does not mean they were
 * copied yet.
 */
export interface WorkbenchMigrationMaterialCopyItem {
  sourceRelativePath: string
  destinationRelativePath: string
  status: 'ready' | 'missing' | 'unsafe'
  linkedIdentities: string[]
  size?: number
  contentHash?: string
  reason?: string
}

export interface WorkbenchMigrationMaterialCopyPlan {
  schemaVersion: 1
  destinationRoot: string
  items: WorkbenchMigrationMaterialCopyItem[]
}

export interface WorkbenchMigrationPlan {
  schemaVersion: 1
  sourceId: string
  sourceHash: string
  sourceDirectory: string
  mappingHash: string
  generatedAt: string
  items: WorkbenchMigrationPlanItem[]
  /** Present on plans generated after the material-copy protocol slice. */
  materialCopy?: WorkbenchMigrationMaterialCopyPlan
}

export interface WorkbenchMigrationReceipt {
  requestId: string
  identity: string
  sourceSnapshotHash: string
  mappingHash: string
  sourceFingerprint: string
  status: WorkbenchMigrationReceiptStatus
  targetId?: string
  attempts: number
  plannedAt: string
  appliedAt?: string
  error?: { code: string; message: string }
}

export interface WorkbenchMigrationPreparationRequest {
  requestId: string
  sourceDirectory: string
  sourceId: string
  sourceHash: string
  confirmedSourceKeys: string[]
}

export interface WorkbenchMigrationPreparation {
  requestId: string
  plan: WorkbenchMigrationPlan
  receipts: WorkbenchMigrationReceipt[]
  stale: boolean
  message: string
}

export interface WorkbenchMigrationApplyRequest {
  requestId: string
  identity: string
  sourceId: string
  sourceSnapshotHash: string
  mappingHash: string
  allowUnknown?: boolean
}

export interface WorkbenchMigrationApplyResult {
  receipt: WorkbenchMigrationReceipt
  targetId?: string
}

export interface WorkbenchMigrationBatchApplyRequest {
  batchRequestId: string
  sourceId: string
  sourceSnapshotHash: string
  mappingHash: string
  identities: string[]
  allowUnknown?: boolean
}

export interface WorkbenchMigrationBatchApplyItem {
  identity: string
  status: WorkbenchMigrationReceiptStatus | 'missing'
  receipt?: WorkbenchMigrationReceipt
  targetId?: string
  error?: { code: string; message: string }
}

export interface WorkbenchMigrationBatchApplyResult {
  batchRequestId: string
  sourceId: string
  sourceSnapshotHash: string
  mappingHash: string
  status: 'completed' | 'partial'
  items: WorkbenchMigrationBatchApplyItem[]
}

export interface WorkbenchMigrationReportItem {
  identity: string
  sourceKey: string
  title: string
  action: WorkbenchMigrationAction
  status: WorkbenchMigrationReceiptStatus | 'missing'
  targetId?: string
  targetStatus?: 'present' | 'missing' | 'unverified'
  error?: { code: string; message: string }
}

export interface WorkbenchMigrationReport {
  schemaVersion: 1
  sourceId: string
  sourceHash: string
  mappingHash: string
  generatedAt: string
  counts: Record<WorkbenchMigrationReceiptStatus | 'missing', number>
  items: WorkbenchMigrationReportItem[]
}

export interface WorkbenchMigrationReportRequest {
  sourceId: string
  sourceHash: string
  mappingHash: string
}

export interface WorkbenchMigrationState {
  plans: WorkbenchMigrationPlan[]
  receipts: WorkbenchMigrationReceipt[]
}
