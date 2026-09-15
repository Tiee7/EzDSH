import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EmployeeRunService } from '../../src/main/employees/employee-run-service.js'
import { EmployeeRunStore } from '../../src/main/employees/employee-run-store.js'
import {
  DEFAULT_RESEARCH_EMPLOYEE,
  type EmployeeRunClient,
} from '../../src/main/employees/employee-service.js'
import type {
  EmployeeRunObservationResult,
  EmployeeRunStartRequest,
} from '../../src/shared/employee-runs.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-employee-recovery-'))
  directories.push(directory)
  return directory
}

function request(commandId = 'command-1'): EmployeeRunStartRequest {
  return {
    commandId,
    employeeId: DEFAULT_RESEARCH_EMPLOYEE.id,
    task: { description: '核对持久运行' },
    context: { cwd: '/trusted/project', projectId: 'project-1' },
  }
}

async function createService(directory: string, client: EmployeeRunClient): Promise<EmployeeRunService> {
  const service = new EmployeeRunService({
    store: new EmployeeRunStore(directory),
    cwd: '/trusted/project',
    createClient: () => client,
    resolveEmployee: (id) => id === DEFAULT_RESEARCH_EMPLOYEE.id
      ? structuredClone(DEFAULT_RESEARCH_EMPLOYEE)
      : undefined,
  })
  await service.initialize()
  return service
}

function observableClient(options: {
  observation: Promise<EmployeeRunObservationResult>
  cancel?: () => Promise<void | { accepted: boolean }>
  cursor?: number
}): EmployeeRunClient & {
  sendPrompt: ReturnType<typeof vi.fn>
  submitPrompt: ReturnType<typeof vi.fn>
  observeTurn: ReturnType<typeof vi.fn>
  cancelSession: ReturnType<typeof vi.fn>
} {
  return {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    sendPrompt: vi.fn().mockResolvedValue({ text: 'legacy path must not run' }),
    getObservationCursor: vi.fn().mockResolvedValue(options.cursor ?? 2),
    submitPrompt: vi.fn().mockResolvedValue({ accepted: true }),
    observeTurn: vi.fn(() => options.observation),
    cancelSession: vi.fn(options.cancel ?? (async () => ({ accepted: true }))),
  }
}

