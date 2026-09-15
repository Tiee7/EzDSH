import { join } from 'node:path'

import type { EmployeeRunRecord, EmployeeRunStartReceipt, EmployeeRunStartRequest } from '../../shared/employee-runs.js'
import type { UserDataLayout } from '../../shared/state.js'
import type { WorkTaskSnapshot } from '../../shared/work-items.js'
import type { WorkflowRunRecord } from '../../shared/workflow.js'
import { WorkActionService } from './work-action-service.js'
import { WorkArtifactService } from './work-artifact-service.js'
import { WorkItemExecutionService } from './work-item-execution-service.js'
import {
  createWorkItemScopeAuthorizer,
  initializeWorkItemIpcWorkspace,
  WorkItemWorkspaceUnavailableError,
  type WorkItemExecutionOperation,
  type WorkItemIpcWorkspaceScope,
} from './work-item-ipc.js'
import { WorkItemService } from './work-item-service.js'
import { WorkItemStore } from './work-item-store.js'
import { WorkflowTaskBridge, type WorkflowTaskRunPort } from './workflow-task-bridge.js'

export interface WorkItemWorkspaceEmployeeRunPort {
  startWorkItemRun(request: EmployeeRunStartRequest): Promise<EmployeeRunStartReceipt>
  listWorkItemRuns(): Promise<EmployeeRunRecord[]>
  getWorkItemRun(runId: string): Promise<EmployeeRunRecord | undefined>
  cancelWorkItemRun(runId: string): Promise<EmployeeRunRecord>
}

export interface WorkItemWorkspaceWorkflowRunPort extends WorkflowTaskRunPort {
  watch(listener: (record: WorkflowRunRecord) => void): () => void
}

export interface WorkItemWorkspaceOptions {
  layout: UserDataLayout
  employeeRuns: WorkItemWorkspaceEmployeeRunPort
  workflowRuns: WorkItemWorkspaceWorkflowRunPort
  assertExecutionAvailable?: (operation: WorkItemExecutionOperation, request: unknown) => void
  onChanged?: (snapshot: WorkTaskSnapshot) => void
  onObserverError?: (error: unknown) => void
}

/** Production composition boundary for one workspace's durable WorkItem state and IPC scope. */
export function initializeWorkItemWorkspaceScope(
  options: WorkItemWorkspaceOptions,
): Promise<WorkItemIpcWorkspaceScope> {
  let workspaceActionService: WorkActionService
  return initializeWorkItemIpcWorkspace({
    restore: async () => {
      const store = new WorkItemStore(options.layout.state)
      const artifacts = new WorkArtifactService(store, join(options.layout.root, 'work-artifacts'))
      const authorizeScope = await createWorkItemScopeAuthorizer(options.layout.root)
      await artifacts.initialize()
      return { store, artifacts, authorizeScope }
    },
    construct: ({ store, artifacts, authorizeScope }) => {
      const workItems = new WorkItemService(store, (artifact) => artifacts.verifyStoredArtifact(artifact))
      const workflowBridge = new WorkflowTaskBridge(options.workflowRuns)
      const execution = new WorkItemExecutionService({
        workItems,
        employeeRuns: {
          start: (request) => options.employeeRuns.startWorkItemRun(request),
          list: () => options.employeeRuns.listWorkItemRuns(),
        },
        workflowBridge,
        defaultCwd: options.layout.root,
      })
      workspaceActionService = new WorkActionService({
        workItems,
        employeeRuns: {
          get: (runId) => options.employeeRuns.getWorkItemRun(runId),
          cancel: (runId) => options.employeeRuns.cancelWorkItemRun(runId),
        },
        workflowBridge,
      })
      return {
        workItems,
        execution,
        actions: workspaceActionService,
        assertExecutionAvailable: options.assertExecutionAvailable,
        authorizeScope,
      }
    },
    attachListeners: (_services, { store }, scope) => {
      const listeners = [
        options.workflowRuns.watch((record) => {
          void scope.invoke(() => workspaceActionService.observeWorkflowRun(record)).catch((error: unknown) => {
            if (!(error instanceof WorkItemWorkspaceUnavailableError)) options.onObserverError?.(error)
          })
        }),
      ]
      if (options.onChanged !== undefined) listeners.unshift(store.onChanged(options.onChanged))
      return listeners
    },
  })
}
