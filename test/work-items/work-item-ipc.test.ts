import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EzDSHBridge } from '../../src/shared/contracts.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'
import { WorkItemService } from '../../src/main/work-items/work-item-service.js'
import { WorkItemStore } from '../../src/main/work-items/work-item-store.js'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron,
}))

const directories: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function realWorkItems(): Promise<{ service: WorkItemService; task: WorkTaskSnapshot }> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-ipc-'))
  directories.push(directory)
  const service = new WorkItemService(new WorkItemStore(directory))
  await service.initialize()
  const task = await service.create({
    requestId: 'create-offline',
    title: 'Offline task',
    goal: 'Remain readable',
    acceptance: 'No Runtime call',
    scope: { projectId: 'project-1', resourceRefs: [] },
  })
  return { service, task }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('WorkItem IPC registration and workspace ownership', () => {
  it('restores state, constructs services, and attaches listeners before opening dispatch', async () => {
    const { initializeWorkItemIpcWorkspace } = await import('../../src/main/work-items/work-item-ipc.js')
    const order: string[] = []
    const restored = deferred<{ workspace: string }>()
    let listenerScope: unknown
    const services = {
      workItems: {
        list: vi.fn(async () => { order.push('dispatch'); return [] }),
        get: vi.fn(), create: vi.fn(), revise: vi.fn(), acceptArtifact: vi.fn(),
      },
      execution: { execute: vi.fn() },
      cancellation: { cancelTask: vi.fn() },
      actions: { controlRun: vi.fn(), answerAction: vi.fn() },
    }
    const initializing = initializeWorkItemIpcWorkspace({
      restore: () => { order.push('restore'); return restored.promise },
      construct: (state) => { order.push(`construct:${state.workspace}`); return services },
      attachListeners: (_services, _state, scope) => { listenerScope = scope; order.push('listeners'); return [vi.fn()] },
    })
    await Promise.resolve()
    expect(order).toEqual(['restore'])

    restored.resolve({ workspace: 'a' })
    const scope = await initializing
    expect(listenerScope).toBe(scope)
    expect(order).toEqual(['restore', 'construct:a', 'listeners'])
    await scope.invoke((current) => current.workItems.list())
    expect(order).toEqual(['restore', 'construct:a', 'listeners', 'dispatch'])
  })

  it('uses the existing EmployeeRunService through a typed Main-only EmployeeService port', async () => {
    const { EmployeeService } = await import('../../src/main/employees/employee-service.js')
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-employee-port-'))
    directories.push(directory)
    const prompt = deferred<{ text: string }>()
    const client = {
      createSession: vi.fn(async () => ({ sessionId: 'employee-session' })),
      sendPrompt: vi.fn(() => prompt.promise),
      cancelSession: vi.fn(async () => ({ accepted: true })),
    }
    const employees = new EmployeeService({
      configPath: join(directory, 'employees.json'),
      cwd: directory,
      createClient: () => client,
    })
    await employees.initialize()

    const receipt = await employees.startWorkItemRun({
      commandId: 'command-1',
      employeeId: 'researcher',
      task: { description: 'Research', taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 1 },
      context: { cwd: directory },
    })
    expect((await employees.getWorkItemRun(receipt.run.runId))?.commandId).toBe('command-1')
    expect(await employees.listWorkItemRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: receipt.run.runId, taskId: 'task-1' }),
    ]))
    await expect(employees.cancelWorkItemRun(receipt.run.runId)).resolves.toMatchObject({ runId: receipt.run.runId })
    prompt.resolve({ text: 'late result' })
    await vi.waitFor(async () => {
      expect((await employees.getWorkItemRun(receipt.run.runId))?.status).toMatch(/completed|cancelled/)
    })
  })

  it('registers the exact channels and leaves list/get available while execution capability is offline', async () => {
    const { createWorkItemIpcWorkspaceScope, registerWorkItemIpc } = await import('../../src/main/work-items/work-item-ipc.js')
    const { service, task } = await realWorkItems()
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>()
    const assertExecutionAvailable = vi.fn(() => { throw Object.assign(new Error('DSH Runtime 尚未启动'), { code: 'RUNTIME_OFFLINE' }) })
    const cancelTask = vi.fn(async () => task)
    const scope = createWorkItemIpcWorkspaceScope({
      workItems: service,
      execution: { execute: vi.fn() },
      cancellation: { cancelTask },
      actions: { controlRun: vi.fn(), answerAction: vi.fn() },
      assertExecutionAvailable,
    })
    registerWorkItemIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, () => scope)

    expect([...handlers.keys()]).toEqual([
      'work-items:list',
      'work-items:get',
      'work-items:create',
      'work-items:execute',
      'work-items:revise',
      'work-items:cancel-task',
      'work-items:archive',
      'work-items:accept-artifact',
      'work-items:open-artifact',
      'work-items:control-run',
      'work-items:answer-action',
    ])
    await expect(handlers.get('work-items:list')!({}, { projectId: 'project-1' }))
      .resolves.toEqual({ ok: true, data: [task] })
    await expect(handlers.get('work-items:list')!({}, { projectId: 'project-1', includeArchived: true }))
      .resolves.toEqual({ ok: true, data: [task] })
    await expect(handlers.get('work-items:get')!({}, task.task.id))
      .resolves.toEqual({ ok: true, data: task })
    await expect(handlers.get('work-items:cancel-task')!({}, {
      requestId: 'cancel-offline', taskId: task.task.id, expectedRevision: task.task.revision,
    })).resolves.toEqual({ ok: true, data: task })
    expect(cancelTask).toHaveBeenCalledWith({
      requestId: 'cancel-offline', taskId: task.task.id, expectedRevision: task.task.revision,
    })
    expect(assertExecutionAvailable).not.toHaveBeenCalled()

    const execute = await handlers.get('work-items:execute')!({}, {
      requestId: 'execute-offline', taskId: task.task.id, expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: null,
    })
    expect(execute).toMatchObject({ ok: false, error: { code: 'RUNTIME_OFFLINE', message: 'DSH Runtime 尚未启动' } })
    expect(scope.services.execution.execute).not.toHaveBeenCalled()
  })

  it('validates unknown and invalid payloads before service dispatch and serializes classified failures', async () => {
    const { createWorkItemIpcWorkspaceScope, registerWorkItemIpc } = await import('../../src/main/work-items/work-item-ipc.js')
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<any>>()
    const workItems = {
      list: vi.fn(async () => []), get: vi.fn(async () => undefined), create: vi.fn(),
      revise: vi.fn(), archive: vi.fn(), acceptArtifact: vi.fn(), openArtifact: vi.fn(),
    }
    const execution = { execute: vi.fn() }
    const cancellation = { cancelTask: vi.fn() }
    const actions = { controlRun: vi.fn(), answerAction: vi.fn() }
    registerWorkItemIpc(
      { handle: (channel, listener) => { handlers.set(channel, listener) } },
      () => createWorkItemIpcWorkspaceScope({ workItems, execution, cancellation, actions }),
    )

    const unknownQuery = await handlers.get('work-items:list')!({}, { projectId: 'project', permissions: ['all'] })
    expect(unknownQuery).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
    expect(workItems.list).not.toHaveBeenCalled()

    const invalidArchiveQuery = await handlers.get('work-items:list')!({}, { includeArchived: 'yes' })
    expect(invalidArchiveQuery).toMatchObject({ ok: false, error: { code: 'INVALID_TYPE' } })
    expect(workItems.list).not.toHaveBeenCalled()

    const invalidGet = await handlers.get('work-items:get')!({}, '   ')
    expect(invalidGet).toMatchObject({ ok: false, error: { code: 'EMPTY_STRING' } })
    expect(workItems.get).not.toHaveBeenCalled()

    const unknownCreate = await handlers.get('work-items:create')!({}, {
      requestId: 'create', title: 'Task', goal: 'Goal', acceptance: 'Done',
      scope: { resourceRefs: [], authorizePath: '/private' },
    })
    expect(unknownCreate).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
    expect(workItems.create).not.toHaveBeenCalled()

    const invalidArchive = await handlers.get('work-items:archive')!({}, {
      requestId: 'archive', taskId: 'task-1', expectedRevision: 1, archived: 'yes',
    })
    expect(invalidArchive).toMatchObject({ ok: false, error: { code: 'INVALID_TYPE' } })
    expect(workItems.archive).not.toHaveBeenCalled()

    const unknownCancel = await handlers.get('work-items:cancel-task')!({}, {
      requestId: 'cancel', taskId: 'task-1', expectedRevision: 1, force: true,
    })
    expect(unknownCancel).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
    expect(cancellation.cancelTask).not.toHaveBeenCalled()

    const invalidOpen = await handlers.get('work-items:open-artifact')!({}, { taskId: 'task-1', artifactId: 'artifact-1', storedPath: '/tmp/private' })
    expect(invalidOpen).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } })
    expect(workItems.openArtifact).not.toHaveBeenCalled()

    workItems.revise.mockRejectedValueOnce(Object.assign(new Error('Revision conflict'), { code: 'REVISION_CONFLICT' }))
    const failed = await handlers.get('work-items:revise')!({}, {
      requestId: 'revise', taskId: 'task-1', expectedRevision: 1, goal: 'New goal', acceptance: 'New check',
    })
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'Revision conflict', requestId: expect.any(String), retryable: true },
    })
  })

  it('routes every mutation to its owning service with validated payloads', async () => {
    const { createWorkItemIpcWorkspaceScope, registerWorkItemIpc } = await import('../../src/main/work-items/work-item-ipc.js')
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<any>>()
    const snapshot = { task: { id: 'task-1' } } as WorkTaskSnapshot
    const workItems = {
      list: vi.fn(), get: vi.fn(), create: vi.fn(async () => snapshot), revise: vi.fn(async () => snapshot),
      archive: vi.fn(async () => snapshot), acceptArtifact: vi.fn(async () => snapshot), openArtifact: vi.fn(async () => undefined),
    }
    const execution = { execute: vi.fn(async () => snapshot) }
    const cancellation = { cancelTask: vi.fn(async () => snapshot) }
    const actions = { controlRun: vi.fn(async () => snapshot), answerAction: vi.fn(async () => snapshot) }
    const assertExecutionAvailable = vi.fn()
    registerWorkItemIpc(
      { handle: (channel, listener) => { handlers.set(channel, listener) } },
      () => createWorkItemIpcWorkspaceScope({ workItems, execution, cancellation, actions, assertExecutionAvailable }),
    )
    const requests = {
      create: { requestId: 'create', title: ' Task ', goal: ' Goal ', acceptance: ' Done ', scope: { resourceRefs: [] } },
      execute: { requestId: 'execute', taskId: 'task-1', expectedRevision: 1, executor: { kind: 'workflow' as const, workflowId: 'workflow-1' }, mode: 'initial' as const, input: null },
      revise: { requestId: 'revise', taskId: 'task-1', expectedRevision: 1, goal: ' New ', acceptance: ' Check ' },
      cancel: { requestId: 'cancel', taskId: 'task-1', expectedRevision: 1 },
      archive: { requestId: 'archive', taskId: 'task-1', expectedRevision: 1, archived: true },
      accept: { requestId: 'accept', taskId: 'task-1', expectedRevision: 1, artifactId: 'artifact-1', contentVersion: 1, requirementVersion: 1 },
      open: { taskId: 'task-1', artifactId: 'artifact-1' },
      control: { requestId: 'control', taskId: 'task-1', runId: 'run-1', expectedRevision: 1, action: 'cancel' as const },
      answer: { requestId: 'answer', taskId: 'task-1', actionId: 'action-1', expectedSourceEventId: 'event-1', expectedRequirementVersion: 1, answer: true },
    }

    await handlers.get('work-items:create')!({}, requests.create)
    await handlers.get('work-items:execute')!({}, requests.execute)
    await handlers.get('work-items:revise')!({}, requests.revise)
    await handlers.get('work-items:cancel-task')!({}, requests.cancel)
    await handlers.get('work-items:archive')!({}, requests.archive)
    await handlers.get('work-items:accept-artifact')!({}, requests.accept)
    await handlers.get('work-items:open-artifact')!({}, requests.open)
    await handlers.get('work-items:control-run')!({}, requests.control)
    await handlers.get('work-items:answer-action')!({}, requests.answer)

    expect(workItems.create).toHaveBeenCalledWith({ ...requests.create, title: 'Task', goal: 'Goal', acceptance: 'Done' })
    expect(execution.execute).toHaveBeenCalledWith(requests.execute)
    expect(workItems.revise).toHaveBeenCalledWith({ ...requests.revise, goal: 'New', acceptance: 'Check' })
    expect(cancellation.cancelTask).toHaveBeenCalledWith(requests.cancel)
    expect(workItems.archive).toHaveBeenCalledWith(requests.archive)
    expect(workItems.acceptArtifact).toHaveBeenCalledWith(requests.accept)
    expect(workItems.openArtifact).toHaveBeenCalledWith('task-1', 'artifact-1')
    expect(actions.controlRun).toHaveBeenCalledWith(requests.control)
    expect(actions.answerAction).toHaveBeenCalledWith(requests.answer)
    expect(assertExecutionAvailable.mock.calls.map(([operation]) => operation)).toEqual(['execute', 'control-run', 'answer-action'])
  })

  it('canonicalizes trusted workspace cwd on create and reauthorizes it before execute', async () => {
    const {
      createWorkItemIpcWorkspaceScope,
      createWorkItemScopeAuthorizer,
      registerWorkItemIpc,
    } = await import('../../src/main/work-items/work-item-ipc.js')
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-scope-'))
    directories.push(directory)
    const workspace = join(directory, 'workspace')
    await mkdir(join(workspace, 'projects', 'alpha'), { recursive: true })
    const canonicalCwd = await realpath(join(workspace, 'projects', 'alpha'))
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<any>>()
    const created = { task: { id: 'task-1' } } as WorkTaskSnapshot
    const persisted = {
      task: {
        id: 'task-1',
        scope: { projectId: 'project-1', cwd: canonicalCwd, resourceRefs: ['brief.md'] },
      },
    } as WorkTaskSnapshot
    const workItems = {
      list: vi.fn(),
      get: vi.fn(async () => persisted),
      create: vi.fn(async () => created),
      revise: vi.fn(),
      acceptArtifact: vi.fn(),
    }
    const execution = { execute: vi.fn(async () => persisted) }
    const authorizeScope = await createWorkItemScopeAuthorizer(workspace)
    registerWorkItemIpc(
      { handle: (channel, listener) => { handlers.set(channel, listener) } },
      () => createWorkItemIpcWorkspaceScope({
        workItems,
        execution,
        cancellation: { cancelTask: vi.fn() },
        actions: { controlRun: vi.fn(), answerAction: vi.fn() },
        authorizeScope,
      }),
    )

    await expect(handlers.get('work-items:create')!({}, {
      requestId: 'create',
      title: 'Task',
      goal: 'Goal',
      acceptance: 'Done',
      scope: { projectId: 'project-1', cwd: 'projects/alpha', resourceRefs: ['brief.md'] },
    })).resolves.toEqual({ ok: true, data: created })
    expect(workItems.create).toHaveBeenCalledWith(expect.objectContaining({
      scope: { projectId: 'project-1', cwd: canonicalCwd, resourceRefs: ['brief.md'] },
    }))

    const request = {
      requestId: 'execute', taskId: 'task-1', expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: null,
    }
    await expect(handlers.get('work-items:execute')!({}, request)).resolves.toEqual({ ok: true, data: persisted })
    expect(workItems.get).toHaveBeenCalledWith('task-1')
    expect(execution.execute).toHaveBeenCalledWith(request)
  })

  it('rejects out-of-workspace and symlink-escaped cwd on create and persisted execute', async () => {
    const {
      createWorkItemIpcWorkspaceScope,
      createWorkItemScopeAuthorizer,
      registerWorkItemIpc,
    } = await import('../../src/main/work-items/work-item-ipc.js')
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-scope-escape-'))
    directories.push(directory)
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ])
    await symlink(outside, join(workspace, 'escape'))
    const handlers = new Map<string, (event: unknown, request?: unknown) => Promise<any>>()
    const workItems = {
      list: vi.fn(),
      get: vi.fn(async () => ({
        task: { id: 'task-1', scope: { cwd: outside, resourceRefs: [] } },
      }) as WorkTaskSnapshot),
      create: vi.fn(),
      revise: vi.fn(),
      acceptArtifact: vi.fn(),
    }
    const execution = { execute: vi.fn() }
    const authorizeScope = await createWorkItemScopeAuthorizer(workspace)
    registerWorkItemIpc(
      { handle: (channel, listener) => { handlers.set(channel, listener) } },
      () => createWorkItemIpcWorkspaceScope({
        workItems,
        execution,
        cancellation: { cancelTask: vi.fn() },
        actions: { controlRun: vi.fn(), answerAction: vi.fn() },
        authorizeScope,
      }),
    )
    const createRequest = {
      requestId: 'create', title: 'Task', goal: 'Goal', acceptance: 'Done',
      scope: { resourceRefs: [] },
    }

    await expect(handlers.get('work-items:create')!({}, {
      ...createRequest,
      scope: { cwd: outside, resourceRefs: [] },
    })).resolves.toMatchObject({ ok: false, error: { code: 'WORK_ITEM_SCOPE_UNAUTHORIZED' } })
    await expect(handlers.get('work-items:create')!({}, {
      ...createRequest,
      scope: { cwd: 'escape/new-child', resourceRefs: [] },
    })).resolves.toMatchObject({ ok: false, error: { code: 'WORK_ITEM_SCOPE_UNAUTHORIZED' } })
    expect(workItems.create).not.toHaveBeenCalled()

    await expect(handlers.get('work-items:execute')!({}, {
      requestId: 'execute', taskId: 'task-1', expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'researcher' }, mode: 'initial', input: null,
    })).resolves.toMatchObject({ ok: false, error: { code: 'WORK_ITEM_SCOPE_UNAUTHORIZED' } })
    expect(execution.execute).not.toHaveBeenCalled()
  })

  it('closes admission, removes exact listeners, and drains old workspace operations before replacement', async () => {
    const { createWorkItemIpcWorkspaceScope } = await import('../../src/main/work-items/work-item-ipc.js')
    const pending = deferred<WorkTaskSnapshot>()
    const pendingObserver = deferred<void>()
    const removeChanged = vi.fn()
    const removeWorkflow = vi.fn()
    const old = createWorkItemIpcWorkspaceScope({
      workItems: { list: vi.fn(), get: vi.fn(), create: vi.fn(() => pending.promise), revise: vi.fn(), acceptArtifact: vi.fn() },
      execution: { execute: vi.fn() },
      cancellation: { cancelTask: vi.fn() },
      actions: { controlRun: vi.fn(), answerAction: vi.fn() },
    }, [removeChanged, removeWorkflow])
    const running = old.invoke((services) => services.workItems.create({} as never))
    const observing = old.invoke(() => pendingObserver.promise)
    const disposing = old.dispose()

    expect(removeChanged).toHaveBeenCalledTimes(1)
    expect(removeWorkflow).toHaveBeenCalledTimes(1)
    await expect(old.invoke((services) => services.workItems.list())).rejects.toMatchObject({ code: 'WORK_ITEM_WORKSPACE_UNAVAILABLE' })
    let disposed = false
    void disposing.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    const snapshot = { task: { id: 'old-task' } } as WorkTaskSnapshot
    pending.resolve(snapshot)
    await expect(running).resolves.toBe(snapshot)
    await Promise.resolve()
    expect(disposed).toBe(false)
    pendingObserver.resolve()
    await observing
    await disposing
    expect(disposed).toBe(true)

    const nextList = vi.fn(async () => [])
    const next = createWorkItemIpcWorkspaceScope({
      workItems: { list: nextList, get: vi.fn(), create: vi.fn(), revise: vi.fn(), acceptArtifact: vi.fn() },
      execution: { execute: vi.fn() },
      cancellation: { cancelTask: vi.fn() },
      actions: { controlRun: vi.fn(), answerAction: vi.fn() },
    })
    await expect(next.invoke((services) => services.workItems.list())).resolves.toEqual([])
    expect(nextList).toHaveBeenCalledTimes(1)
  })

  it('removes the exact Main store listener so the disposed workspace cannot emit later changes', async () => {
    const { createWorkItemIpcWorkspaceScope } = await import('../../src/main/work-items/work-item-ipc.js')
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-listener-'))
    directories.push(directory)
    const store = new WorkItemStore(directory)
    const service = new WorkItemService(store)
    await service.initialize()
    const changed = vi.fn()
    const scope = createWorkItemIpcWorkspaceScope({
      workItems: service,
      execution: { execute: vi.fn() },
      cancellation: { cancelTask: vi.fn() },
      actions: { controlRun: vi.fn(), answerAction: vi.fn() },
    }, [store.onChanged(changed)])

    await scope.invoke((services) => services.workItems.create({
      requestId: 'before-dispose', title: 'First', goal: 'First goal', acceptance: 'First check', scope: { resourceRefs: [] },
    }))
    expect(changed).toHaveBeenCalledTimes(1)
    await scope.dispose()
    await service.create({
      requestId: 'after-dispose', title: 'Second', goal: 'Second goal', acceptance: 'Second check', scope: { resourceRefs: [] },
    })
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('WorkItem preload bridge', () => {
  it('passes every argument through, unwraps failures, and removes the exact changed listener', async () => {
    await import('../../src/preload/index.js')
    const bridge = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'EzDSH')![1] as EzDSHBridge
    electron.invoke.mockResolvedValue({ ok: true, data: {} })
    const request = { requestId: 'request' } as never

    await bridge.workItems.list({ projectId: 'project-1' })
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:list', { projectId: 'project-1' })
    await bridge.workItems.get('task-1')
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:get', 'task-1')
    await bridge.workItems.create(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:create', request)
    await bridge.workItems.execute(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:execute', request)
    await bridge.workItems.revise(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:revise', request)
    await bridge.workItems.cancelTask(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:cancel-task', request)
    await bridge.workItems.archive(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:archive', request)
    await bridge.workItems.acceptArtifact(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:accept-artifact', request)
    await bridge.workItems.openArtifact('task-1', 'artifact-1')
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:open-artifact', { taskId: 'task-1', artifactId: 'artifact-1' })
    await bridge.workItems.controlRun(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:control-run', request)
    await bridge.workItems.answerAction(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('work-items:answer-action', request)

    const listener = vi.fn()
    const unsubscribe = bridge.workItems.onChanged(listener)
    const handler = electron.on.mock.calls.find(([channel]) => channel === 'work-items:changed')![1]
    const snapshot = { task: { id: 'task-1' } } as WorkTaskSnapshot
    handler({}, snapshot)
    expect(listener).toHaveBeenCalledWith(snapshot)
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith('work-items:changed', handler)

    electron.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'TASK_NOT_FOUND', message: 'Task missing', requestId: 'error-request', retryable: false },
    })
    await expect(bridge.workItems.get('missing')).rejects.toMatchObject({
      message: 'Task missing', code: 'TASK_NOT_FOUND', requestId: 'error-request', retryable: false,
    })
  })
})
