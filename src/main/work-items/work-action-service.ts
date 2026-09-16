import type { EmployeeRunRecord } from '../../shared/employee-runs.js'
import {
  validateWorkActionAnswerRequest,
  validateWorkRunControlRequest,
  type WorkAction,
  type WorkActionAnswerRequest,
  type WorkQuestionActionProtocol,
  type WorkRunControlRequest,
  type WorkRunStatus,
  type WorkTaskSnapshot,
  type WorkExecutor,
} from '../../shared/work-items.js'
import { isWorkflowValue, type WorkflowApprovalDecisionRequest, type WorkflowQuestionAnswerRequest, type WorkflowResumeRequest, type WorkflowRunEvent, type WorkflowRunRecord, type WorkflowValue } from '../../shared/workflow.js'
import { WorkItemService } from './work-item-service.js'

export interface WorkActionEmployeeRunPort {
  get?(runId: string): Promise<EmployeeRunRecord | undefined>
  cancel?(runId: string): Promise<EmployeeRunRecord>
}

export interface WorkActionWorkflowBridgePort {
  get?(runId: string): Promise<WorkflowRunRecord | undefined> | WorkflowRunRecord | undefined
  approveExpected?(runId: string, request: WorkflowApprovalDecisionRequest): Promise<WorkflowRunRecord>
  /** Optional until the Workflow executor implements question waiting/continuation. */
  answerExpected?(runId: string, request: WorkflowQuestionAnswerRequest): Promise<WorkflowRunRecord>
  resume?(runId: string): Promise<WorkflowRunRecord>
  resumeExpected?(runId: string, request: WorkflowResumeRequest): Promise<WorkflowRunRecord>
  cancel?(runId: string): Promise<WorkflowRunRecord>
}

export interface WorkActionServiceOptions {
  workItems: WorkItemService
  employeeRuns: WorkActionEmployeeRunPort
  workflowBridge: WorkActionWorkflowBridgePort
  artifacts?: WorkActionArtifactPort
}

/** Main-owned output sink. Completion creates a reviewable draft; it never accepts it. */
export interface WorkActionArtifactPort {
  saveText(input: {
    requestId: string
    taskId: string
    attemptId: string
    runId: string
    requirementVersion: number
    contentVersion: number
    name: string
    text: string
  }): Promise<unknown>
  saveJson(input: {
    requestId: string
    taskId: string
    attemptId: string
    runId: string
    requirementVersion: number
    contentVersion: number
    name: string
    value: unknown
  }): Promise<unknown>
}

export class WorkActionService {
  private readonly requestTails = new Map<string, Promise<void>>()

  constructor(private readonly options: WorkActionServiceOptions) {}

