import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkArtifactService } from '../../src/main/work-items/work-artifact-service.js'
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
