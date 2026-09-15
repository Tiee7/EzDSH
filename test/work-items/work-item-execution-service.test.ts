import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkItemExecutionService } from '../../src/main/work-items/work-item-execution-service.js'
import { WorkItemService } from '../../src/main/work-items/work-item-service.js'
import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store.js'
import type { EmployeeRunRecord, EmployeeRunStartRequest } from '../../src/shared/employee-runs.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ezdsh-work-execution-'))
  directories.push(value)
  return value
}

function employeeRun(request: EmployeeRunStartRequest, runId = `employee-${request.commandId}`): EmployeeRunRecord {
  const now = new Date().toISOString()
  return {
    runId,
    commandId: request.commandId,
    requestDigest: 'synthetic',
    employeeId: request.employeeId,
    employeeVersion: 3,
    employeeSnapshot: { schemaVersion: 2, version: 3, id: request.employeeId, name: '研究员', role: '研究', description: '', businessBoundary: '', systemPrompt: '', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: now, updatedAt: now },
    task: request.task,
    context: request.context,
    taskId: request.task.taskId,
    attemptId: request.task.attemptId,
    requirementVersion: request.task.requirementVersion,
    sourceRunId: request.task.sourceRunId,
    projectId: request.context.projectId,
    cwd: request.context.cwd,
    sessionId: `session-${request.commandId}`,
    sessionEvidence: 'created',
    status: 'queued',
    dispatchStage: 'recorded',
    promptRequestId: `prompt-${request.commandId}`,
    partialOutput: '',
    output: '',
    createdAt: now,
    updatedAt: now,
  }
}

function workflowRun(commandId: string, workflowId = 'workflow-1', runId = `workflow-${commandId}`): WorkflowRunRecord {
  return {
    id: runId,
    workflowId,
    workflowRevision: 4,
    idempotencyKey: commandId,
    origin: { kind: 'top-level' },
    status: 'queued',
    input: null,
    nodeStates: [],
    events: [],
    allowShellFile: false,
    debug: false,
  }
}

async function fixture(options: { store?: WorkItemStore } = {}) {
  const stateDirectory = await directory()
  const store = options.store ?? new WorkItemStore(stateDirectory)
  const workItems = new WorkItemService(store)
  await workItems.initialize()
  const employeeRecords: EmployeeRunRecord[] = []
  const workflowRecords: WorkflowRunRecord[] = []
  const employeeRuns = {
    start: vi.fn(async (request: EmployeeRunStartRequest) => {
      const run = employeeRun(request)
      employeeRecords.push(run)
      return { run, replayed: false }
    }),
    list: vi.fn(async () => structuredClone(employeeRecords)),
  }
  const workflowBridge = {
    start: vi.fn(async (request: { commandId: string; workflowId: string }) => {
      const run = workflowRun(request.commandId, request.workflowId)
      workflowRecords.push(run)
      return run
    }),
    findByCommand: vi.fn(async (commandId: string) => workflowRecords.find((run) => run.idempotencyKey === commandId)),
  }
  const execution = new WorkItemExecutionService({ workItems, employeeRuns, workflowBridge, defaultCwd: '/trusted/default' })
  const task = await workItems.create({ requestId: 'create-1', title: '竞品简报', goal: '核实三项变化', acceptance: '附来源', scope: { projectId: 'project-1', resourceRefs: [] } })
  return { stateDirectory, store, workItems, employeeRuns, employeeRecords, workflowBridge, workflowRecords, execution, task }
}

