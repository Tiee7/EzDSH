import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EmployeeRunRecord } from '../../src/shared/employee-runs.js'
import {
  EmployeeRunStore,
  EmployeeRunStoreConflictError,
} from '../../src/main/employees/employee-run-store.js'
import { DEFAULT_RESEARCH_EMPLOYEE } from '../../src/main/employees/employee-service.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-employee-runs-'))
  directories.push(directory)
  return directory
}

function record(overrides: Partial<EmployeeRunRecord> = {}): EmployeeRunRecord {
  const now = '2026-09-15T01:00:00.000Z'
  return {
    runId: 'run-1',
    commandId: 'command-1',
    requestDigest: 'digest-1',
    employeeId: DEFAULT_RESEARCH_EMPLOYEE.id,
    employeeVersion: DEFAULT_RESEARCH_EMPLOYEE.version,
    employeeSnapshot: structuredClone(DEFAULT_RESEARCH_EMPLOYEE),
    task: { description: '核实三项变化' },
    context: { cwd: '/trusted/project', projectId: 'project-1' },
    projectId: 'project-1',
    cwd: '/trusted/project',
    sessionId: 'session-1',
    sessionEvidence: 'created',
    status: 'queued',
    dispatchStage: 'recorded',
    partialOutput: '',
    output: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('EmployeeRunStore', () => {
  it('reopens a durable run and command receipt and replays equivalent create input', async () => {
    const directory = await temporaryDirectory()
    const first = new EmployeeRunStore(directory)
    await first.initialize()

    const created = await first.create({
      commandId: 'command-1',
      requestDigest: 'digest-1',
      record: record(),
    })
    const reopened = new EmployeeRunStore(directory)
    await reopened.initialize()
    const replay = await reopened.create({
      commandId: 'command-1',
      requestDigest: 'digest-1',
      record: record({ runId: 'unused-on-replay' }),
    })

    expect(created.replayed).toBe(false)
    expect(await reopened.get('run-1')).toEqual(created.run)
    expect(await reopened.list()).toEqual([created.run])
    expect(await reopened.findByCommand('command-1')).toMatchObject({
      requestDigest: 'digest-1',
      run: { runId: 'run-1' },
    })
    expect(replay).toEqual({ run: created.run, replayed: true })
    await expect(reopened.create({
      commandId: 'command-1',
      requestDigest: 'different-digest',
      record: record({ runId: 'run-2', requestDigest: 'different-digest' }),
    })).rejects.toMatchObject({
      name: 'EmployeeRunStoreConflictError',
      code: 'COMMAND_ID_CONFLICT',
    })
    expect(EmployeeRunStoreConflictError).toBeDefined()
  })

  it('serializes updates and gives callers and listeners isolated clones', async () => {
    const store = new EmployeeRunStore(await temporaryDirectory())
    await store.initialize()
    await store.create({ commandId: 'command-1', requestDigest: 'digest-1', record: record() })
    const observed: EmployeeRunRecord[] = []
    store.subscribe((event) => {
      event.run.output = 'listener mutation'
      observed.push(event.run)
      throw new Error('broken listener')
    })
    const healthy = vi.fn()
    store.subscribe(healthy)

    const [running, completed] = await Promise.all([
      store.update('run-1', { status: 'running', dispatchStage: 'prompt-in-flight' }),
      store.update('run-1', { status: 'completed', dispatchStage: 'completed', output: '最终结果' }),
    ])

    expect(running.status).toBe('running')
    expect(completed).toMatchObject({ status: 'completed', output: '最终结果' })
    expect((await store.get('run-1'))?.output).toBe('最终结果')
    expect(observed).toHaveLength(2)
    expect(healthy).toHaveBeenCalledTimes(2)
    const obtained = await store.get('run-1')
    if (obtained) obtained.employeeSnapshot.role = '外部修改'
    expect((await store.get('run-1'))?.employeeSnapshot.role).toBe(DEFAULT_RESEARCH_EMPLOYEE.role)
  })

  it('keeps the prior state and emits no event when atomic replacement fails', async () => {
    const directory = await temporaryDirectory()
    let replacements = 0
    const store = new EmployeeRunStore(directory, {
      rename: async (from, to) => {
        replacements += 1
        if (replacements === 2) throw new Error('simulated rename failure')
        await rename(from, to)
      },
    })
    await store.initialize()
    await store.create({ commandId: 'command-1', requestDigest: 'digest-1', record: record() })
    const listener = vi.fn()
    store.subscribe(listener)

    await expect(store.update('run-1', { status: 'running' })).rejects.toThrow('simulated rename failure')

    expect(listener).not.toHaveBeenCalled()
    expect((await store.get('run-1'))?.status).toBe('queued')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    const reopened = new EmployeeRunStore(directory)
    await reopened.initialize()
    expect((await reopened.get('run-1'))?.status).toBe('queued')
  })

  it('cleans the temporary file and records nothing when the temporary write fails', async () => {
    const directory = await temporaryDirectory()
    const store = new EmployeeRunStore(directory, {
      writeFile: async () => { throw new Error('simulated temporary write failure') },
    })
    await store.initialize()
    const listener = vi.fn()
    store.subscribe(listener)

    await expect(store.create({
      commandId: 'command-1',
      requestDigest: 'digest-1',
      record: record(),
    })).rejects.toThrow('simulated temporary write failure')

    expect(await store.list()).toEqual([])
    expect(await store.findByCommand('command-1')).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
