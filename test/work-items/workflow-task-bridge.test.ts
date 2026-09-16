import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { WorkflowTaskBridge } from '../../src/main/work-items/workflow-task-bridge.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { EmployeeSnapshot } from '../../src/shared/employees.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

function run(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return { id: 'run-1', workflowId: 'workflow-1', workflowRevision: 7, origin: { kind: 'top-level' }, status: 'paused', input: null, nodeStates: [], events: [], allowShellFile: false, debug: false, ...overrides }
}

describe('WorkflowTaskBridge', () => {
  it('starts a fixed workflow revision with trusted task association and stable command identity', async () => {
    const workflowRuns = { start: vi.fn().mockResolvedValue(run()), resume: vi.fn(), resumeExpected: vi.fn(), cancel: vi.fn(), get: vi.fn(), approveExpected: vi.fn(), answerExpected: vi.fn(), findByIdempotencyKey: vi.fn() }
    const bridge = new WorkflowTaskBridge(workflowRuns)

    await bridge.start({ commandId: 'command-1', taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 2, sourceRunId: 'employee-run', workflowId: 'workflow-1', workflowRevision: 7, input: { topic: 'AI' } })

    expect(workflowRuns.start).toHaveBeenCalledWith('workflow-1', { topic: 'AI' }, { idempotencyKey: 'command-1', workflowRevision: 7 }, {
      taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 2, commandId: 'command-1', sourceRunId: 'employee-run',
    })
  })

  it('resumes and cancels the original run and finds linkage by command', async () => {
    const original = run({ idempotencyKey: 'command-1' })
    const workflowRuns = { start: vi.fn(), resume: vi.fn().mockResolvedValue(original), resumeExpected: vi.fn().mockResolvedValue(original), cancel: vi.fn().mockResolvedValue(original), get: vi.fn().mockReturnValue(original), approveExpected: vi.fn(), answerExpected: vi.fn().mockResolvedValue(original), findByIdempotencyKey: vi.fn().mockReturnValue(original) }
    const bridge = new WorkflowTaskBridge(workflowRuns)

    expect(await bridge.resume(original.id)).toBe(original)
    expect(await bridge.resumeExpected(original.id, { requestId: 'resume-1', expectedTaskId: 'task-1', expectedRequirementVersion: 2 })).toBe(original)
    expect(await bridge.cancel(original.id)).toBe(original)
    expect(await bridge.findByCommand('command-1')).toBe(original)
    expect(workflowRuns.resume).toHaveBeenCalledWith(original.id)
    expect(workflowRuns.resumeExpected).toHaveBeenCalledWith(original.id, { requestId: 'resume-1', expectedTaskId: 'task-1', expectedRequirementVersion: 2 })
    expect(workflowRuns.cancel).toHaveBeenCalledWith(original.id)
    const questionRequest = { requestId: 'answer-1', answer: 'yes', expectedQuestionEventId: 'event-1', expectedNodeId: 'question', expectedTaskId: 'task-1', expectedRequirementVersion: 2, expectedActionVersion: 1 as const, sourceRevision: 7 }
    expect(await bridge.answerExpected(original.id, questionRequest)).toBe(original)
    expect(workflowRuns.answerExpected).toHaveBeenCalledWith(original.id, questionRequest)
  })

  it('keeps debug starts outside WorkTask association', async () => {
    const workflowRuns = { start: vi.fn().mockResolvedValue(run({ debug: true })), resume: vi.fn(), resumeExpected: vi.fn(), cancel: vi.fn(), get: vi.fn(), approveExpected: vi.fn(), answerExpected: vi.fn(), findByIdempotencyKey: vi.fn() }
    const bridge = new WorkflowTaskBridge(workflowRuns)

    const debug = await bridge.startDebug('workflow-1', null)

    expect(workflowRuns.start).toHaveBeenCalledWith('workflow-1', null, { debug: true })
    expect(debug.workTask).toBeUndefined()
  })

  it('freezes the workflow revision and direct employee snapshot for each new run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-task-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-1',
      name: 'Employee workflow',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee', type: 'employee', label: 'Research', config: { employeeId: 'researcher', instruction: '核实', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'one', source: 'input', target: 'employee' },
        { id: 'two', source: 'employee', target: 'output' },
      ],
    })
    const employee = (version: number): EmployeeSnapshot => ({ schemaVersion: 2, version, id: 'researcher', name: '研究员', role: '研究', description: '', businessBoundary: '', systemPrompt: `system-v${version}`, operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: `2026-09-15T00:00:0${version}.000Z` })
    let currentEmployee = employee(1)
    const resolveEmployee = vi.fn(() => structuredClone(currentEmployee))
    const sendPrompt = vi.fn().mockResolvedValue({ text: 'done' })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'session-1' }), sendPrompt }),
      resolveEmployee,
    })
    const bridge = new WorkflowTaskBridge(service)
    try {
      const first = await bridge.start({ commandId: 'command-1', taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 1, workflowId: workflow.id, input: null })
      currentEmployee = employee(2)
      await waitFor(() => service.get(first.id)?.status === 'completed')
      expect(resolveEmployee).toHaveBeenCalledTimes(2)
      expect(sendPrompt.mock.calls[0]?.[1]).toContain('system-v1')
      expect(service.get(first.id)).toMatchObject({
        workflowRevision: 1,
        workTask: { taskId: 'task-1', attemptId: 'attempt-1', requirementVersion: 1, commandId: 'command-1' },
        employeeNodeSnapshots: [{ nodeId: 'employee', employeeId: 'researcher', employeeVersion: 1, employeeSnapshot: { systemPrompt: 'system-v1' } }],
      })

      const updated = await workflowStore.update(workflow.id, { name: workflow.name, description: 'revision 2', nodes: workflow.nodes, edges: workflow.edges, revision: 1 })
      const redo = await bridge.start({ commandId: 'command-2', taskId: 'task-1', attemptId: 'attempt-2', requirementVersion: 1, sourceRunId: first.id, workflowId: workflow.id, input: null })
      expect(redo.id).not.toBe(first.id)
      expect(redo.workflowRevision).toBe(updated.revision)
      expect(redo.workTask).toMatchObject({ attemptId: 'attempt-2', commandId: 'command-2', sourceRunId: first.id })
      expect(redo.employeeNodeSnapshots?.[0]).toMatchObject({ employeeVersion: 2, employeeSnapshot: { systemPrompt: 'system-v2' } })
      expect(redo.parentRunId).toBeUndefined()
    } finally {
      await service.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks a persisted queued employee node when the current employee is disabled without replacing its snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-task-disabled-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-disabled', name: 'Disabled employee', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee', type: 'employee', label: 'Research', config: { employeeId: 'researcher', instruction: '核实', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'one', source: 'input', target: 'employee' }, { id: 'two', source: 'employee', target: 'output' }],
    })
    const frozen: EmployeeSnapshot = { schemaVersion: 2, version: 1, id: 'researcher', name: '原研究员', role: '原岗位', description: '', businessBoundary: '', systemPrompt: 'frozen-system', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' }
    const runStore = new WorkflowRunStore(directory)
    await runStore.initialize()
    await runStore.enqueue({
      id: 'persisted-run', workflowId: workflow.id, workflowRevision: workflow.revision,
      employeeNodeSnapshots: [{ nodeId: 'employee', employeeId: frozen.id, employeeVersion: frozen.version, employeeSnapshot: frozen }],
      origin: { kind: 'top-level' }, status: 'queued', input: null,
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [], allowShellFile: false,
    })
    const sendPrompt = vi.fn().mockResolvedValue({ text: 'must not run' })
    const current = { ...frozen, version: 2, name: '新档案', systemPrompt: 'current-system', enabled: false }
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt }),
      resolveEmployee: () => structuredClone(current),
    })
    try {
      await service.initialize()
      await waitFor(() => service.get('persisted-run')?.status === 'failed')
      expect(sendPrompt).not.toHaveBeenCalled()
      expect(service.get('persisted-run')).toMatchObject({
        status: 'failed',
        employeeNodeSnapshots: [{ employeeVersion: 1, employeeSnapshot: { name: '原研究员', systemPrompt: 'frozen-system', enabled: true } }],
      })
    } finally {
      await service.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes the original persisted run but blocks its employee node after the employee is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-task-resume-disabled-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-resume-disabled', name: 'Resume disabled employee', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee', type: 'employee', label: 'Research', config: { employeeId: 'researcher', instruction: '核实', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'one', source: 'input', target: 'employee' }, { id: 'two', source: 'employee', target: 'output' }],
    })
    const frozen: EmployeeSnapshot = { schemaVersion: 2, version: 1, id: 'researcher', name: '原研究员', role: '原岗位', description: '', businessBoundary: '', systemPrompt: 'frozen-system', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' }
    const runStore = new WorkflowRunStore(directory)
    await runStore.initialize()
    await runStore.save({
      id: 'paused-run', workflowId: workflow.id, workflowRevision: workflow.revision,
      employeeNodeSnapshots: [{ nodeId: 'employee', employeeId: frozen.id, employeeVersion: frozen.version, employeeSnapshot: frozen }],
      origin: { kind: 'top-level' }, status: 'paused', input: null,
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [], allowShellFile: false,
    })
    const sendPrompt = vi.fn().mockResolvedValue({ text: 'must not run' })
    const current = { ...frozen, version: 2, name: '新档案', systemPrompt: 'current-system', enabled: false }
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt }),
      resolveEmployee: () => structuredClone(current),
    })
    try {
      await service.initialize()
      const resumed = await service.resume('paused-run')
      expect(resumed.id).toBe('paused-run')
      await waitFor(() => service.get('paused-run')?.status === 'failed')
      expect(sendPrompt).not.toHaveBeenCalled()
      expect(service.get('paused-run')).toMatchObject({
        id: 'paused-run',
        status: 'failed',
        employeeNodeSnapshots: [{ employeeVersion: 1, employeeSnapshot: { name: '原研究员', systemPrompt: 'frozen-system', enabled: true } }],
      })
    } finally {
      await service.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('workflow did not settle')
}
