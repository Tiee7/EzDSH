import { describe, expect, it } from 'vitest'
import {
  createWorkItemNavigation,
  openEmployeeFromWorkItem,
  openExistingWorkItemRun,
  parseWorkItemNavigation,
  restoreWorkItemNavigation,
  serializeWorkItemNavigation,
} from '../../src/renderer/work-items/work-item-navigation.js'

describe('work item navigation context', () => {
  it('serializes and parses a typed context without embedding task data', () => {
    const context = openEmployeeFromWorkItem({
      employeeId: 'researcher',
      taskId: 'task-1',
      methodId: 'briefing',
      methodVersion: 3,
      returnTo: {
        destination: 'work-items',
        source: 'work-items',
        selectedTaskId: 'task-1',
        selectedEmployeeId: 'researcher',
        filter: { status: 'active', query: 'brief' },
        scrollTop: 240,
      },
    })
    const parsed = parseWorkItemNavigation(serializeWorkItemNavigation(context))
    expect(parsed).toEqual(context)
    expect(serializeWorkItemNavigation(context)).not.toContain('goal')
  })

  it('keeps the selected employee method version when restoring a linked work item', () => {
    const origin = {
      destination: 'employees' as const,
      source: 'work-items' as const,
      selectedEmployeeId: 'researcher',
      selectedMethodId: 'briefing',
      selectedMethodVersion: 3,
    }
    const context = createWorkItemNavigation({ destination: 'detail', source: 'employees', taskId: 'task-1', employeeId: 'researcher', methodId: 'briefing', methodVersion: 3, returnTo: origin })
    expect(restoreWorkItemNavigation(parseWorkItemNavigation(serializeWorkItemNavigation(context))!)).toEqual(origin)
  })

  it('drops unknown fields and invalid optional values while keeping safe defaults', () => {
    const parsed = parseWorkItemNavigation({
      destination: 'work-items',
      source: 'unexpected',
      taskId: ' task-2 ',
      employeeId: '\u0000secret',
      runMode: 'task',
      returnTo: {
        destination: 'work-items',
        source: 'unexpected',
        selectedTaskId: 'task-1',
        scrollTop: -10,
        secret: 'should disappear',
      },
      businessTask: { goal: 'must never be carried' },
    })
    expect(parsed).toMatchObject({ destination: 'work-items', source: 'work-items', taskId: 'task-2', runMode: 'task' })
    expect(parsed?.employeeId).toBeUndefined()
    expect(parsed?.returnTo).toBeUndefined()
    expect(parsed && 'businessTask' in parsed).toBe(false)
  })

  it('rejects unsupported versions, run modes and incomplete destination contexts', () => {
    expect(parseWorkItemNavigation({ version: 99, destination: 'detail', taskId: 'task-1' })).toBeUndefined()
    expect(parseWorkItemNavigation({ destination: 'detail', taskId: 'task-1', runMode: 'future-mode' })).toBeUndefined()
    expect(parseWorkItemNavigation({ destination: 'detail' })).toBeUndefined()
    expect(() => createWorkItemNavigation({ destination: 'workflow' })).toThrow('workflowId is required')
  })

  it('preserves workflow and existing-run fields for all formal entry points', () => {
    const workflow = openExistingWorkItemRun({
      taskId: 'task-1', runId: 'run-1', destination: 'workflow', workflowId: 'flow-1', methodId: 'method-1',
      returnTo: { destination: 'detail', source: 'workflow', selectedTaskId: 'task-1', selectedRunId: 'run-1' },
    })
    expect(workflow).toMatchObject({ destination: 'workflow', taskId: 'task-1', runId: 'run-1', workflowId: 'flow-1', methodId: 'method-1' })
    expect(parseWorkItemNavigation(serializeWorkItemNavigation(workflow))).toEqual(workflow)
  })

  it('keeps debug runs separate from formal work item execution', () => {
    const context = openExistingWorkItemRun({ taskId: 'task-1', runId: 'debug-1', destination: 'workflow', runMode: 'debug', workflowId: 'flow-1' })
    expect(context.runMode).toBe('debug')
    expect(context.taskId).toBe('task-1')
    expect(parseWorkItemNavigation(serializeWorkItemNavigation(context))?.runMode).toBe('debug')
  })

  it('restores all return selection and filter context without changing it', () => {
    const origin = {
      destination: 'work-items' as const,
      source: 'work-items' as const,
      selectedTaskId: 'task-7',
      selectedRunId: 'run-4',
      filter: { employeeId: 'writer', workflowId: 'flow-2' },
      scrollTop: 999,
    }
    const context = createWorkItemNavigation({ destination: 'workflow', source: 'work-items', taskId: origin.selectedTaskId, workflowId: 'flow-2', runId: origin.selectedRunId, returnTo: origin })
    const restored = restoreWorkItemNavigation(parseWorkItemNavigation(serializeWorkItemNavigation(context))!)
    expect(restored).toEqual(origin)
    expect(restored).not.toBe(origin)
  })

  it.each([
    { projectId: 'project-1' },
    { unassignedProject: true as const },
  ])('round-trips project filter %o without changing navigation version 1', (projectFilter) => {
    const context = openEmployeeFromWorkItem({
      employeeId: 'researcher',
      returnTo: {
        destination: 'work-items',
        source: 'work-items',
        filter: { status: 'active', ...projectFilter },
      },
    })

    const parsed = parseWorkItemNavigation(serializeWorkItemNavigation(context))

    expect(parsed).toEqual(context)
    expect(parsed?.version).toBe(1)
    expect(parsed?.returnTo?.filter).toEqual({ status: 'active', ...projectFilter })
  })

  it('drops conflicting project constraints while preserving other valid filters', () => {
    const parsed = parseWorkItemNavigation({
      destination: 'work-items',
      returnTo: {
        destination: 'work-items',
        source: 'work-items',
        filter: {
          status: 'review',
          query: 'brief',
          projectId: 'project-1',
          unassignedProject: true,
        },
      },
    })

    expect(parsed?.returnTo?.filter).toEqual({ status: 'review', query: 'brief' })
  })

  it('retains legacy filters that do not contain project fields', () => {
    const parsed = parseWorkItemNavigation({
      version: 1,
      destination: 'work-items',
      returnTo: {
        destination: 'work-items',
        source: 'work-items',
        filter: { employeeId: 'writer', workflowId: 'flow-2' },
      },
    })

    expect(parsed?.returnTo?.filter).toEqual({ employeeId: 'writer', workflowId: 'flow-2' })
  })

  it.each([
    '',
    '  project-1  \u0000',
    'x'.repeat(257),
  ])('drops unsafe project ID %j at the existing safe text boundary', (projectId) => {
    const parsed = parseWorkItemNavigation({
      destination: 'work-items',
      returnTo: {
        destination: 'work-items',
        source: 'work-items',
        filter: { query: 'brief', projectId },
      },
    })

    expect(parsed?.returnTo?.filter).toEqual({ query: 'brief' })
  })

  it('clones project filter state when creating and restoring navigation', () => {
    const filter = { projectId: 'project-1' }
    const returnTo = {
      destination: 'work-items' as const,
      source: 'work-items' as const,
      filter,
    }
    const context = createWorkItemNavigation({ destination: 'employees', employeeId: 'researcher', returnTo })
    const restored = restoreWorkItemNavigation(context)

    expect(context.returnTo?.filter).toEqual(filter)
    expect(context.returnTo?.filter).not.toBe(filter)
    expect(restored?.filter).toEqual(filter)
    expect(restored?.filter).not.toBe(context.returnTo?.filter)
  })

  it('rejects malformed JSON instead of treating it as a navigation command', () => {
    expect(parseWorkItemNavigation('{not-json')).toBeUndefined()
    expect(parseWorkItemNavigation(null)).toBeUndefined()
  })
})
