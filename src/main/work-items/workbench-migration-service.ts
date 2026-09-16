import { createHash } from 'node:crypto'

import {
  previewWorkbenchImport,
  type WorkbenchImportCandidate,
  type WorkbenchImportPreview,
} from './workbench-import.js'
import { WorkbenchMigrationStore } from './workbench-migration-store.js'
import type {
  WorkbenchMigrationIdentity,
  WorkbenchMigrationApplyRequest,
  WorkbenchMigrationApplyResult,
  WorkbenchMigrationReport,
  WorkbenchMigrationReportItem,
  WorkbenchMigrationReportRequest,
  WorkbenchMigrationPlan,
  WorkbenchMigrationPlanItem,
  WorkbenchMigrationPreparation,
  WorkbenchMigrationPreparationRequest,
  WorkbenchMigrationReceipt,
  WorkbenchMigrationState,
} from '../../shared/workbench-migration.js'
import type { WorkTaskCreateRequest, WorkTaskSnapshot } from '../../shared/work-items.js'

export class WorkbenchMigrationServiceError extends Error {
  readonly code: 'INVALID_REQUEST' | 'SOURCE_CHANGED' | 'PLAN_NOT_FOUND' | 'ITEM_NOT_APPLICABLE' | 'TARGET_WRITER_UNAVAILABLE'

  constructor(code: WorkbenchMigrationServiceError['code'], message: string) {
    super(message)
    this.name = 'WorkbenchMigrationServiceError'
    this.code = code
  }
}

export class WorkbenchMigrationService {
  constructor(
    private readonly store: WorkbenchMigrationStore,
    private readonly targetWriter?: { createWorkItem(input: WorkTaskCreateRequest): Promise<WorkTaskSnapshot> },
  ) {}

  initialize(): Promise<void> {
    return this.store.initialize()
  }

