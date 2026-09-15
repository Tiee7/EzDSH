import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkActionService } from '../../src/main/work-items/work-action-service.js'
import { WorkItemService } from '../../src/main/work-items/work-item-service.js'
import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store.js'
import type { WorkflowApprovalDecisionRequest, WorkflowRunRecord } from '../../src/shared/workflow.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-actions-'))
  directories.push(directory)
  return directory
}

async function taskFixture(existingDirectory?: string) {
  const directory = existingDirectory ?? await stateDirectory()
  const store = new WorkItemStore(directory)
  const workItems = new WorkItemService(store)
  await workItems.initialize()
  const task = await workItems.create({
    requestId: 'create-task', title: 'Approval task', goal: 'Publish safely', acceptance: 'Approval is explicit', scope: { resourceRefs: [] },
  })
  const intent = await workItems.recordDispatchIntent({
    requestId: 'dispatch-workflow', taskId: task.task.id, expectedRevision: task.task.revision,
    executor: { kind: 'workflow', workflowId: 'workflow-1' }, mode: 'initial', input: null,
  })
  const linked = await workItems.linkDispatch(intent.requestId, intent.commandId, {
    runId: 'workflow-run-1', status: 'waiting', rawStatus: 'waiting-approval',
    capabilities: { cancel: true, resume: false, append: false },
  })
  return { directory, store, workItems, task: linked.snapshot, commandId: intent.commandId }
}

function waitingRun(commandId: string, eventId: string, events: WorkflowRunRecord['events'] = []): WorkflowRunRecord {
  return {
    id: 'workflow-run-1', workflowId: 'workflow-1', workflowRevision: 1, origin: { kind: 'top-level' },
    workTask: { taskId: '', attemptId: '', requirementVersion: 1, commandId },
    status: 'waiting-approval', waitingApprovalNodeId: 'approval', input: null,
    nodeStates: [{ nodeId: 'approval', status: 'pending' }],
    events: [...events, { id: eventId, time: '2026-09-15T10:00:00.000Z', type: 'approval-requested', nodeId: 'approval', message: 'Approve?' }],
    allowShellFile: false, debug: false,
  }
}

function workflowBridge(initial: WorkflowRunRecord) {
  let current = structuredClone(initial)
  const approveExpected = vi.fn(async (runId: string, request: WorkflowApprovalDecisionRequest) => {
    if (runId !== current.id) throw new Error('Workflow run not found')
    const event = current.events.find((candidate) => candidate.id === request.expectedApprovalEventId)
    const latest = [...current.events].reverse().find((candidate) => candidate.type === 'approval-requested')
    if (event?.nodeId !== request.expectedNodeId || latest?.id !== event.id || current.status !== 'waiting-approval') {
      throw new Error('Workflow approval target is stale')
    }
    current.status = request.approved ? 'queued' : 'failed'
    current.waitingApprovalNodeId = undefined
    current.events.push({
      id: `decision-${request.requestId}`, time: '2026-09-15T10:01:00.000Z',
      type: request.approved ? 'approval-approved' : 'approval-rejected', nodeId: request.expectedNodeId,
    })
    return structuredClone(current)
  })
  return {
    get: vi.fn(async (runId: string) => runId === current.id ? structuredClone(current) : undefined),
    approveExpected,
    resume: vi.fn(),
    cancel: vi.fn(),
    setCurrent(record: WorkflowRunRecord) { current = structuredClone(record) },
  }
}

