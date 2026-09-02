import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { WORKFLOW_GENERATION_PHASES } from '../../shared/workflow.js'
import type {
  WorkflowGenerateRequest,
  WorkflowGenerateResult,
  WorkflowGenerationCheckpoint,
  WorkflowGenerationProgressUpdate,
  WorkflowGenerationRecord,
} from '../../shared/workflow.js'
import { WorkflowGenerationStore } from './workflow-generation-store.js'
import { WorkflowRunService, type WorkflowGenerationRunOptions } from './workflow-run-service.js'
import { formatWorkflowAiFailureMessage, withWorkflowAiFailureMessage, WorkflowAiDiagnostics, type WorkflowAiDiagnosticWriteResult } from './workflow-ai-diagnostics.js'

export interface WorkflowGenerationServiceOptions {
  stateDir?: string
  store?: WorkflowGenerationStore
  runService: WorkflowRunService
  diagnostics?: WorkflowAiDiagnostics
}

type GenerationListener = (record: WorkflowGenerationRecord) => void

interface ActiveGeneration {
  controller: AbortController
  record: WorkflowGenerationRecord
}

export class WorkflowGenerationService {
  private readonly store: WorkflowGenerationStore
  private readonly listeners = new Set<GenerationListener>()
  private readonly active = new Map<string, ActiveGeneration>()
  private readonly diagnostics: WorkflowAiDiagnostics | undefined
  private saveQueue: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(private readonly options: WorkflowGenerationServiceOptions) {
    if (options.store !== undefined) {
      this.store = options.store
    } else if (options.stateDir !== undefined) {
      this.store = new WorkflowGenerationStore(options.stateDir)
    } else {
      throw new Error('Workflow generation history requires a state directory or store')
    }
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
      const diagnostic = await this.writeFailureDiagnostic(record, new Error('应用重启导致生成任务中断，可从断点继续。'), 'ezdsh')
      record.error = formatWorkflowAiFailureMessage(new Error('应用重启导致生成任务中断，可从断点继续。'), diagnostic)
      record.events.push({ phase: 'failed', status: 'failed', message: record.error, time: record.completedAt })
      await this.store.save(record)
    }
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

  async cancel(id: string): Promise<WorkflowGenerationRecord> {
    await this.initialize()
    const active = this.active.get(id)
    const record = active?.record ?? this.store.get(id)
    if (record === undefined) throw new Error(`Workflow generation not found: ${id}`)
    if (record.status !== 'running') return record

    record.status = 'cancelled'
    record.phase = 'cancelled'
    record.completedAt = new Date().toISOString()
    record.error = '用户终止了工作流生成。'
    record.events.push({ phase: 'cancelled', status: 'cancelled', message: record.error, time: record.completedAt })
    active?.controller.abort()
    await this.save(record)
    return this.store.get(id) ?? record
  }

