import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store'
import type { WorkAction, WorkTaskExecuteRequest } from '../../src/shared/work-items'

const directories: string[] = []

async function createStore(): Promise<WorkItemStore> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-cancel-'))
  directories.push(directory)
  const store = new WorkItemStore(directory)
  await store.initialize()
  return store
}

async function createTask(store: WorkItemStore, requestId = 'create') {
  return store.create({
    requestId,
    title: 'Release brief',
    goal: 'Prepare the release brief',
    acceptance: 'The brief is reviewable',
    scope: { resourceRefs: [] },
  })
}

async function addWorkflowRun(store: WorkItemStore, taskId: string, expectedRevision: number, suffix: string) {
  const request: WorkTaskExecuteRequest = {
    requestId: `dispatch-${suffix}`,
    taskId,
    expectedRevision,
    executor: { kind: 'workflow', workflowId: `workflow-${suffix}`, workflowRevision: 1 },
    mode: 'initial',
    input: null,
  }
  const intent = await store.recordDispatchIntent(request)
  const linked = await store.linkDispatch(intent.requestId, intent.commandId, {
    runId: `run-${suffix}`,
    status: 'running',
    rawStatus: 'running',
    capabilities: { cancel: true, resume: false, append: false },
  })
  return { request, intent, linked }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('WorkItemStore task cancellation', () => {
  it('persists the cancellation intent and supersedes open actions before executor work', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked } = await addWorkflowRun(store, created.task.id, created.task.revision, 'one')
    const run = linked.snapshot.runs[0]!
    const action: WorkAction = {
      id: 'approval-1', taskId: created.task.id, runId: run.runId, sourceEventId: 'event-1',
      requirementVersion: run.requirementVersion, kind: 'approval', status: 'open', nodeId: 'approval-node',
    }
    const withAction = await store.syncWorkflowActions(created.task.id, run.runId, [action])

    const receipt = await store.beginTaskCancellation({
      requestId: 'cancel-task', taskId: created.task.id, expectedRevision: withAction.task.revision,
    })

    expect(receipt).toMatchObject({ requestId: 'cancel-task', taskId: created.task.id, stage: 'requested', replayed: false })
    expect(receipt.snapshot.task).toMatchObject({
      status: 'active',
      cancellation: {
        requestId: 'cancel-task', expectedRevision: withAction.task.revision, state: 'requested',
        targets: [{
          commandId: run.commandId, runId: run.runId, attemptId: run.attemptId,
          requirementVersion: run.requirementVersion, executor: run.executor,
          state: 'pending', observedAt: expect.any(String),
        }],
      },
    })
    expect(receipt.snapshot.actions).toEqual([{ ...action, status: 'superseded' }])
    expect(receipt.snapshot.attempts).toEqual(withAction.attempts)
    expect(receipt.snapshot.runs).toEqual(withAction.runs)
    expect(receipt.snapshot.artifacts).toEqual(withAction.artifacts)
  })

  it('cancels a recorded dispatch before claim and makes later claim a no-op', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const request: WorkTaskExecuteRequest = {
      requestId: 'dispatch-unclaimed', taskId: created.task.id, expectedRevision: created.task.revision,
      executor: { kind: 'employee', employeeId: 'writer' }, mode: 'initial', input: null,
    }
    const intent = await store.recordDispatchIntent(request)

    const cancelled = await store.beginTaskCancellation({
      requestId: 'cancel-before-claim', taskId: created.task.id, expectedRevision: intent.snapshot.task.revision,
    })
    const replayedDispatch = await store.recordDispatchIntent(request)
    const claimed = await store.claimDispatch(intent.requestId, intent.commandId)

    expect(cancelled.stage).toBe('cancelled')
    expect(cancelled.snapshot.task).toMatchObject({ status: 'cancelled', activeAttemptId: undefined, cancellation: { state: 'cancelled' } })
    expect(cancelled.snapshot.runs[0]).toMatchObject({
      runId: '', status: 'cancelled', rawStatus: 'cancelled-before-dispatch', capabilities: { cancel: false, resume: false, append: false },
    })
    expect(replayedDispatch).toMatchObject({ stage: 'cancelled', replayed: true })
    expect(claimed).toMatchObject({ stage: 'cancelled' })
  })

  it('freezes a completed Workflow root so asynchronous descendants can be checked', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked, intent } = await addWorkflowRun(store, created.task.id, created.task.revision, 'completed-root')
    const completed = await store.syncRun(created.task.id, linked.snapshot.runs[0]!.runId, {
      status: 'completed', rawStatus: 'completed', capabilities: { cancel: false, resume: false, append: false },
    })

    const cancellation = await store.beginTaskCancellation({
      requestId: 'cancel-completed-root', taskId: created.task.id, expectedRevision: completed!.task.revision,
    })

    expect(cancellation).toMatchObject({
      stage: 'requested',
      snapshot: { task: { status: 'active' }, runs: [expect.objectContaining({ status: 'completed' })] },
    })
    expect(cancellation.snapshot.task.cancellation?.targets).toEqual([
      expect.objectContaining({ commandId: intent.commandId, state: 'pending' }),
    ])
  })

  it('replays a linked dispatch with the current cancellation snapshot', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const linked = await addWorkflowRun(store, created.task.id, created.task.revision, 'linked-replay')
    const cancelled = await store.beginTaskCancellation({
      requestId: 'cancel-linked-replay', taskId: created.task.id, expectedRevision: linked.linked.snapshot.task.revision,
    })

    const replay = await store.recordDispatchIntent(linked.request)

    expect(replay).toMatchObject({ stage: 'linked', replayed: true })
    expect(replay.snapshot.task.cancellation).toEqual(cancelled.snapshot.task.cancellation)
    expect(replay.snapshot.task.revision).toBe(cancelled.snapshot.task.revision)
  })

  it('persists partial target results and gives unknown precedence until every target is stopped', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const first = await addWorkflowRun(store, created.task.id, created.task.revision, 'one')
    const second = await addWorkflowRun(store, created.task.id, first.linked.snapshot.task.revision, 'two')
    const request = { requestId: 'cancel-two', taskId: created.task.id, expectedRevision: second.linked.snapshot.task.revision }
    const begun = await store.beginTaskCancellation(request)
    const firstCommandId = first.intent.commandId
    const secondCommandId = second.intent.commandId

    const processing = await store.updateTaskCancellationTarget(request.requestId, firstCommandId, {
      state: 'cancelling', observedAt: '2026-09-16T10:00:00.000Z',
    })
    const unknown = await store.updateTaskCancellationTarget(request.requestId, secondCommandId, {
      state: 'outcome-unknown', error: 'executor result unavailable', observedAt: '2026-09-16T10:00:01.000Z',
    })
    const secondStopped = await store.updateTaskCancellationTarget(request.requestId, secondCommandId, {
      state: 'cancelled', finalRunStatus: 'cancelled', observedAt: '2026-09-16T10:00:02.000Z',
    })
    const completed = await store.updateTaskCancellationTarget(request.requestId, firstCommandId, {
      state: 'settled', finalRunStatus: 'completed', observedAt: '2026-09-16T10:00:03.000Z',
    })

    expect(begun.stage).toBe('requested')
    expect(processing.stage).toBe('cancelling')
    expect(unknown.stage).toBe('outcome-unknown')
    expect(secondStopped.stage).toBe('cancelling')
    expect(completed).toMatchObject({ stage: 'cancelled', snapshot: { task: { status: 'cancelled', cancellation: { state: 'cancelled' } } } })

    const replay = await store.beginTaskCancellation(request)
    const current = await store.getTaskCancellation(request.requestId)
    expect(replay.replayed).toBe(true)
    expect(replay.snapshot).toEqual(completed.snapshot)
    expect(current?.snapshot).toEqual(completed.snapshot)
  })

  it('does not revise, persist, or emit for a semantically identical executor observation', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked, intent } = await addWorkflowRun(store, created.task.id, created.task.revision, 'stable')
    const requestId = 'cancel-stable'
    await store.beginTaskCancellation({ requestId, taskId: created.task.id, expectedRevision: linked.snapshot.task.revision })
    const changed = vi.fn()
    store.onChanged(changed)
    const first = await store.updateTaskCancellationTarget(requestId, intent.commandId, {
      state: 'cancelling', observedAt: '2026-09-16T10:00:00.000Z',
    })
    const second = await store.updateTaskCancellationTarget(requestId, intent.commandId, {
      state: 'cancelling', observedAt: '2026-09-16T10:01:00.000Z',
    })

    expect(second.replayed).toBe(true)
    expect(second.snapshot.task.revision).toBe(first.snapshot.task.revision)
    expect(second.snapshot.task.cancellation?.targets[0]?.observedAt).toBe('2026-09-16T10:00:00.000Z')
    expect(changed).toHaveBeenCalledTimes(1)

    const unknown = await store.updateTaskCancellationTarget(requestId, intent.commandId, {
      state: 'outcome-unknown', error: 'executor unavailable', observedAt: '2026-09-16T10:02:00.000Z',
    })
    const repeatedUnknown = await store.updateTaskCancellationTarget(requestId, intent.commandId, {
      state: 'outcome-unknown', error: 'executor unavailable', observedAt: '2026-09-16T10:03:00.000Z',
    })
    expect(repeatedUnknown.replayed).toBe(true)
    expect(repeatedUnknown.snapshot.task.revision).toBe(unknown.snapshot.task.revision)
    expect(repeatedUnknown.snapshot.task.cancellation?.targets[0]?.observedAt).toBe('2026-09-16T10:02:00.000Z')
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('keeps a non-final cancellation projection when an executor observer still reports running', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked, intent } = await addWorkflowRun(store, created.task.id, created.task.revision, 'sync-fence')
    const requestId = 'cancel-sync-fence'
    await store.beginTaskCancellation({ requestId, taskId: created.task.id, expectedRevision: linked.snapshot.task.revision })
    const cancelling = await store.updateTaskCancellationTarget(requestId, intent.commandId, {
      state: 'cancelling', observedAt: '2026-09-16T10:00:00.000Z',
    })

    const projected = await store.syncRun(created.task.id, cancelling.snapshot.runs[0]!.runId, {
      status: 'running', rawStatus: 'running', capabilities: { cancel: true, resume: false, append: false },
    })

    expect(projected?.task.revision).toBe(cancelling.snapshot.task.revision)
    expect(projected?.runs[0]).toMatchObject({
      status: 'cancelling', rawStatus: 'task-cancellation:cancelling', capabilities: { cancel: false },
    })
  })

  it.each([
    { state: 'settled', finalRunStatus: 'running', observedAt: '2026-09-16T10:00:00.000Z' },
    { state: 'cancelled', finalRunStatus: 'completed', observedAt: '2026-09-16T10:00:00.000Z' },
    { state: 'outcome-unknown', observedAt: '2026-09-16T10:00:00.000Z' },
    { state: 'pending', finalRunStatus: 'cancelled', observedAt: '2026-09-16T10:00:00.000Z' },
  ] as const)('rejects a semantically invalid cancellation target update %#', async (update) => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked, intent } = await addWorkflowRun(store, created.task.id, created.task.revision, 'invalid-update')
    await store.beginTaskCancellation({
      requestId: 'cancel-invalid-update', taskId: created.task.id, expectedRevision: linked.snapshot.task.revision,
    })

    await expect(store.updateTaskCancellationTarget('cancel-invalid-update', intent.commandId, update))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })

  it('immediately cancels a task with no runs and replays the current snapshot', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const request = { requestId: 'cancel-empty', taskId: created.task.id, expectedRevision: created.task.revision }

    const cancelled = await store.beginTaskCancellation(request)
    const replay = await store.beginTaskCancellation(request)

    expect(cancelled).toMatchObject({ stage: 'cancelled', snapshot: { task: { status: 'cancelled', cancellation: { state: 'cancelled', targets: [] } } } })
    expect(replay).toMatchObject({ stage: 'cancelled', replayed: true })
    expect(replay.snapshot).toEqual(cancelled.snapshot)
  })

  it('blocks conflicting business mutations after cancellation begins', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked } = await addWorkflowRun(store, created.task.id, created.task.revision, 'barrier')
    const run = linked.snapshot.runs[0]!
    const action: WorkAction = {
      id: 'approval-barrier', taskId: created.task.id, runId: run.runId, sourceEventId: 'event-barrier',
      requirementVersion: run.requirementVersion, kind: 'approval', status: 'open', nodeId: 'approval-node',
    }
    const withAction = await store.syncWorkflowActions(created.task.id, run.runId, [action])
    const priorControl = {
      requestId: 'control-before-cancel', taskId: created.task.id, expectedRevision: withAction.task.revision,
      runId: run.runId, action: 'cancel' as const,
    }
    const priorAnswer = {
      requestId: 'answer-before-cancel', taskId: created.task.id, actionId: action.id,
      expectedSourceEventId: action.sourceEventId, expectedRequirementVersion: action.requirementVersion, answer: true,
    }
    await store.beginRunControl(priorControl)
    await store.beginActionAnswer(priorAnswer)
    const begun = await store.beginTaskCancellation({
      requestId: 'cancel-barrier', taskId: created.task.id, expectedRevision: withAction.task.revision,
    })
    const revision = begun.snapshot.task.revision

    const expectBarrier = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toMatchObject({ code: 'TASK_CANCELLATION_CONFLICT' })
    }
    await expectBarrier(store.revise({
      requestId: 'revise-after-cancel', taskId: created.task.id, expectedRevision: revision,
      goal: 'Changed', acceptance: 'Changed',
    }))
    await expectBarrier(store.recordDispatchIntent({
      requestId: 'dispatch-after-cancel', taskId: created.task.id, expectedRevision: revision,
      executor: { kind: 'employee', employeeId: 'writer' }, mode: 'initial', input: null,
    }))
    await expectBarrier(store.beginRunControl({
      requestId: 'resume-after-cancel', taskId: created.task.id, expectedRevision: revision,
      runId: run.runId, action: 'cancel',
    }))
    await expectBarrier(store.archive({
      requestId: 'archive-after-cancel', taskId: created.task.id, expectedRevision: revision, archived: true,
    }))
    await expectBarrier(store.beginRunControl(priorControl))
    await expectBarrier(store.beginActionAnswer(priorAnswer))
  })

  it('keeps a final cancellation projection when an earlier run-control response arrives late', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const { linked, intent } = await addWorkflowRun(store, created.task.id, created.task.revision, 'late-control')
    const paused = await store.syncRun(created.task.id, linked.snapshot.runs[0]!.runId, {
      status: 'paused', rawStatus: 'paused', capabilities: { cancel: true, resume: true, append: false },
    })
    const request = {
      requestId: 'resume-before-task-cancel', taskId: created.task.id, expectedRevision: paused!.task.revision,
      runId: linked.snapshot.runs[0]!.runId, action: 'resume' as const,
    }
    await store.beginRunControl(request)
    const begun = await store.beginTaskCancellation({
      requestId: 'cancel-during-resume', taskId: created.task.id, expectedRevision: paused!.task.revision,
    })
    await store.updateTaskCancellationTarget(begun.requestId, intent.commandId, {
      state: 'cancelled', finalRunStatus: 'cancelled', observedAt: '2026-09-16T10:00:00.000Z',
    })

    const late = await store.completeRunControl(request, {
      status: 'queued', rawStatus: 'queued-after-resume', capabilities: { cancel: true, resume: false, append: false },
    })

    expect(late.snapshot.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
    expect(late.snapshot.runs[0]).toMatchObject({ status: 'cancelled', rawStatus: 'task-cancellation:cancelled' })
  })

  it('rejects stale cancellation revisions and request id reuse', async () => {
    const store = await createStore()
    const created = await createTask(store)
    await expect(store.beginTaskCancellation({
      requestId: 'cancel-stale', taskId: created.task.id, expectedRevision: created.task.revision + 1,
    })).rejects.toBeInstanceOf(WorkItemStoreConflictError)

    await store.beginTaskCancellation({
      requestId: 'cancel-once', taskId: created.task.id, expectedRevision: created.task.revision,
    })
    await expect(store.beginTaskCancellation({
      requestId: 'cancel-once', taskId: 'another-task', expectedRevision: created.task.revision,
    })).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' })
  })

  it('keeps accepted completed work immutable instead of relabelling it cancelled', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const state = (store as unknown as { state: { tasks: Record<string, any> } }).state
    state.tasks[created.task.id].task.status = 'completed'

    await expect(store.beginTaskCancellation({
      requestId: 'cancel-completed', taskId: created.task.id, expectedRevision: created.task.revision,
    })).rejects.toMatchObject({ code: 'TASK_CANCELLATION_CONFLICT' })
  })

  it('does not replay an earlier business mutation after task cancellation', async () => {
    const store = await createStore()
    const created = await createTask(store)
    const revisionRequest = {
      requestId: 'revise-before-cancel', taskId: created.task.id, expectedRevision: created.task.revision,
      goal: 'Revised goal', acceptance: 'Revised acceptance',
    }
    const revised = await store.revise(revisionRequest)
    await store.beginTaskCancellation({
      requestId: 'cancel-after-revise', taskId: created.task.id, expectedRevision: revised.snapshot.task.revision,
    })

    await expect(store.revise(revisionRequest)).rejects.toMatchObject({ code: 'TASK_CANCELLATION_CONFLICT' })
  })

  it('reopens the current partial cancellation and replays its original request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-cancel-reopen-'))
    directories.push(directory)
    const firstStore = new WorkItemStore(directory)
    await firstStore.initialize()
    const created = await createTask(firstStore, 'create-reopen')
    const { linked, intent } = await addWorkflowRun(firstStore, created.task.id, created.task.revision, 'reopen')
    const request = { requestId: 'cancel-reopen', taskId: created.task.id, expectedRevision: linked.snapshot.task.revision }
    await firstStore.beginTaskCancellation(request)
    const partial = await firstStore.updateTaskCancellationTarget(request.requestId, intent.commandId, {
      state: 'outcome-unknown', error: 'runtime response was lost', observedAt: '2026-09-16T10:00:00.000Z',
    })

    const reopened = new WorkItemStore(directory)
    await reopened.initialize()
    const recovered = await reopened.getTaskCancellation(request.requestId)
    const replay = await reopened.beginTaskCancellation(request)

    expect(recovered?.snapshot).toEqual(partial.snapshot)
    expect(replay).toMatchObject({ stage: 'outcome-unknown', replayed: true })
    expect(replay.snapshot).toEqual(partial.snapshot)
  })

  it('rejects malformed persisted cancellation target data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-cancel-invalid-'))
    directories.push(directory)
    const firstStore = new WorkItemStore(directory)
    await firstStore.initialize()
    const created = await createTask(firstStore, 'create-invalid')
    const { linked } = await addWorkflowRun(firstStore, created.task.id, created.task.revision, 'invalid')
    await firstStore.beginTaskCancellation({
      requestId: 'cancel-invalid', taskId: created.task.id, expectedRevision: linked.snapshot.task.revision,
    })
    const statePath = join(directory, 'work-items.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as any
    state.tasks[created.task.id].task.cancellation.targets[0].error = 42
    state.requests['cancel-invalid'].receipt.snapshot.task.cancellation.targets[0].error = 42
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const reopened = new WorkItemStore(directory)
    await expect(reopened.initialize()).rejects.toMatchObject({ code: 'TASK_CANCELLATION_CONFLICT' })
  })
})
