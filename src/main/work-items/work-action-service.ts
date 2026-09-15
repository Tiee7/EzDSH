import type { EmployeeRunRecord } from '../../shared/employee-runs.js'
import {
  validateWorkActionAnswerRequest,
  validateWorkRunControlRequest,
  type WorkAction,
  type WorkActionAnswerRequest,
  type WorkRunControlRequest,
  type WorkRunStatus,
  type WorkTaskSnapshot,
  type WorkExecutor,
} from '../../shared/work-items.js'
import type { WorkflowApprovalDecisionRequest, WorkflowResumeRequest, WorkflowRunEvent, WorkflowRunRecord } from '../../shared/workflow.js'
import { WorkItemService } from './work-item-service.js'

export interface WorkActionEmployeeRunPort {
  get?(runId: string): Promise<EmployeeRunRecord | undefined>
  cancel?(runId: string): Promise<EmployeeRunRecord>
}

export interface WorkActionWorkflowBridgePort {
  get?(runId: string): Promise<WorkflowRunRecord | undefined> | WorkflowRunRecord | undefined
  approveExpected?(runId: string, request: WorkflowApprovalDecisionRequest): Promise<WorkflowRunRecord>
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

  answerAction(input: WorkActionAnswerRequest): Promise<WorkTaskSnapshot> {
    const request = validateWorkActionAnswerRequest(input)
    if (typeof request.answer !== 'boolean') throw new Error('Workflow approval answer must be boolean')
    const normalized = { ...request, answer: request.answer }
    return this.serialize(request.requestId, () => this.answerActionOnce(normalized))
  }

  controlRun(input: WorkRunControlRequest): Promise<WorkTaskSnapshot> {
    const request = validateWorkRunControlRequest(input)
    return this.serialize(request.requestId, () => this.controlRunOnce(request))
  }

  private async answerActionOnce(request: WorkActionAnswerRequest & { answer: boolean }): Promise<WorkTaskSnapshot> {
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
    status: record.status === 'waiting-approval' ? 'waiting' : record.status,
    rawStatus: record.status,
    capabilities: {
      cancel: ['queued', 'running', 'waiting-approval'].includes(record.status),
      resume: ['paused', 'failed'].includes(record.status),
      append: false,
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
