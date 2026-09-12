import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { verifyWorkflowReleaseIntegrity } from './workflow-release-integrity.js'
import { normalizeWorkflowRelease, type WorkflowRelease } from '../../shared/workflow-operations.js'
import { cloneWorkflow } from '../../shared/workflow.js'

const FILE_NAME = 'workflow-releases.json'
const INTEGRITY_FILE_NAME = 'workflow-release-integrity-failures.json'
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export interface WorkflowReleaseStoreOptions {
  now?: () => string
}

export interface WorkflowReleaseRollbackResult {
  restored: WorkflowRelease
  rolledBack: WorkflowRelease
}

/** Safe identity-only evidence for a persisted release rejected during integrity validation. */
export interface WorkflowReleaseIntegrityFailure {
  id: string
  environmentId: string
  workflowId: string
  /** Zero means the rejected source had no valid positive revision. Never copy its raw value. */
  workflowRevision: number
  status: WorkflowRelease['status']
  detectedAt: string
  reason: 'digest-mismatch' | 'invalid-release' | 'duplicate-release-id'
}

interface WorkflowReleaseIntegrityResolution {
  workflowId: string
  environmentId: string
  releaseId: string
  kind: 'publish' | 'rollback'
  startedAt: string
}

/** Store-owned fields remain optional for callers and are always replaced by the trusted store clock. */
export type WorkflowReleasePublishRecord = Omit<WorkflowRelease, 'activation' | 'createdAt' | 'publishedAt'>
  & Partial<Pick<WorkflowRelease, 'activation' | 'createdAt' | 'publishedAt'>>

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function statusRank(status: WorkflowRelease['status']): number {
  switch (status) {
    case 'published': return 0
    case 'rolled-back': return 1
    case 'superseded': return 2
  }
}

function cloneRelease(release: WorkflowRelease): WorkflowRelease {
  return {
    id: release.id,
    environmentId: release.environmentId,
    workflowId: release.workflowId,
    workflowRevision: release.workflowRevision,
    contentSha256: release.contentSha256,
    workflowSnapshot: cloneWorkflow(release.workflowSnapshot),
    ...(release.workflowDependencies === undefined ? {} : { workflowDependencies: release.workflowDependencies.map((dependency) => cloneWorkflow(dependency)) }),
    status: release.status,
    connectorGrants: release.connectorGrants.map((grant) => ({ connectorId: grant.connectorId, operations: [...grant.operations] })),
    createdAt: release.createdAt,
    publishedAt: release.publishedAt,
    ...(release.activation === undefined ? {} : { activation: { ...release.activation } }),
  }
}

