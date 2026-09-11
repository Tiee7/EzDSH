import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type {
  WorkflowDefinition,
  WorkflowCompensationEffectReconcileRequest,
  WorkflowCompensationEffectReconciliation,
  WorkflowEffectReconcileRequest,
  WorkflowEffectReconciliation,
  WorkflowEdge,
  WorkflowGenerateRequest,
  WorkflowGenerateResult,
  WorkflowGenerationProgressUpdate,
  WorkflowModificationChange,
  WorkflowModificationProgressUpdate,
  WorkflowModifyRequest,
  WorkflowModifyResult,
  WorkflowNode,
  WorkflowNodeInputBinding,
  WorkflowNodeRunState,
  WorkflowExecutionScope,
  WorkflowRunEvent,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowValue,
  WorkflowModelSelection,
  WorkflowGenerationCheckpoint,
  ConditionOperator,
  HttpNodeConfig,
  WorkflowCodeLanguage,
  WorkflowJsonSchema,
  ListOperatorNodeConfig,
  MergeNodeConfig,
  WorkflowRunLease,
  WorkflowCompensationEntry,
  WorkflowEffectReconciliationTarget,
} from '../../shared/workflow.js'
import { EMPLOYEE_CAPABILITIES, employeeDisplayName } from '../../shared/employees.js'
import type { EmployeeCapability, EmployeeCreateInput, EmployeeSnapshot } from '../../shared/employees.js'
import { DEFAULT_APP_LOCALE, type AppLocale } from '../../shared/locale.js'
import { cloneWorkflow, interpolateWorkflowVariables, isWorkflowValue, normalizeWorkflow, normalizeWorkflowLaunchInput, resolveWorkflowValuePath, validateWorkflow, validateWorkflowCompensationEffectReconcileRequest, validateWorkflowEffectReconcileRequest, workflowAllNodeRunStates, workflowLoopBodyNodeIds, workflowNodeDependencyIds } from '../../shared/workflow.js'
import { layoutWorkflowNodes } from '../../shared/workflow-layout.js'
import { assertValidWorkflow, topologicalOrder } from './workflow-validator.js'
import { WorkflowStore } from './workflow-store.js'
import { WorkflowRunStore } from './workflow-run-store.js'
import { WorkflowRunWorker } from './workflow-run-worker.js'
import { DshWorkflowAdapter, WorkflowNodeOutputError, buildNodePrompt, extractJsonDocument, invalidWorkflowJsonOutputError, parseWorkflowJson, type WorkflowSessionClient } from './dsh-workflow-adapter.js'
import type { WorkflowLightweightClient, WorkflowLightweightRequest } from './workflow-lightweight-client.js'
import type { WorkflowMcpClient } from './workflow-mcp-client.js'
import { WorkflowInternalSessionStore, type WorkflowInternalSessionKind } from './workflow-internal-session-store.js'
import { planWorkflowRetry } from './workflow-retry.js'
import type { WorkflowConnectorRequest, WorkflowConnectorService } from './workflow-connector-service.js'
import { normalizeWorkflowRelease, restrictConnectorGrantsToEnvironment, type WorkflowCustomerEnvironment, type WorkflowRelease } from '../../shared/workflow-operations.js'
import { verifyWorkflowReleaseIntegrity } from './workflow-release-integrity.js'

export interface WorkflowRunServiceOptions {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  workflowRoot: string
  /** Standalone Node executable bundled with the app, used by code nodes. */
  nodeCommandPath?: string
  createClient: () => WorkflowSessionClient
  resolveEmployee: (id: string) => EmployeeSnapshot | undefined
  listEmployees?: () => EmployeeSnapshot[]
  /** Creates and persists a professional employee profile. Absent ⇒ AI generation never creates employees. */
  createEmployee?: (input: EmployeeCreateInput) => Promise<EmployeeSnapshot>
  /** Locale for natural-language fields in AI-generated employee profiles. */
  getLocale?: () => AppLocale
  /** Load canonical EzDSH workflow documentation immediately before an AI request. */
  loadWorkflowAiDocumentation?: () => Promise<string | undefined>
  /** @deprecated Test and embedding compatibility. Prefer loadWorkflowAiDocumentation. */
  workflowAiDocumentation?: string
  lightweightClient?: Pick<WorkflowLightweightClient, 'complete'>
  /** Opens a durable model conversation for AI workflow generation. */
  createGenerationSession?: (options: { sessionId?: string; model?: WorkflowModelSelection }) => Promise<WorkflowGenerationSession>
  mcpClient?: Pick<WorkflowMcpClient, 'call'>
  /** Main-process managed connector executor. Raw URL HTTP remains for legacy workflows. */
  connectorService?: Pick<WorkflowConnectorService, 'request'> & Partial<Pick<WorkflowConnectorService, 'authorize'>>
  /** Keep raw URL HTTP available to compatibility embeddings; production main disables it. */
  allowLegacyHttp?: boolean
  /** Main-process only immutable release resolver for published workflow starts. */
  resolveReleasedWorkflow?: (releaseId: string) => WorkflowRelease | undefined
  /** Current Main-process environment policy; omitted only by compatibility embeddings. */
  resolveWorkflowEnvironment?: (environmentId: string) => WorkflowCustomerEnvironment | undefined
  /** Compatibility executor for explicitly declared compensation workflows. */
  executeSubWorkflow?: (workflowId: string, input: WorkflowValue, waitForCompletion: boolean, version?: number | 'latest', options?: WorkflowRunOptions) => Promise<WorkflowValue>
  internalSessionStore?: WorkflowInternalSessionStore
}

type RunListener = (record: WorkflowRunRecord) => void

export interface WorkflowGenerationSession {
  readonly sessionId: string
  complete(request: WorkflowLightweightRequest): Promise<string>
  cancel(): Promise<void>
  archive(): Promise<void>
}

export interface WorkflowGenerationRunOptions {
  checkpoint?: WorkflowGenerationCheckpoint
  onCheckpoint?: (checkpoint: WorkflowGenerationCheckpoint) => Promise<void> | void
  resumeMessage?: string
}

interface ActiveRun {
  cancelled: boolean
  /** Persisted queue ownership was lost; do not write a stale terminal record. */
  leaseLost: boolean
  pauseRequested?: boolean
  readonly abortController: AbortController
  readonly sessionIds: Set<string>
  readonly archivedSessionIds: Set<string>
  readonly sessionKeys: Map<string, string>
}

export class WorkflowRunService {
  private readonly listeners = new Set<RunListener>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly liveLineages = new Map<string, readonly string[]>()
  private readonly adapter: DshWorkflowAdapter
  private readonly lightweightClient: Pick<WorkflowLightweightClient, 'complete'>
  private readonly mcpClient: Pick<WorkflowMcpClient, 'call'>
  private readonly internalSessionStore: WorkflowInternalSessionStore
  private readonly worker: WorkflowRunWorker
  private readonly compensationActive = new Set<string>()
  private readonly reconciliationActive = new Set<string>()
  private readonly administrativeActive = new Set<string>()
  private readonly runMutationTails = new Map<string, Promise<void>>()
  private readonly workflowMutationTails = new Map<string, Promise<void>>()
  private readonly workflowAdministrativeActive = new Set<string>()
  private initialized = false
  private initializationPromise: Promise<void> | undefined

  constructor(private readonly options: WorkflowRunServiceOptions) {
    this.adapter = new DshWorkflowAdapter({ cwd: options.workflowRoot, createClient: options.createClient })
    this.lightweightClient = options.lightweightClient ?? { complete: async () => { throw new Error('轻量智能处理不可用：请先配置模型供应商。') } }
    this.mcpClient = options.mcpClient ?? { call: async () => { throw new Error('MCP 直连不可用：请检查 MCP 配置。') } }
    this.internalSessionStore = options.internalSessionStore ?? new WorkflowInternalSessionStore(options.workflowRoot)
    this.worker = new WorkflowRunWorker({
      store: options.runStore,
      executeClaimedRun: (runId, lease, leaseSignal) => this.execute(runId, lease, leaseSignal),
      onExecutionError: (runId, error) => this.handleWorkerExecutionError(runId, error),
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await this.options.workflowStore.initialize()
      await this.options.runStore.initialize()
      await this.internalSessionStore.initialize()
      await this.recoverLegacyChildLineages()
      // A new service instance is a new process boundary: any persisted lease
      // belongs to a process that no longer exists, even if its expiry is in
      // the future. Reconcile it before starting the fresh Worker.
      await this.options.runStore.recoverInterruptedRuns(new Date(), true)
      await this.options.runStore.recoverInterruptedCompensations()
      // Records written before the durable queue existed have no lease and
      // retain the previous startup-pause behaviour.
      await this.options.runStore.pauseActiveRuns()
      await this.backfillLegacyEffectReconciliationTargets()
      await this.options.runStore.pruneExpired()
      this.initialized = true
      await this.worker.start()
    })()
    this.initializationPromise = pending
    try {
      await pending
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined
    }
  }

  watch(listener: RunListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(workflowId?: string): WorkflowRunRecord[] {
    return this.options.runStore.list(workflowId)
  }

  get(runId: string): WorkflowRunRecord | undefined {
    return this.options.runStore.get(runId)
  }

  async getRunDefinition(runId: string): Promise<WorkflowDefinition | undefined> {
    await this.initialize()
    if (typeof runId !== 'string' || runId.trim() === '') throw new Error('Invalid workflow run ID')
    const record = this.options.runStore.get(runId)
    if (record === undefined) return undefined

    let rawDefinition: WorkflowDefinition | undefined
    const { releaseId, environmentId, traceId } = record
    const releaseIdentity = [releaseId, environmentId, traceId]
    const isReleasedRun = releaseIdentity.some((value) => value !== undefined)
    if (!isReleasedRun) {
      rawDefinition = this.options.workflowStore.getRevision(record.workflowId, record.workflowRevision)
    } else {
      if (typeof releaseId !== 'string' || releaseId.trim() === '' || typeof environmentId !== 'string' || environmentId.trim() === '' || typeof traceId !== 'string' || traceId.trim() === '') return undefined
      const release = normalizeWorkflowRelease(this.options.resolveReleasedWorkflow?.(releaseId))
      if (release === undefined || release.id !== releaseId || release.environmentId !== environmentId || !verifyWorkflowReleaseIntegrity(release)) return undefined
      rawDefinition = this.resolveReleasedDefinition(release, record.workflowId, record.workflowRevision)
    }

    const definition = normalizeWorkflow(rawDefinition)
    if (definition === undefined || definition.id !== record.workflowId || definition.revision !== record.workflowRevision) return undefined
    if (!validateWorkflow(definition).valid) return undefined
    delete definition.lastRunId
    return cloneWorkflow(definition)
  }

  async remove(runId: string): Promise<void> {
    await this.initialize()
    this.assertRunAdministrationAvailable(runId)
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try { this.assertRunAdministrationAvailable(runId) } catch (error) { releaseMutation(); throw error }
    this.administrativeActive.add(runId)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
      if (record.status === 'queued' || record.status === 'running' || record.status === 'waiting-approval') {
        throw new Error('运行中的记录不能删除，请先取消运行')
      }
      const removed = await this.options.runStore.remove(runId)
      if (!removed) throw new Error(`Workflow run not found: ${runId}`)
    } finally {
      this.administrativeActive.delete(runId)
      releaseMutation()
    }
  }

  /** Remove every non-active run record for a workflow before deleting its definition. */
  async removeForWorkflow(workflowId: string): Promise<number> {
    await this.initialize()
    return this.removeWorkflowAndRuns(workflowId, false)
  }

  /** Definition deletion and run cleanup share the same workflow critical section. */
  async removeWorkflow(workflowId: string): Promise<void> {
    await this.initialize()
    if (typeof workflowId !== 'string' || workflowId.trim() === '') throw new Error('Invalid workflow ID')
    await this.removeWorkflowAndRuns(workflowId, true)
  }

  private async removeWorkflowAndRuns(workflowId: string, removeDefinition: boolean): Promise<number> {
    await this.beginWorkflowAdministration(workflowId)
    const releases: Array<() => void> = []
    let administrativeRecords: WorkflowRunRecord[] = []
    try {
      const initialRecords = this.options.runStore.list(workflowId)
      for (const record of initialRecords) this.assertRunAdministrationAvailable(record.id)
      for (const runId of initialRecords.map((record) => record.id).sort()) releases.push(await this.acquireKeyedMutex(this.runMutationTails, runId))
      const releaseWorkflow = await this.acquireKeyedMutex(this.workflowMutationTails, workflowId)
      try {
        if (removeDefinition && this.options.workflowStore.get(workflowId) === undefined) throw new Error(`Workflow not found: ${workflowId}`)
        administrativeRecords = this.options.runStore.list(workflowId)
        for (const record of administrativeRecords) this.assertRunAdministrationAvailable(record.id)
        const active = administrativeRecords.find((record) => record.status === 'queued' || record.status === 'running' || record.status === 'waiting-approval')
        if (active !== undefined) throw new Error('工作流仍有运行中的记录，请先取消运行后再删除工作流')
        for (const record of administrativeRecords) this.administrativeActive.add(record.id)
        const removed = await this.options.runStore.removeForWorkflow(workflowId)
        if (removeDefinition) await this.options.workflowStore.remove(workflowId)
        return removed
      } finally {
        for (const record of administrativeRecords) this.administrativeActive.delete(record.id)
        releaseWorkflow()
      }
    } finally {
      for (const release of releases.reverse()) release()
      await this.endWorkflowAdministration(workflowId)
    }
  }

  private async beginWorkflowAdministration(workflowId: string): Promise<void> {
    const releaseWorkflow = await this.acquireKeyedMutex(this.workflowMutationTails, workflowId)
    try {
      if (this.workflowAdministrativeActive.has(workflowId)) throw new Error('该工作流的删除或运行清理正在进行。')
      this.workflowAdministrativeActive.add(workflowId)
    } finally {
      releaseWorkflow()
    }
  }

  private async endWorkflowAdministration(workflowId: string): Promise<void> {
    const releaseWorkflow = await this.acquireKeyedMutex(this.workflowMutationTails, workflowId)
    try {
      this.workflowAdministrativeActive.delete(workflowId)
    } finally {
      releaseWorkflow()
    }
  }

  private async acquireKeyedMutex(tails: Map<string, Promise<void>>, key: string): Promise<() => void> {
    const previous = tails.get(key) ?? Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      releaseCurrent()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }

  private assertRunMutationAvailable(runId: string): void {
    const record = this.options.runStore.get(runId)
    const activelyExecuting = this.active.has(runId) && (record === undefined || record.status === 'queued' || record.status === 'running' || workflowAllNodeRunStates(record.nodeStates).some((state) => state.status === 'running'))
    if (activelyExecuting || this.reconciliationActive.has(runId) || this.compensationActive.has(runId) || this.administrativeActive.has(runId)) {
      throw new Error('该运行仍在执行，或人工核对、补偿、其他变更正在进行。')
    }
  }

  private assertRunAdministrationAvailable(runId: string): void {
    this.assertRunMutationAvailable(runId)
    if (this.active.has(runId)) throw new Error('该运行仍在执行，完成收尾前不能删除。')
  }

  async stop(): Promise<void> {
    for (const [runId, active] of this.active) {
      active.pauseRequested = true
      active.cancelled = true
      active.abortController.abort()
      await this.cancelInternalSessions(active)
      const record = this.options.runStore.get(runId)
      if (record !== undefined && (record.status === 'queued' || record.status === 'running')) {
        record.status = 'paused'
        record.error = '应用正在切换工作区，运行已暂停。'
        record.completedAt = new Date().toISOString()
        await this.save(record, 'run-paused', record.error)
      }
    }
    await this.worker.stop()
  }

  async start(workflowId: string, input: WorkflowValue, options: WorkflowRunOptions = {}): Promise<WorkflowRunRecord> {
    await this.initialize()
    if (!isWorkflowValue(input)) throw new Error('Workflow 输入必须是 JSON-safe 值')
    const releaseWorkflow = await this.acquireKeyedMutex(this.workflowMutationTails, workflowId)
    try {
      if (this.workflowAdministrativeActive.has(workflowId)) throw new Error('该工作流的删除或运行清理正在进行。')
      const workflow = options.workflowRevision === undefined ? this.options.workflowStore.get(workflowId) : this.options.workflowStore.getRevision(workflowId, options.workflowRevision)
      if (workflow === undefined) throw new Error(`Workflow not found: ${workflowId}`)
      assertValidWorkflow(workflow, '启动运行')
      const effectiveInput = normalizeWorkflowLaunchInput(workflow, input)
      const record = this.createRecord(workflow, effectiveInput, options)
      const enqueued = await this.enqueue(record, '运行已排队')
      this.worker.wake()
      return cloneWorkflow(enqueued)
    } finally {
      releaseWorkflow()
    }
  }

  async startReleased(releaseId: string, input: WorkflowValue, options: WorkflowRunOptions = {}): Promise<WorkflowRunRecord> {
    await this.initialize()
    if (!isWorkflowValue(input)) throw new Error('Workflow 输入必须是 JSON-safe 值')
    const release = this.resolveReleasedWorkflowOrThrow(releaseId)
    if (release.status !== 'published') throw new Error('只能启动已发布的 workflow release')
    return this.startReleasedDefinition(release.id, release.workflowSnapshot, input, options, release)
  }

  /** Execute a live child in the caller's slot, or enqueue an asynchronous child. */
  async executeSubWorkflow(
    workflowId: string,
    input: WorkflowValue,
    waitForCompletion: boolean,
    version?: number | 'latest',
    options: WorkflowRunOptions = {},
    parentRunId?: string,
  ): Promise<WorkflowValue> {
    await this.initialize()
    if (!isWorkflowValue(input)) throw new Error('Workflow 输入必须是 JSON-safe 值')
    const releaseWorkflow = await this.acquireKeyedMutex(this.workflowMutationTails, workflowId)
    let parentActive: ActiveRun | undefined
    let child!: WorkflowRunRecord
    let enqueued: WorkflowRunRecord | undefined
    try {
      if (this.workflowAdministrativeActive.has(workflowId)) throw new Error('子工作流的删除或运行清理正在进行。')
      const parent = parentRunId === undefined ? undefined : this.options.runStore.get(parentRunId)
      if (parentRunId !== undefined && parent === undefined) throw new Error(`父运行不存在：${parentRunId}`)
      const lineage = parent === undefined ? [] : [...(parent.workflowAncestry ?? []), parent.workflowId]
      if (lineage.includes(workflowId)) throw new WorkflowRecursiveCallError([...lineage, workflowId])
      const workflow = this.options.workflowStore.get(workflowId)
      if (workflow === undefined) throw new Error(`子工作流不存在：${workflowId}`)
      if (typeof version === 'number' && workflow.revision !== version) throw new Error(`子工作流版本不匹配：需要 v${version}，当前为 v${workflow.revision}。`)
      assertValidWorkflow(workflow, '启动子工作流')
      parentActive = parentRunId === undefined ? undefined : this.active.get(parentRunId)
      throwIfAborted(parentActive?.abortController.signal)
      const effectiveInput = normalizeWorkflowLaunchInput(workflow, input)
      child = this.createRecord(workflow, effectiveInput, options)
      if (parent !== undefined) {
        child.parentRunId = parent.id
        child.workflowAncestry = [...lineage]
        child.origin = { kind: 'child', parentRunId: parent.id }
      }
      this.liveLineages.set(child.id, [...lineage, workflow.id])
      if (!waitForCompletion || parentActive === undefined) {
        enqueued = await this.enqueue(child, '子运行已排队')
        if (enqueued.id !== child.id) this.liveLineages.delete(child.id)
      } else {
        // Persist as running so even an idle Worker's polling cannot claim this
        // inline run while its caller is saving the creation event.
        child.status = 'running'
        await this.save(child, 'run-created', '同步子运行已创建')
      }
    } finally {
      releaseWorkflow()
    }
    if (enqueued !== undefined) {
      this.worker.wake()
      if (!waitForCompletion) return { runId: enqueued.id }
      // Compensation and other parentless calls have no occupied Worker
      // slot. Let the Worker own all attempts instead of racing its polling.
      const settled = await this.waitForChildRun(enqueued.id)
      if (settled.status !== 'completed') throw new Error(settled.error ?? '子工作流执行失败。')
      return settled.output ?? null
    }
    const inlineParentActive = parentActive
    if (inlineParentActive === undefined) throw new Error('同步子运行缺少父运行上下文。')
    for (;;) {
      await this.execute(child.id, undefined, undefined, inlineParentActive)
      const settled = this.options.runStore.get(child.id)
      if (settled === undefined) throw new Error(`Workflow run not found: ${child.id}`)
      if (settled.status === 'completed') return settled.output ?? null
      if (settled.status !== 'queued') throw new Error(settled.error ?? '子工作流执行失败。')
      // A retry yields the child, but the parent's Worker slot still belongs
      // to this call. Resume the same run when due instead of queueing behind it.
      try {
        const current = await this.waitForChildRun(child.id, inlineParentActive.abortController.signal, settled.queue?.availableAt)
        if (current.status !== 'queued') throw new Error(current.error ?? '子工作流执行失败。')
      } catch (error) {
        if (inlineParentActive.abortController.signal.aborted) await this.cancel(child.id)
        throw error
      }
    }
  }

