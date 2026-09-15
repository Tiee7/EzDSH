import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EmployeeDefinition } from '../../src/shared/employees.js'
import type { EmployeeRunStartRequest } from '../../src/shared/employee-runs.js'
import {
  DEFAULT_RESEARCH_EMPLOYEE,
  EmployeeService,
  type EmployeeRunClient,
} from '../../src/main/employees/employee-service.js'
import { EmployeeRunStore } from '../../src/main/employees/employee-run-store.js'
import { EmployeeRunService } from '../../src/main/employees/employee-run-service.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-employee-run-service-'))
  directories.push(directory)
  return directory
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function request(overrides: Partial<EmployeeRunStartRequest> = {}): EmployeeRunStartRequest {
  return {
    commandId: 'command-1',
    employeeId: DEFAULT_RESEARCH_EMPLOYEE.id,
    task: { description: '核实三项变化', taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 2 },
    context: { cwd: '/trusted/project', projectId: 'project-1' },
    ...overrides,
  }
}

async function createRunService(options: {
  directory?: string
  client?: EmployeeRunClient
  employee?: EmployeeDefinition
  store?: EmployeeRunStore
} = {}): Promise<{ service: EmployeeRunService; store: EmployeeRunStore; client: EmployeeRunClient; directory: string }> {
  const directory = options.directory ?? await temporaryDirectory()
  const client = options.client ?? {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    sendPrompt: vi.fn().mockResolvedValue({ text: '最终结果' }),
  }
  const store = options.store ?? new EmployeeRunStore(directory)
  const employee = options.employee ?? structuredClone(DEFAULT_RESEARCH_EMPLOYEE)
  const service = new EmployeeRunService({
    store,
    cwd: '/trusted/project',
    createClient: () => client,
    resolveEmployee: (id) => id === employee.id ? structuredClone(employee) : undefined,
  })
  await service.initialize()
  return { service, store, client, directory }
}