describe('EmployeeRunService recovery and Runtime cancellation', () => {
  it('keeps an accepted-only cancellation in cancelling with its session occupied', async () => {
    const observation = deferred<EmployeeRunObservationResult>()
    const client = observableClient({ observation: observation.promise })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())
    await vi.waitFor(() => expect(client.submitPrompt).toHaveBeenCalledTimes(1))

    const cancelled = await service.cancel(started.run.runId, '用户请求停止')

    expect(cancelled).toMatchObject({
      status: 'cancelling',
      dispatchStage: 'cancel-requested',
      cancelReason: '用户请求停止',
      cancelRequestState: 'accepted',
    })
    expect(cancelled).not.toHaveProperty('terminalEvidence')
    expect(service.listSessionLocks()).toEqual([expect.objectContaining({ runId: started.run.runId })])
    expect(client.sendPrompt).not.toHaveBeenCalled()
    observation.resolve({
      outcome: 'cancelled', cursor: 4, output: '',
      terminalEvidence: { type: 'turn/end', seq: 4, reasonKind: 'aborted' },
    })
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('cancelled'))
  })

  it('persists a cancellation RPC failure and never resubmits the prompt', async () => {
    const observation = deferred<EmployeeRunObservationResult>()
    const client = observableClient({
      observation: observation.promise,
      cancel: async () => { throw new Error('cancel transport unavailable') },
    })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())
    await vi.waitFor(() => expect(client.submitPrompt).toHaveBeenCalledTimes(1))

    await expect(service.cancel(started.run.runId, '停止')).resolves.toMatchObject({
      status: 'cancelling',
      cancelRequestState: 'failed',
      cancelRequestError: 'cancel transport unavailable',
    })
    expect(client.submitPrompt).toHaveBeenCalledTimes(1)
    expect(client.sendPrompt).not.toHaveBeenCalled()
    expect(service.listSessionLocks()).toHaveLength(1)
    observation.resolve({
      outcome: 'completed', cursor: 5, output: '仍然完成',
      terminalEvidence: { type: 'turn/end', seq: 5, reasonKind: 'completed' },
    })
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('completed'))
  })

  it('records an explicit accepted false cancellation response as failed while observation continues', async () => {
    const observation = deferred<EmployeeRunObservationResult>()
    const client = observableClient({
      observation: observation.promise,
      cancel: async () => ({ accepted: false }),
    })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())
    await vi.waitFor(() => expect(client.submitPrompt).toHaveBeenCalledTimes(1))

    await expect(service.cancel(started.run.runId, '停止')).resolves.toMatchObject({
      status: 'cancelling',
      cancelRequestState: 'failed',
      cancelRequestError: 'Runtime did not accept session cancellation',
    })
    expect(client.submitPrompt).toHaveBeenCalledTimes(1)
    expect(service.listSessionLocks()).toHaveLength(1)

    observation.resolve({
      outcome: 'cancelled', cursor: 5, output: '',
      terminalEvidence: { type: 'turn/end', seq: 5, reasonKind: 'aborted' },
    })
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('cancelled'))
    expect(service.listSessionLocks()).toEqual([])
  })

  it('does not submit after cancellation wins the gap between dispatch claim and Runtime submission', async () => {
    const directory = await temporaryDirectory()
    const observation = deferred<EmployeeRunObservationResult>()
    const client = observableClient({ observation: observation.promise })
    const store = new EmployeeRunStore(directory)
    const service = new EmployeeRunService({
      store,
      cwd: '/trusted/project',
      createClient: () => client,
      resolveEmployee: () => structuredClone(DEFAULT_RESEARCH_EMPLOYEE),
    })
    await service.initialize()
    let cancellation: Promise<unknown> | undefined
    store.subscribe((event) => {
      if (event.run.status === 'running' && cancellation === undefined) {
        cancellation = service.cancel(event.run.runId, 'claim 后取消')
      }
    })

    const started = await service.start(request())
    await vi.waitFor(() => expect(cancellation).toBeDefined())
    await cancellation

    expect(await service.get(started.run.runId)).toMatchObject({
      status: 'cancelling',
      cancelRequestState: 'accepted',
    })
    expect(client.submitPrompt).not.toHaveBeenCalled()
    expect(client.sendPrompt).not.toHaveBeenCalled()
    expect(client.cancelSession).toHaveBeenCalledTimes(1)
    expect(service.listSessionLocks()).toHaveLength(1)
  })

  it('keeps the first reliable terminal result across completion and cancellation callback races', async () => {
    const completion = deferred<EmployeeRunObservationResult>()
    const cancelResponse = deferred<void | { accepted: boolean }>()
    const client = observableClient({ observation: completion.promise, cancel: () => cancelResponse.promise })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())
    await vi.waitFor(() => expect(client.submitPrompt).toHaveBeenCalledTimes(1))

    const cancelling = service.cancel(started.run.runId, '竞态取消')
    await vi.waitFor(() => expect(client.cancelSession).toHaveBeenCalledTimes(1))
    completion.resolve({
      outcome: 'completed', cursor: 8, output: '先完成',
      terminalEvidence: { type: 'turn/end', seq: 8, reasonKind: 'completed' },
    })
    await vi.waitFor(async () => expect(await service.get(started.run.runId)).toMatchObject({
      status: 'completed', output: '先完成',
    }))
    cancelResponse.resolve({ accepted: true })

    await expect(cancelling).resolves.toMatchObject({ status: 'completed', output: '先完成' })
    expect(await service.get(started.run.runId)).toMatchObject({
      status: 'completed', output: '先完成', terminalEvidence: { seq: 8, reasonKind: 'completed' },
    })
    expect(client.submitPrompt).toHaveBeenCalledTimes(1)
  })

  it('keeps a confirmed cancelled terminal when the cancel RPC callback arrives later', async () => {
    const terminal = deferred<EmployeeRunObservationResult>()
    const cancelResponse = deferred<void | { accepted: boolean }>()
    const client = observableClient({ observation: terminal.promise, cancel: () => cancelResponse.promise })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())
    await vi.waitFor(() => expect(client.submitPrompt).toHaveBeenCalledTimes(1))

    const cancelling = service.cancel(started.run.runId, '确认取消')
    await vi.waitFor(() => expect(client.cancelSession).toHaveBeenCalledTimes(1))
    terminal.resolve({
      outcome: 'cancelled', cursor: 8, output: '',
      terminalEvidence: { type: 'turn/end', seq: 8, reasonKind: 'aborted' },
    })
    await vi.waitFor(async () => expect((await service.get(started.run.runId))?.status).toBe('cancelled'))
    cancelResponse.resolve({ accepted: true })

    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' })
    expect(await service.get(started.run.runId)).toMatchObject({
      status: 'cancelled',
      dispatchStage: 'cancelled',
      terminalEvidence: { seq: 8, reasonKind: 'aborted' },
      output: '',
    })
    expect(service.listSessionLocks()).toEqual([])
  })

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'aborted'],
  ] as const)('keeps force-unlock failure semantics after a late %s terminal event', async (outcome, reasonKind) => {
    const observation = deferred<EmployeeRunObservationResult>()
    const client = observableClient({ observation: observation.promise })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())
    await vi.waitFor(() => expect(client.submitPrompt).toHaveBeenCalledTimes(1))

    await service.forceUnlockSession('session-1')
    expect(client.cancelSession).toHaveBeenCalledTimes(1)
    expect(service.listSessionLocks()).toEqual([])
    observation.resolve({
      outcome,
      cursor: 9,
      output: '迟到的成功输出',
      terminalEvidence: { type: 'turn/end', seq: 9, reasonKind },
    })

    await vi.waitFor(async () => expect(await service.get(started.run.runId)).toMatchObject({
      status: 'failed',
      dispatchStage: 'failed',
      cancelReason: 'Employee run was force-unlocked',
      error: 'Employee run was force-unlocked',
      output: '',
      terminalEvidence: { seq: 9, reasonKind },
    }))
    expect(client.submitPrompt).toHaveBeenCalledTimes(1)
    expect(service.listSessionLocks()).toEqual([])
  })

  it('records observer timeout and resumes the original cancelling run from its last cursor after restart', async () => {
    const directory = await temporaryDirectory()
    const observation = deferred<EmployeeRunObservationResult>()
    const firstClient = observableClient({ observation: observation.promise, cursor: 2 })
    const first = await createService(directory, firstClient)
    const started = await first.start(request())
    await vi.waitFor(() => expect(firstClient.submitPrompt).toHaveBeenCalledTimes(1))
    await first.cancel(started.run.runId, '停止但尚未确认')
    observation.resolve({ outcome: 'timeout', cursor: 6, output: '部分', error: 'observer deadline' })
    await vi.waitFor(async () => expect(await first.get(started.run.runId)).toMatchObject({
      status: 'cancelling',
      observerState: 'timeout',
      observationCursor: 6,
      observationError: 'observer deadline',
    }))
    expect(first.listSessionLocks()).toHaveLength(1)

    const resumedResult: EmployeeRunObservationResult = {
      outcome: 'completed', cursor: 9, output: '执行端最终完成',
      terminalEvidence: { type: 'turn/end', seq: 9, reasonKind: 'completed' },
    }
    const restartedClient = observableClient({ observation: Promise.resolve(resumedResult), cursor: 100 })
    const restarted = await createService(directory, restartedClient)

    await vi.waitFor(async () => expect(await restarted.get(started.run.runId)).toMatchObject({
      runId: started.run.runId,
      status: 'completed',
      output: '执行端最终完成',
    }))
    expect(restartedClient.observeTurn).toHaveBeenCalledWith('session-1', expect.objectContaining({
      afterSeq: 6,
      requestId: started.run.promptRequestId,
    }))
    expect(firstClient.submitPrompt).toHaveBeenCalledTimes(1)
    expect(restartedClient.submitPrompt).not.toHaveBeenCalled()
    expect(restarted.listSessionLocks()).toEqual([])
  })

  it('records disconnect as an unknown interrupted outcome without releasing occupancy', async () => {
    const result: EmployeeRunObservationResult = {
      outcome: 'disconnected', cursor: 7, output: '已观察片段', error: 'history connection closed',
    }
    const client = observableClient({ observation: Promise.resolve(result), cursor: 3 })
    const service = await createService(await temporaryDirectory(), client)
    const started = await service.start(request())

    await vi.waitFor(async () => expect(await service.get(started.run.runId)).toMatchObject({
      status: 'interrupted',
      dispatchStage: 'outcome-unknown',
      observerState: 'disconnected',
      observationCursor: 7,
      observationError: 'history connection closed',
      partialOutput: '已观察片段',
    }))
    expect(service.listSessionLocks()).toEqual([expect.objectContaining({ runId: started.run.runId })])
    expect(client.submitPrompt).toHaveBeenCalledTimes(1)

    await service.forceUnlockSession('session-1')
    expect(await service.get(started.run.runId)).toMatchObject({
      status: 'interrupted',
      cancelReason: 'Employee run was force-unlocked',
    })
    expect(service.listSessionLocks()).toEqual([])
    expect(client.cancelSession).toHaveBeenCalledTimes(1)
  })

  it('classifies a legacy persisted running outcome as unknown after restart without replaying it', async () => {
    const directory = await temporaryDirectory()
    const response = deferred<{ text: string }>()
    const firstClient: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      sendPrompt: vi.fn(() => response.promise),
    }
    const first = await createService(directory, firstClient)
    const started = await first.start(request())
    await vi.waitFor(() => expect(firstClient.sendPrompt).toHaveBeenCalledTimes(1))

    const restartedClient: EmployeeRunClient = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'unused' }),
      sendPrompt: vi.fn().mockResolvedValue({ text: 'must not replay' }),
    }
    const restarted = await createService(directory, restartedClient)

    await vi.waitFor(async () => expect(await restarted.get(started.run.runId)).toMatchObject({
      runId: started.run.runId,
      status: 'interrupted',
      dispatchStage: 'outcome-unknown',
      observerState: 'unsupported',
      observationError: expect.stringMatching(/cannot be reconciled safely/),
    }))
    expect(firstClient.sendPrompt).toHaveBeenCalledTimes(1)
    expect(restartedClient.sendPrompt).not.toHaveBeenCalled()
    expect(restartedClient.createSession).not.toHaveBeenCalled()
  })
})