  /** Wait for a child to settle, or for an inline retry's due time. */
  private waitForChildRun(runId: string, signal?: AbortSignal, dueAt?: string): Promise<WorkflowRunRecord> {
    return new Promise((resolvePromise, reject) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unwatch = (): void => {}
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        unwatch()
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const current = this.options.runStore.get(runId)
        if (error !== undefined) reject(error)
        else if (current === undefined) reject(new Error(`Workflow run not found: ${runId}`))
        else resolvePromise(current)
      }
      const onAbort = (): void => finish(new Error('子工作流等待已取消。'))
      const observe = (record: WorkflowRunRecord): void => {
        if (record.id === runId && record.status !== 'queued' && record.status !== 'running') finish()
      }
      unwatch = this.watch(observe)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      const current = this.options.runStore.get(runId)
      if (current === undefined) finish()
      else observe(current)
      if (!finished && dueAt !== undefined) timer = setTimeout(() => finish(), Math.max(0, Date.parse(dueAt) - Date.now()))
    })
  }

  async resume(runId: string): Promise<WorkflowRunRecord> {
    await this.initialize()
    this.assertRunMutationAvailable(runId)
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try { this.assertRunMutationAvailable(runId) } catch (error) { releaseMutation(); throw error }
    this.administrativeActive.add(runId)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
      if (record.status !== 'paused' && record.status !== 'failed') throw new Error('只有暂停或失败的运行可以恢复')
      if (this.hasUncheckpointedLoopEffects(record)) throw new Error('旧版循环缺少逐迭代副作用记录，请先人工核对，不能安全恢复')
      if (workflowAllNodeRunStates(record.nodeStates).some((state) => state.effectState === 'prepared' || state.effectState === 'dispatched' || state.effectState === 'unknown' || state.effectState === 'confirmed' && state.status !== 'completed')) throw new Error('运行包含状态不确定的外部副作用，请先完成补偿或人工核对')
      this.revalidateReleasedAccess(record)
      record.status = 'queued'
      record.error = undefined
      record.completedAt = undefined
      record.retentionExpiresAt = undefined
      for (const node of workflowAllNodeRunStates(record.nodeStates)) {
        if (node.status === 'failed' || node.status === 'running' || node.status === 'cancelled') {
          node.status = 'pending'
          node.error = undefined
          node.startedAt = undefined
          node.completedAt = undefined
          node.input = undefined
          node.output = undefined
        }
      }
      this.prepareQueuedRecord(record)
      await this.save(record, 'run-created', '运行已重新排队')
      this.worker.wake()
      return cloneWorkflow(record)
    } finally {
      this.administrativeActive.delete(runId)
      releaseMutation()
    }
  }

  async reconcileEffect(runId: string, input: WorkflowEffectReconcileRequest): Promise<WorkflowRunRecord> {
    if (typeof runId !== 'string' || runId.trim() === '') throw new Error('Invalid workflow run ID')
    const request = validateWorkflowEffectReconcileRequest(input)
    await this.initialize()
    this.assertRunMutationAvailable(runId)
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try { this.assertRunMutationAvailable(runId) } catch (error) { releaseMutation(); throw error }
    this.reconciliationActive.add(runId)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
      if (record.status !== 'paused' && record.status !== 'failed') throw new Error('只有暂停或失败的运行可以人工核对副作用')
      if (record.effectReconciliationTargets === undefined) this.syncEffectReconciliationTargets(record)
      let scope: WorkflowExecutionScope | undefined
      let state: WorkflowNodeRunState | undefined
      if (request.iterationId === undefined) {
        const persistedTarget = record.effectReconciliationTargets?.find((candidate) => candidate.nodeId === request.nodeId && candidate.iterationId === undefined)
        if (persistedTarget !== undefined) state = record.nodeStates.find((candidate) => candidate.nodeId === request.nodeId && candidate.executionScope === undefined)
      } else {
        const persistedTarget = record.effectReconciliationTargets?.find((candidate) => candidate.nodeId === request.nodeId && candidate.iterationId === request.iterationId)
        if (persistedTarget !== undefined) {
          for (const owner of record.nodeStates) {
            const iteration = owner.loopIterations?.find((candidate) => candidate.iterationId === request.iterationId)
            if (iteration === undefined || iteration.status === 'completed') continue
            state = iteration.nodeStates.find((candidate) => candidate.nodeId === request.nodeId)
            scope = { loopNodeId: owner.nodeId, iterationId: iteration.iterationId, iterationIndex: iteration.iterationIndex }
            break
          }
        }
      }
      if (state === undefined || state.effectState !== 'unknown') throw new Error('指定节点或循环迭代不存在未知副作用')
      const unsafe = (candidate: WorkflowNodeRunState): boolean => candidate.effectState === 'prepared' || candidate.effectState === 'dispatched' || candidate.effectState === 'unknown' || candidate.effectState === 'confirmed' && candidate.status !== 'completed'
      const canRequeue = request.outcome === 'not-dispatched' && !this.hasUncheckpointedLoopEffects(record)
        && !workflowAllNodeRunStates(record.nodeStates).some((candidate) => candidate !== state && unsafe(candidate))
      if (canRequeue) this.revalidateReleasedAccess(record)
      const resolvedAt = new Date().toISOString()
      appendEffectReconciliation(state, { outcome: request.outcome, note: request.note, resolvedAt })
      if (scope !== undefined) state.executionScope = scope
      if (request.outcome === 'dispatched') {
        state.effectState = 'confirmed'
        state.status = 'failed'
        state.completedAt = resolvedAt
        state.error = '人工确认副作用已派发；缺少执行结果，运行保持终止。'
        record.status = 'failed'
        record.error = state.error
        record.completedAt = resolvedAt
      } else {
        state.effectState = 'none'
        state.status = 'pending'
        state.error = undefined
        state.startedAt = undefined
        state.completedAt = undefined
        state.elapsedMs = undefined
        state.nextAttemptAt = undefined
        state.input = undefined
        state.output = undefined
        if (canRequeue) {
          resetInterruptedSafeNodeStates(record.nodeStates)
          record.error = undefined
          record.completedAt = undefined
          record.retentionExpiresAt = undefined
          this.prepareQueuedRecord(record)
        } else {
          record.status = 'paused'
          record.error = '仍有其他副作用需要人工核对，运行保持暂停。'
        }
      }
      // Audit, precise reset and queue transition share one durable snapshot.
      const reconcileType: WorkflowRunEvent['type'] = `node-effect-reconciled-${request.outcome}`
      const reconcileMessage = request.outcome === 'dispatched' ? '人工确认副作用已派发，运行终止。' : '人工确认副作用未派发。'
      if (request.outcome === 'dispatched') await this.saveFailure(record, reconcileType, reconcileMessage, request.nodeId, scope)
      else await this.save(record, reconcileType, reconcileMessage, request.nodeId, scope)
      if (canRequeue) this.worker.wake()
      return this.options.runStore.get(runId) ?? cloneWorkflow(record)
    } finally {
      this.reconciliationActive.delete(runId)
      releaseMutation()
    }
  }

  async reconcileCompensation(runId: string, input: WorkflowCompensationEffectReconcileRequest): Promise<WorkflowRunRecord> {
    if (typeof runId !== 'string' || runId.trim() === '') throw new Error('Invalid workflow run ID')
    const request = validateWorkflowCompensationEffectReconcileRequest(input)
    await this.initialize()
    this.assertRunMutationAvailable(runId)
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try { this.assertRunMutationAvailable(runId) } catch (error) { releaseMutation(); throw error }
    this.reconciliationActive.add(runId)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
      if (record.status === 'queued' || record.status === 'running' || record.status === 'waiting-approval') throw new Error('运行尚未结束，不能核对补偿副作用')
      const entry = record.compensationStack?.find((candidate) => candidate.occurrenceId === request.occurrenceId)
      if (entry === undefined || entry.status !== 'failed' || entry.effectState !== 'unknown') throw new Error('指定补偿 occurrence 不存在或不再需要人工核对')
      const resolvedAt = new Date().toISOString()
      appendCompensationEffectReconciliation(entry, { outcome: request.outcome, note: request.note, resolvedAt })
      if (request.outcome === 'dispatched') {
        entry.status = 'completed'
        entry.effectState = 'confirmed'
        entry.completedAt = resolvedAt
        entry.error = undefined
      } else {
        this.revalidateReleasedAccess(record)
        entry.status = 'pending'
        entry.effectState = 'none'
        entry.startedAt = undefined
        entry.completedAt = undefined
        entry.error = undefined
      }
      if (!(record.compensationStack ?? []).some((candidate) => candidate.effectState === 'unknown')) record.compensationBlocker = undefined
      const type: WorkflowRunEvent['type'] = `compensation-effect-reconciled-${request.outcome}`
      const message = request.outcome === 'dispatched'
        ? `人工确认补偿副作用已派发：${entry.sourceNodeId}`
        : `人工确认补偿副作用未派发：${entry.sourceNodeId}`
      await this.save(record, type, message, entry.sourceNodeId, entry.executionScope)
      return this.options.runStore.get(runId) ?? cloneWorkflow(record)
    } finally {
      this.reconciliationActive.delete(runId)
      releaseMutation()
    }
  }

  private hasUncheckpointedLoopEffects(record: WorkflowRunRecord): boolean {
    const workflow = this.workflowForRecord(record)
    if (workflow === undefined) return false
    return workflow.nodes.some((node) => {
      if (node.type !== 'loop') return false
      const owner = record.nodeStates.find((state) => state.nodeId === node.id)
      if (owner?.status === 'completed' || owner?.loopIterations !== undefined) return false
      return workflowLoopBodyNodeIds(workflow, node.id).some((bodyId) => {
        const body = workflow.nodes.find((candidate) => candidate.id === bodyId)
        const state = record.nodeStates.find((candidate) => candidate.nodeId === bodyId)
        return body !== undefined && isEffectfulNode(body) && state !== undefined
          && (state.status !== 'pending' && state.status !== 'skipped' || state.startedAt !== undefined || (state.attempt ?? 0) > 0 || state.effectState !== undefined && state.effectState !== 'none')
      })
    })
  }

  async approve(runId: string, approved: boolean): Promise<WorkflowRunRecord> {
    await this.initialize()
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
      if (record.status !== 'waiting-approval' || record.waitingApprovalNodeId === undefined) throw new Error('当前运行没有等待中的审批')
      const workflow = this.workflowForRecord(record)
      if (workflow === undefined) throw new Error('关联的 Workflow 已不存在')
      const node = workflow.nodes.find((candidate) => candidate.id === record.waitingApprovalNodeId)
      const state = record.nodeStates.find((candidate) => candidate.nodeId === record.waitingApprovalNodeId)
      if ((node?.type !== 'approval' && node?.type !== 'wait-input') || state === undefined || (node.type === 'wait-input' && node.config.mode !== 'approval')) throw new Error('审批节点不存在')
      if (!approved) {
        state.status = 'failed'
        state.error = '审批被拒绝'
        state.completedAt = new Date().toISOString()
        record.status = 'failed'
        record.error = '审批被拒绝'
        record.completedAt = new Date().toISOString()
        record.waitingApprovalNodeId = undefined
        await this.saveFailure(record, 'approval-rejected', '审批被拒绝', node.id)
        return this.options.runStore.get(runId) ?? record
      }
      this.revalidateReleasedAccess(record)
      const outputs = new Map(record.nodeStates.filter((candidate) => candidate.output !== undefined).map((candidate) => [candidate.nodeId, candidate.output as WorkflowValue]))
      const incoming = workflow.edges.filter((edge) => edge.target === node.id)
      const nodeMap = new Map(workflow.nodes.map((candidate) => [candidate.id, candidate]))
      const stateMap = new Map(record.nodeStates.map((candidate) => [candidate.nodeId, candidate]))
      state.status = 'completed'
      state.output = this.previousValue(incoming.filter((edge) => this.isEdgeActive(edge, workflow.edges, nodeMap, stateMap, outputs)), outputs, record.input)
      state.completedAt = new Date().toISOString()
      state.elapsedMs = 0
      state.error = undefined
      record.status = 'queued'
      record.error = undefined
      record.waitingApprovalNodeId = undefined
      this.prepareQueuedRecord(record)
      await this.save(record, 'approval-approved', '审批通过，继续运行', node.id)
      this.worker.wake()
      return this.options.runStore.get(runId) ?? record
    } finally {
      releaseMutation()
    }
  }

  async cancel(runId: string): Promise<WorkflowRunRecord> {
    await this.initialize()
    const active = this.active.get(runId)
    let cancellingSessions: Promise<void> | undefined
    if (active !== undefined) {
      active.cancelled = true
      active.abortController.abort()
      cancellingSessions = this.cancelInternalSessions(active)
    }
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try {
      await cancellingSessions
      const record = this.options.runStore.get(runId)
      if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
      await this.options.runStore.requestCancellation(runId)
      const cancelled = this.options.runStore.get(runId) ?? record
      if (cancelled.status === 'cancelled') this.liveLineages.delete(runId)
      for (const listener of this.listeners) listener(cloneWorkflow(cancelled))
      return cancelled
    } finally {
      releaseMutation()
    }
  }

  /**
   * Run explicitly declared reverse actions after a terminal run. The service
   * never invents an inverse for a node and never retries a failed compensation
   * automatically; callers can inspect the durable entry and decide whether
   * to invoke this method again.
   */
  async compensate(runId: string): Promise<WorkflowRunRecord> {
    await this.initialize()
    this.assertRunMutationAvailable(runId)
    const releaseMutation = await this.acquireKeyedMutex(this.runMutationTails, runId)
    try { this.assertRunMutationAvailable(runId) } catch (error) { releaseMutation(); throw error }
    let record: WorkflowRunRecord
    try {
      const current = this.options.runStore.get(runId)
      if (current === undefined) throw new Error(`Workflow run not found: ${runId}`)
      if (current.status === 'queued' || current.status === 'running' || current.status === 'waiting-approval') throw new Error('运行尚未结束，不能执行补偿')
      this.revalidateReleasedAccess(current)
      record = current
    } catch (error) {
      releaseMutation()
      throw error
    }
    this.compensationActive.add(runId)
    try {
      const stack = record.compensationStack ?? []
      const unresolved = stack.find((entry) => entry.effectState === 'unknown')
      if (unresolved !== undefined) throw new Error(`补偿节点 ${unresolved.sourceNodeId} 的副作用状态未知，必须先人工核对。`)
      for (const entry of [...stack].reverse()) {
        if (entry.status === 'completed') continue
        entry.occurrenceId ??= this.compensationOccurrenceId(record, entry.sourceNodeId, entry.executionScope)
        entry.attempt = (entry.attempt ?? 0) + 1
        entry.status = 'running'
        entry.effectState = 'prepared'
        entry.startedAt = new Date().toISOString()
        entry.completedAt = undefined
        entry.error = undefined
        await this.saveEvents(record, [
          this.createEvent('compensation-started', `开始补偿节点：${entry.sourceNodeId}`, entry.sourceNodeId, entry.executionScope),
          this.createEvent('compensation-effect-prepared', `已准备补偿副作用：${entry.sourceNodeId}`, entry.sourceNodeId, entry.executionScope),
        ])
        try {
          const sourceOutput = workflowAllNodeRunStates(record.nodeStates).find((state) => state.nodeId === entry.sourceNodeId && state.executionScope?.iterationId === entry.executionScope?.iterationId)?.output ?? null
          const compensationInput = entry.action.input === undefined
            ? cloneWorkflow(sourceOutput)
            : resolveWorkflowTemplateValue(entry.action.input, record.input, sourceOutput)
          entry.effectState = 'dispatched'
          await this.save(record, 'compensation-effect-dispatched', `已派发补偿副作用：${entry.sourceNodeId}`, entry.sourceNodeId, entry.executionScope)
          await this.executeCompensationWorkflow(record, entry, compensationInput)
          entry.status = 'completed'
          entry.effectState = 'confirmed'
          entry.completedAt = new Date().toISOString()
          if (!stack.some((candidate) => candidate.effectState === 'unknown')) record.compensationBlocker = undefined
          await this.saveEvents(record, [
            this.createEvent('compensation-effect-confirmed', `已确认补偿副作用：${entry.sourceNodeId}`, entry.sourceNodeId, entry.executionScope),
            this.createEvent('compensation-completed', `补偿完成：${entry.sourceNodeId}`, entry.sourceNodeId, entry.executionScope),
          ])
        } catch (error) {
          entry.status = 'failed'
          entry.effectState = 'unknown'
          entry.completedAt = new Date().toISOString()
          entry.error = error instanceof Error ? error.message : String(error)
          record.compensationBlocker = `补偿副作用状态未知，必须人工核对：${entry.error}`
          await this.saveEvents(record, [
            this.createEvent('compensation-effect-unknown', record.compensationBlocker, entry.sourceNodeId, entry.executionScope),
            this.createEvent('compensation-failed', record.compensationBlocker, entry.sourceNodeId, entry.executionScope),
          ])
          break
        }
      }
      return this.options.runStore.get(runId) ?? record
    } finally {
      this.compensationActive.delete(runId)
      releaseMutation()
    }
  }

  async generate(request: WorkflowGenerateRequest, onProgress?: (update: WorkflowGenerationProgressUpdate) => Promise<void> | void, signal?: AbortSignal, generationOptions: WorkflowGenerationRunOptions = {}): Promise<WorkflowGenerateResult> {
    let generationSession: WorkflowGenerationSession | undefined
    let succeeded = false
    const cancelSession = (): void => {
      if (generationSession !== undefined) void generationSession.cancel().catch(() => undefined)
    }
    if (signal !== undefined) signal.addEventListener('abort', cancelSession, { once: true })
    try {
      if (request.prompt.trim() === '') throw new Error('AI 生成需求不能为空')
      const checkpoint = generationOptions.checkpoint
      const report = async (phase: WorkflowGenerationProgressUpdate['phase'], message: string): Promise<void> => {
        throwIfAborted(signal)
        await onProgress?.({ phase, message })
      }
      const persistCheckpoint = async (phase: WorkflowGenerationCheckpoint['phase'], lastModelOutput?: string): Promise<void> => {
        const next: WorkflowGenerationCheckpoint = {
          phase,
          createdEmployees: cloneWorkflow(createdEmployees),
          warnings: [...employeeWarnings],
          ...(selectedEmployeeIds.size === 0 ? {} : { selectedEmployeeIds: [...selectedEmployeeIds] }),
          ...(generationSession === undefined ? (checkpoint?.sessionId === undefined ? {} : { sessionId: checkpoint.sessionId }) : { sessionId: generationSession.sessionId }),
          ...(lastModelOutput === undefined ? (checkpoint?.lastModelOutput === undefined ? {} : { lastModelOutput: checkpoint.lastModelOutput }) : { lastModelOutput: lastModelOutput.slice(0, 24_000) }),
        }
        await generationOptions.onCheckpoint?.(next)
      }
      const createdEmployees: EmployeeSnapshot[] = (checkpoint?.createdEmployees ?? []).map(cloneWorkflow)
      const employeeWarnings = [...(checkpoint?.warnings ?? [])]
      const selectedEmployeeIds = new Set(checkpoint?.selectedEmployeeIds ?? [])
      let reusedGenerationSession = checkpoint?.sessionId !== undefined
      if (this.options.createGenerationSession !== undefined) {
        try {
          generationSession = await this.options.createGenerationSession({
            ...(checkpoint?.sessionId === undefined ? {} : { sessionId: checkpoint.sessionId }),
            ...(request.model === undefined ? {} : { model: request.model }),
          })
        } catch (error) {
          if (checkpoint?.sessionId === undefined) throw error
          reusedGenerationSession = false
          generationSession = await this.options.createGenerationSession({ ...(request.model === undefined ? {} : { model: request.model }) })
        }
        await persistCheckpoint(checkpoint?.phase ?? 'preparing', checkpoint?.lastModelOutput)
      }
      const complete = (modelRequest: WorkflowLightweightRequest): Promise<string> => generationSession === undefined
        ? this.lightweightClient.complete(modelRequest)
        : generationSession.complete(modelRequest)
      const resumeAtWorkflowGeneration = checkpoint?.phase === 'generating-workflow' || checkpoint?.phase === 'validating'
      const existingEmployees = this.options.listEmployees?.() ?? []
      const catalogEntries = existingEmployees.map(employeeCatalogEntry)
      const enabledEmployeeCount = existingEmployees.filter((employee) => employee.enabled).length
      if (!resumeAtWorkflowGeneration) {
        await report('preparing', '正在整理需求与生成约束。')
        const canCreateEmployees = this.options.createEmployee !== undefined && request.createEmployees !== false
        await report('planning-employees', canCreateEmployees
          ? `正在读取员工目录，已召集共计 ${enabledEmployeeCount} 位候选员工；正在判断是否需要新建专业员工。`
          : `已读取员工目录，共 ${enabledEmployeeCount} 位可用候选员工；已跳过新建专业员工。`)
        if (canCreateEmployees) {
          try {
            const planText = await complete({
              systemPrompt: buildEmployeePlanPrompt(catalogEntries, this.options.getLocale?.() ?? DEFAULT_APP_LOCALE),
              prompt: `用户需求：${request.prompt.slice(0, 8_000)}`,
              outputMode: 'json',
              signal,
              ...(request.model === undefined ? {} : { model: request.model }),
            })
            const plan = extractJsonDocument(planText)
            const specs = isUnknownRecord(plan) && Array.isArray(plan.employees) ? plan.employees : []
            await report('creating-employees', specs.length === 0
              ? `未创建新员工；这不代表最终员工已经选定，后续将从 ${enabledEmployeeCount} 位已有员工中筛选并复用。`
              : `已规划 ${specs.length} 名新专业员工，正在创建。`)
            for (const spec of specs) {
              throwIfAborted(signal)
              const input = employeeSpecToCreateInput(spec)
              if (input === undefined) {
                employeeWarnings.push('AI 规划的员工档案格式无效，已跳过。')
                continue
              }
              try {
                await report('creating-employees', `正在创建专业员工「${employeeDisplayName(input)}（${input.role}）」`)
                createdEmployees.push(await this.options.createEmployee!(input))
                await persistCheckpoint('creating-employees')
              } catch (error) {
                throwIfAborted(signal)
                employeeWarnings.push(`员工「${employeeDisplayName(input)}（${input.role}）」创建失败：${error instanceof Error ? error.message : String(error)}`)
              }
            }
            if (specs.length > 0) await report('creating-employees', createdEmployees.length === specs.length ? `专业员工创建完成，共 ${createdEmployees.length} 名。` : `专业员工处理完成，成功创建 ${createdEmployees.length} 名。`)
          } catch (error) {
            throwIfAborted(signal)
            employeeWarnings.push(`员工规划失败，仅使用现有员工：${error instanceof Error ? error.message : String(error)}`)
            await report('creating-employees', '专业员工规划失败，将继续使用现有员工生成工作流。')
          }
        } else {
          await report('creating-employees', `已跳过新员工创建；后续仍会从 ${enabledEmployeeCount} 位已有员工中筛选候选。`)
        }
      } else {
        await report('generating-workflow', '已恢复生成断点，将复用之前处理好的员工和当前 Session。')
      }
      const finalEmployees = Array.from(new Map([...existingEmployees, ...createdEmployees].map((employee) => [employee.id, employee])).values())
      const finalCatalog = finalEmployees.map(employeeCatalogEntry)
      throwIfAborted(signal)
      const requiresEmployeeSelection = finalCatalog.length > EMPLOYEE_SELECTION_THRESHOLD || JSON.stringify(finalCatalog).length > EMPLOYEE_SELECTION_CATALOG_CHAR_LIMIT
      await report('generating-workflow', requiresEmployeeSelection
        ? '正在从员工目录中按职责覆盖筛选候选员工。'
        : '员工目录规模较小，将把已有员工候选直接交给 Workflow 生成。')
      const generationCatalog = checkpoint?.selectedEmployeeIds !== undefined
        ? finalCatalog.filter((entry) => selectedEmployeeIds.has(entry.id))
        : resumeAtWorkflowGeneration
        ? finalCatalog
        : await this.selectEmployeesForGeneration(request.prompt, finalEmployees, finalCatalog, request.model, employeeWarnings, signal, complete)
      for (const entry of generationCatalog) selectedEmployeeIds.add(entry.id)
      await persistCheckpoint('generating-workflow')
      const selectedEmployeeNames = generationCatalog
        .filter((entry) => entry.enabled)
        .map((entry) => `${entry.displayName}（${entry.role}）`)
      await report('generating-workflow', !requiresEmployeeSelection
        ? `已准备 ${selectedEmployeeNames.length} 位已有员工候选：${selectedEmployeeNames.join('、') || '无'}。`
        : selectedEmployeeNames.length === 0
        ? '没有筛选出可复用的已有员工，后续将使用通用 AI 节点或按需求创建节点。'
        : `已筛选出 ${selectedEmployeeNames.length} 位候选员工：${selectedEmployeeNames.join('、')}。`)
      await report('generating-workflow', '正在根据需求、员工目录和固定 Schema 生成工作流草稿。')
      let text: string
      {
        const workflowAiDocumentation = await this.resolveWorkflowAiDocumentation()
        throwIfAborted(signal)
        text = await complete({
          systemPrompt: buildWorkflowGenerationPrompt(generationCatalog, workflowAiDocumentation),
          prompt: [
            `用户需求：${request.prompt.slice(0, 8_000)}`,
            generationOptions.resumeMessage === undefined ? '' : `这是一次从断点继续的生成。上一次任务未完成，请直接修复并输出完整 Workflow JSON。上次失败原因：${generationOptions.resumeMessage}`,
            !reusedGenerationSession && checkpoint?.lastModelOutput !== undefined ? `上一次模型返回（可能不完整）：\n${checkpoint.lastModelOutput}` : '',
          ].filter(Boolean).join('\n\n'),
          outputMode: 'json',
          signal,
          ...(request.model === undefined ? {} : { model: request.model }),
        })
      }
      await persistCheckpoint('validating', text)
      throwIfAborted(signal)
      const raw = extractJsonDocument(text)
      const candidate = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>), id: `workflow-${randomUUID()}` } : raw
      const normalizedWorkflow = normalizeWorkflow(request.name?.trim() === '' || request.name === undefined
        ? candidate
        : { ...(candidate as Record<string, unknown>), name: request.name.trim() })
      if (normalizedWorkflow === undefined) throw new Error('AI 返回的 Workflow 文档格式无效')
      const repaired = repairGeneratedWorkflow(normalizedWorkflow, generationCatalog)
      await report('validating', '正在规范化节点、补齐布局并校验依赖关系。')
      const workflow = {
        ...layoutWorkflowNodes(repaired.workflow),
        generationPrompt: request.prompt.trim(),
      }
      const validation = validateWorkflow(workflow)
      if (!validation.valid) throw new Error(`AI 返回的 Workflow 不符合结构规范：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`)
      succeeded = true
      await generationSession?.archive().catch(() => undefined)
      return {
        workflow,
        createdEmployees,
        ...(employeeWarnings.length + repaired.warnings.length > 0 ? { employeeWarnings: [...employeeWarnings, ...repaired.warnings] } : {}),
      }
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', cancelSession)
      if (!succeeded) await generationSession?.cancel().catch(() => undefined)
    }
  }

  async modify(request: WorkflowModifyRequest, onProgress?: (update: WorkflowModificationProgressUpdate) => Promise<void> | void, signal?: AbortSignal): Promise<WorkflowModifyResult> {
    if (request.prompt.trim() === '') throw new Error('AI 修改需求不能为空')
    const report = async (phase: WorkflowModificationProgressUpdate['phase'], message: string): Promise<void> => {
      throwIfAborted(signal)
      await onProgress?.({ phase, message })
    }
    throwIfAborted(signal)
    const current = cloneWorkflow(request.workflow)
    await report('preparing', '正在读取当前工作流和修改目标。')
    const validation = validateWorkflow(current)
    if (!validation.valid) throw new Error(`当前 Workflow 无法交给 AI 修改：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`)
    const catalog = (this.options.listEmployees?.() ?? []).map(employeeCatalogEntry)
    await report('analyzing', `正在分析 ${current.nodes.length} 个节点、变量和流程依赖。`)
    await report('generating', '正在根据修改要求生成最小变更方案。')
    let text: string
    {
      const workflowAiDocumentation = await this.resolveWorkflowAiDocumentation()
      throwIfAborted(signal)
      text = await this.lightweightClient.complete({
        systemPrompt: buildWorkflowModificationPrompt(workflowAiDocumentation),
        prompt: [
          `用户希望修改当前工作流：${request.prompt.slice(0, 8_000)}`,
          '当前工作流 JSON：',
          JSON.stringify(current),
          `可用专业员工目录（只能保留其中真实存在的 employeeId）：${JSON.stringify(catalog)}`,
        ].join('\n\n'),
        outputMode: 'json',
        signal,
        ...(request.model === undefined ? {} : { model: request.model }),
      })
    }
    throwIfAborted(signal)
    const raw = extractJsonDocument(text)
    const rawWorkflow = isUnknownRecord(raw) && isUnknownRecord(raw.workflow) ? raw.workflow : raw
    if (!isUnknownRecord(rawWorkflow)) throw new Error('AI 返回的 Workflow 修改结果格式无效')
    const candidate = {
      ...rawWorkflow,
      id: current.id,
      name: typeof rawWorkflow.name === 'string' && rawWorkflow.name.trim() !== '' ? rawWorkflow.name : current.name,
      description: typeof rawWorkflow.description === 'string' ? rawWorkflow.description : current.description,
      revision: current.revision,
      enabled: typeof rawWorkflow.enabled === 'boolean' ? rawWorkflow.enabled : current.enabled,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      ...(current.generationPrompt === undefined ? {} : { generationPrompt: current.generationPrompt }),
      ...(rawWorkflow.permissionPolicy === undefined && current.permissionPolicy !== undefined ? { permissionPolicy: current.permissionPolicy } : {}),
    }
    const normalized = normalizeWorkflow(candidate)
    if (normalized === undefined) throw new Error('AI 返回的 Workflow 修改结果无法解析')
    const repaired = repairGeneratedWorkflow(normalized, catalog)
    await report('validating', '正在校验修改后的节点、变量、连线和无环依赖。')
    const workflow = layoutWorkflowNodes(repaired.workflow)
    const result = validateWorkflow(workflow)
    if (!result.valid) throw new Error(`AI 修改后的 Workflow 不符合结构规范：${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`)
    const changes = describeWorkflowChanges(current, workflow)
    return {
      workflow,
      changes,
      removedNodes: changes
        .filter((change): change is WorkflowModificationChange & { type: 'removed'; targetId: string; targetLabel: string } => change.type === 'removed' && change.targetId !== undefined && change.targetLabel !== undefined)
        .map((change) => ({ id: change.targetId, label: change.targetLabel })),
    }
  }

  private async resolveWorkflowAiDocumentation(): Promise<string | undefined> {
    if (this.options.loadWorkflowAiDocumentation !== undefined) return this.options.loadWorkflowAiDocumentation()
    return this.options.workflowAiDocumentation
  }

  private async selectEmployeesForGeneration(
    requirement: string,
    employees: EmployeeSnapshot[],
    catalog: EmployeeCatalogEntry[],
    model: WorkflowModelSelection | undefined,
    warnings: string[],
    signal?: AbortSignal,
    complete: (request: WorkflowLightweightRequest) => Promise<string> = (request) => this.lightweightClient.complete(request),
  ): Promise<Array<EmployeeCatalogEntry | EmployeeFullCatalogEntry>> {
    throwIfAborted(signal)
    const catalogSize = JSON.stringify(catalog).length
    if (catalog.length <= EMPLOYEE_SELECTION_THRESHOLD && catalogSize <= EMPLOYEE_SELECTION_CATALOG_CHAR_LIMIT) return catalog
    try {
      const text = await complete({
        systemPrompt: buildEmployeeSelectionPrompt(catalog),
        prompt: `用户需求：${requirement.slice(0, 8_000)}`,
        outputMode: 'json',
        signal,
        ...(model === undefined ? {} : { model }),
      })
      const raw = extractJsonDocument(text)
      if (!isUnknownRecord(raw) || !Array.isArray(raw.employeeIds) || raw.employeeIds.some((id) => typeof id !== 'string')) throw new Error('员工筛选结果格式无效')
      const enabledEmployees = new Map(employees.filter((employee) => employee.enabled).map((employee) => [employee.id, employee]))
      const selected = [...new Set(raw.employeeIds.filter((id): id is string => typeof id === 'string'))]
        .map((id) => enabledEmployees.get(id))
        .filter((employee): employee is EmployeeSnapshot => employee !== undefined)
      return selected.map(employeeFullCatalogEntry)
    } catch (error) {
      throwIfAborted(signal)
      warnings.push(`员工候选筛选失败，将使用完整员工目录：${error instanceof Error ? error.message : String(error)}`)
      return catalog
    }
  }

  private createRecord(
    workflow: WorkflowDefinition,
    input: WorkflowValue,
    options: WorkflowRunOptions,
    release?: WorkflowRelease,
  ): WorkflowRunRecord {
    const model = normalizeModelSelection(options.model)
    const hasManagedConnector = workflow.nodes.some((node) => node.type === 'http' && node.config.connectorId !== undefined)
    const connectorGrants = release === undefined
      ? options.connectorGrants === undefined
        ? hasManagedConnector ? [] : undefined
        : narrowConnectorGrants(workflow.permissionPolicy, options.connectorGrants)
      : options.connectorGrants === undefined
        ? cloneConnectorGrants(release.connectorGrants)
        : intersectConnectorGrants(release.connectorGrants, options.connectorGrants)
    return {
      id: `run-${randomUUID()}`,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      ...(release === undefined ? {} : {
        environmentId: release.environmentId,
        releaseId: release.id,
        traceId: `trace-${randomUUID()}`,
      }),
      ...(options.idempotencyKey?.trim() === undefined || options.idempotencyKey.trim() === '' ? {} : { idempotencyKey: options.idempotencyKey.trim() }),
      ...(options.effectIdempotencyKey?.trim() === undefined || options.effectIdempotencyKey.trim() === '' ? {} : { effectIdempotencyKey: options.effectIdempotencyKey.trim() }),
      origin: { kind: 'top-level' },
      status: 'queued',
      input: cloneWorkflow(input),
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending', elapsedMs: 0 })),
      events: [],
      allowShellFile: options.allowShellFile === true,
      allowCode: options.allowCode === true,
      ...(connectorGrants === undefined ? {} : { connectorGrants }),
      debug: options.debug === true,
      ...(model === undefined ? {} : { model }),
    }
  }

  private workflowForRecord(record: WorkflowRunRecord): WorkflowDefinition | undefined {
    if (record.releaseId !== undefined) {
      const release = this.options.resolveReleasedWorkflow?.(record.releaseId)
      if (release === undefined || !verifyWorkflowReleaseIntegrity(release)) return undefined
      return this.resolveReleasedDefinition(release, record.workflowId, record.workflowRevision)
    }
    return this.options.workflowStore.getRevision(record.workflowId, record.workflowRevision) ?? this.options.workflowStore.get(record.workflowId)
  }

  /** Historical recovery must never project state through the current editable graph. */
  private immutableWorkflowForRecord(record: WorkflowRunRecord): WorkflowDefinition | undefined {
    if (record.releaseId !== undefined) {
      const release = this.options.resolveReleasedWorkflow?.(record.releaseId)
      if (release === undefined || !verifyWorkflowReleaseIntegrity(release)) return undefined
      return this.resolveReleasedDefinition(release, record.workflowId, record.workflowRevision)
    }
    return this.options.workflowStore.getRevision(record.workflowId, record.workflowRevision)
  }

  private async backfillLegacyEffectReconciliationTargets(): Promise<void> {
    for (const record of this.options.runStore.list()) {
      if (record.effectReconciliationTargets !== undefined) continue
      if (record.status !== 'paused' && record.status !== 'failed' && record.status !== 'cancelled') continue
      if (!workflowAllNodeRunStates(record.nodeStates).some((state) => state.effectState === 'unknown')) continue
      this.syncEffectReconciliationTargets(record)
      await this.options.runStore.save(record)
    }
  }

  /** Upgrade queued pre-lineage children before the Worker can claim them. */
  private async recoverLegacyChildLineages(): Promise<void> {
    const records = new Map(this.options.runStore.list().map((record) => [record.id, record]))
    const inferredParents = new Map<string, Set<string>>()
    const unreliableReferences = new Set<string>()
    for (const parent of records.values()) {
      const workflow = this.immutableWorkflowForRecord(parent)
      for (const state of workflowAllNodeRunStates(parent.nodeStates)) {
        const childRunId = workflowRunIdOutput(state.output)
        if (childRunId === undefined || !records.has(childRunId)) continue
        const node = workflow?.nodes.find((candidate) => candidate.id === state.nodeId)
        const child = records.get(childRunId)!
        if (node?.type !== 'sub-workflow' || node.config.waitForCompletion !== false || node.config.workflowId !== child.workflowId) {
          unreliableReferences.add(childRunId)
          continue
        }
        const candidates = inferredParents.get(childRunId) ?? new Set<string>()
        candidates.add(parent.id)
        inferredParents.set(childRunId, candidates)
      }
    }
    for (const record of records.values()) {
      if (record.status !== 'queued' || record.workflowAncestry !== undefined) continue
      if (record.parentRunId === undefined) {
        const candidates = [...(inferredParents.get(record.id) ?? [])]
        if (candidates.length === 1 && !unreliableReferences.has(record.id)) {
          record.parentRunId = candidates[0]
          record.origin = { kind: 'child', parentRunId: candidates[0]! }
        } else if (candidates.length > 1 || unreliableReferences.has(record.id) || record.origin?.kind === 'child') {
          record.status = 'paused'
          record.error = '旧版子运行缺少可验证的唯一父级链路，已暂停以避免递归执行。'
          record.completedAt = new Date().toISOString()
          record.events.push(this.createEvent('run-paused', record.error))
          await this.options.runStore.save(record)
          continue
        } else {
          // No durable child provenance: preserve legitimate legacy top-level runs.
          continue
        }
      }
      const ancestry: string[] = []
      const seenRuns = new Set([record.id])
      let parentRunId: string | undefined = record.parentRunId
      let reliable = true
      while (parentRunId !== undefined) {
        if (seenRuns.has(parentRunId)) { reliable = false; break }
        seenRuns.add(parentRunId)
        const parent = records.get(parentRunId)
        if (parent === undefined) { reliable = false; break }
        if (parent.workflowAncestry !== undefined) {
          ancestry.unshift(...parent.workflowAncestry, parent.workflowId)
          parentRunId = undefined
          break
        }
        ancestry.unshift(parent.workflowId)
        parentRunId = parent.parentRunId
      }
      if (new Set(ancestry).size !== ancestry.length) reliable = false
      if (reliable) {
        record.workflowAncestry = ancestry
        record.origin = { kind: 'child', parentRunId: record.parentRunId }
      } else {
        record.status = 'paused'
        record.error = '旧版子运行缺少可验证的父级链路，已暂停以避免递归执行。'
        record.completedAt = new Date().toISOString()
        record.events.push(this.createEvent('run-paused', record.error))
      }
      await this.options.runStore.save(record)
    }
  }

  private revalidateReleasedAccess(record: WorkflowRunRecord): void {
    if (record.releaseId === undefined || this.options.resolveWorkflowEnvironment === undefined) return
    const release = this.resolveReleasedWorkflowOrThrow(record.releaseId)
    const environment = this.options.resolveWorkflowEnvironment(release.environmentId)
    if (environment === undefined) throw new Error(`Workflow environment not found: ${release.environmentId}`)
    if (environment.status !== 'active') throw new Error(`Workflow environment must be active: ${release.environmentId}`)
    record.connectorGrants = restrictConnectorGrantsToEnvironment(
      intersectConnectorGrants(release.connectorGrants, record.connectorGrants ?? []),
      environment,
    )
    record.allowShellFile = record.allowShellFile && environment.allowShellFile
    record.allowCode = record.allowCode === true && environment.allowCode
  }

  private resolveReleasedWorkflowOrThrow(releaseId: string): WorkflowRelease {
    const release = this.options.resolveReleasedWorkflow?.(releaseId)
    if (release === undefined) throw new Error(`Workflow release not found: ${releaseId}`)
    if (!verifyWorkflowReleaseIntegrity(release)) throw new Error('Workflow release integrity verification failed')
    return release
  }

  private resolveReleasedDefinition(
    release: WorkflowRelease,
    workflowId: string,
    workflowRevision: number,
  ): WorkflowDefinition | undefined {
    const definitions = [release.workflowSnapshot, ...(release.workflowDependencies ?? [])]
    const matched = definitions.find((definition) => definition.id === workflowId && definition.revision === workflowRevision)
    return matched === undefined ? undefined : cloneWorkflow(matched)
  }

  private resolveReleasedDefinitionOrThrow(
    release: WorkflowRelease,
    workflowId: string,
    workflowRevision: number,
  ): WorkflowDefinition {
    const workflow = this.resolveReleasedDefinition(release, workflowId, workflowRevision)
    if (workflow === undefined) throw new Error(`Workflow release snapshot not found: ${workflowId}@${String(workflowRevision)}`)
    return workflow
  }

  private async startReleasedDefinition(
    releaseId: string,
    definition: Pick<WorkflowDefinition, 'id' | 'revision'>,
    input: WorkflowValue,
    options: WorkflowRunOptions = {},
    releaseOverride?: WorkflowRelease,
    wakeWorker = true,
    allowHistoricalRelease = false,
  ): Promise<WorkflowRunRecord> {
    const release = releaseOverride ?? this.resolveReleasedWorkflowOrThrow(releaseId)
    if (!allowHistoricalRelease && release.status !== 'published') throw new Error('只能启动已发布的 workflow release')
    const workflow = this.resolveReleasedDefinitionOrThrow(release, definition.id, definition.revision)
    assertValidWorkflow(workflow, '启动发布工作流')
    const effectiveInput = normalizeWorkflowLaunchInput(workflow, input)
    const record = this.createRecord(workflow, effectiveInput, options, release)
    this.revalidateReleasedAccess(record)
    const enqueued = await this.enqueue(record, '发布运行已排队')
    if (wakeWorker) this.worker.wake()
    return cloneWorkflow(enqueued)
  }

  private prepareQueuedRecord(record: WorkflowRunRecord): void {
    const now = new Date().toISOString()
    record.status = 'queued'
    record.queue = {
      ...(record.queue ?? { enqueuedAt: now, availableAt: now }),
      availableAt: now,
    }
    delete record.queue.lease
    delete record.queue.cancellationRequestedAt
  }

  /** Enqueue and journal creation in one persisted snapshot before waking a worker. */
  private async enqueue(record: WorkflowRunRecord, message: string): Promise<WorkflowRunRecord> {
    const now = new Date().toISOString()
    record.queue = { enqueuedAt: now, availableAt: now }
    record.events.push({ id: randomUUID(), time: now, type: 'run-created', message })
    const enqueued = await this.options.runStore.enqueue(record)
    if (enqueued.id === record.id) {
      for (const listener of this.listeners) listener(cloneWorkflow(enqueued))
    }
    return enqueued
  }

  private async handleWorkerExecutionError(runId: string, error: unknown): Promise<void> {
    const record = this.options.runStore.get(runId)
    if (record === undefined || isRetentionStatus(record.status)) return
    record.status = 'failed'
    record.error = error instanceof Error ? error.message : String(error)
    record.completedAt = new Date().toISOString()
    await this.save(record, 'run-failed', record.error)
  }

  private async execute(runId: string, expectedLease?: WorkflowRunLease, leaseSignal?: AbortSignal, parentActive?: ActiveRun): Promise<void> {
    const active: ActiveRun = { cancelled: false, leaseLost: false, abortController: new AbortController(), sessionIds: new Set(), archivedSessionIds: new Set(), sessionKeys: new Map() }
    const onLeaseLost = (): void => {
      active.leaseLost = true
      active.pauseRequested = true
      active.abortController.abort()
      void this.cancelInternalSessions(active)
    }
    if (leaseSignal?.aborted === true) onLeaseLost()
    else leaseSignal?.addEventListener('abort', onLeaseLost, { once: true })
    const parentSignal = parentActive?.abortController.signal
    const onParentAbort = (): void => {
      active.cancelled = true
      active.pauseRequested = parentActive?.pauseRequested
      active.abortController.abort()
      void this.cancelInternalSessions(active)
    }
    if (parentSignal?.aborted === true) onParentAbort()
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    this.active.set(runId, active)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined || active.leaseLost) return
      if (expectedLease !== undefined && !sameLease(record.queue?.lease, expectedLease)) return
      if (record.queue?.cancellationRequestedAt !== undefined) {
        record.status = 'cancelled'
        record.error = '用户取消了运行'
        record.completedAt = new Date().toISOString()
        await this.save(record, 'run-cancelled', record.error)
        return
      }
      const workflow = this.workflowForRecord(record)
      if (workflow === undefined) throw new Error('关联的 Workflow 已不存在')
      assertValidWorkflow(workflow, '运行工作流')
      this.revalidateReleasedAccess(record)
      const lineage = new Set([...(record.workflowAncestry ?? []), record.workflowId])
      const recursiveNode = workflow.nodes.find((node) => {
        if (node.type !== 'sub-workflow') return false
        return lineage.has(node.config.workflowId)
      })
      if (recursiveNode?.type === 'sub-workflow') {
        const error = new WorkflowRecursiveCallError([...(record.workflowAncestry ?? []), record.workflowId, recursiveNode.config.workflowId])
        const state = record.nodeStates.find((candidate) => candidate.nodeId === recursiveNode.id)
        if (state !== undefined) {
          state.status = 'failed'
          state.error = error.message
          state.completedAt = new Date().toISOString()
        }
        record.status = 'failed'
        record.error = error.message
        record.completedAt = new Date().toISOString()
        await this.saveFailure(record, 'node-failed', error.message, recursiveNode.id)
        return
      }
      if (this.hasUncheckpointedLoopEffects(record)) {
        record.status = 'paused'
        record.error = '旧版循环缺少逐迭代副作用记录，请先人工核对，未自动重放。'
        record.completedAt = new Date().toISOString()
        await this.save(record, 'run-paused', record.error)
        return
      }
      record.status = 'running'
      record.startedAt ??= new Date().toISOString()
      await this.save(record, 'run-started', '运行开始')

      const order = topologicalOrder(workflow)
      const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]))
      const stateMap = new Map(record.nodeStates.map((state) => [state.nodeId, state]))
      const outputs = new Map<string, WorkflowValue>()
      for (const state of record.nodeStates) if (state.output !== undefined) outputs.set(state.nodeId, state.output)

      const incomingByNode = new Map(workflow.nodes.map((node) => [node.id, workflow.edges.filter((edge) => edge.target === node.id)]))
      const dependencyIdsByNode = new Map(workflow.nodes.map((node) => {
        const dependencies = workflowNodeDependencyIds(workflow, node)
        if (node.type !== 'loop') return [node.id, dependencies] as const
        const bodyNodeIds = new Set(workflowLoopBodyNodeIds(workflow, node.id))
        const bodyDependencies = workflow.nodes
          .filter((candidate) => bodyNodeIds.has(candidate.id))
          .flatMap((candidate) => (candidate.inputBindings ?? []).map((binding) => binding.sourceNodeId))
          .filter((sourceId) => sourceId !== node.id && !bodyNodeIds.has(sourceId))
        return [node.id, [...new Set([...dependencies, ...bodyDependencies])] ] as const
      }))
      // A loop-body node is executed inside its owning loop for every item;
      // it must not also be scheduled as an ordinary topological node.
      const loopBodyNodeIds = new Set(workflow.nodes.filter((node) => node.type === 'loop').flatMap((node) => workflowLoopBodyNodeIds(workflow, node.id)))
      const pending = new Set(order.filter((nodeId) => stateMap.get(nodeId)?.status === 'pending' && !loopBodyNodeIds.has(nodeId)))
      while (pending.size > 0 && !active.cancelled && !active.leaseLost) {
        const ready = order.flatMap((nodeId) => {
          if (!pending.has(nodeId)) return []
          if (stateMap.get(nodeId)?.status !== 'pending') {
            pending.delete(nodeId)
            return []
          }
          const dependencyIds = dependencyIdsByNode.get(nodeId) ?? []
          return dependencyIds.every((sourceId) => isTerminalNodeState(stateMap.get(sourceId)?.status)) ? [nodeId] : []
        })
        if (ready.length === 0) throw new Error('Workflow 存在无法继续推进的依赖关系。')

        const runnable: Array<{ node: WorkflowNode; state: WorkflowNodeRunState; incoming: WorkflowEdge[] }> = []
        for (const nodeId of ready) {
          pending.delete(nodeId)
          const node = nodeMap.get(nodeId)
          const state = stateMap.get(nodeId)
          if (node === undefined || state === undefined) continue
          const incoming = incomingByNode.get(node.id) ?? []
          const activeIncoming = incoming.filter((edge) => this.isEdgeActive(edge, workflow.edges, nodeMap, stateMap, outputs))
          if (incoming.length > 0 && activeIncoming.length === 0) {
            state.status = 'skipped'
            state.completedAt = new Date().toISOString()
            state.elapsedMs = 0
            await this.save(record, 'node-skipped', '条件分支未命中', node.id)
            continue
          }
          runnable.push({ node, state, incoming: activeIncoming })
        }
        if (runnable.length === 0) continue

        const outcomes = await Promise.all(runnable.map(({ node, state, incoming }) => this.executeReadyNode(
          node, state, incoming, record, outputs, active, workflow, nodeMap, stateMap,
        )))
        if (outcomes.some((outcome) => outcome === 'waiting-approval' || outcome === 'stopped')) return
      }

      if (active.leaseLost) return
      if (active.cancelled) {
        record.status = active.pauseRequested ? 'paused' : 'cancelled'
        record.error = active.pauseRequested ? '应用正在切换工作区，运行已暂停。' : '用户取消了运行'
        record.completedAt = new Date().toISOString()
        await this.save(record, active.pauseRequested ? 'run-paused' : 'run-cancelled', record.error)
        return
      }
      // Completed continue-loops have already converted handled body failures
      // into iteration results. Keep their failed inspection states without
      // treating those projections as unhandled top-level failures.
      const handledLoopBodyIds = new Set(workflow.nodes.flatMap((node) => (
        node.type === 'loop' && node.config.failureStrategy === 'continue' && stateMap.get(node.id)?.status === 'completed'
          ? workflowLoopBodyNodeIds(workflow, node.id) : []
      )))
      const hasFailure = record.nodeStates.some((state) => state.status === 'failed' && !handledLoopBodyIds.has(state.nodeId))
      if (hasFailure) {
        record.status = 'failed'
        record.completedAt = new Date().toISOString()
        await this.save(record, 'run-failed', record.error ?? '节点执行失败')
        return
      }
      const outputNodes = workflow.nodes.filter((node) => node.type === 'output')
      const lastOutput = outputNodes.map((node) => outputs.get(node.id)).find((value) => value !== undefined)
      record.output = cloneWorkflow(lastOutput ?? Array.from(outputs.values()).at(-1) ?? record.input)
      record.status = active.cancelled ? 'cancelled' : 'completed'
      record.completedAt = new Date().toISOString()
      await this.save(record, active.cancelled ? 'run-cancelled' : 'run-completed', active.cancelled ? '用户取消了运行' : '运行完成')
      await this.options.workflowStore.markLastRun(workflow.id, runId)
    } catch (error) {
      if (active.leaseLost) return
      const record = this.options.runStore.get(runId)
      if (record === undefined) return
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      record.completedAt = new Date().toISOString()
      await this.save(record, 'run-failed', record.error)
    } finally {
      leaseSignal?.removeEventListener('abort', onLeaseLost)
      parentSignal?.removeEventListener('abort', onParentAbort)
      await this.archiveInternalSessions(runId, active).catch(() => undefined)
      this.active.delete(runId)
      const status = this.options.runStore.get(runId)?.status
      if (status === 'completed' || status === 'cancelled' || status === 'failed') this.liveLineages.delete(runId)
    }
  }

  private async executeReadyNode(
    node: WorkflowNode,
    state: WorkflowNodeRunState,
    incoming: WorkflowEdge[],
    record: WorkflowRunRecord,
    outputs: Map<string, WorkflowValue>,
    active: ActiveRun,
    workflow: WorkflowDefinition,
    nodeMap: Map<string, WorkflowNode>,
    stateMap: Map<string, WorkflowNodeRunState>,
  ): Promise<'completed' | 'waiting-approval' | 'stopped'> {
    state.status = 'running'
    state.startedAt = new Date().toISOString()
    if (state.executionScope === undefined) this.resetDownstreamNodeStates(workflow, node.id, stateMap, outputs)
    const executionStartedAt = Date.now()
    await this.save(record, 'node-started', `开始执行节点：${node.label}`, node.id, state.executionScope)
    try {
      const previous = state.executionScope === undefined ? this.resolveNodeInput(node, incoming, outputs, record.input) : state.input ?? null
      state.input = cloneWorkflow(previous)
      const output = await this.executeNodeWithRetry(
        node, state, previous, record, active, workflow, nodeMap, stateMap, outputs,
      )
      if (active.leaseLost) return 'stopped'
      state.status = 'completed'
      state.error = undefined
      state.nextAttemptAt = undefined
      state.output = cloneWorkflow(output)
      state.completedAt = new Date().toISOString()
      state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
      outputs.set(node.id, output)
      this.registerCompensation(node, record, state.executionScope)
      await this.save(record, 'node-completed', `节点完成：${node.label}`, node.id, state.executionScope)
      return 'completed'
    } catch (error) {
      if (active.leaseLost) return 'stopped'
      if (error instanceof WorkflowRetryScheduled) return 'stopped'
      if (error instanceof WorkflowLoopStopped) return 'stopped'
      if (error instanceof WorkflowNodeOutputError && !active.cancelled && !active.pauseRequested) {
        state.status = 'failed'
        state.error = error.message
        state.completedAt = new Date().toISOString()
        state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
        record.status = 'failed'
        record.error = error.message
        record.completedAt = new Date().toISOString()
        await this.saveFailure(record, 'node-failed', error.message, node.id, state.executionScope)
        return 'stopped'
      }
      if (error instanceof WorkflowRecursiveCallError) {
        state.status = 'failed'
        state.effectState = 'none'
        state.error = error.message
        state.completedAt = new Date().toISOString()
        state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
        record.status = 'failed'
        record.error = error.message
        record.completedAt = state.completedAt
        await this.saveFailure(record, 'node-failed', error.message, node.id, state.executionScope)
        return 'stopped'
      }
      if (error instanceof WorkflowApprovalRequired) {
        state.status = 'pending'
        state.startedAt = undefined
        state.completedAt = undefined
        state.elapsedMs = 0
        record.status = 'waiting-approval'
        record.waitingApprovalNodeId = node.id
        record.error = error.message
        await this.save(record, 'approval-requested', error.message, node.id)
        return 'waiting-approval'
      }
      if (error instanceof WorkflowAmbiguousEffectError) {
        state.status = 'pending'
        state.effectState = 'unknown'
        state.error = error.message
        state.completedAt = new Date().toISOString()
        state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
        record.status = 'paused'
        record.error = error.message
        record.completedAt = new Date().toISOString()
        await this.save(record, 'run-paused', error.message, node.id, state.executionScope)
        return 'stopped'
      }
      if (state.effectState === 'prepared' || state.effectState === 'dispatched' || state.effectState === 'confirmed') {
        state.effectState = 'unknown'
        state.status = 'pending'
        state.error = error instanceof Error ? error.message : String(error)
        state.completedAt = new Date().toISOString()
        state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
        record.status = 'paused'
        record.error = active.cancelled
          ? `运行取消时节点“${node.label}”的外部副作用状态未知，已暂停等待人工核对。`
          : `节点“${node.label}”的外部副作用状态未知，已暂停以避免重复执行。`
        record.completedAt = new Date().toISOString()
        await this.save(record, 'run-paused', record.error, node.id, state.executionScope)
        return 'stopped'
      }
      state.status = active.pauseRequested ? 'pending' : active.cancelled ? 'cancelled' : 'failed'
      state.error = error instanceof Error ? error.message : String(error)
      state.completedAt = new Date().toISOString()
      state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
      const owner = state.executionScope === undefined ? undefined : nodeMap.get(state.executionScope.loopNodeId)
      const continueLoop = owner?.type === 'loop' && owner.config.failureStrategy === 'continue' && !active.pauseRequested && !active.cancelled
      record.status = continueLoop ? 'running' : active.pauseRequested ? 'paused' : active.cancelled ? 'cancelled' : 'failed'
      record.error = continueLoop ? undefined : state.error
      record.completedAt = continueLoop ? undefined : new Date().toISOString()
      if (record.status === 'failed') await this.saveFailure(record, 'node-failed', state.error, node.id, state.executionScope)
      else await this.save(record, active.pauseRequested ? 'run-paused' : active.cancelled ? 'run-cancelled' : 'node-failed', state.error, node.id, state.executionScope)
      return 'stopped'
    }
  }

  private async executeNodeWithRetry(
    node: WorkflowNode,
    state: WorkflowNodeRunState,
    previous: WorkflowValue,
    record: WorkflowRunRecord,
    active: ActiveRun,
    workflow: WorkflowDefinition,
    nodeMap: Map<string, WorkflowNode>,
    stateMap: Map<string, WorkflowNodeRunState>,
    outputs: Map<string, WorkflowValue>,
  ): Promise<WorkflowValue> {
    for (;;) {
      if (active.cancelled) throw new Error('运行已取消。')
      state.attempt = (state.attempt ?? 0) + 1
      state.nextAttemptAt = undefined
      try {
        return node.type === 'loop'
          ? await this.executeLoopNode(node, record.input, previous, record.allowShellFile, record.allowCode === true, active, record, workflow, nodeMap, stateMap, outputs, state)
          : await this.executeNode(node, record.input, previous, record.allowShellFile, record.allowCode === true, active, record, state)
      } catch (error) {
        if (error instanceof WorkflowLoopStopped) throw error
        // A cancellation request always wins over a retry plan. In
        // particular, an idempotent connector may still be awaiting a
        // response after its effect was dispatched; replaying it after the
        // user cancelled would violate the run's cancellation contract.
        if (active.cancelled || record.queue?.cancellationRequestedAt !== undefined) throw error
        if (error instanceof WorkflowNodeOutputError) {
          state.output = cloneWorkflow(error.output)
          await this.markEffect(record, state, node, 'confirmed')
          throw error
        }
        const plan = planWorkflowRetry(node, state, error)
        if (plan.decision === 'retry') {
          state.error = error instanceof Error ? error.message : String(error)
          state.nextAttemptAt = new Date(Date.now() + plan.delayMs).toISOString()
          state.status = 'pending'
          state.startedAt = undefined
          state.completedAt = undefined
          record.status = 'queued'
          record.error = state.error
          record.queue = {
            ...(record.queue ?? { enqueuedAt: new Date().toISOString(), availableAt: state.nextAttemptAt }),
            availableAt: state.nextAttemptAt,
          }
          await this.save(record, 'node-retry', `节点失败，将在 ${plan.delayMs}ms 后重试（第 ${plan.nextAttempt} 次）`, node.id, state.executionScope)
          throw new WorkflowRetryScheduled()
        }
        if (plan.decision === 'pause') throw new WorkflowAmbiguousEffectError(error)
        throw error
      }
    }
  }

  private registerCompensation(node: WorkflowNode, record: WorkflowRunRecord, executionScope?: WorkflowExecutionScope): void {
    if (node.compensation === undefined) return
    const stack = record.compensationStack ?? (record.compensationStack = [])
    if (stack.some((entry) => entry.sourceNodeId === node.id && entry.executionScope?.iterationId === executionScope?.iterationId && entry.status !== 'failed')) return
    stack.push({
      sourceNodeId: node.id,
      ...(executionScope === undefined ? {} : { executionScope: cloneWorkflow(executionScope) }),
      action: cloneWorkflow(node.compensation),
      occurrenceId: this.compensationOccurrenceId(record, node.id, executionScope),
      effectState: 'none',
      status: 'pending',
    })
  }

  private compensationOccurrenceId(record: WorkflowRunRecord, sourceNodeId: string, executionScope?: WorkflowExecutionScope): string {
    return `${record.id}:compensation:${sourceNodeId}:${executionScope?.iterationId ?? 'ordinary'}`
  }

  private async markEffect(
    record: WorkflowRunRecord,
    state: WorkflowNodeRunState | undefined,
    node: WorkflowNode,
    phase: 'prepared' | 'dispatched' | 'confirmed',
  ): Promise<void> {
    if (state === undefined || !isEffectfulNode(node)) return
    state.effectState = phase
    await this.save(record, `node-effect-${phase}`, phase === 'prepared' ? `已准备外部副作用：${node.label}` : phase === 'dispatched' ? `已派发外部副作用：${node.label}` : `已确认外部副作用：${node.label}`, node.id, state.executionScope)
  }

  /** Execute the node connected to a loop's body port once per input item. */
  private async executeLoopNode(
    node: Extract<WorkflowNode, { type: 'loop' }>,
    input: WorkflowValue,
    previous: WorkflowValue,
    allowShellFile: boolean,
    allowCode: boolean,
    active: ActiveRun,
    record: WorkflowRunRecord,
    workflow: WorkflowDefinition,
    nodeMap: Map<string, WorkflowNode>,
    stateMap: Map<string, WorkflowNodeRunState>,
    outputs: Map<string, WorkflowValue>,
    ownerState?: WorkflowNodeRunState,
  ): Promise<WorkflowValue> {
    const bodyNodeIds = workflowLoopBodyNodeIds(workflow, node.id)
    const bodyNodes = bodyNodeIds.flatMap((bodyNodeId) => {
      const bodyNode = nodeMap.get(bodyNodeId)
      return bodyNode === undefined ? [] : [bodyNode]
    })
    if (bodyNodes.length === 0) {
      // Legacy loop documents had no body edge and are still executable while
      // users migrate them to the structural form.
      return this.executeNode(node, input, previous, allowShellFile, allowCode, active, record, ownerState)
    }

    const loopInput = this.primaryNodeValue(node, previous)
    const items = Array.isArray(loopInput) ? loopInput : [loopInput]
    if (ownerState === undefined) throw new Error('循环运行状态不存在')
    const iterations = ownerState.loopIterations ?? (ownerState.loopIterations = [])
    const results: WorkflowValue[] = []
    const limit = node.config.maxIterations ?? 20
    if (items.length === 0) {
      for (const bodyNode of bodyNodes) {
        const bodyState = stateMap.get(bodyNode.id)
        if (bodyState === undefined) continue
        bodyState.status = 'skipped'
        bodyState.completedAt = new Date().toISOString()
        bodyState.elapsedMs = 0
        await this.save(record, 'node-skipped', `循环输入为空，跳过循环体：${bodyNode.label}`, bodyNode.id)
      }
    }
    for (const [index, item] of items.slice(0, limit).entries()) {
      if (active.cancelled || active.leaseLost) throw new Error('运行已取消。')
      let iteration = iterations.find((candidate) => candidate.iterationIndex === index)
      if (iteration === undefined) {
        iteration = { iterationIndex: index, iterationId: `${record.id}:loop:${node.id}:iteration:${index}`, input: cloneWorkflow(item), status: 'pending', nodeStates: bodyNodes.map((bodyNode) => ({ nodeId: bodyNode.id, status: 'pending' })) }
        iterations.push(iteration)
      }
      const scope: WorkflowExecutionScope = { loopNodeId: node.id, iterationIndex: index, iterationId: iteration.iterationId }
      let current: WorkflowValue = cloneWorkflow(iteration.input)
      const iterationOutputs = new Map(outputs)
      for (const bodyNodeId of bodyNodeIds) iterationOutputs.delete(bodyNodeId)
      if (iteration.status === 'completed') {
        for (const bodyState of iteration.nodeStates) {
          if (bodyState.output !== undefined) outputs.set(bodyState.nodeId, bodyState.output)
          const summary = stateMap.get(bodyState.nodeId)
          if (summary !== undefined) Object.assign(summary, cloneWorkflow(bodyState), { executionScope: undefined, effectState: undefined })
        }
        results.push(cloneWorkflow(iteration.output ?? null))
        continue
      }
      iteration.status = 'running'
      for (const bodyNode of bodyNodes) {
        const bodyState = iteration.nodeStates.find((candidate) => candidate.nodeId === bodyNode.id)
        if (bodyState === undefined) throw new Error('循环迭代检查点缺少节点状态')
        bodyState.executionScope = scope
        if (bodyState.status === 'completed') {
          current = cloneWorkflow(bodyState.output ?? null)
          iterationOutputs.set(bodyNode.id, current)
          continue
        }
        if (bodyNode.type === 'approval' || bodyNode.type === 'wait-input') throw new Error('循环体暂不支持审批或表单节点')
        bodyState.input ??= cloneWorkflow(this.resolveLoopBodyInput(bodyNode, current, node.id, iterationOutputs))
        // Keep the owner resumable in the same persisted snapshot that queues a
        // body retry or pauses an uncertain effect. The body owns its policy.
        ownerState.status = 'pending'
        const outcome = await this.executeReadyNode(bodyNode, bodyState, [], record, iterationOutputs, active, workflow, nodeMap, stateMap)
        if (active.leaseLost) throw new WorkflowLoopStopped()
        const summary = stateMap.get(bodyNode.id)
        if (summary !== undefined) Object.assign(summary, cloneWorkflow(bodyState), { executionScope: undefined, effectState: undefined })
        if (outcome !== 'completed') {
          if (node.config.failureStrategy === 'continue' && record.status === 'running' && bodyState.status === 'failed' && !active.cancelled && !active.pauseRequested) {
            current = { error: bodyState.error ?? '循环体执行失败', index: index + 1 }
            record.status = 'running'
            record.error = undefined
            record.completedAt = undefined
            record.retentionExpiresAt = undefined
            break
          }
          throw new WorkflowLoopStopped()
        }
        ownerState.status = 'running'
        current = cloneWorkflow(bodyState.output ?? null)
      }
      for (const bodyNodeId of bodyNodeIds) {
        const bodyOutput = iterationOutputs.get(bodyNodeId)
        if (bodyOutput !== undefined) outputs.set(bodyNodeId, bodyOutput)
      }
      iteration.output = cloneWorkflow(current)
      iteration.status = 'completed'
      results.push(current)
      await this.save(record, 'node-completed', `循环第 ${index + 1} 项完成`, node.id, scope)
    }
    return results
  }

  private resolveLoopBodyInput(node: WorkflowNode, item: WorkflowValue, loopNodeId: string, outputs: Map<string, WorkflowValue>): WorkflowValue {
    const bindings = node.inputBindings
    if (bindings === undefined || bindings.length === 0) return item
    return Object.fromEntries(bindings.map((binding) => {
      const value = binding.sourceNodeId === loopNodeId
        ? resolveWorkflowValuePath(item, binding.sourcePath)
        : this.resolveBinding(binding, outputs)
      if (value !== undefined) return [binding.name, cloneWorkflow(value)]
      if (binding.defaultValue !== undefined) return [binding.name, cloneWorkflow(binding.defaultValue)]
      if (binding.required) {
        const field = binding.sourcePath === undefined ? '' : `.${binding.sourcePath}`
        throw new Error(`循环体输入变量“${binding.name}”需要来源“${binding.sourceNodeId}${field}”，但该值不可用。`)
      }
      return [binding.name, null]
    }))
  }

  /** A running predecessor invalidates every previously materialized downstream state. */
  private resetDownstreamNodeStates(
    workflow: WorkflowDefinition,
    sourceNodeId: string,
    stateMap: Map<string, WorkflowNodeRunState>,
    outputs: Map<string, WorkflowValue>,
  ): void {
    const downstream = new Map<string, string[]>()
    for (const edge of workflow.edges) downstream.set(edge.source, [...(downstream.get(edge.source) ?? []), edge.target])
    for (const node of workflow.nodes) {
      for (const binding of node.inputBindings ?? []) downstream.set(binding.sourceNodeId, [...(downstream.get(binding.sourceNodeId) ?? []), node.id])
    }
    const visited = new Set<string>([sourceNodeId])
    const queue = [...(downstream.get(sourceNodeId) ?? [])]
    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
      const state = stateMap.get(nodeId)
      if (state !== undefined && state.status !== 'running') {
        state.status = 'pending'
        state.startedAt = undefined
        state.completedAt = undefined
        state.elapsedMs = 0
        state.error = undefined
        state.input = undefined
        state.output = undefined
        outputs.delete(nodeId)
      }
      queue.push(...(downstream.get(nodeId) ?? []))
    }
  }

  private async executeLiveSubWorkflow(
    node: Extract<WorkflowNode, { type: 'sub-workflow' }>,
    childInput: WorkflowValue,
    allowShellFile: boolean,
    allowCode: boolean,
    record: WorkflowRunRecord,
  ): Promise<WorkflowValue> {
    return this.executeSubWorkflow(
      node.config.workflowId,
      childInput,
      node.config.waitForCompletion !== false,
      node.config.version,
      { allowShellFile, allowCode, connectorGrants: record.connectorGrants, ...(record.model === undefined ? {} : { model: record.model }) },
      record.id,
    )
  }

  private async executeReleasedSubWorkflow(
    node: Extract<WorkflowNode, { type: 'sub-workflow' }>,
    childInput: WorkflowValue,
    allowShellFile: boolean,
    allowCode: boolean,
    record: WorkflowRunRecord,
  ): Promise<WorkflowValue> {
    const releaseId = record.releaseId
    if (releaseId === undefined) throw new Error('发布运行缺少 release 上下文')
    const release = this.resolveReleasedWorkflowOrThrow(releaseId)
    const workflowRevision = node.config.version
    if (typeof workflowRevision !== 'number') throw new Error(`发布子工作流缺少固定版本：${node.config.workflowId}`)
    const childWorkflow = this.resolveReleasedDefinitionOrThrow(release, node.config.workflowId, workflowRevision)
    const waitForCompletion = node.config.waitForCompletion !== false
    const childRun = await this.startReleasedDefinition(
      release.id,
      childWorkflow,
      childInput,
      {
        allowShellFile,
        allowCode,
        ...(record.connectorGrants === undefined ? {} : { connectorGrants: record.connectorGrants }),
        ...(record.model === undefined ? {} : { model: record.model }),
      },
      release,
      !waitForCompletion,
    )
    if (!waitForCompletion) return { runId: childRun.id }
    await this.execute(childRun.id)
    const settled = this.options.runStore.get(childRun.id)
    if (settled === undefined) throw new Error(`Workflow run not found: ${childRun.id}`)
    if (settled.status !== 'completed') throw new Error(settled.error ?? '子工作流执行失败')
    return settled.output ?? null
  }

  private async executeCompensationWorkflow(
    record: WorkflowRunRecord,
    entry: WorkflowCompensationEntry,
    compensationInput: WorkflowValue,
  ): Promise<WorkflowValue> {
    const attemptKey = `${entry.occurrenceId}:attempt:${String(entry.attempt ?? 1)}`
    const runOptions: WorkflowRunOptions = {
      idempotencyKey: attemptKey,
      effectIdempotencyKey: entry.occurrenceId,
      allowShellFile: record.allowShellFile,
      allowCode: record.allowCode === true,
      connectorGrants: record.connectorGrants,
      ...(record.model === undefined ? {} : { model: record.model }),
    }
    try {
      if (record.releaseId === undefined) {
        return await (this.options.executeSubWorkflow === undefined
          ? this.executeSubWorkflow(entry.action.workflowId, compensationInput, entry.action.waitForCompletion !== false, entry.action.workflowRevision, runOptions, record.id)
          : this.options.executeSubWorkflow(entry.action.workflowId, compensationInput, entry.action.waitForCompletion !== false, entry.action.workflowRevision, runOptions))
      }
      this.revalidateReleasedAccess(record)
      const release = this.resolveReleasedWorkflowOrThrow(record.releaseId)
      const revision = entry.action.workflowRevision
      if (revision === undefined) throw new Error(`发布补偿工作流缺少固定版本：${entry.action.workflowId}`)
      const workflow = this.resolveReleasedDefinitionOrThrow(release, entry.action.workflowId, revision)
      const waitForCompletion = entry.action.waitForCompletion !== false
      const childRun = await this.startReleasedDefinition(
        release.id,
        workflow,
        compensationInput,
        runOptions,
        release,
        !waitForCompletion,
        true,
      )
      if (!waitForCompletion) return { runId: childRun.id }
      await this.execute(childRun.id)
      const settled = this.options.runStore.get(childRun.id)
      if (settled === undefined) throw new Error(`Workflow run not found: ${childRun.id}`)
      if (settled.status !== 'completed') throw new Error(settled.error ?? '补偿子工作流执行失败')
      return settled.output ?? null
    } finally {
      const child = this.options.runStore.list(entry.action.workflowId).find((candidate) => candidate.idempotencyKey === attemptKey && candidate.releaseId === record.releaseId)
      if (child !== undefined) {
        entry.childRunId = child.id
        const history = entry.childRunIds ?? (entry.childRunIds = [])
        if (!history.includes(child.id)) history.push(child.id)
      }
    }
  }

  private async executeNode(
    node: WorkflowNode,
    input: WorkflowValue,
    previous: WorkflowValue,
    allowShellFile: boolean,
    allowCode: boolean,
    active: ActiveRun,
    record: WorkflowRunRecord,
    state?: WorkflowNodeRunState,
  ): Promise<WorkflowValue> {
    switch (node.type) {
      case 'input': {
        if (node.config.name !== undefined && isRecord(input) && node.config.name in input) return input[node.config.name] as WorkflowValue
        return input ?? node.config.defaultValue ?? null
      }
      case 'ai-task': {
        const autonomy = node.config.mode === 'autonomous'
          ? '请自行完成必要的推理和规划，但本节点是无状态轻量处理：不得假定可调用 Skill、MCP 或文件工具。'
          : '这是一次无状态的轻量处理；不要扩展到节点指令以外的工作。'
        return this.executeLightweight(
          node,
          [autonomy, node.config.instruction].join('\n\n'),
          input,
          previous,
          node.config.systemPrompt,
          node.config.outputMode,
          active.abortController.signal,
          record.model,
          node.config.outputSchema,
        )
      }
      case 'structured-extract':
        return this.executeStructuredExtract(node, input, previous, active.abortController.signal, record.model)
      case 'sub-workflow': {
        const childInput = node.config.inputMapping === undefined ? this.primaryNodeValue(node, previous) : resolveWorkflowTemplateValue(node.config.inputMapping, input, previous)
        await this.markEffect(record, state, node, 'prepared')
        await this.markEffect(record, state, node, 'dispatched')
        const childOutput = record.releaseId === undefined
          ? await this.executeLiveSubWorkflow(node, childInput, allowShellFile, allowCode, record)
          : await this.executeReleasedSubWorkflow(node, childInput, allowShellFile, allowCode, record)
        await this.markEffect(record, state, node, 'confirmed')
        return childOutput
      }
      case 'employee': {
        const employee = this.options.resolveEmployee(node.config.employeeId)
        if (employee === undefined) throw new Error(`Employee "${node.config.employeeId}" was not found`)
        if (!employee.enabled) throw new Error(`Employee "${node.config.employeeId}" is disabled`)
        const sessionId = await this.getInternalSession(record, active, 'employee', node.id, node.config.employeeId)
        await this.markEffect(record, state, node, 'prepared')
        await this.markEffect(record, state, node, 'dispatched')
        const employeeOutput = await this.adapter.executeEmployeeInSession(sessionId, node, employee, input, previous)
        await this.markEffect(record, state, node, 'confirmed')
        return employeeOutput
      }
      case 'skill': {
        const sessionId = await this.getInternalSession(record, active, 'skill', node.id)
        await this.markEffect(record, state, node, 'prepared')
        await this.markEffect(record, state, node, 'dispatched')
        const skillOutput = await this.adapter.executeSkillInSession(sessionId, node, input, previous)
        await this.markEffect(record, state, node, 'confirmed')
        return skillOutput
      }
      case 'mcp': {
        const argumentsValue = resolveMcpArguments(node.config.arguments ?? {}, input, previous)
        await this.markEffect(record, state, node, 'prepared')
        await this.markEffect(record, state, node, 'dispatched')
        const mcpOutput = await this.mcpClient.call(node.config.tool, argumentsValue)
        await this.markEffect(record, state, node, 'confirmed')
        return mcpOutput
      }
      case 'parallel': return Promise.all(node.config.instructions.map((instruction) => this.executeLightweight(
        { id: node.id, label: node.label, type: node.type }, instruction, input, previous, undefined, 'text', active.abortController.signal, record.model,
      )))
      case 'loop': {
        // Kept only for direct callers of executeNode in older integrations;
        // normal workflow runs dispatch structural loops through executeLoopNode.
        if ((node.config.instruction ?? '').trim() === '') return this.primaryNodeValue(node, previous)
        const loopInput = this.primaryNodeValue(node, previous)
        const items = Array.isArray(loopInput) ? loopInput : [loopInput]
        const results: WorkflowValue[] = []
        for (const item of items.slice(0, node.config.maxIterations ?? 20)) {
          results.push(await this.executeLightweight(
            { id: node.id, label: node.label, type: node.type },
            `${node.config.instruction}\n当前循环项：${JSON.stringify(item)}`,
            input,
            item,
            undefined,
            'text',
            active.abortController.signal,
            record.model,
          ))
        }
        return results
      }
      case 'sleep': {
        await waitForWorkflowDuration(resolveSleepDuration(node.config), active.abortController.signal)
        return previous
      }
      case 'condition': return evaluateCondition(node.config.operator, this.primaryNodeValue(node, previous), node.config.value)
      case 'switch': {
        const value = this.primaryNodeValue(node, previous)
        return value
      }
      case 'approval': throw new WorkflowApprovalRequired(node.config.message)
      case 'wait-input': {
        if (node.config.mode !== 'approval') throw new Error('表单等待暂未接入运行时恢复通道。')
        throw new WorkflowApprovalRequired(node.config.message)
      }
      case 'transform': {
        const primary = this.primaryNodeValue(node, previous)
        const textTemplate = node.config.template === 'prepend' || node.config.template === 'append' || node.config.template === 'replace' || node.config.template === 'text'
        const value = textTemplate && node.inputBindings !== undefined && node.inputBindings.length > 1 && isRecord(previous)
          ? previous[node.inputBindings[0]?.name ?? ''] ?? null
          : primary
        return transform(node.config, previous, value)
      }
      case 'text-merge': {
        const variables = isRecord(previous)
          ? previous
          : node.inputBindings?.length === 1
            ? { [node.inputBindings[0]?.name ?? 'value']: previous }
            : { value: previous }
        const template = node.config.template
        if (template.trim() !== '') return interpolateWorkflowVariables(template, variables)
        return Object.values(variables).map((value) => renderTemplateValue(value)).join(node.config.separator ?? '\n')
      }
      case 'object-builder': return resolveWorkflowTemplateValue(node.config.fields, input, previous)
      case 'list-operator': return applyListOperator(node.config, this.primaryNodeValue(node, previous))
      case 'merge': return applyMerge(node.config, previous)
      case 'output': {
        if (node.config.contentMode === 'text') {
          const variables = isRecord(previous)
            ? previous
            : node.inputBindings?.length === 1
              ? { [node.inputBindings[0]?.name ?? 'value']: previous }
              : { value: previous }
          return interpolateWorkflowVariables(node.config.text ?? '', variables)
        }
        const bindings = node.inputBindings
        if (bindings !== undefined && bindings.length === 1 && isRecord(previous)) return previous[bindings[0]?.name ?? 'result'] ?? null
        return previous
      }
      case 'shell':
        if (!allowShellFile) throw new Error('Shell/File 节点需要运行时显式授权')
        {
          const shellCwd = resolveWorkspacePath(this.options.workflowRoot, node.config.cwd ?? '.')
          await this.markEffect(record, state, node, 'prepared')
          await this.markEffect(record, state, node, 'dispatched')
          const shellOutput = await runShell(node.config.command, node.config.args.map((argument) => interpolateNodeTemplate(argument, previous)), shellCwd, node.config.timeoutMs ?? 120_000, active.abortController.signal)
          await this.markEffect(record, state, node, 'confirmed')
          return shellOutput
        }
      case 'file':
        if (!allowShellFile) throw new Error('Shell/File 节点需要运行时显式授权')
        {
          if (node.config.operation !== 'write') return runFile(this.options.workflowRoot, node.config.operation, node.config.path, node.config.content, previous, node.config.recursive === true)
          resolveWorkspacePath(this.options.workflowRoot, node.config.path)
          await this.markEffect(record, state, node, 'prepared')
          await this.markEffect(record, state, node, 'dispatched')
          const fileOutput = await runFile(this.options.workflowRoot, node.config.operation, node.config.path, node.config.content, previous, node.config.recursive === true)
          await this.markEffect(record, state, node, 'confirmed')
          return fileOutput
        }
      case 'http':
        if (node.config.connectorId === undefined && this.options.allowLegacyHttp === false) throw new Error('HTTP 节点必须绑定托管连接器。')
        if (node.config.connectorId !== undefined && this.options.connectorService?.authorize !== undefined) {
          await this.options.connectorService.authorize(this.buildManagedConnectorRequest(node, record, state?.executionScope), input, previous)
        }
        await this.markEffect(record, state, node, 'prepared')
        await this.markEffect(record, state, node, 'dispatched')
        {
          const httpOutput = node.config.connectorId === undefined
            ? await runHttp(node.config, input, previous, active.abortController.signal)
            : await this.executeManagedConnector(node, input, previous, record, active.abortController.signal, state?.executionScope)
          await this.markEffect(record, state, node, 'confirmed')
          return httpOutput
        }
      case 'code':
        if (!allowCode) throw new Error('代码节点需要运行时显式授权')
        await this.markEffect(record, state, node, 'prepared')
        await this.markEffect(record, state, node, 'dispatched')
        {
          const codeOutput = await runCode(node.config.language, node.config.code, input, previous, this.options.workflowRoot, node.config.timeoutMs ?? 120_000, active.abortController.signal, this.options.nodeCommandPath)
          await this.markEffect(record, state, node, 'confirmed')
          return codeOutput
        }
    }
  }

  private async executeManagedConnector(node: Extract<WorkflowNode, { type: 'http' }>, input: WorkflowValue, previous: WorkflowValue, record: WorkflowRunRecord, signal: AbortSignal, scope?: WorkflowExecutionScope): Promise<WorkflowValue> {
    if (this.options.connectorService === undefined) throw new Error('托管连接器服务不可用。')
    const response = await this.options.connectorService.request(this.buildManagedConnectorRequest(node, record, scope), input, previous, signal)
    return response as unknown as WorkflowValue
  }

  private buildManagedConnectorRequest(node: Extract<WorkflowNode, { type: 'http' }>, record: WorkflowRunRecord, scope?: WorkflowExecutionScope): WorkflowConnectorRequest {
    const config = node.config
    if (config.connectorId === undefined || config.connectorPath === undefined) throw new Error('托管 HTTP 节点缺少连接器路径。')
    return {
      connectorId: config.connectorId,
      connectorPath: config.connectorPath,
      method: config.method,
      headers: config.headers,
      query: config.query,
      body: config.body,
      responseMode: config.responseMode,
      timeoutMs: config.timeoutMs,
      // Compensation children inherit their durable parent occurrence instead
      // of exposing a newly generated child run id at the remote boundary.
      ...(config.method === 'GET' ? {} : { idempotencyKey: this.managedEffectIdempotencyKey(record, node.id, scope) }),
      workflowPolicy: this.workflowForRecord(record)?.permissionPolicy,
      runGrant: record.connectorGrants,
    }
  }

  private managedEffectIdempotencyKey(record: WorkflowRunRecord, nodeId: string, scope?: WorkflowExecutionScope): string {
    const occurrence = scope === undefined
      ? `node:${nodeId}`
      : `loop:${scope.loopNodeId}:iteration:${scope.iterationIndex}:node:${nodeId}`
    const effectBase = record.effectIdempotencyKey ?? record.idempotencyKey
    if (effectBase === undefined) return scope === undefined
      ? `${record.id}:${nodeId}`
      : `${record.id}:loop:${scope?.loopNodeId}:iteration:${scope?.iterationIndex}:node:${nodeId}`
    const base = effectBase
    const suffix = createHash('sha256').update(occurrence).digest('hex').slice(0, 16)
    const key = `${base}:effect:${suffix}`
    return /^[\x21-\x7e]{1,200}$/u.test(key) ? key : `workflow-effect:${createHash('sha256').update(key).digest('hex')}`
  }

  private async executeLightweight(
    node: { id: string; label: string; type: string },
    instruction: string,
    input: WorkflowValue,
    previous: WorkflowValue,
    systemPrompt: string | undefined,
    outputMode: 'text' | 'json',
    signal: AbortSignal,
    model?: WorkflowModelSelection,
    outputSchema?: WorkflowJsonSchema,
  ): Promise<WorkflowValue> {
    const request: WorkflowLightweightRequest = {
      prompt: buildNodePrompt(node, instruction, input, previous, systemPrompt, outputMode, outputSchema),
      outputMode,
      ...(model === undefined ? {} : { model }),
      signal,
    }
    const text = await this.lightweightClient.complete(request)
    if (outputMode === 'text') return text.trim()
    try {
      const parsed = parseWorkflowJson(text)
      if (outputSchema !== undefined && !matchesWorkflowJsonSchema(parsed, outputSchema)) throw new Error('JSON 不符合 outputSchema')
      return parsed
    } catch (initialError) {
      const repair = await this.lightweightClient.complete({
        prompt: [
          '上一次输出不是有效的 JSON。请修复格式并只输出一个有效 JSON 文档，不要解释，不要使用 Markdown 代码围栏。',
          ...(outputSchema === undefined ? [] : [`必须符合以下 JSON Schema：${JSON.stringify(outputSchema)}`]),
          '需要修复的输出：',
          text,
        ].join('\n\n'),
        outputMode: 'json',
        ...(model === undefined ? {} : { model }),
        signal,
      })
      try {
        const parsed = parseWorkflowJson(repair)
        if (outputSchema !== undefined && !matchesWorkflowJsonSchema(parsed, outputSchema)) throw new Error('JSON 不符合 outputSchema')
        return parsed
      } catch (repairError) {
        throw invalidWorkflowJsonOutputError(node.label, initialError, repairError, {
          originalResponse: text,
          repairResponse: repair,
        })
      }
    }
  }

  private async executeStructuredExtract(
    node: Extract<WorkflowNode, { type: 'structured-extract' }>,
    input: WorkflowValue,
    previous: WorkflowValue,
    signal: AbortSignal,
    model?: WorkflowModelSelection,
  ): Promise<WorkflowValue> {
    const attempts = Math.max(1, Math.min(6, (node.config.maxRetries ?? 2) + 1))
    let lastText = ''
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const prompt = [
        '这是一个确定性的结构化提取步骤。请从输入文本中提取信息，只输出 JSON，不要 Markdown 或解释。',
        `JSON Schema：${JSON.stringify(node.config.schema)}`,
        attempt === 0 ? '' : `上一次输出无效，请修正后重试：${lastText}`,
      ].filter(Boolean).join('\n\n')
      lastText = await this.lightweightClient.complete({ prompt: buildNodePrompt({ id: node.id, label: node.label, type: node.type }, prompt, input, previous, undefined, 'json', node.config.schema), outputMode: 'json', ...(model === undefined ? {} : { model }), signal })
      try {
        const parsed = parseWorkflowJson(lastText)
        if (matchesWorkflowJsonSchema(parsed, node.config.schema)) return parsed
      } catch {
        // Try again with the invalid output included in the next prompt.
      }
    }
    throw new Error(`节点“${node.label}”在 ${attempts} 次尝试后仍未生成符合 Schema 的 JSON`)
  }

  private async getInternalSession(
    record: WorkflowRunRecord,
    active: ActiveRun,
    kind: WorkflowInternalSessionKind,
    nodeId: string,
    employeeId?: string,
  ): Promise<string> {
    const reuseKey = kind === 'employee' ? `employee:${employeeId ?? ''}` : `skill:${nodeId}`
    const existing = active.sessionKeys.get(reuseKey)
    if (existing !== undefined) return existing
    const sessionId = await this.adapter.createInternalSession(record.model)
    active.sessionKeys.set(reuseKey, sessionId)
    active.sessionIds.add(sessionId)
    await this.internalSessionStore.register({
      sessionId,
      runId: record.id,
      workflowId: record.workflowId,
      kind,
      nodeId,
      ...(employeeId === undefined ? {} : { employeeId }),
      createdAt: new Date().toISOString(),
    })
    // Archiving affects only workspace visibility, not execution. Doing it at
    // creation keeps workflow-internal sessions out of ordinary chat lists
    // even while a long-running employee task is still active.
    const archivedAt = new Date().toISOString()
    await this.adapter.archiveSession(sessionId)
    active.archivedSessionIds.add(sessionId)
    await this.internalSessionStore.markArchived(sessionId, archivedAt, retentionExpiry(record))
    return sessionId
  }

  private async cancelInternalSessions(active: ActiveRun): Promise<void> {
    await Promise.all(Array.from(active.sessionIds, (sessionId) => this.adapter.cancelSession(sessionId).catch(() => undefined)))
  }

  private async archiveInternalSessions(runId: string, active: ActiveRun): Promise<void> {
    const pendingSessionIds = Array.from(active.sessionIds).filter((sessionId) => !active.archivedSessionIds.has(sessionId))
    if (pendingSessionIds.length === 0) return
    const record = this.options.runStore.get(runId)
    const archivedAt = new Date().toISOString()
    const expiry = retentionExpiry(record ?? { status: 'failed', debug: false })
    await Promise.all(pendingSessionIds.map(async (sessionId) => {
      try {
        await this.adapter.archiveSession(sessionId)
        active.archivedSessionIds.add(sessionId)
        await this.internalSessionStore.markArchived(sessionId, archivedAt, expiry)
      } catch {
        // A workflow result remains valid even when DSH is shutting down; startup maintenance retries known sessions.
      }
    }))
  }

  /** Called during startup, before DSH starts, to permanently remove only known archived workflow sessions. */
  async cleanupExpiredInternalArtifacts(removeArtifact: (sessionId: string) => Promise<void>): Promise<{ runIds: string[]; sessionIds: string[] }> {
    await this.initialize()
    const runIds = await this.options.runStore.pruneExpired()
    const candidates = this.internalSessionStore.expiredArchivedSessionIds()
    const removed: string[] = []
    for (const sessionId of candidates) {
      await removeArtifact(sessionId)
      removed.push(sessionId)
    }
    if (removed.length > 0) await this.internalSessionStore.remove(removed)
    return { runIds, sessionIds: removed }
  }

  private isEdgeActive(edge: WorkflowEdge, edges: WorkflowEdge[], nodeMap: Map<string, WorkflowNode>, stateMap: Map<string, WorkflowNodeRunState>, outputs: Map<string, WorkflowValue>): boolean {
    const sourceState = stateMap.get(edge.source)
    if (sourceState?.status !== 'completed') return false
    const source = nodeMap.get(edge.source)
    if (source?.type === 'switch') {
      const sourceStateInput = stateMap.get(edge.source)?.input
      const selected = this.primaryNodeValue(source, sourceStateInput ?? outputs.get(edge.source) ?? null)
      const matchedCase = source.config.cases.find((entry) => conditionValuesEqual(selected, entry.value))?.id
      return edge.sourcePort === undefined || edge.sourcePort === 'default'
        ? matchedCase === undefined
        : edge.sourcePort === `switch:${matchedCase}`
    }
    if (source?.type !== 'condition') return true
    const sourcePort = conditionSourcePort(edge, edges)
    if (sourcePort === undefined) return false
    return (outputs.get(edge.source) === true) === (sourcePort === 'true')
  }

  private previousValue(incoming: WorkflowEdge[], outputs: Map<string, WorkflowValue>, input: WorkflowValue): WorkflowValue {
    const values = incoming.flatMap((edge) => {
      const value = outputs.get(edge.source)
      return value === undefined ? [] : [{ edge, value }]
    })
    if (values.length === 0) return input
    if (values.length === 1) return values[0]?.value as WorkflowValue
    return values.reduce<Record<string, WorkflowValue>>((result, { edge, value }) => {
      const key = edge.targetPort?.trim() || edge.source
      const existing = result[key]
      result[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value]
      return result
    }, {})
  }

  /** Build the node-local variable object. Untouched legacy nodes retain their former edge-derived payload. */
  private resolveNodeInput(
    node: WorkflowNode,
    incoming: WorkflowEdge[],
    outputs: Map<string, WorkflowValue>,
    input: WorkflowValue,
  ): Record<string, WorkflowValue> | WorkflowValue {
    const bindings = node.inputBindings
    if (bindings === undefined) return this.previousValue(incoming, outputs, input)
    return Object.fromEntries(bindings.map((binding) => [binding.name, this.resolveBinding(binding, outputs)]))
  }

  private resolveBinding(binding: WorkflowNodeInputBinding, outputs: Map<string, WorkflowValue>): WorkflowValue {
    const source = outputs.get(binding.sourceNodeId)
    const value = source === undefined ? undefined : resolveWorkflowValuePath(source, binding.sourcePath)
    if (value !== undefined) return cloneWorkflow(value)
    if (binding.defaultValue !== undefined) return cloneWorkflow(binding.defaultValue)
    if (!binding.required) return null
    const field = binding.sourcePath === undefined ? '' : `.${binding.sourcePath}`
    throw new Error(`节点输入变量“${binding.name}”需要来源“${binding.sourceNodeId}${field}”，但该值不可用。`)
  }

  /** Utility nodes operate on their single selected variable rather than its wrapper object. */
  private primaryNodeValue(node: WorkflowNode, input: WorkflowValue): WorkflowValue {
    const bindings = node.inputBindings
    if (bindings !== undefined && bindings.length === 1 && isRecord(input)) return input[bindings[0]?.name ?? 'result'] ?? null
    return input
  }

  private createEvent(type: WorkflowRunEvent['type'], message: string, nodeId?: string, executionScope?: WorkflowExecutionScope): WorkflowRunEvent {
    return { id: randomUUID(), time: new Date().toISOString(), type, nodeId, message, ...(executionScope === undefined ? {} : { executionScope: cloneWorkflow(executionScope) }) }
  }

  private syncEffectReconciliationTargets(record: WorkflowRunRecord): void {
    const workflow = this.immutableWorkflowForRecord(record)
    if (workflow === undefined) {
      record.effectReconciliationTargets = []
      return
    }
    const nodeLabels = new Map(workflow?.nodes.map((node) => [node.id, node.label]) ?? [])
    const loopBodyNodeIds = new Set(workflow?.nodes.filter((node) => node.type === 'loop').flatMap((node) => workflowLoopBodyNodeIds(workflow, node.id)) ?? [])
    const targets: WorkflowEffectReconciliationTarget[] = []
    const visit = (states: WorkflowNodeRunState[], loop?: { nodeLabel: string; iterationId: string; iterationIndex: number; input: WorkflowValue }): void => {
      for (const state of states) {
        if (state.effectState === 'unknown' && (loop !== undefined || !loopBodyNodeIds.has(state.nodeId))) {
          const iterationId = loop?.iterationId
          const latestEffectEvent = [...record.events].reverse().find((event) => event.nodeId === state.nodeId
            && event.executionScope?.iterationId === iterationId
            && event.type.startsWith('node-effect-'))
          targets.push({
            key: `${record.id}:${iterationId ?? 'ordinary'}:${state.nodeId}:${state.attempt ?? 0}:${state.effectReconciliationHistory?.length ?? 0}:${latestEffectEvent?.id ?? 'no-effect-event'}`,
            nodeId: state.nodeId,
            nodeLabel: nodeLabels.get(state.nodeId) ?? state.nodeId,
            ...(iterationId === undefined ? {} : { iterationId, iterationIndex: loop?.iterationIndex, loopNodeLabel: loop?.nodeLabel }),
            ...(state.input === undefined && loop === undefined ? {} : { input: state.input ?? loop?.input }),
          })
        }
        for (const iteration of state.loopIterations ?? []) {
          visit(iteration.nodeStates, {
            nodeLabel: nodeLabels.get(state.nodeId) ?? state.nodeId,
            iterationId: iteration.iterationId,
            iterationIndex: iteration.iterationIndex,
            input: iteration.input,
          })
        }
      }
    }
    visit(record.nodeStates)
    record.effectReconciliationTargets = targets
  }

  private async save(record: WorkflowRunRecord, type: WorkflowRunEvent['type'], message: string, nodeId?: string, executionScope?: WorkflowExecutionScope): Promise<void> {
    return this.saveEvents(record, [this.createEvent(type, message, nodeId, executionScope)], executionScope)
  }

  private async saveFailure(record: WorkflowRunRecord, detailType: WorkflowRunEvent['type'], message: string, nodeId?: string, executionScope?: WorkflowExecutionScope): Promise<void> {
    const events: WorkflowRunEvent[] = []
    if (!record.events.some((event) => event.type === 'run-failed')) events.push(this.createEvent('run-failed', record.error ?? message))
    events.push(this.createEvent(detailType, message, nodeId, executionScope))
    await this.saveEvents(record, events, executionScope)
  }

  private async saveEvents(record: WorkflowRunRecord, events: WorkflowRunEvent[], executionScope?: WorkflowExecutionScope): Promise<void> {
    executionScope ??= events.find((event) => event.executionScope !== undefined)?.executionScope
    if (executionScope !== undefined) {
      const iteration = record.nodeStates.find((state) => state.nodeId === executionScope.loopNodeId)?.loopIterations?.find((candidate) => candidate.iterationId === executionScope.iterationId)
      for (const bodyState of iteration?.nodeStates ?? []) {
        const summary = record.nodeStates.find((state) => state.nodeId === bodyState.nodeId)
        if (summary === undefined) continue
        // Existing inspectors keep a current-iteration summary. Effects live
        // only in the durable nested journal, never in this display projection.
        for (const key of Object.keys(summary) as Array<keyof WorkflowNodeRunState>) if (key !== 'nodeId') delete summary[key]
        Object.assign(summary, cloneWorkflow(bodyState), { executionScope: undefined, effectState: undefined })
      }
    }
    // WorkflowRunStore owns lease removal and conflict detection. Keeping the
    // caller's lease on this snapshot lets the store reject a stale writer if
    // another Worker reclaimed the run between two checkpoint writes.
    if (isRetentionStatus(record.status) && record.completedAt !== undefined && record.retentionExpiresAt === undefined) {
      record.retentionExpiresAt = retentionExpiry(record)
    }
    record.events.push(...events.map((event) => cloneWorkflow(event)))
    this.syncEffectReconciliationTargets(record)
    const saved = await this.options.runStore.save(record)
    for (const listener of this.listeners) listener(cloneWorkflow(saved))
  }
}

