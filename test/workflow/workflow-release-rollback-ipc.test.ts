import { describe, expect, it, vi } from 'vitest'
import { registerWorkflowReleaseRollbackIpc } from '../../src/main/workflow/workflow-release-rollback-ipc.js'
import { workflowReleaseSummary, type WorkflowRelease } from '../../src/shared/workflow-operations.js'

function release(id: string, status: WorkflowRelease['status']): WorkflowRelease {
  return {
    id,
    environmentId: 'customer-acme-production',
    workflowId: 'workflow-orders',
    workflowRevision: id === 'release-v1' ? 1 : 2,
    contentSha256: 'a'.repeat(64),
    workflowSnapshot: {
      schemaVersion: 2,
      id: 'workflow-orders',
      name: 'Orders',
      description: '',
      revision: id === 'release-v1' ? 1 : 2,
      enabled: true,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'edge-output', source: 'input', target: 'output' }],
    },
    status,
    connectorGrants: [],
    createdAt: '2026-09-03T00:00:00.000Z',
    publishedAt: '2026-09-03T00:00:00.000Z',
  }
}

describe('workflow release rollback IPC', () => {
  it('returns the restored release while observing the release that was rolled back', async () => {
    const restored = release('release-v1', 'published')
    const rolledBack = release('release-v2', 'rolled-back')
    const rollback = vi.fn(async () => ({ restored, rolledBack }))
    const recordDeployment = vi.fn(async () => undefined)
    let handler: ((_event: unknown, releaseId: string) => Promise<unknown>) | undefined
    const ipcMain = {
      handle: vi.fn((_channel: string, listener: (_event: unknown, releaseId: string) => Promise<unknown>) => { handler = listener }),
    }

    registerWorkflowReleaseRollbackIpc(ipcMain, () => ({ rollback }), () => ({ recordDeployment }))

    expect(ipcMain.handle).toHaveBeenCalledWith('workflow-releases:rollback', expect.any(Function))
    expect(handler).toBeDefined()
    await expect(handler?.({}, restored.id)).resolves.toEqual({
      ok: true,
      data: workflowReleaseSummary(restored),
    })
    expect(rollback).toHaveBeenCalledWith(restored.id)
    expect(recordDeployment).toHaveBeenCalledWith({
      environmentId: rolledBack.environmentId,
      releaseId: rolledBack.id,
      action: 'release-rolled-back',
    })
  })
})