  preview(sourceDirectory: string): Promise<WorkbenchImportPreview> {
    if (typeof sourceDirectory !== 'string' || sourceDirectory.trim() === '') {
      throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '旧 Workbench 路径不能为空')
    }
    return previewWorkbenchImport(sourceDirectory.trim())
  }

  async prepare(request: WorkbenchMigrationPreparationRequest): Promise<WorkbenchMigrationPreparation> {
    validateRequest(request)
    const current = await this.preview(request.sourceDirectory)
    if (current.sourceId !== request.sourceId || current.sourceHash !== request.sourceHash) {
      const plan = buildPlan(current)
      return {
        requestId: request.requestId,
        plan,
        receipts: [],
        stale: true,
        message: '旧 Workbench 源数据在确认期间发生变化，请重新预览后再生成计划。',
      }
    }
    const plan = buildPlan(current)
    const selected = new Set(request.confirmedSourceKeys)
    const previous = await this.store.stateSnapshot()
    const previousByIdentity = new Map(previous.receipts
      .filter((receipt) => receipt.sourceSnapshotHash === plan.sourceHash && receipt.mappingHash === plan.mappingHash)
      .map((receipt) => [receipt.identity, receipt]))
    const receipts = plan.items.map((item) => {
      const previousReceipt = previousByIdentity.get(item.identity.identity)
      const status = item.conflicts.length > 0
        ? 'conflict' as const
        : item.source.kind === 'project'
          ? item.target.action === 'link' ? 'ready' as const : 'skipped' as const
          : selected.has(item.identity.sourceKey) || selected.has(baseSourceKey(item.identity.sourceKey)) ? 'ready' as const : 'skipped' as const
      const receipt: WorkbenchMigrationReceipt = {
        requestId: request.requestId,
        identity: item.identity.identity,
        sourceSnapshotHash: plan.sourceHash,
        mappingHash: plan.mappingHash,
        sourceFingerprint: item.identity.sourceFingerprint,
        status,
        ...(item.target.targetId === undefined ? {} : { targetId: item.target.targetId }),
        attempts: previousReceipt?.attempts ?? 0,
        plannedAt: previousReceipt?.plannedAt ?? new Date().toISOString(),
        ...(item.conflicts.length === 0 ? {} : {
          error: { code: 'SOURCE_CONFLICT', message: item.conflicts.join('；') },
        }),
      }
      return receipt
    })
    return this.store.savePreparation(request.requestId, plan, receipts)
  }

  async state(): Promise<WorkbenchMigrationState> {
    return this.store.stateSnapshot()
  }

  async report(request: WorkbenchMigrationReportRequest): Promise<WorkbenchMigrationReport> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '迁移报告请求无效')
    }
    if (Object.keys(request as unknown as Record<string, unknown>).some((key) => !['sourceId', 'sourceHash', 'mappingHash'].includes(key))) {
      throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '迁移报告请求包含未知字段')
    }
    const { sourceId, sourceHash, mappingHash } = request
    for (const [name, value] of [['sourceId', sourceId], ['sourceHash', sourceHash], ['mappingHash', mappingHash]] as const) {
      if (typeof value !== 'string' || value.trim() === '') throw new WorkbenchMigrationServiceError('INVALID_REQUEST', `${name} 无效`)
    }
    const plan = await this.store.getPlan(sourceId, sourceHash)
    if (plan === undefined) throw new WorkbenchMigrationServiceError('PLAN_NOT_FOUND', '找不到对应的迁移计划')
    if (plan.mappingHash !== mappingHash) throw new WorkbenchMigrationServiceError('SOURCE_CHANGED', '迁移映射已变化，请重新生成报告')
    const snapshot = await this.store.stateSnapshot()
    const receipts = new Map(snapshot.receipts
      .filter((receipt) => receipt.sourceSnapshotHash === sourceHash && receipt.mappingHash === mappingHash)
      .map((receipt) => [receipt.identity, receipt]))
    const statuses: Array<keyof WorkbenchMigrationReport['counts']> = ['previewed', 'ready', 'applying', 'applied', 'skipped', 'conflict', 'failed', 'unknown', 'missing']
    const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as WorkbenchMigrationReport['counts']
    const items = plan.items.map((item) => {
      const receipt = receipts.get(item.identity.identity)
      const status: WorkbenchMigrationReportItem['status'] = receipt?.status ?? 'missing'
      counts[status] += 1
      return {
        identity: item.identity.identity,
        sourceKey: item.identity.sourceKey,
        title: item.source.title,
        action: item.target.action,
        status,
        ...(receipt?.targetId === undefined ? {} : { targetId: receipt.targetId }),
        ...(receipt?.error === undefined ? {} : { error: receipt.error }),
      }
    })
    return { schemaVersion: 1, sourceId, sourceHash, mappingHash, generatedAt: new Date().toISOString(), counts, items }
  }

  async apply(request: WorkbenchMigrationApplyRequest): Promise<WorkbenchMigrationApplyResult> {
    validateApplyRequest(request)
    if (this.targetWriter === undefined) {
      throw new WorkbenchMigrationServiceError('TARGET_WRITER_UNAVAILABLE', '工作项迁移写入器尚未就绪')
    }
    const plan = await this.store.getPlan(request.sourceId, request.sourceSnapshotHash)
    if (plan === undefined) {
      throw new WorkbenchMigrationServiceError('PLAN_NOT_FOUND', '找不到对应的迁移计划，请重新预览并保存确认计划')
    }
    if (plan.mappingHash !== request.mappingHash) {
      throw new WorkbenchMigrationServiceError('SOURCE_CHANGED', '迁移映射已变化，请重新预览并保存确认计划')
    }
    const item = plan.items.find((candidate) => candidate.identity.identity === request.identity)
    if (item === undefined || item.target.kind !== 'work-item' || item.target.action !== 'create' || item.conflicts.length > 0) {
      throw new WorkbenchMigrationServiceError('ITEM_NOT_APPLICABLE', '该迁移项存在冲突或不是可创建的工作项')
    }
    const current = await this.preview(plan.sourceDirectory)
    const currentPlan = buildPlan(current)
    const currentItem = currentPlan.items.find((candidate) => candidate.identity.identity === request.identity)
    if (current.sourceId !== plan.sourceId || current.sourceHash !== plan.sourceHash
      || currentPlan.mappingHash !== plan.mappingHash || currentItem?.identity.sourceFingerprint !== item.identity.sourceFingerprint) {
      throw new WorkbenchMigrationServiceError('SOURCE_CHANGED', '旧 Workbench 源数据已变化，请重新预览并保存确认计划')
    }
    const begun = await this.store.beginApply(item.identity.identity, plan.sourceHash, plan.mappingHash, request.allowUnknown === true)
    if (begun.status === 'applied') return { receipt: begun, targetId: begun.targetId }
    const createRequest = buildCreateRequest(plan, item)
    try {
      const snapshot = await this.targetWriter.createWorkItem(createRequest)
      const receipt = await this.store.completeApply(item.identity.identity, plan.sourceHash, plan.mappingHash, snapshot.task.id)
      return { receipt, targetId: snapshot.task.id }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.store.failApply(item.identity.identity, plan.sourceHash, plan.mappingHash, { code: 'TARGET_CREATE_FAILED', message: detail }).catch(() => undefined)
      throw error
    }
  }
}