function releaseIntegrityFailure(
  release: WorkflowRelease,
  detectedAt: string,
  reason: WorkflowReleaseIntegrityFailure['reason'],
): WorkflowReleaseIntegrityFailure {
  return {
    id: release.id,
    environmentId: release.environmentId,
    workflowId: release.workflowId,
    workflowRevision: safeIntegrityRevision(release.workflowRevision),
    status: release.status,
    detectedAt,
    reason,
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(filePath))
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

function normalizeVerifiedRelease(value: unknown): WorkflowRelease | undefined {
  const release = normalizeWorkflowRelease(value)
  if (release === undefined) return undefined
  return verifyWorkflowReleaseIntegrity(release) ? release : undefined
}

export class WorkflowReleaseStore {
  private readonly filePath: string
  private readonly integrityFilePath: string
  private readonly now: () => string
  private readonly releases = new Map<string, WorkflowRelease>()
  private readonly integrityFailures = new Map<string, WorkflowReleaseIntegrityFailure>()
  private pendingIntegrityResolution: WorkflowReleaseIntegrityResolution | undefined
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(stateDir: string, options: WorkflowReleaseStoreOptions = {}) {
    this.filePath = join(stateDir, FILE_NAME)
    this.integrityFilePath = join(stateDir, INTEGRITY_FILE_NAME)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await ensurePrivateDirectory(dirname(this.filePath))
      this.releases.clear()
      this.integrityFailures.clear()
      this.pendingIntegrityResolution = undefined
      await this.loadIntegrityFailures()
      let integrityChanged = false
      const integrityTargetsDetectedFromReleaseFile = new Set<string>()
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        const entries = Array.isArray(parsed)
          ? parsed
          : isRecord(parsed) && Array.isArray(parsed.releases)
            ? parsed.releases
            : []
        const releaseIdCounts = new Map<string, number>()
        for (const value of entries) {
          const id = safeReleaseId(value)
          if (id !== undefined) releaseIdCounts.set(id, (releaseIdCounts.get(id) ?? 0) + 1)
        }
        for (const value of entries) {
          const identity = safeReleaseIdentity(value)
          const duplicateId = safeReleaseId(value)
          const isDuplicate = duplicateId !== undefined && (releaseIdCounts.get(duplicateId) ?? 0) > 1
          const release = isDuplicate ? undefined : normalizeWorkflowRelease(value)
          if (release !== undefined && verifyWorkflowReleaseIntegrity(release)) {
            this.releases.set(release.id, cloneRelease(release))
          } else {
            const failure = isDuplicate
              ? identity === undefined ? undefined : { ...identity, detectedAt: this.now(), reason: 'duplicate-release-id' as const }
              : release === undefined
                ? releaseIntegrityFailureFromUnknown(value, this.now())
              : releaseIntegrityFailure(release, this.now(), 'digest-mismatch')
            if (failure !== undefined) {
              integrityTargetsDetectedFromReleaseFile.add(releaseTargetKey(failure.workflowId, failure.environmentId))
              const key = integrityFailureKey(failure)
              const previous = this.integrityFailures.get(key)
              const next = previous !== undefined && sameIntegrityFailureIdentity(previous, failure)
                ? { ...failure, detectedAt: previous.detectedAt }
                : failure
              this.integrityFailures.set(key, next)
              integrityChanged = previous === undefined || JSON.stringify(previous) !== JSON.stringify(next) || integrityChanged
            }
          }
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      const pendingResolution = this.pendingIntegrityResolution as WorkflowReleaseIntegrityResolution | undefined
      if (pendingResolution !== undefined) {
        const resolved = this.releases.get(pendingResolution.releaseId)
        const target = releaseTargetKey(pendingResolution.workflowId, pendingResolution.environmentId)
        if (resolved?.status === 'published'
          && resolved.workflowId === pendingResolution.workflowId
          && resolved.environmentId === pendingResolution.environmentId
          && resolved.activation?.kind === pendingResolution.kind
          && resolved.activation.at === pendingResolution.startedAt
          && !integrityTargetsDetectedFromReleaseFile.has(target)) {
          integrityChanged = this.clearPublishedIntegrityFailures(pendingResolution.workflowId, pendingResolution.environmentId) || integrityChanged
        }
        this.pendingIntegrityResolution = undefined
        integrityChanged = true
      }
      if (integrityChanged) await this.persistIntegrityFailures()
      this.initialized = true
    })()
    this.initializationPromise = pending
    try {
      await pending
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined
    }
  }

  list(): WorkflowRelease[] {
    return Array.from(this.releases.values())
      .sort((left, right) => {
        const byStatus = statusRank(left.status) - statusRank(right.status)
        if (byStatus !== 0) return byStatus
        const byPublishedAt = right.publishedAt.localeCompare(left.publishedAt)
        if (byPublishedAt !== 0) return byPublishedAt
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt)
        if (byCreatedAt !== 0) return byCreatedAt
        return right.id.localeCompare(left.id)
      })
      .map(cloneRelease)
  }

  listIntegrityFailures(): WorkflowReleaseIntegrityFailure[] {
    return Array.from(this.integrityFailures.values())
      .sort((left, right) => integrityFailureKey(left).localeCompare(integrityFailureKey(right)))
      .map((failure) => ({ ...failure }))
  }

  get(id: string): WorkflowRelease | undefined {
    const release = this.releases.get(id)
    return release === undefined ? undefined : cloneRelease(release)
  }

  async publish(input: WorkflowReleasePublishRecord): Promise<WorkflowRelease> {
    await this.initialize()
    if (input.status !== 'published') throw new Error('Workflow release publish input must have published status')
    return this.mutate(async () => {
      const timestamp = this.now()
      const normalized = normalizeVerifiedRelease({
        ...input,
        status: 'published',
        createdAt: timestamp,
        publishedAt: timestamp,
        activation: { kind: 'publish', at: timestamp },
      })
      if (normalized === undefined) throw new Error('Invalid workflow release or failed integrity verification')
      if (this.releases.has(normalized.id)) throw new Error('Workflow release id already exists')
      const resolvesIntegrityFailure = this.hasPublishedIntegrityFailure(normalized.workflowId, normalized.environmentId)
      if (resolvesIntegrityFailure) {
        this.pendingIntegrityResolution = {
          workflowId: normalized.workflowId,
          environmentId: normalized.environmentId,
          releaseId: normalized.id,
          kind: 'publish',
          startedAt: timestamp,
        }
        await this.persistIntegrityFailures()
      }
      const nextReleases = new Map(this.list().map((release) => [release.id, release]))
      for (const release of nextReleases.values()) {
        if (release.id === normalized.id) continue
        if (release.workflowId === normalized.workflowId && release.environmentId === normalized.environmentId && release.status === 'published') {
          release.status = 'superseded'
        }
      }
      nextReleases.set(normalized.id, cloneRelease(normalized))
      await this.persist([...nextReleases.values()])
      this.releases.clear()
      for (const [id, release] of nextReleases) this.releases.set(id, release)
      if (resolvesIntegrityFailure) {
        await this.persistIntegrityFailures(normalized)
        this.clearPublishedIntegrityFailures(normalized.workflowId, normalized.environmentId)
        this.pendingIntegrityResolution = undefined
      }
      return cloneRelease(normalized)
    })
  }

  async rollback(id: string): Promise<WorkflowReleaseRollbackResult> {
    await this.initialize()
    return this.mutate(async () => {
      const target = this.releases.get(id)
      const normalizedTarget = target === undefined ? undefined : normalizeVerifiedRelease(target)
      if (normalizedTarget === undefined) throw new Error('Release not found or failed integrity verification')
      if (normalizedTarget.status !== 'superseded') throw new Error('Rollback target must be a superseded workflow release')
      if (target === undefined) throw new Error('Release not found or failed integrity verification')

      const current = Array.from(this.releases.values()).find((release) =>
        release.id !== normalizedTarget.id
        && release.workflowId === normalizedTarget.workflowId
        && release.environmentId === normalizedTarget.environmentId
        && release.status === 'published')
      if (current === undefined) throw new Error('Rollback requires a current published workflow release')

      const timestamp = this.now()
      const restored = normalizeVerifiedRelease({
        ...target,
        status: 'published',
        activation: { kind: 'rollback', at: timestamp, previousReleaseId: current.id },
      })
      const rolledBack = normalizeVerifiedRelease({ ...current, status: 'rolled-back' })
      if (restored === undefined || rolledBack === undefined) throw new Error('Invalid workflow release activation or failed integrity verification')
      const resolvesIntegrityFailure = this.hasPublishedIntegrityFailure(restored.workflowId, restored.environmentId)
      if (resolvesIntegrityFailure) {
        this.pendingIntegrityResolution = {
          workflowId: restored.workflowId,
          environmentId: restored.environmentId,
          releaseId: restored.id,
          kind: 'rollback',
          startedAt: timestamp,
        }
        await this.persistIntegrityFailures()
      }
      const nextReleases = new Map(this.list().map((release) => [release.id, release]))
      nextReleases.set(restored.id, cloneRelease(restored))
      nextReleases.set(rolledBack.id, cloneRelease(rolledBack))
      await this.persist([...nextReleases.values()])
      this.releases.clear()
      for (const [releaseId, release] of nextReleases) this.releases.set(releaseId, release)
      if (resolvesIntegrityFailure) {
        await this.persistIntegrityFailures(restored)
        this.clearPublishedIntegrityFailures(restored.workflowId, restored.environmentId)
        this.pendingIntegrityResolution = undefined
      }
      return {
        restored: cloneRelease(restored),
        rolledBack: cloneRelease(rolledBack),
      }
    })
  }

  private async persist(releases: WorkflowRelease[]): Promise<void> {
    await atomicWriteJson(this.filePath, {
      version: 1,
      releases: releases.map(cloneRelease),
    })
  }

  private async loadIntegrityFailures(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.integrityFilePath, 'utf8')) as unknown
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.failures) || Object.keys(parsed).some((key) => key !== 'version' && key !== 'failures' && key !== 'pendingResolution')) {
        throw new Error('Workflow release integrity ledger is invalid')
      }
      for (const value of parsed.failures) {
        const failure = normalizeReleaseIntegrityFailure(value)
        const key = failure === undefined ? undefined : integrityFailureKey(failure)
        if (failure === undefined || key === undefined || this.integrityFailures.has(key)) throw new Error('Workflow release integrity ledger is invalid')
        this.integrityFailures.set(key, failure)
      }
      if (parsed.pendingResolution !== undefined) {
        const pendingResolution = normalizeIntegrityResolution(parsed.pendingResolution)
        if (pendingResolution === undefined) throw new Error('Workflow release integrity ledger is invalid')
        this.pendingIntegrityResolution = pendingResolution
      }
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof Error && /integrity ledger/i.test(error.message)) throw error
        throw new Error('Workflow release integrity ledger is invalid', { cause: error })
      }
    }
  }

  private async persistIntegrityFailures(resolvedTarget?: { workflowId: string; environmentId: string }): Promise<void> {
    const failures = this.listIntegrityFailures().filter((failure) => !(resolvedTarget !== undefined
      && failure.workflowId === resolvedTarget.workflowId && failure.environmentId === resolvedTarget.environmentId
      && failure.status === 'published'))
    await atomicWriteJson(this.integrityFilePath, {
      version: 1,
      failures,
      ...(resolvedTarget !== undefined || this.pendingIntegrityResolution === undefined ? {} : { pendingResolution: { ...this.pendingIntegrityResolution } }),
    })
  }

  private clearPublishedIntegrityFailures(workflowId: string, environmentId: string): boolean {
    let changed = false
    for (const [key, failure] of this.integrityFailures) {
      if (failure.workflowId === workflowId && failure.environmentId === environmentId && failure.status === 'published') {
        this.integrityFailures.delete(key)
        changed = true
      }
    }
    return changed
  }

  private hasPublishedIntegrityFailure(workflowId: string, environmentId: string): boolean {
    return Array.from(this.integrityFailures.values()).some((failure) => (
      failure.workflowId === workflowId && failure.environmentId === environmentId && failure.status === 'published'
    ))
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation)
    this.mutationChain = result.then(() => undefined, () => undefined)
    return result
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeReleaseIdentity(value: unknown): Omit<WorkflowReleaseIntegrityFailure, 'detectedAt' | 'reason'> | undefined {
  if (!isRecord(value)) return undefined
  const id = safeId(value.id)
  const workflowId = safeId(value.workflowId)
  const environmentId = safeId(value.environmentId)
  if (id === undefined || workflowId === undefined || environmentId === undefined) return undefined
  const workflowRevision = safeIntegrityRevision(value.workflowRevision)
  if (value.status !== 'published' && value.status !== 'superseded' && value.status !== 'rolled-back') return undefined
  return {
    id,
    workflowId,
    environmentId,
    workflowRevision,
    status: value.status,
  }
}

function safeIntegrityRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 0
}

function safeReleaseId(value: unknown): string | undefined {
  return isRecord(value) ? safeId(value.id) : undefined
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return RELEASE_ID_PATTERN.test(id) ? id : undefined
}

function releaseIntegrityFailureFromUnknown(value: unknown, detectedAt: string): WorkflowReleaseIntegrityFailure | undefined {
  const identity = safeReleaseIdentity(value)
  return identity === undefined ? undefined : { ...identity, detectedAt, reason: 'invalid-release' }
}

function normalizeReleaseIntegrityFailure(value: unknown): WorkflowReleaseIntegrityFailure | undefined {
  if (!isRecord(value)) return undefined
  const knownKeys = new Set(['id', 'workflowId', 'environmentId', 'workflowRevision', 'status', 'detectedAt', 'reason'])
  if (Object.keys(value).some((key) => !knownKeys.has(key))) return undefined
  // The persisted sidecar accepts only our numeric sentinel or a safe revision,
  // rather than normalizing arbitrary malformed sidecar payloads on reload.
  if (typeof value.workflowRevision !== 'number' || !Number.isSafeInteger(value.workflowRevision) || value.workflowRevision < 0) return undefined
  const identity = safeReleaseIdentity(value)
  if (identity === undefined || typeof value.detectedAt !== 'string' || Number.isNaN(Date.parse(value.detectedAt))) return undefined
  if (value.reason !== 'digest-mismatch' && value.reason !== 'invalid-release' && value.reason !== 'duplicate-release-id') return undefined
  return { ...identity, detectedAt: value.detectedAt, reason: value.reason }
}

