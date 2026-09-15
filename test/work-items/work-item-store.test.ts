import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store'

const directories: string[] = []

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-items-'))
  directories.push(directory)
  return directory
}

const request = {
  requestId: 'create-1',
  title: '竞品简报',
  goal: '核实三项变化',
  acceptance: '附来源',
  scope: { resourceRefs: ['source:a'] }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('WorkItemStore', () => {
  it('reopens the durable task, relations, receipt, and dispatch intent', async () => {
    const directory = await temporaryStateDirectory()
    const firstStore = new WorkItemStore(directory)
    await firstStore.initialize()
    const created = await firstStore.create(request)
    const dispatched = await firstStore.recordDispatchIntent({
      requestId: 'dispatch-1',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' },
      mode: 'initial',
      input: { query: 'three changes' }
    })

    const reopened = new WorkItemStore(directory)
    await reopened.initialize()
    const snapshot = await reopened.get(created.task.id)
    const replay = await reopened.recordDispatchIntent({
      requestId: 'dispatch-1',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' },
      mode: 'initial',
      input: { query: 'three changes' }
    })

    expect(snapshot).toEqual(dispatched.snapshot)
    expect(snapshot?.attempts).toHaveLength(1)
    expect(snapshot?.runs[0]).toMatchObject({
      taskId: created.task.id,
      attemptId: snapshot?.attempts[0]?.id,
      commandId: dispatched.commandId,
      runId: dispatched.runId,
      status: 'queued',
      rawStatus: 'dispatch-intent-recorded'
    })
    expect(replay).toEqual({ ...dispatched, replayed: true })
  })

  it('replays equivalent creates and classifies different request content as conflict', async () => {
    const store = new WorkItemStore(await temporaryStateDirectory())
    await store.initialize()

    const first = await store.create(request)
    const replay = await store.create({ ...request, scope: { resourceRefs: ['source:a'] } })

    expect(replay.task.id).toBe(first.task.id)
    expect(replay.digest).toBe(first.digest)
    expect(replay.replayed).toBe(true)
    await expect(store.create({ ...request, goal: '另一个目标' })).rejects.toBeInstanceOf(
      WorkItemStoreConflictError
    )
    expect(await store.list()).toHaveLength(1)
  })

  it('serializes concurrent mutations and rejects the stale revision without a lost update', async () => {
    const store = new WorkItemStore(await temporaryStateDirectory())
    await store.initialize()
    const created = await store.create(request)
    const dispatch = (requestId: string) => store.recordDispatchIntent({
      requestId,
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'workflow' as const, workflowId: requestId },
      mode: 'initial' as const,
      input: null
    })

    const results = await Promise.allSettled([dispatch('dispatch-a'), dispatch('dispatch-b')])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({ reason: expect.any(WorkItemStoreConflictError) })
    const snapshot = await store.get(created.task.id)
    expect(snapshot?.task.revision).toBe(2)
    expect(snapshot?.attempts).toHaveLength(1)
    expect(snapshot?.runs).toHaveLength(1)
  })

  it('keeps prior durable and observable state when the atomic write fails', async () => {
    const directory = await temporaryStateDirectory()
    let replacements = 0
    const store = new WorkItemStore(directory, {
      rename: async (from, to) => {
        replacements += 1
        if (replacements === 2) throw new Error('simulated atomic replace failure')
        await rename(from, to)
      }
    })
    await store.initialize()
    const created = await store.create(request)
    const changes: string[] = []
    store.onChanged((snapshot) => changes.push(snapshot.task.id))

    await expect(store.recordDispatchIntent({
      requestId: 'dispatch-fails',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' },
      mode: 'initial',
      input: {}
    })).rejects.toThrow('simulated atomic replace failure')

    expect(changes).toEqual([])
    expect((await store.get(created.task.id))?.runs).toEqual([])
    const reopened = new WorkItemStore(directory)
    await reopened.initialize()
    expect((await reopened.get(created.task.id))?.runs).toEqual([])
    const persisted = JSON.parse(await readFile(join(directory, 'work-items.json'), 'utf8'))
    expect(persisted.requests['dispatch-fails']).toBeUndefined()
  })
})
