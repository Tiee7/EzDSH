import type { EmployeeRunRecord } from '../../shared/employee-runs.js'
import {
  validateWorkTaskCancelRequest,
  type WorkTaskCancelRequest,
  type WorkTaskCancellationTarget,
  type WorkTaskSnapshot,
} from '../../shared/work-items.js'
import type { WorkflowRunRecord } from '../../shared/workflow.js'
import type {
  WorkTaskCancellationReceipt,
  WorkTaskCancellationTargetUpdate,
} from './work-item-store.js'

export interface WorkItemCancellationStorePort {
  get(taskId: string): Promise<WorkTaskSnapshot | undefined>
  list(query?: { includeArchived?: boolean }): Promise<WorkTaskSnapshot[]>
  beginTaskCancellation(request: WorkTaskCancelRequest): Promise<WorkTaskCancellationReceipt>
  updateTaskCancellationTarget(
    requestId: string,
    commandId: string,
    update: WorkTaskCancellationTargetUpdate,
  ): Promise<WorkTaskCancellationReceipt>
}

export interface WorkItemCancellationEmployeePort {
  get(runId: string): Promise<EmployeeRunRecord | undefined>
  findByCommand(commandId: string): Promise<EmployeeRunRecord | undefined>
  cancel(runId: string): Promise<EmployeeRunRecord>
}

export interface WorkItemCancellationWorkflowPort {
  get(runId: string): Promise<WorkflowRunRecord | undefined> | WorkflowRunRecord | undefined
  findByCommand(commandId: string): Promise<WorkflowRunRecord | undefined> | WorkflowRunRecord | undefined
  cancel(runId: string): Promise<WorkflowRunRecord>
}

export interface WorkItemCancellationServiceOptions {
  workItems: WorkItemCancellationStorePort
  employeeRuns: WorkItemCancellationEmployeePort
  workflowRuns: WorkItemCancellationWorkflowPort
}

type TargetDecision = WorkTaskCancellationTargetUpdate & { shouldRequestCancel?: boolean }

/**
 * Main-owned task cancellation coordinator. The WorkItem intent and frozen
 * command targets are durable before this service contacts either executor.
 */
export class WorkItemCancellationService {
  private readonly taskTails = new Map<string, Promise<void>>()

  constructor(private readonly options: WorkItemCancellationServiceOptions) {}

  cancelTask(input: WorkTaskCancelRequest): Promise<WorkTaskSnapshot> {
    const request = validateWorkTaskCancelRequest(input)
    return this.serialize(request.taskId, async () => {
      const receipt = await this.options.workItems.beginTaskCancellation(request)
      return (await this.reconcileReceipt(receipt)).snapshot
    })
  }

  async reconcileTask(taskId: string): Promise<WorkTaskSnapshot | undefined> {
    return this.serialize(taskId, async () => {
      const snapshot = await this.options.workItems.get(taskId)
      const cancellation = snapshot?.task.cancellation
      if (snapshot === undefined || cancellation === undefined || cancellation.state === 'cancelled') return snapshot
      const receipt = await this.options.workItems.beginTaskCancellation({
        requestId: cancellation.requestId,
        taskId,
        expectedRevision: cancellation.expectedRevision,
      })
      return (await this.reconcileReceipt(receipt)).snapshot
    })
  }

  async reconcilePending(): Promise<WorkTaskSnapshot[]> {
    const tasks = await this.options.workItems.list({ includeArchived: true })
    const reconciled: WorkTaskSnapshot[] = []
    for (const snapshot of tasks) {
      if (snapshot.task.cancellation === undefined || snapshot.task.cancellation.state === 'cancelled') continue
      const next = await this.reconcileTask(snapshot.task.id)
      if (next !== undefined) reconciled.push(next)
    }
    return reconciled
  }

  private async reconcileReceipt(initial: WorkTaskCancellationReceipt): Promise<WorkTaskCancellationReceipt> {
    let receipt = initial
    const cancellation = receipt.snapshot.task.cancellation
    if (cancellation === undefined || cancellation.state === 'cancelled') return receipt
    for (const frozen of cancellation.targets) {
      const currentTarget = receipt.snapshot.task.cancellation?.targets.find((target) => target.commandId === frozen.commandId)
      if (currentTarget === undefined || currentTarget.state === 'cancelled' || currentTarget.state === 'settled') continue
      const update = await this.reconcileTarget(receipt.snapshot, currentTarget)
      receipt = await this.options.workItems.updateTaskCancellationTarget(
        cancellation.requestId,
        currentTarget.commandId,
        update,
      )
    }
    return receipt
  }

