import { describe, expect, it } from 'vitest'
import { employeeWorkItemEntry, workflowWorkItemEntry } from '../../src/renderer/work-items/work-item-entry.js'

describe('formal Work Item entry paths', () => {
  it('creates an employee task and keeps the legacy session fields as execution input', () => {
    const entry = employeeWorkItemEntry({ task: '整理公开来源', employeeId: 'researcher', projectId: 'project-1', sessionId: 'session-1', methodId: 'method-1', methodVersion: 2 })
    expect(entry.create).toMatchObject({ title: '整理公开来源', goal: '整理公开来源', scope: { projectId: 'project-1', resourceRefs: [] } })
    expect(entry.execute).toMatchObject({ taskId: '__created_task__', executor: { kind: 'employee', employeeId: 'researcher', methodId: 'method-1', methodVersion: 2 }, mode: 'initial', input: { task: '整理公开来源', sessionId: 'session-1', methodId: 'method-1' } })
    expect(entry.navigation).toMatchObject({ destination: 'detail', source: 'employees', employeeId: 'researcher', methodId: 'method-1', methodVersion: 2, runMode: 'task', returnTo: { destination: 'employees', selectedEmployeeId: 'researcher', selectedMethodId: 'method-1', selectedMethodVersion: 2 } })
  })

  it('creates a workflow task separately from the debug workflow run path', () => {
    const entry = workflowWorkItemEntry({ task: '生成竞品简报', workflowId: 'workflow-1', workflowRevision: 7 })
    expect(entry.create).toMatchObject({ goal: '生成竞品简报', scope: { resourceRefs: [] } })
    expect(entry.execute).toMatchObject({ taskId: '__created_task__', executor: { kind: 'workflow', workflowId: 'workflow-1', workflowRevision: 7 }, mode: 'initial' })
    expect(entry.navigation).toMatchObject({ destination: 'detail', source: 'workflow', workflowId: 'workflow-1', runMode: 'task', returnTo: { destination: 'workflow', selectedWorkflowId: 'workflow-1' } })
  })
})