function validateRequest(request: WorkbenchMigrationPreparationRequest): void {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '迁移计划请求无效')
  }
  const value = request as unknown as Record<string, unknown>
  const allowedKeys = ['requestId', 'sourceDirectory', 'sourceId', 'sourceHash', 'confirmedSourceKeys']
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '迁移计划请求包含未知字段')
  }
  for (const key of ['requestId', 'sourceDirectory', 'sourceId', 'sourceHash']) {
    const field = value[key]
    if (typeof field !== 'string' || field.trim() === '' || field.length > 4_096) {
      throw new WorkbenchMigrationServiceError('INVALID_REQUEST', `${key} 无效`)
    }
  }
  const confirmed = value.confirmedSourceKeys
  if (!Array.isArray(confirmed) || confirmed.length > 10_000
    || confirmed.some((entry) => typeof entry !== 'string' || entry.trim() === '' || entry.length > 4_096)
    || new Set(confirmed).size !== confirmed.length) {
    throw new WorkbenchMigrationServiceError('INVALID_REQUEST', 'confirmedSourceKeys 无效')
  }
}

function validateApplyRequest(request: WorkbenchMigrationApplyRequest): void {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '迁移 Apply 请求无效')
  }
  const value = request as unknown as Record<string, unknown>
  const allowedKeys = ['requestId', 'identity', 'sourceId', 'sourceSnapshotHash', 'mappingHash', 'allowUnknown']
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new WorkbenchMigrationServiceError('INVALID_REQUEST', '迁移 Apply 请求包含未知字段')
  }
  for (const key of ['requestId', 'identity', 'sourceId', 'sourceSnapshotHash', 'mappingHash']) {
    const field = value[key]
    if (typeof field !== 'string' || field.trim() === '' || field.length > 4_096) {
      throw new WorkbenchMigrationServiceError('INVALID_REQUEST', `${key} 无效`)
    }
  }
  if (value.allowUnknown !== undefined && typeof value.allowUnknown !== 'boolean') {
    throw new WorkbenchMigrationServiceError('INVALID_REQUEST', 'allowUnknown 无效')
  }
}

function buildCreateRequest(plan: WorkbenchMigrationPlan, item: WorkbenchMigrationPlanItem): WorkTaskCreateRequest {
  const source = item.source
  const projectId = source.projectSourceId === undefined
    ? undefined
    : plan.items.find((candidate) => candidate.source.kind === 'project'
      && candidate.source.id === source.projectSourceId
      && candidate.target.targetId !== undefined)?.target.targetId
  const title = source.title.trim() || source.id
  const goal = source.goal?.trim() || `Imported from legacy Workbench record ${source.id}.`
  const acceptance = source.acceptance?.trim() || 'Review this imported Work Item and confirm its acceptance criteria.'
  return {
    requestId: `workbench-import-create-${sha256(item.identity.identity).slice(0, 32)}`,
    title,
    goal,
    acceptance,
    scope: {
      ...(projectId === undefined ? {} : { projectId }),
      resourceRefs: [...source.fileReferences],
    },
  }
}

