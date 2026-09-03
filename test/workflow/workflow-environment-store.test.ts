import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkflowCustomerEnvironment } from '../../src/shared/workflow-operations.js'
import { WorkflowEnvironmentStore } from '../../src/main/workflow/workflow-environment-store.js'

function createEnvironment(overrides: Partial<WorkflowCustomerEnvironment> = {}): WorkflowCustomerEnvironment {
  return {
    id: 'customer-acme-staging',
    customerName: 'Acme',
    name: '预发布',
    kind: 'staging',
    status: 'active',
    connectorIds: ['crm'],
    allowShellFile: true,
    allowCode: true,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}

describe('WorkflowEnvironmentStore', () => {
  it('persists normalized environments across restart without unknown fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-environments-'))
    await chmod(dir, 0o755)
    const store = new WorkflowEnvironmentStore(dir)
    const saved = await store.upsert({
      ...createEnvironment(),
      id: ' customer-acme-staging ',
      customerName: ' Acme ',
      connectorIds: ['crm', 'crm'],
      unexpectedSecret: 'Bearer private',
    } as WorkflowCustomerEnvironment)

    expect(saved).toEqual(createEnvironment())
    expect(await readFile(join(dir, 'workflow-customer-environments.json'), 'utf8')).not.toContain('unexpectedSecret')
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'workflow-customer-environments.json'))).mode & 0o777).toBe(0o600)

    const reloaded = new WorkflowEnvironmentStore(dir)
    await reloaded.initialize()
    expect(reloaded.get('customer-acme-staging')).toEqual(createEnvironment())
    expect(reloaded.list()).toEqual([createEnvironment()])
  })

  it('returns clones and skips invalid persisted entries on startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-environments-invalid-'))
    await writeFile(join(dir, 'workflow-customer-environments.json'), JSON.stringify([
      createEnvironment(),
      { id: 'broken-environment', customerName: 'Broken' },
    ]))

    const store = new WorkflowEnvironmentStore(dir)
    await store.initialize()

    const first = store.get('customer-acme-staging')!
    first.connectorIds.push('billing')
    expect(store.get('customer-acme-staging')).toEqual(createEnvironment())
    expect(store.list()).toEqual([createEnvironment()])
  })

  it('rejects invalid environments and persists removals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-environments-remove-'))
    const store = new WorkflowEnvironmentStore(dir)
    await expect(store.upsert(createEnvironment({ kind: 'production', allowShellFile: true, allowCode: false }))).rejects.toThrow(/environment/i)

    await store.upsert(createEnvironment({ id: 'customer-acme-dev', kind: 'development' }))
    expect(await store.remove('customer-acme-dev')).toBe(true)
    expect(await store.remove('customer-acme-dev')).toBe(false)

    const reloaded = new WorkflowEnvironmentStore(dir)
    await reloaded.initialize()
    expect(reloaded.list()).toEqual([])
  })
})
