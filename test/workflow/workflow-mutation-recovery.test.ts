import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowMutationCoordinator } from '../../src/main/workflow/workflow-mutation-coordinator.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

const faults = vi.hoisted(() => ({ failClear: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
    if (faults.failClear && String(path).endsWith('/workflow-mutation-intent.json')) throw new Error('clear failed')
    return fs.unlink(path)
  } }
})

const run = (id: string, workflowId = 'w'): WorkflowRunRecord => ({ id, workflowId, workflowRevision: 1, status: 'completed', input: null, nodeStates: [], events: [], allowShellFile: false })
type Writer = { write(file: string, value: string): Promise<void> }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-mutation-'))
  const mutations = new WorkflowMutationCoordinator(dir)
  const store = new WorkflowStore(dir, mutations)
  const runs = new WorkflowRunStore(dir, undefined, mutations)
  await store.create({ ...createDefaultWorkflow('old'), id: 'w' })
  await runs.save(run('r'))
  return { dir, mutations, store, runs }
}

function crashBefore(mutations: WorkflowMutationCoordinator, file: string) {
  const writer = mutations as unknown as Writer
  const original = writer.write.bind(writer)
  return vi.spyOn(writer, 'write').mockImplementation(async (target, value) => {
    if (target === file) throw new Error('simulated crash')
    await original(target, value)
  })
}