function buildPlan(preview: WorkbenchImportPreview): WorkbenchMigrationPlan {
  const items: WorkbenchMigrationPlanItem[] = []
  const sourceKeyOccurrences = new Map<string, number>()
  for (const project of preview.projects) {
    const baseSourceKey = `project:${project.sourceId}`
    const occurrence = (sourceKeyOccurrences.get(baseSourceKey) ?? 0) + 1
    sourceKeyOccurrences.set(baseSourceKey, occurrence)
    const sourceKey = occurrence === 1 ? baseSourceKey : `${baseSourceKey}:duplicate-${occurrence}`
    const identity = makeIdentity(preview.sourceId, sourceKey, project.contentHash)
    const conflicts = preview.conflicts
      .filter((conflict) => conflict.sourceKey === baseSourceKey || conflict.sourceKey.startsWith(`${baseSourceKey}:`))
      .map((conflict) => conflict.detail)
    if (occurrence > 1 && !conflicts.some((detail) => detail.includes('duplicate'))) {
      conflicts.push(`源记录 ${baseSourceKey} 出现重复，必须先在旧 Workbench 中消除重复身份。`)
    }
    items.push({
      identity,
      source: { kind: 'project', id: project.sourceId, title: project.name, fileReferences: [] },
      target: {
        kind: 'project-context',
        action: project.projectRef === undefined ? 'skip' : 'link',
        ...(project.projectRef === undefined ? {} : { targetId: project.projectRef }),
      },
      conflicts: [
        ...(project.projectRef === undefined ? ['项目没有可链接的 EzDSH projectId，当前只读项目上下文不能新建项目实体。'] : []),
        ...conflicts,
      ],
    })
  }
  for (const candidate of preview.candidates) {
    const occurrence = (sourceKeyOccurrences.get(candidate.sourceKey) ?? 0) + 1
    sourceKeyOccurrences.set(candidate.sourceKey, occurrence)
    const identitySourceKey = occurrence === 1 ? candidate.sourceKey : `${candidate.sourceKey}:duplicate-${occurrence}`
    const identity = makeIdentity(preview.sourceId, identitySourceKey, candidate.contentHash)
    const conflicts = preview.conflicts
      .filter((conflict) => affectsCandidate(conflict.sourceKey, candidate))
      .map((conflict) => conflict.detail)
    if (occurrence > 1 && !conflicts.some((detail) => detail.includes('duplicate'))) {
      conflicts.push(`源记录 ${candidate.sourceKey} 出现重复，必须先在旧 Workbench 中消除重复身份。`)
    }
    items.push({
      identity,
      source: {
        kind: candidate.kind === 'task' ? 'work-item' : 'idea',
        id: candidate.legacyId,
        title: candidate.title,
        goal: candidate.goal,
        acceptance: candidate.acceptance,
        legacyStatus: candidate.originalStatus,
        proposedStatus: candidate.proposedStatus,
        acceptanceEvidence: [...candidate.acceptanceEvidence],
        ...(candidate.projectSourceId === undefined ? {} : { projectSourceId: candidate.projectSourceId }),
        fileReferences: [...candidate.fileReferences],
      },
      target: { kind: 'work-item', action: conflicts.length === 0 ? 'create' : 'conflict' },
      conflicts,
    })
  }
  const mappingHash = sha256(stableStringify(items))
  return {
    schemaVersion: 1,
    sourceId: preview.sourceId,
    sourceHash: preview.sourceHash,
    sourceDirectory: preview.sourceDirectory,
    mappingHash,
    generatedAt: new Date().toISOString(),
    items,
  }
}

function makeIdentity(sourceId: string, sourceKey: string, sourceFingerprint: string): WorkbenchMigrationIdentity {
  return {
    schemaVersion: 1,
    sourceType: 'ezdsh-workbench-v1',
    sourceId,
    sourceKey,
    identity: `workbench-import-${sha256(`${sourceId}\u0000${sourceKey}`).slice(0, 24)}`,
    sourceFingerprint,
  }
}

function affectsCandidate(sourceKey: string, candidate: WorkbenchImportCandidate): boolean {
  return sourceKey === candidate.sourceKey
    || sourceKey.startsWith(`${candidate.sourceKey}:`)
    || candidate.fileReferences.some((reference) => sourceKey.includes(reference))
}

function baseSourceKey(sourceKey: string): string {
  return sourceKey.replace(/:duplicate-\d+$/u, '')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
