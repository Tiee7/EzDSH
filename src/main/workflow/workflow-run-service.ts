import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  WorkflowDefinition,
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
  WorkflowRunEvent,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowValue,
  WorkflowModelSelection,
  ConditionOperator,
  HttpNodeConfig,
  WorkflowCodeLanguage,
} from '../../shared/workflow.js'
import { EMPLOYEE_CAPABILITIES } from '../../shared/employees.js'
import type { EmployeeCapability, EmployeeCreateInput, EmployeeSnapshot } from '../../shared/employees.js'
import { DEFAULT_APP_LOCALE, type AppLocale } from '../../shared/locale.js'
import { cloneWorkflow, interpolateWorkflowVariables, isWorkflowValue, normalizeWorkflow, resolveWorkflowValuePath, validateWorkflow, workflowNodeDependencyIds } from '../../shared/workflow.js'
import { layoutWorkflowNodes } from '../../shared/workflow-layout.js'
import { assertValidWorkflow, topologicalOrder } from './workflow-validator.js'
import { WorkflowStore } from './workflow-store.js'
import { WorkflowRunStore } from './workflow-run-store.js'
import { DshWorkflowAdapter, buildNodePrompt, extractJsonDocument, parseWorkflowJson, type WorkflowSessionClient } from './dsh-workflow-adapter.js'
import type { WorkflowLightweightClient, WorkflowLightweightRequest } from './workflow-lightweight-client.js'
import type { WorkflowMcpClient } from './workflow-mcp-client.js'
import { WorkflowInternalSessionStore, type WorkflowInternalSessionKind } from './workflow-internal-session-store.js'

export interface WorkflowRunServiceOptions {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  workspaceRoot: string
  /** Standalone Node executable bundled with the app, used by code nodes. */
  nodeCommandPath?: string
  createClient: () => WorkflowSessionClient
  resolveEmployee: (id: string) => EmployeeSnapshot | undefined
  listEmployees?: () => EmployeeSnapshot[]
  /** Creates and persists a professional employee profile. Absent ⇒ AI generation never creates employees. */
  createEmployee?: (input: EmployeeCreateInput) => Promise<EmployeeSnapshot>
  /** Locale for natural-language fields in AI-generated employee profiles. */
  getLocale?: () => AppLocale
  /** Canonical EzDSH workflow documentation supplied to generation and modification prompts. */
  workflowAiDocumentation?: string
  lightweightClient?: Pick<WorkflowLightweightClient, 'complete'>
  mcpClient?: Pick<WorkflowMcpClient, 'call'>
  internalSessionStore?: WorkflowInternalSessionStore
}

type RunListener = (record: WorkflowRunRecord) => void

interface ActiveRun {
  cancelled: boolean
  pauseRequested?: boolean
  readonly abortController: AbortController
  readonly sessionIds: Set<string>
  readonly archivedSessionIds: Set<string>
  readonly sessionKeys: Map<string, string>
}

export class WorkflowRunService {
  private readonly listeners = new Set<RunListener>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly adapter: DshWorkflowAdapter
  private readonly lightweightClient: Pick<WorkflowLightweightClient, 'complete'>
  private readonly mcpClient: Pick<WorkflowMcpClient, 'call'>
  private readonly internalSessionStore: WorkflowInternalSessionStore
  private initialized = false