function appendEffectReconciliation(state: WorkflowNodeRunState, decision: WorkflowEffectReconciliation): void {
  const history = state.effectReconciliationHistory ?? (state.effectReconciliationHistory = state.effectReconciliation === undefined ? [] : [cloneWorkflow(state.effectReconciliation)])
  history.push(cloneWorkflow(decision))
  state.effectReconciliation = cloneWorkflow(decision)
}

function appendCompensationEffectReconciliation(entry: WorkflowCompensationEntry, decision: WorkflowCompensationEffectReconciliation): void {
  const history = entry.effectReconciliationHistory ?? (entry.effectReconciliationHistory = entry.effectReconciliation === undefined ? [] : [cloneWorkflow(entry.effectReconciliation)])
  history.push(cloneWorkflow(decision))
  entry.effectReconciliation = cloneWorkflow(decision)
}

function workflowRunIdOutput(value: WorkflowValue | undefined): string | undefined {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') return undefined
  const runId = value.runId
  return typeof runId === 'string' && runId.trim() !== '' ? runId : undefined
}

/** Final reconciliation also restores safe branches left in-flight at a crash. */
function resetInterruptedSafeNodeStates(states: WorkflowNodeRunState[]): void {
  for (const state of states) {
    if (state.status === 'completed') continue
    const safe = state.effectState === undefined || state.effectState === 'none'
    if (safe && (state.status === 'running' || state.status === 'failed' || state.status === 'cancelled')) {
      state.status = 'pending'
      state.error = undefined
      state.startedAt = undefined
      state.completedAt = undefined
      state.elapsedMs = undefined
      state.nextAttemptAt = undefined
      state.input = undefined
      state.output = undefined
    }
    for (const iteration of state.loopIterations ?? []) {
      if (iteration.status !== 'completed') resetInterruptedSafeNodeStates(iteration.nodeStates)
    }
  }
}

