import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkItemService } from '../../src/main/work-items/work-item-service'
import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store'
import { WorkItemValidationError } from '../../src/shared/work-items'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function service(): Promise<WorkItemService> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-service-'))
  directories.push(directory)
  const store = new WorkItemStore(directory)
  const result = new WorkItemService(store)
  await result.initialize()
  return result
}

describe('WorkItemService', () => {
  it('validates and normalizes create requests before storing them', async () => {
    const subject = await service()
    const snapshot = await subject.create({
      requestId: ' create-1 ',
      title: ' 竞品简报 ',
      goal: ' 核实三项变化 ',
      acceptance: ' 附来源 ',
      scope: { resourceRefs: [] }
    })

    expect(snapshot.task).toMatchObject({ title: '竞品简报', revision: 1 })
    expect(snapshot.task.requirements[0]).toMatchObject({ goal: '核实三项变化', acceptance: '附来源' })
    await expect(subject.create({
      requestId: 'bad', title: ' ', goal: 'goal', acceptance: 'done', scope: { resourceRefs: [] }
    })).rejects.toBeInstanceOf(WorkItemValidationError)
  })

  it('records only a durable dispatch intent and replays it idempotently', async () => {
    const subject = await service()
    const created = await subject.create({
      requestId: 'create-1', title: 'Task', goal: 'Goal', acceptance: 'Done', scope: { resourceRefs: [] }
    })
    const request = {
      requestId: 'dispatch-1',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'workflow' as const, workflowId: 'wf-1', workflowRevision: 2 },
      mode: 'initial' as const,
      input: { topic: 'AI' }
    }

    const first = await subject.recordDispatchIntent(request)
    const replay = await subject.recordDispatchIntent(request)

    expect(first.snapshot.task.revision).toBe(2)
    expect(first.stage).toBe('recorded')
    expect(first.snapshot.runs[0]).toMatchObject({ status: 'queued', rawStatus: 'dispatch-intent-recorded' })
    expect(replay).toEqual({ ...first, replayed: true })
    await expect(subject.recordDispatchIntent({ ...request, input: { topic: 'different' } }))
      .rejects.toBeInstanceOf(WorkItemStoreConflictError)
    expect(await subject.list({ workflowId: 'wf-1' })).toHaveLength(1)
  })

  it('archives and restores durably with exact request replay and default filtering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-archive-'))
    directories.push(directory)
    const firstStore = new WorkItemStore(directory)
    const firstService = new WorkItemService(firstStore, async () => true)
    await firstService.initialize()
    const created = await firstService.create({
      requestId: 'create-archive', title: 'Task', goal: 'Goal', acceptance: 'Done', scope: { resourceRefs: [] }
    })
    const dispatch = await firstService.recordDispatchIntent({
      requestId: 'dispatch-archive',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'workflow', workflowId: 'wf-1' },
      mode: 'initial',
      input: null,
    })
    await firstService.linkDispatch(dispatch.requestId, dispatch.commandId, {
      runId: 'run-archive',
      status: 'completed',
      rawStatus: 'completed',
      capabilities: { cancel: false, resume: false, append: false },
    })
    await firstStore.beginArtifactWrite({
      requestId: 'write-archive',
      artifactId: 'artifact-archive',
      taskId: created.task.id,
      attemptId: dispatch.attemptId,
      runId: 'run-archive',
      requirementVersion: 1,
      contentVersion: 1,
      contentHash: 'a'.repeat(64),
      kind: 'text',
      name: 'artifact.txt',
      storedPath: '/tmp/artifact.txt',
    })
    const written = await firstStore.completeArtifactWrite('write-archive', 'artifact-archive', async () => true)
    const accepted = await firstService.acceptArtifact({
      requestId: 'accept-archive',
      taskId: created.task.id,
      expectedRevision: written.snapshot.task.revision,
      artifactId: 'artifact-archive',
      contentVersion: 1,
      requirementVersion: 1,
    })

    const legacyService = new WorkItemService(new WorkItemStore(directory))
    await legacyService.initialize()
    expect(await legacyService.list()).toEqual([accepted])
    const archiveRequest = {
      requestId: 'archive-1', taskId: created.task.id, expectedRevision: accepted.task.revision, archived: true,
    }

    await expect(legacyService.archive({
      ...archiveRequest,
      requestId: 'archive-stale',
      expectedRevision: accepted.task.revision - 1,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const archived = await legacyService.archive(archiveRequest)
    expect(archived.task).toMatchObject({
      id: created.task.id,
      revision: accepted.task.revision + 1,
      status: accepted.task.status,
      archivedAt: expect.any(String),
      acceptedArtifactIds: accepted.task.acceptedArtifactIds,
      requirements: accepted.task.requirements,
    })
    expect(archived.task.updatedAt).toBe(archived.task.archivedAt)
    expect(archived.attempts).toEqual(accepted.attempts)
    expect(archived.runs).toEqual(accepted.runs)
    expect(archived.artifacts).toEqual(accepted.artifacts)
    expect(await legacyService.list()).toEqual([])
    expect(await legacyService.list({ includeArchived: true })).toEqual([archived])

    const restoredService = new WorkItemService(new WorkItemStore(directory))
    await restoredService.initialize()
    expect(await restoredService.archive(archiveRequest)).toEqual(archived)
    await expect(restoredService.archive({ ...archiveRequest, archived: false }))
      .rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' })

    const restored = await restoredService.archive({
      requestId: 'restore-1', taskId: created.task.id, expectedRevision: archived.task.revision, archived: false,
    })
    expect(restored.task.archivedAt).toBeUndefined()
    expect(restored.task).toMatchObject({
      id: created.task.id,
      revision: archived.task.revision + 1,
      status: accepted.task.status,
      acceptedArtifactIds: accepted.task.acceptedArtifactIds,
      requirements: accepted.task.requirements,
    })
    expect(restored.task.updatedAt).toEqual(expect.any(String))
    expect(restored.attempts).toEqual(accepted.attempts)
    expect(restored.runs).toEqual(accepted.runs)
    expect(restored.artifacts).toEqual(accepted.artifacts)
    expect(await restoredService.archive(archiveRequest)).toEqual(archived)
    expect(await restoredService.list()).toEqual([restored])
  })

  it.each(['queued', 'running', 'waiting', 'paused', 'cancelling'] as const)(
    'rejects archive while a %s run exists',
    async (status) => {
      const subject = await service()
      const created = await subject.create({
        requestId: `create-${status}`, title: 'Task', goal: 'Goal', acceptance: 'Done', scope: { resourceRefs: [] }
      })
      const dispatch = await subject.recordDispatchIntent({
        requestId: `dispatch-${status}`,
        taskId: created.task.id,
        expectedRevision: 1,
        executor: { kind: 'workflow', workflowId: 'wf-1' },
        mode: 'initial',
        input: null,
      })
      if (status !== 'queued') {
        await subject.linkDispatch(dispatch.requestId, dispatch.commandId, {
          runId: `run-${status}`,
          status,
          rawStatus: status,
          capabilities: { cancel: true, resume: true, append: true },
        })
      }

      await expect(subject.archive({
        requestId: `archive-${status}`,
        taskId: created.task.id,
        expectedRevision: 2,
        archived: true,
      })).rejects.toMatchObject({ code: 'ARCHIVE_CONFLICT' })
    }
  )

  it('rejects archive while an open action exists even after its run completes', async () => {
    const subject = await service()
    const created = await subject.create({
      requestId: 'create-open-action', title: 'Task', goal: 'Goal', acceptance: 'Done', scope: { resourceRefs: [] }
    })
    const dispatch = await subject.recordDispatchIntent({
      requestId: 'dispatch-open-action',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'workflow', workflowId: 'wf-1' },
      mode: 'initial',
      input: null,
    })
    await subject.linkDispatch(dispatch.requestId, dispatch.commandId, {
      runId: 'run-open-action',
      status: 'completed',
      rawStatus: 'completed',
      capabilities: { cancel: false, resume: false, append: false },
    })
    const withAction = await subject.syncWorkflowActions(created.task.id, 'run-open-action', [{
      id: 'action-1',
      taskId: created.task.id,
      runId: 'run-open-action',
      sourceEventId: 'event-1',
      requirementVersion: 1,
      kind: 'question',
      status: 'open',
    }])

    await expect(subject.archive({
      requestId: 'archive-open-action',
      taskId: created.task.id,
      expectedRevision: withAction.task.revision,
      archived: true,
    })).rejects.toMatchObject({ code: 'ARCHIVE_CONFLICT' })
  })
})
