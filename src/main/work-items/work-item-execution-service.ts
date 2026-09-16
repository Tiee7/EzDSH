import type { EmployeeRunRecord, EmployeeRunStartRequest, EmployeeRunStartReceipt } from '../../shared/employee-runs.js'
import { validateWorkTaskExecuteRequest, type WorkRunStatus, type WorkTaskExecuteRequest, type WorkTaskSnapshot } from '../../shared/work-items.js'
import { isWorkflowValue, type WorkflowRunRecord, type WorkflowValue } from '../../shared/workflow.js'
import type { EmployeeWorkMethod } from '../../shared/employee-methods.js'
import { WorkItemService } from './work-item-service.js'
import type { WorkDispatchIntentReceipt } from './work-item-store.js'
import type { WorkflowTaskBridge, WorkflowTaskStartRequest } from './workflow-task-bridge.js'

export interface WorkItemEmployeeRunPort {
  start(request: EmployeeRunStartRequest): Promise<EmployeeRunStartReceipt>
  list(): Promise<EmployeeRunRecord[]>
}

export interface WorkItemEmployeeMethodPort {
  snapshot(employeeId: string, methodId: string): Promise<EmployeeWorkMethod>
}

export interface WorkItemWorkflowBridgePort extends Pick<WorkflowTaskBridge, 'start' | 'findByCommand'> {}

export interface WorkItemExecutionServiceOptions {
  workItems: WorkItemService
  employeeRuns: WorkItemEmployeeRunPort
  employeeMethods?: WorkItemEmployeeMethodPort
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
    // A task cancellation can win after the dispatch intent is recorded but
    // before this request claims it. In that case Main has durably cancelled
    // the unstarted command and no executor call is allowed.
    if (claimed.stage === 'cancelled') return claimed.snapshot
    if (claimed.stage !== 'dispatching') return this.reconcile(claimed.requestId, claimed.commandId, claimed.snapshot)
    let execution: EmployeeRunRecord | WorkflowRunRecord
    try {
      if (input.executor.kind === 'employee' && input.executor.methodId !== undefined) {
        const method = await this.resolveMethod(input.executor.employeeId, input.executor.methodId, input.executor.methodVersion)
        execution = await this.options.workflowBridge.start(this.methodWorkflowRequest(input, method, claimed.snapshot, claimed.attemptId, claimed.commandId))
      } else if (input.executor.kind === 'employee') {
        execution = (await this.options.employeeRuns.start(await this.employeeRequest(input, claimed.snapshot, claimed.attemptId, claimed.commandId))).run
      } else {
        execution = await this.options.workflowBridge.start(this.workflowRequest(input, claimed.snapshot, claimed.attemptId, claimed.commandId))
      }
    } catch (error) {
      await this.options.workItems.markDispatchOutcomeUnknown(intent.requestId, intent.commandId, `outcome-unknown:${errorText(error)}`)
      throw error
    }
    return (await this.options.workItems.linkDispatch(intent.requestId, intent.commandId, projectExecution(execution))).snapshot
  }

  private async reconcile(requestId: string, commandId: string, snapshot: WorkTaskSnapshot): Promise<WorkTaskSnapshot> {
    const reference = snapshot.runs.find((run) => run.commandId === commandId)
    if (reference === undefined) throw new Error(`Dispatch ${requestId} has no durable run reference`)
    const execution = reference.executor.kind === 'employee' && reference.executor.methodId === undefined
      ? (await this.options.employeeRuns.list()).find((run) => run.commandId === commandId)
      : await this.options.workflowBridge.findByCommand(commandId)
    if (execution !== undefined) {
      return (await this.options.workItems.linkDispatch(requestId, commandId, projectExecution(execution))).snapshot
    }
    return (await this.options.workItems.markDispatchOutcomeUnknown(requestId, commandId, 'outcome-unknown:executor-run-not-found')).snapshot
  }

  private async employeeRequest(input: WorkTaskExecuteRequest, snapshot: WorkTaskSnapshot, attemptId: string, commandId: string): Promise<EmployeeRunStartRequest> {
    const requirement = snapshot.task.requirements.find((candidate) => candidate.version === snapshot.task.currentRequirementVersion)
    if (requirement === undefined) throw new Error(`Task ${snapshot.task.id} has no current requirement`)
    const launch = employeeLaunchInput(input.input)
    if (launch.projectId !== undefined && launch.projectId !== snapshot.task.scope.projectId) {
      throw new Error('Employee execution project does not match the work item scope')
    }
    const employeeId = input.executor.kind === 'employee' ? input.executor.employeeId : ''
    return {
      commandId,
      employeeId,
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
        ...(launch.sessionId === undefined ? {} : { sessionId: launch.sessionId, sessionVerification: 'trusted-main' as const }),
      },
    }
  }

  private async resolveMethod(employeeId: string, methodId: string, expectedVersion?: number): Promise<EmployeeWorkMethod> {
    const method = await this.options.employeeMethods?.snapshot(employeeId, methodId)
    if (method === undefined) throw new Error('Employee method service is not available')
    // A method-backed run is immutable: the renderer must send the version it selected.
    if (expectedVersion === undefined || method.version !== expectedVersion) throw new Error(`Employee method ${methodId} version is stale`)
    return method
  }

  private methodWorkflowRequest(input: WorkTaskExecuteRequest, method: EmployeeWorkMethod, snapshot: WorkTaskSnapshot, attemptId: string, commandId: string): WorkflowTaskStartRequest {
    if (!isWorkflowValue(input.input)) throw new Error('Employee method workflow input must be a finite JSON-safe value')
    return {
      commandId,
      taskId: snapshot.task.id,
      attemptId,
      requirementVersion: snapshot.task.currentRequirementVersion,
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      workflowId: method.workflowId,
      workflowRevision: method.workflowRevision,
      input: input.input as WorkflowValue,
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
    status: execution.status === 'waiting-approval' || execution.status === 'waiting-question' ? 'waiting' : execution.status,
    rawStatus: execution.status,
    capabilities: {
      cancel: ['queued', 'running', 'waiting-approval', 'waiting-question'].includes(execution.status),
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

interface EmployeeLaunchInput {
  task?: string
  projectId?: string
  sessionId?: string
  methodId?: string
}

function employeeLaunchInput(value: unknown): EmployeeLaunchInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const candidate = record[key]
    if (typeof candidate !== 'string') return undefined
    const normalized = candidate.trim()
    return normalized === '' ? undefined : normalized
  }
  return {
    task: text('task'),
    projectId: text('projectId'),
    sessionId: text('sessionId'),
    methodId: text('methodId'),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
