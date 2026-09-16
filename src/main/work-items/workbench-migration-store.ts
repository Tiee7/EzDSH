import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  WorkbenchMigrationPlan,
  WorkbenchMigrationPreparation,
  WorkbenchMigrationReceipt,
} from '../../shared/workbench-migration.js'

interface StoredRequest {
  digest: string
  preparation: WorkbenchMigrationPreparation
}

interface State {
  version: 1
  plans: Record<string, WorkbenchMigrationPlan>
  receipts: Record<string, WorkbenchMigrationReceipt>
  requests: Record<string, StoredRequest>
}

export class WorkbenchMigrationStoreConflictError extends Error {
  readonly code: 'REQUEST_ID_CONFLICT' | 'PLAN_CONFLICT' | 'RECEIPT_NOT_FOUND' | 'INVALID_STATUS' | 'TARGET_CONFLICT'

  constructor(code: WorkbenchMigrationStoreConflictError['code'], message: string) {
    super(message)
    this.name = 'WorkbenchMigrationStoreConflictError'
    this.code = code
  }
}

const EMPTY_STATE: State = { version: 1, plans: {}, receipts: {}, requests: {} }

function copy<T>(value: T): T {
  return structuredClone(value)
}

function keyForPlan(plan: WorkbenchMigrationPlan): string {
  return `${plan.sourceId}\u0000${plan.sourceHash}`
}

