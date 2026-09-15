import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkArtifactService } from '../../src/main/work-items/work-artifact-service.js'
import { WorkActionService } from '../../src/main/work-items/work-action-service.js'
import { WorkItemExecutionService } from '../../src/main/work-items/work-item-execution-service.js'
import { WorkItemService } from '../../src/main/work-items/work-item-service.js'
import { WorkItemStore } from '../../src/main/work-items/work-item-store.js'
import type { EmployeeRunRecord, EmployeeRunStartRequest } from '../../src/shared/employee-runs.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function employeeRun(request: EmployeeRunStartRequest): EmployeeRunRecord {
  const now = new Date().toISOString()
  return {
    runId: `employee-${request.commandId}`,
    commandId: request.commandId,
    requestDigest: 'integration',
    employeeId: request.employeeId,
    employeeVersion: 1,
    employeeSnapshot: { schemaVersion: 2, version: 1, id: request.employeeId, name: 'Researcher', role: 'Research', description: '', businessBoundary: '', systemPrompt: '', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: now, updatedAt: now },
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
    status: 'completed',
    dispatchStage: 'linked',
    promptRequestId: `prompt-${request.commandId}`,
    partialOutput: '',
    output: 'done',
    createdAt: now,
    updatedAt: now,
  }
}

function workflowRun(commandId: string, workflowId: string): WorkflowRunRecord {
  return {
    id: `workflow-${commandId}`,
    workflowId,
    workflowRevision: 3,
    idempotencyKey: commandId,
    origin: { kind: 'top-level' },
    status: 'completed',
    input: null,
    nodeStates: [],
    events: [],
    allowShellFile: false,
    debug: false,
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-items-integration-'))
  directories.push(directory)
  const store = new WorkItemStore(join(directory, 'state'))
  const artifactService = new WorkArtifactService(store, join(directory, 'artifacts'))
  await artifactService.initialize()
  const workItems = new WorkItemService(store, (artifact) => artifactService.verifyStoredArtifact(artifact))
  await workItems.initialize()
  const employeeRuns: EmployeeRunRecord[] = []
  const employeePort = {
    start: vi.fn(async (request: EmployeeRunStartRequest) => {
      const run = employeeRun(request)
      employeeRuns.push(run)
      return { run, replayed: false }
    }),
    list: vi.fn(async () => structuredClone(employeeRuns)),
  }
  const workflowRuns: WorkflowRunRecord[] = []
  const workflowPort = {
    start: vi.fn(async (request: { commandId: string; workflowId: string }) => {
      const run = workflowRun(request.commandId, request.workflowId)
      workflowRuns.push(run)
      return run
    }),
    findByCommand: vi.fn(async (commandId: string) => workflowRuns.find((run) => run.idempotencyKey === commandId)),
  }
  const execution = new WorkItemExecutionService({ workItems, employeeRuns: employeePort, workflowBridge: workflowPort, defaultCwd: directory })
  return { directory, store, workItems, artifactService, execution, employeePort, workflowPort }
}

describe('Work Items end-to-end composition', () => {
  it('projects later Employee run events into the durable Work Item snapshot', async () => {
    const f = await fixture()
    const created = await f.workItems.create({ requestId: 'create-observed', title: 'Observed employee', goal: 'Track the employee', acceptance: 'Current run state is visible', scope: { resourceRefs: [] } })
    const dispatched = await f.execution.execute({ requestId: 'dispatch-observed', taskId: created.task.id, expectedRevision: created.task.revision, executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: null })
    const reference = dispatched.runs[0]!
    const initial = f.employeePort.start.mock.results[0]?.value
    const started = initial === undefined ? undefined : await initial
    expect(started).toBeDefined()
    const employeeRuns = {
      get: vi.fn(async (runId: string) => runId === reference.runId ? started!.run : undefined),
      cancel: vi.fn(),
    }
    const observer = new WorkActionService({ workItems: f.workItems, employeeRuns, workflowBridge: {}, artifacts: f.artifactService })
    const running = { ...started!.run, status: 'running' as const, dispatchStage: 'prompt-in-flight' as const, updatedAt: new Date(Date.now() + 1).toISOString() }

    const projected = await observer.observeEmployeeRun(running)

    expect(projected?.runs.find((run) => run.runId === reference.runId)).toMatchObject({ status: 'running', rawStatus: 'running', capabilities: { cancel: true } })
    await expect(f.workItems.get(created.task.id)).resolves.toMatchObject({ runs: [{ runId: reference.runId, status: 'running' }] })

    const completed = { ...running, status: 'completed' as const, dispatchStage: 'completed' as const, completedAt: new Date(Date.now() + 2).toISOString(), output: 'done' }
    const completedProjection = await observer.observeEmployeeRun(completed)
    expect(completedProjection?.runs.find((run) => run.runId === reference.runId)).toMatchObject({ status: 'completed', rawStatus: 'completed' })
    expect(completedProjection?.artifacts).toHaveLength(1)
    await expect(f.artifactService.read(completedProjection!.artifacts[0]!)).resolves.toEqual(Buffer.from('done'))
  })

  it('saves a completed Workflow output as a reviewable JSON deliverable', async () => {
    const f = await fixture()
    const created = await f.workItems.create({ requestId: 'create-workflow-output', title: 'Workflow output', goal: 'Track output', acceptance: 'Review JSON', scope: { resourceRefs: [] } })
    const dispatched = await f.execution.execute({ requestId: 'dispatch-workflow-output', taskId: created.task.id, expectedRevision: created.task.revision, executor: { kind: 'workflow', workflowId: 'workflow-1', workflowRevision: 3 }, mode: 'initial', input: { source: 'test' } })
    const reference = dispatched.runs[0]!
    const record = workflowRun(reference.commandId, 'workflow-1')
    record.output = { summary: 'done', count: 3 }
    record.workTask = { taskId: created.task.id, attemptId: reference.attemptId, requirementVersion: reference.requirementVersion, commandId: reference.commandId }

    const observed = await new WorkActionService({ workItems: f.workItems, employeeRuns: {}, workflowBridge: {}, artifacts: f.artifactService }).observeWorkflowRun(record)

    expect(observed?.artifacts).toHaveLength(1)
    await expect(f.artifactService.read(observed!.artifacts[0]!)).resolves.toEqual(Buffer.from('{\n  "summary": "done",\n  "count": 3\n}\n'))
  })

  it('creates, dispatches, accepts a deliverable, and reopens the accepted state', async () => {
    const f = await fixture()
    const created = await f.workItems.create({ requestId: 'create', title: 'Release brief', goal: 'Verify release changes', acceptance: 'A cited brief', scope: { projectId: 'project-1', cwd: f.directory, resourceRefs: [] } })
    const dispatched = await f.execution.execute({ requestId: 'employee-run', taskId: created.task.id, expectedRevision: created.task.revision, executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: { focus: 'release' } })
    const run = dispatched.runs[0]!
    const artifact = await f.artifactService.saveText({ requestId: 'artifact', taskId: created.task.id, attemptId: run.attemptId, runId: run.runId, requirementVersion: run.requirementVersion, contentVersion: 1, name: 'brief.md', text: '# verified\n' })
    const beforeAcceptance = (await f.workItems.get(created.task.id))!
    const accepted = await f.workItems.acceptArtifact({ requestId: 'accept', taskId: created.task.id, expectedRevision: beforeAcceptance.task.revision, artifactId: artifact.id, contentVersion: artifact.contentVersion, requirementVersion: artifact.requirementVersion })

    expect(f.employeePort.start).toHaveBeenCalledOnce()
    expect(accepted.task.status).toBe('completed')
    expect(accepted.task.acceptedArtifactIds).toEqual([artifact.id])

    const reopenedStore = new WorkItemStore(join(f.directory, 'state'))
    const reopenedArtifacts = new WorkArtifactService(reopenedStore, join(f.directory, 'artifacts'))
    await reopenedArtifacts.initialize()
    const reopened = new WorkItemService(reopenedStore, (candidate) => reopenedArtifacts.verifyStoredArtifact(candidate))
    await reopened.initialize()
    await expect(reopened.get(created.task.id)).resolves.toMatchObject({ task: { status: 'completed', acceptedArtifactIds: [artifact.id] } })
  })

  it('keeps redo and handoff as new attempts while preserving the durable task identity', async () => {
    const f = await fixture()
    const created = await f.workItems.create({ requestId: 'create', title: 'Workflow handoff', goal: 'Run the workflow', acceptance: 'Workflow completed', scope: { resourceRefs: [] } })
    const first = await f.execution.execute({ requestId: 'first', taskId: created.task.id, expectedRevision: created.task.revision, executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: null })
    const redo = await f.execution.execute({ requestId: 'redo', taskId: created.task.id, expectedRevision: first.task.revision, executor: { kind: 'workflow', workflowId: 'workflow-1', workflowRevision: 3 }, mode: 'redo', input: { source: 'review' } })
    const handoff = await f.execution.execute({ requestId: 'handoff', taskId: created.task.id, expectedRevision: redo.task.revision, executor: { kind: 'workflow', workflowId: 'workflow-2', workflowRevision: 1 }, mode: 'handoff', sourceRunId: first.runs[0]!.runId, input: null })

    expect(handoff.task.id).toBe(created.task.id)
    expect(handoff.attempts.map((attempt) => attempt.reason)).toEqual(['initial', 'redo', 'handoff'])
    expect(handoff.runs).toHaveLength(3)
    expect(f.workflowPort.start).toHaveBeenCalledTimes(2)
  })
})