  /** Persist stable WorkAction occurrences from one authoritative top-level Workflow record. */
  async observeWorkflowRun(record: WorkflowRunRecord): Promise<WorkTaskSnapshot | undefined> {
    if (record.origin?.kind !== 'top-level' || record.workTask === undefined) return undefined
    const snapshot = await this.options.workItems.get(record.workTask.taskId)
    if (snapshot === undefined) return undefined
    const reference = snapshot.runs.find((run) => run.runId === record.id)
    if (reference === undefined || !isWorkflowBackedExecutor(reference.executor)
      || reference.commandId !== record.workTask.commandId
      || reference.attemptId !== record.workTask.attemptId
      || reference.requirementVersion !== record.workTask.requirementVersion) {
      return undefined
    }
    const requests = record.events
      .map((event, index) => ({ event, index }))
      .filter((item): item is { event: WorkflowRunEvent & { nodeId: string }; index: number } =>
        item.event.type === 'approval-requested' && item.event.nodeId !== undefined)
    const latestRequest = requests.at(-1)?.event
    const actions: WorkAction[] = requests.map(({ event, index }) => {
      const nextRequestIndex = requests.find((candidate) => candidate.index > index)?.index ?? record.events.length
      const resolved = record.events.slice(index + 1, nextRequestIndex).some((candidate) =>
        candidate.nodeId === event.nodeId
        && (candidate.type === 'approval-approved' || candidate.type === 'approval-rejected' || candidate.type === 'approval-resolved'))
      const open = !resolved
        && latestRequest?.id === event.id
        && record.status === 'waiting-approval'
        && record.waitingApprovalNodeId === event.nodeId
      return {
        id: workflowActionId(record.id, event.id),
        taskId: record.workTask!.taskId,
        runId: record.id,
        sourceEventId: event.id,
        requirementVersion: record.workTask!.requirementVersion,
        kind: 'approval',
        status: resolved ? 'resolved' : open ? 'open' : 'superseded',
        nodeId: event.nodeId,
      }
    })
    const questionRequests = record.events
      .map((event, index) => ({ event, index }))
      .filter((item): item is { event: WorkflowRunEvent & { nodeId: string }; index: number } =>
        item.event.type === 'question-requested' && item.event.nodeId !== undefined)
    const latestQuestionRequest = questionRequests.at(-1)?.event
    for (const { event, index } of questionRequests) {
      const nextRequestIndex = questionRequests.find((candidate) => candidate.index > index)?.index ?? record.events.length
      const resolved = record.events.slice(index + 1, nextRequestIndex).some((candidate) =>
        candidate.nodeId === event.nodeId && candidate.type === 'question-resolved')
      const waiting = record.waitingQuestion?.sourceEventId === event.id && record.waitingQuestion.nodeId === event.nodeId
        ? record.waitingQuestion
        : undefined
      const existing = snapshot.actions.find((candidate) => candidate.id === workflowActionId(record.id, event.id) && candidate.kind === 'question')
      const protocol = waiting === undefined ? existing?.question : {
        version: waiting.version,
        sourceRevision: waiting.sourceRevision,
        prompt: waiting.prompt,
        response: structuredClone(waiting.response),
      }
      const open = !resolved
        && latestQuestionRequest?.id === event.id
        && record.status === 'waiting-question'
        && record.waitingQuestionNodeId === event.nodeId
        && waiting !== undefined
      actions.push({
        id: workflowActionId(record.id, event.id), taskId: record.workTask.taskId, runId: record.id,
        sourceEventId: event.id, requirementVersion: record.workTask.requirementVersion,
        kind: 'question', status: resolved ? 'resolved' : open ? 'open' : 'superseded', nodeId: event.nodeId,
        ...(protocol === undefined ? {} : { question: protocol }),
      })
    }
    const statusProjection = await this.options.workItems.syncWorkflowRun(record.workTask.taskId, record.id, projectWorkflow(record))
    if (statusProjection === undefined) return undefined
    const projection = await this.options.workItems.syncWorkflowActions(record.workTask.taskId, record.id, actions)
    if (projection !== undefined && record.status === 'completed' && record.output !== undefined) {
      await this.saveWorkflowOutput(record, reference, record.output)
      return (await this.options.workItems.get(record.workTask.taskId)) ?? projection
    }
    return projection
  }

  /** Keep plain Employee backed runs current in the Work Items projection. */
  async observeEmployeeRun(record: EmployeeRunRecord): Promise<WorkTaskSnapshot | undefined> {
    if (record.taskId === undefined || record.attemptId === undefined || record.requirementVersion === undefined) return undefined
    const snapshot = await this.options.workItems.get(record.taskId)
    if (snapshot === undefined) return undefined
    const reference = snapshot.runs.find((run) => run.runId === record.runId)
    if (reference === undefined || reference.executor.kind !== 'employee'
      || reference.executor.employeeId !== record.employeeId || reference.commandId !== record.commandId
      || reference.attemptId !== record.attemptId || reference.requirementVersion !== record.requirementVersion) {
      return undefined
    }
    const projection = await this.options.workItems.syncEmployeeRun(record.taskId, record.runId, projectEmployee(record))
    if (projection !== undefined && record.status === 'completed') {
      const output = record.output.trim() || record.partialOutput.trim()
      if (output !== '') {
        await this.saveEmployeeOutput(record, reference, output)
        return (await this.options.workItems.get(record.taskId)) ?? projection
      }
    }
    return projection
  }

  private async saveEmployeeOutput(record: EmployeeRunRecord, reference: WorkTaskSnapshot['runs'][number], output: string): Promise<void> {
    if (this.options.artifacts === undefined || record.attemptId === undefined || record.requirementVersion === undefined) return
    await this.options.artifacts.saveText({
      requestId: `employee-output:${record.runId}:v1`,
      taskId: record.taskId!,
      attemptId: reference.attemptId,
      runId: record.runId,
      requirementVersion: reference.requirementVersion,
      contentVersion: 1,
      name: `employee-output-${record.runId}.md`,
      text: output,
    })
  }

