import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkItemStore } from '../../src/main/work-items/work-item-store.js'
import { validateWorkTaskExecuteRequest, type WorkTaskExecuteRequest } from '../../src/shared/work-items.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))) })

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'ezdsh-handoff-'))
  directories.push(path)
  const store = new WorkItemStore(path)
  await store.initialize()
  const created = await store.create({ requestId: 'create', title: '报告', goal: '竞品研究', acceptance: '附来源', scope: { resourceRefs: [] } })
  const request: WorkTaskExecuteRequest = { requestId: 'initial', taskId: created.task.id, expectedRevision: 1, executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: '核实来源' }
  return { path, store, created, request }
}

describe('work item handoff', () => {
  it('creates a distinct handoff attempt on the same durable task and preserves prior requirements and runs', async () => {
    const { path, store, request } = await fixture()
    const initial = await store.recordDispatchIntent(request)
    await store.claimDispatch(initial.requestId, initial.commandId)
    const linked = await store.linkDispatch(initial.requestId, initial.commandId, { runId: 'run-researcher', status: 'completed', rawStatus: 'completed', capabilities: { cancel: false, resume: false, append: false } })
    const handoff: WorkTaskExecuteRequest = { ...request, requestId: 'handoff', expectedRevision: linked.snapshot.task.revision, executor: { kind: 'workflow', workflowId: 'report', workflowRevision: 2 }, mode: 'handoff', sourceRunId: 'run-researcher', input: { evidence: 'fixed draft v1' } }
    const result = await store.recordDispatchIntent(handoff)
    expect(result.snapshot.task.id).toBe(initial.snapshot.task.id)
    expect(result.snapshot.task.revision).toBe(linked.snapshot.task.revision + 1)
    expect(result.attemptId).not.toBe(initial.attemptId)
    expect(result.snapshot.attempts[1]).toMatchObject({ reason: 'handoff', requirementVersion: 1, responsibility: handoff.executor })
    expect(result.snapshot.runs[0]).toEqual(linked.snapshot.runs[0])
    expect(result.snapshot.runs[1]).toMatchObject({ sourceRunId: 'run-researcher', attemptId: result.attemptId })
    expect(result.snapshot.task.requirements).toEqual(initial.snapshot.task.requirements)
    expect(result.snapshot.task.acceptedArtifactIds).toEqual(initial.snapshot.task.acceptedArtifactIds)
    const reopened = new WorkItemStore(path)
    await reopened.initialize()
    expect(await reopened.get(request.taskId)).toEqual(result.snapshot)
    expect(await reopened.recordDispatchIntent(handoff)).toMatchObject({ replayed: true, attemptId: result.attemptId })
    expect((await reopened.get(request.taskId))?.attempts).toHaveLength(2)
  })

  it('rejects a handoff without an existing attempt and a foreign source run without mutating the task', async () => {
    const { store, request } = await fixture()
    await expect(store.recordDispatchIntent({ ...request, mode: 'handoff' })).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' })
    const initial = await store.recordDispatchIntent(request)
    await expect(store.recordDispatchIntent({ ...request, requestId: 'bad-source', expectedRevision: 2, mode: 'handoff', sourceRunId: 'foreign-run' })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    expect(await store.get(request.taskId)).toEqual(initial.snapshot)
  })

  it('keeps continue-attempt as a local service call and redo as a distinct attempt', async () => {
    const { store, request } = await fixture()
    const initial = await store.recordDispatchIntent(request)
    const continued = await store.recordDispatchIntent({ ...request, requestId: 'continue', expectedRevision: 2, mode: 'continue-attempt', executor: { kind: 'employee', employeeId: 'editor' } })
    expect(continued.attemptId).toBe(initial.attemptId)
    expect(continued.snapshot.attempts).toHaveLength(1)
    expect(continued.snapshot.attempts[0]?.responsibility).toEqual(request.executor)
    const redo = await store.recordDispatchIntent({ ...request, requestId: 'redo', expectedRevision: 3, mode: 'redo' })
    expect(redo.attemptId).not.toBe(initial.attemptId)
    expect(redo.snapshot.attempts[1]?.reason).toBe('redo')
    expect(validateWorkTaskExecuteRequest({ ...request, mode: 'handoff' }).mode).toBe('handoff')
    expect(() => validateWorkTaskExecuteRequest({ ...request, mode: 'pretend-continue' })).toThrow('mode is not supported')
  })

  it('rejects non-finite workflow input before recording an attempt', async () => {
    const { store, request } = await fixture()
    const before = await store.get(request.taskId)
    await expect(store.recordDispatchIntent({
      ...request,
      requestId: 'unsafe-workflow-input',
      executor: { kind: 'workflow', workflowId: 'report', workflowRevision: 1 },
      input: Number.POSITIVE_INFINITY,
    })).rejects.toMatchObject({ code: 'INVALID_VALUE' })
    expect(await store.get(request.taskId)).toEqual(before)
  })
})