class WorkflowLoopStopped extends Error {}

class WorkflowApprovalRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowApprovalRequired'
  }
}

class WorkflowAmbiguousEffectError extends Error {
  constructor(cause: unknown) {
    super(`节点执行结果不确定，已暂停以避免重复副作用：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'WorkflowAmbiguousEffectError'
  }
}

class WorkflowRecursiveCallError extends Error {
  constructor(lineage: readonly string[]) {
    super(`不允许递归调用子工作流：${lineage.join(' → ')}`)
    this.name = 'WorkflowRecursiveCallError'
  }
}

class WorkflowRetryScheduled extends Error {
  constructor() {
    super('节点已排队等待重试。')
    this.name = 'WorkflowRetryScheduled'
  }
}

function isTerminalNodeState(status: WorkflowNodeRunState['status'] | undefined): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed' || status === 'cancelled'
}

function sameLease(left: WorkflowRunLease | undefined, right: WorkflowRunLease): boolean {
  return left?.ownerId === right.ownerId && left.claimedAt === right.claimedAt && left.expiresAt === right.expiresAt
}

function isEffectfulNode(node: WorkflowNode): boolean {
  if (node.type === 'file') return node.config.operation === 'write'
  if (node.type === 'http') return node.config.method !== 'GET'
  return node.type === 'mcp' || node.type === 'shell' || node.type === 'code' || node.type === 'employee' || node.type === 'skill' || node.type === 'sub-workflow'
}

/**
 * Workflows saved before condition ports were required have unlabelled exits.
 * Preserve their two-way intent deterministically (first exit = true, second = false)
 * instead of treating every exit as active and running both branches.
 */
function conditionSourcePort(edge: WorkflowEdge, edges: WorkflowEdge[]): 'true' | 'false' | undefined {
  if (edge.sourcePort === 'true' || edge.sourcePort === 'false') return edge.sourcePort
  const legacyExits = edges.filter((candidate) => candidate.source === edge.source && candidate.sourcePort !== 'true' && candidate.sourcePort !== 'false')
  const index = legacyExits.findIndex((candidate) => candidate.id === edge.id)
  return index === 0 ? 'true' : index === 1 ? 'false' : undefined
}

function isRecord(value: WorkflowValue): value is { [key: string]: WorkflowValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Intersect caller-supplied one-run grants with the saved workflow policy. */
function narrowConnectorGrants(
  policy: WorkflowDefinition['permissionPolicy'],
  grants: NonNullable<WorkflowRunOptions['connectorGrants']>,
): NonNullable<WorkflowRunRecord['connectorGrants']> {
  const permissions = new Map((policy?.connectors ?? []).map((permission) => [permission.connectorId.trim(), new Set(permission.operations)]))
  const narrowed = new Map<string, Set<'read' | 'write'>>()
  for (const grant of grants) {
    const connectorId = grant.connectorId.trim()
    const allowed = permissions.get(connectorId)
    if (allowed === undefined) continue
    const operations = narrowed.get(connectorId) ?? new Set<'read' | 'write'>()
    for (const operation of grant.operations) if (allowed.has(operation)) operations.add(operation)
    if (operations.size > 0) narrowed.set(connectorId, operations)
  }
  return [...narrowed.entries()].map(([connectorId, operations]) => ({ connectorId, operations: [...operations] }))
}

function cloneConnectorGrants(
  grants: readonly { connectorId: string; operations: readonly ('read' | 'write')[] }[],
): NonNullable<WorkflowRunRecord['connectorGrants']> {
  return grants.map((grant) => ({ connectorId: grant.connectorId, operations: [...grant.operations] }))
}

function intersectConnectorGrants(
  base: readonly { connectorId: string; operations: readonly ('read' | 'write')[] }[],
  requested: readonly { connectorId: string; operations: readonly ('read' | 'write')[] }[],
): NonNullable<WorkflowRunRecord['connectorGrants']> {
  const allowed = new Map(base.map((grant) => [grant.connectorId.trim(), new Set(grant.operations)]))
  const narrowed = new Map<string, Set<'read' | 'write'>>()
  for (const grant of requested) {
    const connectorId = grant.connectorId.trim()
    const permitted = allowed.get(connectorId)
    if (permitted === undefined) continue
    const operations = narrowed.get(connectorId) ?? new Set<'read' | 'write'>()
    for (const operation of grant.operations) if (permitted.has(operation)) operations.add(operation)
    if (operations.size > 0) narrowed.set(connectorId, operations)
  }
  return [...narrowed.entries()].map(([connectorId, operations]) => ({ connectorId, operations: [...operations] }))
}

interface EmployeeCatalogEntry {
  id: string
  displayName: string
  name: string
  role: string
  description: string
  businessBoundary: string
  capabilities: string[]
  skillIds: string[]
  enabled: boolean
}

interface EmployeeFullCatalogEntry extends EmployeeCatalogEntry {
  systemPrompt: string
  operatingGuidelines: string[]
  qualityStandards: string[]
}

const EMPLOYEE_SELECTION_THRESHOLD = 12
const EMPLOYEE_SELECTION_CATALOG_CHAR_LIMIT = 12_000

function employeeCatalogEntry(employee: EmployeeSnapshot): EmployeeCatalogEntry {
  return {
    id: employee.id,
    displayName: employeeDisplayName(employee),
    name: employee.name,
    role: employee.role,
    description: employee.description,
    businessBoundary: employee.businessBoundary,
    capabilities: [...employee.capabilities],
    skillIds: [...employee.skillIds],
    enabled: employee.enabled,
  }
}

function employeeFullCatalogEntry(employee: EmployeeSnapshot): EmployeeFullCatalogEntry {
  return {
    ...employeeCatalogEntry(employee),
    systemPrompt: employee.systemPrompt,
    operatingGuidelines: [...employee.operatingGuidelines],
    qualityStandards: [...employee.qualityStandards],
  }
}

function buildEmployeeSelectionPrompt(catalog: EmployeeCatalogEntry[]): string {
  return [
    '你是 EzDSH 的 Workflow 员工候选筛选助手。根据用户需求识别必须覆盖的职责/角色，并从员工目录中召回所有可能相关的候选员工。',
    '只输出 JSON，不要 Markdown 代码围栏或解释。格式必须是：{"employeeIds":["真实员工ID"],"reason":"选择理由","missingRoles":["缺少但需要的职责"]}。',
    '只能返回目录中 enabled 为 true 的真实 employeeId；目录中的 displayName 是个人名字，role 是岗位职责，筛选必须依据岗位职责、边界和能力，而不是个人名字。不要创建员工，不要返回员工名称。',
    '筛选必须按职责/角色覆盖，而不是按全局人数截断：每一个刚需角色都至少保留一名候选；同一角色下代表不同策略、风格、方法或业务边界的员工都应保留，除非用户明确要求只选择其中一个。不要使用固定的 Top-N，也不要为了凑数排除候选。',
    '如果没有员工适合当前需求，employeeIds 返回空数组，并在 missingRoles 中说明缺少的职责。',
    `可用员工目录：${JSON.stringify(catalog)}`,
  ].join('\n')
}

function buildEmployeePlanPrompt(catalog: EmployeeCatalogEntry[], locale: AppLocale): string {
  const languageInstruction = locale === 'zh'
    ? '所有自然语言字段必须使用简体中文。新员工的 displayName 是个人名字（中文名为主，可允许少量自然英文名），name 是兼容字段中的简短岗位名，role 是正式岗位；其余字段使用简体中文。'
    : 'All natural-language fields must be written in English. A new employee displayName must be a natural English personal name, name is a legacy short role label, role is the formal job title, and all other natural-language fields must be English.'
  return [
    '你是 EZDSH 的 Workflow 员工规划助手。根据用户对工作流的描述，判断需要哪些专业员工（AI Employee）参与，并输出需要新建的员工档案。',
    `已有员工目录（优先复用，不要重复创建职责相同的员工）：${JSON.stringify(catalog)}`,
    '只输出 JSON，不要 Markdown 代码围栏，不要解释。',
    'JSON 必须是一个对象：{"employees": [ { "displayName": "个人名字", "name": "简短岗位名", "role": "正式岗位", "description": "...", "businessBoundary": "...", "systemPrompt": "...", "operatingGuidelines": ["..."], "qualityStandards": ["..."], "capabilities": ["research"], "skillIds": [] } ]}',
    '只有确实需要新建的员工才放进 employees；如果已有目录中的员工能承担全部职责，输出 {"employees": []}。',
    '同一次生成的新员工 displayName 应彼此不同，并尽量不要与已有员工的个人名字重复；displayName 不能直接使用岗位名称。',
    'capabilities 只能使用 research、copywriting、image-generation、file-read、file-write、workflow；skillIds 必须是技能 ID 字符串数组。',
    '不要输出 id、version、schemaVersion、createdAt、updatedAt 或 builtIn；不要生成 API Key、密码、Token、任意代码或危险命令。',
    languageInstruction,
  ].join('\n')
}

function employeeSpecToCreateInput(value: unknown): EmployeeCreateInput | undefined {
  if (!isUnknownRecord(value)) return undefined
  const readString = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string).trim() : '')
  const readStringArray = (key: string): string[] => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string') : []
  const requestedName = readString('name')
  const requestedDisplayName = readString('displayName')
  const role = readString('role')
  const systemPrompt = readString('systemPrompt')
  const name = requestedName || role
  const displayName = requestedDisplayName || name
  if (name === '' || displayName === '' || role === '' || systemPrompt === '') return undefined
  const description = readString('description')
  const capabilities = readStringArray('capabilities').filter((capability): capability is EmployeeCapability => (EMPLOYEE_CAPABILITIES as readonly string[]).includes(capability))
  return {
    displayName,
    name,
    role,
    description,
    businessBoundary: readString('businessBoundary') || description,
    systemPrompt,
    operatingGuidelines: readStringArray('operatingGuidelines'),
    qualityStandards: readStringArray('qualityStandards'),
    capabilities,
    skillIds: readStringArray('skillIds'),
    enabled: true,
  }
}

const GENERATION_CONDITION_OPERATORS = new Set<ConditionOperator>(['truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'])

function generatedInstruction(label: string): string {
  return `请根据上游输入，以「${label}」的职责完成分析，并输出客观、可核验的结果。`
}

function comparableEmployeeText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function findGeneratedEmployee(node: Extract<WorkflowNode, { type: 'employee' }>, catalog: EmployeeCatalogEntry[]): EmployeeCatalogEntry | undefined {
  const requestedId = node.config.employeeId.trim()
  const exact = catalog.find((employee) => employee.id === requestedId && employee.enabled)
  if (exact !== undefined) return exact
  const terms = [node.label, requestedId].map(comparableEmployeeText).filter((value) => value.length >= 2)
  return catalog.find((employee) => employee.enabled && terms.some((term) => {
    const candidates = [employee.id, employee.displayName, employee.name, employee.role].map(comparableEmployeeText)
    return candidates.some((candidate) => candidate === term || candidate.includes(term) || term.includes(candidate))
  }))
}

function repairGeneratedNode(node: WorkflowNode, catalog: EmployeeCatalogEntry[], warnings: string[]): WorkflowNode {
  switch (node.type) {
    case 'employee': {
      const employee = findGeneratedEmployee(node, catalog)
      const instruction = node.config.instruction.trim() || generatedInstruction(node.label)
      if (employee !== undefined) return { ...node, config: { ...node.config, employeeId: employee.id, instruction } }
      warnings.push(`节点「${node.label}」引用的员工不可用，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction, mode: 'single', skillIds: [], outputMode: node.config.outputMode } }
    }
    case 'ai-task': return { ...node, config: { ...node.config, instruction: node.config.instruction.trim() || generatedInstruction(node.label) } }
    case 'structured-extract': return node
    case 'skill': {
      if (node.config.skillId.trim() !== '') return { ...node, config: { ...node.config, instruction: node.config.instruction.trim() || generatedInstruction(node.label) } }
      warnings.push(`节点「${node.label}」未提供 Skill ID，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: node.config.instruction.trim() || generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'mcp': {
      if (node.config.tool.trim() !== '') return node
      warnings.push(`节点「${node.label}」未提供 MCP 工具名，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: node.config.instruction?.trim() || generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'sub-workflow': return { ...node, config: { ...node.config, workflowId: node.config.workflowId.trim(), waitForCompletion: node.config.waitForCompletion !== false } }
    case 'parallel': {
      const instructions = node.config.instructions.filter((instruction) => instruction.trim() !== '')
      return { ...node, config: { instructions: instructions.length > 0 ? instructions : [generatedInstruction(node.label)] } }
    }
    case 'sleep': return node
    case 'loop': return { ...node, config: { ...node.config, ...(node.config.instruction === undefined ? {} : { instruction: node.config.instruction.trim() || generatedInstruction(node.label) }), maxIterations: node.config.maxIterations ?? 20 } }
    case 'condition': return { ...node, config: { ...node.config, operator: GENERATION_CONDITION_OPERATORS.has(node.config.operator) ? node.config.operator : 'truthy' } }
    case 'switch': return { ...node, config: { cases: node.config.cases.filter((entry) => entry.id.trim() !== '').map((entry) => ({ ...entry, id: entry.id.trim(), ...(entry.label === undefined ? {} : { label: entry.label.trim() }) })) } }
    case 'approval': return { ...node, config: { message: node.config.message.trim() || `请确认是否继续执行「${node.label}」后的步骤。` } }
    case 'wait-input': return { ...node, config: { ...node.config, message: node.config.message.trim() || `请确认是否继续执行「${node.label}」后的步骤。` } }
    case 'transform': return ['identity', 'json', 'extract-text', 'prepend', 'append', 'replace', 'text'].includes(node.config.template) ? node : { ...node, config: { ...node.config, template: 'identity' } }
    case 'text-merge': return { ...node, config: { template: node.config.template, separator: node.config.separator ?? '\n' } }
    case 'object-builder': return node
    case 'list-operator': return node
    case 'merge': return node
    case 'shell': {
      if (node.config.command.trim() !== '' && !/[[\]{}();|&<>`$\\]/u.test(node.config.command)) return node
      warnings.push(`节点「${node.label}」包含不完整或不安全的 Shell 配置，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'file': {
      if (['read', 'write', 'list', 'stat', 'extract-text'].includes(node.config.operation)) {
        if (node.config.path.trim() !== '' && !node.config.path.startsWith('/') && !/^[a-zA-Z]:[\\/]/u.test(node.config.path)) return node
      }
      warnings.push(`节点「${node.label}」包含无效文件配置，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'http': {
      if (node.config.connectorId !== undefined) {
        if (node.config.connectorId.trim() !== '' && node.config.connectorPath !== undefined && node.config.connectorPath.trim() !== '') return node
        warnings.push(`节点「${node.label}」包含无效托管连接器配置，已安全改为智能处理节点。`)
        return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
      }
      try {
        const url = new URL(node.config.url)
        if ((url.protocol === 'http:' || url.protocol === 'https:') && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(node.config.method)) return node
      } catch { /* fall through to the safe replacement */ }
      warnings.push(`节点「${node.label}」包含无效 HTTP 配置，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'code': {
      if ((node.config.language === 'nodejs' || node.config.language === 'python3') && node.config.code.trim() !== '') return node
      warnings.push(`节点「${node.label}」包含无效代码配置，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'input':
    case 'output': return node
  }
}

function repairGeneratedEdges(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const repaired: WorkflowEdge[] = []
  const edgeIds = new Set<string>()
  const incoming = new Set<string>()
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target || edgeIds.has(edge.id)) continue
    repaired.push(edge)
    edgeIds.add(edge.id)
    incoming.add(edge.target)
  }
  for (let index = 1; index < nodes.length; index += 1) {
    const target = nodes[index]!
    if (incoming.has(target.id)) continue
    const source = nodes[index - 1]!
    let edgeId = `edge-${source.id}-${target.id}`
    let suffix = 2
    while (edgeIds.has(edgeId)) edgeId = `edge-${source.id}-${target.id}-${suffix++}`
    repaired.push({ id: edgeId, source: source.id, target: target.id, ...(source.type === 'condition' ? { sourcePort: 'true' as const } : {}) })
    edgeIds.add(edgeId)
    incoming.add(target.id)
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const conditionExits = new Map<string, WorkflowEdge[]>()
  for (const edge of repaired) {
    if (nodeById.get(edge.source)?.type !== 'condition') continue
    conditionExits.set(edge.source, [...(conditionExits.get(edge.source) ?? []), edge])
  }
  const normalizedPorts = new Map<string, 'true' | 'false'>()
  for (const exits of conditionExits.values()) {
    const used = new Set<'true' | 'false'>()
    for (const edge of exits) {
      if ((edge.sourcePort === 'true' || edge.sourcePort === 'false') && !used.has(edge.sourcePort)) {
        normalizedPorts.set(edge.id, edge.sourcePort)
        used.add(edge.sourcePort)
      }
    }
    for (const edge of exits) {
      if (normalizedPorts.has(edge.id)) continue
      const port = used.has('true') ? used.has('false') ? undefined : 'false' : 'true'
      if (port === undefined) continue
      normalizedPorts.set(edge.id, port)
      used.add(port)
    }
  }
  return repaired.map((edge) => {
    const sourcePort = normalizedPorts.get(edge.id)
    return sourcePort === undefined ? edge : { ...edge, sourcePort }
  })
}

function generatedTerminalNodeId(nodes: WorkflowNode[], base: string): string {
  const existingIds = new Set(nodes.map((node) => node.id))
  if (!existingIds.has(base)) return base
  let suffix = 2
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

/** Generated workflows always have a runnable input and a visible final result. */
function ensureGeneratedTerminalNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const withInput = nodes.some((node) => node.type === 'input')
    ? nodes
    : [{ id: generatedTerminalNodeId(nodes, 'input'), type: 'input' as const, label: '开始', config: { name: 'task' }, position: { x: 0, y: 0 } }, ...nodes]
  return withInput.some((node) => node.type === 'output')
    ? withInput
    : [...withInput, { id: generatedTerminalNodeId(withInput, 'output'), type: 'output' as const, label: '结束', config: { contentMode: 'variable' as const }, position: { x: 0, y: 0 } }]
}

function repairGeneratedWorkflow(workflow: WorkflowDefinition, catalog: EmployeeCatalogEntry[]): { workflow: WorkflowDefinition; warnings: string[] } {
  const warnings: string[] = []
  const nodes = ensureGeneratedTerminalNodes(workflow.nodes.map((node) => repairGeneratedNode(node, catalog, warnings)))
  return { workflow: { ...workflow, nodes, edges: repairGeneratedEdges(nodes, workflow.edges) }, warnings }
}

function buildWorkflowGenerationPrompt(catalog: EmployeeCatalogEntry[], workflowAiDocumentation?: string): string {
  return [
    '你是 EzDSH Workflow 架构助手。根据用户描述生成一个可审阅、可运行的 Workflow Schema v2 JSON。本文提示词是 docs/ai-workflow-generation.md 的运行时摘要；遵守它，不要凭经验发明节点或运行语义。',
    '只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或额外文本。顶层至少包含 schemaVersion: 2、id、name、description、revision、enabled、nodes、edges。必须有一个 input 节点和一个 output 节点。每个节点都输出唯一 id、type、label、config、position（数字 x/y）、inputBindings（数组）和 outputVariables（数组）；每条边都输出唯一 id、source、target，并且引用已有节点。多节点工作流的 edges 不能为空，图不能有环。',
    '把工作流理解为有向无环图：节点负责一个清晰职责；连线负责执行顺序、分支和汇聚；inputBindings 负责数据来源、字段选择和本地变量名；instruction 只负责使用本节点已经声明的变量。坐标只影响画布，不影响执行。',
    '工作流有多个启动参数时，优先让 input 节点使用 config.fields，例如 [{"name":"topic","label":"主题","type":"string","required":true},{"name":"document","label":"文档","type":"file","required":true},{"name":"attachments","label":"附件","type":"file-list","required":false}]。fields 中的每一项都会出现在运行前输入表单；input 节点的完整 result 仍然是启动输入对象，下游通过 sourcePath 选择字段。只有单值输入才使用 config.name。字段 type 只能是 string、number、boolean、json、file 或 file-list。',
    '输入绑定格式为 {"id":"唯一绑定ID","name":"本节点变量名","sourceNodeId":"来源节点ID","sourcePath":"可选点号字段路径","required":true}，可选 defaultValue。name 必须符合 ^[A-Za-z_][A-Za-z0-9_]*$ 且在本节点内唯一。sourcePath 省略表示来源节点完整 result；设置后只取该字段，例如 summary 或 profile.name。绑定本身也形成执行依赖，即使没有直接边。每个 {{变量}} 或 {{变量.字段}} 都必须有对应绑定；禁止使用未声明的全局历史上下文。',
    '一个节点可以绑定多个上游，一个上游也可以被多个下游绑定。多输入默认是 AND：下游等待所有依赖节点进入终态；没有“任意一个完成即可继续”的 any/or/race/first 语义。失败不是成功值。需要择一路径时使用 condition，不要省略绑定或伪造 OR 汇聚。普通 fan-out 用多个画布节点；parallel 只用于同一节点内并行执行多条相似指令并返回数组。',
    '输出变量用于声明 JSON 输出字段，例如 [{"name":"summary","description":"摘要"}]；每个节点的完整输出都隐含为 result，不要重复声明 result。需要字段级下游引用时使用 outputMode: json、声明 outputVariables，并在 instruction 中要求严格只输出 JSON。',
    '节点类型选择：ai-task 是当前工作流的一次轻量内联推理；当 outputMode=json 时可直接声明严格 outputSchema，校验失败会自动重试，简单场景无需额外节点；structured-extract 是显式的文本到 JSON Schema 提取步骤，支持 maxRetries；employee 是可复用、有业务边界和质量标准的专业岗位；skill 是明确技能；mcp 是明确工具调用；transform 是确定性转换；text-merge 是确定性的多文本合并节点，使用 config.template 和多个 inputBindings 中的 {{变量}} 重组字符串；object-builder 用常量、变量和嵌套模板构造 JSON；list-operator 用于筛选、取字段、映射、排序、去重、截取、分组和聚合数组；merge 用于 append、object-merge、join、zip 或 first-non-null 汇聚多个上游；condition 是二路 If true/false 判断；switch 是按输入值精确匹配多个 case 的多路判断，并从 switch:<caseId> 或 default 端口继续；wait-input 的 approval 预设是人工同意/拒绝（旧 approval 仅兼容历史定义）；sub-workflow 用于选择另一个工作流、映射 inputMapping、等待并读取输出，可用 version 固定修订号或 latest 跟随最新版；loop 是不调用模型、把数组逐项传入下方线性循环体子流程并从右侧收集链末端结果的有限遍历；sleep 是固定等待或每次执行重新随机等待指定范围后原样传递输入；output 是固定的最终结果节点。output 也要声明 inputBindings：变量模式会转发一个或多个绑定值；文本模式使用 config.text 模板，并可在文本中使用已绑定的 {{变量}} 或 {{变量.字段}} 重组多个值。http/code/shell/file 只在用户明确要求时使用。',
    'employee 节点必须引用目录中真实存在且启用的 employeeId，并填写非空 instruction。员工档案包含个人名字 displayName、正式岗位 role 和兼容字段 name；筛选和节点职责描述必须依据 role、业务边界和能力，不要把个人名字当作岗位或 ID。员工是可复用的专业岗位定义，不是一次性任务或运行会话。不要猜不存在的员工或技能。没有合适员工时用 ai-task；只有请求允许创建员工并且已经得到真实 employeeId 时才引用新员工。员工长期职责放在员工档案，当前一次性任务放在节点 instruction。',
    'condition.operator 只能是 truthy、equals、not-equals、contains、greater-than、less-than。每个 condition 最多两条下游路径，必须分别使用 sourcePort: "true" 和 sourcePort: "false"；三种以上情况用嵌套 condition。true/false 汇入共同下游是允许的：未选分支会 skipped，但不要把两个互斥分支结果都设为 required；必要时统一输出结构，或使用 required: false 与 defaultValue。',
    'ai-task.config 必须包含非空 instruction、mode（single 或 autonomous）、skillIds 数组和 outputMode（text 或 json）；json 模式可选 outputSchema（type、properties、required、items、enum、additionalProperties），模型输出必须严格符合 schema。structured-extract.config 必须包含 schema，可选 maxRetries（0 到 5），它是显式的文本到 JSON 提取步骤。employee.config 必须包含真实 employeeId、非空 instruction 和 outputMode。parallel.instructions 至少一条非空字符串；loop 需要一条 sourcePort 为 loop-body 的下方循环体首节点出边、一条 sourcePort 为 loop-next 的右侧后续出边，循环体后续节点只能串成一条线性链，不能分支或连到循环外，maxIterations 在 1 到 100；sleep.config.mode 可为 fixed 或 random，fixed 使用 durationMs，random 使用 minDurationMs 到 maxDurationMs 且每次执行重新取整数；所有时长必须是 0 到 600000 的整数且最小值不能大于最大值；transform.template 只能是 identity、json、extract-text、prepend、append、replace、text，text 模式直接用 config.text 生成新文本，prepend/append/replace 的文本配置可使用已绑定的 {{变量}}；replace 使用 find 和 replacement；text-merge.template 可以是包含 {{变量}} 的文本，template 为空时使用 separator（默认换行）按 inputBindings 顺序合并；file.operation 可为 read、write、list、stat、extract-text，路径必须是 Workflow 工作目录内的相对路径。',
    '需要 HTTP API 时使用 http：method 只能 GET、POST、PUT、PATCH、DELETE，url 只能 http/https，headers 必须是对象，responseMode 只能 auto/json/text，可选 query、body、timeoutMs。代码使用 code：language 只能 nodejs/python3，code 非空；Node.js 使用 input/previous 并 return，Python3 使用 input/previous 并给 result 赋值。code、shell、file 运行前可能需要用户显式授权。',
    '只有用户明确提供 MCP 工具名时才生成 mcp，否则使用 ai-task 或 employee；不要生成空 tool。不要生成 API Key、密码、Token、任意危险命令、eval、反向 Shell、破坏性删除逻辑。不能把会话 ID、运行 ID或运行结果写入工作流定义。',
    '生成流程必须先识别最终结果和启动输入，再拆分职责，设计每个节点的输入绑定与输出字段，之后画控制流和分支，最后校验所有 ID、字段、依赖和无环关系。',
    `可用专业员工目录（只能引用其中的 employeeId；目录可能已经过候选筛选，优先重新核对业务边界和质量标准，不要强行使用不匹配的员工）：${JSON.stringify(catalog)}`,
    workflowDocumentationContext(workflowAiDocumentation),
  ].join('\n')
}

function buildWorkflowModificationPrompt(workflowAiDocumentation?: string): string {
  return [
    '你是 EzDSH Workflow 修改架构助手。你要在用户提供的现有 Workflow Schema v2 上做精确修改，而不是重新臆造一个无关流程。',
    '只输出一个 JSON 对象，必须是修改后的完整 WorkflowDefinition；不要输出 Markdown 代码围栏、解释、changes 字段或额外文本。',
    '除非用户明确要求，否则保留现有工作流的 id、开始节点、结束节点、已有节点职责和已有连线。用户要求拆分时，可以把一个职责拆成多个更细节点，但必须同步更新 edges、inputBindings 和 outputVariables，确保每个节点仍然可执行。',
    '删除节点是高风险修改：只有用户明确要求删除、替换或移除某项职责时才删除；否则保留节点并通过新增、拆分或修改配置实现目标。应用层会比较修改前后的节点并在删除发生时要求用户确认。',
    '把控制流和数据流分开：edges 表达执行顺序、分支和汇聚，inputBindings 表达变量来源。一个节点可以绑定多个来源，一个来源也可以提供给多个下游；多输入默认等待全部依赖完成。switch 必须在 config.cases 中声明唯一的 case id/value，并为每个 case 提供 sourcePort 为 switch:<caseId> 的边，另提供一条 sourcePort 为 default 的兜底边。merge 是通用汇聚节点，优先用它处理图分叉后的数据合并。',
    '所有员工节点必须引用现有员工目录中的真实 employeeId；不要凭空创建员工、技能、MCP 工具或模型。不要把运行结果、会话 ID、API Key、密码或 Token 写入工作流定义。',
    '修改后必须保留且只能保留一个 input 开始节点和一个 output 结束节点；图必须是无环图；每个节点都必须包含合法 type、label、config、position，并正确维护输入绑定和连线引用。',
    '先理解用户要解决的问题，再最小范围修改；如果需求存在多种实现，优先选择用户能在画布和变量面板中直接审阅的实现。',
    workflowDocumentationContext(workflowAiDocumentation, 60_000),
  ].join('\n')
}

function workflowDocumentationContext(documentation?: string, maxCharacters?: number): string {
  const text = documentation?.trim()
  if (text === undefined || text === '') return '当前未能读取本地 Workflow 文档；以上运行时规则是最低约束，不能放宽。'
  const included = maxCharacters === undefined ? text : text.slice(0, maxCharacters)
  return ['以下是随 EzDSH 提供的 Workflow 文档原文，必须把它作为 Schema、变量、执行语义和安全边界的权威约束：', '---', included, '---'].join('\n')
}

function describeWorkflowChanges(before: WorkflowDefinition, after: WorkflowDefinition): WorkflowModificationChange[] {
  const changes: WorkflowModificationChange[] = []
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) changes.push({ type: 'removed', targetId: node.id, targetLabel: node.label, details: `删除节点「${node.label}」。` })
  }
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id)
    if (previous === undefined) {
      changes.push({ type: 'added', targetId: node.id, targetLabel: node.label, details: `新增节点「${node.label}」。` })
      continue
    }
    const { position: _previousPosition, ...previousWithoutPosition } = previous
    const { position: _nextPosition, ...nextWithoutPosition } = node
    if (JSON.stringify(previousWithoutPosition) !== JSON.stringify(nextWithoutPosition)) changes.push({ type: 'updated', targetId: node.id, targetLabel: node.label, details: `更新节点「${node.label}」的配置、提示词或变量。` })
  }

  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]))
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]))
  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) changes.push({ type: 'rewired', targetId: edge.id, details: '移除了一条流程连线。' })
  }
  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id)
    if (previous === undefined) {
      changes.push({ type: 'rewired', targetId: edge.id, details: '新增了一条流程连线。' })
    } else if (JSON.stringify(previous) !== JSON.stringify(edge)) {
      changes.push({ type: 'rewired', targetId: edge.id, details: '调整了一条流程连线。' })
    }
  }
  return changes
}

function normalizeModelSelection(value: unknown): WorkflowModelSelection | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('指定的模型格式无效。')
  const candidate = value as { providerId?: unknown; modelId?: unknown }
  const providerId = typeof candidate.providerId === 'string' ? candidate.providerId.trim() : ''
  const modelId = typeof candidate.modelId === 'string' ? candidate.modelId.trim() : ''
  if (providerId === '' || modelId === '') throw new Error('指定的模型必须包含供应商和模型 ID。')
  return { providerId, modelId }
}

function evaluateCondition(operator: ConditionOperator, left: WorkflowValue, right: WorkflowValue | undefined): boolean {
  switch (operator) {
    case 'truthy': return Boolean(left)
    case 'equals': return conditionValuesEqual(left, right)
    case 'not-equals': return !conditionValuesEqual(left, right)
    case 'contains': return typeof left === 'string' && typeof right === 'string' ? left.includes(right) : Array.isArray(left) && left.some((item) => conditionValuesEqual(item, right))
    case 'greater-than': {
      const leftNumber = conditionNumber(left)
      const rightNumber = conditionNumber(right)
      return leftNumber !== undefined && rightNumber !== undefined && leftNumber > rightNumber
    }
    case 'less-than': {
      const leftNumber = conditionNumber(left)
      const rightNumber = conditionNumber(right)
      return leftNumber !== undefined && rightNumber !== undefined && leftNumber < rightNumber
    }
  }
}

function conditionValuesEqual(left: WorkflowValue, right: WorkflowValue | undefined): boolean {
  return JSON.stringify(conditionScalar(left)) === JSON.stringify(conditionScalar(right))
}

/** Plain run fields arrive as text, so recognize unambiguous JSON scalar spellings during comparison. */
function conditionScalar(value: WorkflowValue | undefined): WorkflowValue | undefined {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return value
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed === null || typeof parsed === 'number' || typeof parsed === 'boolean' ? parsed : value
  } catch {
    return value
  }
}

function conditionNumber(value: WorkflowValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function matchesWorkflowJsonSchema(value: WorkflowValue, schema: WorkflowJsonSchema): boolean {
  if (schema.enum !== undefined && !schema.enum.some((candidate) => conditionValuesEqual(value, candidate))) return false
  switch (schema.type) {
    case 'null': return value === null
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value) && (schema.items === undefined || value.every((item) => matchesWorkflowJsonSchema(item, schema.items!)))
    case 'object': {
      if (!isRecord(value)) return false
      if (schema.required?.some((key) => !(key in value))) return false
      if (schema.properties !== undefined && Object.entries(schema.properties).some(([key, child]) => key in value && !matchesWorkflowJsonSchema(value[key]!, child))) return false
      if (schema.additionalProperties === false && schema.properties !== undefined && Object.keys(value).some((key) => !(key in schema.properties!))) return false
      return true
    }
  }
}

function applyListOperator(config: ListOperatorNodeConfig, input: WorkflowValue): WorkflowValue {
  const items = Array.isArray(input) ? input : [input]
  const atPath = (item: WorkflowValue): WorkflowValue | undefined => resolveWorkflowValuePath(item, config.path)
  switch (config.operation) {
    case 'filter': return items.filter((item) => config.value === undefined || conditionValuesEqual(atPath(item) ?? null, config.value))
    case 'map': return items.map((item) => config.outputPath === undefined ? item : resolveWorkflowValuePath(item, config.outputPath) ?? null)
    case 'pluck': return items.map((item) => resolveWorkflowValuePath(item, config.path) ?? null)
    case 'sort': return [...items].sort((left, right) => compareWorkflowValues(atPath(left), atPath(right)) * (config.descending ? -1 : 1))
    case 'dedupe': {
      const seen = new Set<string>()
      return items.filter((item) => { const key = JSON.stringify(config.path === undefined ? item : atPath(item)); if (seen.has(key)) return false; seen.add(key); return true })
    }
    case 'slice': return items.slice(config.start ?? 0, config.end)
    case 'group': {
      const groups: Record<string, WorkflowValue[]> = {}
      for (const item of items) {
        const key = String(resolveWorkflowValuePath(item, config.groupPath ?? config.path) ?? '')
        groups[key] = [...(groups[key] ?? []), item]
      }
      return groups
    }
    case 'aggregate': {
      const values = config.aggregatePath === undefined ? items : items.map((item) => resolveWorkflowValuePath(item, config.aggregatePath!) ?? null)
      if (config.aggregateMode === 'count') return values.length
      const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      if (config.aggregateMode === 'sum') return numbers.reduce((sum, value) => sum + value, 0)
      if (config.aggregateMode === 'average') return numbers.length === 0 ? 0 : numbers.reduce((sum, value) => sum + value, 0) / numbers.length
      if (config.aggregateMode === 'min') return numbers.length === 0 ? null : Math.min(...numbers)
      if (config.aggregateMode === 'max') return numbers.length === 0 ? null : Math.max(...numbers)
      return { count: items.length, values: items }
    }
  }
}

function compareWorkflowValues(left: WorkflowValue | undefined, right: WorkflowValue | undefined): number {
  if (left === right) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right))
}

function applyMerge(config: MergeNodeConfig, input: WorkflowValue): WorkflowValue {
  const values = isRecord(input) ? Object.values(input) : [input]
  const left = values[0] ?? null
  const right = values[1] ?? null
  switch (config.operation) {
    case 'append': return values.flatMap((value) => Array.isArray(value) ? value : [value])
    case 'object-merge': return Object.assign({}, ...values.filter(isRecord))
    case 'first-non-null': return values.find((value) => value !== null && value !== undefined) ?? null
    case 'zip': {
      const arrays = values.filter(Array.isArray) as WorkflowValue[][]
      const length = Math.max(0, ...arrays.map((array) => array.length))
      return Array.from({ length }, (_item, index) => arrays.map((array) => array[index] ?? null))
    }
    case 'join': {
      if (!Array.isArray(left) || !Array.isArray(right)) return []
      const leftKey = config.leftKey ?? 'id'
      const rightKey = config.rightKey ?? leftKey
      return left.flatMap((item) => {
        if (!isRecord(item)) return []
        const matches = right.filter((candidate) => isRecord(candidate) && conditionValuesEqual(item[leftKey], candidate[rightKey]))
        return matches.map((candidate) => ({ ...item, ...(isRecord(candidate) ? candidate : {}) }))
      })
    }
  }
}

function transform(config: Extract<WorkflowNode, { type: 'transform' }>['config'], input: WorkflowValue, value: WorkflowValue): WorkflowValue {
  const variables = isRecord(input) ? { ...input, ...(Object.prototype.hasOwnProperty.call(input, 'value') ? {} : { value }) } : { value: input }
  const render = (text: string | undefined): string => text === undefined ? '' : interpolateWorkflowVariables(text, variables)
  const renderedValue = renderTemplateValue(value)
  switch (config.template) {
    case 'identity': return value
    case 'json': return JSON.stringify(value, null, 2)
    case 'extract-text': return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.text === 'string' ? value.text : String(value)
    case 'prepend': return `${render(config.text)}${renderedValue}`
    case 'append': return `${renderedValue}${render(config.text)}`
    case 'replace': {
      const find = render(config.find)
      return find === '' ? renderedValue : renderedValue.split(find).join(render(config.replacement))
    }
    case 'text': return render(config.text)
  }
}

function isRetentionStatus(status: WorkflowRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'paused'
}

function retentionExpiry(record: Pick<WorkflowRunRecord, 'status' | 'debug'>): string {
  const days = record.debug === true || record.status === 'failed' || record.status === 'paused' || record.status === 'waiting-approval'
    ? 30
    : 14
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString()
}

export function resolveMcpArguments(
  template: Record<string, WorkflowValue>,
  input: WorkflowValue,
  previous: WorkflowValue,
): Record<string, WorkflowValue> {
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveMcpArgument(value, input, previous)]))
}

function resolveMcpArgument(value: WorkflowValue, input: WorkflowValue, previous: WorkflowValue): WorkflowValue {
  if (typeof value === 'string') {
    if (value === '{{input}}') return cloneWorkflow(input)
    if (value === '{{value}}') return cloneWorkflow(previous)
    const token = value.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}$/u)?.[1]
    const variables = isRecord(previous) ? previous : {}
    if (token !== undefined) {
      const [name, ...path] = token.split('.')
      const root = name === undefined ? undefined : variables[name]
      const resolved = root === undefined ? undefined : resolveWorkflowValuePath(root, path.join('.'))
      if (resolved !== undefined) return cloneWorkflow(resolved)
    }
    return interpolateWorkflowVariables(value
      .replaceAll('{{input}}', renderTemplateValue(input))
      .replaceAll('{{value}}', renderTemplateValue(previous)), variables)
  }
  if (Array.isArray(value)) return value.map((item) => resolveMcpArgument(item, input, previous))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveMcpArgument(item, input, previous)]))
  }
  return value
}

function interpolateNodeTemplate(template: string, variables: WorkflowValue): string {
  return isRecord(variables) ? interpolateWorkflowVariables(template, variables) : template.replaceAll('{{value}}', renderTemplateValue(variables))
}

function renderTemplateValue(value: WorkflowValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function resolveWorkspacePath(root: string, candidate: string): string {
  if (isAbsolute(candidate)) throw new Error('工作区路径必须是相对路径')
  const resolvedRoot = normalize(resolve(root))
  const resolved = normalize(resolve(resolvedRoot, candidate))
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) throw new Error('路径不能离开 Workflow 工作目录')
  return resolved
}

async function runFile(root: string, operation: 'read' | 'write' | 'list' | 'stat' | 'extract-text', path: string, content: string | undefined, previous: WorkflowValue, recursive = false): Promise<WorkflowValue> {
  const filePath = resolveWorkspacePath(root, path)
  if (operation === 'read') return await readFile(filePath, 'utf8')
  if (operation === 'stat') {
    const info = await stat(filePath)
    return { path: normalizeRelativePath(root, filePath), type: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() }
  }
  if (operation === 'list') return listWorkspaceEntries(root, filePath, recursive)
  if (operation === 'extract-text') return extractDocumentText(filePath)
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const rendered = interpolateNodeTemplate(content ?? '{{value}}', previous)
  await writeFile(filePath, rendered, { encoding: 'utf8', mode: 0o600 })
  return rendered
}

function normalizeRelativePath(root: string, filePath: string): string {
  return relative(normalize(resolve(root)), normalize(filePath)).split(sep).join('/') || '.'
}

async function listWorkspaceEntries(root: string, directory: string, recursive: boolean): Promise<WorkflowValue> {
  const entries: Array<{ path: string; type: 'file' | 'directory'; size: number }> = []
  const rootInfo = await stat(directory)
  if (rootInfo.isDirectory() && normalizeRelativePath(root, directory) !== '.') entries.push({ path: normalizeRelativePath(root, directory), type: 'directory', size: 0 })
  const visit = async (current: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true })
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = joinPath(current, child.name)
      if (child.isDirectory()) {
        entries.push({ path: normalizeRelativePath(root, childPath), type: 'directory', size: 0 })
        if (recursive) await visit(childPath)
      } else if (child.isFile()) {
        const info = await stat(childPath)
        entries.push({ path: normalizeRelativePath(root, childPath), type: 'file', size: info.size })
      }
    }
  }
  await visit(directory)
  return entries
}

function joinPath(base: string, child: string): string {
  return `${base}${base.endsWith(sep) ? '' : sep}${child}`
}

async function extractDocumentText(filePath: string): Promise<string> {
  const extension = extname(filePath).toLowerCase()
  const raw = await readFile(filePath)
  if (extension === '.html' || extension === '.htm') return raw.toString('utf8').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (extension === '.json') {
    try { return JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2) } catch { return raw.toString('utf8') }
  }
  if (['.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml'].includes(extension) || extension === '') return raw.toString('utf8')
  if (extension === '.pdf') {
    // Keep a dependency-free fallback for simple text PDFs. Binary streams that
    // need layout-aware extraction should be handled by a dedicated Skill/MCP.
    return raw.toString('latin1').replace(/\(([^)]*)\)\s*Tj/gu, '$1').replace(/\\([\\()])/gu, '$1').replace(/[^\x20-\x7E\n\r\t]/gu, ' ').replace(/\s+/gu, ' ').trim()
  }
  if (extension === '.rtf') return raw.toString('utf8').replace(/\\[a-z]+\d* ?/giu, '').replace(/[{}]/gu, '').replace(/\s+/gu, ' ').trim()
  if (extension === '.docx') return extractDocxText(filePath)
  throw new Error(`暂不支持将 ${extension || '该文件'} 转换为文本，请使用文本文件或安装文档解析 Skill。`)
}

function extractDocxText(filePath: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    const child = spawn('unzip', ['-p', filePath, 'word/document.xml'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) { reject(new Error(`DOCX 文档解析失败：${Buffer.concat(errors).toString('utf8').trim() || '系统未提供 unzip。'}`)); return }
      const xml = Buffer.concat(chunks).toString('utf8')
      const text = xml.replace(/<w:tab\s*\/?\s*>/gu, '\t').replace(/<w:br\s*\/?\s*>/gu, '\n').replace(/<\/w:p>/gu, '\n').replace(/<[^>]+>/gu, '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/\n{3,}/gu, '\n\n').trim()
      resolveText(text)
    })
  })
}

const WORKFLOW_HTTP_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

async function runHttp(config: HttpNodeConfig, input: WorkflowValue, previous: WorkflowValue, parentSignal: AbortSignal): Promise<WorkflowValue> {
  if (parentSignal.aborted) throw new Error('HTTP 请求已取消。')
  const renderedUrl = resolveWorkflowTemplate(config.url, input, previous)
  let url: URL
  try {
    url = new URL(renderedUrl)
  } catch {
    throw new Error('HTTP 请求 URL 无效。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP 请求只允许 http 或 https URL。')
  const query = config.query === undefined ? undefined : resolveWorkflowTemplateValue(config.query, input, previous)
  if (query !== undefined && isRecord(query)) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, renderTemplateValue(value))
  }
  const headers = Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolveWorkflowTemplate(value, input, previous)]))
  const resolvedBody = config.body === undefined ? undefined : resolveWorkflowTemplateValue(config.body, input, previous)
  const requestInit: RequestInit = { method: config.method, headers }
  if (resolvedBody !== undefined && config.method !== 'GET') {
    if (typeof resolvedBody === 'string') requestInit.body = resolvedBody
    else {
      requestInit.body = JSON.stringify(resolvedBody)
      if (Object.keys(headers).every((key) => key.toLowerCase() !== 'content-type')) headers['Content-Type'] = 'application/json'
    }
  }
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (parentSignal.aborted) controller.abort()
  else parentSignal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), clampWorkflowTimeout(config.timeoutMs))
  try {
    let response: Response
    try {
      response = await fetch(url, { ...requestInit, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(parentSignal.aborted ? 'HTTP 请求已取消。' : 'HTTP 请求超时。')
      throw error
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > WORKFLOW_HTTP_MAX_RESPONSE_BYTES) throw new Error('HTTP 响应超过 5 MB 限制。')
    let body: WorkflowValue = text
    if (config.responseMode !== 'text' && (config.responseMode === 'json' || response.headers.get('content-type')?.toLowerCase().includes('application/json') === true)) {
      try { body = JSON.parse(text) as WorkflowValue } catch {
        if (config.responseMode === 'json') throw new Error('HTTP 响应不是有效 JSON。')
      }
    }
    if (!response.ok) throw new Error(`HTTP 请求失败（${response.status}）：${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`)
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), body }
  } finally {
    clearTimeout(timeout)
    parentSignal.removeEventListener('abort', onAbort)
  }
}

function resolveWorkflowTemplateValue(value: WorkflowValue, input: WorkflowValue, previous: WorkflowValue): WorkflowValue {
  if (typeof value === 'string') {
    if (value.trim() === '{{input}}') return cloneWorkflow(input)
    if (value.trim() === '{{value}}') return cloneWorkflow(previous)
    return resolveWorkflowTemplate(value, input, previous)
  }
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowTemplateValue(item, input, previous))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveWorkflowTemplateValue(item, input, previous)]))
  return value
}

function resolveWorkflowTemplate(template: string, input: WorkflowValue, previous: WorkflowValue): string {
  const variables = isRecord(previous) ? previous : {}
  return interpolateWorkflowVariables(template
    .replaceAll('{{input}}', renderTemplateValue(input))
    .replaceAll('{{value}}', renderTemplateValue(previous)), variables)
}

function clampWorkflowTimeout(timeoutMs: number | undefined): number {
  return Math.max(1_000, Math.min(timeoutMs ?? 120_000, 10 * 60 * 1_000))
}

function runCode(language: WorkflowCodeLanguage, code: string, input: WorkflowValue, previous: WorkflowValue, cwd: string, timeoutMs: number, parentSignal: AbortSignal, nodeCommandPath?: string): Promise<WorkflowValue> {
  const nodeScript = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const input = payload.input;
const previous = payload.previous;
const logs = [];
const originalLog = console.log;
console.log = (...args) => logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
try {
  const result = await (async () => {
${code}
  })();
  const output = result === undefined ? logs.join('\\n') : result;
  process.stdout.write(JSON.stringify(output === undefined ? null : output));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally { console.log = originalLog; }
`
  const pythonScript = `
import contextlib, io, json, sys
payload = json.loads(sys.stdin.read())
input = payload.get("input")
previous = payload.get("previous")
result = None
_output = io.StringIO()
try:
    with contextlib.redirect_stdout(_output):
${code.split('\n').map((line) => `        ${line}`).join('\n')}
    if result is None and _output.getvalue().strip():
        result = _output.getvalue().strip()
    print(json.dumps(result, ensure_ascii=False))
except Exception as error:
    print(f"{type(error).__name__}: {error}", file=sys.stderr)
    raise
`
  const command = language === 'nodejs' ? (nodeCommandPath ?? process.execPath) : resolvePythonCommand()
  const args = language === 'nodejs' ? ['--input-type=module', '--eval', nodeScript] : ['-c', pythonScript]
  const environment = language === 'nodejs' && command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
  return runCodeProcess(command, args, cwd, JSON.stringify({ input, previous }), clampWorkflowTimeout(timeoutMs), parentSignal, environment)
}

function resolvePythonCommand(): string {
  const candidates = process.platform === 'win32'
    ? ['python', 'py']
    : ['python3', 'python', '/usr/local/bin/python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const path = process.env.PATH?.split(process.platform === 'win32' ? ';' : ':').find((directory) => existsSync(resolve(directory, candidate)))
    if (path !== undefined) return resolve(path, candidate)
  }
  return candidates[0] ?? 'python3'
}

function runCodeProcess(command: string, args: string[], cwd: string, payload: string, timeoutMs: number, parentSignal: AbortSignal, extraEnvironment?: NodeJS.ProcessEnv): Promise<WorkflowValue> {
  return new Promise((resolvePromise, reject) => {
    if (parentSignal.aborted) {
      reject(new Error('代码节点已取消。'))
      return
    }
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnvironment } })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (error?: Error, value?: WorkflowValue): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parentSignal.removeEventListener('abort', onAbort)
      if (error === undefined) resolvePromise(value ?? null)
      else reject(error)
    }
    const onAbort = (): void => { child.kill(); finish(new Error('代码节点已取消。')) }
    parentSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; child.kill(); finish(new Error('代码节点超时。')) }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout, 'utf8') > WORKFLOW_HTTP_MAX_RESPONSE_BYTES) child.kill() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (settled || timedOut || parentSignal.aborted) return
      if (code !== 0) { finish(new Error(`代码节点退出码 ${String(code)}：${stderr.trim() || stdout.trim()}`)); return }
      const text = stdout.trim()
      if (text === '') { finish(undefined, null); return }
      try {
        const value = JSON.parse(text) as unknown
        if (!isWorkflowValue(value)) throw new Error('代码输出不是 JSON-safe 值')
        finish(undefined, value)
      } catch { finish(undefined, text) }
    })
    child.stdin?.end(payload)
  })
}

