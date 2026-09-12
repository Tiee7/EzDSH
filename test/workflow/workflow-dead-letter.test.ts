import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowInternalSessionStore } from '../../src/main/workflow/workflow-internal-session-store.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

async function fixture(limits?: { global: number; perEnvironment: number }) {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-dead-letter-'))
  const workflowStore = new WorkflowStore(dir)
  const workflow = await workflowStore.create({ name: 'Recover', description: '', nodes: [
    { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
    { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } },
  ], edges: [{ id: 'edge', source: 'input', target: 'output' }] })
  const runStore = new WorkflowRunStore(dir, limits)
  const internalSessionStore = new WorkflowInternalSessionStore(dir)
  const createService = (store = runStore) => new WorkflowRunService({ workflowStore, runStore: store, internalSessionStore, workflowRoot: dir,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
  const service = createService()
  await service.initialize()
  await (service as unknown as { worker: { stop(): Promise<void> } }).worker.stop()
  const save = async (id: string, patch: Partial<WorkflowRunRecord> = {}) => runStore.save({ id, workflowId: workflow.id, workflowRevision: workflow.revision, status: 'failed', input: { password: 'private-input' }, events: [], allowShellFile: false,
    nodeStates: [{ nodeId: 'input', status: 'completed', output: 'checkpoint', effectState: 'none' }, { nodeId: 'output', status: 'failed', input: 'saved-input', output: 'diagnostic', effectState: 'none' }], error: 'Authorization: Bearer private-error', ...patch })
  return { dir, runStore, workflowStore, workflow, service, createService, save, internalSessionStore }
}

describe('operational dead letter and bounded recovery', () => {
  it('projects only dead letters, including completed/cancelled compensation blockers, without raw payloads', async () => {
    const f = await fixture()
    for (const status of ['failed', 'paused', 'queued', 'running', 'waiting-approval', 'completed', 'cancelled'] as const) await f.save(status, { status })
    await f.save('compensation', { status: 'completed', compensationStack: [{ sourceNodeId: 'input', action: { type: 'workflow', workflowId: 'undo-secret' }, status: 'failed', effectState: 'unknown', error: 'private-compensation' }] })
    const page = await f.service.listDeadLetters({ workflowId: f.workflow.id, limit: 2 })
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(2)
    const all = await f.service.listDeadLetters({ workflowId: f.workflow.id })
    expect(all.items.map((item) => item.runId).sort()).toEqual(['compensation', 'failed', 'paused'])
    expect(JSON.stringify(all)).not.toMatch(/private-|undo-secret|diagnostic|checkpoint/)
    expect(all.items.find((item) => item.runId === 'failed')?.failureCategory).toBe('legacy-failure-unclassified')
    expect((await f.service.listDeadLetters({ status: 'completed' })).items[0]?.runId).toBe('compensation')
    expect((await f.service.listDeadLetters({ offset: 2, limit: 2 })).items).toHaveLength(1)
  })

  it.each(['pending', 'running', 'failed', 'completed'] as const)('blocks every %s compensation stack for single and batch recovery', async (status) => {
    const f = await fixture()
    const run = await f.save('comp', { compensationStack: [{ sourceNodeId: 'input', action: { type: 'workflow', workflowId: 'undo' }, status }] })
    const preview = await f.service.previewRecovery({ runIds: [run.id] })
    expect(preview[0]).toMatchObject({ decision: 'blocked', reason: 'compensation-present' })
    await expect(f.service.resume(run.id)).rejects.toThrow(/补偿/)
    expect(f.runStore.get(run.id)).toEqual(run)
  })

  it.each(['prepared', 'dispatched', 'unknown', 'confirmed'] as const)('never admits incomplete %s node effects', async (effectState) => {
    const f = await fixture()
    await f.save('effect', { nodeStates: [{ nodeId: 'output', status: 'failed', effectState }] })
    const [preview] = await f.service.previewRecovery({ runIds: ['effect'] })
    expect(preview).toMatchObject({ decision: 'blocked', reason: 'effect-reconciliation-required' })
    const [result] = await f.service.executeRecovery({ requestId: 'request-1', items: [preview!] })
    expect(result).toMatchObject({ status: 'blocked', reason: 'effect-reconciliation-required' })
  })

  it('keeps exact run identity, completed checkpoints and all effect audit while admitting only explicitly selected runs', async () => {
    const f = await fixture()
    const original = await f.save('selected')
    await f.save('not-selected')
    const [preview] = await f.service.previewRecovery({ runIds: [original.id] })
    expect(preview).toMatchObject({ decision: 'eligible', reason: 'safe-to-resume', expectedStateToken: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const result = await f.service.executeRecovery({ requestId: 'request-1', items: [preview!] })
    expect(result).toEqual([{ runId: original.id, status: 'queued', reason: 'safe-to-resume' }])
    expect(f.runStore.get(original.id)).toMatchObject({ workflowId: original.workflowId, workflowRevision: original.workflowRevision, status: 'queued', nodeStates: [{ ...original.nodeStates[0] }, { nodeId: 'output', status: 'pending', effectState: 'none' }] })
    expect(f.runStore.get('not-selected')?.status).toBe('failed')
    expect(f.runStore.list()).toHaveLength(2)
    const disk = JSON.parse(await readFile(join(f.dir, 'workflow-runs.json'), 'utf8'))
    expect(disk.runs.find((run: WorkflowRunRecord) => run.id === original.id).recoveryReceipts).toEqual([{ requestId: 'request-1', acceptedStateToken: preview!.expectedStateToken, acceptedAt: expect.any(String) }])
  })

  it('rejects stale previews after nested audit edits and continues other items independently', async () => {
    const f = await fixture()
    const first = await f.save('first')
    await f.save('second')
    const previews = await f.service.previewRecovery({ runIds: ['first', 'second', 'missing'] })
    first.nodeStates[0]!.output = 'changed checkpoint'
    await f.runStore.save(first)
    expect(await f.service.executeRecovery({ requestId: 'request-1', items: previews })).toMatchObject([
      { runId: 'first', status: 'stale' }, { runId: 'second', status: 'queued' }, { runId: 'missing', status: 'not-found' },
    ])
    expect(f.runStore.get('first')).toEqual(first)
  })

  it('deduplicates retries after restart, lost response and another failure; mismatched tokens conflict', async () => {
    const f = await fixture()
    await f.save('run')
    const items = await f.service.previewRecovery({ runIds: ['run'] })
    const request = { requestId: 'request-1', items }
    await f.service.executeRecovery(request)
    const accepted = f.runStore.get('run')!
    accepted.status = 'failed'
    await f.runStore.save(accepted)
    const store = new WorkflowRunStore(f.dir)
    const service = f.createService(store)
    await service.initialize()
    await (service as unknown as { worker: { stop(): Promise<void> } }).worker.stop()
    expect(await service.executeRecovery(request)).toMatchObject([{ status: 'already-accepted' }])
    expect(store.get('run')?.status).toBe('failed')
    expect(await service.executeRecovery({ ...request, items: [{ ...items[0]!, expectedStateToken: 'a'.repeat(64) }] })).toMatchObject([{ status: 'blocked', reason: 'request-conflict' }])
  })

  it('returns one accepted receipt under simultaneous duplicate submissions', async () => {
    const f = await fixture()
    await f.save('run')
    const items = await f.service.previewRecovery({ runIds: ['run'] })
    const results = await Promise.all([f.service.executeRecovery({ requestId: 'same', items }), f.service.executeRecovery({ requestId: 'same', items })])
    expect(results.flat().map((result) => result.status).sort()).toEqual(['already-accepted', 'queued'])
    expect(f.runStore.get('run')?.recoveryReceipts).toHaveLength(1)
  })

  it('rejects invalid/duplicate/oversized batches before any mutation', async () => {
    const f = await fixture()
    await f.save('run')
    for (const runIds of [[], ['run', 'run'], Array.from({ length: 21 }, (_, i) => `run-${i}`), [' ']]) await expect(f.service.previewRecovery({ runIds })).rejects.toThrow(/Invalid/)
    await expect(f.service.executeRecovery({ requestId: '', items: [] })).rejects.toThrow(/Invalid/)
    expect(f.runStore.get('run')?.status).toBe('failed')
  })

  it('queue-full and disk failures leave zero mutation and never wake the worker', async () => {
    const f = await fixture({ global: 1, perEnvironment: 1 })
    await f.save('occupied', { status: 'queued' })
    const run = await f.save('run')
    const items = await f.service.previewRecovery({ runIds: ['run'] })
    const wake = vi.spyOn((f.service as unknown as { worker: { wake(): void } }).worker, 'wake')
    expect(await f.service.executeRecovery({ requestId: 'full', items })).toMatchObject([{ status: 'blocked', reason: 'queue-full' }])
    expect(f.runStore.get('run')).toEqual(run)
    expect(wake).not.toHaveBeenCalled()
    await f.runStore.remove('occupied')
    vi.spyOn(f.runStore as unknown as { persist(): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('secret-disk-path'))
    expect(await f.service.executeRecovery({ requestId: 'disk', items })).toMatchObject([{ status: 'failed', reason: 'recovery-failed' }])
    expect(f.runStore.get('run')).toEqual(run)
    expect(wake).not.toHaveBeenCalled()
  })

  it('holds expired unresolved node/compensation evidence and linked internal artifacts', async () => {
    const f = await fixture()
    const expiry = '2000-01-01T00:00:00.000Z'
    await f.save('node-audit', { status: 'cancelled', retentionExpiresAt: expiry, nodeStates: [{ nodeId: 'output', status: 'cancelled', effectState: 'unknown' }] })
    await f.save('comp-audit', { status: 'completed', retentionExpiresAt: expiry, compensationStack: [{ sourceNodeId: 'input', action: { type: 'workflow', workflowId: 'undo' }, status: 'pending' }] })
    await f.save('ordinary', { status: 'completed', retentionExpiresAt: expiry })
    for (const runId of ['node-audit', 'comp-audit', 'ordinary']) await f.internalSessionStore.register({ sessionId: `${runId}-session`, runId, workflowId: f.workflow.id, kind: 'skill', createdAt: expiry, archivedAt: expiry, retentionExpiresAt: expiry })
    const remove = vi.fn(async () => {})
    expect(await f.service.cleanupExpiredInternalArtifacts(remove)).toEqual({ runIds: ['ordinary'], sessionIds: ['ordinary-session'] })
    expect(f.runStore.list().map((run) => run.id).sort()).toEqual(['comp-audit', 'node-audit'])
  })

  it('keeps accepted receipts when a stale non-lease snapshot is saved later', async () => {
    const f = await fixture()
    const stale = await f.save('run')
    const items = await f.service.previewRecovery({ runIds: ['run'] })
    await f.service.executeRecovery({ requestId: 'accepted', items })
    await f.runStore.save(stale)
    expect(await f.service.executeRecovery({ requestId: 'accepted', items })).toMatchObject([{ status: 'already-accepted' }])
  })

  it('fails closed for an unavailable fixed revision even if a current definition exists', async () => {
    const f = await fixture()
    const run = await f.save('missing-revision', { workflowRevision: 99 })
    expect(await f.service.previewRecovery({ runIds: [run.id] })).toMatchObject([{ decision: 'blocked', reason: 'definition-unavailable' }])
    await expect(f.service.resume(run.id)).rejects.toThrow(/revision unavailable/)
    expect(f.runStore.get(run.id)).toEqual(run)
  })

  it('blocks confirmed effects lacking a completed output checkpoint', async () => {
    const f = await fixture()
    await f.save('incomplete', { nodeStates: [{ nodeId: 'input', status: 'completed', effectState: 'confirmed' }] })
    expect(await f.service.previewRecovery({ runIds: ['incomplete'] })).toMatchObject([{ decision: 'blocked', reason: 'effect-reconciliation-required' }])
  })

  it('blocks unjournaled legacy effect attempts without inferring safety from error text', async () => {
    const f = await fixture()
    const workflow = await f.workflowStore.create({ name: 'Legacy write', description: '', nodes: [
      f.workflow.nodes[0]!, { id: 'write', type: 'mcp', label: 'Write', config: { tool: 'send', arguments: {} }, position: { x: 100, y: 0 } }, f.workflow.nodes[1]!,
    ], edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }] })
    await f.save('legacy', { workflowId: workflow.id, nodeStates: [{ nodeId: 'write', status: 'failed' }], error: 'known not sent safe retry' })
    expect(await f.service.previewRecovery({ runIds: ['legacy'] })).toMatchObject([{ decision: 'blocked', reason: 'effect-reconciliation-required' }])
  })

  it('fails independently when one preview source resolver throws private data', async () => {
    const f = await fixture()
    await f.save('first')
    await f.save('second')
    const resolve = f.workflowStore.getRevision.bind(f.workflowStore)
    vi.spyOn(f.workflowStore, 'getRevision').mockImplementationOnce(() => { throw new Error('private-storage') }).mockImplementation(resolve)
    const previews = await f.service.previewRecovery({ runIds: ['first', 'second'] })
    expect(previews).toMatchObject([{ decision: 'blocked', reason: 'recovery-failed' }, { decision: 'eligible' }])
    expect(JSON.stringify(previews)).not.toContain('private-')
  })

  it('returns stale after cancellation and blocked while service stops without mutation', async () => {
    const f = await fixture()
    const run = await f.save('run')
    const items = await f.service.previewRecovery({ runIds: [run.id] })
    await f.runStore.save({ ...run, status: 'queued' })
    await f.service.cancel(run.id)
    expect(await f.service.executeRecovery({ requestId: 'cancel', items })).toMatchObject([{ status: 'stale' }])
    const stoppedRecord = await f.runStore.save(run)
    await f.service.stop()
    expect(await f.service.executeRecovery({ requestId: 'stop', items })).toMatchObject([{ status: 'blocked', reason: 'service-unavailable' }])
    expect(f.runStore.get(run.id)).toEqual(stoppedRecord)
  })
})