function keyForReceipt(receipt: WorkbenchMigrationReceipt): string {
  return `${receipt.identity}\u0000${receipt.sourceSnapshotHash}\u0000${receipt.mappingHash}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validPlan(value: unknown): value is WorkbenchMigrationPlan {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.sourceId !== 'string' || typeof value.sourceHash !== 'string'
    || typeof value.sourceDirectory !== 'string' || typeof value.mappingHash !== 'string' || typeof value.generatedAt !== 'string'
    || !Array.isArray(value.items)) return false
  const identities = new Set<string>()
  return value.items.every((item) => {
    if (!isRecord(item) || !isRecord(item.identity) || !isRecord(item.source) || !isRecord(item.target) || !Array.isArray(item.conflicts)) return false
    const identity = item.identity
    const source = item.source
    const target = item.target
    if (identities.has(String(identity.identity))) return false
    identities.add(String(identity.identity))
    return identity.schemaVersion === 1 && identity.sourceType === 'ezdsh-workbench-v1'
      && typeof identity.sourceId === 'string' && typeof identity.sourceKey === 'string'
      && typeof identity.identity === 'string' && typeof identity.sourceFingerprint === 'string'
      && identity.sourceId === value.sourceId
      && typeof source.kind === 'string' && ['project', 'work-item', 'idea', 'material', 'proposal'].includes(source.kind)
      && typeof source.id === 'string' && typeof source.title === 'string'
      && (source.goal === undefined || typeof source.goal === 'string')
      && (source.acceptance === undefined || typeof source.acceptance === 'string')
      && (source.legacyStatus === undefined || typeof source.legacyStatus === 'string')
      && (source.proposedStatus === undefined || typeof source.proposedStatus === 'string')
      && (source.acceptanceEvidence === undefined || (Array.isArray(source.acceptanceEvidence) && source.acceptanceEvidence.every((entry) => typeof entry === 'string')))
      && Array.isArray(source.fileReferences) && source.fileReferences.every((entry) => typeof entry === 'string')
      && (source.projectSourceId === undefined || typeof source.projectSourceId === 'string')
      && (target.kind === 'work-item' || target.kind === 'project-context')
      && ['create', 'link', 'skip', 'conflict'].includes(String(target.action))
      && (target.targetId === undefined || typeof target.targetId === 'string')
      && item.conflicts.every((entry) => typeof entry === 'string')
  })
}

function validReceipt(value: unknown): value is WorkbenchMigrationReceipt {
  if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.identity !== 'string'
    || typeof value.sourceSnapshotHash !== 'string' || typeof value.mappingHash !== 'string'
    || typeof value.sourceFingerprint !== 'string' || typeof value.status !== 'string'
    || !['previewed', 'ready', 'applying', 'applied', 'skipped', 'conflict', 'failed', 'unknown'].includes(value.status)
    || !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 || typeof value.plannedAt !== 'string') return false
  if (value.targetId !== undefined && typeof value.targetId !== 'string') return false
  if (value.appliedAt !== undefined && typeof value.appliedAt !== 'string') return false
  return value.error === undefined || (isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string')
}

function assertState(value: unknown): State {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.plans) || !isRecord(value.receipts) || !isRecord(value.requests)) {
    throw new Error('Unsupported Workbench migration state')
  }
  if (Object.values(value.plans).some((plan) => !validPlan(plan)) || Object.values(value.receipts).some((receipt) => !validReceipt(receipt))) {
    throw new Error('Invalid Workbench migration state')
  }
  for (const [key, receiptValue] of Object.entries(value.receipts)) {
    const receipt = receiptValue as WorkbenchMigrationReceipt
    // Accept the first development snapshot keyed only by identity; new writes
    // use the source snapshot and mapping hash so a changed source can retain
    // its previous applied/unknown receipt instead of colliding with it.
    if (key !== receipt.identity && key !== keyForReceipt(receipt)) throw new Error(`Workbench migration receipt key ${key} does not match receipt identity`)
  }
  return copy(value as unknown as State)
}

export class WorkbenchMigrationStore {
  private readonly filePath: string
  private state: State = copy(EMPTY_STATE)
  private initialized = false
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly stateDirectory: string) {
    this.filePath = join(stateDirectory, 'workbench-migration.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    try {
      this.state = assertState(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = copy(EMPTY_STATE)
    }
    this.initialized = true
  }

  async stateSnapshot(): Promise<{ plans: WorkbenchMigrationPlan[]; receipts: WorkbenchMigrationReceipt[] }> {
    this.assertInitialized()
    return {
      plans: Object.values(this.state.plans).map(copy),
      receipts: Object.values(this.state.receipts).map(copy),
    }
  }

  async getPlan(sourceId: string, sourceHash: string): Promise<WorkbenchMigrationPlan | undefined> {
    this.assertInitialized()
    const plan = this.state.plans[`${sourceId}\u0000${sourceHash}`]
    return plan === undefined ? undefined : copy(plan)
  }

  async beginApply(identity: string, sourceSnapshotHash: string, mappingHash: string, allowUnknown = false): Promise<WorkbenchMigrationReceipt> {
    return this.mutate(async () => {
      const receiptKey = `${identity}\u0000${sourceSnapshotHash}\u0000${mappingHash}`
      const existing = this.state.receipts[receiptKey]
      if (existing === undefined) {
        throw new WorkbenchMigrationStoreConflictError('RECEIPT_NOT_FOUND', `Migration receipt ${identity} was not found`)
      }
      if (existing.status === 'applied' || existing.status === 'applying') return copy(existing)
      if (!['ready', 'failed'].includes(existing.status) && !(allowUnknown && existing.status === 'unknown')) {
        throw new WorkbenchMigrationStoreConflictError('INVALID_STATUS', `Migration receipt ${identity} is ${existing.status}`)
      }
      const { error: _error, ...withoutError } = existing
      const nextReceipt: WorkbenchMigrationReceipt = {
        ...withoutError,
        status: 'applying',
        attempts: existing.attempts + 1,
      }
      const next = copy(this.state)
      next.receipts[receiptKey] = nextReceipt
      await this.commit(next)
      return copy(nextReceipt)
    })
  }

  async completeApply(identity: string, sourceSnapshotHash: string, mappingHash: string, targetId: string): Promise<WorkbenchMigrationReceipt> {
    return this.mutate(async () => {
      const receiptKey = `${identity}\u0000${sourceSnapshotHash}\u0000${mappingHash}`
      const existing = this.state.receipts[receiptKey]
      if (existing === undefined) throw new WorkbenchMigrationStoreConflictError('RECEIPT_NOT_FOUND', `Migration receipt ${identity} was not found`)
      if (existing.status === 'applied') {
        if (existing.targetId !== targetId) {
          const nextReceipt: WorkbenchMigrationReceipt = {
            ...existing,
            status: 'unknown',
            error: { code: 'TARGET_CONFLICT', message: `Migration identity ${identity} resolved to a different target` },
          }
          const next = copy(this.state)
          next.receipts[receiptKey] = nextReceipt
          await this.commit(next)
          throw new WorkbenchMigrationStoreConflictError('TARGET_CONFLICT', `Migration identity ${identity} resolved to a different target`)
        }
        return copy(existing)
      }
      if (existing.status !== 'applying') throw new WorkbenchMigrationStoreConflictError('INVALID_STATUS', `Migration receipt ${identity} is ${existing.status}`)
      if (targetId.trim() === '') throw new WorkbenchMigrationStoreConflictError('TARGET_CONFLICT', 'Migration targetId must not be blank')
      const { error: _error, ...withoutError } = existing
      const nextReceipt: WorkbenchMigrationReceipt = {
        ...withoutError,
        status: 'applied',
        targetId,
        appliedAt: new Date().toISOString(),
      }
      const next = copy(this.state)
      next.receipts[receiptKey] = nextReceipt
      await this.commit(next)
      return copy(nextReceipt)
    })
  }

  async failApply(
    identity: string,
    sourceSnapshotHash: string,
    mappingHash: string,
    error: { code: string; message: string },
    status: 'failed' | 'unknown' = 'failed',
  ): Promise<WorkbenchMigrationReceipt> {
    return this.mutate(async () => {
      const receiptKey = `${identity}\u0000${sourceSnapshotHash}\u0000${mappingHash}`
      const existing = this.state.receipts[receiptKey]
      if (existing === undefined) throw new WorkbenchMigrationStoreConflictError('RECEIPT_NOT_FOUND', `Migration receipt ${identity} was not found`)
      if (existing.status === 'applied') return copy(existing)
      if (!['applying', 'failed', 'unknown'].includes(existing.status)) {
        throw new WorkbenchMigrationStoreConflictError('INVALID_STATUS', `Migration receipt ${identity} is ${existing.status}`)
      }
      const nextReceipt: WorkbenchMigrationReceipt = { ...existing, status, error }
      const next = copy(this.state)
      next.receipts[receiptKey] = nextReceipt
      await this.commit(next)
      return copy(nextReceipt)
    })
  }

  async savePreparation(
    requestId: string,
    plan: WorkbenchMigrationPlan,
    receipts: readonly WorkbenchMigrationReceipt[],
  ): Promise<WorkbenchMigrationPreparation> {
    return this.mutate(async () => {
      if (typeof requestId !== 'string' || requestId.trim() === '' || !validPlan(plan)) {
        throw new Error('Invalid Workbench migration preparation')
      }
      const planIdentities = new Set(plan.items.map((item) => item.identity.identity))
      if (receipts.length !== plan.items.length || receipts.some((receipt) => !validReceipt(receipt)
        || receipt.requestId !== requestId || !planIdentities.has(receipt.identity))) {
        throw new Error('Workbench migration receipts do not match plan')
      }
      const request = { requestId, plan, receipts }
      const requestDigest = digest(request)
      const previous = this.state.requests[requestId]
      if (previous !== undefined) {
        if (previous.digest !== requestDigest) throw new WorkbenchMigrationStoreConflictError('REQUEST_ID_CONFLICT', `Request ${requestId} was already used with different content`)
        return copy(previous.preparation)
      }
      const planKey = keyForPlan(plan)
      const existingPlan = this.state.plans[planKey]
      if (existingPlan !== undefined && existingPlan.mappingHash !== plan.mappingHash) {
        throw new WorkbenchMigrationStoreConflictError('PLAN_CONFLICT', `Plan ${plan.sourceId} has a different mapping for this source snapshot`)
      }
      const next = copy(this.state)
      next.plans[planKey] = copy(plan)
      for (const receipt of receipts) {
        const receiptKey = keyForReceipt(receipt)
        const existing = next.receipts[receiptKey]
        if (existing !== undefined
          && (existing.sourceSnapshotHash !== receipt.sourceSnapshotHash || existing.mappingHash !== receipt.mappingHash)) {
          throw new WorkbenchMigrationStoreConflictError('PLAN_CONFLICT', `Migration identity ${receipt.identity} changed its source mapping`)
        }
        const immutable = existing !== undefined && ['applying', 'applied', 'unknown'].includes(existing.status)
        next.receipts[receiptKey] = copy(immutable ? existing : receipt)
      }
      const preparation: WorkbenchMigrationPreparation = {
        requestId,
        plan: copy(plan),
        receipts: receipts.map((receipt) => copy(next.receipts[keyForReceipt(receipt)])),
        stale: false,
        message: 'Migration plan is durably recorded; eligible Work Items can be applied one at a time.',
      }
      next.requests[requestId] = { digest: requestDigest, preparation: copy(preparation) }
      await this.commit(next)
      return copy(preparation)
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized()
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(next: State): Promise<void> {
    const temporaryPath = `${this.filePath}.${Date.now()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await rename(temporaryPath, this.filePath)
      this.state = next
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkbenchMigrationStore must be initialized before use')
  }
}
