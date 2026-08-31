import { randomUUID } from 'node:crypto'
import type {
  WorkflowModificationProgressUpdate,
  WorkflowModificationRecord,
  WorkflowModifyRequest,
  WorkflowModifyResult,
} from '../../shared/workflow.js'
import { WorkflowModificationStore } from './workflow-modification-store.js'
import type { WorkflowRunService } from './workflow-run-service.js'

export interface WorkflowModificationServiceOptions {
  stateDir?: string
  store?: WorkflowModificationStore
  runService: WorkflowRunService
}

type ModificationListener = (record: WorkflowModificationRecord) => void

export class WorkflowModificationService {
  private readonly store: WorkflowModificationStore
  private readonly listeners = new Set<ModificationListener>()
  private initialized = false

  constructor(private readonly options: WorkflowModificationServiceOptions) {
    if (options.store !== undefined) this.store = options.store
    else if (options.stateDir !== undefined) this.store = new WorkflowModificationStore(options.stateDir)
    else throw new Error('Workflow modification history requires a state directory or store')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.initialize()
    for (const record of this.store.list()) {
      if (record.status !== 'running') continue
      record.status = 'failed'
      record.phase = 'failed'
      record.completedAt = new Date().toISOString()
      record.error = '应用重启导致修改任务中断。'
      record.events.push({ phase: 'failed', status: 'failed', message: record.error, time: record.completedAt })
      await this.store.save(record)
    }
    this.initialized = true
  }

  watch(listener: ModificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async list(workflowId?: string): Promise<WorkflowModificationRecord[]> {
    await this.initialize()
    return this.store.list(workflowId)
  }

  async get(id: string): Promise<WorkflowModificationRecord | undefined> {
    await this.initialize()
    return this.store.get(id)
  }

  async modify(request: WorkflowModifyRequest): Promise<WorkflowModifyResult> {
    await this.initialize()
    const id = request.modificationId?.trim() || `modification-${randomUUID()}`
    if (this.store.get(id) !== undefined) throw new Error(`Workflow modification already exists: ${id}`)
    const record: WorkflowModificationRecord = {
      id,
      workflowId: request.workflow.id,
      workflowRevision: request.workflow.revision,
      prompt: request.prompt,
      status: 'running',
      phase: 'preparing',
      ...(request.model === undefined ? {} : { model: request.model }),
      events: [],
      changes: [],
      removedNodes: [],
      startedAt: new Date().toISOString(),
    }
    await this.progress(record, { phase: 'preparing', message: '开始分析当前工作流。' })
    try {
      const result = await this.options.runService.modify(request, async (update) => this.progress(record, update))
      record.status = 'completed'
      record.phase = 'completed'
      record.completedAt = new Date().toISOString()
      record.workflow = result.workflow
      record.changes = result.changes
      record.removedNodes = result.removedNodes
      record.error = undefined
      await this.progress(record, { phase: 'completed', message: '修改方案已生成并通过结构校验。' })
      return result
    } catch (error) {
      record.status = 'failed'
      record.phase = 'failed'
      record.completedAt = new Date().toISOString()
      record.error = error instanceof Error ? error.message : String(error)
      await this.progress(record, { phase: 'failed', message: record.error })
      throw error
    }
  }

  private async progress(record: WorkflowModificationRecord, update: WorkflowModificationProgressUpdate | { phase: 'failed'; message: string }): Promise<void> {
    record.phase = update.phase
    record.events.push({ phase: update.phase, status: update.phase === 'failed' ? 'failed' : update.phase === 'completed' ? 'completed' : 'running', message: update.message, time: new Date().toISOString() })
    const saved = await this.store.save(record)
    for (const listener of this.listeners) listener(saved)
  }
}