  private async saveWorkflowOutput(record: WorkflowRunRecord, reference: WorkTaskSnapshot['runs'][number], output: unknown): Promise<void> {
    if (this.options.artifacts === undefined || record.workTask === undefined) return
    await this.options.artifacts.saveJson({
      requestId: `workflow-output:${record.id}:v1`,
      taskId: record.workTask.taskId,
      attemptId: reference.attemptId,
      runId: record.id,
      requirementVersion: reference.requirementVersion,
      contentVersion: 1,
      name: `workflow-output-${record.id}.json`,
      value: output,
    })
  }

  async answerAction(input: WorkActionAnswerRequest): Promise<WorkTaskSnapshot> {
    const request = validateWorkActionAnswerRequest(input)
    const snapshot = await this.options.workItems.get(request.taskId)
    const action = snapshot?.actions.find((candidate) => candidate.id === request.actionId)
    if (action?.kind === 'question') {
      const answer = validateQuestionAnswer(action.question, request.expectedActionVersion, request.answer)
      return this.serialize(request.requestId, () => this.answerQuestionActionOnce(request, answer))
    }
    if (typeof request.answer !== 'boolean') throw new Error('Workflow approval answer must be boolean')
    const normalized = { ...request, answer: request.answer }
    return this.serialize(request.requestId, () => this.answerApprovalActionOnce(normalized))
  }

  controlRun(input: WorkRunControlRequest): Promise<WorkTaskSnapshot> {
    const request = validateWorkRunControlRequest(input)
    return this.serialize(request.requestId, () => this.controlRunOnce(request))
  }

  private async answerApprovalActionOnce(request: WorkActionAnswerRequest & { answer: boolean }): Promise<WorkTaskSnapshot> {
    const intent = await this.options.workItems.beginActionAnswer(request)
    if (intent.stage === 'resolved') return intent.snapshot
    if (intent.stage === 'rejected') throw new Error(intent.rejectionReason ?? `Action answer request ${request.requestId} was rejected`)
    const action = intent.snapshot.actions.find((candidate) => candidate.id === intent.actionId)
    if (action === undefined || action.nodeId === undefined) throw new Error(`Action ${intent.actionId} has no Workflow approval target`)
    if (action.kind !== 'approval') throw new Error(`Action ${intent.actionId} is not a Workflow approval`)
    const reference = intent.snapshot.runs.find((candidate) => candidate.runId === action.runId)
    if (reference === undefined || !isWorkflowBackedExecutor(reference.executor)) throw new Error(`Workflow run ${action.runId} was not found for action ${action.id}`)
    let decided: WorkflowRunRecord
    try {
      const current = await this.options.workflowBridge.get?.(action.runId)
      assertWorkflowAssociation(current, reference, request.taskId)
      if (this.options.workflowBridge.approveExpected === undefined) throw new Error('Workflow targeted approval control is unavailable')
      decided = await this.options.workflowBridge.approveExpected(action.runId, {
        requestId: request.requestId,
        approved: request.answer,
        expectedApprovalEventId: request.expectedSourceEventId,
        expectedNodeId: action.nodeId,
        expectedTaskId: request.taskId,
        expectedRequirementVersion: request.expectedRequirementVersion,
      })
      assertWorkflowAssociation(decided, reference, request.taskId)
    } catch (error) {
      await this.options.workItems.rejectActionAnswer(request, errorText(error))
      throw error
    }
    return (await this.options.workItems.completeActionAnswer(request, projectWorkflow(decided))).snapshot
  }

