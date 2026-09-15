import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkActionService } from '../../src/main/work-items/work-action-service.js'
import { WorkItemService } from '../../src/main/work-items/work-item-service.js'
import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store.js'
import type { EmployeeRunRecord } from '../../src/shared/employee-runs.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function linkedTask(kind: 'employee' | 'workflow') {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-control-'))
  directories.push(directory)
  const workItems = new WorkItemService(new WorkItemStore(directory))
  await workItems.initialize()
  const created = await workItems.create({ requestId: `create-${kind}`, title: 'Controlled task', goal: 'Run once', acceptance: 'Observable control', scope: { resourceRefs: [] } })
  const executor = kind === 'employee' ? { kind, employeeId: 'employee-1' } as const : { kind, workflowId: 'workflow-1' } as const
  const intent = await workItems.recordDispatchIntent({ requestId: `dispatch-${kind}`, taskId: created.task.id, expectedRevision: 1, executor, mode: 'initial', input: null })
  const runId = `${kind}-run-1`
  const linked = await workItems.linkDispatch(intent.requestId, intent.commandId, {
    runId, status: kind === 'workflow' ? 'paused' : 'running', rawStatus: kind === 'workflow' ? 'paused' : 'running',
    capabilities: { cancel: true, resume: kind === 'workflow', append: false },
  })
  return { directory, workItems, task: linked.snapshot, runId, commandId: intent.commandId }
}

function employeeRecord(runId: string, commandId: string, taskId: string, attemptId: string): EmployeeRunRecord {
  const now = '2026-09-15T10:00:00.000Z'
  return {
    runId, commandId, requestDigest: 'digest', employeeId: 'employee-1', employeeVersion: 1,
    employeeSnapshot: { schemaVersion: 2, version: 1, id: 'employee-1', name: 'Employee', role: 'Role', description: '', businessBoundary: '', systemPrompt: '', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: now, updatedAt: now },
    task: { taskId, description: 'Run once', attemptId, requirementVersion: 1 }, context: { cwd: '/tmp' },
    taskId, attemptId, requirementVersion: 1, cwd: '/tmp', sessionId: 'session-1', sessionEvidence: 'created',
    status: 'cancelling', dispatchStage: 'cancel-requested', promptRequestId: 'prompt-1', cancelRequestState: 'failed',
    cancelRequestError: 'Runtime rejected cancellation', partialOutput: '', output: '', createdAt: now, updatedAt: now,
  }
}

function workflowRecord(runId: string, commandId: string, taskId: string, attemptId: string): WorkflowRunRecord {
  return {
    id: runId, workflowId: 'workflow-1', workflowRevision: 1, origin: { kind: 'top-level' },
    workTask: { taskId, attemptId, requirementVersion: 1, commandId }, status: 'queued', input: null,
    nodeStates: [], events: [], allowShellFile: false, debug: false,
  }
}

