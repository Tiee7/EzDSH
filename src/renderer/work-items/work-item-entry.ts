import type { WorkTaskCreateRequest, WorkTaskExecuteRequest } from '../../shared/work-items.js'
import { createWorkItemNavigation, type WorkItemNavigationContext } from './work-item-navigation.js'

interface WorkItemEntryIdentity {
  requestId: string
  executeRequestId: string
}

function requestIdentity(prefix: string): WorkItemEntryIdentity {
  const token = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { requestId: `${prefix}-${token}`, executeRequestId: `${prefix}-execute-${token}` }
}

export interface EmployeeWorkItemEntryInput {
  task: string
  employeeId: string
  projectId?: string
  sessionId?: string
  methodId?: string
  methodVersion?: number
  existingTaskId?: string
  expectedRevision?: number
}

export interface WorkflowWorkItemEntryInput {
  task: string
  workflowId: string
  workflowRevision: number
  existingTaskId?: string
  expectedRevision?: number
}

export interface WorkItemEntryRequests {
  create: WorkTaskCreateRequest
  execute: WorkTaskExecuteRequest
  navigation: WorkItemNavigationContext
}

/** Build the formal employee path while keeping the legacy session run separate. */
export function employeeWorkItemEntry(input: EmployeeWorkItemEntryInput): WorkItemEntryRequests {
  const task = input.task.trim()
  if (input.methodId !== undefined && (!Number.isSafeInteger(input.methodVersion) || input.methodVersion! < 1)) throw new Error('Employee method version is required')
  const identity = requestIdentity('employee-work-item')
  const create: WorkTaskCreateRequest = {
    requestId: identity.requestId,
    title: task.slice(0, 80),
    goal: task,
    acceptance: '完成执行并提交可审阅的工作项产物。',
    scope: { ...(input.projectId === undefined ? {} : { projectId: input.projectId }), resourceRefs: [] },
  }
  const execute: WorkTaskExecuteRequest = {
    requestId: identity.executeRequestId,
    taskId: input.existingTaskId ?? '__created_task__',
    expectedRevision: input.expectedRevision ?? 1,
    executor: { kind: 'employee', employeeId: input.employeeId, ...(input.methodId === undefined ? {} : { methodId: input.methodId, ...(input.methodVersion === undefined ? {} : { methodVersion: input.methodVersion }) }) },
    mode: 'initial',
    input: { task, ...(input.projectId === undefined ? {} : { projectId: input.projectId }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), ...(input.methodId === undefined ? {} : { methodId: input.methodId }) },
  }
  return { create, execute, navigation: createWorkItemNavigation({ destination: 'detail', source: 'employees', taskId: input.existingTaskId ?? '__created_task__', employeeId: input.employeeId, methodId: input.methodId, methodVersion: input.methodVersion, runMode: 'task', returnTo: { destination: 'employees', source: 'employees', selectedEmployeeId: input.employeeId, selectedMethodId: input.methodId, selectedMethodVersion: input.methodVersion } }) }
}

/** Build the formal workflow path; debug workflow runs continue through workflows.start. */
export function workflowWorkItemEntry(input: WorkflowWorkItemEntryInput): WorkItemEntryRequests {
  const task = input.task.trim()
  const identity = requestIdentity('workflow-work-item')
  const create: WorkTaskCreateRequest = {
    requestId: identity.requestId,
    title: task.slice(0, 80),
    goal: task,
    acceptance: '完成工作流执行并提交可审阅的工作项产物。',
    scope: { resourceRefs: [] },
  }
  const execute: WorkTaskExecuteRequest = {
    requestId: identity.executeRequestId,
    taskId: input.existingTaskId ?? '__created_task__',
    expectedRevision: input.expectedRevision ?? 1,
    executor: { kind: 'workflow', workflowId: input.workflowId, workflowRevision: input.workflowRevision },
    mode: 'initial',
    input: { task, workflowId: input.workflowId, workflowRevision: input.workflowRevision },
  }
  return { create, execute, navigation: createWorkItemNavigation({ destination: 'detail', source: 'workflow', taskId: input.existingTaskId ?? '__created_task__', workflowId: input.workflowId, runMode: 'task', returnTo: { destination: 'workflow', source: 'workflow', selectedWorkflowId: input.workflowId } }) }
}
