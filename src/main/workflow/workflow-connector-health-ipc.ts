import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import { toEzDSHError, type IpcResult } from '../../shared/errors.js'
import type { WorkflowConnectorHealthEvidence, WorkflowConnectorHealthQuery } from '../../shared/workflow-operations.js'
import type { WorkflowConnectorHealthService } from './workflow-connector-health-service.js'

export function registerWorkflowConnectorHealthIpc(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Pick<WorkflowConnectorHealthService, 'check'> | undefined): void {
  ipcMain.handle('workflow-connectors:check-health', async (_event, query: unknown): Promise<IpcResult<WorkflowConnectorHealthEvidence>> => {
    try {
      const service = resolve()
      if (!service) throw new Error('unavailable')
      return { ok: true, data: await service.check(query as WorkflowConnectorHealthQuery) }
    } catch {
      return { ok: false, error: toEzDSHError(new Error('Connector health unavailable'), randomUUID()) }
    }
  })
}
