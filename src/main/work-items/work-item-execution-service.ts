import type { EmployeeRunRecord, EmployeeRunStartRequest, EmployeeRunStartReceipt } from '../../shared/employee-runs.js'
import { validateWorkTaskExecuteRequest, type WorkRunStatus, type WorkTaskExecuteRequest, type WorkTaskSnapshot } from '../../shared/work-items.js'
import type { WorkflowRunRecord, WorkflowValue } from '../../shared/workflow.js'
import { WorkItemService } from './work-item-service.js'
import type { WorkDispatchIntentReceipt } from './work-item-store.js'
import type { WorkflowTaskBridge, WorkflowTaskStartRequest } from './workflow-task-bridge.js'

export interface WorkItemEmployeeRunPort {
  start(request: EmployeeRunStartRequest): Promise<EmployeeRunStartReceipt>
  list(): Promise<EmployeeRunRecord[]>
}

export interface WorkItemWorkflowBridgePort extends Pick<WorkflowTaskBridge, 'start' | 'findByCommand'> {}

export interface WorkItemExecutionServiceOptions {
  workItems: WorkItemService
  employeeRuns: WorkItemEmployeeRunPort
  workflowBridge: WorkItemWorkflowBridgePort
  defaultCwd: string
}

export class WorkItemExecutionService {
  private readonly requestTails = new Map<string, Promise<void>>()

  constructor(private readonly options: WorkItemExecutionServiceOptions) {}

  async execute(input: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot> {
    const request = validateWorkTaskExecuteRequest(input)
    return this.serialize(request.requestId, () => this.executeOnce(request))
  }

  private async executeOnce(input: WorkTaskExecuteRequest): Promise<WorkTaskSnapshot> {
    const intent = await this.options.workItems.recordDispatchIntent(input)
    if (intent.replayed) {
      if (intent.stage === 'linked') return intent.snapshot
      if (intent.stage !== 'recorded') return this.reconcile(intent.requestId, intent.commandId, intent.snapshot)
    }

    return this.dispatch(input, intent)
  }

  private async dispatch(input: WorkTaskExecuteRequest, intent: WorkDispatchIntentReceipt): Promise<WorkTaskSnapshot> {
    const claimed = await this.options.workItems.claimDispatch(intent.requestId, intent.commandId)
    let execution: EmployeeRunRecord | WorkflowRunRecord
    try {
      execution = input.executor.kind === 'employee'
        ? (await this.options.employeeRuns.start(this.employeeRequest(input, claimed.snapshot, claimed.attemptId, claimed.commandId))).run
        : await this.options.workflowBridge.start(this.workflowRequest(input, claimed.snapshot, claimed.attemptId, claimed.commandId))
    } catch (error) {
      await this.options.workItems.markDispatchOutcomeUnknown(intent.requestId, intent.commandId, `outcome-unknown:${errorText(error)}`)
      throw error
    }
    return (await this.options.workItems.linkDispatch(intent.requestId, intent.commandId, projectExecution(execution))).snapshot
  }

  private async reconcile(requestId: string, commandId: string, snapshot: WorkTaskSnapshot): Promise<WorkTaskSnapshot> {
    const reference = snapshot.runs.find((run) => run.commandId === commandId)
    if (reference === undefined) throw new Error(`Dispatch ${requestId} has no durable run reference`)
    const execution = reference.executor.kind === 'employee'
      ? (await this.options.employeeRuns.list()).find((run) => run.commandId === commandId)
      : await this.options.workflowBridge.findByCommand(commandId)
    if (execution !== undefined) {
      return (await this.options.workItems.linkDispatch(requestId, commandId, projectExecution(execution))).snapshot
    }
    return (await this.options.workItems.markDispatchOutcomeUnknown(requestId, commandId, 'outcome-unknown:executor-run-not-found')).snapshot
  }

  private employeeRequest(input: WorkTaskExecuteRequest, snapshot: WorkTaskSnapshot, attemptId: string, commandId: string): EmployeeRunStartRequest {
    const requirement = snapshot.task.requirements.find((candidate) => candidate.version === snapshot.task.currentRequirementVersion)
    if (requirement === undefined) throw new Error(`Task ${snapshot.task.id} has no current requirement`)
    return {
      commandId,
      employeeId: input.executor.kind === 'employee' ? input.executor.employeeId : '',
      task: {
        description: describeRequirement(requirement.goal, requirement.acceptance, input.input),
        taskId: snapshot.task.id,
        attemptId,
        requirementVersion: requirement.version,
        ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      },
      context: {
        cwd: snapshot.task.scope.cwd ?? this.options.defaultCwd,
        ...(snapshot.task.scope.projectId === undefined ? {} : { projectId: snapshot.task.scope.projectId }),
      },
    }
  }

  private workflowRequest(input: WorkTaskExecuteRequest, snapshot: WorkTaskSnapshot, attemptId: string, commandId: string): WorkflowTaskStartRequest {
    if (input.executor.kind !== 'workflow') throw new Error('Workflow executor is required')
    return {
      commandId,
      taskId: snapshot.task.id,
      attemptId,
      requirementVersion: snapshot.task.currentRequirementVersion,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      workflowId: input.executor.workflowId,
      ...(input.executor.workflowRevision === undefined ? {} : { workflowRevision: input.executor.workflowRevision }),
      input: input.input as WorkflowValue,
    }
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

function projectExecution(execution: EmployeeRunRecord | WorkflowRunRecord): Pick<WorkTaskSnapshot['runs'][number], 'runId' | 'status' | 'rawStatus' | 'capabilities'> {
  if ('runId' in execution) {
    return {
      runId: execution.runId,
      status: execution.status as WorkRunStatus,
      rawStatus: execution.status,
      capabilities: { cancel: !['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.status), resume: false, append: false },
    }
  }
  return {
    runId: execution.id,
    status: execution.status === 'waiting-approval' ? 'waiting' : execution.status,
    rawStatus: execution.status,
    capabilities: {
      cancel: ['queued', 'running', 'waiting-approval'].includes(execution.status),
      resume: ['paused', 'failed'].includes(execution.status),
      append: false,
    },
  }
}

function describeRequirement(goal: string, acceptance: string, input: unknown): string {
  let serialized = ''
  try { serialized = input === null || input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input) }
  catch { serialized = String(input) }
  return [`目标：${goal}`, `验收：${acceptance}`, serialized === '' ? '' : `输入：${serialized}`].filter(Boolean).join('\n')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