describe('EmployeeRunService', () => {
  it('returns a durable queued run before deferred prompt completion and exposes the final result', async () => {
    const response = deferred<{ text: string }>()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn(() => response.promise),
    }
    const { service } = await createRunService({ client })
    const events: string[] = []
    service.watch((event) => events.push(event.run.status))

    const started = await service.start(request())

    expect(started).toMatchObject({ replayed: false, run: { status: 'queued', dispatchStage: 'recorded' } })
    expect(await service.get(started.run.runId)).toMatchObject({ runId: started.run.runId })
    expect(await service.list()).toHaveLength(1)
    await vi.waitFor(() => expect(client.sendPrompt).toHaveBeenCalledTimes(1))
    expect((await service.get(started.run.runId))?.status).toBe('running')

    response.resolve({ text: ' 核实完成 ' })
    await vi.waitFor(async () => expect(await service.get(started.run.runId)).toMatchObject({
      status: 'completed',
      output: '核实完成',
      partialOutput: '',
      completedAt: expect.any(String),
    }))
    expect(events).toEqual(expect.arrayContaining(['running', 'completed']))
  })

  it('replays a command once, classifies changed input, and does not resend after restart', async () => {
    const directory = await temporaryDirectory()
    const firstClient: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '完成' }),
    }
    const first = await createRunService({ directory, client: firstClient })
    const created = await first.service.start(request())
    await vi.waitFor(async () => expect((await first.service.get(created.run.runId))?.status).toBe('completed'))
    const replay = await first.service.start(request())

    expect(replay).toEqual({ run: await first.service.get(created.run.runId), replayed: true })
    expect(firstClient.sendPrompt).toHaveBeenCalledTimes(1)
    await expect(first.service.start(request({ task: { description: '不同任务' } }))).rejects.toMatchObject({
      code: 'COMMAND_ID_CONFLICT',
    })

    const restartedClient: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'unused' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '不应执行' }),
    }
    const restarted = await createRunService({ directory, client: restartedClient })
    const restartedReplay = await restarted.service.start(request())
    expect(restartedReplay.run.runId).toBe(created.run.runId)
    expect(restartedReplay.replayed).toBe(true)
    expect(restartedClient.createSession).not.toHaveBeenCalled()
    expect(restartedClient.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not prompt or expose a run when its initial durable write fails', async () => {
    const directory = await temporaryDirectory()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '不应执行' }),
    }
    const store = new EmployeeRunStore(directory, {
      rename: async () => { throw new Error('simulated initial write failure') },
    })
    const { service } = await createRunService({ directory, client, store })
    const listener = vi.fn()
    const lockListener = vi.fn()
    service.watch(listener)
    service.watchSessionLocks(lockListener)

    await expect(service.start(request())).rejects.toThrow('simulated initial write failure')

    expect(client.sendPrompt).not.toHaveBeenCalled()
    expect(await service.list()).toEqual([])
    expect(service.listSessionLocks()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    expect(lockListener).not.toHaveBeenCalled()
  })

  it('does not prompt when persisting the running transition fails after the queued record', async () => {
    const directory = await temporaryDirectory()
    let replacements = 0
    const store = new EmployeeRunStore(directory, {
      rename: async (from, to) => {
        replacements += 1
        if (replacements === 2) throw new Error('simulated pre-prompt transition failure')
        await rename(from, to)
      },
    })
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '不应执行' }),
    }
    const { service } = await createRunService({ directory, client, store })

    const started = await service.start(request())

    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('failed'))
    expect(client.sendPrompt).not.toHaveBeenCalled()
    expect(service.listSessionLocks()).toEqual([])
  })

  it('creates isolated sessions for projects and rejects a second run sharing a locked explicit session', async () => {
    const pending = deferred<{ text: string }>()
    let sessionIndex = 0
    const client: EmployeeRunClient = {
      createSession: vi.fn(async () => ({ sessionId: `new-session-${++sessionIndex}` })),
      sendPrompt: vi.fn((sessionId) => sessionId === 'shared-session' ? pending.promise : Promise.resolve({ text: '完成' })),
      listWorkspaces: vi.fn().mockResolvedValue([
        { workspaceId: 'project-1', path: '/one', title: '同名', sessionIds: ['shared-session'] },
        { workspaceId: 'project-2', path: '/two', title: '同名', sessionIds: [] },
      ]),
    }
    const { service } = await createRunService({ client })

    const projectOne = await service.start(request({ commandId: 'project-1-command' }))
    const projectTwo = await service.start(request({ commandId: 'project-2-command', context: { cwd: '/trusted/project', projectId: 'project-2' } }))
    expect(client.createSession).toHaveBeenNthCalledWith(1, { cwd: '/trusted/project', workspaceId: 'project-1' })
    expect(client.createSession).toHaveBeenNthCalledWith(2, { cwd: '/trusted/project', workspaceId: 'project-2' })

    const explicit = await service.start(request({
      commandId: 'shared-1',
      context: { cwd: '/trusted/project', projectId: 'project-1', sessionId: 'shared-session' },
    }))
    await vi.waitFor(() => expect(service.listSessionLocks()).toContainEqual(expect.objectContaining({
      runId: explicit.run.runId,
      sessionId: 'shared-session',
    })))
    await expect(service.start(request({
      commandId: 'shared-2',
      context: { cwd: '/trusted/project', projectId: 'project-1', sessionId: 'shared-session' },
    }))).rejects.toThrow(/locked/i)
    pending.resolve({ text: '共享会话完成' })
    await Promise.all([
      service.waitForTerminal(projectOne.run.runId),
      service.waitForTerminal(projectTwo.run.runId),
      service.waitForTerminal(explicit.run.runId),
    ])
  })

  it('accepts an explicitly verified Main session when the client cannot list workspaces', async () => {
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'unused' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '完成' }),
    }
    const { service } = await createRunService({ client })

    const started = await service.start(request({
      context: {
        cwd: '/trusted/project',
        projectId: 'project-1',
        sessionId: 'known-session',
        sessionVerification: 'trusted-main',
      },
    }))
    expect(started).toMatchObject({
      run: { sessionId: 'known-session', sessionEvidence: 'trusted-main' },
    })
    expect(client.createSession).not.toHaveBeenCalled()
    await service.waitForTerminal(started.run.runId)
  })

  it('keeps a dispatched cancellation as a request until the prompt reaches an observable outcome', async () => {
    const response = deferred<{ text: string }>()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn(() => response.promise),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }
    const { service } = await createRunService({ client })
    const started = await service.start(request())
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('running'))

    const cancellation = await service.cancel(started.run.runId, '用户请求停止')

    expect(cancellation).toMatchObject({
      status: 'cancelling',
      dispatchStage: 'cancel-requested',
      cancelReason: '用户请求停止',
    })
    expect(client.cancelSession).toHaveBeenCalledWith('session-1')
    expect(service.listSessionLocks()).toHaveLength(1)
    response.resolve({ text: '执行端在取消竞态中完成' })
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('completed'))
  })

  it('keeps the lock and normal completion when force-unlock persistence fails', async () => {
    const directory = await temporaryDirectory()
    const response = deferred<{ text: string }>()
    let replacements = 0
    const store = new EmployeeRunStore(directory, {
      rename: async (from, to) => {
        replacements += 1
        if (replacements === 3) throw new Error('simulated force-unlock persistence failure')
        await rename(from, to)
      },
    })
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn(() => response.promise),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }
    const { service } = await createRunService({ directory, client, store })
    const started = await service.start(request())
    await vi.waitFor(async () => expect(await service.get(started.run.runId)).toMatchObject({ status: 'running' }))

    await expect(service.forceUnlockSession('session-1')).rejects.toThrow('simulated force-unlock persistence failure')

    const afterFailure = await service.get(started.run.runId)
    expect(afterFailure).toMatchObject({ status: 'running' })
    expect(afterFailure).not.toHaveProperty('error')
    expect(service.listSessionLocks()).toEqual([expect.objectContaining({
      sessionId: 'session-1',
      runId: started.run.runId,
    })])
    expect(client.cancelSession).not.toHaveBeenCalled()
    response.resolve({ text: '正常完成' })
    const terminal = await service.waitForTerminal(started.run.runId)
    expect(terminal).toMatchObject({
      status: 'completed',
      output: '正常完成',
    })
    expect(terminal).not.toHaveProperty('error')
    await vi.waitFor(() => expect(service.listSessionLocks()).toEqual([]))
  })

  it('never submits a prompt after queued cancellation wins the dispatch claim race', async () => {
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '不应执行' }),
    }
    const { service, store } = await createRunService({ client })
    const dispatchRead = deferred<void>()
    const resumeDispatch = deferred<void>()
    const realGet = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementationOnce(async (runId) => {
      const snapshot = await realGet(runId)
      dispatchRead.resolve()
      await resumeDispatch.promise
      return snapshot
    })
    const started = await service.start(request())
    await dispatchRead.promise

    const cancellation = await service.cancel(started.run.runId, '排队时取消')
    expect(cancellation).toMatchObject({
      status: 'cancelled',
      dispatchStage: 'cancelled-before-dispatch',
    })
    resumeDispatch.resolve()
    await vi.waitFor(() => expect(service.listSessionLocks()).toEqual([]))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(client.sendPrompt).not.toHaveBeenCalled()
    expect(await realGet(started.run.runId)).toMatchObject({
      status: 'cancelled',
      dispatchStage: 'cancelled-before-dispatch',
    })
  })

  it('returns the durable terminal record when completion wins a stale cancel race', async () => {
    const response = deferred<{ text: string }>()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn(() => response.promise),
      cancelSession: vi.fn().mockResolvedValue(undefined),
    }
    const { service, store } = await createRunService({ client })
    const started = await service.start(request())
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('running'))
    const cancelRead = deferred<void>()
    const resumeCancel = deferred<void>()
    const realGet = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementationOnce(async (runId) => {
      const snapshot = await realGet(runId)
      cancelRead.resolve()
      await resumeCancel.promise
      return snapshot
    })

    const cancellationPromise = service.cancel(started.run.runId, '迟到的取消')
    await cancelRead.promise
    response.resolve({ text: '先完成' })
    await vi.waitFor(async () => expect(await realGet(started.run.runId)).toMatchObject({
      status: 'completed',
      output: '先完成',
    }))
    resumeCancel.resolve()
    const cancellation = await cancellationPromise

    expect(cancellation).toMatchObject({ status: 'completed', output: '先完成' })
    expect(await realGet(started.run.runId)).toMatchObject({ status: 'completed', output: '先完成' })
    expect(client.cancelSession).not.toHaveBeenCalled()
    expect(service.listSessionLocks()).toEqual([])
  })

  it('does not miss a terminal update that lands while terminal waiting begins', async () => {
    const response = deferred<{ text: string }>()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn(() => response.promise),
    }
    const { service, store } = await createRunService({ client })
    const started = await service.start(request())
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('running'))
    const realGet = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementationOnce(async (runId) => {
      const before = await realGet(runId)
      const now = new Date().toISOString()
      await store.update(runId, {
        status: 'completed',
        dispatchStage: 'completed',
        output: '竞态完成',
        updatedAt: now,
        completedAt: now,
      })
      return before
    })

    const terminal = await Promise.race([
      service.waitForTerminal(started.run.runId),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('terminal update was missed')), 100)),
    ])

    expect(terminal).toMatchObject({ status: 'completed', output: '竞态完成' })
    response.resolve({ text: '最终调用完成' })
    await vi.waitFor(() => expect(service.listSessionLocks()).toEqual([]))
  })

  it('captures an immutable employee snapshot and leaves one-off task data out of employees.json', async () => {
    const root = await temporaryDirectory()
    const client: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: '完成' }),
    }
    const employees = new EmployeeService({
      configPath: join(root, 'employees.json'),
      cwd: root,
      createClient: () => client,
    })
    await employees.initialize()
    const before = employees.get(DEFAULT_RESEARCH_EMPLOYEE.id)
    const runPromise = employees.run(DEFAULT_RESEARCH_EMPLOYEE.id, { task: '一次性机密代号：ORCHID' })
    await vi.waitFor(() => expect(client.sendPrompt).toHaveBeenCalledTimes(1))
    await employees.update(DEFAULT_RESEARCH_EMPLOYEE.id, { role: '已变更岗位' })
    await employees.remove(DEFAULT_RESEARCH_EMPLOYEE.id)
    await runPromise

    const persistedRuns = JSON.parse(await readFile(join(root, 'employee-runs.json'), 'utf8')) as {
      runs: Record<string, { employeeVersion: number; employeeSnapshot: EmployeeDefinition }>
    }
    const savedRun = Object.values(persistedRuns.runs)[0]
    expect(savedRun).toMatchObject({
      employeeVersion: before?.version,
      employeeSnapshot: { role: before?.role },
    })
    expect(employees.get(DEFAULT_RESEARCH_EMPLOYEE.id)).toBeUndefined()
    const employeeFile = await readFile(join(root, 'employees.json'), 'utf8')
    expect(employeeFile).not.toContain('ORCHID')
  })

  it('rejects non-serializable task input before calling the prompt', async () => {
    const { service, client } = await createRunService()
    const circular: { description: string; self?: unknown } = { description: '循环' }
    circular.self = circular

    await expect(service.start(request({ task: circular }))).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
    expect(client.createSession).not.toHaveBeenCalled()
    expect(client.sendPrompt).not.toHaveBeenCalled()
  })
})
