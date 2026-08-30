import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { cloneWorkflow, type WorkflowRunRecord } from '../../shared/workflow.js'

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tempPath, filePath)
}

export class WorkflowRunStore {
  private readonly filePath: string
  private readonly runs = new Map<string, WorkflowRunRecord>()
  private initialized = false

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'workflow-runs.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (typeof value !== 'object' || value === null || typeof (value as { id?: unknown }).id !== 'string') continue
          const record = value as WorkflowRunRecord
          this.runs.set(record.id, cloneWorkflow(record))
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    this.initialized = true
  }

  async pauseActiveRuns(): Promise<WorkflowRunRecord[]> {
    await this.initialize()
    const paused: WorkflowRunRecord[] = []
    for (const record of this.runs.values()) {
      if (record.status !== 'queued' && record.status !== 'running') continue
      record.status = 'paused'
      record.error = '应用重启导致运行暂停，可从 Workflow 页面恢复。'
      record.events.push({ id: randomUUID(), time: new Date().toISOString(), type: 'run-paused', message: record.error })
      paused.push(cloneWorkflow(record))
    }
    if (paused.length > 0) await this.persist()
    return paused
  }

  list(workflowId?: string): WorkflowRunRecord[] {
    return Array.from(this.runs.values())
      .filter((record) => workflowId === undefined || record.workflowId === workflowId)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .map((record) => cloneWorkflow(record))
  }

  get(id: string): WorkflowRunRecord | undefined {
    const record = this.runs.get(id)
    return record === undefined ? undefined : cloneWorkflow(record)
  }

  async save(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    await this.initialize()
    this.runs.set(record.id, cloneWorkflow(record))
    await this.persist()
    return cloneWorkflow(record)
  }

  /** Remove terminal run history whose configured retention period has elapsed. */
  async pruneExpired(now = new Date()): Promise<string[]> {
    await this.initialize()
    const removed: string[] = []
    for (const [id, record] of this.runs.entries()) {
      if (record.status === 'queued' || record.status === 'running' || record.status === 'paused' || record.status === 'waiting-approval') continue
      if (record.retentionExpiresAt === undefined) continue
      const expiresAt = new Date(record.retentionExpiresAt)
      if (Number.isNaN(expiresAt.getTime()) || expiresAt > now) continue
      this.runs.delete(id)
      removed.push(id)
    }
    if (removed.length > 0) await this.persist()
    return removed
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, Array.from(this.runs.values()))
  }
}
