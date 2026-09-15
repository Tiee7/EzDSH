import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  WorkItemStore,
  WorkItemStoreConflictError,
  WorkItemStoreInputError
} from '../../src/main/work-items/work-item-store'

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

  it('distinguishes opaque structured-clone input without interpreting its fields', async () => {
    const store = new WorkItemStore(await temporaryStateDirectory())
    await store.initialize()
    const created = await store.create(request)
    const dispatch = (requestId: string, input: unknown, expectedRevision = 1) =>
      store.recordDispatchIntent({
        requestId,
        taskId: created.task.id,
        expectedRevision,
        executor: { kind: 'employee', employeeId: 'researcher' },
        mode: 'initial',
        input
      })

    await expect(dispatch('undefined-or-string', undefined)).resolves.toMatchObject({ replayed: false })
    await expect(dispatch('undefined-or-string', '__undefined__')).rejects.toBeInstanceOf(
      WorkItemStoreConflictError
    )
    await expect(dispatch('number-or-null', Number.NaN, 2)).resolves.toMatchObject({ replayed: false })
    await expect(dispatch('number-or-null', null, 2)).rejects.toBeInstanceOf(WorkItemStoreConflictError)
    await expect(dispatch('negative-zero', -0, 3)).resolves.toMatchObject({ replayed: false })
    await expect(dispatch('negative-zero', 0, 3)).rejects.toBeInstanceOf(WorkItemStoreConflictError)
    const sparse: unknown[] = []
    sparse.length = 1
    await expect(dispatch('sparse', sparse, 4)).resolves.toMatchObject({ replayed: false })
    await expect(dispatch('sparse', [undefined], 4)).rejects.toBeInstanceOf(WorkItemStoreConflictError)
    await expect(dispatch('map-or-set', new Map([['role', 'admin']]), 5)).resolves.toMatchObject({
      replayed: false
    })
    await expect(dispatch('map-or-set', new Set([['role', 'admin']]), 5)).rejects.toBeInstanceOf(
      WorkItemStoreConflictError
    )
    await expect(dispatch('unsupported', () => undefined, 6)).rejects.toMatchObject({
      name: 'WorkItemStoreInputError', code: 'UNSUPPORTED_INPUT', path: '$.input'
    })
    await expect(dispatch('unsupported', { permission: 'opaque-data' }, 6)).resolves.toMatchObject({
      replayed: false
    })

    let dateMethodCalls = 0
    const unsafeDate = new Date(0) as Date & { getTime: () => number }
    unsafeDate.getTime = () => {
      dateMethodCalls += 1
      return 0
    }
    await expect(dispatch('safe-date', unsafeDate, 7)).rejects.toBeInstanceOf(WorkItemStoreInputError)
    expect(dateMethodCalls).toBe(0)
    await expect(dispatch('safe-date', new Date(0), 7)).resolves.toMatchObject({ replayed: false })

    let mapMethodCalls = 0
    const unsafeMap = new Map([['role', 'admin']]) as Map<string, string> & { entries: Map<string, string>['entries'] }
    unsafeMap.entries = () => {
      mapMethodCalls += 1
      return new Map<string, string>().entries()
    }
    await expect(dispatch('safe-map', unsafeMap, 8)).rejects.toBeInstanceOf(WorkItemStoreInputError)
    expect(mapMethodCalls).toBe(0)
    await expect(dispatch('safe-map', new Map([['role', 'admin']]), 8)).resolves.toMatchObject({
      replayed: false
    })

    const numericLastIndex = /role/g
    numericLastIndex.lastIndex = 0
    const stringLastIndex = /role/g
    ;(stringLastIndex as unknown as { lastIndex: string }).lastIndex = '0'
    await expect(dispatch('regexp-last-index', numericLastIndex, 9)).resolves.toMatchObject({ replayed: false })
    await expect(dispatch('regexp-last-index', stringLastIndex, 9)).rejects.toBeInstanceOf(
      WorkItemStoreConflictError
    )
    let arrayGetterCalls = 0
    const accessorArray: unknown[] = []
    Object.defineProperty(accessorArray, 0, {
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1
        return 'value'
      }
    })
    await expect(dispatch('safe-array', accessorArray, 10)).rejects.toBeInstanceOf(WorkItemStoreInputError)
    expect(arrayGetterCalls).toBe(0)
    await expect(dispatch('safe-array', ['value'], 10)).resolves.toMatchObject({ replayed: false })
    expect((await store.get(created.task.id))?.runs).toHaveLength(10)
  })

  it('isolates listener exceptions after a durable commit', async () => {
    const directory = await temporaryStateDirectory()
    const store = new WorkItemStore(directory)
    await store.initialize()
    const calls: string[] = []
    store.onChanged(() => {
      calls.push('throws')
      throw new Error('broken listener')
    })
    store.onChanged(() => calls.push('continues'))

    const receipt = await store.create(request)

    expect(receipt.task.id).toBeTruthy()
    expect(calls).toEqual(['throws', 'continues'])
    const reopened = new WorkItemStore(directory)
    await reopened.initialize()
    expect((await reopened.get(receipt.task.id))?.task.id).toBe(receipt.task.id)
  })

  it('rejects a Proxy before invoking any of its traps and does not consume the request id', async () => {
    const store = new WorkItemStore(await temporaryStateDirectory())
    await store.initialize()
    const created = await store.create(request)
    const traps = { get: 0, ownKeys: 0, descriptor: 0 }
    const proxy = new Proxy(['value'], {
      get(target, property, receiver) {
        traps.get += 1
        return Reflect.get(target, property, receiver)
      },
      ownKeys(target) {
        traps.ownKeys += 1
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, property) {
        traps.descriptor += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      }
    })
    const dispatch = (input: unknown) => store.recordDispatchIntent({
      requestId: 'proxy-request',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' },
      mode: 'initial',
      input
    })

    await expect(dispatch(proxy)).rejects.toMatchObject({
      name: 'WorkItemStoreInputError', code: 'UNSUPPORTED_INPUT', path: '$.input'
    })
    expect(traps).toEqual({ get: 0, ownKeys: 0, descriptor: 0 })
    await expect(dispatch(['value'])).resolves.toMatchObject({ replayed: false })
  })

  it('treats prototype-named request ids as own durable receipt keys', async () => {
    const directory = await temporaryStateDirectory()
    const store = new WorkItemStore(directory)
    await store.initialize()
    const createRequest = { ...request, requestId: 'toString' }

    const created = await store.create(createRequest)
    await expect(store.create(createRequest)).resolves.toMatchObject({
      task: { id: created.task.id }, replayed: true
    })
    await expect(store.create({ ...createRequest, goal: 'different' })).rejects.toBeInstanceOf(
      WorkItemStoreConflictError
    )

    const dispatchRequest = {
      requestId: '__proto__',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'workflow' as const, workflowId: 'wf-1' },
      mode: 'initial' as const,
      input: { topic: 'opaque' }
    }
    const dispatched = await store.recordDispatchIntent(dispatchRequest)
    await expect(store.recordDispatchIntent(dispatchRequest)).resolves.toMatchObject({
      commandId: dispatched.commandId, replayed: true
    })
    await expect(store.recordDispatchIntent({ ...dispatchRequest, input: { topic: 'different' } }))
      .rejects.toBeInstanceOf(WorkItemStoreConflictError)

    const reopened = new WorkItemStore(directory)
    await reopened.initialize()
    await expect(reopened.create(createRequest)).resolves.toMatchObject({
      task: { id: created.task.id }, replayed: true
    })
    await expect(reopened.recordDispatchIntent(dispatchRequest)).resolves.toMatchObject({
      commandId: dispatched.commandId, replayed: true
    })
  })
})
