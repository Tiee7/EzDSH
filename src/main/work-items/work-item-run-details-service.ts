import type {
  EmployeeRunRecord,
} from '../../shared/employee-runs.js'
import type {
  WorkExecutor,
  WorkTaskEmployeeRunDetail,
  WorkTaskRunDetail,
  WorkTaskSnapshot,
  WorkTaskWorkflowRunDetail,
} from '../../shared/work-items.js'
import type { WorkflowRunRecord } from '../../shared/workflow.js'
import type { WorkItemService } from './work-item-service.js'

export interface WorkItemRunDetailsEmployeePort {
  getWorkItemRun(runId: string): Promise<EmployeeRunRecord | undefined>
}

export interface WorkItemRunDetailsWorkflowPort {
  get(runId: string): WorkflowRunRecord | undefined
}

export interface WorkItemRunDetailsReadService {
  getRunDetail(taskId: string, runId: string): Promise<WorkTaskRunDetail | undefined>
}

/**
 * Reads one authoritative execution after checking its durable WorkItem link.
 * The explicit projections below are the IPC allowlist: executor internals,
 * immutable employee prompts, queue leases, and credential metadata never cross
 * into the renderer.
 */
export class WorkItemRunDetailsService implements WorkItemRunDetailsReadService {
  constructor(
    private readonly workItems: Pick<WorkItemService, 'get'>,
    private readonly employeeRuns: WorkItemRunDetailsEmployeePort,
    private readonly workflowRuns: WorkItemRunDetailsWorkflowPort,
  ) {}

  async getRunDetail(taskId: string, runId: string): Promise<WorkTaskRunDetail | undefined> {
    const snapshot = await this.workItems.get(taskId)
    if (snapshot === undefined) return undefined

    const reference = snapshot.runs.find((run) => run.runId === runId)
    if (reference === undefined || reference.runId === '') return undefined

    if (reference.executor.kind === 'employee' && reference.executor.methodId === undefined) {
      const run = await this.employeeRuns.getWorkItemRun(runId)
      return run === undefined ? undefined : this.employeeDetail(snapshot, reference.executor, reference.commandId, runId, run)
    }

    const run = this.workflowRuns.get(runId)
    return run === undefined ? undefined : this.workflowDetail(snapshot, reference.executor, reference.commandId, runId, run)
  }

  private employeeDetail(
    snapshot: WorkTaskSnapshot,
    executor: Extract<WorkExecutor, { kind: 'employee' }>,
    commandId: string,
    runId: string,
    run: EmployeeRunRecord,
  ): WorkTaskEmployeeRunDetail | undefined {
    if (run.runId !== runId || run.taskId !== snapshot.task.id || run.commandId !== commandId || run.employeeId !== executor.employeeId) return undefined
    return {
      kind: 'employee',
      executor: clone(executor),
      taskId: snapshot.task.id,
      ...(run.attemptId === undefined ? {} : { attemptId: run.attemptId }),
      ...(run.requirementVersion === undefined ? {} : { requirementVersion: run.requirementVersion }),
      runId: run.runId,
      commandId: run.commandId,
      requestDigest: run.requestDigest,
      ...(run.sourceRunId === undefined ? {} : { sourceRunId: run.sourceRunId }),
      employeeId: run.employeeId,
      employeeVersion: run.employeeVersion,
      task: clone(run.task),
      ...(run.round === undefined ? {} : { round: clone(run.round) }),
      context: clone(run.context),
      ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
      cwd: run.cwd,
      sessionId: run.sessionId,
      sessionEvidence: run.sessionEvidence,
      status: run.status,
      dispatchStage: run.dispatchStage,
      promptRequestId: run.promptRequestId,
      ...(run.promptAcceptedAt === undefined ? {} : { promptAcceptedAt: run.promptAcceptedAt }),
      ...(run.observationCursor === undefined ? {} : { observationCursor: run.observationCursor }),
      ...(run.observerState === undefined ? {} : { observerState: run.observerState }),
      ...(run.observationError === undefined ? {} : { observationError: run.observationError }),
      ...(run.terminalEvidence === undefined ? {} : { terminalEvidence: clone(run.terminalEvidence) }),
      ...(run.cancelRequestState === undefined ? {} : { cancelRequestState: run.cancelRequestState }),
      ...(run.cancelRequestError === undefined ? {} : { cancelRequestError: run.cancelRequestError }),
      partialOutput: run.partialOutput,
      output: run.output,
      ...(run.error === undefined ? {} : { error: run.error }),
      ...(run.cancelReason === undefined ? {} : { cancelReason: run.cancelReason }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
      ...(run.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: run.cancelRequestedAt }),
    }
  }

