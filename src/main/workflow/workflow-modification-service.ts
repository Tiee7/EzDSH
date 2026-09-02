import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  WorkflowModificationProgressUpdate,
  WorkflowModificationRecord,
  WorkflowModifyRequest,
  WorkflowModifyResult,
} from '../../shared/workflow.js'
import { WorkflowModificationStore } from './workflow-modification-store.js'
import type { WorkflowRunService } from './workflow-run-service.js'
import { formatWorkflowAiFailureMessage, withWorkflowAiFailureMessage, WorkflowAiDiagnostics, type WorkflowAiDiagnosticWriteResult } from './workflow-ai-diagnostics.js'

export interface WorkflowModificationServiceOptions {
  stateDir?: string
  store?: WorkflowModificationStore
  runService: WorkflowRunService
  diagnostics?: WorkflowAiDiagnostics
}

type ModificationListener = (record: WorkflowModificationRecord) => void

interface ActiveModification {
  controller: AbortController
  record: WorkflowModificationRecord
}

export class WorkflowModificationService {
  private readonly store: WorkflowModificationStore
  private readonly listeners = new Set<ModificationListener>()
  private readonly active = new Map<string, ActiveModification>()
  private readonly diagnostics: WorkflowAiDiagnostics | undefined
  private saveQueue: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(private readonly options: WorkflowModificationServiceOptions) {
    if (options.store !== undefined) this.store = options.store
    else if (options.stateDir !== undefined) this.store = new WorkflowModificationStore(options.stateDir)
    else throw new Error('Workflow modification history requires a state directory or store')
    this.diagnostics = options.diagnostics ?? (options.stateDir === undefined ? undefined : new WorkflowAiDiagnostics(join(options.stateDir, '..', 'logs')))
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.initialize()
    for (const record of this.store.list()) {
      if (record.status !== 'running') continue
      record.status = 'failed'
      record.phase = 'failed'
      record.completedAt = new Date().toISOString()
      const diagnostic = await this.writeFailureDiagnostic(record, new Error('应用重启导致修改任务中断。'), 'ezdsh')
      record.error = formatWorkflowAiFailureMessage(new Error('应用重启导致修改任务中断。'), diagnostic)
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

  async cancel(id: string): Promise<WorkflowModificationRecord> {
    await this.initialize()
    const active = this.active.get(id)
    const record = active?.record ?? this.store.get(id)
    if (record === undefined) throw new Error(`Workflow modification not found: ${id}`)
    if (record.status !== 'running') return record

    record.status = 'cancelled'
    record.phase = 'cancelled'
    record.completedAt = new Date().toISOString()
    record.error = '用户终止了 AI 修改。'
    record.events.push({ phase: 'cancelled', status: 'cancelled', message: record.error, time: record.completedAt })
    active?.controller.abort()
    await this.save(record)
    return this.store.get(id) ?? record
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
    const controller = new AbortController()
    this.active.set(id, { controller, record })
    await this.progress(record, { phase: 'preparing', message: '开始分析当前工作流。' })
    try {
      const result = await this.options.runService.modify(request, async (update) => this.progress(record, update), controller.signal)
      if (controller.signal.aborted || record.status === 'cancelled') throw abortError()
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
      if (controller.signal.aborted || record.status === 'cancelled') throw error
      record.status = 'failed'
      record.phase = 'failed'
      record.completedAt = new Date().toISOString()
      const diagnostic = await this.writeFailureDiagnostic(record, error)
      record.error = formatWorkflowAiFailureMessage(error, diagnostic)
      await this.progress(record, { phase: 'failed', message: record.error })
      throw withWorkflowAiFailureMessage(error, record.error)
    } finally {
      this.active.delete(id)
    }
  }

  private async progress(record: WorkflowModificationRecord, update: WorkflowModificationProgressUpdate | { phase: 'failed'; message: string }): Promise<void> {
    record.phase = update.phase
    record.events.push({ phase: update.phase, status: update.phase === 'failed' ? 'failed' : update.phase === 'completed' ? 'completed' : 'running', message: update.message, time: new Date().toISOString() })
    await this.save(record)
  }

  private async save(record: WorkflowModificationRecord): Promise<void> {
    const operation = this.saveQueue.then(async () => {
      const saved = await this.store.save(record)
      for (const listener of this.listeners) listener(saved)
    })
    this.saveQueue = operation.catch(() => undefined)
    await operation
  }

  private async writeFailureDiagnostic(record: WorkflowModificationRecord, error: unknown, source?: 'model-output' | 'model-service' | 'runtime' | 'ezdsh' | 'unknown'): Promise<WorkflowAiDiagnosticWriteResult | undefined> {
    if (this.diagnostics === undefined) return undefined
    const result = await this.diagnostics.recordFailure({
      kind: 'modification',
      taskId: record.id,
      prompt: record.prompt,
      phase: record.phase,
      startedAt: record.startedAt,
      failedAt: record.completedAt ?? new Date().toISOString(),
      ...(record.model === undefined ? {} : { model: record.model }),
      workflowId: record.workflowId,
      error,
      events: record.events,
      ...(source === undefined ? {} : { source }),
    })
    record.diagnosticLogPath = result.path
    return result
  }
}

function abortError(): Error {
  const error = new Error('用户终止了 AI 修改。')
  error.name = 'AbortError'
  return error
}
