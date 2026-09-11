import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import type { IpcResult } from '../../shared/errors.js'
import { toEzDSHError } from '../../shared/errors.js'
import { workflowReleaseSummary, type WorkflowReleaseSummary } from '../../shared/workflow-operations.js'
import type { WorkflowReleaseRollbackResult } from './workflow-release-store.js'
import type { WorkflowDeploymentObservationInput } from './workflow-observability-service.js'

export const WORKFLOW_RELEASE_ROLLBACK_CHANNEL = 'workflow-releases:rollback'

interface RollbackDeploymentService {
  rollback(releaseId: string): Promise<WorkflowReleaseRollbackResult>
}

interface RollbackObservabilityService {
  recordDeployment(input: WorkflowDeploymentObservationInput): Promise<void>
}

export function registerWorkflowReleaseRollbackIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  resolveDeploymentService: () => RollbackDeploymentService | undefined,
  resolveObservabilityService: () => RollbackObservabilityService | undefined,
): void {
  ipcMain.handle(WORKFLOW_RELEASE_ROLLBACK_CHANNEL, async (_event, releaseId: string): Promise<IpcResult<WorkflowReleaseSummary>> => {
    try {
      const deploymentService = resolveDeploymentService()
      const observabilityService = resolveObservabilityService()
      if (deploymentService === undefined || observabilityService === undefined) throw new Error('Workflow deployment service is not ready')
      const result = await deploymentService.rollback(releaseId)
      await observabilityService.recordDeployment({
        environmentId: result.rolledBack.environmentId,
        releaseId: result.rolledBack.id,
        action: 'release-rolled-back',
      })
      return { ok: true, data: workflowReleaseSummary(result.restored) }
    } catch (error) {
      return { ok: false, error: toEzDSHError(error, randomUUID()) }
    }
  })
}
