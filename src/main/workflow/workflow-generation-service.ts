import { randomUUID } from 'node:crypto'
import type {
  WorkflowGenerateRequest,
  WorkflowGenerateResult,
  WorkflowGenerationProgressUpdate,
  WorkflowGenerationRecord,
} from '../../shared/workflow.js'
import { WorkflowGenerationStore } from './workflow-generation-store.js'
import { WorkflowRunService } from './workflow-run-service.js'

export interface WorkflowGenerationServiceOptions {
  stateDir?: string
  store?: WorkflowGenerationStore
  runService: WorkflowRunService
}

type GenerationListener = (record: WorkflowGenerationRecord) => void

export class WorkflowGenerationService {
  private readonly store: WorkflowGenerationStore
  private readonly listeners = new Set<GenerationListener>()
  private initialized = false

  constructor(private readonly options: WorkflowGenerationServiceOptions) {
    if (options.store !== undefined) {
      this.store = options.store
    } else if (options.stateDir !== undefined) {
      this.store = new WorkflowGenerationStore(options.stateDir)
    } else {
      throw new Error('Workflow generation history requires a state directory or store')
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.initialize()
    this.initialized = true
  }

  watch(listener: GenerationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async list(): Promise<WorkflowGenerationRecord[]> {
    await this.initialize()
    return this.store.list()
  }

  async get(id: string): Promise<WorkflowGenerationRecord | undefined> {
    await this.initialize()
    return this.store.get(id)
  }

  async generate(request: WorkflowGenerateRequest): Promise<WorkflowGenerateResult> {
    await this.initialize()
    const id = request.generationId?.trim() || `generation-${randomUUID()}`
    if (this.store.get(id) !== undefined) throw new Error(`Workflow generation already exists: ${id}`)
    const startedAt = new Date().toISOString()
    const record: WorkflowGenerationRecord = {
      id,
      prompt: request.prompt,
      name: request.name?.trim() || request.prompt.trim().slice(0, 48),
      status: 'running',
      phase: 'preparing',
      ...(request.model === undefined ? {} : { model: request.model }),
      events: [],
      createdEmployees: [],
      startedAt,
    }
    await this.progress(record, { phase: 'preparing', message: '开始生成工作流。' })
    try {
      const result = await this.options.runService.generate(request, async (update) => {
        await this.progress(record, update)
      })
      record.status = 'completed'
      record.phase = 'completed'
      record.completedAt = new Date().toISOString()
      record.workflow = result.workflow
      record.createdEmployees = result.createdEmployees
      record.warnings = result.employeeWarnings
      record.error = undefined
      await this.progress(record, { phase: 'completed', message: '工作流草稿已生成并通过结构校验。' })
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

  private async progress(record: WorkflowGenerationRecord, update: WorkflowGenerationProgressUpdate | { phase: 'failed'; message: string }): Promise<void> {
    record.phase = update.phase
    record.events.push({ phase: update.phase, status: update.phase === 'failed' ? 'failed' : update.phase === 'completed' ? 'completed' : 'running', message: update.message, time: new Date().toISOString() })
    await this.save(record)
  }

  private async save(record: WorkflowGenerationRecord): Promise<void> {
    const saved = await this.store.save(record)
    for (const listener of this.listeners) listener(saved)
  }
}
