import { describe, expect, it, vi } from 'vitest'
import type { EzDSHBridge } from '../../src/shared/contracts.js'
import type { WorkflowOperationalHealth } from '../../src/shared/workflow-operations.js'

const preloadElectron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: preloadElectron.exposeInMainWorld },
  ipcRenderer: {
    invoke: preloadElectron.invoke,
    on: preloadElectron.on,
    removeListener: preloadElectron.removeListener,
  },
}))

const expected: WorkflowOperationalHealth = {
  workflowId: 'workflow-acme',
  environmentId: 'customer-acme-prod',
  status: 'healthy',
  reason: 'healthy',
  observedAt: '2026-09-12T10:00:00.000Z',
  service: { lifecycle: 'accepting' },
  worker: { state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 0, lastPollSucceededAt: '2026-09-12T09:59:59.000Z' },
  environment: { state: 'active' },
  release: { state: 'active', id: 'release-current', revision: 1, activation: { kind: 'publish', at: '2026-09-12T09:00:00.000Z' } },
  execution: { state: 'completed', runId: 'run-current', time: '2026-09-12T09:30:00.000Z' },
}

async function registerHandler(service: { getOperationalHealth(query: unknown): WorkflowOperationalHealth } | undefined) {
  const module = await import('../../src/main/workflow/workflow-operational-health-ipc.js')
  let handler: ((_event: unknown, query: unknown) => Promise<unknown>) | undefined
  const ipcMain = {
    handle: vi.fn((channel: string, listener: (_event: unknown, query: unknown) => Promise<unknown>) => {
      if (channel === 'workflow-observability:operational-health') handler = listener
    }),
  }
  module.registerWorkflowOperationalHealthIpc(ipcMain, () => service)
  if (handler === undefined) throw new Error('Operational health handler was not registered')
  return handler
}

describe('operational health IPC contract', () => {
  it('registers an executable handler and returns authoritative health', async () => {
    const getOperationalHealth = vi.fn(() => expected)
    const handler = await registerHandler({ getOperationalHealth })
    const query = { workflowId: 'workflow-acme', environmentId: 'customer-acme-prod' }

    await expect(handler({}, query)).resolves.toEqual({ ok: true, data: expected })
    expect(getOperationalHealth).toHaveBeenCalledWith(query)
  })

  it('returns failure envelopes for invalid input, missing service, and service failures', async () => {
    const invalid = await registerHandler({ getOperationalHealth: () => { throw new Error('Invalid workflow ID') } })
    await expect(invalid({}, null)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Invalid workflow ID', requestId: expect.any(String), retryable: true },
    })

    const missing = await registerHandler(undefined)
    await expect(missing({}, { workflowId: 'workflow-acme', environmentId: 'customer-acme-prod' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Workflow operational health service is not ready', requestId: expect.any(String), retryable: true },
    })

    const failure = Object.assign(new Error('Release store unavailable'), { code: 'RELEASE_STORE_UNAVAILABLE' })
    const failed = await registerHandler({ getOperationalHealth: () => { throw failure } })
    await expect(failed({}, { workflowId: 'workflow-acme', environmentId: 'customer-acme-prod' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Workflow operational health is unavailable', requestId: expect.any(String), retryable: true },
    })
  })

  it('redacts unexpected service error messages and arbitrary codes', async () => {
    const handler = await registerHandler({ getOperationalHealth: () => {
      throw Object.assign(new Error('secret-token leaked from malformed store payload'), { code: 'secret-token-code' })
    } })
    const result = await handler({}, { workflowId: 'workflow-acme', environmentId: 'customer-acme-prod' })
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Workflow operational health is unavailable' } })
  })

  it('exposes the preload call and unwraps failures', async () => {
    await import('../../src/preload/index.js')
    const bridge = preloadElectron.exposeInMainWorld.mock.calls.find(([name]) => name === 'EzDSH')?.[1] as EzDSHBridge | undefined
    if (bridge === undefined) throw new Error('Preload bridge was not exposed')
    const query = { workflowId: 'workflow-acme', environmentId: 'customer-acme-prod' }

    preloadElectron.invoke.mockResolvedValueOnce({ ok: true, data: expected })
    await expect(bridge.workflowReleases.getOperationalHealth(query)).resolves.toEqual(expected)
    expect(preloadElectron.invoke).toHaveBeenCalledWith('workflow-observability:operational-health', query)

    preloadElectron.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'HEALTH_UNAVAILABLE', message: 'Health unavailable', requestId: 'request-health', retryable: false },
    })
    await expect(bridge.workflowReleases.getOperationalHealth(query)).rejects.toMatchObject({
      code: 'HEALTH_UNAVAILABLE', message: 'Health unavailable', requestId: 'request-health', retryable: false,
    })
  })
})
