import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import { toEzDSHError, type IpcResult } from '../../shared/errors.js'
import { validateWorkflowDeadLetterQuery, validateWorkflowRecoveryPreview, validateWorkflowRecoveryExecute } from '../../shared/workflow-dead-letter.js'
import type { WorkflowRunService } from './workflow-run-service.js'

type RecoveryService = Pick<WorkflowRunService, 'listDeadLetters' | 'previewRecovery' | 'executeRecovery'>

export function registerWorkflowDeadLetterIpc(ipcMain: Pick<IpcMain, 'handle'>, resolveService: () => RecoveryService | undefined): void {
  const register = (channel: string, operation: (service: RecoveryService, request: unknown) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (_event, request: unknown): Promise<IpcResult<unknown>> => {
      try {
        const service = resolveService()
        if (service === undefined) throw new Error('Service unavailable')
        return { ok: true, data: await operation(service, request) }
      } catch {
        return { ok: false, error: toEzDSHError(new Error('Workflow recovery request failed'), randomUUID()) }
      }
    })
  }
  register('workflow-dead-letter:list', (service, input) => service.listDeadLetters(validateWorkflowDeadLetterQuery(input)))
  register('workflow-dead-letter:preview', (service, input) => service.previewRecovery(validateWorkflowRecoveryPreview(input)))
  register('workflow-dead-letter:execute', (service, input) => service.executeRecovery(validateWorkflowRecoveryExecute(input)))
}