  constructor(private readonly options: WorkflowRunServiceOptions) {
    this.adapter = new DshWorkflowAdapter({ cwd: options.workspaceRoot, createClient: options.createClient })
    this.lightweightClient = options.lightweightClient ?? { complete: async () => { throw new Error('轻量智能处理不可用：请先配置模型供应商。') } }
    this.mcpClient = options.mcpClient ?? { call: async () => { throw new Error('MCP 直连不可用：请检查 MCP 配置。') } }
    this.internalSessionStore = options.internalSessionStore ?? new WorkflowInternalSessionStore(options.workspaceRoot)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.options.workflowStore.initialize()
    await this.options.runStore.initialize()
    await this.internalSessionStore.initialize()
    await this.options.runStore.pauseActiveRuns()
    await this.options.runStore.pruneExpired()
    this.initialized = true
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

  async remove(runId: string): Promise<void> {
    await this.initialize()
    const record = this.options.runStore.get(runId)
    if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
    if (record.status === 'queued' || record.status === 'running' || record.status === 'waiting-approval') {
      throw new Error('运行中的记录不能删除，请先取消运行')
    }
    const removed = await this.options.runStore.remove(runId)
    if (!removed) throw new Error(`Workflow run not found: ${runId}`)
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
  }

  async start(workflowId: string, input: WorkflowValue, options: WorkflowRunOptions = {}): Promise<WorkflowRunRecord> {
    await this.initialize()
    if (!isWorkflowValue(input)) throw new Error('Workflow 输入必须是 JSON-safe 值')
    const workflow = this.options.workflowStore.get(workflowId)
    if (workflow === undefined) throw new Error(`Workflow not found: ${workflowId}`)
    assertValidWorkflow(workflow, '启动运行')
    const record = this.createRecord(workflow, input, options)
    await this.save(record, 'run-created', '运行已排队')
    void this.execute(record.id)
    return cloneWorkflow(record)
  }

  async resume(runId: string): Promise<WorkflowRunRecord> {
    await this.initialize()
    const record = this.options.runStore.get(runId)
    if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
    if (record.status !== 'paused' && record.status !== 'failed') throw new Error('只有暂停或失败的运行可以恢复')
    record.status = 'queued'
    record.error = undefined
    record.completedAt = undefined
    record.retentionExpiresAt = undefined
    for (const node of record.nodeStates) {
      if (node.status === 'failed' || node.status === 'running' || node.status === 'cancelled') {
        node.status = 'pending'
        node.error = undefined
        node.startedAt = undefined
        node.completedAt = undefined
        node.input = undefined
        node.output = undefined
      }
    }
    await this.save(record, 'run-created', '运行已重新排队')
    void this.execute(record.id)
    return cloneWorkflow(record)
  }

  async approve(runId: string, approved: boolean): Promise<WorkflowRunRecord> {
    await this.initialize()
    const record = this.options.runStore.get(runId)
    if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
    if (record.status !== 'waiting-approval' || record.waitingApprovalNodeId === undefined) throw new Error('当前运行没有等待中的审批')
    const workflow = this.options.workflowStore.get(record.workflowId)
    if (workflow === undefined) throw new Error('关联的 Workflow 已不存在')
    const node = workflow.nodes.find((candidate) => candidate.id === record.waitingApprovalNodeId)
    const state = record.nodeStates.find((candidate) => candidate.nodeId === record.waitingApprovalNodeId)
    if (node?.type !== 'approval' || state === undefined) throw new Error('审批节点不存在')
    if (!approved) {
      state.status = 'failed'
      state.error = '审批被拒绝'
      state.completedAt = new Date().toISOString()
      record.status = 'failed'
      record.error = '审批被拒绝'
      record.completedAt = new Date().toISOString()
      record.waitingApprovalNodeId = undefined
      await this.save(record, 'approval-resolved', '审批被拒绝', node.id)
      return this.options.runStore.get(runId) ?? record
    }
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
    await this.save(record, 'approval-resolved', '审批通过，继续运行', node.id)
    void this.execute(runId)
    return this.options.runStore.get(runId) ?? record
  }

  async cancel(runId: string): Promise<WorkflowRunRecord> {
    const record = this.options.runStore.get(runId)
    if (record === undefined) throw new Error(`Workflow run not found: ${runId}`)
    const active = this.active.get(runId)
    if (active !== undefined) {
      active.cancelled = true
      active.abortController.abort()
      await this.cancelInternalSessions(active)
    }
    if (record.status === 'queued' || record.status === 'waiting-approval') {
      record.status = 'cancelled'
      record.waitingApprovalNodeId = undefined
      record.completedAt = new Date().toISOString()
      await this.save(record, 'run-cancelled', '用户取消了运行')
    }
    return this.options.runStore.get(runId) ?? record
  }

  async generate(request: WorkflowGenerateRequest, onProgress?: (update: WorkflowGenerationProgressUpdate) => Promise<void> | void): Promise<WorkflowGenerateResult> {
    if (request.prompt.trim() === '') throw new Error('AI 生成需求不能为空')
    const report = async (phase: WorkflowGenerationProgressUpdate['phase'], message: string): Promise<void> => {
      await onProgress?.({ phase, message })
    }
    await report('preparing', '正在整理需求与生成约束。')
    const existingEmployees = this.options.listEmployees?.() ?? []
    const catalogEntries = existingEmployees.map(employeeCatalogEntry)
    const createdEmployees: EmployeeSnapshot[] = []
    const employeeWarnings: string[] = []
    const canCreateEmployees = this.options.createEmployee !== undefined && request.createEmployees !== false
    await report('planning-employees', canCreateEmployees ? '正在判断是否需要专业员工。' : '已跳过专业员工规划。')
    if (canCreateEmployees) {
      try {
        const planText = await this.lightweightClient.complete({
          systemPrompt: buildEmployeePlanPrompt(catalogEntries, this.options.getLocale?.() ?? DEFAULT_APP_LOCALE),
          prompt: `用户需求：${request.prompt.slice(0, 8_000)}`,
          outputMode: 'json',
          ...(request.model === undefined ? {} : { model: request.model }),
        })
        const plan = extractJsonDocument(planText)
        const specs = isUnknownRecord(plan) && Array.isArray(plan.employees) ? plan.employees : []
        await report('creating-employees', specs.length === 0 ? '没有需要新建的专业员工。' : `已规划 ${specs.length} 名专业员工，正在创建。`)
        for (const spec of specs) {
          const input = employeeSpecToCreateInput(spec)
          if (input === undefined) {
            employeeWarnings.push('AI 规划的员工档案格式无效，已跳过。')
            continue
          }
          try {
            await report('creating-employees', `正在创建专业员工「${input.name}」。`)
            createdEmployees.push(await this.options.createEmployee!(input))
          } catch (error) {
            employeeWarnings.push(`员工「${input.name}」创建失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (specs.length > 0) await report('creating-employees', createdEmployees.length === specs.length ? `专业员工创建完成，共 ${createdEmployees.length} 名。` : `专业员工处理完成，成功创建 ${createdEmployees.length} 名。`)
      } catch (error) {
        employeeWarnings.push(`员工规划失败，仅使用现有员工：${error instanceof Error ? error.message : String(error)}`)
        await report('creating-employees', '专业员工规划失败，将继续使用现有员工生成工作流。')
      }
    } else {
      await report('creating-employees', '没有需要创建的专业员工。')
    }
    const finalCatalog = [...catalogEntries, ...createdEmployees.map(employeeCatalogEntry)]
    await report('generating-workflow', '正在根据需求、员工目录和固定 Schema 生成工作流草稿。')
    const text = await this.lightweightClient.complete({
      systemPrompt: buildWorkflowGenerationPrompt(finalCatalog, this.options.workflowAiDocumentation),
      prompt: `用户需求：${request.prompt.slice(0, 8_000)}`,
      outputMode: 'json',
      ...(request.model === undefined ? {} : { model: request.model }),
    })
    const raw = extractJsonDocument(text)
    const candidate = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>), id: `workflow-${randomUUID()}` } : raw
    const normalizedWorkflow = normalizeWorkflow(request.name?.trim() === '' || request.name === undefined
      ? candidate
      : { ...(candidate as Record<string, unknown>), name: request.name.trim() })
    if (normalizedWorkflow === undefined) throw new Error('AI 返回的 Workflow 文档格式无效')
    const repaired = repairGeneratedWorkflow(normalizedWorkflow, finalCatalog)
    await report('validating', '正在规范化节点、补齐布局并校验依赖关系。')
    const workflow = layoutWorkflowNodes(repaired.workflow)
    const validation = validateWorkflow(workflow)
    if (!validation.valid) throw new Error(`AI 返回的 Workflow 不符合结构规范：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`)
    return {
      workflow,
      createdEmployees,
      ...(employeeWarnings.length + repaired.warnings.length > 0 ? { employeeWarnings: [...employeeWarnings, ...repaired.warnings] } : {}),
    }
  }

  async modify(request: WorkflowModifyRequest, onProgress?: (update: WorkflowModificationProgressUpdate) => Promise<void> | void): Promise<WorkflowModifyResult> {
    if (request.prompt.trim() === '') throw new Error('AI 修改需求不能为空')
    const report = async (phase: WorkflowModificationProgressUpdate['phase'], message: string): Promise<void> => {
      await onProgress?.({ phase, message })
    }
    const current = cloneWorkflow(request.workflow)
    await report('preparing', '正在读取当前工作流和修改目标。')
    const validation = validateWorkflow(current)
    if (!validation.valid) throw new Error(`当前 Workflow 无法交给 AI 修改：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`)
    const catalog = (this.options.listEmployees?.() ?? []).map(employeeCatalogEntry)
    await report('analyzing', `正在分析 ${current.nodes.length} 个节点、变量和流程依赖。`)
    await report('generating', '正在根据修改要求生成最小变更方案。')
    const text = await this.lightweightClient.complete({
      systemPrompt: buildWorkflowModificationPrompt(this.options.workflowAiDocumentation),
      prompt: [
        `用户希望修改当前工作流：${request.prompt.slice(0, 8_000)}`,
        '当前工作流 JSON：',
        JSON.stringify(current),
        `可用专业员工目录（只能保留其中真实存在的 employeeId）：${JSON.stringify(catalog)}`,
      ].join('\n\n'),
      outputMode: 'json',
      ...(request.model === undefined ? {} : { model: request.model }),
    })
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

  private createRecord(workflow: WorkflowDefinition, input: WorkflowValue, options: WorkflowRunOptions): WorkflowRunRecord {
    const model = normalizeModelSelection(options.model)
    return {
      id: `run-${randomUUID()}`,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'queued',
      input: cloneWorkflow(input),
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending', elapsedMs: 0 })),
      events: [],
      allowShellFile: options.allowShellFile === true,
      allowCode: options.allowCode === true,
      debug: options.debug === true,
      ...(model === undefined ? {} : { model }),
    }
  }

  private async execute(runId: string): Promise<void> {
    const active: ActiveRun = { cancelled: false, abortController: new AbortController(), sessionIds: new Set(), archivedSessionIds: new Set(), sessionKeys: new Map() }
    this.active.set(runId, active)
    try {
      const record = this.options.runStore.get(runId)
      if (record === undefined) return
      const workflow = this.options.workflowStore.get(record.workflowId)
      if (workflow === undefined) throw new Error('关联的 Workflow 已不存在')
      assertValidWorkflow(workflow, '运行工作流')
      record.status = 'running'
      record.startedAt ??= new Date().toISOString()
      await this.save(record, 'run-started', '运行开始')

      const order = topologicalOrder(workflow)
      const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]))
      const stateMap = new Map(record.nodeStates.map((state) => [state.nodeId, state]))
      const outputs = new Map<string, WorkflowValue>()
      for (const state of record.nodeStates) if (state.output !== undefined) outputs.set(state.nodeId, state.output)

      const incomingByNode = new Map(workflow.nodes.map((node) => [node.id, workflow.edges.filter((edge) => edge.target === node.id)]))
      const dependencyIdsByNode = new Map(workflow.nodes.map((node) => [node.id, workflowNodeDependencyIds(workflow, node)]))
      const pending = new Set(order.filter((nodeId) => stateMap.get(nodeId)?.status === 'pending'))
      while (pending.size > 0 && !active.cancelled) {
        const ready = order.flatMap((nodeId) => {
          if (!pending.has(nodeId)) return []
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
          node, state, incoming, record, outputs, active,
        )))
        if (outcomes.some((outcome) => outcome === 'waiting-approval' || outcome === 'stopped')) return
      }

      if (active.cancelled) {
        record.status = active.pauseRequested ? 'paused' : 'cancelled'
        record.error = active.pauseRequested ? '应用正在切换工作区，运行已暂停。' : '用户取消了运行'
        record.completedAt = new Date().toISOString()
        await this.save(record, active.pauseRequested ? 'run-paused' : 'run-cancelled', record.error)
        return
      }
      const hasFailure = record.nodeStates.some((state) => state.status === 'failed')
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
      const record = this.options.runStore.get(runId)
      if (record === undefined) return
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      record.completedAt = new Date().toISOString()
      await this.save(record, 'run-failed', record.error)
    } finally {
      await this.archiveInternalSessions(runId, active).catch(() => undefined)
      this.active.delete(runId)
    }
  }

  private async executeReadyNode(
    node: WorkflowNode,
    state: WorkflowNodeRunState,
    incoming: WorkflowEdge[],
    record: WorkflowRunRecord,
    outputs: Map<string, WorkflowValue>,
    active: ActiveRun,
  ): Promise<'completed' | 'waiting-approval' | 'stopped'> {
    state.status = 'running'
    state.startedAt = new Date().toISOString()
    const executionStartedAt = Date.now()
    await this.save(record, 'node-started', `开始执行节点：${node.label}`, node.id)
    try {
      const previous = this.resolveNodeInput(node, incoming, outputs, record.input)
      state.input = cloneWorkflow(previous)
      const output = await this.executeNode(node, record.input, previous, record.allowShellFile, record.allowCode === true, active, record)
      state.status = 'completed'
      state.output = cloneWorkflow(output)
      state.completedAt = new Date().toISOString()
      state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
      outputs.set(node.id, output)
      await this.save(record, 'node-completed', `节点完成：${node.label}`, node.id)
      return 'completed'
    } catch (error) {
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
      state.status = active.pauseRequested ? 'pending' : active.cancelled ? 'cancelled' : 'failed'
      state.error = error instanceof Error ? error.message : String(error)
      state.completedAt = new Date().toISOString()
      state.elapsedMs = Math.max(0, Date.now() - executionStartedAt)
      record.status = active.pauseRequested ? 'paused' : active.cancelled ? 'cancelled' : 'failed'
      record.error = state.error
      record.completedAt = new Date().toISOString()
      await this.save(record, active.pauseRequested ? 'run-paused' : active.cancelled ? 'run-cancelled' : 'node-failed', state.error, node.id)
      return 'stopped'
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
        )
      }
      case 'employee': {
        const employee = this.options.resolveEmployee(node.config.employeeId)
        if (employee === undefined) throw new Error(`Employee "${node.config.employeeId}" was not found`)
        if (!employee.enabled) throw new Error(`Employee "${node.config.employeeId}" is disabled`)
        const sessionId = await this.getInternalSession(record, active, 'employee', node.id, node.config.employeeId)
        return this.adapter.executeEmployeeInSession(sessionId, node, employee, input, previous)
      }
      case 'skill': {
        const sessionId = await this.getInternalSession(record, active, 'skill', node.id)
        return this.adapter.executeSkillInSession(sessionId, node, input, previous)
      }
      case 'mcp': return this.mcpClient.call(node.config.tool, resolveMcpArguments(node.config.arguments ?? {}, input, previous))
      case 'parallel': return Promise.all(node.config.instructions.map((instruction) => this.executeLightweight(
        { id: node.id, label: node.label, type: node.type }, instruction, input, previous, undefined, 'text', active.abortController.signal, record.model,
      )))
      case 'loop': {
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
      case 'condition': return evaluateCondition(node.config.operator, this.primaryNodeValue(node, previous), node.config.value)
      case 'approval': throw new WorkflowApprovalRequired(node.config.message)
      case 'transform': return transform(node.config.template, node.config.text, this.primaryNodeValue(node, previous))
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
        return runShell(node.config.command, node.config.args.map((argument) => interpolateNodeTemplate(argument, previous)), resolveWorkspacePath(this.options.workspaceRoot, node.config.cwd ?? '.'), node.config.timeoutMs ?? 120_000)
      case 'file':
        if (!allowShellFile) throw new Error('Shell/File 节点需要运行时显式授权')
        return runFile(this.options.workspaceRoot, node.config.operation, node.config.path, node.config.content, previous)
      case 'http': return runHttp(node.config, input, previous, active.abortController.signal)
      case 'code':
        if (!allowCode) throw new Error('代码节点需要运行时显式授权')
        return runCode(node.config.language, node.config.code, input, previous, this.options.workspaceRoot, node.config.timeoutMs ?? 120_000, active.abortController.signal, this.options.nodeCommandPath)
    }
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
  ): Promise<WorkflowValue> {
    const request: WorkflowLightweightRequest = {
      prompt: buildNodePrompt(node, instruction, input, previous, systemPrompt, outputMode),
      outputMode,
      ...(model === undefined ? {} : { model }),
      signal,
    }
    const text = await this.lightweightClient.complete(request)
    if (outputMode === 'text') return text.trim()
    try {
      return parseWorkflowJson(text)
    } catch {
      const repair = await this.lightweightClient.complete({
        prompt: [
          '上一次输出不是有效的 JSON。请修复格式并只输出一个有效 JSON 文档，不要解释，不要使用 Markdown 代码围栏。',
          '需要修复的输出：',
          text,
        ].join('\n\n'),
        outputMode: 'json',
        ...(model === undefined ? {} : { model }),
        signal,
      })
      try {
        return parseWorkflowJson(repair)
      } catch {
        throw new Error(`节点“${node.label}”未返回有效 JSON`)
      }
    }
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

  private async save(record: WorkflowRunRecord, type: WorkflowRunEvent['type'], message: string, nodeId?: string): Promise<void> {
    if (isRetentionStatus(record.status) && record.completedAt !== undefined && record.retentionExpiresAt === undefined) {
      record.retentionExpiresAt = retentionExpiry(record)
    }
    record.events.push({ id: randomUUID(), time: new Date().toISOString(), type, nodeId, message })
    const saved = await this.options.runStore.save(record)
    for (const listener of this.listeners) listener(cloneWorkflow(saved))
  }
}

class WorkflowApprovalRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowApprovalRequired'
  }
}

function isTerminalNodeState(status: WorkflowNodeRunState['status'] | undefined): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed' || status === 'cancelled'
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

interface EmployeeCatalogEntry {
  id: string
  name: string
  role: string
  description: string
  businessBoundary: string
  capabilities: string[]
  skillIds: string[]
  enabled: boolean
}

function employeeCatalogEntry(employee: EmployeeSnapshot): EmployeeCatalogEntry {
  return {
    id: employee.id,
    name: employee.name,
    role: employee.role,
    description: employee.description,
    businessBoundary: employee.businessBoundary,
    capabilities: [...employee.capabilities],
    skillIds: [...employee.skillIds],
    enabled: employee.enabled,
  }
}

function buildEmployeePlanPrompt(catalog: EmployeeCatalogEntry[], locale: AppLocale): string {
  const languageInstruction = locale === 'zh'
    ? '所有自然语言字段必须使用简体中文，包括 name、role、description、businessBoundary、systemPrompt、operatingGuidelines 和 qualityStandards。'
    : 'All natural-language fields must be written in English, including name, role, description, businessBoundary, systemPrompt, operatingGuidelines, and qualityStandards.'
  return [
    '你是 EZDSH 的 Workflow 员工规划助手。根据用户对工作流的描述，判断需要哪些专业员工（AI Employee）参与，并输出需要新建的员工档案。',
    `已有员工目录（优先复用，不要重复创建职责相同的员工）：${JSON.stringify(catalog)}`,
    '只输出 JSON，不要 Markdown 代码围栏，不要解释。',
    'JSON 必须是一个对象：{"employees": [ { "name": "...", "role": "...", "description": "...", "businessBoundary": "...", "systemPrompt": "...", "operatingGuidelines": ["..."], "qualityStandards": ["..."], "capabilities": ["research"], "skillIds": [] } ]}',
    '只有确实需要新建的员工才放进 employees；如果已有目录中的员工能承担全部职责，输出 {"employees": []}。',
    'capabilities 只能使用 research、copywriting、image-generation、file-read、file-write、workflow；skillIds 必须是技能 ID 字符串数组。',
    '不要输出 id、version、schemaVersion、createdAt、updatedAt 或 builtIn；不要生成 API Key、密码、Token、任意代码或危险命令。',
    languageInstruction,
  ].join('\n')
}

function employeeSpecToCreateInput(value: unknown): EmployeeCreateInput | undefined {
  if (!isUnknownRecord(value)) return undefined
  const readString = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string).trim() : '')
  const readStringArray = (key: string): string[] => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string') : []
  const name = readString('name')
  const role = readString('role')
  const systemPrompt = readString('systemPrompt')
  if (name === '' || role === '' || systemPrompt === '') return undefined
  const description = readString('description')
  const capabilities = readStringArray('capabilities').filter((capability): capability is EmployeeCapability => (EMPLOYEE_CAPABILITIES as readonly string[]).includes(capability))
  return {
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
    const candidates = [employee.id, employee.name, employee.role].map(comparableEmployeeText)
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
    case 'parallel': {
      const instructions = node.config.instructions.filter((instruction) => instruction.trim() !== '')
      return { ...node, config: { instructions: instructions.length > 0 ? instructions : [generatedInstruction(node.label)] } }
    }
    case 'loop': return { ...node, config: { ...node.config, instruction: node.config.instruction.trim() || generatedInstruction(node.label), maxIterations: node.config.maxIterations ?? 20 } }
    case 'condition': return { ...node, config: { ...node.config, operator: GENERATION_CONDITION_OPERATORS.has(node.config.operator) ? node.config.operator : 'truthy' } }
    case 'approval': return { ...node, config: { message: node.config.message.trim() || `请确认是否继续执行「${node.label}」后的步骤。` } }
    case 'transform': return ['identity', 'json', 'extract-text', 'prepend', 'append'].includes(node.config.template) ? node : { ...node, config: { ...node.config, template: 'identity' } }
    case 'shell': {
      if (node.config.command.trim() !== '' && !/[[\]{}();|&<>`$\\]/u.test(node.config.command)) return node
      warnings.push(`节点「${node.label}」包含不完整或不安全的 Shell 配置，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'file': {
      if (node.config.operation === 'read' || node.config.operation === 'write') {
        if (node.config.path.trim() !== '' && !node.config.path.startsWith('/') && !/^[a-zA-Z]:[\\/]/u.test(node.config.path)) return node
      }
      warnings.push(`节点「${node.label}」包含无效文件配置，已安全改为智能处理节点。`)
      return { ...node, type: 'ai-task', config: { instruction: generatedInstruction(node.label), mode: 'single', skillIds: [], outputMode: 'text' } }
    }
    case 'http': {
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
    '工作流有多个启动参数时，优先让 input 节点使用 config.fields，例如 [{"name":"topic","label":"主题","type":"string","required":true},{"name":"audience","label":"受众","type":"string","required":false,"defaultValue":""}]。fields 中的每一项都会出现在运行前输入表单；input 节点的完整 result 仍然是启动输入对象，下游通过 sourcePath 选择字段。只有单值输入才使用 config.name。字段 type 只能是 string、number、boolean 或 json。',
    '输入绑定格式为 {"id":"唯一绑定ID","name":"本节点变量名","sourceNodeId":"来源节点ID","sourcePath":"可选点号字段路径","required":true}，可选 defaultValue。name 必须符合 ^[A-Za-z_][A-Za-z0-9_]*$ 且在本节点内唯一。sourcePath 省略表示来源节点完整 result；设置后只取该字段，例如 summary 或 profile.name。绑定本身也形成执行依赖，即使没有直接边。每个 {{变量}} 或 {{变量.字段}} 都必须有对应绑定；禁止使用未声明的全局历史上下文。',
    '一个节点可以绑定多个上游，一个上游也可以被多个下游绑定。多输入默认是 AND：下游等待所有依赖节点进入终态；没有“任意一个完成即可继续”的 any/or/race/first 语义。失败不是成功值。需要择一路径时使用 condition，不要省略绑定或伪造 OR 汇聚。普通 fan-out 用多个画布节点；parallel 只用于同一节点内并行执行多条相似指令并返回数组。',
    '输出变量用于声明 JSON 输出字段，例如 [{"name":"summary","description":"摘要"}]；每个节点的完整输出都隐含为 result，不要重复声明 result。需要字段级下游引用时使用 outputMode: json、声明 outputVariables，并在 instruction 中要求严格只输出 JSON。',
    '节点类型选择：ai-task 是当前工作流的一次轻量内联推理；employee 是可复用、有业务边界和质量标准的专业岗位；skill 是明确技能；mcp 是明确工具调用；transform 是确定性转换；condition 是二路 true/false 判断；approval 是人工确认；loop 是有上限的数组迭代；output 是固定的最终结果节点。output 也要声明 inputBindings：变量模式会转发一个或多个绑定值；文本模式使用 config.text 模板，并可在文本中使用已绑定的 {{变量}} 或 {{变量.字段}} 重组多个值。http/code/shell/file 只在用户明确要求时使用。禁止生成旧版 agent 或未实现的 switch、merge、race、retry、global-context 节点。',
    'employee 节点必须引用目录中真实存在且启用的 employeeId，并填写非空 instruction。员工是可复用的专业岗位定义，不是一次性任务或运行会话。不要把员工名称当 ID，也不要猜不存在的员工或技能。没有合适员工时用 ai-task；只有请求允许创建员工并且已经得到真实 employeeId 时才引用新员工。员工长期职责放在员工档案，当前一次性任务放在节点 instruction。',
    'condition.operator 只能是 truthy、equals、not-equals、contains、greater-than、less-than。每个 condition 最多两条下游路径，必须分别使用 sourcePort: "true" 和 sourcePort: "false"；三种以上情况用嵌套 condition。true/false 汇入共同下游是允许的：未选分支会 skipped，但不要把两个互斥分支结果都设为 required；必要时统一输出结构，或使用 required: false 与 defaultValue。',
    'ai-task.config 必须包含非空 instruction、mode（single 或 autonomous）、skillIds 数组和 outputMode（text 或 json）。employee.config 必须包含真实 employeeId、非空 instruction 和 outputMode。parallel.instructions 至少一条非空字符串；loop.instruction 非空且 maxIterations 在 1 到 100；transform.template 只能是 identity、json、extract-text、prepend、append。',
    '需要 HTTP API 时使用 http：method 只能 GET、POST、PUT、PATCH、DELETE，url 只能 http/https，headers 必须是对象，responseMode 只能 auto/json/text，可选 query、body、timeoutMs。代码使用 code：language 只能 nodejs/python3，code 非空；Node.js 使用 input/previous 并 return，Python3 使用 input/previous 并给 result 赋值。code、shell、file 运行前可能需要用户显式授权。',
    '只有用户明确提供 MCP 工具名时才生成 mcp，否则使用 ai-task 或 employee；不要生成空 tool。不要生成 API Key、密码、Token、任意危险命令、eval、反向 Shell、破坏性删除逻辑。file 路径必须是工作区相对路径。不能把会话 ID、运行 ID或运行结果写入工作流定义。',
    '生成流程必须先识别最终结果和启动输入，再拆分职责，设计每个节点的输入绑定与输出字段，之后画控制流和分支，最后校验所有 ID、字段、依赖和无环关系。',
    `可用专业员工目录（只能引用其中的 employeeId）：${JSON.stringify(catalog)}`,
    workflowDocumentationContext(workflowAiDocumentation),
  ].join('\n')
}

function buildWorkflowModificationPrompt(workflowAiDocumentation?: string): string {
  return [
    '你是 EzDSH Workflow 修改架构助手。你要在用户提供的现有 Workflow Schema v2 上做精确修改，而不是重新臆造一个无关流程。',
    '只输出一个 JSON 对象，必须是修改后的完整 WorkflowDefinition；不要输出 Markdown 代码围栏、解释、changes 字段或额外文本。',
    '除非用户明确要求，否则保留现有工作流的 id、开始节点、结束节点、已有节点职责和已有连线。用户要求拆分时，可以把一个职责拆成多个更细节点，但必须同步更新 edges、inputBindings 和 outputVariables，确保每个节点仍然可执行。',
    '删除节点是高风险修改：只有用户明确要求删除、替换或移除某项职责时才删除；否则保留节点并通过新增、拆分或修改配置实现目标。应用层会比较修改前后的节点并在删除发生时要求用户确认。',
    '把控制流和数据流分开：edges 表达执行顺序、分支和汇聚，inputBindings 表达变量来源。一个节点可以绑定多个来源，一个来源也可以提供给多个下游；多输入默认等待全部依赖完成。不要发明 switch、merge、any、race、global-context 等未实现节点或语义。',
    '所有员工节点必须引用现有员工目录中的真实 employeeId；不要凭空创建员工、技能、MCP 工具或模型。不要把运行结果、会话 ID、API Key、密码或 Token 写入工作流定义。',
    '修改后必须保留且只能保留一个 input 开始节点和一个 output 结束节点；图必须是无环图；每个节点都必须包含合法 type、label、config、position，并正确维护输入绑定和连线引用。',
    '先理解用户要解决的问题，再最小范围修改；如果需求存在多种实现，优先选择用户能在画布和变量面板中直接审阅的实现。',
    workflowDocumentationContext(workflowAiDocumentation),
  ].join('\n')
}

function workflowDocumentationContext(documentation?: string): string {
  const text = documentation?.trim()
  if (text === undefined || text === '') return '当前未能读取本地 Workflow 文档；以上运行时规则是最低约束，不能放宽。'
  return ['以下是随 EzDSH 提供的 Workflow 文档原文，必须把它作为 Schema、变量、执行语义和安全边界的权威约束：', '---', text.slice(0, 60_000), '---'].join('\n')
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

function transform(template: Extract<WorkflowNode, { type: 'transform' }>['config']['template'], text: string | undefined, value: WorkflowValue): WorkflowValue {
  switch (template) {
    case 'identity': return value
    case 'json': return JSON.stringify(value, null, 2)
    case 'extract-text': return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.text === 'string' ? value.text : String(value)
    case 'prepend': return `${text ?? ''}${String(value)}`
    case 'append': return `${String(value)}${text ?? ''}`
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
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) throw new Error('路径不能离开当前工作区')
  return resolved
}

async function runFile(root: string, operation: 'read' | 'write', path: string, content: string | undefined, previous: WorkflowValue): Promise<WorkflowValue> {
  const filePath = resolveWorkspacePath(root, path)
  if (operation === 'read') return await readFile(filePath, 'utf8')
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const rendered = interpolateNodeTemplate(content ?? '{{value}}', previous)
  await writeFile(filePath, rendered, { encoding: 'utf8', mode: 0o600 })
  return rendered
}

const WORKFLOW_HTTP_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

async function runHttp(config: HttpNodeConfig, input: WorkflowValue, previous: WorkflowValue, parentSignal: AbortSignal): Promise<WorkflowValue> {
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
  parentSignal.addEventListener('abort', onAbort, { once: true })
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
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnvironment } })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const onAbort = (): void => { child.kill(); reject(new Error('代码节点已取消。')) }
    parentSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; child.kill(); reject(new Error('代码节点超时。')) }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout, 'utf8') > WORKFLOW_HTTP_MAX_RESPONSE_BYTES) child.kill() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); parentSignal.removeEventListener('abort', onAbort); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      parentSignal.removeEventListener('abort', onAbort)
      if (timedOut || parentSignal.aborted) return
      if (code !== 0) { reject(new Error(`代码节点退出码 ${String(code)}：${stderr.trim() || stdout.trim()}`)); return }
      const text = stdout.trim()
      if (text === '') { resolvePromise(null); return }
      try {
        const value = JSON.parse(text) as unknown
        if (!isWorkflowValue(value)) throw new Error('代码输出不是 JSON-safe 值')
        resolvePromise(value)
      } catch { resolvePromise(text) }
    })
    child.stdin?.end(payload)
  })
}

function runShell(command: string, args: string[], cwd: string, timeoutMs: number): Promise<WorkflowValue> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Shell 节点超时'))
    }, Math.max(1_000, Math.min(timeoutMs, 10 * 60 * 1_000)))
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Shell 退出码 ${String(code)}：${stderr.trim() || stdout.trim()}`))
      else resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 })
    })
  })
}
