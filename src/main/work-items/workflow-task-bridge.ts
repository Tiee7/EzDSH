import type { WorkflowRunRecord, WorkflowRunTaskAssociation, WorkflowValue } from '../../shared/workflow.js'

export interface WorkflowTaskStartRequest extends WorkflowRunTaskAssociation {
  workflowId: string
  workflowRevision?: number
  input: WorkflowValue
}

export interface WorkflowTaskRunPort {
  start(
    workflowId: string,
    input: WorkflowValue,
    options?: { idempotencyKey?: string; workflowRevision?: number; debug?: boolean },
    association?: WorkflowRunTaskAssociation
  ): Promise<WorkflowRunRecord>
  resume(runId: string): Promise<WorkflowRunRecord>
  cancel(runId: string): Promise<WorkflowRunRecord>
  findByIdempotencyKey(idempotencyKey: string): Promise<WorkflowRunRecord | undefined> | WorkflowRunRecord | undefined
}

/** Main-only bridge. Renderer workflow starts never receive a trusted task association. */
export class WorkflowTaskBridge {
  constructor(private readonly workflowRuns: WorkflowTaskRunPort) {}

  start(request: WorkflowTaskStartRequest): Promise<WorkflowRunRecord> {
    const association: WorkflowRunTaskAssociation = {
      taskId: request.taskId,
      attemptId: request.attemptId,
      requirementVersion: request.requirementVersion,
      commandId: request.commandId,
      ...(request.sourceRunId === undefined ? {} : { sourceRunId: request.sourceRunId }),
    }
    return this.workflowRuns.start(
      request.workflowId,
      request.input,
      { idempotencyKey: request.commandId, ...(request.workflowRevision === undefined ? {} : { workflowRevision: request.workflowRevision }) },
      association
    )
  }

  findByCommand(commandId: string): Promise<WorkflowRunRecord | undefined> {
    return Promise.resolve(this.workflowRuns.findByIdempotencyKey(commandId))
  }

  resume(runId: string): Promise<WorkflowRunRecord> {
    return this.workflowRuns.resume(runId)
  }

  cancel(runId: string): Promise<WorkflowRunRecord> {
    return this.workflowRuns.cancel(runId)
  }

  startDebug(workflowId: string, input: WorkflowValue): Promise<WorkflowRunRecord> {
    return this.workflowRuns.start(workflowId, input, { debug: true })
  }
}
