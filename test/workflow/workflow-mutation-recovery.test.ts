import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowMutationCoordinator } from '../../src/main/workflow/workflow-mutation-coordinator.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'

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

  for (const operation of ['delete', 'recover-delete', 'prune', 'lineage'] as const) it(`protects verified legacy async runId output during ${operation}`, async () => {
    const { dir, mutations, store, runs } = await setup()
    await store.create({ id: 'parent-definition', name: 'Parent', description: '', nodes: [
      { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'child', type: 'sub-workflow', label: 'Child', position: { x: 200, y: 0 }, config: { workflowId: 'w', waitForCompletion: false } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 400, y: 0 }, config: {} },
    ], edges: [{ id: 'a', source: 'input', target: 'child' }, { id: 'b', source: 'child', target: 'output' }] })
    await runs.save({ ...run('parent', 'parent-definition'), nodeStates: [{ nodeId: 'child', status: 'completed', output: { runId: 'r' } }] })
    await runs.save({ ...run('r'), retentionExpiresAt: '2020-01-01T00:00:00Z' })
    if (operation === 'lineage') {
      const service = new WorkflowRunService({ workflowStore: store, runStore: runs, workflowRoot: dir,
        createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      })
      try {
        await service.initialize()
        expect(runs.get('r')).toMatchObject({ status: 'completed', parentRunId: 'parent', workflowAncestry: ['parent-definition'], origin: { kind: 'child', parentRunId: 'parent' } })
      } finally { await service.stop() }
    } else if (operation === 'prune') {
      expect(await runs.pruneExpired()).toEqual([])
    } else if (operation === 'delete') {
      expect(await runs.deleteWorkflow(store, 'w', true)).toBe(0)
    } else {
      crashBefore(mutations, 'workflow-runs.json')
      await expect(runs.deleteWorkflow(store, 'w', true)).rejects.toThrow('simulated crash')
      const recovered = new WorkflowRunStore(dir, undefined, new WorkflowMutationCoordinator(dir))
      await recovered.initialize()
      expect(recovered.get('r')).toBeDefined()
    }
    expect(runs.get('r')).toBeDefined()
  })

  it('uses the existing run cache when removing through WorkflowStore', async () => {
    const { dir, store, runs } = await setup()
    await store.remove('w')
    expect(runs.get('r')).toBeUndefined()
    await runs.save(run('unrelated', 'other'))
    expect(JSON.parse(await readFile(join(dir, 'workflow-runs.json'), 'utf8')).runs.map((record: WorkflowRunRecord) => record.id)).toEqual(['unrelated'])
  })

  it('does not infer a child from ordinary user output in an exact non-subworkflow node', async () => {
    const { store, runs } = await setup()
    await store.create({ ...createDefaultWorkflow('Parent'), id: 'ordinary-parent' })
    const parent = store.get('ordinary-parent')!
    const node = parent.nodes.find((candidate) => candidate.type === 'output')!
    await runs.save({ ...run('parent', parent.id), nodeStates: [{ nodeId: node.id, status: 'completed', output: { runId: 'r' } }] })
    await runs.save({ ...run('r'), retentionExpiresAt: '2020-01-01T00:00:00Z' })
    expect(await runs.pruneExpired()).toEqual(['r'])
    expect(runs.get('parent')?.parentRunId).toBeUndefined()
  })

  for (const audit of ['effect-dispatched', 'effect-not-dispatched', 'compensation-dispatched', 'compensation-not-dispatched'] as const) it(`supports retained audit without execution after source deletion: ${audit}`, async () => {
    const { dir, store, runs } = await setup()
    const definition = await store.update('w', { nodes: [
      { id: 'input', type: 'input', label: 'Input', position: { x: 0, y: 0 }, config: {} },
      { id: 'effect', type: 'mcp', label: 'Effect', position: { x: 200, y: 0 }, config: { tool: 'write', arguments: {} } },
      { id: 'output', type: 'output', label: 'Output', position: { x: 400, y: 0 }, config: {} },
    ], edges: [{ id: 'a', source: 'input', target: 'effect' }, { id: 'b', source: 'effect', target: 'output' }] })
    await runs.save({ ...run('r'), workflowRevision: definition.revision, status: 'paused',
      nodeStates: [{ nodeId: 'effect', status: 'failed', effectState: 'unknown' }],
      compensationStack: [{ occurrenceId: 'occurrence', sourceNodeId: 'effect', status: 'failed', effectState: 'unknown', action: { type: 'workflow', workflowId: 'undo' } }],
    })
    const service = new WorkflowRunService({ workflowStore: store, runStore: runs, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    try {
      await service.initialize()
      await service.removeWorkflow('w')
      const before = runs.get('r')!
      if (audit === 'effect-not-dispatched') {
        await expect(service.reconcileEffect('r', { nodeId: 'effect', outcome: 'not-dispatched', note: 'verified absent' })).rejects.toThrow('TOMBSTONED')
        expect(runs.get('r')).toEqual(before)
      } else if (audit === 'effect-dispatched') {
        const result = await service.reconcileEffect('r', { nodeId: 'effect', outcome: 'dispatched', note: 'receipt found' })
        expect(result.nodeStates[0]?.effectState).toBe('confirmed')
        expect(result.status).toBe('failed')
      } else {
        const outcome = audit === 'compensation-dispatched' ? 'dispatched' : 'not-dispatched'
        const result = await service.reconcileCompensation('r', { occurrenceId: 'occurrence', outcome, note: 'reviewed' })
        expect(result.compensationStack?.[0]?.effectState).toBe(outcome === 'dispatched' ? 'confirmed' : 'none')
        expect(result.status).toBe('paused')
      }
      await expect(service.resume('r')).rejects.toThrow('TOMBSTONED')
      await expect(service.compensate('r')).rejects.toThrow('TOMBSTONED')
      await expect(runs.saveRetainedAudit({ ...runs.get('r')!, status: 'queued' })).rejects.toThrow('AUDIT_INVALID')
      await expect(runs.save({ ...runs.get('r')!, status: 'queued' })).rejects.toThrow('TOMBSTONED')
      await expect(runs.enqueue({ ...runs.get('r')!, status: 'queued', releaseId: 'claimed-release', environmentId: 'claimed-environment', traceId: 'claimed-trace' })).rejects.toThrow('TOMBSTONED')
      expect(await runs.claimNextDue('test', 10_000)).toBeUndefined()
    } finally { await service.stop() }
    const restarted = new WorkflowRunService({ workflowStore: store, runStore: runs, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    try {
      await restarted.initialize()
      expect(runs.get('r')).toBeDefined()
      expect(runs.get('r')?.status).not.toBe('queued')
    } finally { await restarted.stop() }
  })
})