  private workflowDetail(
    snapshot: WorkTaskSnapshot,
    executor: WorkExecutor,
    commandId: string,
    runId: string,
    run: WorkflowRunRecord,
  ): WorkTaskWorkflowRunDetail | undefined {
    const association = run.workTask
    if (association === undefined
      || association.taskId !== snapshot.task.id
      || association.commandId !== commandId
      || run.id !== runId) return undefined
    if (executor.kind === 'workflow' && executor.workflowId !== run.workflowId) return undefined

    return {
      kind: 'workflow',
      executor: clone(executor),
      taskId: snapshot.task.id,
      attemptId: association.attemptId,
      requirementVersion: association.requirementVersion,
      runId: run.id,
      commandId: association.commandId,
      ...(association.sourceRunId === undefined ? {} : { sourceRunId: association.sourceRunId }),
      workflowId: run.workflowId,
      workflowRevision: run.workflowRevision,
      ...(run.environmentId === undefined ? {} : { environmentId: run.environmentId }),
      ...(run.releaseId === undefined ? {} : { releaseId: run.releaseId }),
      ...(run.traceId === undefined ? {} : { traceId: run.traceId }),
      ...(run.idempotencyKey === undefined ? {} : { idempotencyKey: run.idempotencyKey }),
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      ...(run.workflowAncestry === undefined ? {} : { workflowAncestry: clone(run.workflowAncestry) }),
      ...(run.origin === undefined ? {} : { origin: clone(run.origin) }),
      status: run.status,
      ...(run.queue === undefined ? {} : {
        queue: {
          enqueuedAt: run.queue.enqueuedAt,
          availableAt: run.queue.availableAt,
          ...(run.queue.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: run.queue.cancellationRequestedAt }),
        },
      }),
      input: clone(run.input),
      ...(run.output === undefined ? {} : { output: clone(run.output) }),
      nodeStates: clone(run.nodeStates),
      events: clone(run.events),
      ...(run.approvalDecisionReceipts === undefined ? {} : { approvalDecisionReceipts: clone(run.approvalDecisionReceipts) }),
      ...(run.questionAnswerReceipts === undefined ? {} : { questionAnswerReceipts: clone(run.questionAnswerReceipts) }),
      ...(run.compensationStack === undefined ? {} : { compensationStack: clone(run.compensationStack) }),
      ...(run.compensationBlocker === undefined ? {} : { compensationBlocker: run.compensationBlocker }),
      ...(run.effectReconciliationTargets === undefined ? {} : { effectReconciliationTargets: clone(run.effectReconciliationTargets) }),
      allowShellFile: run.allowShellFile,
      ...(run.allowCode === undefined ? {} : { allowCode: run.allowCode }),
      ...(run.debug === undefined ? {} : { debug: run.debug }),
      ...(run.waitingApprovalNodeId === undefined ? {} : { waitingApprovalNodeId: run.waitingApprovalNodeId }),
      ...(run.waitingQuestionNodeId === undefined ? {} : { waitingQuestionNodeId: run.waitingQuestionNodeId }),
      ...(run.waitingQuestion === undefined ? {} : { waitingQuestion: clone(run.waitingQuestion) }),
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
