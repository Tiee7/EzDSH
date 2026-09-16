import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkItemCancellationService } from '../../src/main/work-items/work-item-cancellation-service.js'
import { WorkItemStore } from '../../src/main/work-items/work-item-store.js'
import type { EmployeeRunRecord } from '../../src/shared/employee-runs.js'
import type { WorkExecutor, WorkTaskSnapshot } from '../../src/shared/work-items.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function fixture(executors: WorkExecutor[]) {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-task-cancellation-service-'))
  directories.push(directory)
  const store = new WorkItemStore(directory)
  await store.initialize()
  let snapshot = (await store.create({
    requestId: 'create', title: 'Cancel safely', goal: 'Stop every executor', acceptance: 'Every outcome is verified', scope: { resourceRefs: [] },
  })).snapshot
  const runs: Array<{ commandId: string; runId: string; executor: WorkExecutor }> = []
  for (const [index, executor] of executors.entries()) {
    const intent = await store.recordDispatchIntent({
      requestId: `dispatch-${index}`, taskId: snapshot.task.id, expectedRevision: snapshot.task.revision,
      executor, mode: index === 0 ? 'initial' : 'continue-attempt', input: null,
    })
    const runId = `run-${index}`
    snapshot = (await store.linkDispatch(intent.requestId, intent.commandId, {
      runId, status: 'running', rawStatus: 'running', capabilities: { cancel: true, resume: false, append: false },
    })).snapshot
    runs.push({ commandId: intent.commandId, runId, executor })
  }
  return { directory, store, snapshot, runs }
}

function employeeRun(task: WorkTaskSnapshot, commandId: string, runId: string, overrides: Partial<EmployeeRunRecord> = {}): EmployeeRunRecord {
  const reference = task.runs.find((run) => run.commandId === commandId)!
  const now = '2026-09-16T10:00:00.000Z'
  return {
    runId, commandId, requestDigest: 'digest', employeeId: 'employee-1', employeeVersion: 1,
    employeeSnapshot: { schemaVersion: 2, version: 1, id: 'employee-1', name: 'Employee', role: 'Role', description: '', businessBoundary: '', systemPrompt: '', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: now, updatedAt: now },
    task: { taskId: task.task.id, attemptId: reference.attemptId, requirementVersion: reference.requirementVersion },
    context: { cwd: '/tmp' }, taskId: task.task.id, attemptId: reference.attemptId,
    requirementVersion: reference.requirementVersion, cwd: '/tmp', sessionId: `session-${runId}`,
    sessionEvidence: 'created', status: 'running', dispatchStage: 'prompt-in-flight', promptRequestId: `prompt-${runId}`,
    partialOutput: '', output: '', createdAt: now, updatedAt: now, ...overrides,
  }
}

function workflowRun(task: WorkTaskSnapshot, commandId: string, runId: string, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  const reference = task.runs.find((run) => run.commandId === commandId)!
  return {
    id: runId, workflowId: 'workflow-1', workflowRevision: 1, origin: { kind: 'top-level' },
    workTask: { taskId: task.task.id, attemptId: reference.attemptId, requirementVersion: reference.requirementVersion, commandId },
    status: 'running', input: null, nodeStates: [], events: [], allowShellFile: false, debug: false, ...overrides,
  }
}

