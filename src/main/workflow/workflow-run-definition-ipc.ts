import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import type { WorkflowDefinition } from '../../shared/workflow.js'
import type { IpcResult } from '../../shared/errors.js'
import { toEzDSHError } from '../../shared/errors.js'
import type { WorkflowRunService } from './workflow-run-service.js'

export const WORKFLOW_RUN_DEFINITION_CHANNEL = 'workflow-runs:get-definition'

type WorkflowRunDefinitionService = Pick<WorkflowRunService, 'getRunDefinition'>

export function registerWorkflowRunDefinitionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  resolveService: () => WorkflowRunDefinitionService | undefined,
): void {
  ipcMain.handle(WORKFLOW_RUN_DEFINITION_CHANNEL, async (_event, runId: unknown): Promise<IpcResult<WorkflowDefinition | undefined>> => {
    try {
      const service = resolveService()
      if (service === undefined) throw new Error('Workflow service is not ready')
      return { ok: true, data: await service.getRunDefinition(runId as string) }
    } catch (error) {
      return { ok: false, error: toEzDSHError(error, randomUUID()) }
    }
  })
}
