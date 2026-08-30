import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export type WorkflowInternalSessionKind = 'employee' | 'skill'

export interface WorkflowInternalSessionRecord {
  sessionId: string
  runId: string
  workflowId: string
  kind: WorkflowInternalSessionKind
  nodeId?: string
  employeeId?: string
  createdAt: string
  archivedAt?: string
  retentionExpiresAt?: string
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tempPath, filePath)
}

/** Durable registry of DSH sessions that belong exclusively to workflow internals. */
export class WorkflowInternalSessionStore {
  private readonly filePath: string
  private readonly sessions = new Map<string, WorkflowInternalSessionRecord>()
  private initialized = false

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'workflow-internal-sessions.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          const session = readRecord(value)
          if (session !== undefined) this.sessions.set(session.sessionId, session)
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    this.initialized = true
  }

  list(): WorkflowInternalSessionRecord[] {
    return Array.from(this.sessions.values()).map(clone)
  }

  async register(record: WorkflowInternalSessionRecord): Promise<void> {
    await this.initialize()
    this.sessions.set(record.sessionId, clone(record))
    await this.persist()
  }

  async markArchived(sessionId: string, archivedAt: string, retentionExpiresAt: string): Promise<void> {
    await this.initialize()
    const record = this.sessions.get(sessionId)
    if (record === undefined) return
    record.archivedAt = archivedAt
    record.retentionExpiresAt = retentionExpiresAt
    await this.persist()
  }

  expiredArchivedSessionIds(now = new Date()): string[] {
    return Array.from(this.sessions.values())
      .filter((record) => record.archivedAt !== undefined && record.retentionExpiresAt !== undefined)
      .filter((record) => {
        const expiry = new Date(record.retentionExpiresAt ?? '')
        return !Number.isNaN(expiry.getTime()) && expiry <= now
      })
      .map((record) => record.sessionId)
  }

  async remove(sessionIds: readonly string[]): Promise<void> {
    await this.initialize()
    let changed = false
    for (const sessionId of sessionIds) changed = this.sessions.delete(sessionId) || changed
    if (changed) await this.persist()
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, Array.from(this.sessions.values()))
  }
}

function readRecord(value: unknown): WorkflowInternalSessionRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.sessionId !== 'string' || typeof raw.runId !== 'string' || typeof raw.workflowId !== 'string') return undefined
  if (raw.kind !== 'employee' && raw.kind !== 'skill') return undefined
  if (typeof raw.createdAt !== 'string') return undefined
  return {
    sessionId: raw.sessionId, runId: raw.runId, workflowId: raw.workflowId, kind: raw.kind, createdAt: raw.createdAt,
    ...(typeof raw.nodeId === 'string' ? { nodeId: raw.nodeId } : {}),
    ...(typeof raw.employeeId === 'string' ? { employeeId: raw.employeeId } : {}),
    ...(typeof raw.archivedAt === 'string' ? { archivedAt: raw.archivedAt } : {}),
    ...(typeof raw.retentionExpiresAt === 'string' ? { retentionExpiresAt: raw.retentionExpiresAt } : {}),
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
