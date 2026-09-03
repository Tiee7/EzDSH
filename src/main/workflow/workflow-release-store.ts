import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { verifyWorkflowReleaseIntegrity } from './workflow-release-integrity.js'
import { normalizeWorkflowRelease, type WorkflowRelease } from '../../shared/workflow-operations.js'
import { cloneWorkflow } from '../../shared/workflow.js'

const FILE_NAME = 'workflow-releases.json'

export interface WorkflowReleaseStoreOptions {
  now?: () => string
}

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
  private readonly now: () => string
  private readonly releases = new Map<string, WorkflowRelease>()
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(stateDir: string, options: WorkflowReleaseStoreOptions = {}) {
    this.filePath = join(stateDir, FILE_NAME)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await ensurePrivateDirectory(dirname(this.filePath))
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        const entries = Array.isArray(parsed)
          ? parsed
          : isRecord(parsed) && Array.isArray(parsed.releases)
            ? parsed.releases
            : []
        this.releases.clear()
        for (const value of entries) {
          const release = normalizeVerifiedRelease(value)
          if (release !== undefined) this.releases.set(release.id, cloneRelease(release))
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
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

  get(id: string): WorkflowRelease | undefined {
    const release = this.releases.get(id)
    return release === undefined ? undefined : cloneRelease(release)
  }

  async publish(input: WorkflowRelease): Promise<WorkflowRelease> {
    await this.initialize()
    if (input.status !== 'published') throw new Error('Workflow release publish input must have published status')
    const timestamp = this.now()
    const normalized = normalizeVerifiedRelease({
      ...input,
      status: 'published',
      createdAt: timestamp,
      publishedAt: timestamp,
    })
    if (normalized === undefined) throw new Error('Invalid workflow release or failed integrity verification')
    return this.mutate(async () => {
      if (this.releases.has(normalized.id)) throw new Error('Workflow release id already exists')
      for (const release of this.releases.values()) {
        if (release.id === normalized.id) continue
        if (release.workflowId === normalized.workflowId && release.environmentId === normalized.environmentId && release.status === 'published') {
          release.status = 'superseded'
        }
      }
      this.releases.set(normalized.id, cloneRelease(normalized))
      await this.persist()
      return cloneRelease(normalized)
    })
  }

  async rollback(id: string): Promise<WorkflowRelease> {
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

      current.status = 'rolled-back'
      target.status = 'published'
      await this.persist()
      return cloneRelease(target)
    })
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, {
      version: 1,
      releases: this.list().map((release) => cloneRelease(release)),
    })
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

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}
