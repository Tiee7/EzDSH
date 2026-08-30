import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowGenerateRequest,
  WorkflowNode,
  WorkflowNodeRunState,
  WorkflowRunEvent,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowValue,
  WorkflowModelSelection,
  ConditionOperator,
} from '../../shared/workflow.js'
import type { EmployeeSnapshot } from '../../shared/employees.js'
import { cloneWorkflow, isWorkflowValue, normalizeWorkflow, validateWorkflow } from '../../shared/workflow.js'
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
  createClient: () => WorkflowSessionClient
  resolveEmployee: (id: string) => EmployeeSnapshot | undefined
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
    assertValidWorkflow(workflow)
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
    state.status = 'completed'
    state.output = this.previousValue(node.id, incoming, outputs, record.input)
    state.completedAt = new Date().toISOString()
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

  async generate(request: WorkflowGenerateRequest): Promise<WorkflowDefinition> {
    if (request.prompt.trim() === '') throw new Error('AI 生成需求不能为空')
    const text = await this.lightweightClient.complete({
      systemPrompt: [
        '你是 Workflow 架构助手。根据用户描述生成一个可审阅的 JSON 工作流文档。',
        '只输出 JSON，不要 Markdown 代码围栏，不要解释。',
        '文档必须包含 name、description、nodes、edges；节点 type 只能是 input、ai-task、employee、skill、mcp、parallel、loop、condition、approval、transform、output、shell、file。',
        'ai-task 用于轻量内联智能处理；employee 必须引用已有 employeeId。禁止输出旧版 agent 节点。',
        '不要生成 API Key、密码、Token、任意 JavaScript、eval 或 shell 控制符。文件路径必须是工作区相对路径。',
      ].join('\n'),
      prompt: `用户需求：${request.prompt.slice(0, 8_000)}`,
      outputMode: 'json',
    })
    const raw = extractJsonDocument(text)
    const candidate = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>), id: `workflow-${randomUUID()}` } : raw
    const workflow = normalizeWorkflow(request.name?.trim() === '' || request.name === undefined
      ? candidate
      : { ...(candidate as Record<string, unknown>), name: request.name.trim() })
    if (workflow === undefined) throw new Error('AI 返回的 Workflow 文档格式无效')
    const validation = validateWorkflow(workflow)
    if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('\n'))
    return workflow
  }

  private createRecord(workflow: WorkflowDefinition, input: WorkflowValue, options: WorkflowRunOptions): WorkflowRunRecord {
    const model = normalizeModelSelection(options.model)
    return {
      id: `run-${randomUUID()}`,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'queued',
      input: cloneWorkflow(input),
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' })),
      events: [],
      allowShellFile: options.allowShellFile === true,
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
      assertValidWorkflow(workflow)
      record.status = 'running'
      record.startedAt ??= new Date().toISOString()
      await this.save(record, 'run-started', '运行开始')

      const order = topologicalOrder(workflow)
      const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]))
      const stateMap = new Map(record.nodeStates.map((state) => [state.nodeId, state]))
      const outputs = new Map<string, WorkflowValue>()
      for (const state of record.nodeStates) if (state.output !== undefined) outputs.set(state.nodeId, state.output)

      for (const nodeId of order) {
        const node = nodeMap.get(nodeId)
        const state = stateMap.get(nodeId)
        if (node === undefined || state === undefined) continue
        if (state.status === 'completed') continue
        if (active.cancelled) {
          state.status = active.pauseRequested ? 'pending' : 'cancelled'
          state.completedAt = new Date().toISOString()
          record.status = active.pauseRequested ? 'paused' : 'cancelled'
          record.error = active.pauseRequested ? '应用正在切换工作区，运行已暂停。' : '用户取消了运行'
          record.completedAt = new Date().toISOString()
          await this.save(record, active.pauseRequested ? 'run-paused' : 'run-cancelled', record.error, node.id)
          break
        }
        const incoming = workflow.edges.filter((edge) => edge.target === node.id)
        if (incoming.length > 0 && !incoming.some((edge) => this.isEdgeActive(edge, nodeMap, stateMap, outputs))) {
          state.status = 'skipped'
          state.completedAt = new Date().toISOString()
          await this.save(record, 'node-skipped', '条件分支未命中', node.id)
          continue
        }
        state.status = 'running'
        state.startedAt = new Date().toISOString()
        await this.save(record, 'node-started', `开始执行节点：${node.label}`, node.id)
        try {
          const previous = this.previousValue(node.id, incoming, outputs, record.input)
          const output = await this.executeNode(node, record.input, previous, record.allowShellFile, active, record)
          state.status = 'completed'
          state.output = cloneWorkflow(output)
          state.completedAt = new Date().toISOString()
          outputs.set(node.id, output)
          await this.save(record, 'node-completed', `节点完成：${node.label}`, node.id)
        } catch (error) {
          if (error instanceof WorkflowApprovalRequired) {
            state.status = 'pending'
            state.startedAt = undefined
            state.completedAt = undefined
            record.status = 'waiting-approval'
            record.waitingApprovalNodeId = node.id
            record.error = error.message
            await this.save(record, 'approval-requested', error.message, node.id)
            return
          }
          state.status = active.pauseRequested ? 'pending' : active.cancelled ? 'cancelled' : 'failed'
          state.error = error instanceof Error ? error.message : String(error)
          state.completedAt = new Date().toISOString()
          record.status = active.pauseRequested ? 'paused' : active.cancelled ? 'cancelled' : 'failed'
          record.error = state.error
          record.completedAt = new Date().toISOString()
          await this.save(record, active.pauseRequested ? 'run-paused' : active.cancelled ? 'run-cancelled' : 'node-failed', state.error, node.id)
          return
        }
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

  private async executeNode(
    node: WorkflowNode,
    input: WorkflowValue,
    previous: WorkflowValue,
    allowShellFile: boolean,
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
        const items = Array.isArray(previous) ? previous : [previous]
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
      case 'condition': return evaluateCondition(node.config.operator, previous, node.config.value)
      case 'approval': throw new WorkflowApprovalRequired(node.config.message)
      case 'transform': return transform(node.config.template, node.config.text, previous)
      case 'output': return previous
      case 'shell':
        if (!allowShellFile) throw new Error('Shell/File 节点需要运行时显式授权')
        return runShell(node.config.command, node.config.args, resolveWorkspacePath(this.options.workspaceRoot, node.config.cwd ?? '.'), node.config.timeoutMs ?? 120_000)
      case 'file':
        if (!allowShellFile) throw new Error('Shell/File 节点需要运行时显式授权')
        return runFile(this.options.workspaceRoot, node.config.operation, node.config.path, node.config.content, previous)
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
    const sessionId = await this.adapter.createInternalSession()
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

  private isEdgeActive(edge: WorkflowEdge, nodeMap: Map<string, WorkflowNode>, stateMap: Map<string, WorkflowNodeRunState>, outputs: Map<string, WorkflowValue>): boolean {
    const sourceState = stateMap.get(edge.source)
    if (sourceState?.status !== 'completed') return false
    const source = nodeMap.get(edge.source)
    if (source?.type !== 'condition' || edge.sourcePort === undefined || edge.sourcePort === 'default') return true
    return (outputs.get(edge.source) === true) === (edge.sourcePort === 'true')
  }

  private previousValue(nodeId: string, incoming: WorkflowEdge[], outputs: Map<string, WorkflowValue>, input: WorkflowValue): WorkflowValue {
    const values = incoming.map((edge) => outputs.get(edge.source)).filter((value): value is WorkflowValue => value !== undefined)
    if (values.length === 0) return input
    if (values.length === 1) return values[0] as WorkflowValue
    return values
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

function isRecord(value: WorkflowValue): value is { [key: string]: WorkflowValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    case 'equals': return JSON.stringify(left) === JSON.stringify(right)
    case 'not-equals': return JSON.stringify(left) !== JSON.stringify(right)
    case 'contains': return typeof left === 'string' && typeof right === 'string' ? left.includes(right) : Array.isArray(left) && left.some((item) => JSON.stringify(item) === JSON.stringify(right))
    case 'greater-than': return typeof left === 'number' && typeof right === 'number' && left > right
    case 'less-than': return typeof left === 'number' && typeof right === 'number' && left < right
  }
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
    return value
      .replaceAll('{{input}}', renderTemplateValue(input))
      .replaceAll('{{value}}', renderTemplateValue(previous))
  }
  if (Array.isArray(value)) return value.map((item) => resolveMcpArgument(item, input, previous))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveMcpArgument(item, input, previous)]))
  }
  return value
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
  const rendered = (content ?? '{{value}}').replaceAll('{{value}}', String(previous)).replaceAll('{{input}}', String(previous))
  await writeFile(filePath, rendered, { encoding: 'utf8', mode: 0o600 })
  return rendered
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
