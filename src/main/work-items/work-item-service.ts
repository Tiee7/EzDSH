import {
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  type WorkItemQuery,
  type WorkTaskCreateRequest,
  type WorkTaskExecuteRequest,
  type WorkTaskSnapshot
} from '../../shared/work-items.js'
import {
  WorkItemStore,
  type WorkDispatchIntentReceipt
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
}
