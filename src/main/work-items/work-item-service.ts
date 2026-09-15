import {
  validateWorkActionAnswerRequest,
  validateWorkRunControlRequest,
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  type WorkAction,
  type WorkActionAnswerRequest,
  type WorkItemQuery,
  type WorkRunControlRequest,
  type WorkTaskCreateRequest,
  type WorkTaskExecuteRequest,
  type WorkTaskSnapshot
} from '../../shared/work-items.js'
import {
  WorkItemStore,
  type WorkActionAnswerReceipt,
  type WorkDispatchIntentReceipt,
  type WorkRunControlReceipt
} from './work-item-store.js'

export class WorkItemService {
  constructor(private readonly store: WorkItemStore) {}

  initialize(): Promise<void> {
    return this.store.initialize()
  }

  async create(input: WorkTaskCreateRequest): Promise<WorkTaskSnapshot> {
    const receipt = await this.store.create(validateWorkTaskCreateRequest(input))
    return receipt.snapshot
  }

  get(taskId: string): Promise<WorkTaskSnapshot | undefined> {
    return this.store.get(taskId)
  }

  list(query?: WorkItemQuery): Promise<WorkTaskSnapshot[]> {
    return this.store.list(query)
  }

  recordDispatchIntent(input: WorkTaskExecuteRequest): Promise<WorkDispatchIntentReceipt> {
    return this.store.recordDispatchIntent(validateWorkTaskExecuteRequest(input))
  }

  claimDispatch(requestId: string, commandId: string): Promise<WorkDispatchIntentReceipt> {
    return this.store.claimDispatch(requestId, commandId)
  }

  linkDispatch(
    requestId: string,
    commandId: string,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'runId' | 'status' | 'rawStatus' | 'capabilities'>
  ): Promise<WorkDispatchIntentReceipt> {
    return this.store.linkDispatch(requestId, commandId, execution)
  }

  markDispatchOutcomeUnknown(requestId: string, commandId: string, rawStatus: string): Promise<WorkDispatchIntentReceipt> {
    return this.store.markDispatchOutcomeUnknown(requestId, commandId, rawStatus)
  }

  syncWorkflowActions(taskId: string, runId: string, actions: WorkAction[]): Promise<WorkTaskSnapshot> {
    return this.store.syncWorkflowActions(taskId, runId, actions)
  }

  beginActionAnswer(input: WorkActionAnswerRequest): Promise<WorkActionAnswerReceipt> {
    return this.store.beginActionAnswer(validateWorkActionAnswerRequest(input))
  }

  completeActionAnswer(
    input: WorkActionAnswerRequest,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>,
  ): Promise<WorkActionAnswerReceipt> {
    return this.store.completeActionAnswer(validateWorkActionAnswerRequest(input), execution)
  }

  rejectActionAnswer(input: WorkActionAnswerRequest, reason: string): Promise<WorkActionAnswerReceipt> {
    return this.store.rejectActionAnswer(validateWorkActionAnswerRequest(input), reason)
  }

  beginRunControl(input: WorkRunControlRequest): Promise<WorkRunControlReceipt> {
    return this.store.beginRunControl(validateWorkRunControlRequest(input))
  }

  completeRunControl(
    input: WorkRunControlRequest,
    execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>,
  ): Promise<WorkRunControlReceipt> {
    return this.store.completeRunControl(validateWorkRunControlRequest(input), execution)
  }
}
