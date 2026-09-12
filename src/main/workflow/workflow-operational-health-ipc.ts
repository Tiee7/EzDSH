import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import type { IpcResult } from '../../shared/errors.js'
import { toEzDSHError } from '../../shared/errors.js'
import type { WorkflowOperationalHealth, WorkflowOperationalHealthQuery } from '../../shared/workflow-operations.js'
import type { WorkflowOperationalHealthService } from './workflow-operational-health-service.js'

export const WORKFLOW_OPERATIONAL_HEALTH_CHANNEL = 'workflow-observability:operational-health'

type OperationalHealthService = Pick<WorkflowOperationalHealthService, 'getOperationalHealth'>

export function registerWorkflowOperationalHealthIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  resolveService: () => OperationalHealthService | undefined,
): void {
  ipcMain.handle(WORKFLOW_OPERATIONAL_HEALTH_CHANNEL, async (_event, query: unknown): Promise<IpcResult<WorkflowOperationalHealth>> => {
    try {
      const service = resolveService()
      if (service === undefined) throw new Error('Workflow operational health service is not ready')
      return { ok: true, data: service.getOperationalHealth(query as WorkflowOperationalHealthQuery) }
    } catch (error) {
      // Store/parser failures can contain persisted payloads. Only these fixed
      // diagnostics may cross the bridge; arbitrary error codes can leak too.
      const message = error instanceof Error && [
        'Invalid workflow ID', 'Invalid environment ID', 'Workflow operational health service is not ready',
      ].includes(error.message) ? error.message : 'Workflow operational health is unavailable'
      return { ok: false, error: toEzDSHError(new Error(message), randomUUID()) }
    }
  })
}