  private async answerQuestionActionOnce(
    request: WorkActionAnswerRequest,
    answer: WorkflowValue,
  ): Promise<WorkTaskSnapshot> {
    const intent = await this.options.workItems.beginActionAnswer(request)
    if (intent.stage === 'resolved') return intent.snapshot
    if (intent.stage === 'rejected') throw new Error(intent.rejectionReason ?? `Action answer request ${request.requestId} was rejected`)
    const action = intent.snapshot.actions.find((candidate) => candidate.id === intent.actionId)
    if (action === undefined || action.kind !== 'question') throw new Error(`Action ${intent.actionId} is not a question`)
    let protocol: WorkQuestionActionProtocol
    try {
      protocol = validateQuestionProtocol(action.question, request.expectedActionVersion)
      validateQuestionAnswer(protocol, request.expectedActionVersion, answer)
    } catch (error) {
      await this.options.workItems.rejectActionAnswer(request, errorText(error))
      throw error
    }
    const reference = intent.snapshot.runs.find((candidate) => candidate.runId === action.runId)
    if (reference === undefined || !isWorkflowBackedExecutor(reference.executor)) throw new Error(`Workflow run ${action.runId} was not found for action ${action.id}`)
    const workflowRequest: WorkflowQuestionAnswerRequest = {
      requestId: request.requestId,
      answer,
      expectedQuestionEventId: request.expectedSourceEventId,
      expectedNodeId: action.nodeId ?? protocolNodeId(action),
      expectedTaskId: request.taskId,
      expectedRequirementVersion: request.expectedRequirementVersion,
      expectedActionVersion: protocol.version,
      sourceRevision: protocol.sourceRevision,
    }
    let decided: WorkflowRunRecord | undefined
    try {
      const current = await this.options.workflowBridge.get?.(action.runId)
      assertWorkflowAssociation(current, reference, request.taskId)
      if (this.options.workflowBridge.answerExpected === undefined) throw new Error('Workflow question control is unavailable')
      decided = await this.options.workflowBridge.answerExpected(action.runId, workflowRequest)
      assertWorkflowAssociation(decided, reference, request.taskId)
    } catch (error) {
      let current: WorkflowRunRecord | undefined
      try { current = await this.options.workflowBridge.get?.(action.runId) } catch { /* Preserve the original unknown result. */ }
      if (current !== undefined && hasWorkflowQuestionAnswerReceipt(current, workflowRequest)) {
        assertWorkflowAssociation(current, reference, request.taskId)
        decided = current
      } else {
        if (current !== undefined && !isCurrentWorkflowQuestionTarget(current, reference, workflowRequest)) {
          await this.options.workItems.rejectActionAnswer(request, errorText(error))
        }
        throw error
      }
    }
    if (decided === undefined) throw new Error('Workflow question result is unavailable')
    return (await this.options.workItems.completeActionAnswer(request, projectWorkflow(decided))).snapshot
  }

  private async controlRunOnce(request: WorkRunControlRequest): Promise<WorkTaskSnapshot> {
    const intent = await this.options.workItems.beginRunControl(request)
    if (intent.stage === 'processed') return intent.snapshot
    const reference = intent.snapshot.runs.find((candidate) => candidate.runId === request.runId)
    if (reference === undefined) throw new Error(`Run ${request.runId} was not found on task ${request.taskId}`)
    if (reference.executor.kind === 'employee' && reference.executor.methodId === undefined) {
      const current = await this.options.employeeRuns.get?.(request.runId)
      if (current === undefined) throw new Error(`Employee run ${request.runId} was not found`)
      assertEmployeeAssociation(current, reference, request.taskId)
      if (intent.replayed && current !== undefined && request.action === 'cancel' && current.status === 'cancelling') {
        return (await this.options.workItems.completeRunControl(request, projectEmployee(current))).snapshot
      }
      if (request.action === 'resume') throw new Error(`employee run ${request.runId} does not support resume`)
      if (this.options.employeeRuns.cancel === undefined) throw new Error('Employee cancel control is unavailable')
      const controlled = await this.options.employeeRuns.cancel(request.runId)
      assertEmployeeAssociation(controlled, reference, request.taskId)
      return (await this.options.workItems.completeRunControl(request, projectEmployee(controlled))).snapshot
    }

    const current = await this.options.workflowBridge.get?.(request.runId)
    assertWorkflowAssociation(current, reference, request.taskId)
    if (request.action === 'resume') {
      if (intent.replayed && hasWorkflowResumeReceipt(current, request)) {
        return (await this.options.workItems.completeRunControl(request, projectWorkflow(current))).snapshot
      }
      if (this.options.workflowBridge.resumeExpected === undefined) throw new Error('Workflow targeted resume control is unavailable')
      const controlled = await this.options.workflowBridge.resumeExpected(request.runId, {
        requestId: request.requestId,
        expectedTaskId: request.taskId,
        expectedRequirementVersion: reference.requirementVersion,
      })
      assertWorkflowAssociation(controlled, reference, request.taskId)
      if (controlled.id !== request.runId) throw new Error('Workflow resume returned a different run id')
      return (await this.options.workItems.completeRunControl(request, projectWorkflow(controlled))).snapshot
    }
    if (intent.replayed && current.status === 'cancelled') {
      return (await this.options.workItems.completeRunControl(request, projectWorkflow(current))).snapshot
    }
    if (this.options.workflowBridge.cancel === undefined) throw new Error('Workflow cancel control is unavailable')
    const controlled = await this.options.workflowBridge.cancel(request.runId)
    assertWorkflowAssociation(controlled, reference, request.taskId)
    if (controlled.id !== request.runId) throw new Error(`Workflow ${request.action} returned a different run id`)
    return (await this.options.workItems.completeRunControl(request, projectWorkflow(controlled))).snapshot
  }

