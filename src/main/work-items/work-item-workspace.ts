import { join } from 'node:path'

import type { EmployeeRunEvent, EmployeeRunRecord, EmployeeRunStartReceipt, EmployeeRunStartRequest } from '../../shared/employee-runs.js'
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
  watchWorkItemRuns?(listener: (event: EmployeeRunEvent) => void): () => void
}

export interface WorkItemWorkspaceEmployeeMethodPort {
  snapshot(employeeId: string, methodId: string): Promise<import('../../shared/employee-methods.js').EmployeeWorkMethod>
}

export interface WorkItemWorkspaceWorkflowRunPort extends WorkflowTaskRunPort {
  list(): WorkflowRunRecord[]
  watch(listener: (record: WorkflowRunRecord) => void): () => void
}

export interface WorkItemWorkspaceOptions {
  layout: UserDataLayout
  employeeRuns: WorkItemWorkspaceEmployeeRunPort
  employeeMethods?: WorkItemWorkspaceEmployeeMethodPort
  workflowRuns: WorkItemWorkspaceWorkflowRunPort
  assertExecutionAvailable?: (operation: WorkItemExecutionOperation, request: unknown) => void
  onChanged?: (snapshot: WorkTaskSnapshot) => void
  onObserverError?: (error: unknown) => void
  openArtifact?: (storedPath: string) => Promise<string | void>
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
      const workItems = new WorkItemService(
        store,
        (artifact) => artifacts.verifyStoredArtifact(artifact),
        options.openArtifact === undefined ? undefined : async (artifact) => {
          const error = await options.openArtifact!(artifact.storedPath)
          if (typeof error === 'string' && error !== '') throw new Error(error)
        },
      )
      const workflowBridge = new WorkflowTaskBridge(options.workflowRuns)
      const execution = new WorkItemExecutionService({
        workItems,
        employeeRuns: {
          start: (request) => options.employeeRuns.startWorkItemRun(request),
          list: () => options.employeeRuns.listWorkItemRuns(),
        },
        employeeMethods: options.employeeMethods,
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
        artifacts,
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
      const listeners: Array<() => void> = []
      let workflowObservationTail = Promise.resolve()
      const projectWorkflowRun = (run: WorkflowRunRecord): void => {
        workflowObservationTail = workflowObservationTail
          .then(() => {
            const current = options.workflowRuns.get(run.id) ?? run
            return scope.invoke(() => workspaceActionService.observeWorkflowRun(current)).then(() => undefined)
          })
          .catch((error: unknown) => {
            if (!(error instanceof WorkItemWorkspaceUnavailableError)) options.onObserverError?.(error)
          })
      }
      const workflowInitialProjection = Promise.resolve().then(() => options.workflowRuns.list()).then((runs) => {
        for (const run of runs) projectWorkflowRun(run)
      }).catch((error: unknown) => options.onObserverError?.(error))
      listeners.push(options.workflowRuns.watch((record) => {
        void workflowInitialProjection.then(() => { projectWorkflowRun(record) })
      }))
      let employeeObservationTail = Promise.resolve()
      const projectEmployeeRun = (run: EmployeeRunRecord): void => {
        employeeObservationTail = employeeObservationTail
          .then(async () => {
            const current = await options.employeeRuns.getWorkItemRun(run.runId) ?? run
            return scope.invoke(() => workspaceActionService.observeEmployeeRun(current)).then(() => undefined)
          })
          .catch((error: unknown) => {
            if (!(error instanceof WorkItemWorkspaceUnavailableError)) options.onObserverError?.(error)
          })
      }
      // Re-project persisted terminal states on startup; EmployeeRunService only
      // emits future mutations, while Work Items must survive a process restart.
      const employeeInitialProjection = options.employeeRuns.listWorkItemRuns().then((runs) => {
        for (const run of runs) projectEmployeeRun(run)
      }).catch((error: unknown) => options.onObserverError?.(error))
      if (options.employeeRuns.watchWorkItemRuns !== undefined) {
        listeners.push(options.employeeRuns.watchWorkItemRuns((event: EmployeeRunEvent) => {
          // Wait for the startup inventory before accepting live events, so a
          // stale inventory result cannot overwrite a newer terminal update.
          void employeeInitialProjection.then(() => { projectEmployeeRun(event.run) })
        }))
      }
      const reconcileLinkedRuns = (snapshot: WorkTaskSnapshot): void => {
        for (const run of snapshot.runs) {
          if (run.executor.kind === 'workflow' || run.executor.methodId !== undefined) {
            const current = options.workflowRuns.get(run.runId)
            if (current !== undefined) void workflowInitialProjection.then(() => { projectWorkflowRun(current) })
            continue
          }
          void employeeInitialProjection.then(async () => {
            const current = await options.employeeRuns.getWorkItemRun(run.runId)
            if (current !== undefined) projectEmployeeRun(current)
          }).catch((error: unknown) => options.onObserverError?.(error))
        }
      }
      listeners.unshift(store.onChanged((snapshot) => {
        options.onChanged?.(snapshot)
        reconcileLinkedRuns(snapshot)
      }))
      return listeners
    },
  })
}
