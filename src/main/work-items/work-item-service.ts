import {
  validateWorkActionAnswerRequest,
  validateWorkArtifactAcceptRequest,
  validateWorkRunControlRequest,
  validateWorkTaskArchiveRequest,
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  validateWorkTaskRevisionRequest,
  type WorkAction,
  type WorkActionAnswerRequest,
  type WorkArtifact,
  type WorkArtifactAcceptRequest,
  type WorkItemQuery,
  type WorkRunControlRequest,
  type WorkTaskArchiveRequest,
  type WorkTaskCreateRequest,
  type WorkTaskExecuteRequest,
  type WorkTaskRevisionRequest,
  type WorkTaskSnapshot
} from '../../shared/work-items.js'
import {
  WorkItemStore,
  type WorkActionAnswerReceipt,
  type WorkArtifactAcceptReceipt,
  type WorkDispatchIntentReceipt,
  type WorkRunControlReceipt
} from './work-item-store.js'

export class WorkItemService {
  constructor(
    private readonly store: WorkItemStore,
    private readonly artifactVerifier?: (artifact: WorkArtifact) => Promise<boolean>,
    private readonly artifactOpener?: (artifact: WorkArtifact) => Promise<void>,
  ) {}

  initialize(): Promise<void> {
    return this.store.initialize()
  }

  async create(input: WorkTaskCreateRequest): Promise<WorkTaskSnapshot> {
    const receipt = await this.store.create(validateWorkTaskCreateRequest(input))
    return receipt.snapshot
  }

  async revise(input: WorkTaskRevisionRequest): Promise<WorkTaskSnapshot> {
    const receipt = await this.store.revise(validateWorkTaskRevisionRequest(input))
    return receipt.snapshot
  }

  async archive(input: WorkTaskArchiveRequest): Promise<WorkTaskSnapshot> {
    const receipt = await this.store.archive(validateWorkTaskArchiveRequest(input))
    return receipt.snapshot
  }

  async acceptArtifact(input: WorkArtifactAcceptRequest): Promise<WorkTaskSnapshot> {
    if (this.artifactVerifier === undefined) {
      throw new Error('WorkItemService requires a trusted artifact verifier before accepting artifacts')
    }
    const receipt: WorkArtifactAcceptReceipt = await this.store.acceptArtifact(
      validateWorkArtifactAcceptRequest(input),
      this.artifactVerifier,
    )
    return receipt.snapshot
  }

  async openArtifact(taskId: string, artifactId: string): Promise<void> {
    const snapshot = await this.store.get(taskId)
    if (snapshot === undefined) throw new Error(`Task ${taskId} was not found`)
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === artifactId)
    if (artifact === undefined) throw new Error(`Artifact ${artifactId} was not found on task ${taskId}`)
    if (this.artifactVerifier === undefined || !await this.artifactVerifier(artifact)) {
      throw new Error(`Artifact ${artifactId} failed integrity verification`)
    }
    if (this.artifactOpener === undefined) throw new Error('Artifact opening is unavailable')
    await this.artifactOpener(artifact)
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

  syncEmployeeRun(taskId: string, runId: string, execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>): Promise<WorkTaskSnapshot | undefined> {
    return this.store.syncRun(taskId, runId, execution)
  }

  syncWorkflowRun(taskId: string, runId: string, execution: Pick<WorkTaskSnapshot['runs'][number], 'status' | 'rawStatus' | 'capabilities'>): Promise<WorkTaskSnapshot | undefined> {
    return this.store.syncRun(taskId, runId, execution)
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