describe('WorkItemExecutionService', () => {
  it.each(['employee', 'workflow'] as const)('claims a reopened recorded %s intent and starts it exactly once', async (kind) => {
    const stateDirectory = await directory()
    const firstItems = new WorkItemService(new WorkItemStore(stateDirectory))
    await firstItems.initialize()
    const task = await firstItems.create({ requestId: `create-${kind}`, title: 'Task', goal: 'Goal', acceptance: 'Done', scope: { resourceRefs: [] } })
    const request = {
      requestId: `run-${kind}`,
      taskId: task.task.id,
      expectedRevision: 1,
      executor: kind === 'employee'
        ? { kind: 'employee' as const, employeeId: 'researcher' }
        : { kind: 'workflow' as const, workflowId: 'workflow-1' },
      mode: 'initial' as const,
      input: null,
    }
    const recorded = await firstItems.recordDispatchIntent(request)
    expect(recorded.stage).toBe('recorded')

    const reopenedItems = new WorkItemService(new WorkItemStore(stateDirectory))
    await reopenedItems.initialize()
    const employeeRuns = {
      start: vi.fn(async (input: EmployeeRunStartRequest) => ({ run: employeeRun(input, 'real-employee-run'), replayed: false })),
      list: vi.fn(async () => [] as EmployeeRunRecord[]),
    }
    const workflowBridge = {
      start: vi.fn(async (input: { commandId: string; workflowId: string }) => workflowRun(input.commandId, input.workflowId, 'real-workflow-run')),
      findByCommand: vi.fn(async () => undefined),
    }
    const execution = new WorkItemExecutionService({ workItems: reopenedItems, employeeRuns, workflowBridge, defaultCwd: '/trusted/default' })

    const snapshot = await execution.execute(request)

    expect(kind === 'employee' ? employeeRuns.start : workflowBridge.start).toHaveBeenCalledTimes(1)
    expect(snapshot.runs[0]).toMatchObject({
      commandId: recorded.commandId,
      runId: kind === 'employee' ? 'real-employee-run' : 'real-workflow-run',
      rawStatus: 'queued',
    })
  })

  it('executes only an explicitly selected existing task and never calls create', async () => {
    const f = await fixture()
    const create = vi.spyOn(f.workItems, 'create')

    const snapshot = await f.execution.execute({ requestId: 'run-1', taskId: f.task.task.id, expectedRevision: 1, executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: { query: 'changes' } })

    expect(create).not.toHaveBeenCalled()
    expect(f.employeeRuns.start).toHaveBeenCalledOnce()
    expect(snapshot.runs[0]).toMatchObject({ runId: expect.stringMatching(/^employee-/), commandId: expect.any(String), rawStatus: 'queued', taskId: f.task.task.id })
    expect(f.employeeRuns.start).toHaveBeenCalledWith(expect.objectContaining({
      commandId: snapshot.runs[0]?.commandId,
      task: expect.objectContaining({ taskId: f.task.task.id, attemptId: snapshot.task.activeAttemptId, requirementVersion: 1 }),
      context: { cwd: '/trusted/default', projectId: 'project-1' },
    }))
  })

  it('resolves the selected employee method and trusted session at the Main boundary', async () => {
    const f = await fixture()
    const methods = {
      snapshot: vi.fn(async (employeeId: string, methodId: string) => ({
        schemaVersion: 1 as const,
        id: methodId,
        employeeId,
        name: '研究流程',
        description: '固定研究步骤',
        workflowId: 'workflow-method',
        workflowRevision: 7,
        version: 3,
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      })),
    }
    const execution = new WorkItemExecutionService({ workItems: f.workItems, employeeRuns: f.employeeRuns, workflowBridge: f.workflowBridge, employeeMethods: methods, defaultCwd: '/trusted/default' })

    const snapshot = await execution.execute({
      requestId: 'method-run', taskId: f.task.task.id, expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher', methodId: 'method-1', methodVersion: 3 }, mode: 'initial',
      input: { task: '核实变化', projectId: 'project-1', sessionId: 'session-selected', methodId: 'method-1' },
    })

    expect(methods.snapshot).toHaveBeenCalledWith('researcher', 'method-1')
    expect(snapshot.attempts[0]?.responsibility).toEqual({ kind: 'employee', employeeId: 'researcher', methodId: 'method-1', methodVersion: 3 })
    expect(snapshot.runs[0]?.executor).toEqual({ kind: 'employee', employeeId: 'researcher', methodId: 'method-1', methodVersion: 3 })
    expect(f.employeeRuns.start).not.toHaveBeenCalled()
    expect(f.workflowBridge.start).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'workflow-method', workflowRevision: 7,
      input: { task: '核实变化', projectId: 'project-1', sessionId: 'session-selected', methodId: 'method-1' },
    }))
  })

  it('replays one request without invoking the executor twice and rejects changed content', async () => {
    const f = await fixture()
    const request = { requestId: 'run-1', taskId: f.task.task.id, expectedRevision: 1, executor: { kind: 'employee' as const, employeeId: 'researcher' }, mode: 'initial' as const, input: { query: 'changes' } }

    const first = await f.execution.execute(request)
    const replay = await f.execution.execute(request)

    expect(replay).toEqual(first)
    expect(f.employeeRuns.start).toHaveBeenCalledTimes(1)
    await expect(f.execution.execute({ ...request, input: { query: 'different' } })).rejects.toBeInstanceOf(WorkItemStoreConflictError)
  })

  it('serializes concurrent requests by the normalized request id', async () => {
    const f = await fixture()
    const request = { requestId: 'same', taskId: f.task.task.id, expectedRevision: 1, executor: { kind: 'employee' as const, employeeId: 'researcher' }, mode: 'initial' as const, input: null }

    const [first, replay] = await Promise.all([
      f.execution.execute(request),
      f.execution.execute({ ...request, requestId: ' same ' }),
    ])

    expect(replay).toEqual(first)
    expect(f.employeeRuns.start).toHaveBeenCalledTimes(1)
  })

  it('passes normalized workflow and source run ids through the executor bridge and durable link', async () => {
    const f = await fixture()

    const snapshot = await f.execution.execute({
      requestId: ' workflow-request ',
      taskId: ` ${f.task.task.id} `,
      expectedRevision: 1,
      executor: { kind: 'workflow', workflowId: ' workflow-1 ' },
      mode: 'initial',
      input: null,
      sourceRunId: ' source-run ',
    })

    expect(f.workflowBridge.start).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'workflow-1',
      sourceRunId: 'source-run',
    }))
    expect(snapshot.runs[0]).toMatchObject({
      sourceRunId: 'source-run',
      executor: { kind: 'workflow', workflowId: 'workflow-1' },
    })
  })

  it('serializes concurrent replay and never restarts an unknown command', async () => {
    const f = await fixture()
    const request = { requestId: 'run-1', taskId: f.task.task.id, expectedRevision: 1, executor: { kind: 'employee' as const, employeeId: 'researcher' }, mode: 'initial' as const, input: null }
    const concurrent = await Promise.all([f.execution.execute(request), f.execution.execute(request)])
    expect(concurrent[1]).toEqual(concurrent[0])
    expect(f.employeeRuns.start).toHaveBeenCalledTimes(1)

    const failed = await fixture()
    failed.employeeRuns.start.mockRejectedValueOnce(new Error('submission disconnected'))
    const failedRequest = { ...request, taskId: failed.task.task.id }
    await expect(failed.execution.execute(failedRequest)).rejects.toThrow('submission disconnected')
    const replay = await failed.execution.execute(failedRequest)
    expect(failed.employeeRuns.start).toHaveBeenCalledTimes(1)
    expect(replay.runs[0]).toMatchObject({ status: 'interrupted', rawStatus: 'outcome-unknown:executor-run-not-found', runId: '' })
  })

  it('recovers a run created before business linking by querying the stable command only', async () => {
    const stateDirectory = await directory()
    let replacements = 0
    const failingStore = new WorkItemStore(stateDirectory, {
      rename: async (from, to) => {
        replacements += 1
        if (replacements === 4) throw new Error('simulated link interruption')
        await rename(from, to)
      },
    })
    const first = await fixture({ store: failingStore })
    const request = { requestId: 'run-1', taskId: first.task.task.id, expectedRevision: 1, executor: { kind: 'employee' as const, employeeId: 'researcher' }, mode: 'initial' as const, input: null }
    await expect(first.execution.execute(request)).rejects.toThrow('simulated link interruption')
    expect(first.employeeRuns.start).toHaveBeenCalledTimes(1)

    const reopenedItems = new WorkItemService(new WorkItemStore(stateDirectory))
    await reopenedItems.initialize()
    const recovered = new WorkItemExecutionService({ workItems: reopenedItems, employeeRuns: first.employeeRuns, workflowBridge: first.workflowBridge, defaultCwd: '/trusted/default' })
    const snapshot = await recovered.execute(request)

    expect(first.employeeRuns.start).toHaveBeenCalledTimes(1)
    expect(first.employeeRuns.list).toHaveBeenCalled()
    expect(snapshot.runs[0]).toMatchObject({ runId: first.employeeRecords[0]?.runId, rawStatus: 'queued' })
  })

  it('keeps employee and workflow runs on one attempt, while redo creates a new attempt and run', async () => {
    const f = await fixture()
    const employee = await f.execution.execute({ requestId: 'employee', taskId: f.task.task.id, expectedRevision: 1, executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: null })
    const workflow = await f.execution.execute({ requestId: 'workflow', taskId: f.task.task.id, expectedRevision: 2, executor: { kind: 'workflow', workflowId: 'workflow-1' }, mode: 'continue-attempt', input: null, sourceRunId: employee.runs[0]?.runId })
    const redo = await f.execution.execute({ requestId: 'redo', taskId: f.task.task.id, expectedRevision: 3, executor: { kind: 'workflow', workflowId: 'workflow-1' }, mode: 'redo', input: null, sourceRunId: workflow.runs[1]?.runId })

    expect(workflow.attempts).toHaveLength(1)
    expect(workflow.runs.map((run) => run.executor.kind)).toEqual(['employee', 'workflow'])
    expect(workflow.runs[1]?.attemptId).toBe(workflow.runs[0]?.attemptId)
    expect(redo.attempts).toHaveLength(2)
    expect(redo.runs[2]?.attemptId).not.toBe(redo.runs[1]?.attemptId)
    expect(redo.runs[2]?.runId).not.toBe(redo.runs[1]?.runId)
  })
})
