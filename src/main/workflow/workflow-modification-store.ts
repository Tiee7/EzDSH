import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { cloneWorkflow, type WorkflowModificationRecord } from '../../shared/workflow.js'

const FILE_NAME = 'workflow-modification-history.json'

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isModificationRecord(value: unknown): value is WorkflowModificationRecord {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.workflowId === 'string'
    && typeof value.workflowRevision === 'number'
    && typeof value.prompt === 'string'
    && (value.status === 'running' || value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled')
    && typeof value.phase === 'string'
    && Array.isArray(value.events)
    && Array.isArray(value.changes)
    && Array.isArray(value.removedNodes)
    && typeof value.startedAt === 'string'
}

export class WorkflowModificationStore {
  private readonly filePath: string
  private readonly records = new Map<string, WorkflowModificationRecord>()
  private initialized = false

  constructor(stateDir: string) {
    this.filePath = join(stateDir, FILE_NAME)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (isModificationRecord(value)) this.records.set(value.id, cloneWorkflow(value))
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    this.initialized = true
  }

  list(workflowId?: string): WorkflowModificationRecord[] {
    return Array.from(this.records.values())
      .filter((record) => workflowId === undefined || record.workflowId === workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => cloneWorkflow(record))
  }

  get(id: string): WorkflowModificationRecord | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : cloneWorkflow(record)
  }

  async save(record: WorkflowModificationRecord): Promise<WorkflowModificationRecord> {
    await this.initialize()
    this.records.set(record.id, cloneWorkflow(record))
    await atomicWriteJson(this.filePath, this.list())
    return cloneWorkflow(record)
  }
}