function waitForWorkflowDuration(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const onAbort = (): void => finish(new Error('Sleep 节点已取消。'))
    const timer = setTimeout(() => finish(), durationMs)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function resolveSleepDuration(config: { durationMs: number; mode?: 'fixed' | 'random'; minDurationMs?: number; maxDurationMs?: number }): number {
  if (config.mode !== 'random') return config.durationMs
  const min = config.minDurationMs ?? config.durationMs
  const max = config.maxDurationMs ?? min
  return min + Math.floor(Math.random() * (max - min + 1))
}

function runShell(command: string, args: string[], cwd: string, timeoutMs: number, parentSignal: AbortSignal): Promise<WorkflowValue> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error, value?: WorkflowValue): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parentSignal.removeEventListener('abort', onAbort)
      if (error === undefined) resolvePromise(value ?? null)
      else reject(error)
    }
    const onAbort = (): void => {
      child.kill()
      finish(new Error('Shell 节点已取消。'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Shell 节点超时'))
    }, Math.max(1_000, Math.min(timeoutMs, 10 * 60 * 1_000)))
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code !== 0) finish(new Error(`Shell 退出码 ${String(code)}：${stderr.trim() || stdout.trim()}`))
      else finish(undefined, { stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 })
    })
    if (parentSignal.aborted) onAbort()
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const error = new Error('AI 任务已取消。')
  error.name = 'AbortError'
  throw error
}