describe('workflow mutation recovery', () => {
  it('does not expose a failed definition save in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-mutation-'))
    const store = new WorkflowStore(dir)
    const workflow = await store.create({ ...createDefaultWorkflow('old'), id: 'w' })
    vi.spyOn(store as unknown as { persist(...args: unknown[]): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('disk failed'))
    await expect(store.update('w', { name: 'new', revision: workflow.revision })).rejects.toThrow('disk failed')
    expect(store.get('w')?.name).toBe('old')
    expect(store.getRevision('w', 2)).toBeUndefined()
  })

  it('serializes competing optimistic saves without overwriting an exact revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-mutation-'))
    const store = new WorkflowStore(dir)
    await store.create({ ...createDefaultWorkflow('old'), id: 'w' })
    const results = await Promise.allSettled([
      store.update('w', { name: 'one', revision: 1 }),
      store.update('w', { name: 'two', revision: 1 }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, 'workflow-versions.json'), 'utf8')).w['2'].name).toBe(store.get('w')?.name)
  })

  for (const boundary of ['workflow-versions.json', 'workflows.json']) it(`rolls a save forward after crashing before ${boundary}`, async () => {
    const { dir, mutations, store } = await setup()
    crashBefore(mutations, boundary)
    await expect(store.update('w', { name: 'new' })).rejects.toThrow('simulated crash')
    expect(store.get('w')?.name).toBe('old')
    await expect(store.update('w', { name: 'later' })).rejects.toThrow('RECOVERY_REQUIRED')
    const recovered = new WorkflowStore(dir, new WorkflowMutationCoordinator(dir))
    await recovered.initialize()
    expect(recovered.get('w')?.name).toBe('new')
    expect(recovered.getRevision('w', 2)?.name).toBe('new')
    await expect(readFile(join(dir, 'workflow-mutation-intent.json'))).rejects.toThrow()
    await new WorkflowMutationCoordinator(dir).initialize()
  })

  for (const boundary of ['workflow-tombstones.json', 'workflows.json', 'workflow-versions.json', 'workflow-runs.json']) it(`recovers deletion without resurrection after crashing before ${boundary}`, async () => {
    const { dir, mutations, store, runs } = await setup()
    crashBefore(mutations, boundary)
    await expect(runs.deleteWorkflow(store, 'w', true)).rejects.toThrow('simulated crash')
    expect(store.get('w')).toBeDefined()
    expect(runs.get('r')).toBeDefined()
    const recoveredMutations = new WorkflowMutationCoordinator(dir)
    const recovered = new WorkflowStore(dir, recoveredMutations)
    const recoveredRuns = new WorkflowRunStore(dir, undefined, recoveredMutations)
    await Promise.all([recovered.initialize(), recoveredRuns.initialize()])
    expect(recovered.get('w')).toBeUndefined()
    expect(recovered.getRevision('w', 1)).toBeDefined()
    expect(recoveredRuns.get('r')).toBeUndefined()
    await expect(recovered.create({ ...createDefaultWorkflow('reuse'), id: 'w' })).rejects.toThrow('TOMBSTONED')
    await expect(recoveredRuns.save(run('r', 'other'))).rejects.toThrow('TOMBSTONED')
    await new WorkflowMutationCoordinator(dir).initialize()
  })

  it('preserves a cross-workflow compensation reference closure and protects it from prune/remove', async () => {
    const { store, runs } = await setup()
    const parent = run('parent', 'outside')
    parent.compensationStack = [{ id: 'compensation', sourceNodeId: 'node', status: 'completed', childRunIds: ['r'] }] as WorkflowRunRecord['compensationStack']
    await runs.save(parent)
    await runs.save({ ...run('r'), retentionExpiresAt: '2020-01-01T00:00:00Z' })
    expect(await runs.deleteWorkflow(store, 'w', true)).toBe(0)
    expect(runs.get('r')).toBeDefined()
    expect(store.get('w')).toBeUndefined()
    expect(store.getRevision('w', 1)).toBeDefined()
    expect(await runs.pruneExpired()).toEqual([])
    await expect(runs.remove('r')).rejects.toThrow('PROTECTED')
    await expect(runs.remove('parent')).rejects.toThrow('PROTECTED')
  })

  it('fails closed on unknown participant contents and a malformed intent', async () => {
    const { dir, mutations, store } = await setup()
    crashBefore(mutations, 'workflows.json')
    await expect(store.update('w', { name: 'new' })).rejects.toThrow()
    await writeFile(join(dir, 'workflows.json'), '[]')
    await expect(new WorkflowMutationCoordinator(dir).initialize()).rejects.toThrow('DIGEST_CONFLICT')
    await writeFile(join(dir, 'workflow-mutation-intent.json'), JSON.stringify({ schemaVersion: 99 }))
    await expect(new WorkflowMutationCoordinator(dir).initialize()).rejects.toThrow('INVALID_INTENT')
  })

  it('rejects symlink state files and writes private intent/files', async () => {
    const { dir, mutations, store } = await setup()
    crashBefore(mutations, 'workflows.json')
    await expect(store.update('w', { name: 'new' })).rejects.toThrow()
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'workflow-mutation-intent.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'workflow-versions.json'))).mode & 0o777).toBe(0o600)
    const unsafeDir = await mkdtemp(join(tmpdir(), 'workflow-symlink-'))
    await symlink(join(dir, 'workflows.json'), join(unsafeDir, 'workflows.json'))
    await expect(new WorkflowStore(unsafeDir).initialize()).rejects.toThrow('UNSAFE_FILE')
  })

  it('keeps old committed reads when clearing intent fails and recovers after another crash', async () => {
    const { dir, store, runs } = await setup()
    faults.failClear = true
    try {
      await expect(runs.deleteWorkflow(store, 'w', true)).rejects.toThrow('clear failed')
      expect(store.get('w')).toBeDefined()
      expect(runs.get('r')).toBeDefined()
      await expect(new WorkflowMutationCoordinator(dir).initialize()).rejects.toThrow('clear failed')
    } finally { faults.failClear = false }
    const recovered = new WorkflowStore(dir, new WorkflowMutationCoordinator(dir))
    await recovered.initialize()
    expect(recovered.get('w')).toBeUndefined()
    await new WorkflowMutationCoordinator(dir).initialize()
  })

  it('rejects a tampered after-image hash before writing any participant', async () => {
    const { dir, mutations, store } = await setup()
    crashBefore(mutations, 'workflow-versions.json')
    await expect(store.update('w', { name: 'new' })).rejects.toThrow()
    const path = join(dir, 'workflow-mutation-intent.json')
    const pending = JSON.parse(await readFile(path, 'utf8'))
    pending.images[0].after = '{}'
    await writeFile(path, JSON.stringify(pending))
    const before = await readFile(join(dir, 'workflows.json'), 'utf8')
    await expect(new WorkflowMutationCoordinator(dir).initialize()).rejects.toThrow('INVALID_INTENT')
    expect(await readFile(join(dir, 'workflows.json'), 'utf8')).toBe(before)
  })

  it('serializes deletion with save and rejects stale run-ID resurrection', async () => {
    const { store, runs } = await setup()
    const deleting = runs.deleteWorkflow(store, 'w', true)
    const updating = store.update('w', { name: 'racing' })
    const outcomes = await Promise.allSettled([deleting, updating])
    expect(outcomes[0]?.status).toBe('fulfilled')
    expect(store.get('w')).toBeUndefined()
    await expect(runs.save(run('r'))).rejects.toThrow('TOMBSTONED')
    await expect(store.create({ ...createDefaultWorkflow('ABA'), id: 'w' })).rejects.toThrow('TOMBSTONED')
  })
})