  private async serialize<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.requestTails.get(requestId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.requestTails.set(requestId, tail)
    void tail.finally(() => { if (this.requestTails.get(requestId) === tail) this.requestTails.delete(requestId) })
    return result
  }
}

function isWorkflowBackedExecutor(executor: WorkExecutor): boolean {
  return executor.kind === 'workflow' || (executor.kind === 'employee' && executor.methodId !== undefined)
}

function protocolNodeId(action: WorkAction): never {
  throw new Error(`Question action ${action.id} has no Workflow node target`)
}

function hasWorkflowQuestionAnswerReceipt(record: WorkflowRunRecord, request: WorkflowQuestionAnswerRequest): boolean {
  return record.questionAnswerReceipts?.some((receipt) =>
    receipt.requestId === request.requestId
    && receipt.expectedQuestionEventId === request.expectedQuestionEventId
    && receipt.expectedNodeId === request.expectedNodeId
    && receipt.expectedTaskId === request.expectedTaskId
    && receipt.expectedRequirementVersion === request.expectedRequirementVersion
    && receipt.expectedActionVersion === request.expectedActionVersion
    && receipt.sourceRevision === request.sourceRevision
    && JSON.stringify(receipt.answer) === JSON.stringify(request.answer)) === true
}

function isCurrentWorkflowQuestionTarget(
  record: WorkflowRunRecord,
  reference: WorkTaskSnapshot['runs'][number],
  request: WorkflowQuestionAnswerRequest,
): boolean {
  const question = record.waitingQuestion
  const latest = [...record.events].reverse().find((event) => event.type === 'question-requested')
  return record.id === reference.runId
    && record.origin?.kind === 'top-level'
    && record.workTask?.taskId === request.expectedTaskId
    && record.workTask.commandId === reference.commandId
    && record.workTask.attemptId === reference.attemptId
    && record.workTask.requirementVersion === request.expectedRequirementVersion
    && record.status === 'waiting-question'
    && record.waitingQuestionNodeId === request.expectedNodeId
    && question?.nodeId === request.expectedNodeId
    && question.sourceEventId === request.expectedQuestionEventId
    && question.version === request.expectedActionVersion
    && question.sourceRevision === request.sourceRevision
    && latest?.id === request.expectedQuestionEventId
}

function validateQuestionProtocol(question: WorkQuestionActionProtocol | undefined, expectedVersion: number | undefined): WorkQuestionActionProtocol {
  if (question === undefined || question.version !== 1) throw new Error('Question action has no supported protocol')
  if (expectedVersion !== question.version) throw new Error('Question action version is stale')
  if (!Number.isSafeInteger(question.sourceRevision) || question.sourceRevision < 1 || typeof question.prompt !== 'string' || question.prompt.trim() === '') throw new Error('Question protocol is invalid')
  const response = question.response
  if (response.type === 'text') {
    if (response.maxLength !== undefined && (!Number.isSafeInteger(response.maxLength) || response.maxLength < 1)) throw new Error('Question text protocol is invalid')
  } else if (response.type === 'single-choice') {
    if (response.options.length === 0 || response.options.some((option) => option.value.trim() === '' || option.label.trim() === '') || new Set(response.options.map((option) => option.value)).size !== response.options.length) throw new Error('Question options are invalid')
  } else if (response.type === 'structured') {
    if (response.schema.fields.length === 0 || response.schema.fields.some((field) => field.key.trim() === '' || !['string', 'number', 'boolean', 'json'].includes(field.type)) || new Set(response.schema.fields.map((field) => field.key)).size !== response.schema.fields.length) throw new Error('Question schema is invalid')
  } else throw new Error('Question response type is unsupported')
  return question
}

