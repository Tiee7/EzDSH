import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EzDSHBridge } from '../../src/shared/contracts.js'

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: electron }))
beforeEach(() => { vi.clearAllMocks(); vi.resetModules() })

describe('employee method preload contract', () => {
  it('forwards owner, identity and expected version separately for all method operations', async () => {
    await import('../../src/preload/index.js')
    const bridge = electron.exposeInMainWorld.mock.calls[0]?.[1] as EzDSHBridge
    electron.invoke.mockResolvedValue({ ok: true, data: undefined })
    const input = { name: 'Method', description: '', workflowId: 'workflow', workflowRevision: 3 }
    await bridge.employees.methods.list('owner')
    await bridge.employees.methods.get('owner', 'method')
    await bridge.employees.methods.create('owner', input)
    await bridge.employees.methods.update('owner', 'method', { expectedVersion: 2, name: 'New name' })
    await bridge.employees.methods.remove('owner', 'method', 3)
    await bridge.employees.methods.snapshot('owner', 'method')
    expect(electron.invoke.mock.calls).toEqual([
      ['employees:methods:list', 'owner'],
      ['employees:methods:get', 'owner', 'method'],
      ['employees:methods:create', 'owner', input],
      ['employees:methods:update', 'owner', 'method', { expectedVersion: 2, name: 'New name' }],
      ['employees:methods:remove', 'owner', 'method', 3],
      ['employees:methods:snapshot', 'owner', 'method'],
    ])
  })
  it('surfaces failed save receipts instead of treating them as saved methods', async () => {
    await import('../../src/preload/index.js')
    const bridge = electron.exposeInMainWorld.mock.calls[0]?.[1] as EzDSHBridge
    electron.invoke.mockResolvedValue({ ok: false, error: { message: 'Method version conflict' } })
    await expect(bridge.employees.methods.update('owner', 'method', { expectedVersion: 1, name: 'stale' })).rejects.toThrow('Method version conflict')
  })
})
