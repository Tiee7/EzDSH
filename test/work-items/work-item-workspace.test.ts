import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data.js'
import {
  initializeWorkItemWorkspaceScope,
  type WorkItemWorkspaceWorkflowRunPort,
} from '../../src/main/work-items/work-item-workspace.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'
import type { WorkflowRunRecord, WorkflowRunTaskAssociation, WorkflowValue } from '../../src/shared/workflow.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function workflowRecord(
  commandId: string,
  association: WorkflowRunTaskAssociation,
  status: WorkflowRunRecord['status'],
  output?: WorkflowValue,
): WorkflowRunRecord {
  return {
    id: `workflow-${commandId}`,
    workflowId: 'workflow-1',
    workflowRevision: 1,
    idempotencyKey: commandId,
    origin: { kind: 'top-level' },
    workTask: association,
    status,
    input: null,
    ...(output === undefined ? {} : { output }),
    nodeStates: [],
    events: [],
    allowShellFile: false,
    debug: false,
  }
}

async function workspaceFixture(startStatus: WorkflowRunRecord['status']) {
  const root = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-workspace-'))
  roots.push(root)
  const layout = getUserDataLayout(root)
  await ensureUserDataLayout(layout)
  let records: WorkflowRunRecord[] = []
  const listeners = new Set<(record: WorkflowRunRecord) => void>()
  const workflowRuns = {
    start: vi.fn(async (_workflowId: string, _input: WorkflowValue, options?: { idempotencyKey?: string }, association?: WorkflowRunTaskAssociation) => {
      if (options?.idempotencyKey === undefined || association === undefined) throw new Error('missing work item association')
      const record = workflowRecord(options.idempotencyKey, association, startStatus, startStatus === 'completed' ? { result: 'done' } : undefined)
      records = [record]
      return structuredClone(record)
    }),
    list: vi.fn(() => structuredClone(records)),
    get: vi.fn((runId: string) => structuredClone(records.find((record) => record.id === runId))),
    watch: vi.fn((listener: (record: WorkflowRunRecord) => void) => { listeners.add(listener); return () => listeners.delete(listener) }),
    findByIdempotencyKey: vi.fn((commandId: string) => structuredClone(records.find((record) => record.idempotencyKey === commandId))),
    resume: vi.fn(),
    resumeExpected: vi.fn(),
    cancel: vi.fn(),
    approveExpected: vi.fn(),
  } as unknown as WorkItemWorkspaceWorkflowRunPort
  const employeeRuns = {
    startWorkItemRun: vi.fn(),
    listWorkItemRuns: vi.fn(async () => []),
    getWorkItemRun: vi.fn(async () => undefined),
    cancelWorkItemRun: vi.fn(),
  }
  const open = () => initializeWorkItemWorkspaceScope({ layout, workflowRuns, employeeRuns })
  const setRecords = (next: WorkflowRunRecord[]) => { records = structuredClone(next) }
  return { layout, workflowRuns, open, setRecords }
}

async function createAndRun(scope: Awaited<ReturnType<typeof initializeWorkItemWorkspaceScope>>): Promise<WorkTaskSnapshot> {
  const created = await scope.services.workItems.create({
    requestId: 'create-workflow-task',
    title: 'Workflow task',
    goal: 'Produce a result',
    acceptance: 'Review the JSON result',
    scope: { resourceRefs: [] },
  })
  return scope.services.execution.execute({
    requestId: 'execute-workflow-task',
    taskId: created.task.id,
    expectedRevision: created.task.revision,
    executor: { kind: 'workflow', workflowId: 'workflow-1', workflowRevision: 1 },
    mode: 'initial',
    input: null,
  })
}

describe('Work Item workspace Workflow reconciliation', () => {
  it('compensates a terminal Workflow result after its run is linked', async () => {
    const fixture = await workspaceFixture('completed')
    const scope = await fixture.open()
    const dispatched = await createAndRun(scope)

    await vi.waitFor(async () => {
      await expect(scope.services.workItems.get(dispatched.task.id)).resolves.toMatchObject({
        runs: [expect.objectContaining({ status: 'completed', rawStatus: 'completed', capabilities: expect.objectContaining({ cancel: false }) })],
        artifacts: [expect.objectContaining({ kind: 'json', runId: dispatched.runs[0]!.runId })],
      })
    })
    await scope.dispose()
  })

  it('replays persisted Workflow runs on startup to recover status and output', async () => {
    const fixture = await workspaceFixture('queued')
    const first = await fixture.open()
    const dispatched = await createAndRun(first)
    const run = fixture.workflowRuns.get(dispatched.runs[0]!.runId)!
    await first.dispose()

    fixture.setRecords([{ ...run, status: 'completed', output: { result: 'recovered' } }])
    const reopened = await fixture.open()

    await vi.waitFor(async () => {
      await expect(reopened.services.workItems.get(dispatched.task.id)).resolves.toMatchObject({
        runs: [expect.objectContaining({ status: 'completed', rawStatus: 'completed', capabilities: expect.objectContaining({ cancel: false }) })],
        artifacts: [expect.objectContaining({ kind: 'json', runId: run.id })],
      })
    })
    await reopened.dispose()
  })
})