function validateQuestionAnswer(question: WorkQuestionActionProtocol | undefined, expectedVersion: number | undefined, answer: unknown): WorkflowValue {
  const protocol = validateQuestionProtocol(question, expectedVersion)
  if (protocol.response.type === 'text') {
    if (typeof answer !== 'string' || answer.trim() === '') throw new Error('Question text answer must be non-empty')
    if (answer.length > (protocol.response.maxLength ?? 10_000)) throw new Error('Question text answer exceeds its maximum length')
    return answer
  }
  if (protocol.response.type === 'single-choice') {
    if (typeof answer !== 'string' || !protocol.response.options.some((option) => option.value === answer)) throw new Error('Question answer is not an allowed option')
    return answer
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer) || !isWorkflowValue(answer)) throw new Error('Question structured answer must be JSON-safe object')
  const value = answer as Record<string, unknown>
  const fields = protocol.response.schema.fields
  if (Object.keys(value).some((key) => !fields.some((field) => field.key === key))) throw new Error('Question structured answer has an unknown field')
  for (const field of fields) {
    const candidate = value[field.key]
    if (candidate === undefined) { if (field.required) throw new Error(`Question structured answer is missing ${field.key}`); continue }
    if (field.type === 'string' && (typeof candidate !== 'string' || field.required === true && candidate.trim() === '')) throw new Error(`Question structured answer ${field.key} must be non-empty string`)
    if (field.type === 'number' && (typeof candidate !== 'number' || !Number.isFinite(candidate))) throw new Error(`Question structured answer ${field.key} must be number`)
    if (field.type === 'boolean' && typeof candidate !== 'boolean') throw new Error(`Question structured answer ${field.key} must be boolean`)
  }
  return value as WorkflowValue
}

function hasWorkflowResumeReceipt(record: WorkflowRunRecord, request: WorkRunControlRequest): boolean {
  return record.workTaskControlReceipts?.some((receipt) =>
    receipt.action === 'resume'
    && receipt.requestId === request.requestId
    && receipt.expectedTaskId === request.taskId
    && receipt.expectedRequirementVersion === record.workTask?.requirementVersion) === true
}

function workflowActionId(runId: string, sourceEventId: string): string {
  return `workflow:${runId}:event:${sourceEventId}`
}

function assertWorkflowAssociation(
  record: WorkflowRunRecord | undefined,
  reference: WorkTaskSnapshot['runs'][number],
  taskId: string,
): asserts record is WorkflowRunRecord {
  if (record === undefined || record.id !== reference.runId || record.origin?.kind !== 'top-level'
    || record.workTask?.taskId !== taskId
    || record.workTask.commandId !== reference.commandId
    || record.workTask.attemptId !== reference.attemptId
    || record.workTask.requirementVersion !== reference.requirementVersion) {
    throw new Error(`Workflow run ${reference.runId} does not match task ${taskId}`)
  }
}

function assertEmployeeAssociation(record: EmployeeRunRecord, reference: WorkTaskSnapshot['runs'][number], taskId: string): void {
  if (record.runId !== reference.runId || record.taskId !== taskId || record.commandId !== reference.commandId
    || record.attemptId !== reference.attemptId || record.requirementVersion !== reference.requirementVersion) {
    throw new Error(`Employee run ${reference.runId} does not match task ${taskId}`)
  }
}

function projectEmployee(record: EmployeeRunRecord): Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'> {
  const detail = record.cancelRequestState === undefined
    ? ''
    : `:cancel-${record.cancelRequestState}${record.cancelRequestError === undefined ? '' : `:${record.cancelRequestError}`}`
  return {
    status: record.status as WorkRunStatus,
    rawStatus: `${record.status}${detail}`,
    capabilities: {
      cancel: !['completed', 'failed', 'cancelled', 'interrupted', 'cancelling'].includes(record.status),
      resume: false,
      append: false,
    },
  }
}

function projectWorkflow(record: WorkflowRunRecord): Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'> {
  return {
    status: record.status === 'waiting-approval' || record.status === 'waiting-question' ? 'waiting' : record.status,
    rawStatus: record.status,
    capabilities: {
      cancel: ['queued', 'running', 'waiting-approval', 'waiting-question'].includes(record.status),
      resume: ['paused', 'failed'].includes(record.status),
      append: false,
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