function normalizeIntegrityResolution(value: unknown): WorkflowReleaseIntegrityResolution | undefined {
  if (!isRecord(value)) return undefined
  const knownKeys = new Set(['workflowId', 'environmentId', 'releaseId', 'kind', 'startedAt'])
  if (Object.keys(value).some((key) => !knownKeys.has(key))) return undefined
  if (typeof value.workflowId !== 'string' || !RELEASE_ID_PATTERN.test(value.workflowId)) return undefined
  if (typeof value.environmentId !== 'string' || !RELEASE_ID_PATTERN.test(value.environmentId)) return undefined
  if (typeof value.releaseId !== 'string' || !RELEASE_ID_PATTERN.test(value.releaseId)) return undefined
  if (value.kind !== 'publish' && value.kind !== 'rollback') return undefined
  if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) return undefined
  return {
    workflowId: value.workflowId,
    environmentId: value.environmentId,
    releaseId: value.releaseId,
    kind: value.kind,
    startedAt: value.startedAt,
  }
}

function sameIntegrityFailureIdentity(left: WorkflowReleaseIntegrityFailure, right: WorkflowReleaseIntegrityFailure): boolean {
  return left.id === right.id
    && left.workflowId === right.workflowId
    && left.environmentId === right.environmentId
    && left.workflowRevision === right.workflowRevision
    && left.status === right.status
    && left.reason === right.reason
}

function integrityFailureKey(failure: Omit<WorkflowReleaseIntegrityFailure, 'detectedAt' | 'reason'>): string {
  return `${failure.id}\u0000${failure.workflowId}\u0000${failure.environmentId}\u0000${failure.workflowRevision}\u0000${failure.status}`
}

function releaseTargetKey(workflowId: string, environmentId: string): string {
  return `${workflowId}\u0000${environmentId}`
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}