describe('WorkActionService', () => {
  it('closes an approval action for a workflow-backed employee method', async () => {
    const directory = await stateDirectory()
    const workItems = new WorkItemService(new WorkItemStore(directory))
    await workItems.initialize()
    const created = await workItems.create({ requestId: 'method-task', title: 'Method task', goal: 'Run method', acceptance: 'Approve result', scope: { resourceRefs: [] } })
    const intent = await workItems.recordDispatchIntent({
      requestId: 'method-dispatch', taskId: created.task.id, expectedRevision: created.task.revision,
      executor: { kind: 'employee', employeeId: 'researcher', methodId: 'method-1', methodVersion: 2 }, mode: 'initial', input: null,
    })
    const linked = await workItems.linkDispatch(intent.requestId, intent.commandId, { runId: 'workflow-run-1', status: 'waiting', rawStatus: 'waiting-approval', capabilities: { cancel: true, resume: false, append: false } })
    const run = waitingRun(intent.commandId, 'method-approval')
    run.workTask = { taskId: linked.snapshot.task.id, attemptId: linked.snapshot.attempts[0]!.id, requirementVersion: 1, commandId: intent.commandId }
    const workflows = workflowBridge(run)
    const service = new WorkActionService({ workItems, employeeRuns: {}, workflowBridge: workflows })
    const observed = await service.observeWorkflowRun(run)
    const action = observed!.actions[0]!
    const answered = await service.answerAction({ requestId: 'method-answer', taskId: linked.snapshot.task.id, actionId: action.id, expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1, answer: true })
    expect(workflows.approveExpected).toHaveBeenCalledOnce()
    expect(answered.actions[0]?.status).toBe('resolved')
  })

  it('answers the same durable action from two callers with one Workflow decision', async () => {
    const fixture = await taskFixture()
    const run = waitingRun(fixture.commandId, 'approval-event-1')
    run.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(run)
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const observed = await service.observeWorkflowRun(run)
    const action = observed!.actions[0]!
    const request = {
      requestId: 'answer-1', taskId: fixture.task.task.id, actionId: action.id,
      expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1, answer: true,
    }

    const [first, second] = await Promise.all([service.answerAction(request), service.answerAction(request)])

    expect(workflows.approveExpected).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first.actions[0]?.status).toBe('resolved')
    expect(first.runs[0]).toMatchObject({ runId: run.id, status: 'queued', rawStatus: 'queued' })
  })

  it('rejects an old occurrence when the same node is waiting on a later event', async () => {
    const fixture = await taskFixture()
    const firstRun = waitingRun(fixture.commandId, 'approval-event-1')
    firstRun.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(firstRun)
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const firstObserved = await service.observeWorkflowRun(firstRun)
    const oldAction = firstObserved!.actions[0]!
    const laterRun = waitingRun(fixture.commandId, 'approval-event-2', [
      firstRun.events[0]!,
      { id: 'decision-1', time: '2026-09-15T10:01:00.000Z', type: 'approval-approved', nodeId: 'approval' },
    ])
    laterRun.workTask = firstRun.workTask
    workflows.setCurrent(laterRun)

    await expect(service.answerAction({
      requestId: 'stale-answer', taskId: fixture.task.task.id, actionId: oldAction.id,
      expectedSourceEventId: oldAction.sourceEventId, expectedRequirementVersion: 1, answer: false,
    })).rejects.toThrow(/stale/u)
    expect((await fixture.workItems.get(fixture.task.task.id))?.actions[0]?.status).toBe('open')
  })

  it('persists separate identities for repeated node occurrences and reopens the idempotent answer receipt', async () => {
    const fixture = await taskFixture()
    const firstRun = waitingRun(fixture.commandId, 'approval-event-1')
    firstRun.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(firstRun)
    const firstService = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    await firstService.observeWorkflowRun(firstRun)
    const laterRun = waitingRun(fixture.commandId, 'approval-event-2', [
      firstRun.events[0]!,
      { id: 'decision-1', time: '2026-09-15T10:01:00.000Z', type: 'approval-approved', nodeId: 'approval' },
    ])
    laterRun.workTask = firstRun.workTask
    workflows.setCurrent(laterRun)
    const observed = await firstService.observeWorkflowRun(laterRun)

    expect(observed?.actions).toHaveLength(2)
    expect(observed?.actions.map((action) => action.id)).toEqual(expect.arrayContaining([
      expect.stringContaining('approval-event-1'), expect.stringContaining('approval-event-2'),
    ]))
    expect(observed?.actions.map((action) => action.status)).toEqual(['resolved', 'open'])

    const current = observed!.actions[1]!
    const request = {
      requestId: 'answer-current', taskId: fixture.task.task.id, actionId: current.id,
      expectedSourceEventId: current.sourceEventId, expectedRequirementVersion: 1, answer: true,
    }
    const answered = await firstService.answerAction(request)
    const reopenedItems = new WorkItemService(new WorkItemStore(fixture.directory))
    await reopenedItems.initialize()
    const reopenedService = new WorkActionService({ workItems: reopenedItems, employeeRuns: {}, workflowBridge: workflows })
    const replay = await reopenedService.answerAction(request)

    expect(replay).toEqual(answered)
    expect(workflows.approveExpected).toHaveBeenCalledTimes(1)
    await expect(reopenedService.answerAction({ ...request, answer: false })).rejects.toBeInstanceOf(WorkItemStoreConflictError)
  })

  it('rejects an unknown action and a mismatched requirement version without touching Workflow', async () => {
    const fixture = await taskFixture()
    const run = waitingRun(fixture.commandId, 'approval-event-1')
    run.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(run)
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const action = (await service.observeWorkflowRun(run))!.actions[0]!

    await expect(service.answerAction({ requestId: 'unknown', taskId: fixture.task.task.id, actionId: 'missing', expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1, answer: true })).rejects.toThrow(/action.*not found/iu)
    await expect(service.answerAction({ requestId: 'wrong-version', taskId: fixture.task.task.id, actionId: action.id, expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 2, answer: true })).rejects.toThrow(/requirement/iu)
    expect(workflows.approveExpected).not.toHaveBeenCalled()
  })

  it('does not reopen a resolved action when an older waiting projection arrives late', async () => {
    const fixture = await taskFixture()
    const waiting = waitingRun(fixture.commandId, 'approval-event-1')
    waiting.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(waiting)
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const action = (await service.observeWorkflowRun(waiting))!.actions[0]!
    await service.answerAction({
      requestId: 'answer-before-late-observation', taskId: fixture.task.task.id, actionId: action.id,
      expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1, answer: true,
    })

    const afterLateObservation = await service.observeWorkflowRun(waiting)

    expect(afterLateObservation?.actions[0]?.status).toBe('resolved')
  })

  it('rejects a non-boolean approval before reserving its request id', async () => {
    const fixture = await taskFixture()
    const run = waitingRun(fixture.commandId, 'approval-event-1')
    run.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(run)
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const action = (await service.observeWorkflowRun(run))!.actions[0]!
    const base = {
      requestId: 'answer-type-check', taskId: fixture.task.task.id, actionId: action.id,
      expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1,
    }

    expect(() => service.answerAction({ ...base, answer: 'yes' })).toThrow(/boolean/iu)
    await expect(service.answerAction({ ...base, answer: true })).resolves.toMatchObject({
      actions: [{ id: action.id, status: 'resolved' }],
    })
    expect(workflows.approveExpected).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('durably claims one action before distinct request ids race with loser answer %s', async (loserAnswer) => {
    const fixture = await taskFixture()
    const run = waitingRun(fixture.commandId, 'approval-event-1')
    run.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(run)
    const originalApprove = workflows.approveExpected.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const approvalEntered = new Promise<void>((resolve) => { entered = resolve })
    workflows.approveExpected.mockImplementation(async (...args) => {
      entered()
      await gate
      return originalApprove(...args)
    })
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const action = (await service.observeWorkflowRun(run))!.actions[0]!
    const request = (requestId: string, answer: boolean) => ({
      requestId, taskId: fixture.task.task.id, actionId: action.id,
      expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1, answer,
    })

    const winner = service.answerAction(request('winner-request', true))
    await approvalEntered
    await expect(service.answerAction(request('loser-request', loserAnswer))).rejects.toThrow(/claimed|no longer open/iu)
    release()
    await winner

    const reopenedItems = new WorkItemService(new WorkItemStore(fixture.directory))
    await reopenedItems.initialize()
    const reopened = new WorkActionService({ workItems: reopenedItems, employeeRuns: {}, workflowBridge: workflows })
    await expect(reopened.answerAction(request('loser-request', loserAnswer))).rejects.toThrow(/claimed|no longer open/iu)
    expect(workflows.approveExpected).toHaveBeenCalledTimes(1)
  })

  it('keeps resolved over a late superseded projection and upgrades superseded when resolution evidence arrives', async () => {
    const fixture = await taskFixture()
    const waiting = waitingRun(fixture.commandId, 'approval-event-1')
    waiting.workTask = { taskId: fixture.task.task.id, attemptId: fixture.task.attempts[0]!.id, requirementVersion: 1, commandId: fixture.commandId }
    const workflows = workflowBridge(waiting)
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge: workflows })
    const action = (await service.observeWorkflowRun(waiting))!.actions[0]!
    await service.answerAction({
      requestId: 'resolved-answer', taskId: fixture.task.task.id, actionId: action.id,
      expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: 1, answer: true,
    })
    const supersededProjection = structuredClone(waiting)
    supersededProjection.status = 'failed'
    supersededProjection.waitingApprovalNodeId = undefined
    expect((await service.observeWorkflowRun(supersededProjection))?.actions[0]?.status).toBe('resolved')

    const second = waitingRun(fixture.commandId, 'approval-event-2', [
      ...supersededProjection.events,
      { id: 'decision-1', time: '2026-09-15T10:01:00.000Z', type: 'approval-approved', nodeId: 'approval' },
    ])
    second.workTask = waiting.workTask
    second.status = 'failed'
    second.waitingApprovalNodeId = undefined
    const initiallySuperseded = await service.observeWorkflowRun(second)
    expect(initiallySuperseded?.actions[1]?.status).toBe('superseded')
    const resolvedSecond = structuredClone(second)
    resolvedSecond.events.push({ id: 'decision-2', time: '2026-09-15T10:03:00.000Z', type: 'approval-rejected', nodeId: 'approval' })
    expect((await service.observeWorkflowRun(resolvedSecond))?.actions[1]?.status).toBe('resolved')
  })
})