describe('WorkItemCancellationService', () => {
  it('persists the task intent before requesting cancellation and waits for Employee terminal evidence', async () => {
    const f = await fixture([{ kind: 'employee', employeeId: 'employee-1' }])
    const ref = f.runs[0]!
    let current = employeeRun(f.snapshot, ref.commandId, ref.runId)
    const cancel = vi.fn(async () => {
      expect((await f.store.get(f.snapshot.task.id))?.task.cancellation).toMatchObject({ requestId: 'cancel-task', state: 'requested' })
      current = { ...current, status: 'cancelling', dispatchStage: 'cancel-requested', cancelRequestState: 'accepted' }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => current, findByCommand: async () => current, cancel },
      workflowRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
    })

    const cancelling = await service.cancelTask({ requestId: 'cancel-task', taskId: f.snapshot.task.id, expectedRevision: f.snapshot.task.revision })
    expect(cancelling.task.status).toBe('active')
    expect(cancelling.task.cancellation).toMatchObject({ state: 'cancelling', targets: [{ state: 'cancelling' }] })
    expect(cancel).toHaveBeenCalledTimes(1)

    current = { ...current, status: 'cancelled', dispatchStage: 'cancelled', completedAt: '2026-09-16T10:01:00.000Z' }
    const cancelled = await service.reconcileTask(f.snapshot.task.id)
    expect(cancelled?.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancelled?.runs).toHaveLength(1)
  })

  it('keeps the aggregate outcome unknown when one executor cannot prove it stopped', async () => {
    const f = await fixture([
      { kind: 'employee', employeeId: 'employee-1' },
      { kind: 'workflow', workflowId: 'workflow-1' },
    ])
    const employeeRef = f.runs[0]!
    const workflowRef = f.runs[1]!
    let employee = employeeRun(f.snapshot, employeeRef.commandId, employeeRef.runId)
    const workflow = workflowRun(f.snapshot, workflowRef.commandId, workflowRef.runId)
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: {
        get: async () => employee,
        findByCommand: async () => employee,
        cancel: async () => {
          employee = { ...employee, status: 'cancelling', dispatchStage: 'cancel-requested', cancelRequestState: 'failed', cancelRequestError: 'runtime unavailable' }
          return employee
        },
      },
      workflowRuns: {
        get: async () => workflow,
        findByCommand: async () => workflow,
        cancel: async () => ({ ...workflow, status: 'cancelled', completedAt: '2026-09-16T10:01:00.000Z' }),
      },
    })

    const result = await service.cancelTask({ requestId: 'cancel-mixed', taskId: f.snapshot.task.id, expectedRevision: f.snapshot.task.revision })
    expect(result.task.status).toBe('active')
    expect(result.task.cancellation?.state).toBe('outcome-unknown')
    expect(result.task.cancellation?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ commandId: employeeRef.commandId, state: 'outcome-unknown', error: 'runtime unavailable' }),
      expect.objectContaining({ commandId: workflowRef.commandId, state: 'cancelled' }),
    ]))
    expect(result.attempts).toHaveLength(1)
    expect(result.runs).toHaveLength(2)
  })

  it('reconciles executor-side cancellation evidence after a crash without sending a duplicate cancel', async () => {
    const f = await fixture([{ kind: 'employee', employeeId: 'employee-1' }])
    const ref = f.runs[0]!
    const current = employeeRun(f.snapshot, ref.commandId, ref.runId, {
      status: 'cancelling', dispatchStage: 'cancel-requested', cancelRequestState: 'accepted',
    })
    const cancel = vi.fn()
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => current, findByCommand: async () => current, cancel },
      workflowRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
    })

    const result = await service.cancelTask({ requestId: 'cancel-after-crash', taskId: f.snapshot.task.id, expectedRevision: f.snapshot.task.revision })
    expect(result.task.cancellation?.state).toBe('cancelling')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels an authoritative active Employee run even when the Work Item projection was interrupted', async () => {
    const f = await fixture([{ kind: 'employee', employeeId: 'employee-1' }])
    const ref = f.runs[0]!
    await f.store.syncRun(f.snapshot.task.id, ref.runId, {
      status: 'interrupted', rawStatus: 'outcome-unknown:link-lost', capabilities: { cancel: false, resume: false, append: false },
    })
    let current = employeeRun(f.snapshot, ref.commandId, ref.runId)
    const cancel = vi.fn(async () => {
      current = { ...current, status: 'cancelled', dispatchStage: 'cancelled', completedAt: '2026-09-16T10:02:00.000Z' }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => current, findByCommand: async () => current, cancel },
      workflowRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
    })
    const before = await f.store.get(f.snapshot.task.id)

    const result = await service.cancelTask({ requestId: 'cancel-interrupted', taskId: f.snapshot.task.id, expectedRevision: before!.task.revision })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
  })

  it('requires a paused Workflow to enter a durable cancelled state before cancelling the task', async () => {
    const f = await fixture([{ kind: 'workflow', workflowId: 'workflow-1' }])
    const ref = f.runs[0]!
    let current = workflowRun(f.snapshot, ref.commandId, ref.runId, { status: 'paused' })
    const cancel = vi.fn(async () => {
      current = { ...current, status: 'cancelled', completedAt: '2026-09-16T10:02:00.000Z' }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
      workflowRuns: { get: async () => current, findByCommand: async () => current, cancel },
    })

    const result = await service.cancelTask({ requestId: 'cancel-paused', taskId: f.snapshot.task.id, expectedRevision: f.snapshot.task.revision })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
  })

  it('waits for an asynchronous child tree even when the top-level Workflow already completed', async () => {
    const f = await fixture([{ kind: 'workflow', workflowId: 'workflow-1' }])
    const ref = f.runs[0]!
    const completedProjection = await f.store.syncRun(f.snapshot.task.id, ref.runId, {
      status: 'completed', rawStatus: 'completed', capabilities: { cancel: false, resume: false, append: false },
    })
    let current = workflowRun(f.snapshot, ref.commandId, ref.runId, { status: 'completed' })
    const cancel = vi.fn(async () => {
      current = {
        ...current,
        workTaskCancellation: {
          requestId: `work-task:${f.snapshot.task.id}:${ref.commandId}`,
          requestedAt: '2026-09-16T10:00:00.000Z', updatedAt: '2026-09-16T10:00:00.000Z', state: 'cancelling',
          targets: [
            { runId: ref.runId, state: 'settled', finalRunStatus: 'completed', observedAt: '2026-09-16T10:00:00.000Z' },
            { runId: 'async-child', parentRunId: ref.runId, state: 'cancelling', observedAt: '2026-09-16T10:00:00.000Z' },
          ],
        },
      }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
      workflowRuns: { get: async () => current, findByCommand: async () => current, cancel },
    })

    const cancelling = await service.cancelTask({
      requestId: 'cancel-completed-workflow-tree', taskId: f.snapshot.task.id, expectedRevision: completedProjection!.task.revision,
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancelling.task.cancellation).toMatchObject({ state: 'cancelling', targets: [{ state: 'cancelling' }] })

    current = {
      ...current,
      workTaskCancellation: {
        ...current.workTaskCancellation!, state: 'cancelled', updatedAt: '2026-09-16T10:01:00.000Z',
        targets: [
          { runId: ref.runId, state: 'settled', finalRunStatus: 'completed', observedAt: '2026-09-16T10:01:00.000Z' },
          { runId: 'async-child', parentRunId: ref.runId, state: 'cancelled', finalRunStatus: 'cancelled', observedAt: '2026-09-16T10:01:00.000Z' },
        ],
      },
    }
    const cancelled = await service.reconcileTask(f.snapshot.task.id)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancelled?.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
    expect(cancelled?.runs[0]).toMatchObject({ status: 'completed', rawStatus: 'task-cancellation:completed' })
  })

  it('terminalizes a Workflow that pauses behind an already durable task-cancellation fence', async () => {
    const f = await fixture([{ kind: 'workflow', workflowId: 'workflow-1' }])
    const ref = f.runs[0]!
    const requestedAt = '2026-09-16T10:01:00.000Z'
    let current = workflowRun(f.snapshot, ref.commandId, ref.runId)
    const cancel = vi.fn(async () => {
      if (current.status === 'running') {
        current = { ...current, queue: { enqueuedAt: requestedAt, availableAt: requestedAt, cancellationRequestedAt: requestedAt } }
      } else {
        current = { ...current, status: 'cancelled', completedAt: '2026-09-16T10:02:00.000Z' }
      }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
      workflowRuns: { get: async () => current, findByCommand: async () => current, cancel },
    })

    const cancelling = await service.cancelTask({ requestId: 'cancel-pausing-workflow', taskId: f.snapshot.task.id, expectedRevision: f.snapshot.task.revision })
    expect(cancelling.task.cancellation?.state).toBe('cancelling')
    current = { ...current, status: 'paused', nodeStates: [{ nodeId: 'write', status: 'pending', effectState: 'unknown' }] }
    const cancelled = await service.reconcileTask(f.snapshot.task.id)

    expect(cancel).toHaveBeenCalledTimes(2)
    expect(cancelled?.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
  })

  it('cancels a failed recoverable Workflow so task cancellation cannot be bypassed by resume', async () => {
    const f = await fixture([{ kind: 'workflow', workflowId: 'workflow-1' }])
    const ref = f.runs[0]!
    await f.store.syncRun(f.snapshot.task.id, ref.runId, {
      status: 'failed', rawStatus: 'failed', capabilities: { cancel: false, resume: true, append: false },
    })
    let current = workflowRun(f.snapshot, ref.commandId, ref.runId, { status: 'failed', error: 'retryable failure' })
    const cancel = vi.fn(async () => {
      current = { ...current, status: 'cancelled', completedAt: '2026-09-16T10:02:00.000Z' }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: f.store,
      employeeRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
      workflowRuns: { get: async () => current, findByCommand: async () => current, cancel },
    })
    const before = await f.store.get(f.snapshot.task.id)

    const result = await service.cancelTask({ requestId: 'cancel-failed-workflow', taskId: f.snapshot.task.id, expectedRevision: before!.task.revision })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
    expect(result.runs[0]).toMatchObject({ status: 'cancelled', capabilities: { resume: false } })
  })

  it('cancels a dispatch that links after the first cancellation check could not find it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-task-cancellation-late-link-'))
    directories.push(directory)
    const store = new WorkItemStore(directory)
    await store.initialize()
    const created = await store.create({
      requestId: 'create-late', title: 'Late link', goal: 'Stop the late run', acceptance: 'Cancellation is confirmed', scope: { resourceRefs: [] },
    })
    const intent = await store.recordDispatchIntent({
      requestId: 'dispatch-late', taskId: created.task.id, expectedRevision: created.task.revision,
      executor: { kind: 'employee', employeeId: 'employee-1' }, mode: 'initial', input: null,
    })
    await store.claimDispatch(intent.requestId, intent.commandId)
    let current: EmployeeRunRecord | undefined
    const cancel = vi.fn(async () => {
      current = { ...current!, status: 'cancelled', dispatchStage: 'cancelled', completedAt: '2026-09-16T10:03:00.000Z' }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: store,
      employeeRuns: { get: async () => current, findByCommand: async () => current, cancel },
      workflowRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
    })

    const unknown = await service.cancelTask({
      requestId: 'cancel-late', taskId: created.task.id, expectedRevision: intent.snapshot.task.revision,
    })
    expect(unknown.task.cancellation?.state).toBe('outcome-unknown')

    current = employeeRun(unknown, intent.commandId, 'late-run')
    await store.linkDispatch(intent.requestId, intent.commandId, {
      runId: current.runId, status: 'running', rawStatus: 'running', capabilities: { cancel: true, resume: false, append: false },
    })
    const cancelled = await service.reconcileTask(created.task.id)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancelled?.task).toMatchObject({ status: 'cancelled', cancellation: { state: 'cancelled' } })
    expect(cancelled?.runs[0]).toMatchObject({ runId: 'late-run' })
  })

  it('recovers the durable run link by command when cancellation finds an executor created before a crash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-task-cancellation-crash-link-'))
    directories.push(directory)
    const store = new WorkItemStore(directory)
    await store.initialize()
    const created = await store.create({
      requestId: 'create-crash-link', title: 'Crash link', goal: 'Recover the executor', acceptance: 'History has the real run id', scope: { resourceRefs: [] },
    })
    const request = {
      requestId: 'dispatch-crash-link', taskId: created.task.id, expectedRevision: created.task.revision,
      executor: { kind: 'employee' as const, employeeId: 'employee-1' }, mode: 'initial' as const, input: null,
    }
    const intent = await store.recordDispatchIntent(request)
    const claimed = await store.claimDispatch(intent.requestId, intent.commandId)
    let current = employeeRun(claimed.snapshot, intent.commandId, 'executor-created-before-crash')
    const cancel = vi.fn(async () => {
      current = { ...current, status: 'cancelled', dispatchStage: 'cancelled', completedAt: '2026-09-16T10:04:00.000Z' }
      return current
    })
    const service = new WorkItemCancellationService({
      workItems: store,
      employeeRuns: { get: async () => current, findByCommand: async () => current, cancel },
      workflowRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
    })

    const cancelled = await service.cancelTask({
      requestId: 'cancel-crash-link', taskId: created.task.id, expectedRevision: claimed.snapshot.task.revision,
    })
    const dispatch = await store.recordDispatchIntent(request)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancelled.runs[0]).toMatchObject({
      runId: 'executor-created-before-crash', status: 'cancelled', rawStatus: 'task-cancellation:cancelled',
    })
    expect(dispatch).toMatchObject({ stage: 'linked', runId: 'executor-created-before-crash' })
  })

  it('recovers the durable run link even when the first executor cancellation call throws', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-task-cancellation-crash-link-error-'))
    directories.push(directory)
    const store = new WorkItemStore(directory)
    await store.initialize()
    const created = await store.create({
      requestId: 'create-crash-link-error', title: 'Crash link error', goal: 'Recover the executor identity', acceptance: 'Unknown result keeps the real run id', scope: { resourceRefs: [] },
    })
    const request = {
      requestId: 'dispatch-crash-link-error', taskId: created.task.id, expectedRevision: created.task.revision,
      executor: { kind: 'employee' as const, employeeId: 'employee-1' }, mode: 'initial' as const, input: null,
    }
    const intent = await store.recordDispatchIntent(request)
    const claimed = await store.claimDispatch(intent.requestId, intent.commandId)
    const current = employeeRun(claimed.snapshot, intent.commandId, 'executor-found-before-cancel-error')
    const service = new WorkItemCancellationService({
      workItems: store,
      employeeRuns: {
        get: async () => current,
        findByCommand: async () => current,
        cancel: vi.fn(async () => { throw new Error('runtime response lost') }),
      },
      workflowRuns: { get: async () => undefined, findByCommand: async () => undefined, cancel: vi.fn() },
    })

    const unknown = await service.cancelTask({
      requestId: 'cancel-crash-link-error', taskId: created.task.id, expectedRevision: claimed.snapshot.task.revision,
    })
    const dispatch = await store.recordDispatchIntent(request)

    expect(unknown.task.cancellation).toMatchObject({ state: 'outcome-unknown', targets: [{ runId: current.runId, state: 'outcome-unknown' }] })
    expect(unknown.runs[0]).toMatchObject({ runId: current.runId })
    expect(dispatch).toMatchObject({ stage: 'linked', runId: current.runId })
  })
})
