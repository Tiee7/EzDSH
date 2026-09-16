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

export interface WorkbenchMigrationPlan {
  schemaVersion: 1
  sourceId: string
  sourceHash: string
  sourceDirectory: string
  mappingHash: string
  generatedAt: string
  items: WorkbenchMigrationPlanItem[]
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
}

export interface WorkbenchMigrationApplyResult {
  receipt: WorkbenchMigrationReceipt
  targetId?: string
}

export interface WorkbenchMigrationState {
  plans: WorkbenchMigrationPlan[]
  receipts: WorkbenchMigrationReceipt[]
}
