import { describe, expect, it, vi } from 'vitest'
import type { EzDSHBridge } from '../../src/shared/contracts.js'
const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: electron }))

describe('dead-letter executable IPC and preload', () => {
  it('validates each request before dispatch and hides service error content', async () => {
    const { registerWorkflowDeadLetterIpc } = await import('../../src/main/workflow/workflow-dead-letter-ipc.js')
    const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
    const service = { listDeadLetters: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 50 })), previewRecovery: vi.fn(async () => []), executeRecovery: vi.fn(async () => []) }
    registerWorkflowDeadLetterIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, () => service)
    expect(handlers.size).toBe(3)
    expect(await handlers.get('workflow-dead-letter:list')!({}, {})).toMatchObject({ ok: true, data: { total: 0 } })
    const query = { runIds: ['run'] }
    expect(await handlers.get('workflow-dead-letter:preview')!({}, query)).toEqual({ ok: true, data: [] })
    expect(service.previewRecovery).toHaveBeenCalledWith(query)
    expect(await handlers.get('workflow-dead-letter:execute')!({}, { requestId: 'request', items: [] })).toMatchObject({ ok: false })
    expect(service.executeRecovery).not.toHaveBeenCalled()
    service.previewRecovery.mockRejectedValueOnce(Object.assign(new Error('private-provider-token'), { code: 'private-code' }))
    const failed = await handlers.get('workflow-dead-letter:preview')!({}, query)
    expect(failed).toMatchObject({ ok: false, error: { message: 'Workflow recovery request failed' } })
    expect(JSON.stringify(failed)).not.toContain('private-')
  })

  it('wires all preload calls and unwraps failure envelopes', async () => {
    await import('../../src/preload/index.js')
    const bridge = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'EzDSH')![1] as EzDSHBridge
    electron.invoke.mockResolvedValue({ ok: true, data: [] })
    await bridge.workflows.listDeadLetters({ workflowId: 'workflow' })
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow-dead-letter:list', { workflowId: 'workflow' })
    await bridge.workflows.previewRecovery({ runIds: ['run'] })
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow-dead-letter:preview', { runIds: ['run'] })
    const request = { requestId: 'request', items: [{ runId: 'run', expectedStateToken: 'a'.repeat(64) }] }
    await bridge.workflows.executeRecovery(request)
    expect(electron.invoke).toHaveBeenLastCalledWith('workflow-dead-letter:execute', request)
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Workflow recovery request failed', requestId: 'error-request', retryable: true } })
    await expect(bridge.workflows.executeRecovery(request)).rejects.toMatchObject({ message: 'Workflow recovery request failed' })
  })
})