describe('WorkActionService run control', () => {
  it('keeps a rejected Employee cancel visible instead of reporting confirmed stopped', async () => {
    const fixture = await linkedTask('employee')
    const rejected = employeeRecord(fixture.runId, fixture.commandId, fixture.task.task.id, fixture.task.attempts[0]!.id)
    const employeeRuns = { get: vi.fn(async () => rejected), cancel: vi.fn(async () => rejected) }
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns, workflowBridge: {} })

    const result = await service.controlRun({ requestId: 'cancel-1', taskId: fixture.task.task.id, runId: fixture.runId, expectedRevision: fixture.task.task.revision, action: 'cancel' })

    expect(result.runs[0]).toMatchObject({ status: 'cancelling', capabilities: { cancel: false, resume: false, append: false } })
    expect(result.runs[0]?.rawStatus).toMatch(/cancel.*failed.*Runtime rejected cancellation/iu)
    expect(result.runs[0]?.status).not.toBe('cancelled')
  })

  it('resumes the original Workflow run id and replays the durable control receipt', async () => {
    const fixture = await linkedTask('workflow')
    const resumed = workflowRecord(fixture.runId, fixture.commandId, fixture.task.task.id, fixture.task.attempts[0]!.id)
    const workflowBridge = { get: vi.fn(async () => resumed), resume: vi.fn(), resumeExpected: vi.fn(async (runId: string) => ({ ...resumed, id: runId })), cancel: vi.fn(), approveExpected: vi.fn() }
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge })
    const request = { requestId: 'resume-1', taskId: fixture.task.task.id, runId: fixture.runId, expectedRevision: fixture.task.task.revision, action: 'resume' as const }

    const first = await service.controlRun(request)
    const replay = await service.controlRun(request)

    expect(first.runs[0]?.runId).toBe(fixture.runId)
    expect(replay).toEqual(first)
    expect(workflowBridge.resumeExpected).toHaveBeenCalledTimes(1)
    expect(workflowBridge.resumeExpected).toHaveBeenCalledWith(fixture.runId, { requestId: request.requestId, expectedTaskId: fixture.task.task.id, expectedRequirementVersion: 1 })
  })

  it('rejects a stale task revision, unknown run, and unsupported Employee resume before executor control', async () => {
    const fixture = await linkedTask('employee')
    const employeeRuns = { get: vi.fn(), cancel: vi.fn() }
    const workflowBridge = { get: vi.fn(), resume: vi.fn(), resumeExpected: vi.fn(), cancel: vi.fn(), approveExpected: vi.fn() }
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns, workflowBridge })

    await expect(service.controlRun({ requestId: 'stale', taskId: fixture.task.task.id, runId: fixture.runId, expectedRevision: fixture.task.task.revision - 1, action: 'cancel' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(service.controlRun({ requestId: 'unknown', taskId: fixture.task.task.id, runId: 'missing', expectedRevision: fixture.task.task.revision, action: 'cancel' })).rejects.toThrow(/run.*not found/iu)
    await expect(service.controlRun({ requestId: 'resume-employee', taskId: fixture.task.task.id, runId: fixture.runId, expectedRevision: fixture.task.task.revision, action: 'resume' })).rejects.toThrow(/does not support resume/iu)
    expect(employeeRuns.cancel).not.toHaveBeenCalled()
    expect(workflowBridge.resume).not.toHaveBeenCalled()
  })

  it('rejects reuse of a completed control request id with different content', async () => {
    const fixture = await linkedTask('workflow')
    const resumed = workflowRecord(fixture.runId, fixture.commandId, fixture.task.task.id, fixture.task.attempts[0]!.id)
    const workflowBridge = { get: vi.fn(async () => resumed), resume: vi.fn(), resumeExpected: vi.fn(async () => resumed), cancel: vi.fn(async () => resumed), approveExpected: vi.fn() }
    const service = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge })
    const request = { requestId: 'control-same', taskId: fixture.task.task.id, runId: fixture.runId, expectedRevision: fixture.task.task.revision, action: 'resume' as const }
    await service.controlRun(request)

    await expect(service.controlRun({ ...request, action: 'cancel' })).rejects.toBeInstanceOf(WorkItemStoreConflictError)
    expect(workflowBridge.cancel).not.toHaveBeenCalled()
  })

  it('reopens a recorded resume after the accepted Workflow run fails again without resuming twice', async () => {
    const fixture = await linkedTask('workflow')
    const failed = { ...workflowRecord(fixture.runId, fixture.commandId, fixture.task.task.id, fixture.task.attempts[0]!.id), status: 'failed' as const }
    let current = structuredClone(failed)
    const resumeExpected = vi.fn(async (runId: string, request: { requestId: string; expectedTaskId: string; expectedRequirementVersion: number }) => {
      current = {
        ...current,
        id: runId,
        status: 'failed',
        workTaskControlReceipts: [{ ...request, action: 'resume' as const, acceptedStateToken: 'accepted-token', acceptedAt: '2026-09-15T10:00:00.000Z' }],
      }
      return { ...structuredClone(current), status: 'queued' as const, error: undefined }
    })
    const workflowBridge = {
      get: vi.fn(async () => structuredClone(current)), resumeExpected, resume: vi.fn(), cancel: vi.fn(), approveExpected: vi.fn(),
    }
    const originalComplete = fixture.workItems.completeRunControl.bind(fixture.workItems)
    vi.spyOn(fixture.workItems, 'completeRunControl').mockRejectedValueOnce(new Error('process stopped before WorkItem completion'))
    const request = { requestId: 'resume-gap', taskId: fixture.task.task.id, runId: fixture.runId, expectedRevision: fixture.task.task.revision, action: 'resume' as const }
    const firstService = new WorkActionService({ workItems: fixture.workItems, employeeRuns: {}, workflowBridge })

    await expect(firstService.controlRun(request)).rejects.toThrow(/process stopped/iu)
    expect(current).toMatchObject({ id: fixture.runId, status: 'failed', workTaskControlReceipts: [{ requestId: request.requestId }] })
    expect(resumeExpected).toHaveBeenCalledTimes(1)

    vi.mocked(fixture.workItems.completeRunControl).mockImplementation(originalComplete)
    const reopenedItems = new WorkItemService(new WorkItemStore(fixture.directory))
    await reopenedItems.initialize()
    const reopened = new WorkActionService({ workItems: reopenedItems, employeeRuns: {}, workflowBridge })
    const replay = await reopened.controlRun(request)

    expect(replay.runs[0]).toMatchObject({ runId: fixture.runId, status: 'failed', rawStatus: 'failed' })
    expect(resumeExpected).toHaveBeenCalledTimes(1)
    expect(workflowBridge.resume).not.toHaveBeenCalled()
  })
})