  async resume(id: string): Promise<WorkflowGenerationRecord> {
    await this.initialize()
    if (this.active.has(id)) throw new Error('Workflow generation is already running')
    const record = this.store.get(id)
    if (record === undefined) throw new Error(`Workflow generation not found: ${id}`)
    if (record.status !== 'failed' && record.status !== 'cancelled') throw new Error('只有失败或已终止的生成任务可以恢复')
    const checkpoint = record.checkpoint ?? {
      phase: inferResumePhase(record),
      createdEmployees: record.createdEmployees,
      warnings: record.warnings ?? [],
    }
    const resumeMessage = record.error
    record.status = 'running'
    record.phase = checkpoint.phase
    record.checkpoint = checkpoint
    record.createdEmployees = checkpoint.createdEmployees
    record.warnings = checkpoint.warnings.length === 0 ? undefined : checkpoint.warnings
    record.error = undefined
    record.completedAt = undefined
    record.events.push({ phase: checkpoint.phase, status: 'running', message: '正在从断点继续；已完成的步骤不会重复执行。', time: new Date().toISOString() })
    await this.save(record)
    const controller = new AbortController()
    this.active.set(id, { controller, record })
    void this.run(record, {
      generationId: record.id,
      prompt: record.prompt,
      name: record.name,
      ...(record.createEmployees === undefined ? {} : { createEmployees: record.createEmployees }),
      ...(record.model === undefined ? {} : { model: record.model }),
    }, controller, {
      checkpoint,
      resumeMessage,
    }).catch(() => undefined)
    return cloneRecord(record)
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
      ...(request.createEmployees === undefined ? {} : { createEmployees: request.createEmployees }),
      events: [],
      createdEmployees: [],
      startedAt,
    }
    const controller = new AbortController()
    this.active.set(id, { controller, record })
    await this.progress(record, { phase: 'preparing', message: '开始生成工作流。' })
    return this.run(record, request, controller)
  }

  private async run(record: WorkflowGenerationRecord, request: WorkflowGenerateRequest, controller: AbortController, generationOptions: WorkflowGenerationRunOptions = {}): Promise<WorkflowGenerateResult> {
    const options: WorkflowGenerationRunOptions = {
      ...generationOptions,
      onCheckpoint: async (checkpoint) => {
        await this.saveCheckpoint(record, checkpoint)
      },
    }
    try {
      const result = await this.options.runService.generate(request, async (update) => {
        await this.progress(record, update)
      }, controller.signal, options)
      if (controller.signal.aborted || record.status === 'cancelled') throw abortError()
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
      if (controller.signal.aborted || record.status === 'cancelled') throw error
      record.status = 'failed'
      record.phase = 'failed'
      record.completedAt = new Date().toISOString()
      const diagnostic = await this.writeFailureDiagnostic(record, error)
      record.error = formatWorkflowAiFailureMessage(error, diagnostic)
      await this.progress(record, { phase: 'failed', message: record.error })
      throw withWorkflowAiFailureMessage(error, record.error)
    } finally {
      this.active.delete(record.id)
    }
  }

  private async progress(record: WorkflowGenerationRecord, update: WorkflowGenerationProgressUpdate | { phase: 'failed'; message: string }): Promise<void> {
    record.phase = update.phase
    record.events.push({ phase: update.phase, status: update.phase === 'failed' ? 'failed' : update.phase === 'completed' ? 'completed' : 'running', message: update.message, time: new Date().toISOString() })
    await this.save(record)
  }

  private async save(record: WorkflowGenerationRecord): Promise<void> {
    const operation = this.saveQueue.then(async () => {
      const saved = await this.store.save(record)
      for (const listener of this.listeners) listener(saved)
    })
    this.saveQueue = operation.catch(() => undefined)
    await operation
  }

  private async saveCheckpoint(record: WorkflowGenerationRecord, checkpoint: WorkflowGenerationCheckpoint): Promise<void> {
    record.checkpoint = checkpoint
    record.createdEmployees = checkpoint.createdEmployees
    record.warnings = checkpoint.warnings.length === 0 ? undefined : checkpoint.warnings
    await this.save(record)
  }

  private async writeFailureDiagnostic(record: WorkflowGenerationRecord, error: unknown, source?: 'model-output' | 'model-service' | 'runtime' | 'ezdsh' | 'unknown'): Promise<WorkflowAiDiagnosticWriteResult | undefined> {
    if (this.diagnostics === undefined) return undefined
    const result = await this.diagnostics.recordFailure({
      kind: 'generation',
      taskId: record.id,
      prompt: record.prompt,
      phase: record.checkpoint?.phase ?? record.phase,
      startedAt: record.startedAt,
      failedAt: record.completedAt ?? new Date().toISOString(),
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.checkpoint?.sessionId === undefined ? {} : { sessionId: record.checkpoint.sessionId }),
      error,
      events: record.events,
      ...(source === undefined ? {} : { source }),
      ...(record.checkpoint?.lastModelOutput === undefined ? {} : { checkpointModelOutput: record.checkpoint.lastModelOutput }),
    })
    record.diagnosticLogPath = result.path
    return result
  }
}

function cloneRecord(record: WorkflowGenerationRecord): WorkflowGenerationRecord {
  return JSON.parse(JSON.stringify(record)) as WorkflowGenerationRecord
}

function inferResumePhase(record: WorkflowGenerationRecord): WorkflowGenerationCheckpoint['phase'] {
  const event = [...record.events].reverse().find((candidate) => candidate.phase !== 'failed' && candidate.phase !== 'cancelled' && candidate.phase !== 'completed')
  return event === undefined || !WORKFLOW_GENERATION_PHASES.includes(event.phase as (typeof WORKFLOW_GENERATION_PHASES)[number])
    ? 'preparing'
    : event.phase as WorkflowGenerationCheckpoint['phase']
}

function abortError(): Error {
  const error = new Error('用户终止了工作流生成。')
  error.name = 'AbortError'
  return error
}