  private async reconcileTarget(snapshot: WorkTaskSnapshot, target: WorkTaskCancellationTarget): Promise<WorkTaskCancellationTargetUpdate> {
    try {
      if (target.executor.kind === 'employee' && target.executor.methodId === undefined) {
        return await this.reconcileEmployee(snapshot, target)
      }
      return await this.reconcileWorkflow(snapshot, target)
    } catch (error) {
      return unknownTarget(error)
    }
  }

  private async reconcileEmployee(snapshot: WorkTaskSnapshot, target: WorkTaskCancellationTarget): Promise<WorkTaskCancellationTargetUpdate> {
    let record = target.runId === ''
      ? await this.options.employeeRuns.findByCommand(target.commandId)
      : await this.options.employeeRuns.get(target.runId)
    if (record === undefined && target.runId !== '') record = await this.options.employeeRuns.findByCommand(target.commandId)
    if (record === undefined) return unknownTarget('Employee run could not be verified')
    assertEmployeeAssociation(record, snapshot.task.id, target)

    let decision = employeeDecision(record)
    if (decision.shouldRequestCancel === true && canIssueFirstCancel(target)) {
      try {
        record = await this.options.employeeRuns.cancel(record.runId)
      } catch (error) {
        return { ...unknownTarget(error), runId: record.runId }
      }
      assertEmployeeAssociation(record, snapshot.task.id, target)
      decision = employeeDecision(record)
    } else if (decision.shouldRequestCancel === true) {
      return unknownTarget('Employee run is still active without durable cancellation evidence')
    }
    return { ...withoutControlFlag(decision), runId: record.runId }
  }

  private async reconcileWorkflow(snapshot: WorkTaskSnapshot, target: WorkTaskCancellationTarget): Promise<WorkTaskCancellationTargetUpdate> {
    let record = target.runId === ''
      ? await this.options.workflowRuns.findByCommand(target.commandId)
      : await this.options.workflowRuns.get(target.runId)
    if (record === undefined && target.runId !== '') record = await this.options.workflowRuns.findByCommand(target.commandId)
    if (record === undefined) return unknownTarget('Workflow run could not be verified')
    assertWorkflowAssociation(record, snapshot.task.id, target)

    let decision = workflowDecision(record)
    const shouldBeginExecutionTreeCancellation = target.state === 'pending' && record.workTaskCancellation === undefined
    if (shouldBeginExecutionTreeCancellation
      || decision.shouldRequestCancel === true && (canIssueFirstCancel(target) || canFinalizeWorkflowCancellationFence(record))) {
      try {
        record = await this.options.workflowRuns.cancel(record.id)
      } catch (error) {
        return { ...unknownTarget(error), runId: record.id }
      }
      assertWorkflowAssociation(record, snapshot.task.id, target)
      decision = workflowDecision(record)
    } else if (decision.shouldRequestCancel === true) {
      return unknownTarget('Workflow run is still active without durable cancellation evidence')
    }
    return { ...withoutControlFlag(decision), runId: record.id }
  }

  private async serialize<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskTails.get(taskId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.taskTails.set(taskId, tail)
    void tail.finally(() => { if (this.taskTails.get(taskId) === tail) this.taskTails.delete(taskId) })
    return result
  }
}

function employeeDecision(record: EmployeeRunRecord): TargetDecision {
  const observedAt = new Date().toISOString()
  if (record.status === 'cancelled') return { state: 'cancelled', finalRunStatus: 'cancelled', observedAt }
  if (record.status === 'completed' || record.status === 'failed') {
    return { state: 'settled', finalRunStatus: record.status, observedAt }
  }
  if (record.status === 'interrupted') return unknownTarget(record.observationError ?? record.error ?? 'Employee run outcome is unknown')
  if (record.status === 'cancelling') {
    if (record.observerState === 'timeout' || record.observerState === 'disconnected' || record.observerState === 'unsupported') {
      return unknownTarget(record.observationError ?? `Employee observer is ${record.observerState}`)
    }
    if (record.cancelRequestState !== 'accepted') {
      return unknownTarget(record.cancelRequestError ?? 'Employee cancellation has no accepted receipt')
    }
    return { state: 'cancelling', observedAt }
  }
  return { state: 'pending', observedAt, shouldRequestCancel: true }
}

