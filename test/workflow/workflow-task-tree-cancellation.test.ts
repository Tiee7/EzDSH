import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function run(id: string, status: WorkflowRunRecord['status'], parentRunId?: string): WorkflowRunRecord {
  const now = '2026-09-16T12:00:00.000Z'
  return {
    id,
    workflowId: `workflow-${id}`,
    workflowRevision: 1,
    ...(parentRunId === undefined
      ? {
          origin: { kind: 'top-level' as const },
          workTask: { taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 1, commandId: 'command-1' },
        }
      : {
          parentRunId,
          origin: { kind: 'child' as const, parentRunId },
          workflowAncestry: ['workflow-root'],
        }),
    status,
    queue: { enqueuedAt: now, availableAt: now },
    input: null,
    nodeStates: [],
    events: [],
    allowShellFile: false,
  }
}

async function storeFixture(): Promise<{ directory: string; store: WorkflowRunStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-task-tree-cancel-'))
  roots.push(directory)
  const store = new WorkflowRunStore(directory)
  await store.initialize()
  return { directory, store }
}

describe('Workflow WorkTask tree cancellation', () => {
  it('atomically freezes existing descendants and rejects a child admitted after the fence', async () => {
    const { store } = await storeFixture()
    await store.save(run('root', 'completed'))
    await store.save(run('child', 'waiting-approval', 'root'))

    const root = await store.beginWorkTaskCancellation('root', 'task-cancel-1', new Date('2026-09-16T12:01:00.000Z'))

    expect(root.workTaskCancellation).toMatchObject({
      requestId: 'task-cancel-1',
      state: 'cancelling',
      targets: [
        { runId: 'root', state: 'settled', finalRunStatus: 'completed' },
        { runId: 'child', parentRunId: 'root', state: 'pending' },
      ],
    })
    await expect(store.enqueue(run('late-grandchild', 'queued', 'child'))).rejects.toThrow(/TASK_CANCELLATION_FENCED/u)
    expect(store.get('late-grandchild')).toBeUndefined()
    await expect(store.remove('child')).rejects.toThrow(/WORKFLOW_RUN_PROTECTED/u)
  })

  it('includes a child that wins the serialized enqueue race before the root fence', async () => {
    const { store } = await storeFixture()
    await store.save(run('root', 'completed'))

    const child = await store.enqueue(run('child-first', 'queued', 'root'))
    const root = await store.beginWorkTaskCancellation('root', 'task-cancel-before-restart')

    expect(child.id).toBe('child-first')
    expect(root.workTaskCancellation?.targets.map((target) => target.runId)).toEqual(['root', 'child-first'])
  })

  it('rejects an inline child first saved after the root fence', async () => {
    const { store } = await storeFixture()
    await store.save(run('root', 'running'))
    await store.beginWorkTaskCancellation('root', 'task-cancel-inline-child')

    await expect(store.save(run('inline-child', 'running', 'root'))).rejects.toThrow(/TASK_CANCELLATION_FENCED/u)
    expect(store.get('inline-child')).toBeUndefined()
  })

  it('reloads the frozen tree and keeps a cancelled parent aggregate open while its child is active', async () => {
    const { directory, store } = await storeFixture()
    await store.save(run('root', 'cancelled'))
    await store.save(run('child', 'running', 'root'))
    const started = await store.beginWorkTaskCancellation('root', 'task-cancel-reload')
    expect(started.workTaskCancellation?.state).toBe('cancelling')

    const reopened = new WorkflowRunStore(directory)
    await reopened.initialize()

    expect(reopened.get('root')?.workTaskCancellation).toEqual(started.workTaskCancellation)
    expect(reopened.listPendingWorkTaskCancellations().map((record) => record.id)).toEqual(['root'])
    expect(await reopened.claimNextDue('worker-after-restart', 10_000, new Date('2026-09-16T12:02:00.000Z'))).toBeUndefined()
  })

  it('protects an unfinished tree without permanently pinning a finalized root-only record', async () => {
    const { store } = await storeFixture()
    await store.save(run('root', 'queued'))
    await store.beginWorkTaskCancellation('root', 'task-cancel-retention')

    await expect(store.remove('root')).rejects.toThrow(/WORKFLOW_RUN_PROTECTED/u)

    await store.requestCancellation('root', new Date('2026-09-16T12:02:00.000Z'), true)
    const finalized = await store.refreshWorkTaskCancellation('root', new Date('2026-09-16T12:03:00.000Z'))
    expect(finalized.workTaskCancellation?.state).toBe('cancelled')
    await expect(store.remove('root')).resolves.toBe(true)
  })

  it('preserves a root fence when a stale Worker snapshot saves afterward', async () => {
    const { store } = await storeFixture()
    const staleRoot = await store.save(run('root', 'running'))
    await store.save(run('child', 'waiting-approval', 'root'))
    const fenced = await store.beginWorkTaskCancellation('root', 'task-cancel-stale-writer')

    staleRoot.status = 'completed'
    const saved = await store.save(staleRoot)

    expect(saved.status).toBe('completed')
    expect(saved.workTaskCancellation).toEqual(fenced.workTaskCancellation)
    expect(store.get('root')?.workTaskCancellation).toEqual(fenced.workTaskCancellation)
  })

  it('cancels descendants leaf-first and exposes the durable top-level aggregate', async () => {
    const { directory, store } = await storeFixture()
    await store.save(run('root', 'completed'))
    await store.save(run('child', 'waiting-approval', 'root'))
    await store.save(run('grandchild', 'waiting-question', 'child'))
    const workflowStore = new WorkflowStore(directory)
    const service = new WorkflowRunService({
      workflowStore,
      runStore: store,
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    const order: string[] = []
    const requestCancellation = store.requestCancellation.bind(store)
    vi.spyOn(store, 'requestCancellation').mockImplementation(async (runId, ...args) => {
      order.push(runId)
      return requestCancellation(runId, ...args)
    })

    const cancelled = await service.cancelForWorkTask('root')

    expect(order).toEqual(['grandchild', 'child'])
    expect(cancelled.status).toBe('completed')
    expect(service.getWorkTaskCancellation('root')).toMatchObject({ state: 'cancelled' })
    expect(store.get('child')?.status).toBe('cancelled')
    expect(store.get('grandchild')?.status).toBe('cancelled')
    await service.stop()
  })

  it('persists an unknown descendant outcome and does not blindly retry it', async () => {
    const { directory, store } = await storeFixture()
    await store.save(run('root', 'completed'))
    await store.save(run('child', 'waiting-approval', 'root'))
    const workflowStore = new WorkflowStore(directory)
    const service = new WorkflowRunService({
      workflowStore,
      runStore: store,
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    const requestCancellation = vi.spyOn(store, 'requestCancellation').mockRejectedValueOnce(new Error('persistence response lost'))

    const unknown = await service.cancelForWorkTask('root')
    const replay = await service.cancelForWorkTask('root')

    expect(unknown.workTaskCancellation).toMatchObject({
      state: 'outcome-unknown',
      targets: expect.arrayContaining([expect.objectContaining({ runId: 'child', state: 'outcome-unknown', error: 'persistence response lost' })]),
    })
    expect(replay.workTaskCancellation?.state).toBe('outcome-unknown')
    expect(requestCancellation).toHaveBeenCalledTimes(1)
    await service.stop()
  })

  it('recovers pending tree cancellation before a restarted Worker can claim its child', async () => {
    const { directory, store } = await storeFixture()
    await store.save(run('root', 'completed'))
    await store.enqueue(run('child', 'queued', 'root'))
    await store.beginWorkTaskCancellation('root', 'task-cancel-restart')

    const reopenedStore = new WorkflowRunStore(directory)
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(directory),
      runStore: reopenedStore,
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    await service.initialize()

    expect(reopenedStore.get('child')?.status).toBe('cancelled')
    expect(service.getWorkTaskCancellation('root')?.state).toBe('cancelled')
    await service.stop()
  })
})
