import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { WORKFLOW_GENERATION_PHASES, cloneWorkflow, type WorkflowGenerationCheckpoint, type WorkflowGenerationRecord } from '../../shared/workflow.js'

const FILE_NAME = 'workflow-generation-history.json'

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

function isGenerationCheckpoint(value: unknown): value is WorkflowGenerationCheckpoint {
  if (!isRecord(value)) return false
  return WORKFLOW_GENERATION_PHASES.includes(value.phase as (typeof WORKFLOW_GENERATION_PHASES)[number])
    && Array.isArray(value.createdEmployees)
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === 'string')
    && (value.selectedEmployeeIds === undefined || (Array.isArray(value.selectedEmployeeIds) && value.selectedEmployeeIds.every((id) => typeof id === 'string')))
    && (value.sessionId === undefined || typeof value.sessionId === 'string')
    && (value.lastModelOutput === undefined || typeof value.lastModelOutput === 'string')
}

function isGenerationRecord(value: unknown): value is WorkflowGenerationRecord {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.prompt === 'string'
    && typeof value.name === 'string'
    && (value.status === 'running' || value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled')
    && typeof value.phase === 'string'
    && (value.createEmployees === undefined || typeof value.createEmployees === 'boolean')
    && Array.isArray(value.events)
    && Array.isArray(value.createdEmployees)
    && (value.checkpoint === undefined || isGenerationCheckpoint(value.checkpoint))
    && typeof value.startedAt === 'string'
}

export class WorkflowGenerationStore {
  private readonly filePath: string
  private readonly records = new Map<string, WorkflowGenerationRecord>()
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
          if (isGenerationRecord(value)) this.records.set(value.id, cloneWorkflow(value))
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    this.initialized = true
  }

  list(): WorkflowGenerationRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => cloneWorkflow(record))
  }

  get(id: string): WorkflowGenerationRecord | undefined {
    const record = this.records.get(id)
    return record === undefined ? undefined : cloneWorkflow(record)
  }

  async save(record: WorkflowGenerationRecord): Promise<WorkflowGenerationRecord> {
    await this.initialize()
    this.records.set(record.id, cloneWorkflow(record))
    await atomicWriteJson(this.filePath, this.list())
    return cloneWorkflow(record)
  }

  async remove(id: string): Promise<boolean> {
    await this.initialize()
    const removed = this.records.delete(id)
    if (removed) await atomicWriteJson(this.filePath, this.list())
    return removed
  }
}