function workflowDecision(record: WorkflowRunRecord): TargetDecision {
  const observedAt = new Date().toISOString()
  const tree = record.workTaskCancellation
  if (tree !== undefined) {
    if (tree.state === 'outcome-unknown') {
      const unknown = tree.targets.find((target) => target.state === 'outcome-unknown')
      return unknownTarget(unknown?.error ?? `Workflow execution tree ${record.id} cancellation outcome is unknown`)
    }
    if (tree.state === 'cancelling') return { state: 'cancelling', observedAt }
    const root = tree.targets.find((target) => target.runId === record.id)
    if (root?.state === 'cancelled' && root.finalRunStatus === 'cancelled') {
      return { state: 'cancelled', finalRunStatus: 'cancelled', observedAt }
    }
    if (root?.state === 'settled' && root.finalRunStatus === 'completed') {
      return { state: 'settled', finalRunStatus: 'completed', observedAt }
    }
    return unknownTarget(`Workflow execution tree ${record.id} has no final root result`)
  }
  if (record.status === 'cancelled') return { state: 'cancelled', finalRunStatus: 'cancelled', observedAt }
  if (record.status === 'completed') {
    return { state: 'settled', finalRunStatus: 'completed', observedAt }
  }
  if (record.status === 'running' && record.queue?.cancellationRequestedAt !== undefined) {
    return { state: 'cancelling', observedAt }
  }
  return { state: 'pending', observedAt, shouldRequestCancel: true }
}

function assertEmployeeAssociation(record: EmployeeRunRecord, taskId: string, target: WorkTaskCancellationTarget): void {
  if (record.commandId !== target.commandId || record.taskId !== taskId || record.attemptId !== target.attemptId
    || record.requirementVersion !== target.requirementVersion
    || record.employeeId !== (target.executor.kind === 'employee' ? target.executor.employeeId : undefined)) {
    throw new Error(`Employee command ${target.commandId} does not match task ${taskId}`)
  }
  if (target.runId !== '' && record.runId !== target.runId) throw new Error(`Employee command ${target.commandId} changed run id`)
}

function assertWorkflowAssociation(record: WorkflowRunRecord, taskId: string, target: WorkTaskCancellationTarget): void {
  if (record.origin?.kind !== 'top-level' || record.workTask?.taskId !== taskId
    || record.workTask.commandId !== target.commandId || record.workTask.attemptId !== target.attemptId
    || record.workTask.requirementVersion !== target.requirementVersion) {
    throw new Error(`Workflow command ${target.commandId} does not match task ${taskId}`)
  }
  if (target.runId !== '' && record.id !== target.runId) throw new Error(`Workflow command ${target.commandId} changed run id`)
}

function unknownTarget(error: unknown): WorkTaskCancellationTargetUpdate {
  const message = error instanceof Error ? error.message : String(error)
  return {
    state: 'outcome-unknown',
    error: message.slice(0, 1_000) || 'Cancellation outcome is unknown',
    observedAt: new Date().toISOString(),
  }
}

function withoutControlFlag(decision: TargetDecision): WorkTaskCancellationTargetUpdate {
  const { shouldRequestCancel: _ignored, ...update } = decision
  return update
}

function canIssueFirstCancel(target: WorkTaskCancellationTarget): boolean {
  if (target.state === 'pending') return true
  // The only safe retry from an unknown target is a command that did not yet
  // exist when first checked. A late dispatch link supplies the missing
  // authoritative record; no earlier cancel call was made in that branch.
  return target.state === 'outcome-unknown' && target.error?.endsWith('run could not be verified') === true
}

function canFinalizeWorkflowCancellationFence(record: WorkflowRunRecord): boolean {
  return (record.status === 'paused' || record.status === 'failed')
    && record.queue?.cancellationRequestedAt !== undefined
}
