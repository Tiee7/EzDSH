import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService, type WorkflowRunServiceOptions } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowEnvironmentStore } from '../../src/main/workflow/workflow-environment-store.js'
import { WorkflowReleaseStore } from '../../src/main/workflow/workflow-release-store.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowConnectorService, type WorkflowConnectorResponse } from '../../src/main/workflow/workflow-connector-service.js'
import { computeWorkflowDefinitionSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import { WorkflowObservationStore } from '../../src/main/workflow/workflow-observation-store.js'
import { WorkflowObservabilityService } from '../../src/main/workflow/workflow-observability-service.js'
import { WorkflowMcpClient } from '../../src/main/workflow/workflow-mcp-client.js'
import type { WorkflowCustomerEnvironment } from '../../src/shared/workflow-operations.js'
import type { EmployeeCreateInput, EmployeeSnapshot } from '../../src/shared/employees.js'
import { validateWorkflow, type WorkflowDefinition, type WorkflowNode, type WorkflowOutputMode, type WorkflowRunRecord, type WorkflowValue } from '../../src/shared/workflow.js'

function graph(): WorkflowDefinition {
  return {
    schemaVersion: 2, id: 'workflow-branch', name: 'Branch', description: '', revision: 1, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: { name: 'task' }, position: { x: 0, y: 0 } },
      { id: 'check', type: 'condition', label: 'Check', config: { operator: 'equals', value: 'yes' }, position: { x: 200, y: 0 } },
      { id: 'yes', type: 'transform', label: 'Yes', config: { template: 'prepend', text: 'accepted: ' }, position: { x: 400, y: -80 } },
      { id: 'no', type: 'transform', label: 'No', config: { template: 'prepend', text: 'rejected: ' }, position: { x: 400, y: 80 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 620, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'check' },
      { id: 'e2', source: 'check', target: 'yes', sourcePort: 'true' },
      { id: 'e3', source: 'check', target: 'no', sourcePort: 'false' },
      { id: 'e4', source: 'yes', target: 'output' },
      { id: 'e5', source: 'no', target: 'output' },
    ],
  }
}

async function stoppedApprovalFixture(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), `ezdsh-${prefix}-`))
  const workflowStore = new WorkflowStore(dir)
  const workflow = await workflowStore.create({
    id: `${prefix}-workflow`, name: 'Approval mutation', description: '',
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'approval', type: 'approval', label: 'Approval', config: { message: 'Confirm' }, position: { x: 200, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
    ],
    edges: [{ id: 'a', source: 'input', target: 'approval' }, { id: 'b', source: 'approval', target: 'output' }],
  })
  const runStore = new WorkflowRunStore(dir)
  const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
  })
  await service.initialize()
  await service.stop()
  return { dir, workflow, workflowStore, runStore, service }
}

async function loopSafetyFixture(body: WorkflowNode, connectorService?: WorkflowRunServiceOptions['connectorService'], failureStrategy: 'stop' | 'continue' = 'stop') {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-loop-safety-'))
  const workflowStore = new WorkflowStore(dir)
  const runStore = new WorkflowRunStore(dir)
  const compensations: WorkflowValue[] = []
  const workflow = await workflowStore.create({
    name: 'Loop safety', description: '',
    nodes: [graph().nodes[0]!, { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10, failureStrategy }, position: { x: 200, y: 0 } }, body, graph().nodes[4]!],
    edges: [{ id: 'a', source: 'input', target: 'loop' }, { id: 'b', source: 'loop', target: body.id, sourcePort: 'loop-body' }, { id: 'c', source: 'loop', target: 'output', sourcePort: 'loop-next' }],
  })
  const createService = (store = runStore) => new WorkflowRunService({
    workflowStore, runStore: store, workflowRoot: dir, connectorService,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
    resolveEmployee: () => undefined,
    executeSubWorkflow: async (_id, input) => { compensations.push(input); return 'undone' },
  })
  return { dir, workflow, runStore, compensations, createService, service: createService() }
}

function loopResponse(body: WorkflowValue = 'ok'): WorkflowConnectorResponse {
  return { status: 200, ok: true, headers: {}, body }
}

const loopWriteNode: WorkflowNode = {
  id: 'body', type: 'http', label: 'Write item', position: { x: 200, y: 200 },
  config: { method: 'POST', connectorId: 'crm', connectorPath: '/items', responseMode: 'json' },
}

describe('effect reconciliation', () => {
  async function parallelFixture(loop: boolean, complete: () => Promise<string> = async () => 'pure done', request: NonNullable<WorkflowRunServiceOptions['connectorService']>['request'] = async () => loopResponse()) {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-reconcile-parallel-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const pure: WorkflowNode = { id: 'pure', type: 'ai-task', label: 'Pure', config: { instruction: 'answer', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 200 } }
    const workflow = await workflowStore.create({
      name: 'Parallel reconciliation', description: '',
      nodes: [graph().nodes[0]!, ...(loop ? [{ id: 'loop', type: 'loop' as const, label: 'Loop', config: { maxIterations: 10 }, position: { x: 200, y: 0 } }] : []), loopWriteNode, pure, graph().nodes[4]!],
      edges: [
        { id: 'input-write', source: 'input', target: loop ? 'loop' : 'body' },
        ...(loop ? [{ id: 'body', source: 'loop', target: 'body', sourcePort: 'loop-body' as const }] : []),
        { id: 'input-pure', source: 'input', target: 'pure' },
        { id: 'write-output', source: loop ? 'loop' : 'body', target: 'output', ...(loop ? { sourcePort: 'loop-next' as const } : {}) },
        { id: 'pure-output', source: 'pure', target: 'output' },
      ],
    })
    const createService = (store = runStore) => new WorkflowRunService({ workflowStore, runStore: store, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      lightweightClient: { complete }, connectorService: { request },
    })
    return { dir, workflow, runStore, createService, service: createService() }
  }

  async function ordinary() {
    const fixture = await createReleasedAccessFixture(loopWriteNode)
    const run = await fixture.service.startReleased(fixture.release.id, 'item')
    run.status = 'paused'
    Object.assign(run.nodeStates.find((state) => state.nodeId === 'body')!, { status: 'pending', effectState: 'unknown', error: 'response lost' })
    await fixture.runStore.save(run)
    return { ...fixture, run }
  }

  it.each(['paused', 'failed'] as const)('persists a confirmed terminal decision from %s and notifies observers without output or downstream execution', async (status) => {
    const fixture = await ordinary()
    fixture.run.status = status
    await fixture.runStore.save(fixture.run)
    const observed: WorkflowRunRecord[] = []
    fixture.service.watch((record) => observed.push(record))
    const result = await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'dispatched', note: '  checked receipt  ' })
    expect(result.status).toBe('failed')
    expect(result.nodeStates.find((state) => state.nodeId === 'body')).toMatchObject({ status: 'failed', effectState: 'confirmed', effectReconciliation: { outcome: 'dispatched', note: 'checked receipt', resolvedAt: expect.any(String) } })
    expect(result.nodeStates.find((state) => state.nodeId === 'body')?.output).toBeUndefined()
    expect(result.nodeStates.find((state) => state.nodeId === 'output')?.status).toBe('pending')
    expect(result.events.at(-1)).toMatchObject({ type: 'node-effect-reconciled-dispatched', nodeId: 'body' })
    expect(result.events.at(-1)?.message).not.toContain('checked receipt')
    expect(observed.at(-1)).toEqual(result)
    await expect(fixture.service.resume(result.id)).rejects.toThrow(/副作用/u)
    await expect(fixture.service.reconcileEffect(result.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'again' })).rejects.toThrow()
    expect(fixture.fetchImpl).not.toHaveBeenCalled()
  })

  it('atomically saves an ordinary not-dispatched decision with its exact reset and queue state', async () => {
    const fixture = await ordinary()
    const observed: WorkflowRunRecord[] = []
    fixture.service.watch((record) => observed.push(record))
    const result = await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'no request received' })
    expect(result).toMatchObject({ status: 'queued', queue: { availableAt: expect.any(String) } })
    expect(result.nodeStates.find((state) => state.nodeId === 'body')).toMatchObject({ status: 'pending', effectState: 'none', effectReconciliation: { outcome: 'not-dispatched' } })
    expect(result.nodeStates.find((state) => state.nodeId === 'body')?.error).toBeUndefined()
    expect(observed).toHaveLength(1)
    expect(observed[0]).toEqual(result)
    expect(result.events.at(-1)?.type).toBe('node-effect-reconciled-not-dispatched')
  })

  it.each(['queued', 'running', 'completed', 'cancelled', 'waiting-approval'] as const)('rejects reconciliation of a %s run without mutation', async (status) => {
    const fixture = await ordinary()
    fixture.run.status = status
    await fixture.runStore.save(fixture.run)
    const before = fixture.service.get(fixture.run.id)
    await expect(fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'dispatched', note: 'verified' })).rejects.toThrow()
    expect(fixture.service.get(fixture.run.id)).toEqual(before)
  })

  it('rejects missing, wrong-iteration and non-unknown targets without mutation', async () => {
    const fixture = await ordinary()
    const before = fixture.service.get(fixture.run.id)
    for (const target of [{ nodeId: 'missing' }, { nodeId: 'input' }, { nodeId: 'body', iterationId: 'not-an-iteration' }]) {
      await expect(fixture.service.reconcileEffect(fixture.run.id, { ...target, outcome: 'dispatched', note: 'verified' })).rejects.toThrow()
      expect(fixture.service.get(fixture.run.id)).toEqual(before)
    }
  })

  it('validates untrusted service inputs before mutation', async () => {
    const fixture = await ordinary()
    const before = fixture.service.get(fixture.run.id)
    for (const request of [null, {}, { nodeId: 'body', outcome: 'dispatched', note: ' ' }, { nodeId: 'body', outcome: 'dispatched', note: 'x'.repeat(501) }, { nodeId: 'body', outcome: 'other', note: 'ok' }]) {
      await expect(fixture.service.reconcileEffect(fixture.run.id, request as never)).rejects.toThrow()
    }
    expect(fixture.service.get(fixture.run.id)).toEqual(before)
  })

  it('keeps multiple unknown effects paused until the final unsafe target is reconciled', async () => {
    const fixture = await ordinary()
    // Durable imported runs may carry more than one uncertain external effect.
    fixture.run.nodeStates.push({ nodeId: 'second', status: 'pending', effectState: 'unknown' })
    fixture.run.nodeStates.find((state) => state.nodeId === 'input')!.status = 'running'
    await fixture.runStore.save(fixture.run)
    const first = await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'first checked' })
    expect(first.status).toBe('paused')
    expect(first.nodeStates.find((state) => state.nodeId === 'input')?.status).toBe('running')
    expect(first.nodeStates.find((state) => state.nodeId === 'second')).toEqual({ nodeId: 'second', status: 'pending', effectState: 'unknown' })
    expect(first.nodeStates.find((state) => state.nodeId === 'body')).toMatchObject({ effectState: 'none', effectReconciliation: { outcome: 'not-dispatched' } })
    const final = await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'second', outcome: 'not-dispatched', note: 'second checked' })
    expect(final.status).toBe('queued')
    expect(final.nodeStates.find((state) => state.nodeId === 'input')?.status).toBe('pending')
  })

  it('accepts only one concurrent decision for an unknown target', async () => {
    const fixture = await ordinary()
    const results = await Promise.allSettled([
      fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'dispatched', note: 'receipt' }),
      fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'absent' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(fixture.service.get(fixture.run.id)?.events.filter((event) => event.type.startsWith('node-effect-reconciled-'))).toHaveLength(1)
  })

  it('retains every decision note when the same target becomes unknown again and reloads', async () => {
    const fixture = await ordinary()
    const first = await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'first investigation' })
    first.status = 'paused'
    first.nodeStates.find((state) => state.nodeId === 'body')!.effectState = 'unknown'
    delete first.effectReconciliationTargets
    await fixture.runStore.save(first)
    const final = await fixture.service.reconcileEffect(first.id, { nodeId: 'body', outcome: 'dispatched', note: 'second investigation' })
    const state = final.nodeStates.find((candidate) => candidate.nodeId === 'body')!
    expect(state.effectReconciliationHistory).toEqual([
      { outcome: 'not-dispatched', note: 'first investigation', resolvedAt: expect.any(String) },
      { outcome: 'dispatched', note: 'second investigation', resolvedAt: expect.any(String) },
    ])
    expect(state.effectReconciliation).toEqual(state.effectReconciliationHistory?.at(-1))
    const reloaded = new WorkflowRunStore(fixture.dir)
    await reloaded.initialize()
    expect(reloaded.get(first.id)?.nodeStates.find((candidate) => candidate.nodeId === 'body')?.effectReconciliationHistory).toEqual(state.effectReconciliationHistory)
  })

  it.each(['running', 'failed', 'cancelled'] as const)('resumes interrupted safe %s branches after crash recovery and exact loop reconciliation', async (pureStatus) => {
    const writes: WorkflowValue[] = []
    let pureCalls = 0
    const fixture = await parallelFixture(true, async () => { pureCalls += 1; return 'pure done' }, async (_request, _input, previous) => { writes.push(previous); return loopResponse(previous) })
    await fixture.service.initialize()
    await fixture.service.stop()
    const queued = await fixture.service.start(fixture.workflow.id, ['A', 'B'])
    const checkpoint = (await fixture.runStore.claimNextDue('crashed-worker', 60_000))!
    expect(checkpoint.id).toBe(queued.id)
    Object.assign(checkpoint.nodeStates.find((state) => state.nodeId === 'input')!, { status: 'completed', output: ['A', 'B'] })
    Object.assign(checkpoint.nodeStates.find((state) => state.nodeId === 'pure')!, { status: pureStatus, startedAt: new Date().toISOString(), error: 'interrupted' })
    const iterationId = `${checkpoint.id}:loop:loop:iteration:1`
    const completed = { iterationIndex: 0, iterationId: `${checkpoint.id}:loop:loop:iteration:0`, input: 'A', status: 'completed' as const, output: 'saved-A', nodeStates: [{ nodeId: 'body', status: 'completed' as const, effectState: 'confirmed' as const, output: 'saved-A' }] }
    Object.assign(checkpoint.nodeStates.find((state) => state.nodeId === 'loop')!, { status: 'running', loopIterations: [completed, { iterationIndex: 1, iterationId, input: 'B', status: 'running', nodeStates: [{ nodeId: 'body', status: 'running', effectState: 'dispatched' }] }] })
    await fixture.runStore.save(checkpoint)
    const restoredStore = new WorkflowRunStore(fixture.dir)
    const restarted = fixture.createService(restoredStore)
    try {
      await restarted.initialize()
      const recovered = restarted.get(checkpoint.id)!
      expect(recovered.status).toBe('paused')
      expect(recovered.nodeStates.find((state) => state.nodeId === 'pure')?.status).toBe(pureStatus)
      expect(recovered.nodeStates.find((state) => state.nodeId === 'loop')?.loopIterations?.[1]?.nodeStates[0]).toMatchObject({ effectState: 'unknown', status: 'cancelled' })
      const reconciled = await restarted.reconcileEffect(checkpoint.id, { nodeId: 'body', iterationId, outcome: 'not-dispatched', note: 'checked absent' })
      expect(reconciled.nodeStates.find((state) => state.nodeId === 'pure')).toMatchObject({ status: 'pending' })
      expect(reconciled.nodeStates.find((state) => state.nodeId === 'loop')?.loopIterations?.[0]).toEqual(completed)
      const result = await eventually(restarted, checkpoint.id)
      expect(result.status, result.error).toBe('completed')
      expect(result.nodeStates.find((state) => state.nodeId === 'pure')?.output).toBe('pure done')
      expect(writes).toEqual(['B'])
      expect(pureCalls).toBe(1)
      expect(result.nodeStates.find((state) => state.nodeId === 'loop')?.loopIterations?.[0]).toEqual(completed)
    } finally { await restarted.stop() }
  })

  it.each(['dispatched', 'not-dispatched'] as const)('rejects %s reconciliation while a parallel branch is still active, then permits it after execution settles', async (outcome) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let pureStarted!: () => void
    const started = new Promise<void>((resolve) => { pureStarted = resolve })
    const fixture = await parallelFixture(false, async () => { pureStarted(); await gate; return 'pure done' }, async () => { await started; throw new Error('response lost') })
    try {
      const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, 'item')).id)
      expect(run.status).toBe('paused')
      expect(run.nodeStates.find((state) => state.nodeId === 'pure')?.status).toBe('running')
      const before = fixture.service.get(run.id)
      await expect(fixture.service.reconcileEffect(run.id, { nodeId: 'body', outcome, note: 'verified' })).rejects.toThrow(/仍在执行/u)
      expect(fixture.service.get(run.id)).toEqual(before)
      release()
      // stop waits for actual worker execution cleanup; no private active-map manipulation.
      await fixture.service.stop()
      expect(await fixture.service.reconcileEffect(run.id, { nodeId: 'body', outcome, note: 'verified after settling' })).toMatchObject({ status: outcome === 'dispatched' ? 'failed' : 'queued' })
    } finally { release(); await fixture.service.stop() }
  })

  it('revalidates current environment before requeue and preserves an unresolved decision if disabled', async () => {
    const fixture = await ordinary()
    const before = fixture.service.get(fixture.run.id)
    await fixture.environmentStore.upsert({ ...fixture.environment, status: 'disabled' })
    await expect(fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'checked' })).rejects.toThrow(/environment must be active/u)
    expect(fixture.service.get(fixture.run.id)).toEqual(before)
    expect((await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'dispatched', note: 'receipt found' })).status).toBe('failed')
  })

  it('narrows current environment grants when requeueing', async () => {
    const fixture = await ordinary()
    await fixture.environmentStore.upsert({ ...fixture.environment, connectorIds: [], allowCode: false, allowShellFile: false })
    expect(await fixture.service.reconcileEffect(fixture.run.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'checked' })).toMatchObject({ connectorGrants: [], allowCode: false, allowShellFile: false })
  })

  it.each(['not-dispatched', 'dispatched'] as const)('selects the exact loop iteration, reloads its %s audit and never replays completed items', async (outcome) => {
    const calls: WorkflowValue[] = []
    let failed = false
    const fixture = await loopSafetyFixture(loopWriteNode, { request: async (_request, _input, previous) => {
      calls.push(previous)
      if (previous === 'B' && !failed) { failed = true; throw new Error('response lost') }
      return loopResponse(previous)
    } })
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['A', 'B'])).id)
    await fixture.service.stop()
    const iterations = run.nodeStates.find((state) => state.nodeId === 'loop')!.loopIterations!
    for (const target of [{ nodeId: 'body' }, { nodeId: 'body', iterationId: iterations[0]!.iterationId }, { nodeId: 'output', iterationId: iterations[1]!.iterationId }]) {
      await expect(fixture.service.reconcileEffect(run.id, { ...target, outcome, note: 'checked' })).rejects.toThrow()
    }
    const result = await fixture.service.reconcileEffect(run.id, { nodeId: 'body', iterationId: iterations[1]!.iterationId, outcome, note: '  checked  ' })
    expect(result.nodeStates.find((state) => state.nodeId === 'loop')!.loopIterations![0]).toEqual(iterations[0])
    expect(result.events.at(-1)).toMatchObject({ type: `node-effect-reconciled-${outcome}`, executionScope: { iterationId: iterations[1]!.iterationId, iterationIndex: 1, loopNodeId: 'loop' } })
    const reloadedStore = new WorkflowRunStore(fixture.dir)
    await reloadedStore.initialize()
    const restored = reloadedStore.get(run.id)!
    expect(restored.nodeStates.find((state) => state.nodeId === 'loop')!.loopIterations![1]!.nodeStates[0]?.effectReconciliation).toEqual({ outcome, note: 'checked', resolvedAt: expect.any(String) })
    const restarted = fixture.createService(reloadedStore)
    await restarted.initialize()
    if (outcome === 'not-dispatched') {
      expect((await eventually(restarted, run.id)).status).toBe('completed')
      expect(calls).toEqual(['A', 'B', 'B'])
    } else {
      expect(restarted.get(run.id)?.status).toBe('failed')
      await expect(restarted.resume(run.id)).rejects.toThrow(/副作用/u)
      expect(calls).toEqual(['A', 'B'])
    }
    await restarted.stop()
  })
})

describe('durable loop execution identity', () => {
  it('keeps derived managed-connector keys within the real 200-character dispatch boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-managed-key-boundary-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const credentials = new WorkflowCredentialStore(dir)
    await credentials.upsert({
      id: 'token', label: 'Token', type: 'bearer-token', secret: 'secret',
      scopes: [{ origin: 'https://api.example.test', methods: ['POST'], headerName: 'Authorization', pathPrefixes: ['/write'] }],
    })
    const connectors = new WorkflowConnectorStore(dir)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', credentialRef: { id: 'token' }, allowedPathPrefixes: ['/write'] })
    const sentKeys: string[] = []
    const connectorService = new WorkflowConnectorService({
      connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }],
      fetchImpl: (async (_url: URL | string, init?: RequestInit) => {
        sentKeys.push((init?.headers as Record<string, string>)['Idempotency-Key'])
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    const workflow = await workflowStore.create({
      id: 'managed-key-boundary', name: 'Boundary', description: '', permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['write'] }] },
      nodes: [graph().nodes[0]!, { id: 'write', type: 'http', label: 'Write', config: { method: 'POST', connectorId: 'api', connectorPath: '/write' }, position: { x: 200, y: 0 } }, graph().nodes[4]!],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir, connectorService,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    try {
      const grant = [{ connectorId: 'api', operations: ['write' as const] }]
      const atBoundary = await eventually(service, (await service.start(workflow.id, null, { idempotencyKey: 'a'.repeat(176), connectorGrants: grant })).id)
      const overBoundary = await eventually(service, (await service.start(workflow.id, null, { idempotencyKey: 'b'.repeat(177), connectorGrants: grant })).id)
      expect([atBoundary.status, overBoundary.status]).toEqual(['completed', 'completed'])
      expect(sentKeys[0]).toHaveLength(200)
      expect(sentKeys[0]).toMatch(/^a{176}:effect:/u)
      expect(sentKeys[1]!.length).toBeLessThanOrEqual(200)
      expect(sentKeys[1]).not.toMatch(/^b{177}:effect:/u)
    } finally { await service.stop() }
  })

  it.each([{ name: 'last of two items', items: ['A', 'B'] }, { name: 'only item', items: ['B'] }])('completes a continue loop when its final item fails ($name)', async ({ items }) => {
    const fixture = await loopSafetyFixture({ ...loopWriteNode, config: { ...loopWriteNode.config, method: 'GET' } }, {
      request: async (_request, _input, previous) => { if (previous === 'B') throw new Error('last read failed'); return loopResponse(previous) },
    }, 'continue')
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, items)).id)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual([...items.slice(0, -1).map((item) => loopResponse(item)), { error: 'last read failed', index: items.length }])
    const failedIteration = run.nodeStates.find((state) => state.nodeId === 'loop')?.loopIterations?.at(-1)
    expect(failedIteration).toMatchObject({ status: 'completed', output: { error: 'last read failed', index: items.length }, nodeStates: [{ nodeId: 'body', status: 'failed', error: 'last read failed' }] })
    expect(run.nodeStates.find((state) => state.nodeId === 'body')?.status).toBe('failed')
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'node-failed', nodeId: 'body', executionScope: expect.objectContaining({ iterationIndex: items.length - 1 }) }))
    await fixture.service.stop()
  })

  it('still fails a stop loop when its final item fails', async () => {
    const fixture = await loopSafetyFixture({ ...loopWriteNode, config: { ...loopWriteNode.config, method: 'GET' } }, {
      request: async () => { throw new Error('unhandled read failed') },
    })
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['B'])).id)
    expect(run.status).toBe('failed')
    expect(run.nodeStates.find((state) => state.nodeId === 'loop')?.status).not.toBe('completed')
    expect(run.error).toBe('unhandled read failed')
    await fixture.service.stop()
  })

  it('continues past a failed read without losing the queue lease or replaying the failed item', async () => {
    let calls = 0
    const fixture = await loopSafetyFixture({ ...loopWriteNode, config: { ...loopWriteNode.config, method: 'GET' } }, { request: async () => { calls += 1; if (calls === 1) throw new Error('read failed'); return loopResponse() } }, 'continue')
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['A', 'B'])).id)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual([{ error: 'read failed', index: 1 }, loopResponse()])
    expect(calls).toBe(2)
    await fixture.service.stop()
  })

  it('uses distinct stable managed write keys for different iterations', async () => {
    const keys: Array<string | undefined> = []
    const fixture = await loopSafetyFixture(loopWriteNode, { request: async (request) => { keys.push(request.idempotencyKey); return loopResponse() } })
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['A', 'B'])).id)
    expect(run.status).toBe('completed')
    expect(keys).toEqual([`${run.id}:loop:loop:iteration:0:node:body`, `${run.id}:loop:loop:iteration:1:node:body`])
    await fixture.service.stop()
  })

  it('retries the same iteration with its stable key and preserves prior completed iterations', async () => {
    const keys: Array<string | undefined> = []
    let calls = 0
    const fixture = await loopSafetyFixture({ ...loopWriteNode, retryPolicy: { mode: 'idempotent', maxAttempts: 2, baseDelayMs: 0, jitterRatio: 0 } }, {
      request: async (request) => { keys.push(request.idempotencyKey); calls += 1; if (calls === 2) throw new Error('temporary connection failure'); return loopResponse() },
    })
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['A', 'B'])).id)
    expect(run.status).toBe('completed')
    expect(keys).toEqual([`${run.id}:loop:loop:iteration:0:node:body`, `${run.id}:loop:loop:iteration:1:node:body`, `${run.id}:loop:loop:iteration:1:node:body`])
    expect(run.nodeStates.find((state) => state.nodeId === 'loop')?.loopIterations?.map((iteration) => iteration.nodeStates[0]?.attempt)).toEqual([1, 2])
    expect(run.events.filter((event) => event.type === 'node-retry').map((event) => event.executionScope?.iterationIndex)).toEqual([1])
    await fixture.service.stop()
  })

  it('pauses an ambiguous loop effect and refuses resume without replay', async () => {
    let calls = 0
    const fixture = await loopSafetyFixture(loopWriteNode, { request: async () => { calls += 1; throw new Error('response lost') } })
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['A', 'B'])).id)
    expect(run.status).toBe('paused')
    await expect(fixture.service.resume(run.id)).rejects.toThrow(/副作用/u)
    expect(calls).toBe(1)
    await fixture.service.stop()
  })

  it('restores completed iterations and body checkpoints from disk without reexecuting them', async () => {
    const fixture = await loopSafetyFixture({ id: 'body', type: 'transform', label: 'Body', config: { template: 'append', text: '!' }, position: { x: 200, y: 200 } })
    await fixture.service.initialize()
    await fixture.service.stop()
    const run = await fixture.service.start(fixture.workflow.id, ['A', 'B', 'C'])
    run.status = 'paused'
    run.nodeStates.find((state) => state.nodeId === 'input')!.status = 'completed'
    run.nodeStates.find((state) => state.nodeId === 'input')!.output = ['A', 'B', 'C']
    Object.assign(run.nodeStates.find((state) => state.nodeId === 'loop')!, {
      status: 'pending', loopIterations: [
        { iterationIndex: 0, iterationId: `${run.id}:loop:loop:iteration:0`, input: 'A', status: 'completed', output: 'saved-A', nodeStates: [{ nodeId: 'body', status: 'completed', output: 'saved-A' }] },
        { iterationIndex: 1, iterationId: `${run.id}:loop:loop:iteration:1`, input: 'B', status: 'running', nodeStates: [{ nodeId: 'body', status: 'completed', output: 'saved-B' }] },
      ],
    })
    await fixture.runStore.save(run)
    const restarted = fixture.createService(new WorkflowRunStore(fixture.dir))
    await restarted.resume(run.id)
    const result = await eventually(restarted, run.id)
    expect(result.output).toEqual(['saved-A', 'saved-B', 'C!'])
    expect(result.events.filter((event) => event.type === 'node-started' && event.nodeId === 'body')).toHaveLength(1)
    await restarted.stop()
  })

  it('registers one compensation entry per completed effectful iteration', async () => {
    const fixture = await loopSafetyFixture({ ...loopWriteNode, compensation: { type: 'workflow', workflowId: 'undo' } }, { request: async (_request, _input, previous) => loopResponse(previous) })
    const run = await eventually(fixture.service, (await fixture.service.start(fixture.workflow.id, ['A', 'B'])).id)
    expect(run.compensationStack).toHaveLength(2)
    expect(run.compensationStack?.map((entry) => entry.executionScope?.iterationIndex)).toEqual([0, 1])
    await fixture.service.compensate(run.id)
    expect(fixture.compensations).toEqual([loopResponse('B'), loopResponse('A')])
    await fixture.service.compensate(run.id)
    expect(fixture.compensations).toHaveLength(2)
    await fixture.service.stop()
  })

  it('does not replay a legacy partial loop whose iteration history is unavailable', async () => {
    let writes = 0
    const fixture = await loopSafetyFixture(loopWriteNode, { request: async () => { writes += 1; return loopResponse() } })
    await fixture.service.initialize()
    await fixture.service.stop()
    const run = await fixture.service.start(fixture.workflow.id, ['A', 'B'])
    run.status = 'paused'
    Object.assign(run.nodeStates.find((state) => state.nodeId === 'input')!, { status: 'completed', output: ['A', 'B'] })
    Object.assign(run.nodeStates.find((state) => state.nodeId === 'loop')!, { status: 'running', attempt: 1 })
    Object.assign(run.nodeStates.find((state) => state.nodeId === 'body')!, { status: 'completed', effectState: 'confirmed', output: { ok: true } })
    await fixture.runStore.save(run)
    const restarted = fixture.createService(new WorkflowRunStore(fixture.dir))
    await expect(restarted.resume(run.id)).rejects.toThrow(/迭代|副作用/u)
    expect(writes).toBe(0)
    await restarted.stop()
  })
})

function reviewer(enabled = true): EmployeeSnapshot {
  return {
    schemaVersion: 2,
    version: 1,
    id: 'content-reviewer',
    name: '内容审核员',
    role: '审核专员',
    description: '',
    businessBoundary: '只审核内容，不负责发布',
    systemPrompt: '检查事实',
    operatingGuidelines: ['逐项检查'],
    qualityStandards: ['事实有依据'],
    capabilities: ['research'],
    skillIds: [],
    enabled,
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

async function createNodeService(options: {
  node: WorkflowNode
  responses?: string[]
  resolveEmployee?: (id: string) => EmployeeSnapshot | undefined
  executeSubWorkflow?: (workflowId: string, input: any, waitForCompletion: boolean) => Promise<any>
  mcpClient?: WorkflowRunServiceOptions['mcpClient']
}): Promise<{
  service: WorkflowRunService
  workflowStore: WorkflowStore
  workflowId: string
  sendPrompt: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  mcpCall: ReturnType<typeof vi.fn>
  archiveSession: ReturnType<typeof vi.fn>
  selectSessionModel: ReturnType<typeof vi.fn>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-node-'))
  const workflowStore = new WorkflowStore(dir)
  const input: WorkflowNode = { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }
  const output: WorkflowNode = { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } }
  const workflow = await workflowStore.create({
    id: `workflow-${options.node.id}`,
    name: options.node.label,
    description: '',
    nodes: [input, options.node, output],
    edges: [
      { id: 'edge-input', source: input.id, target: options.node.id },
      { id: 'edge-output', source: options.node.id, target: output.id },
    ],
  })
  const responses = [...(options.responses ?? ['完成'])]
  const sendPrompt = vi.fn(async () => ({ text: responses.shift() ?? '' }))
  const createSession = vi.fn(async () => ({ sessionId: 'session-node' }))
  const complete = vi.fn(async () => responses.shift() ?? '')
  const mcpCall = vi.fn(async () => 'mcp-complete')
  const archiveSession = vi.fn(async () => undefined)
  const selectSessionModel = vi.fn(async () => ({ selected: { provider: 'openai-codex', model: 'gpt-5.6-luna' } }))
  const service = new WorkflowRunService({
    workflowStore,
    runStore: new WorkflowRunStore(dir),
    workflowRoot: dir,
    createClient: () => ({
      createSession,
      sendPrompt,
      archiveSession,
      selectSessionModel,
    }),
    resolveEmployee: options.resolveEmployee ?? (() => undefined),
    lightweightClient: { complete },
    mcpClient: options.mcpClient ?? { call: mcpCall },
    executeSubWorkflow: options.executeSubWorkflow,
  })
  return { service, workflowStore, workflowId: workflow.id, sendPrompt, createSession, complete, mcpCall, archiveSession, selectSessionModel }
}

async function eventually(service: WorkflowRunService, runId: string): Promise<NonNullable<ReturnType<WorkflowRunService['get']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = service.get(runId)
    if (record !== undefined && ['completed', 'failed', 'cancelled', 'paused', 'waiting-approval'].includes(record.status)) return record as NonNullable<ReturnType<WorkflowRunService['get']>>
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('run did not finish in time')
}

async function overwriteWorkflowVersionsWithCurrentOnly(dir: string, workflow: WorkflowDefinition): Promise<void> {
  await writeFile(join(dir, 'workflow-versions.json'), `${JSON.stringify({
    [workflow.id]: { [String(workflow.revision)]: workflow },
  }, null, 2)}\n`)
}

describe('ordinary run revision boundaries', () => {
  const historicalNodes: WorkflowNode[] = [
    { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
    { id: 'first', type: 'transform', label: 'Historical first', config: { template: 'identity' }, position: { x: 200, y: 0 } },
    { id: 'second', type: 'transform', label: 'Historical second', config: { template: 'identity' }, position: { x: 400, y: 0 } },
    { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
  ]
  const currentWriteNodes: WorkflowNode[] = [
    historicalNodes[0]!,
    { id: 'first', type: 'mcp', label: 'Current MCP write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
    { id: 'second', type: 'http', label: 'Current managed write', config: { method: 'POST', connectorId: 'crm', connectorPath: '/write', responseMode: 'json' }, position: { x: 400, y: 0 } },
    historicalNodes[3]!,
  ]
  const edges = [
    { id: 'a', source: 'input', target: 'first' },
    { id: 'b', source: 'first', target: 'second' },
    { id: 'c', source: 'second', target: 'output' },
  ]

  async function missingHistoricalRevisionFixture(kind: 'queued' | 'approval' | 'paused') {
    const dir = await mkdtemp(join(tmpdir(), `ezdsh-missing-run-revision-${kind}-`))
    const authoringStore = new WorkflowStore(dir)
    const initialNodes: WorkflowNode[] = kind === 'approval'
      ? [
          historicalNodes[0]!,
          { id: 'approval', type: 'approval', label: 'Historical approval', config: { message: 'Confirm' }, position: { x: 200, y: 0 } },
          historicalNodes[3]!,
        ]
      : historicalNodes
    const initialEdges = kind === 'approval'
      ? [{ id: 'a', source: 'input', target: 'approval' }, { id: 'b', source: 'approval', target: 'output' }]
      : edges
    const historical = await authoringStore.create({ id: `missing-${kind}`, name: 'Historical', description: '', nodes: initialNodes, edges: initialEdges })
    const current = await authoringStore.update(historical.id, {
      ...historical,
      nodes: kind === 'approval' ? initialNodes.map((node) => ({ ...node, label: `Current ${node.label}` })) : currentWriteNodes,
      edges: initialEdges,
    })
    await overwriteWorkflowVersionsWithCurrentOnly(dir, current)

    const runStore = new WorkflowRunStore(dir)
    const record: WorkflowRunRecord = {
      id: `run-missing-${kind}`,
      workflowId: historical.id,
      workflowRevision: historical.revision,
      status: kind === 'approval' ? 'waiting-approval' : kind,
      ...(kind === 'approval' ? { waitingApprovalNodeId: 'approval' } : {}),
      queue: { enqueuedAt: new Date().toISOString(), availableAt: new Date().toISOString() },
      input: 'payload',
      allowShellFile: false,
      connectorGrants: [{ connectorId: 'crm', operations: ['write'] }],
      nodeStates: initialNodes.map((node) => ({
        nodeId: node.id,
        status: kind === 'approval' && node.id === 'input' ? 'completed' : kind === 'approval' && node.id === 'approval' ? 'running' : 'pending',
        ...(kind === 'approval' && node.id === 'input' ? { output: 'payload' } : {}),
      })),
      events: [],
    }
    await runStore.enqueue(record)
    const mcpCall = vi.fn(async () => 'written')
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const connectorRequest = vi.fn(async () => {
      const response = await fetchImpl('https://connector.invalid/write')
      return { status: response.status, ok: response.ok, headers: {}, body: {} }
    })
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir), runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      mcpClient: { call: mcpCall },
      connectorService: { request: connectorRequest },
    })
    return { dir, service, record, mcpCall, fetchImpl, connectorRequest }
  }

  it('fails a queued historical run closed when its exact revision is missing without dispatching current writes', async () => {
    const { service, record, mcpCall, fetchImpl, connectorRequest } = await missingHistoricalRevisionFixture('queued')
    try {
      await service.initialize()
      const failed = await eventually(service, record.id)
      expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/Workflow|revision|版本|不存在/u) })
      expect(mcpCall).not.toHaveBeenCalled()
      expect(connectorRequest).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })

  it('rejects a revision index whose stored snapshot claims a different revision without dispatching its writes', async () => {
    const { dir, service, record, mcpCall, fetchImpl, connectorRequest } = await missingHistoricalRevisionFixture('queued')
    const current = (JSON.parse(await readFile(join(dir, 'workflows.json'), 'utf8')) as WorkflowDefinition[])[0]!
    await writeFile(join(dir, 'workflow-versions.json'), `${JSON.stringify({
      [record.workflowId]: { [String(record.workflowRevision)]: current },
    }, null, 2)}\n`)
    try {
      await service.initialize()
      const failed = await eventually(service, record.id)
      expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/Workflow|revision|版本|不存在/u) })
      expect(mcpCall).not.toHaveBeenCalled()
      expect(connectorRequest).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })

  it('rejects approval against a missing historical revision without mutating the waiting record', async () => {
    const { service, record, mcpCall, fetchImpl, connectorRequest } = await missingHistoricalRevisionFixture('approval')
    try {
      await service.initialize()
      const before = service.get(record.id)
      await expect(service.approve(record.id, true)).rejects.toThrow(/Workflow|revision|版本|不存在/u)
      expect(service.get(record.id)).toEqual(before)
      expect(mcpCall).not.toHaveBeenCalled()
      expect(connectorRequest).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })

  it('rejects resume against a missing historical revision without requeueing or mutating the record', async () => {
    const { service, record, mcpCall, fetchImpl, connectorRequest } = await missingHistoricalRevisionFixture('paused')
    try {
      await service.initialize()
      const before = service.get(record.id)
      await expect(service.resume(record.id)).rejects.toThrow(/Workflow|revision|版本|不存在/u)
      expect(service.get(record.id)).toEqual(before)
      expect(mcpCall).not.toHaveBeenCalled()
      expect(connectorRequest).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })

  it('backfills the current workflow revision for legacy stores without a versions snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-current-revision-backfill-'))
    const authoringStore = new WorkflowStore(dir)
    const workflow = await authoringStore.create({ id: 'current-backfill', name: 'Current', description: '', nodes: historicalNodes, edges })
    await writeFile(join(dir, 'workflow-versions.json'), '{}\n')
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir), runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    try {
      const completed = await eventually(service, (await service.start(workflow.id, 'payload')).id)
      expect(completed).toMatchObject({ status: 'completed', output: 'payload', workflowRevision: workflow.revision })
    } finally { await service.stop() }
  })

  it.each([
    ['environment-only', { environmentId: 'customer-a' }],
    ['trace-only', { traceId: 'trace-a' }],
    ['conflicting-environment', { releaseId: 'release-a', environmentId: 'customer-b', traceId: 'trace-a' }],
  ] as const)('fails a %s released-shaped run closed before MCP or managed fetch dispatch', async (_case, identity) => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-released-identity-boundary-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: `released-identity-${_case}`, name: 'Released identity boundary', description: '',
      nodes: currentWriteNodes, edges,
    })
    const runStore = new WorkflowRunStore(dir)
    const record: WorkflowRunRecord = {
      id: `run-released-identity-${_case}`, workflowId: workflow.id, workflowRevision: workflow.revision,
      ...identity,
      status: 'queued', queue: { enqueuedAt: new Date().toISOString(), availableAt: new Date().toISOString() },
      input: 'payload', allowShellFile: false, connectorGrants: [{ connectorId: 'crm', operations: ['write'] }],
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' })), events: [],
    }
    await runStore.enqueue(record)
    const mcpCall = vi.fn(async () => 'written')
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const connectorRequest = vi.fn(async () => {
      const response = await fetchImpl('https://connector.invalid/write')
      return { status: response.status, ok: response.ok, headers: {}, body: {} }
    })
    const release = {
      id: 'release-a', environmentId: 'customer-a', workflowId: workflow.id, workflowRevision: workflow.revision,
      contentSha256: computeWorkflowDefinitionSha256(workflow), workflowSnapshot: workflow,
      status: 'published' as const, connectorGrants: [], createdAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
    }
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      mcpClient: { call: mcpCall }, connectorService: { request: connectorRequest },
      resolveReleasedWorkflow: (releaseId) => releaseId === release.id ? release : undefined,
    })
    try {
      await service.initialize()
      const failed = await eventually(service, record.id)
      expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/Workflow|revision|release|发布|身份|不可用/u) })
      expect(mcpCall).not.toHaveBeenCalled()
      expect(connectorRequest).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })
})

async function createReleasedAccessFixture(node?: WorkflowNode, execution?: {
  nodes?: WorkflowNode[]
  edges?: WorkflowDefinition['edges']
  complete?: () => Promise<string>
  fetchImpl?: typeof fetch
  resolveHost?: (hostname: string) => Promise<Array<{ address: string }>>
}) {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-release-access-'))
  const workflowStore = new WorkflowStore(dir)
  const runStore = new WorkflowRunStore(dir)
  const environmentStore = new WorkflowEnvironmentStore(dir)
  const releaseStore = new WorkflowReleaseStore(dir)
  const environment: WorkflowCustomerEnvironment = {
    id: 'acme-staging', customerName: 'Acme', name: 'Staging', kind: 'staging', status: 'active',
    connectorIds: ['crm'], allowCode: true, allowShellFile: true,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
  }
  await environmentStore.upsert(environment)
  const middle: WorkflowNode = node ?? { id: 'approval', type: 'approval', label: 'Approve', config: { message: 'Confirm' }, position: { x: 200, y: 0 } }
  const middleNodes = execution?.nodes ?? [middle]
  const workflow = await workflowStore.create({
    name: 'Released access', description: '',
    permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['read', 'write'] }] },
    nodes: [graph().nodes[0]!, ...middleNodes, graph().nodes[4]!],
    edges: execution?.edges ?? [
      { id: 'access-input', source: 'input', target: middleNodes[0]!.id },
      ...middleNodes.slice(1).map((current, index) => ({ id: `access-${index}`, source: middleNodes[index]!.id, target: current.id })),
      { id: 'access-output', source: middleNodes.at(-1)!.id, target: 'output' },
    ],
  })
  const release = await releaseStore.publish({
    id: 'release-access', environmentId: environment.id, workflowId: workflow.id, workflowRevision: workflow.revision,
    workflowSnapshot: workflow, contentSha256: computeWorkflowDefinitionSha256(workflow),
    status: 'published', connectorGrants: [{ connectorId: 'crm', operations: ['read', 'write'] }],
    createdAt: environment.createdAt, publishedAt: environment.createdAt,
  })
  const connectors = new WorkflowConnectorStore(dir)
  await connectors.upsert({ id: 'crm', name: 'CRM', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
  const fetchImpl = vi.fn<typeof fetch>(execution?.fetchImpl ?? (async () => new Response('{"ok":true}', { status: 200 })))
  const executeSubWorkflow = vi.fn<NonNullable<WorkflowRunServiceOptions['executeSubWorkflow']>>(async () => 'undone')
  const createService = () => new WorkflowRunService({
    workflowStore, runStore, workflowRoot: dir,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
    resolveEmployee: () => undefined,
    resolveReleasedWorkflow: (id) => releaseStore.get(id),
    resolveWorkflowEnvironment: (id) => environmentStore.get(id),
    ...(execution?.complete === undefined ? {} : { lightweightClient: { complete: execution.complete } }),
    connectorService: new WorkflowConnectorService({
      connectors, credentials: new WorkflowCredentialStore(dir),
      resolveHost: execution?.resolveHost ?? (async () => [{ address: '93.184.216.34' }]), fetchImpl,
    }),
    executeSubWorkflow,
  })
  const service = createService()
  // Hold the real durable queue without mocking worker or persistence behavior.
  await service.initialize()
  await service.stop()
  return { dir, service, createService, runStore, environmentStore, environment, release, fetchImpl, executeSubWorkflow }
}

describe('released workflow access boundaries', () => {
  const blockingAiNode = (id: string): WorkflowNode => ({
    id, type: 'ai-task', label: id, position: { x: 200, y: 0 },
    config: { instruction: 'wait', mode: 'single', skillIds: [], outputMode: 'text' },
  })
  const managedHttpNode = (method: 'GET' | 'POST'): WorkflowNode => ({
    id: 'request', type: 'http', label: `${method} Request`, position: { x: 400, y: 0 },
    config: { method, connectorId: 'crm', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' },
  })

  it.each(['disabled', 'archived'] as const)('rejects a direct release start in a %s environment', async (status) => {
    const { service, environmentStore, environment, release } = await createReleasedAccessFixture()
    await environmentStore.upsert({ ...environment, status })
    await expect(service.startReleased(release.id, null)).rejects.toThrow(/environment must be active/u)
    expect(service.list()).toEqual([])
  })

  it('narrows a direct release start against current environment capabilities', async () => {
    const { service, environmentStore, environment, release } = await createReleasedAccessFixture()
    await environmentStore.upsert({ ...environment, connectorIds: [], allowCode: false, allowShellFile: false })
    const run = await service.startReleased(release.id, null, { allowCode: true, allowShellFile: true })
    expect(run).toMatchObject({ connectorGrants: [], allowCode: false, allowShellFile: false })
  })

  it.each(['resume', 'approve', 'compensate'] as const)('blocks %s after an environment is disabled without changing the record', async (action) => {
    const { service, runStore, environmentStore, environment, release, executeSubWorkflow } = await createReleasedAccessFixture()
    const record = await service.startReleased(release.id, null)
    record.status = action === 'approve' ? 'waiting-approval' : 'paused'
    if (action === 'approve') record.waitingApprovalNodeId = 'approval'
    record.compensationStack = [{ sourceNodeId: 'input', action: { type: 'workflow', workflowId: 'undo' }, status: 'pending' }]
    await runStore.save(record)
    const before = service.get(record.id)
    await environmentStore.upsert({ ...environment, status: 'disabled' })
    const continuation = action === 'approve' ? service.approve(record.id, true) : service[action](record.id)
    await expect(continuation).rejects.toThrow(/environment must be active/u)
    expect(service.get(record.id)).toEqual(before)
    expect(executeSubWorkflow).not.toHaveBeenCalled()
  })

  it('still permits approval rejection when the environment is disabled', async () => {
    const { service, runStore, environmentStore, environment, release } = await createReleasedAccessFixture()
    const record = await service.startReleased(release.id, null)
    record.status = 'waiting-approval'
    record.waitingApprovalNodeId = 'approval'
    await runStore.save(record)
    await environmentStore.upsert({ ...environment, status: 'disabled' })
    expect(await service.approve(record.id, false)).toMatchObject({ status: 'failed', error: '审批被拒绝' })
  })

  it.each(['resume', 'approve', 'compensate'] as const)('narrows %s permissions and never restores removed grants or operations', async (action) => {
    const { service, runStore, environmentStore, environment, release, executeSubWorkflow } = await createReleasedAccessFixture()
    const record = await service.startReleased(release.id, null, {
      allowCode: true, allowShellFile: true, connectorGrants: [{ connectorId: 'crm', operations: ['read'] }],
    })
    record.status = action === 'approve' ? 'waiting-approval' : 'paused'
    if (action === 'approve') record.waitingApprovalNodeId = 'approval'
    record.compensationStack = [{ sourceNodeId: 'input', action: { type: 'workflow', workflowId: 'undo' }, status: 'pending' }]
    await runStore.save(record)
    await environmentStore.upsert({ ...environment, allowCode: false, allowShellFile: false })
    const narrowed = action === 'approve' ? await service.approve(record.id, true) : await service[action](record.id)
    expect(narrowed).toMatchObject({ allowCode: false, allowShellFile: false, connectorGrants: [{ connectorId: 'crm', operations: ['read'] }] })
    if (action === 'compensate') {
      expect(executeSubWorkflow).not.toHaveBeenCalled()
      expect(narrowed.compensationStack?.[0]).toMatchObject({ status: 'failed', effectState: 'unknown' })
    }
    narrowed.status = 'paused'
    await runStore.save(narrowed)
    await environmentStore.upsert({ ...environment, connectorIds: [] })
    const revoked = await service.resume(record.id)
    expect(revoked.connectorGrants).toEqual([])
    revoked.status = 'paused'
    await runStore.save(revoked)
    await environmentStore.upsert(environment)
    expect(await service.resume(record.id)).toMatchObject({ connectorGrants: [], allowCode: false, allowShellFile: false })
  })

  it.each(['disabled', 'connector'] as const)('rechecks %s revocation after queueing and before worker execution', async (revocation) => {
    const fixture = await createReleasedAccessFixture({
      id: 'request', type: 'http', label: 'Request', position: { x: 200, y: 0 },
      config: { method: 'GET', connectorId: 'crm', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' },
    })
    const { service, createService, environmentStore, environment, release, fetchImpl } = fixture
    const queued = await service.startReleased(release.id, null)
    await environmentStore.upsert({ ...environment, ...(revocation === 'disabled' ? { status: 'disabled' as const } : { connectorIds: [] }) })
    const workerService = createService()
    try {
      await workerService.initialize()
      const settled = await eventually(workerService, queued.id)
      expect(settled.status).toBe('failed')
      if (revocation === 'disabled') expect(settled.error).toMatch(/environment must be active/u)
      else expect(settled.connectorGrants).toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(settled.events.some((event) => event.type === 'node-effect-dispatched')).toBe(false)
    } finally {
      await workerService.stop()
    }
  })

  it('rechecks a disabled environment after a blocking AI node and before a managed read dispatch', async () => {
    let releaseAi!: () => void
    let aiStarted!: () => void
    const aiGate = new Promise<void>((resolve) => { releaseAi = resolve })
    const enteredAi = new Promise<void>((resolve) => { aiStarted = resolve })
    const fixture = await createReleasedAccessFixture(undefined, {
      nodes: [blockingAiNode('blocker'), managedHttpNode('GET')],
      complete: async () => { aiStarted(); await aiGate; return 'ready' },
    })
    const { createService, environmentStore, environment, release, fetchImpl } = fixture
    const service = createService()
    try {
      await service.initialize()
      const queued = await service.startReleased(release.id, null)
      await enteredAi
      await environmentStore.upsert({ ...environment, status: 'disabled' })
      releaseAi()

      const settled = await eventually(service, queued.id)
      expect(settled).toMatchObject({ status: 'failed', error: expect.stringMatching(/environment must be active/u) })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(settled.events.some((event) => event.nodeId === 'request' && (event.type === 'node-effect-prepared' || event.type === 'node-effect-dispatched'))).toBe(false)
    } finally {
      releaseAi?.()
      await service.stop()
    }
  })

  it.each(['GET', 'POST'] as const)('rechecks connector removal after a blocking AI node and before a managed %s dispatch', async (method) => {
    let releaseAi!: () => void
    let aiStarted!: () => void
    const aiGate = new Promise<void>((resolve) => { releaseAi = resolve })
    const enteredAi = new Promise<void>((resolve) => { aiStarted = resolve })
    const fixture = await createReleasedAccessFixture(undefined, {
      nodes: [blockingAiNode('blocker'), managedHttpNode(method)],
      complete: async () => { aiStarted(); await aiGate; return 'ready' },
    })
    const { createService, environmentStore, environment, release, fetchImpl } = fixture
    const service = createService()
    try {
      await service.initialize()
      const queued = await service.startReleased(release.id, null)
      await enteredAi
      await environmentStore.upsert({ ...environment, connectorIds: [] })
      releaseAi()

      const settled = await eventually(service, queued.id)
      expect(settled).toMatchObject({ status: 'failed', connectorGrants: [], error: expect.stringMatching(/未授(?:予|权)连接器/u) })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(settled.events.some((event) => event.nodeId === 'request' && (event.type === 'node-effect-prepared' || event.type === 'node-effect-dispatched'))).toBe(false)
    } finally {
      releaseAi?.()
      await service.stop()
    }
  })

  it.each([
    { method: 'GET' as const, revocation: 'environment' as const },
    { method: 'POST' as const, revocation: 'connector' as const },
  ])('rechecks $revocation revocation after preparing a managed $method request and before fetch', async ({ method, revocation }) => {
    let releaseResolution!: () => void
    let resolutionStarted!: () => void
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve })
    const enteredResolution = new Promise<void>((resolve) => { resolutionStarted = resolve })
    let resolutionCalls = 0
    const fixture = await createReleasedAccessFixture(managedHttpNode(method), {
      resolveHost: async () => {
        resolutionCalls += 1
        if (resolutionCalls === 1) {
          resolutionStarted()
          await resolutionGate
        }
        return [{ address: '93.184.216.34' }]
      },
    })
    const { createService, environmentStore, environment, release, fetchImpl } = fixture
    const service = createService()
    try {
      await service.initialize()
      const queued = await service.startReleased(release.id, null)
      await enteredResolution
      await environmentStore.upsert({
        ...environment,
        ...(revocation === 'environment' ? { status: 'disabled' as const } : { connectorIds: [] }),
      })
      releaseResolution()

      const settled = await eventually(service, queued.id)
      expect(settled.status).toBe('failed')
      expect(resolutionCalls).toBe(1)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(settled.events.some((event) => event.nodeId === 'request' && event.type === 'node-effect-prepared')).toBe(method === 'POST')
      expect(settled.events.some((event) => event.nodeId === 'request' && event.type === 'node-effect-dispatched')).toBe(false)
    } finally {
      releaseResolution?.()
      await service.stop()
    }
  })

  it('rechecks connector removal before a managed read inside a loop body', async () => {
    let releaseAi!: () => void
    let aiStarted!: () => void
    const aiGate = new Promise<void>((resolve) => { releaseAi = resolve })
    const enteredAi = new Promise<void>((resolve) => { aiStarted = resolve })
    const blocker: WorkflowNode = {
      ...blockingAiNode('blocker'),
      config: { instruction: 'return items', mode: 'single', skillIds: [], outputMode: 'json' },
    }
    const loop: WorkflowNode = { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 2 }, position: { x: 400, y: 0 } }
    const request = managedHttpNode('GET')
    const fixture = await createReleasedAccessFixture(undefined, {
      nodes: [blocker, loop, request],
      edges: [
        { id: 'input-blocker', source: 'input', target: 'blocker' },
        { id: 'blocker-loop', source: 'blocker', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'request', sourcePort: 'loop-body' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
      complete: async () => { aiStarted(); await aiGate; return '["item"]' },
    })
    const { createService, environmentStore, environment, release, fetchImpl } = fixture
    const service = createService()
    try {
      await service.initialize()
      const queued = await service.startReleased(release.id, null)
      await enteredAi
      await environmentStore.upsert({ ...environment, connectorIds: [] })
      releaseAi()

      const settled = await eventually(service, queued.id)
      expect(settled).toMatchObject({ status: 'failed', connectorGrants: [] })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(settled.nodeStates.find((state) => state.nodeId === 'loop')?.loopIterations?.[0]?.nodeStates[0]).toMatchObject({ nodeId: 'request', status: 'failed' })
    } finally {
      releaseAi?.()
      await service.stop()
    }
  })

  it('never restores a connector grant removed earlier in the same released run', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let firstStarted!: () => void
    let secondStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const enteredFirst = new Promise<void>((resolve) => { firstStarted = resolve })
    const enteredSecond = new Promise<void>((resolve) => { secondStarted = resolve })
    let calls = 0
    const fixture = await createReleasedAccessFixture(undefined, {
      nodes: [blockingAiNode('first'), blockingAiNode('second'), managedHttpNode('GET')],
      complete: async () => {
        calls += 1
        if (calls === 1) { firstStarted(); await firstGate }
        else { secondStarted(); await secondGate }
        return 'ready'
      },
    })
    const { createService, environmentStore, environment, release, fetchImpl } = fixture
    const service = createService()
    try {
      await service.initialize()
      const queued = await service.startReleased(release.id, null)
      await enteredFirst
      await environmentStore.upsert({ ...environment, connectorIds: [] })
      releaseFirst()
      await enteredSecond
      await environmentStore.upsert(environment)
      releaseSecond()

      const settled = await eventually(service, queued.id)
      expect(settled).toMatchObject({ status: 'failed', connectorGrants: [], error: expect.stringMatching(/未授(?:予|权)连接器/u) })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      releaseFirst?.()
      releaseSecond?.()
      await service.stop()
    }
  })

  it('rechecks connector removal before retrying the same managed read node', async () => {
    let releaseRequest!: () => void
    let requestStarted!: () => void
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve })
    const enteredRequest = new Promise<void>((resolve) => { requestStarted = resolve })
    const request = {
      ...managedHttpNode('GET'),
      retryPolicy: { mode: 'idempotent' as const, maxAttempts: 2, baseDelayMs: 0, jitterRatio: 0 },
    }
    const fixture = await createReleasedAccessFixture(request, {
      fetchImpl: async () => { requestStarted(); await requestGate; throw new Error('connection lost') },
    })
    const { createService, environmentStore, environment, release, fetchImpl } = fixture
    const service = createService()
    try {
      await service.initialize()
      const queued = await service.startReleased(release.id, null)
      await enteredRequest
      await environmentStore.upsert({ ...environment, connectorIds: [] })
      releaseRequest()

      const settled = await eventually(service, queued.id)
      expect(settled).toMatchObject({ status: 'failed', connectorGrants: [], error: expect.stringMatching(/未授(?:予|权)连接器/u) })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(settled.nodeStates.find((state) => state.nodeId === 'request')?.attempt).toBe(2)
    } finally {
      releaseRequest?.()
      await service.stop()
    }
  })
})

describe('workflow run service', () => {
  it('treats a numeric input string as equal to the same configured number', async () => {
    const { service, workflowId } = await createNodeService({
      node: { id: 'condition', type: 'condition', label: 'Condition', config: { operator: 'equals', value: 3 }, position: { x: 200, y: 0 } },
    })

    const result = await eventually(service, (await service.start(workflowId, '3')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe(true)
  })

  it('compares numeric input strings with a configured numeric string', async () => {
    const { service, workflowId } = await createNodeService({
      node: { id: 'condition', type: 'condition', label: 'Condition', config: { operator: 'greater-than', value: '3' }, position: { x: 200, y: 0 } },
    })

    const result = await eventually(service, (await service.start(workflowId, '4')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe(true)
  })

  it('executes every parallel instruction and preserves instruction order', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'parallel', type: 'parallel', label: 'Parallel', config: { instructions: ['分析第一项', '分析第二项'] }, position: { x: 200, y: 0 } },
      responses: ['第一项结果', '第二项结果'],
    })

    const result = await eventually(service, (await service.start(workflowId, '输入')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['第一项结果', '第二项结果'])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]?.[0]?.prompt).toContain('分析第一项')
    expect(complete.mock.calls[1]?.[0]?.prompt).toContain('分析第二项')
  })

  it('enforces an AI task output schema before completing', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: {
        id: 'ai-schema', type: 'ai-task', label: 'Structured AI',
        config: {
          instruction: '提取标题', mode: 'single', skillIds: [], outputMode: 'json',
          outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        }, position: { x: 200, y: 0 },
      },
      responses: ['{"wrong":true}', '{"title":"正确"}'],
    })

    const result = await eventually(service, (await service.start(workflowId, '输入')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '正确' })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('rejects additional properties when an AI output schema is strict', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'ai-strict-schema', type: 'ai-task', label: 'Strict AI', config: { instruction: '输出标题', mode: 'single', skillIds: [], outputMode: 'json', outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }, position: { x: 200, y: 0 } },
      responses: ['{"title":"对","extra":true}', '{"title":"修复"}'],
    })
    const result = await eventually(service, (await service.start(workflowId, '输入')).id)
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '修复' })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('runs a standalone structured extract node with schema retries', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'extract', type: 'structured-extract', label: 'Extract', config: { schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, maxRetries: 2 }, position: { x: 200, y: 0 } },
      responses: ['{"title":3}', '{"title":"标题"}'],
    })
    const result = await eventually(service, (await service.start(workflowId, '原文')).id)
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '标题' })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('runs a stored sub-workflow with inherited permissions and model selection', async () => {
    const { service, workflowId, workflowStore } = await createNodeService({
      node: { id: 'sub', type: 'sub-workflow', label: 'Sub workflow', config: { workflowId: 'child-workflow', waitForCompletion: true }, position: { x: 200, y: 0 } },
    })
    await workflowStore.create({
      id: 'child-workflow', name: 'Child', description: '',
      nodes: [graph().nodes[0]!, graph().nodes[4]!],
      edges: [{ id: 'direct', source: 'input', target: 'output' }],
    })
    const model = { providerId: 'provider', modelId: 'model' }
    try {
      const result = await eventually(service, (await service.start(workflowId, 'hello', { allowCode: true, allowShellFile: true, model })).id)
      expect(result.status).toBe('completed')
      expect(result.output).toBe('hello')
      expect(service.list('child-workflow')[0]).toMatchObject({ status: 'completed', input: 'hello', allowCode: true, allowShellFile: true, model })
    } finally { await service.stop() }
  })

  it('builds objects, filters lists, and merges inputs deterministically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-data-nodes-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-data-nodes', name: 'Data nodes', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'object', type: 'object-builder', label: 'Object', config: { fields: { title: '{{value}}', items: '{{value}}', nested: { ok: true } } }, position: { x: 200, y: 0 } },
        { id: 'list', type: 'list-operator', label: 'List', config: { operation: 'filter', path: 'ok', value: true }, position: { x: 400, y: 0 }, inputBindings: [{ id: 'items', name: 'items', sourceNodeId: 'object', sourcePath: 'items', required: true }] },
        { id: 'merge', type: 'merge', label: 'Merge', config: { operation: 'append' }, position: { x: 600, y: 0 }, inputBindings: [
          { id: 'left', name: 'left', sourceNodeId: 'object', required: true },
          { id: 'right', name: 'right', sourceNodeId: 'list', required: true },
        ] },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 800, y: 0 } },
      ],
      edges: [
        { id: 'a', source: 'input', target: 'object' },
        { id: 'b', source: 'object', target: 'list' },
        { id: 'c', source: 'list', target: 'merge' },
        { id: 'd', source: 'object', target: 'merge' },
        { id: 'e', source: 'merge', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, [{ ok: true }, { ok: false }])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual([
      { title: [{ ok: true }, { ok: false }], items: [{ ok: true }, { ok: false }], nested: { ok: true } },
      { ok: true },
    ])
  })

  it('supports list projection, grouping, and numeric aggregation', async () => {
    const { service, workflowId } = await createNodeService({
      node: { id: 'list-full', type: 'list-operator', label: 'List full', config: { operation: 'aggregate', aggregateMode: 'sum', aggregatePath: 'amount' }, position: { x: 200, y: 0 } },
    })
    const result = await eventually(service, (await service.start(workflowId, [{ amount: 2 }, { amount: 3 }])).id)
    expect(result.status).toBe('completed')
    expect(result.output).toBe(5)
  })

  it('supports directory listing and file metadata operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-file-'))
    await mkdir(join(dir, 'docs'))
    await writeFile(join(dir, 'docs', 'note.txt'), 'hello', 'utf8')
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-file-ops', name: 'File operations', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'file', type: 'file', label: 'File', config: { operation: 'list', path: 'docs', recursive: true }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'file' }, { id: 'b', source: 'file', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, null, { allowShellFile: true })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual([
      { path: 'docs', type: 'directory', size: 0 },
      { path: 'docs/note.txt', type: 'file', size: 5 },
    ])
  })

  it('uses the dedicated workflow root for file nodes instead of state storage', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-state-'))
    const workflowDir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-root-'))
    const workflowStore = new WorkflowStore(stateDir)
    const workflow = await workflowStore.create({
      id: 'workflow-file-root', name: 'File root', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'file', type: 'file', label: 'File', config: { operation: 'write', path: 'result.txt', content: 'from workflow root' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'file' }, { id: 'b', source: 'file', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(stateDir), workflowRoot: workflowDir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, null, { allowShellFile: true })).id)

    expect(result.status).toBe('completed')
    await expect(readFile(join(workflowDir, 'result.txt'), 'utf8')).resolves.toBe('from workflow root')
    await expect(readFile(join(stateDir, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for a sleep node duration and forwards its input unchanged', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'sleep', type: 'sleep', label: 'Sleep', config: { durationMs: 20 }, position: { x: 200, y: 0 } },
    })
    const startedAt = Date.now()

    const result = await eventually(service, (await service.start(workflowId, 'wake')).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('wake')
    expect(result.nodeStates.find((state) => state.nodeId === 'sleep')?.elapsedMs).toBeGreaterThanOrEqual(15)
    expect(complete).not.toHaveBeenCalled()
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15)
  })

  it('samples a new random sleep duration on every execution', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999999)
    try {
      const { service, workflowId } = await createNodeService({
        node: { id: 'sleep-random', type: 'sleep', label: 'Random sleep', config: { durationMs: 0, mode: 'random', minDurationMs: 0, maxDurationMs: 1 } as never, position: { x: 200, y: 0 } },
      })

      await eventually(service, (await service.start(workflowId, 'first')).id)
      await eventually(service, (await service.start(workflowId, 'second')).id)

      expect(random).toHaveBeenCalledTimes(2)
    } finally {
      random.mockRestore()
    }
  })

  it('loops over array items sequentially and respects the iteration cap', async () => {
    const { service, workflowId, complete } = await createNodeService({
      node: { id: 'loop', type: 'loop', label: 'Loop', config: { instruction: '处理当前项', maxIterations: 2 }, position: { x: 200, y: 0 } },
      responses: ['A 结果', 'B 结果'],
    })

    const result = await eventually(service, (await service.start(workflowId, ['A', 'B', 'C'])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['A 结果', 'B 结果'])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]?.[0]?.prompt).toContain('当前循环项："A"')
    expect(complete.mock.calls[1]?.[0]?.prompt).toContain('当前循环项："B"')
  })

  it('passes each loop item through the body node and forwards collected results to the next edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-loop-body-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-loop-body', name: 'Loop body', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10 }, position: { x: 240, y: 0 } },
        { id: 'body', type: 'transform', label: 'Body', config: { template: 'append', text: '!' }, position: { x: 240, y: 180 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 520, y: 0 } },
      ],
      edges: [
        { id: 'input-loop', source: 'input', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'body', sourcePort: 'loop-body' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, ['A', 'B'])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['A!', 'B!'])
  })

  it('binds each loop item to the body node so deterministic templates can use item fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-loop-body-binding-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-loop-body-binding', name: 'Loop body binding', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10 }, position: { x: 240, y: 0 } },
        {
          id: 'body', type: 'transform', label: 'Body', config: { template: 'text', text: '姓名：{{name}}' }, position: { x: 240, y: 180 },
          inputBindings: [{ id: 'item-name', name: 'name', sourceNodeId: 'loop', sourcePath: 'name', required: true }],
        },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 520, y: 0 } },
      ],
      edges: [
        { id: 'input-loop', source: 'input', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'body', sourcePort: 'loop-body' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, [{ name: '甲' }, { name: '乙' }])).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['姓名：甲', '姓名：乙'])
  })

  it('runs a linear loop body chain before collecting the terminal body result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-loop-chain-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-loop-chain', name: 'Loop chain', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 10 }, position: { x: 240, y: 0 } },
        { id: 'sleep', type: 'sleep', label: 'Sleep', config: { durationMs: 20 }, position: { x: 240, y: 180 } },
        { id: 'format', type: 'transform', label: 'String', config: { template: 'text', text: '当前是第{{value}}个' }, position: { x: 520, y: 180 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 760, y: 0 } },
      ],
      edges: [
        { id: 'input-loop', source: 'input', target: 'loop' },
        { id: 'loop-body', source: 'loop', target: 'sleep', sourcePort: 'loop-body' },
        { id: 'sleep-format', source: 'sleep', target: 'format' },
        { id: 'loop-output', source: 'loop', target: 'output', sourcePort: 'loop-next' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    let formatCompletedOnce = false
    let observedSecondIteration: WorkflowRunRecord | undefined
    const stopWatching = service.watch((record) => {
      const sleep = record.nodeStates.find((state) => state.nodeId === 'sleep')
      const format = record.nodeStates.find((state) => state.nodeId === 'format')
      if (format?.status === 'completed') formatCompletedOnce = true
      if (formatCompletedOnce && sleep?.status === 'running' && format?.status === 'pending') observedSecondIteration = record
    })
    const result = await eventually(service, (await service.start(workflow.id, [1, 2])).id)
    stopWatching()

    expect(result.status).toBe('completed')
    expect(result.output).toEqual(['当前是第1个', '当前是第2个'])
    expect(observedSecondIteration).toBeDefined()
  })

  it('uses custom text from the fixed end node as the final output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-custom-output-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-custom-output',
      name: 'Custom output',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { name: 'task' }, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: '结束', config: { contentMode: 'text', text: '流程处理完成' }, position: { x: 240, y: 0 } },
      ],
      edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { task: '输入内容' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('流程处理完成')
  })

  it('interpolates multiple end-node input variables into a custom output template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-output-template-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-output-template',
      name: 'Output template',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { fields: [{ name: 'title' }, { name: 'body' }] }, position: { x: 0, y: 0 } },
        {
          id: 'output',
          type: 'output',
          label: '结束',
          config: { contentMode: 'text', text: '标题：{{title}}\n内容：{{body}}' },
          position: { x: 240, y: 0 },
          inputBindings: [
            { id: 'title-input', name: 'title', sourceNodeId: 'input', sourcePath: 'title', required: true },
            { id: 'body-input', name: 'body', sourceNodeId: 'input', sourcePath: 'body', required: true },
          ],
        },
      ],
      edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { title: '标题', body: '正文' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('标题：标题\n内容：正文')
  })

  it('can reuse a prior node result string in the end-node template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-output-result-template-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-output-result-template',
      name: 'Output result template',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { name: 'task' }, position: { x: 0, y: 0 } },
        { id: 'process', type: 'ai-task', label: '智能处理', config: { instruction: '处理 {{task}}', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 240, y: 0 }, inputBindings: [{ id: 'task-input', name: 'task', sourceNodeId: 'input', required: true }] },
        { id: 'output', type: 'output', label: '结束', config: { contentMode: 'text', text: '再次处理：{{result}}' }, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result-input', name: 'result', sourceNodeId: 'process', required: true }] },
      ],
      edges: [{ id: 'input-process', source: 'input', target: 'process' }, { id: 'process-output', source: 'process', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => 'AI 环节结果' },
    })

    const result = await eventually(service, (await service.start(workflow.id, { task: '原始输入' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('再次处理：AI 环节结果')
  })

  it('forwards multiple explicitly bound variables from the end node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-output-forward-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-output-forward',
      name: 'Output forwarding',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: '开始', config: { fields: [{ name: 'title' }, { name: 'body' }] }, position: { x: 0, y: 0 } },
        {
          id: 'output',
          type: 'output',
          label: '结束',
          config: { contentMode: 'variable' },
          position: { x: 240, y: 0 },
          inputBindings: [
            { id: 'title-input', name: 'title', sourceNodeId: 'input', sourcePath: 'title', required: true },
            { id: 'body-input', name: 'body', sourceNodeId: 'input', sourcePath: 'body', required: true },
          ],
        },
      ],
      edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { title: '标题', body: '正文' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ title: '标题', body: '正文' })
  })

  it('executes an employee node with the resolved professional profile', async () => {
    const { service, workflowId, sendPrompt, archiveSession } = await createNodeService({
      node: {
        id: 'employee',
        type: 'employee',
        label: '审核员',
        config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'json' },
        position: { x: 200, y: 0 },
      },
      responses: ['{"decision":"approve","issues":[]}'],
      resolveEmployee: () => reviewer(),
    })

    const result = await eventually(service, (await service.start(workflowId, { script: '内容' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ decision: 'approve', issues: [] })
    expect(result.nodeStates.find((state) => state.nodeId === 'employee')?.input).toEqual({ script: '内容' })
    expect(sendPrompt).toHaveBeenCalledWith('session-node', expect.stringContaining('只审核内容'))
    expect(sendPrompt).toHaveBeenCalledWith('session-node', expect.stringContaining('事实有依据'))
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledWith('session-node'))
  })

  it('applies the selected workflow model to Runtime-backed employee sessions', async () => {
    const { service, workflowId, selectSessionModel } = await createNodeService({
      node: {
        id: 'employee',
        type: 'employee',
        label: '审核员',
        config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'text' },
        position: { x: 200, y: 0 },
      },
      resolveEmployee: () => reviewer(),
    })

    const selection = { providerId: 'openai-codex', modelId: 'gpt-5.6-luna' }
    const result = await eventually(service, (await service.start(workflowId, '内容', { model: selection })).id)

    expect(result.status).toBe('completed')
    expect(selectSessionModel).toHaveBeenCalledWith('session-node', {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
    })
  })

  it('reuses one isolated employee Session only within its workflow run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-employee-session-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-two-employees', name: 'Two employee steps', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'review-one', type: 'employee', label: '审核一', config: { employeeId: 'content-reviewer', instruction: '审核一次', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'review-two', type: 'employee', label: '审核二', config: { employeeId: 'content-reviewer', instruction: '再次审核', outputMode: 'text' }, position: { x: 400, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: 'a', source: 'input', target: 'review-one' }, { id: 'b', source: 'review-one', target: 'review-two' }, { id: 'c', source: 'review-two', target: 'output' },
      ],
    })
    const createSession = vi.fn(async () => ({ sessionId: 'employee-run-session' }))
    const sendPrompt = vi.fn(async () => ({ text: '完成' }))
    const archiveSession = vi.fn(async () => undefined)
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession, sendPrompt, archiveSession }),
      resolveEmployee: () => reviewer(),
      lightweightClient: { complete: async () => 'unused' },
      mcpClient: { call: async () => 'unused' },
    })

    const result = await eventually(service, (await service.start(workflow.id, '脚本')).id)

    expect(result.status).toBe('completed')
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(sendPrompt).toHaveBeenNthCalledWith(1, 'employee-run-session', expect.any(String))
    expect(sendPrompt).toHaveBeenNthCalledWith(2, 'employee-run-session', expect.any(String))
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1))
  })

  it('repairs invalid JSON output with the lightweight path and creates no DSH Session', async () => {
    const outputMode: WorkflowOutputMode = 'json'
    const { service, workflowId, sendPrompt, createSession, complete } = await createNodeService({
      node: {
        id: 'ai-task',
        type: 'ai-task',
        label: '结构化处理',
        config: { instruction: '整理条目', mode: 'single', skillIds: [], outputMode },
        position: { x: 200, y: 0 },
      },
      responses: ['not json', '{"items":[]}'],
    })

    const result = await eventually(service, (await service.start(workflowId, {})).id)

    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ items: [] })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(createSession).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('preserves invalid employee JSON responses and explains both parse failures', async () => {
    const { service, workflowId } = await createNodeService({
      node: {
        id: 'employee',
        type: 'employee',
        label: '主管综合研判',
        config: { employeeId: 'content-reviewer', instruction: '综合研判', outputMode: 'json' },
        position: { x: 200, y: 0 },
      },
      responses: ['{"summary": }', '{"summary": "缺少结束引号}'],
      resolveEmployee: () => reviewer(),
    })

    const result = await eventually(service, (await service.start(workflowId, {})).id)
    const state = result.nodeStates.find((candidate) => candidate.nodeId === 'employee')

    expect(result.status).toBe('failed')
    expect(result.error).toContain('首次返回解析失败')
    expect(state?.effectState).toBe('confirmed')
    expect(state?.output).toEqual({
      originalResponse: '{"summary": }',
      repairResponse: '{"summary": "缺少结束引号}',
    })
    expect(state?.error).toContain('首次返回解析失败')
    expect(state?.error).toContain('格式修复返回解析失败')
    expect(state?.error).toContain('已保留两次原始返回')
    expect(result.events.some((event) => event.nodeId === 'employee' && event.type === 'node-effect-confirmed')).toBe(true)
  })

  it('preserves invalid lightweight JSON responses without sending them downstream', async () => {
    const { service, workflowId } = await createNodeService({
      node: {
        id: 'ai-task',
        type: 'ai-task',
        label: '轻量综合研判',
        config: { instruction: '综合研判', mode: 'single', skillIds: [], outputMode: 'json' },
        position: { x: 200, y: 0 },
      },
      responses: ['不是 JSON', '仍然不是 JSON'],
    })

    const result = await eventually(service, (await service.start(workflowId, {})).id)
    const state = result.nodeStates.find((candidate) => candidate.nodeId === 'ai-task')

    expect(result.status).toBe('failed')
    expect(result.output).toBeUndefined()
    expect(state?.output).toEqual({
      originalResponse: '不是 JSON',
      repairResponse: '仍然不是 JSON',
    })
    expect(state?.error).toContain('首次返回解析失败')
    expect(state?.error).toContain('格式修复返回解析失败')
  })

  it('calls MCP with structured arguments and creates no DSH Session', async () => {
    const { service, workflowId, createSession, sendPrompt, mcpCall } = await createNodeService({
      node: {
        id: 'mcp', type: 'mcp', label: '日历',
        config: { tool: 'calendar::create_event', arguments: { title: '{{value}}', task: '{{input}}' } },
        position: { x: 200, y: 0 },
      },
    })

    const result = await eventually(service, (await service.start(workflowId, { topic: '发布' })).id)

    expect(result.status).toBe('completed')
    expect(mcpCall).toHaveBeenCalledWith('calendar::create_event', { title: { topic: '发布' }, task: { topic: '发布' } })
    expect(createSession).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('pauses a dispatched MCP error for reconciliation without completing the MCP or downstream node', async () => {
    const callImpl = vi.fn(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'permission denied' }],
    }))
    const mcpClient = new WorkflowMcpClient({
      loadServers: async () => [{ serverName: 'calendar', transport: 'streamable-http', url: 'https://mcp.example' }],
      callImpl,
    })
    const { service, workflowId } = await createNodeService({
      node: {
        id: 'mcp', type: 'mcp', label: '日历',
        config: { tool: 'calendar::create_event', arguments: { title: '{{value}}' } },
        position: { x: 200, y: 0 },
      },
      mcpClient,
    })

    const result = await eventually(service, (await service.start(workflowId, { topic: '发布' })).id)
    const mcpState = result.nodeStates.find((candidate) => candidate.nodeId === 'mcp')
    const outputState = result.nodeStates.find((candidate) => candidate.nodeId === 'output')

    expect(result.status).toBe('paused')
    expect(result.output).toBeUndefined()
    expect(mcpState).toMatchObject({ status: 'pending', effectState: 'unknown', error: expect.stringContaining('permission denied') })
    expect(mcpState?.completedAt).toEqual(expect.any(String))
    expect(result.events.some((event) => event.nodeId === 'mcp' && event.type === 'node-effect-confirmed')).toBe(false)
    expect(result.events.some((event) => event.nodeId === 'mcp' && event.type === 'node-completed')).toBe(false)
    expect(outputState).toMatchObject({ status: 'pending' })
    expect(result.events.some((event) => event.nodeId === 'output' && event.type === 'node-started')).toBe(false)
    expect(callImpl).toHaveBeenCalledTimes(1)
    await service.stop()
  })

  it('assigns longer retained history to failed and debug runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-retention-policy-'))
    const workflowStore = new WorkflowStore(dir)
    const completedWorkflow = await workflowStore.create({
      id: 'workflow-retention-completed', name: 'Completed', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'output' }],
    })
    const failedWorkflow = await workflowStore.create({
      id: 'workflow-retention-failed', name: 'Failed', description: '',
      nodes: [
        { id: 'failed-input', type: 'input', label: '开始', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee', type: 'employee', label: 'Missing', config: { employeeId: 'missing', instruction: 'do', outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'failed-output', type: 'output', label: '结束', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'failed-input-employee', source: 'failed-input', target: 'employee' },
        { id: 'failed-employee-output', source: 'employee', target: 'failed-output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => 'unused' },
      mcpClient: { call: async () => 'unused' },
    })
    const completed = await eventually(service, (await service.start(completedWorkflow.id, 'ok')).id)
    const debug = await eventually(service, (await service.start(completedWorkflow.id, 'ok', { debug: true })).id)
    const failed = await eventually(service, (await service.start(failedWorkflow.id, 'ok')).id)

    const retainedDays = (record: typeof completed): number => Math.round((new Date(record.retentionExpiresAt ?? '').getTime() - new Date(record.completedAt ?? '').getTime()) / (24 * 60 * 60 * 1_000))
    expect(retainedDays(completed)).toBe(14)
    expect(retainedDays(debug)).toBe(30)
    expect(retainedDays(failed)).toBe(30)
  })

  it('fails clearly when an employee is missing or disabled', async () => {
    const node: WorkflowNode = {
      id: 'employee',
      type: 'employee',
      label: '审核员',
      config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'text' },
      position: { x: 200, y: 0 },
    }
    const missing = await createNodeService({ node })
    const missingResult = await eventually(missing.service, (await missing.service.start(missing.workflowId, {})).id)
    expect(missingResult.status).toBe('failed')
    expect(missingResult.error).toContain('content-reviewer')

    const disabled = await createNodeService({ node, resolveEmployee: () => reviewer(false) })
    const disabledResult = await eventually(disabled.service, (await disabled.service.start(disabled.workflowId, {})).id)
    expect(disabledResult.status).toBe('failed')
    expect(disabledResult.error).toContain('content-reviewer')
  })

  it('includes existing employees in AI workflow generation context and returns an editable draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '生成工作流', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'employee-node', type: 'employee', label: '内容审核员', config: { employeeId: 'content-reviewer', instruction: '', outputMode: 'text' }, position: { x: 200, y: 0 } },
      ], edges: [],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => reviewer(),
      listEmployees: () => [reviewer()],
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '生成内容审核流程' })

    expect(generated.workflow.nodes.some((node) => node.type === 'employee' && node.config.employeeId === 'content-reviewer')).toBe(true)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('content-reviewer'),
    }))
    const generationPrompt = complete.mock.calls[0]?.[0]?.systemPrompt as string
    expect(generationPrompt).toContain('inputBindings')
    expect(generationPrompt).toContain('多输入默认是 AND')
    expect(generationPrompt).toContain('员工是可复用的专业岗位')
  })

  it('loads workflow documentation at generation time without truncating the generation context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-docs-'))
    const complete = vi.fn(async () => JSON.stringify({
      name: '文档读取测试', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 200, y: 0 } },
      ], edges: [{ id: 'input-output', source: 'input', target: 'output' }],
    }))
    let loads = 0
    const documentation = `${'规则 '.repeat(30_005)}文档尾部仍然必须被读取`
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      loadWorkflowAiDocumentation: async () => {
        loads += 1
        return documentation
      },
      lightweightClient: { complete },
    })

    expect(loads).toBe(0)
    await service.generate({ prompt: '生成一个简单工作流' })

    expect(loads).toBe(1)
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('文档尾部仍然必须被读取')
  })

  it('prefilters a large employee catalog and sends full profiles only for selected employees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-employee-selection-'))
    const employees = Array.from({ length: 13 }, (_, index) => ({ ...reviewer(), id: `employee-${index}`, name: `员工${index}` }))
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ employeeIds: ['employee-7'], reason: '匹配研究职责', missingRoles: [] }))
      .mockResolvedValueOnce(JSON.stringify({
        name: '员工筛选工作流', description: '', nodes: [
          { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
          { id: 'employee-node', type: 'employee', label: '员工7', config: { employeeId: 'employee-7', instruction: '完成研究', outputMode: 'text' }, position: { x: 200, y: 0 } },
          { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 400, y: 0 } },
        ], edges: [
          { id: 'input-employee', source: 'input', target: 'employee-node' },
          { id: 'employee-output', source: 'employee-node', target: 'output' },
        ],
      }))
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: (id) => employees.find((employee) => employee.id === id),
      listEmployees: () => employees,
      lightweightClient: { complete },
    })

    await service.generate({ prompt: '生成一个研究工作流' })

    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('employee-0')
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('employee-12')
    expect(complete.mock.calls[1]?.[0]?.systemPrompt).toContain('employee-7')
    expect(complete.mock.calls[1]?.[0]?.systemPrompt).toContain('检查事实')
    expect(complete.mock.calls[1]?.[0]?.systemPrompt).not.toContain('员工0')
  })

  it('modifies an existing workflow with a dedicated prompt and reports deleted nodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-modify-'))
    const current = { ...graph(), generationPrompt: '生成一个条件分支工作流' }
    const modified = {
      ...current,
      nodes: current.nodes.filter((node) => node.id !== 'no'),
      edges: current.edges.filter((edge) => edge.source !== 'no' && edge.target !== 'no'),
    }
    const complete = vi.fn(async () => JSON.stringify(modified))
    const service = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      workflowAiDocumentation: '# Workflow rules\n\nKeep the graph acyclic.',
      lightweightClient: { complete },
    })

    const result = await service.modify({ workflow: current, prompt: '删除拒绝分支，保留通过分支。', model: { providerId: 'provider-a', modelId: 'model-a' } })

    expect(result.workflow.nodes.some((node) => node.id === 'no')).toBe(false)
    expect(result.workflow.generationPrompt).toBe('生成一个条件分支工作流')
    expect(result.removedNodes).toEqual([{ id: 'no', label: 'No' }])
    expect(result.changes.some((change) => change.type === 'removed' && change.targetId === 'no')).toBe(true)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: { providerId: 'provider-a', modelId: 'model-a' }, systemPrompt: expect.stringContaining('Workflow rules') }))
    expect(complete.mock.calls[0]?.[0]?.systemPrompt).toContain('删除节点是高风险修改')
  })

  it('accepts a runtime-generated workflow with multiple declared input variables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-runtime-shape-'))
    const workflowStore = new WorkflowStore(dir)
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ employees: [] }))
      .mockResolvedValueOnce(JSON.stringify({
        schemaVersion: 2,
        id: 'short-video-topic-planning',
        name: '短视频选题策划工作流',
        description: '根据账号定位和目标受众生成短视频选题。',
        revision: 1,
        enabled: true,
        nodes: [
          { id: 'input-1', type: 'input', label: '启动输入', config: { fields: [{ name: 'account_position', required: true }, { name: 'target_audience', required: true }] }, position: { x: 80, y: 180 }, inputBindings: [], outputVariables: [{ name: 'account_position' }, { name: 'target_audience' }] },
          { id: 'planner-1', type: 'ai-task', label: '生成候选选题', config: { instruction: '根据 {{account_position}} 和 {{target_audience}} 生成选题。', mode: 'single', skillIds: [], outputMode: 'json' }, position: { x: 360, y: 180 }, inputBindings: [
            { id: 'bind-position', name: 'account_position', sourceNodeId: 'input-1', sourcePath: 'account_position', required: true },
            { id: 'bind-audience', name: 'target_audience', sourceNodeId: 'input-1', sourcePath: 'target_audience', required: true },
          ], outputVariables: [{ name: 'topics' }] },
          { id: 'output-1', type: 'output', label: '输出选题', config: { outputMode: 'json' }, position: { x: 640, y: 180 }, inputBindings: [{ id: 'bind-topics', name: 'topics', sourceNodeId: 'planner-1', sourcePath: 'topics', required: true }] },
        ],
        edges: [
          { id: 'edge-input-planner', source: 'input-1', target: 'planner-1' },
          { id: 'edge-planner-output', source: 'planner-1', target: 'output-1' },
        ],
      }))
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      createEmployee: async () => { throw new Error('should not create an employee') },
      lightweightClient: { complete },
    })

    await expect(service.generate({ prompt: '生成一个短视频选题的工作流。', name: '生成一个短视频选题的工作流。' })).resolves.toMatchObject({
      workflow: { nodes: expect.arrayContaining([expect.objectContaining({ id: 'planner-1', type: 'ai-task' })]) },
      createdEmployees: [],
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('plans and creates missing employees before generating the workflow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-employees-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const createEmployee = vi.fn(async (input: EmployeeCreateInput) => ({
      schemaVersion: 2,
      version: 1,
      id: `employee-${input.name}`,
      name: input.name,
      role: input.role,
      description: input.description,
      businessBoundary: input.businessBoundary,
      systemPrompt: input.systemPrompt,
      operatingGuidelines: input.operatingGuidelines,
      qualityStandards: input.qualityStandards,
      capabilities: input.capabilities,
      skillIds: input.skillIds,
      enabled: true,
      builtIn: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ employees: [{ name: '财务分析师', role: '分析师', systemPrompt: '分析财务数据并给出建议', capabilities: ['research'] }] }))
      .mockResolvedValueOnce(JSON.stringify({
        name: '分析工作流', description: '', nodes: [
          { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
          { id: 'employee-node', type: 'employee', label: '财务分析师', config: { employeeId: 'employee-财务分析师', instruction: '分析财报', outputMode: 'text' }, position: { x: 200, y: 0 } },
        ], edges: [],
      }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      createEmployee,
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '为上市公司生成财务分析工作流' })

    expect(createEmployee).toHaveBeenCalledTimes(1)
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ name: '财务分析师', role: '分析师' }))
    expect(generated.createdEmployees).toHaveLength(1)
    expect(generated.createdEmployees[0]?.id).toBe('employee-财务分析师')
    expect(generated.workflow.nodes.some((node) => node.type === 'employee' && node.config.employeeId === 'employee-财务分析师')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('keeps generating the workflow when employee creation is not wired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-no-create-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '简单工作流', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'ai-task', type: 'ai-task', label: '处理', config: { instruction: '总结输入', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 400, y: 0 } },
      ], edges: [],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '简单总结任务' })

    expect(generated.createdEmployees).toHaveLength(0)
    expect(generated.workflow.nodes.some((node) => node.type === 'ai-task')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('repairs an incomplete AI graph into a valid, connected, laid-out draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-repair-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '公司分析', description: '', nodes: [
        { id: 'identify-company', type: 'employee', label: '识别企业', config: { employeeId: '', instruction: '', outputMode: 'text' }, position: { x: 0, y: 0 } },
        { id: 'status-condition', type: 'condition', label: '是否上市', config: { operator: 'is-public' }, position: { x: 0, y: 0 } },
        { id: 'public-analysis', type: 'employee', label: '上市公司财务分析', config: { employeeId: 'made-up-analyst', instruction: '', outputMode: 'text' }, position: { x: 0, y: 0 } },
      ], edges: [],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '分析一家企业' })

    expect(validateWorkflow(generated.workflow)).toEqual({ valid: true, issues: [] })
    expect(generated.workflow.nodes[0]).toMatchObject({ type: 'input', label: '开始' })
    expect(generated.workflow.nodes.at(-1)).toMatchObject({ type: 'output', label: '结束', config: { contentMode: 'variable' } })
    expect(generated.workflow.nodes.filter((node) => node.type === 'employee')).toHaveLength(0)
    expect(generated.workflow.nodes.find((node) => node.id === 'status-condition')).toMatchObject({ config: { operator: 'truthy' } })
    expect(generated.workflow.edges).toHaveLength(generated.workflow.nodes.length - 1)
    expect(new Set(generated.workflow.nodes.map((node) => `${node.position.x},${node.position.y}`)).size).toBe(generated.workflow.nodes.length)
  })

  it('adds explicit true and false ports to AI-generated condition exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-condition-ports-'))
    const workflowStore = new WorkflowStore(dir)
    const complete = vi.fn(async () => JSON.stringify({
      name: '企业分析', description: '', nodes: [
        { id: 'input', type: 'input', label: '输入', config: {}, position: { x: 0, y: 0 } },
        { id: 'listed', type: 'condition', label: '是否上市', config: { operator: 'truthy' }, position: { x: 200, y: 0 } },
        { id: 'public', type: 'ai-task', label: '上市分析', config: { instruction: '分析上市公司', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: -80 } },
        { id: 'private', type: 'ai-task', label: '未上市分析', config: { instruction: '分析未上市公司', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: 80 } },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: 'input-listed', source: 'input', target: 'listed' },
        { id: 'listed-public', source: 'listed', target: 'public' },
        { id: 'listed-private', source: 'listed', target: 'private' },
        { id: 'public-output', source: 'public', target: 'output' },
        { id: 'private-output', source: 'private', target: 'output' },
      ],
    }))
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const generated = await service.generate({ prompt: '为企业生成分析流程' })

    expect(generated.workflow.edges.filter((edge) => edge.source === 'listed').map((edge) => edge.sourcePort)).toEqual(['true', 'false'])
  })

  it('executes a condition branch and checkpoints each node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-run-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create(graph())
    const runStore = new WorkflowRunStore(dir)
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    await service.initialize()
    const initial = await service.start(workflow.id, 'yes')
    const result = await eventually(service, initial.id)
    expect(result.status).toBe('completed')
    expect(result.output).toBe('accepted: true')
    expect(result.nodeStates.find((state) => state.nodeId === 'no')?.status).toBe('skipped')
    expect(result.nodeStates.every((state) => typeof state.elapsedMs === 'number')).toBe(true)
    expect(result.events.some((event) => event.type === 'node-completed')).toBe(true)
  })

  it('executes only the matching switch branch and falls back to default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-switch-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-switch', name: 'Switch', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'route', type: 'switch', label: 'Route', config: { cases: [{ id: 'urgent', label: 'Urgent', value: 'urgent' }, { id: 'normal', label: 'Normal', value: 'normal' }] }, position: { x: 220, y: 0 } },
        { id: 'urgent', type: 'transform', label: 'Urgent', config: { template: 'prepend', text: 'urgent: ' }, position: { x: 440, y: -100 } },
        { id: 'normal', type: 'transform', label: 'Normal', config: { template: 'prepend', text: 'normal: ' }, position: { x: 440, y: 0 } },
        { id: 'fallback', type: 'transform', label: 'Fallback', config: { template: 'prepend', text: 'fallback: ' }, position: { x: 440, y: 100 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 680, y: 0 } },
      ],
      edges: [
        { id: 'input-route', source: 'input', target: 'route' },
        { id: 'route-urgent', source: 'route', target: 'urgent', sourcePort: 'switch:urgent' },
        { id: 'route-normal', source: 'route', target: 'normal', sourcePort: 'switch:normal' },
        { id: 'route-default', source: 'route', target: 'fallback', sourcePort: 'default' },
        { id: 'urgent-output', source: 'urgent', target: 'output' },
        { id: 'normal-output', source: 'normal', target: 'output' },
        { id: 'fallback-output', source: 'fallback', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const normal = await eventually(service, (await service.start(workflow.id, 'normal')).id)
    expect(normal.status).toBe('completed')
    expect(normal.output).toBe('normal: normal')
    expect(normal.nodeStates.find((state) => state.nodeId === 'urgent')?.status).toBe('skipped')
    expect(normal.nodeStates.find((state) => state.nodeId === 'fallback')?.status).toBe('skipped')

    const fallback = await eventually(service, (await service.start(workflow.id, 'other')).id)
    expect(fallback.status).toBe('completed')
    expect(fallback.output).toBe('fallback: other')
    expect(fallback.nodeStates.find((state) => state.nodeId === 'urgent')?.status).toBe('skipped')
    expect(fallback.nodeStates.find((state) => state.nodeId === 'normal')?.status).toBe('skipped')
  })

  it('deletes completed run history and rejects active run deletion', async () => {
    const { service, workflowId } = await createNodeService({ node: { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'identity' }, position: { x: 200, y: 0 } } })
    const completed = await eventually(service, (await service.start(workflowId, 'delete me')).id)
    // A terminal record is persisted before markLastRun/session cleanup. Drain
    // the Worker so this assertion targets completed history, not that window.
    await service.stop()
    expect(service.get(completed.id)?.status).toBe('completed')

    await service.remove(completed.id)
    expect(service.get(completed.id)).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-active-delete-'))
    const workflowStore = new WorkflowStore(dir)
    await workflowStore.create(graph())
    const runStore = new WorkflowRunStore(dir)
    const activeService = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
    await activeService.initialize()
    await runStore.save({ id: 'run-active', workflowId: 'workflow-branch', workflowRevision: 1, status: 'running', input: null, nodeStates: [], events: [], allowShellFile: false })

    await expect(activeService.remove('run-active')).rejects.toThrow('不能删除')
  })

  it('deletes a workflow only after confirming it has no active run records', async () => {
    const { service, workflowId } = await createNodeService({ node: { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'identity' }, position: { x: 200, y: 0 } } })
    const completed = await eventually(service, (await service.start(workflowId, 'delete with workflow')).id)
    await service.stop()
    expect(service.get(completed.id)?.status).toBe('completed')

    expect(await service.removeForWorkflow(workflowId)).toBe(1)
    expect(service.get(completed.id)).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-active-delete-workflow-'))
    const workflowStore = new WorkflowStore(dir)
    await workflowStore.create(graph())
    const runStore = new WorkflowRunStore(dir)
    const activeService = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
    await activeService.initialize()
    await runStore.save({ id: 'run-active-workflow', workflowId: 'workflow-branch', workflowRevision: 1, status: 'running', input: null, nodeStates: [], events: [], allowShellFile: false })

    await expect(activeService.removeForWorkflow('workflow-branch')).rejects.toThrow('运行中的记录')
    expect(runStore.get('run-active-workflow')).toBeDefined()
  })

  it('rejects workflow deletion after run completion is saved until markLastRun and active cleanup finish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-delete-completion-window-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({ ...graph(), id: 'delete-completion-window' })
    const runStore = new WorkflowRunStore(dir)
    const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    const originalMarkLastRun = workflowStore.markLastRun.bind(workflowStore)
    let allowMarkLastRun!: () => void
    const markLastRunGate = new Promise<void>((resolve) => { allowMarkLastRun = resolve })
    let markLastRunEntered!: () => void
    const markingLastRun = new Promise<void>((resolve) => { markLastRunEntered = resolve })
    let markLastRunFinished!: () => void
    const markedLastRun = new Promise<void>((resolve) => { markLastRunFinished = resolve })
    vi.spyOn(workflowStore, 'markLastRun').mockImplementation(async (workflowId, runId) => {
      markLastRunEntered()
      await markLastRunGate
      try { await originalMarkLastRun(workflowId, runId) } finally { markLastRunFinished() }
    })

    const started = await service.start(workflow.id, 'yes')
    try {
      await markingLastRun
      expect(runStore.get(started.id)?.status).toBe('completed')
      await expect(service.removeWorkflow(workflow.id)).rejects.toThrow(/仍在执行|运行中/u)
      expect(workflowStore.get(workflow.id)).toBeDefined()
      expect(runStore.get(started.id)).toBeDefined()

      allowMarkLastRun()
      await markedLastRun
      await service.stop()
      expect(runStore.get(started.id)?.status).toBe('completed')
      await service.removeWorkflow(workflow.id)
      expect(workflowStore.get(workflow.id)).toBeUndefined()
      expect(runStore.list(workflow.id)).toHaveLength(0)

      const reloadedWorkflowStore = new WorkflowStore(dir)
      const reloadedRunStore = new WorkflowRunStore(dir)
      await reloadedWorkflowStore.initialize()
      await reloadedRunStore.initialize()
      expect(reloadedWorkflowStore.get(workflow.id)).toBeUndefined()
      expect(reloadedRunStore.list(workflow.id)).toHaveLength(0)
    } finally {
      allowMarkLastRun()
      await markedLastRun.catch(() => undefined)
      await service.stop()
    }
  })

  it('serializes workflow definition deletion with a top-level start so no orphan run is enqueued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-delete-start-race-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({ ...graph(), id: 'delete-start-race' })
    const runStore = new WorkflowRunStore(dir)
    const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
    })
    await service.initialize()
    const originalRemove = workflowStore.remove.bind(workflowStore)
    let allowDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { allowDelete = resolve })
    let deletionEntered!: () => void
    const deleting = new Promise<void>((resolve) => { deletionEntered = resolve })
    vi.spyOn(workflowStore, 'remove').mockImplementation(async (workflowId) => {
      deletionEntered()
      await deleteGate
      return originalRemove(workflowId)
    })
    const deletion = service.removeWorkflow(workflow.id)
    try {
      await deleting
      const starting = service.start(workflow.id, 'must not enqueue')
      await Promise.resolve()
      expect(runStore.list(workflow.id)).toHaveLength(0)
      allowDelete()
      await deletion
      await expect(starting).rejects.toThrow(/not found|不存在|删除|清理/iu)
      expect(workflowStore.get(workflow.id)).toBeUndefined()
      expect(runStore.list(workflow.id)).toHaveLength(0)
    } finally { allowDelete(); await deletion.catch(() => undefined); await service.stop() }
  })

  it('serializes workflow deletion with a live child start and prevents child dispatch during deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-delete-child-race-'))
    const workflowStore = new WorkflowStore(dir)
    const child = await workflowStore.create({
      id: 'delete-child-race-target', name: 'Child', description: '',
      nodes: [graph().nodes[0]!, { id: 'write', type: 'mcp', label: 'Write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } }, graph().nodes[4]!],
      edges: [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }],
    })
    const parent = await workflowStore.create({
      id: 'delete-child-race-parent', name: 'Parent', description: '',
      nodes: [graph().nodes[0]!, { id: 'gate', type: 'ai-task', label: 'Gate', config: { instruction: 'gate', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } }, { id: 'child', type: 'sub-workflow', label: 'Child', config: { workflowId: child.id, waitForCompletion: false }, position: { x: 400, y: 0 } }, graph().nodes[4]!],
      edges: [{ id: 'a', source: 'input', target: 'gate' }, { id: 'b', source: 'gate', target: 'child' }, { id: 'c', source: 'child', target: 'output' }],
    })
    const runStore = new WorkflowRunStore(dir)
    let allowParent!: () => void
    const parentGate = new Promise<void>((resolve) => { allowParent = resolve })
    let parentEntered!: () => void
    const parentRunning = new Promise<void>((resolve) => { parentEntered = resolve })
    let childEffects = 0
    const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => { parentEntered(); await parentGate; return 'ready' } },
      mcpClient: { call: async () => { childEffects += 1; return 'written' } },
    })
    const parentRun = await service.start(parent.id, null)
    await parentRunning
    const originalRemove = workflowStore.remove.bind(workflowStore)
    let allowDelete!: () => void
    const deleteGate = new Promise<void>((resolve) => { allowDelete = resolve })
    let deletionEntered!: () => void
    const deleting = new Promise<void>((resolve) => { deletionEntered = resolve })
    vi.spyOn(workflowStore, 'remove').mockImplementation(async (workflowId) => {
      deletionEntered()
      await deleteGate
      return originalRemove(workflowId)
    })
    const deletion = service.removeWorkflow(child.id)
    try {
      await deleting
      allowParent()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(runStore.list(child.id)).toHaveLength(0)
      expect(childEffects).toBe(0)
      allowDelete()
      await deletion
      const stopped = await eventually(service, parentRun.id)
      expect(['failed', 'paused']).toContain(stopped.status)
      expect(runStore.list(child.id)).toHaveLength(0)
      expect(childEffects).toBe(0)
    } finally { allowParent(); allowDelete(); await deletion.catch(() => undefined); await service.stop() }
  })

  it('replaces text and interpolates bound variables in the transform node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-transform-replace-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-transform-replace', name: 'Transform replace', description: '',
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'text' }, { name: 'replacement' }] }, position: { x: 0, y: 0 } },
        {
          id: 'replace', type: 'transform', label: '替换', config: { template: 'replace', find: 'world', replacement: '{{replacement}}' } as never,
          position: { x: 240, y: 0 }, inputBindings: [
            { id: 'text-input', name: 'text', sourceNodeId: 'start', sourcePath: 'text', required: true },
            { id: 'replacement-input', name: 'replacement', sourceNodeId: 'start', sourcePath: 'replacement', required: true },
          ],
        },
        { id: 'output', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'replace', required: true }] },
      ],
      edges: [{ id: 'start-replace', source: 'start', target: 'replace' }, { id: 'replace-output', source: 'replace', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { text: 'hello world', replacement: 'there' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('hello there')
  })

  it('renders a new text from bound variables with the transform text template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-transform-text-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-transform-text', name: 'Transform text', description: '',
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'diagnosis' }, { name: 'patient' }] }, position: { x: 0, y: 0 } },
        {
          id: 'rewrite', type: 'transform', label: '重写诊断', config: { template: 'text', text: '患者：{{patient}}。新的诊断：{{diagnosis}}' } as never,
          position: { x: 240, y: 0 }, inputBindings: [
            { id: 'diagnosis-input', name: 'diagnosis', sourceNodeId: 'start', sourcePath: 'diagnosis', required: true },
            { id: 'patient-input', name: 'patient', sourceNodeId: 'start', sourcePath: 'patient', required: true },
          ],
        },
        { id: 'output', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'rewrite', required: true }] },
      ],
      edges: [{ id: 'start-rewrite', source: 'start', target: 'rewrite' }, { id: 'rewrite-output', source: 'rewrite', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { diagnosis: '原诊断', patient: '张三' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('患者：张三。新的诊断：原诊断')
  })

  it('merges multiple bound text values with a text-merge node template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-text-merge-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-text-merge', name: 'Text merge', description: '',
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'title' }, { name: 'body' }] }, position: { x: 0, y: 0 } },
        {
          id: 'merge', type: 'text-merge' as never, label: '文本合并', config: { template: '标题：{{title}}\\n正文：{{body}}' } as never,
          position: { x: 240, y: 0 }, inputBindings: [
            { id: 'title-input', name: 'title', sourceNodeId: 'start', sourcePath: 'title', required: true },
            { id: 'body-input', name: 'body', sourceNodeId: 'start', sourcePath: 'body', required: true },
          ],
        } as never,
        { id: 'output', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'merge', required: true }] },
      ],
      edges: [{ id: 'start-merge', source: 'start', target: 'merge' }, { id: 'merge-output', source: 'merge', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { title: '标题', body: '正文' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('标题：标题\\n正文：正文')
  })

  it('treats legacy condition exits without a port as one exclusive true/false pair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-legacy-condition-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(),
      id: 'workflow-legacy-condition',
      edges: graph().edges.map((edge) => edge.source === 'check' ? { ...edge, sourcePort: undefined } : edge),
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, 'yes')).id)

    expect(result.status).toBe('completed')
    expect(result.nodeStates.find((state) => state.nodeId === 'yes')?.status).toBe('completed')
    expect(result.nodeStates.find((state) => state.nodeId === 'no')?.status).toBe('skipped')
  })

  it('runs independent ready branches concurrently and waits for their join', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-concurrent-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-concurrent', name: 'Concurrent', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'research', type: 'ai-task', label: 'Research', config: { instruction: 'research', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 240, y: -80 } },
        { id: 'risk', type: 'ai-task', label: 'Risk', config: { instruction: 'risk', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 240, y: 80 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: 'input-research', source: 'input', target: 'research' },
        { id: 'input-risk', source: 'input', target: 'risk' },
        { id: 'research-output', source: 'research', target: 'output', targetPort: 'research' },
        { id: 'risk-output', source: 'risk', target: 'output', targetPort: 'risk' },
      ],
    })
    let activeCalls = 0
    let maxActiveCalls = 0
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: {
        complete: async ({ prompt }) => {
          activeCalls += 1
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
          await new Promise((resolve) => setTimeout(resolve, 25))
          activeCalls -= 1
          return prompt.includes('research') ? 'research-result' : 'risk-result'
        },
      },
    })

    const result = await eventually(service, (await service.start(workflow.id, 'brief')).id)

    expect(result.status).toBe('completed')
    expect(maxActiveCalls).toBe(2)
    expect(result.output).toEqual({ research: 'research-result', risk: 'risk-result' })
  })

  it('passes named values from structured start input into a multi-input join', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-multi-input-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-multi-input', name: 'Multi input', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [{ name: 'brief', label: '需求', required: true }, { name: 'research', label: '调研', required: true }] }, position: { x: 0, y: 0 } },
        { id: 'join', type: 'transform', label: '汇聚', config: { template: 'identity' }, position: { x: 240, y: 40 }, inputBindings: [
          { id: 'brief-input', name: 'brief', sourceNodeId: 'start', sourcePath: 'brief', required: true },
          { id: 'research-input', name: 'research', sourceNodeId: 'start', sourcePath: 'research', required: true },
        ] },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 480, y: 40 } },
      ],
      edges: [
        { id: 'start-join', source: 'start', target: 'join' },
        { id: 'join-output', source: 'join', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const result = await eventually(service, (await service.start(workflow.id, { brief: '内容需求', research: '调研结论' })).id)

    expect(result.status).toBe('completed')
    expect(result.nodeStates.find((state) => state.nodeId === 'join')?.input).toEqual({ brief: '内容需求', research: '调研结论' })
    expect(result.output).toEqual({ brief: '内容需求', research: '调研结论' })
  })

  it('binds named variables from selected node outputs and interpolates only those variables into a prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-variable-bindings-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      schemaVersion: 2, id: 'workflow-variable-bindings', name: 'Variable bindings', description: '', revision: 1, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'topic', type: 'input', label: '主题', config: { name: 'topic' }, position: { x: 0, y: 0 } },
        { id: 'research', type: 'ai-task', label: '调研', config: { instruction: '研究 {{topic}}', mode: 'single', skillIds: [], outputMode: 'json' }, position: { x: 220, y: -70 }, inputBindings: [{ id: 'topic-input', name: 'topic', sourceNodeId: 'topic', required: true }], outputVariables: [{ name: 'summary' }, { name: 'sources' }] },
        { id: 'outline', type: 'ai-task', label: '提纲', config: { instruction: '为 {{topic}} 制作提纲', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 220, y: 70 }, inputBindings: [{ id: 'topic-input', name: 'topic', sourceNodeId: 'topic', required: true }] },
        { id: 'writer', type: 'ai-task', label: '写作', config: { instruction: '主题：{{topic}}\n调研：{{research}}\n提纲：{{outline}}\n忽略：{{notSelected}}', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 480, y: 0 }, inputBindings: [
          { id: 'topic-input', name: 'topic', sourceNodeId: 'topic', required: true },
          { id: 'research-input', name: 'research', sourceNodeId: 'research', sourcePath: 'summary', required: true },
          { id: 'outline-input', name: 'outline', sourceNodeId: 'outline', required: true },
        ] },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 720, y: 0 }, inputBindings: [{ id: 'result-input', name: 'result', sourceNodeId: 'writer', required: true }] },
      ],
      edges: [
        { id: 'topic-research', source: 'topic', target: 'research' },
        { id: 'topic-outline', source: 'topic', target: 'outline' },
        { id: 'research-writer', source: 'research', target: 'writer' },
        { id: 'outline-writer', source: 'outline', target: 'writer' },
        { id: 'writer-output', source: 'writer', target: 'output' },
      ],
    } as unknown as WorkflowDefinition)
    const complete = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes('节点名称：调研')) return '{"summary":"可验证的调研结论","sources":["资料 A"]}'
      if (prompt.includes('节点名称：提纲')) return '三段式提纲'
      if (prompt.includes('节点名称：写作')) return '完整文稿'
      return ''
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const result = await eventually(service, (await service.start(workflow.id, { topic: '火箭发布' })).id)
    const writerPrompt = complete.mock.calls.map(([request]) => request.prompt as string).find((prompt) => prompt.includes('节点名称：写作'))

    expect(result.status).toBe('completed')
    expect(result.output).toBe('完整文稿')
    expect(result.nodeStates.find((state) => state.nodeId === 'writer')?.input).toEqual({ topic: '火箭发布', research: '可验证的调研结论', outline: '三段式提纲' })
    expect(writerPrompt).toContain('主题：火箭发布')
    expect(writerPrompt).toContain('调研：可验证的调研结论')
    expect(writerPrompt).toContain('提纲：三段式提纲')
    expect(writerPrompt).toContain('忽略：{{notSelected}}')
  })

  it('treats an explicit variable source as a dependency even without a visual edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-variable-dependency-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      id: 'workflow-variable-dependency', name: 'Variable dependency', description: '',
      nodes: [
        { id: 'input', type: 'input', label: '主题', config: { name: 'topic' }, position: { x: 0, y: 0 } },
        { id: 'writer', type: 'ai-task', label: '写作', config: { instruction: '围绕 {{topic}} 写作', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 300, y: 0 }, inputBindings: [{ id: 'topic', name: 'topic', sourceNodeId: 'input', required: true }] },
        { id: 'output', type: 'output', label: '输出', config: {}, position: { x: 600, y: 0 }, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'writer', required: true }] },
      ],
      // The edge controls only the final display path. `input → writer` comes from the binding above.
      edges: [{ id: 'writer-output', source: 'writer', target: 'output' }],
    })
    const complete = vi.fn(async ({ prompt }: { prompt: string }) => prompt.includes('节点名称：写作') ? '成文结果' : '')
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete },
    })

    const result = await eventually(service, (await service.start(workflow.id, { topic: '显式依赖' })).id)

    expect(result.status).toBe('completed')
    expect(result.output).toBe('成文结果')
    expect(result.nodeStates.find((state) => state.nodeId === 'writer')?.input).toEqual({ topic: '显式依赖' })
  })

  it('requires explicit authorization for Shell and File nodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-security-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(), id: 'workflow-shell', name: 'Shell',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'shell', type: 'shell', label: 'Shell', config: { command: 'echo', args: ['{{value}}'] }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'shell' }, { id: 'b', source: 'shell', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    const initial = await service.start(workflow.id, 'hello')
    const result = await eventually(service, initial.id)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('显式授权')
    const authorized = await service.start(workflow.id, 'hello', { allowShellFile: true })
    expect((await eventually(service, authorized.id)).status).toBe('completed')
  })

  it('pauses for approval and continues after approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-approval-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(), id: 'workflow-approval', name: 'Approval',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'approval', type: 'approval', label: 'Approve', config: { message: 'Confirm' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'approval' }, { id: 'b', source: 'approval', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })
    const initial = await service.start(workflow.id, 'hello')
    const waiting = await eventually(service, initial.id)
    expect(waiting.status).toBe('waiting-approval')
    expect(waiting.waitingApprovalNodeId).toBe('approval')
    const approved = await service.approve(initial.id, true)
    expect(approved.events.at(-1)?.type).toBe('approval-approved')
    expect((await eventually(service, initial.id)).status).toBe('completed')
  })

  it('records an approval rejection explicitly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-approval-rejection-'))
    const workflowStore = new WorkflowStore(dir)
    const workflow = await workflowStore.create({
      ...graph(), id: 'workflow-approval-rejection', name: 'Approval rejection',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'approval', type: 'approval', label: 'Approve', config: { message: 'Confirm' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'approval' }, { id: 'b', source: 'approval', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const waiting = await eventually(service, (await service.start(workflow.id, 'hello')).id)
    const rejected = await service.approve(waiting.id, false)

    expect(rejected.events.at(-1)?.type).toBe('approval-rejected')
  })

  it('serializes resume with cancellation so cancellation cannot succeed against a stale paused snapshot', async () => {
    const { workflow, runStore, service } = await stoppedApprovalFixture('resume-cancel-mutation')
    const runId = 'resume-cancel-run'
    await runStore.save({ id: runId, workflowId: workflow.id, workflowRevision: workflow.revision, status: 'paused', input: 'hello', allowShellFile: false, nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'pending' as const })), events: [] })
    const originalSave = runStore.save.bind(runStore)
    let allowResume!: () => void
    const resumeGate = new Promise<void>((resolve) => { allowResume = resolve })
    let resumeEntered!: () => void
    const savingResume = new Promise<void>((resolve) => { resumeEntered = resolve })
    vi.spyOn(runStore, 'save').mockImplementation(async (record) => {
      if (record.id === runId && record.events.at(-1)?.type === 'run-created') {
        resumeEntered()
        await resumeGate
      }
      return originalSave(record)
    })
    const originalCancellation = runStore.requestCancellation.bind(runStore)
    let cancellationPersistCalled = false
    vi.spyOn(runStore, 'requestCancellation').mockImplementation(async (...args) => {
      cancellationPersistCalled = true
      return originalCancellation(...args)
    })
    const resuming = service.resume(runId)
    try {
      await savingResume
      const cancelling = service.cancel(runId)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cancellationPersistCalled).toBe(false)
      allowResume()
      expect((await resuming).status).toBe('queued')
      expect((await cancelling).status).toBe('cancelled')
      expect(service.get(runId)?.status).toBe('cancelled')
    } finally { allowResume(); await resuming.catch(() => undefined) }
  })

  it('serializes approval with cancellation and applies cancellation to the newly queued state', async () => {
    const { workflow, runStore, service } = await stoppedApprovalFixture('approve-cancel-mutation')
    const runId = 'approve-cancel-run'
    await runStore.save({ id: runId, workflowId: workflow.id, workflowRevision: workflow.revision, status: 'waiting-approval', waitingApprovalNodeId: 'approval', input: 'hello', allowShellFile: false,
      nodeStates: [{ nodeId: 'input', status: 'completed', output: 'hello' }, { nodeId: 'approval', status: 'running' }, { nodeId: 'output', status: 'pending' }], events: [],
    })
    const originalSave = runStore.save.bind(runStore)
    let allowApproval!: () => void
    const approvalGate = new Promise<void>((resolve) => { allowApproval = resolve })
    let approvalEntered!: () => void
    const savingApproval = new Promise<void>((resolve) => { approvalEntered = resolve })
    vi.spyOn(runStore, 'save').mockImplementation(async (record) => {
      if (record.id === runId && record.events.at(-1)?.type === 'approval-approved') {
        approvalEntered()
        await approvalGate
      }
      return originalSave(record)
    })
    const originalCancellation = runStore.requestCancellation.bind(runStore)
    let cancellationPersistCalled = false
    vi.spyOn(runStore, 'requestCancellation').mockImplementation(async (...args) => {
      cancellationPersistCalled = true
      return originalCancellation(...args)
    })
    const approving = service.approve(runId, true)
    try {
      await savingApproval
      const cancelling = service.cancel(runId)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(cancellationPersistCalled).toBe(false)
      allowApproval()
      expect((await approving).events.at(-1)?.type).toBe('approval-approved')
      expect((await cancelling).status).toBe('cancelled')
      expect(service.get(runId)?.status).toBe('cancelled')
    } finally { allowApproval(); await approving.catch(() => undefined) }
  })

  it('allows exactly one conflicting approval decision and rejects the waiter against the latest state', async () => {
    const { workflow, runStore, service } = await stoppedApprovalFixture('conflicting-approval-mutation')
    const runId = 'conflicting-approval-run'
    await runStore.save({ id: runId, workflowId: workflow.id, workflowRevision: workflow.revision, status: 'waiting-approval', waitingApprovalNodeId: 'approval', input: 'hello', allowShellFile: false,
      nodeStates: [{ nodeId: 'input', status: 'completed', output: 'hello' }, { nodeId: 'approval', status: 'running' }, { nodeId: 'output', status: 'pending' }], events: [],
    })
    const originalSave = runStore.save.bind(runStore)
    let allowFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { allowFirst = resolve })
    let firstEntered!: () => void
    const savingFirst = new Promise<void>((resolve) => { firstEntered = resolve })
    vi.spyOn(runStore, 'save').mockImplementation(async (record) => {
      if (record.id === runId && record.events.at(-1)?.type === 'approval-approved') {
        firstEntered()
        await firstGate
      }
      return originalSave(record)
    })
    const first = service.approve(runId, true)
    try {
      await savingFirst
      const conflicting = service.approve(runId, false)
      let conflictingSettled = false
      void conflicting.then(() => { conflictingSettled = true }, () => { conflictingSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(conflictingSettled).toBe(false)
      allowFirst()
      await first
      await expect(conflicting).rejects.toThrow(/没有等待中的审批/u)
      expect(service.get(runId)?.events.filter((event) => event.type === 'approval-approved' || event.type === 'approval-rejected')).toHaveLength(1)
    } finally { allowFirst(); await first.catch(() => undefined) }
  })

  it('runs explicit compensation actions in reverse order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-'))
    const workflowStore = new WorkflowStore(dir)
    const undo = await workflowStore.create({
      id: 'workflow-undo', name: 'Undo', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 200, y: 0 } },
      ], edges: [{ id: 'undo-edge', source: 'input', target: 'output' }],
    })
    const main = await workflowStore.create({
      id: 'workflow-compensated', name: 'Compensated', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        {
          id: 'effect', type: 'mcp', label: 'Effect', config: { tool: 'publish', arguments: {} }, position: { x: 200, y: 0 },
          compensation: { type: 'workflow', workflowId: undo.id, input: { undoValue: '{{value}}' } },
        },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'main-a', source: 'input', target: 'effect' }, { id: 'main-b', source: 'effect', target: 'output' }],
    })
    const executeSubWorkflow = vi.fn(async () => 'undone')
    const service = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      mcpClient: { call: async () => 'published' },
      executeSubWorkflow,
    })

    const run = await service.start(main.id, 'order-42')
    const completed = await eventually(service, run.id)
    expect(completed.status).toBe('completed')
    const compensated = await service.compensate(run.id)

    expect(executeSubWorkflow).toHaveBeenCalledWith(undo.id, { undoValue: 'published' }, true, undefined, expect.any(Object))
    expect(compensated.compensationStack).toMatchObject([{ sourceNodeId: 'effect', status: 'completed' }])
  })

  it('journals compensation dispatch before the child call and uses a stable occurrence idempotency key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-journal-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const main = await workflowStore.create({
      id: 'workflow-compensation-journal', name: 'Compensation journal', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'effect', type: 'mcp', label: 'Effect', config: { tool: 'publish', arguments: {} }, compensation: { type: 'workflow', workflowId: 'undo' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'effect' }, { id: 'b', source: 'effect', target: 'output' }],
    })
    let runId = ''
    const executeSubWorkflow = vi.fn(async (_workflowId: string, _input: WorkflowValue, _wait: boolean, _version?: number | 'latest', options?: { idempotencyKey?: string }) => {
      expect(runStore.get(runId)?.compensationStack?.[0]).toMatchObject({ status: 'running', effectState: 'dispatched' })
      return 'undone'
    })
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined, mcpClient: { call: async () => 'published' }, executeSubWorkflow,
    })

    runId = (await service.start(main.id, 'order-42')).id
    expect((await eventually(service, runId)).status).toBe('completed')
    const compensated = await service.compensate(runId)

    const occurrenceId = `${runId}:compensation:effect:ordinary`
    expect(executeSubWorkflow.mock.calls[0]?.[4]).toMatchObject({ idempotencyKey: `${occurrenceId}:attempt:1`, effectIdempotencyKey: occurrenceId })
    expect(compensated.compensationStack?.[0]).toMatchObject({ status: 'completed', effectState: 'confirmed', occurrenceId })
    expect(compensated.events.map((event) => event.type)).toEqual(expect.arrayContaining(['compensation-effect-prepared', 'compensation-effect-dispatched', 'compensation-effect-confirmed']))
    await service.stop()
  })

  it('recovers a compensation whose remote success preceded the local checkpoint as unknown without replaying it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-crash-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const workflow = await workflowStore.create({ name: 'Compensation crash', description: '', nodes: [graph().nodes[0]!, graph().nodes[4]!], edges: [{ id: 'direct', source: 'input', target: 'output' }] })
    const run = await runStore.enqueue({
      id: 'run-compensation-crash', workflowId: workflow.id, workflowRevision: workflow.revision,
      status: 'completed', input: null, output: null, allowShellFile: false, nodeStates: [], events: [],
      compensationStack: [{
        sourceNodeId: 'write', action: { type: 'workflow', workflowId: 'undo' }, status: 'running',
        effectState: 'dispatched', occurrenceId: 'run-compensation-crash:compensation:write:ordinary',
      }],
    } as WorkflowRunRecord)
    const executeSubWorkflow = vi.fn(async () => 'must-not-repeat')
    const restarted = new WorkflowRunService({
      workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined, executeSubWorkflow,
    })

    await restarted.initialize()
    const recovered = restarted.get(run.id)
    expect(recovered?.compensationStack?.[0]).toMatchObject({ status: 'failed', effectState: 'unknown', error: expect.stringMatching(/人工核对/u) })
    await expect(restarted.compensate(run.id)).rejects.toThrow(/人工核对/u)
    expect(executeSubWorkflow).not.toHaveBeenCalled()
    await restarted.stop()
  })
})

describe('terminal workflow failure contract', () => {
  it('drives sticky health from a real released RunService node failure', async () => {
    const fixture = await createReleasedAccessFixture({
      id: 'fail', type: 'ai-task', label: 'Fail', config: { instruction: 'fail', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 },
    })
    const workerService = fixture.createService()
    const observationStore = new WorkflowObservationStore(fixture.dir)
    const observability = new WorkflowObservabilityService({ store: observationStore })
    let observed = Promise.resolve()
    const unwatch = workerService.watch((record) => { observed = observed.then(() => observability.observeRun(record)) })
    try {
      const failed = await eventually(workerService, (await workerService.startReleased(fixture.release.id, null)).id)
      for (let attempt = 0; attempt < 100 && !observationStore.list(fixture.environment.id).some((event) => event.action === 'run-failed'); attempt += 1) {
        await observed
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(failed.status).toBe('failed')
      expect(failed.events.filter((event) => event.type === 'run-failed')).toHaveLength(1)
      const later = new WorkflowObservabilityService({ store: observationStore, now: () => '2099-01-01T00:00:00.000Z', recentFailureWindowMs: 1 })
      expect(later.health(fixture.environment.id)).toMatchObject({ status: 'degraded', reason: 'latest-run-failed' })
    } finally { unwatch(); await workerService.stop() }
  })

  it('appends one terminal failure when dispatched reconciliation changes a paused run to failed', async () => {
    const fixture = await createReleasedAccessFixture(loopWriteNode)
    const observationStore = new WorkflowObservationStore(fixture.dir)
    const observability = new WorkflowObservabilityService({ store: observationStore })
    const queued = await fixture.service.startReleased(fixture.release.id, 'item')
    queued.status = 'paused'
    Object.assign(queued.nodeStates.find((state) => state.nodeId === 'body')!, { status: 'pending', effectState: 'unknown' })
    await fixture.runStore.save(queued)
    let observed = Promise.resolve()
    const unwatch = fixture.service.watch((record) => { observed = observed.then(() => observability.observeRun(record)) })
    try {
      const failed = await fixture.service.reconcileEffect(queued.id, { nodeId: 'body', outcome: 'dispatched', note: 'receipt found' })
      await observed
      expect(failed.events.filter((event) => event.type === 'run-failed')).toHaveLength(1)
      const later = new WorkflowObservabilityService({ store: observationStore, now: () => '2099-01-01T00:00:00.000Z', recentFailureWindowMs: 1 })
      expect(later.health(fixture.environment.id)).toMatchObject({ status: 'degraded', reason: 'latest-run-failed' })
    } finally { unwatch(); await fixture.service.stop() }
  })
})

describe('cancelled write reconciliation', () => {
  it('pauses an aborted dispatched write and permits explicit not-dispatched reconciliation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-cancel-write-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    let dispatched!: () => void
    const requestStarted = new Promise<void>((resolve) => { dispatched = resolve })
    const workflow = await workflowStore.create({
      name: 'Cancel write', description: '', permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['write'] }] },
      nodes: [graph().nodes[0]!, loopWriteNode, graph().nodes[4]!],
      edges: [{ id: 'a', source: 'input', target: 'body' }, { id: 'b', source: 'body', target: 'output' }],
    })
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService: { request: async (_request, _input, _previous, signal) => {
        dispatched()
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted write')), { once: true }))
      } },
    })
    try {
      const started = await service.start(workflow.id, 'item', { connectorGrants: [{ connectorId: 'crm', operations: ['write'] }] })
      await requestStarted
      await service.cancel(started.id)
      const paused = await eventually(service, started.id)
      expect(paused).toMatchObject({ status: 'paused' })
      expect(paused.events.at(-1)?.type).toBe('run-paused')
      expect(paused.nodeStates.find((state) => state.nodeId === 'body')).toMatchObject({ status: 'pending', effectState: 'unknown' })
      expect(await service.reconcileEffect(started.id, { nodeId: 'body', outcome: 'not-dispatched', note: 'connector confirms absent' })).toMatchObject({ status: 'queued' })
    } finally { await service.stop() }
  })
})

describe('compensation effect reconciliation', () => {
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-reconcile-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const workflow = await workflowStore.create({ name: 'Compensation review', description: '', nodes: [graph().nodes[0]!, graph().nodes[4]!], edges: [{ id: 'direct', source: 'input', target: 'output' }] })
    const run = await runStore.enqueue({
      id: 'run-compensation-review', workflowId: workflow.id, workflowRevision: workflow.revision,
      status: 'completed', input: null, output: null, allowShellFile: false, nodeStates: [], events: [],
      compensationStack: [{
        sourceNodeId: 'write', action: { type: 'workflow', workflowId: 'undo' }, status: 'failed', effectState: 'unknown',
        occurrenceId: 'run-compensation-review:compensation:write:ordinary', error: '人工核对',
      }],
    } as WorkflowRunRecord)
    const executeSubWorkflow = vi.fn(async () => 'undone')
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined, executeSubWorkflow,
    })
    const reconcile = (request: { occurrenceId: string; outcome: 'dispatched' | 'not-dispatched'; note: string }) => (
      (service as unknown as { reconcileCompensation(runId: string, request: typeof request): Promise<WorkflowRunRecord> }).reconcileCompensation(run.id, request)
    )
    return { service, run, runStore, executeSubWorkflow, reconcile }
  }

  it('atomically restores an exact unknown occurrence to pending and permits compensation to continue', async () => {
    const { service, run, reconcile, executeSubWorkflow } = await fixture()
    try {
      const reconciled = await reconcile({ occurrenceId: 'run-compensation-review:compensation:write:ordinary', outcome: 'not-dispatched', note: '  provider confirms absent  ' })
      expect(reconciled.compensationStack?.[0]).toMatchObject({
        status: 'pending', effectState: 'none',
        effectReconciliation: { outcome: 'not-dispatched', note: 'provider confirms absent', resolvedAt: expect.any(String) },
        effectReconciliationHistory: [{ outcome: 'not-dispatched', note: 'provider confirms absent', resolvedAt: expect.any(String) }],
      })
      expect(reconciled.events.at(-1)).toMatchObject({ type: 'compensation-effect-reconciled-not-dispatched', message: expect.not.stringContaining('provider confirms absent') })
      expect((await service.compensate(run.id)).compensationStack?.[0]).toMatchObject({ status: 'completed', effectState: 'confirmed' })
      expect(executeSubWorkflow).toHaveBeenCalledOnce()
    } finally { await service.stop() }
  })

  it('confirms an exact dispatched occurrence without inventing output and rejects bad or concurrent decisions', async () => {
    const { service, reconcile, executeSubWorkflow } = await fixture()
    try {
      await expect(reconcile({ occurrenceId: 'missing', outcome: 'dispatched', note: 'checked' })).rejects.toThrow()
      await expect(reconcile({ occurrenceId: 'run-compensation-review:compensation:write:ordinary', outcome: 'dispatched', note: ' ' })).rejects.toThrow()
      const [first, second] = await Promise.allSettled([
        reconcile({ occurrenceId: 'run-compensation-review:compensation:write:ordinary', outcome: 'dispatched', note: 'receipt found' }),
        reconcile({ occurrenceId: 'run-compensation-review:compensation:write:ordinary', outcome: 'not-dispatched', note: 'absent' }),
      ])
      expect([first, second].filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const record = service.get('run-compensation-review')!
      expect(record.compensationStack?.[0]).toMatchObject({ status: 'completed', effectState: 'confirmed', effectReconciliation: { outcome: 'dispatched', note: 'receipt found' } })
      expect(record.compensationStack?.[0]).not.toHaveProperty('output')
      expect(record.events.filter((event) => event.type.startsWith('compensation-effect-reconciled-'))).toHaveLength(1)
      expect(executeSubWorkflow).not.toHaveBeenCalled()
    } finally { await service.stop() }
  })

  it('creates a fresh real child attempt after not-dispatched while preserving the external occurrence key and terminal error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-real-retry-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const undo = await workflowStore.create({
      id: 'undo-real-retry', name: 'Undo', description: '', permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['write'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'refund', type: 'http', label: 'Refund', config: { method: 'POST', connectorId: 'crm', connectorPath: '/refund' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'refund' }, { id: 'b', source: 'refund', target: 'output' }],
    })
    const parent = await workflowStore.create({
      id: 'compensation-real-retry', name: 'Parent', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'charge', type: 'mcp', label: 'Charge', config: { tool: 'charge', arguments: {} }, compensation: { type: 'workflow', workflowId: undo.id }, position: { x: 200, y: 0 } },
        { id: 'fail', type: 'ai-task', label: 'Fail', config: { instruction: 'fail', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 400, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'charge' }, { id: 'b', source: 'charge', target: 'fail' }, { id: 'c', source: 'fail', target: 'output' }],
    })
    const externalKeys: string[] = []
    const service = new WorkflowRunService({
      workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      mcpClient: { call: async () => 'charged' },
      lightweightClient: { complete: async () => { throw new Error('original terminal failure') } },
      connectorService: { request: async (request) => {
        externalKeys.push(request.idempotencyKey ?? '')
        if (externalKeys.length === 1) throw new Error('provider outcome unknown')
        return { status: 200, ok: true, headers: {}, body: 'refunded' }
      } },
    })
    try {
      const failed = await eventually(service, (await service.start(parent.id, null)).id)
      expect(failed.status).toBe('failed')
      const originalError = failed.error
      const first = await service.compensate(failed.id)
      const occurrenceId = first.compensationStack?.[0]?.occurrenceId
      expect(first.compensationStack?.[0]).toMatchObject({ status: 'failed', effectState: 'unknown', attempt: 1, childRunId: expect.any(String) })
      expect(first.error).toBe(originalError)

      const reconciled = await service.reconcileCompensation(failed.id, { occurrenceId: occurrenceId!, outcome: 'not-dispatched', note: 'provider confirms absent' })
      expect(reconciled.error).toBe(originalError)
      const retried = await service.compensate(failed.id)
      expect(retried.compensationStack?.[0]).toMatchObject({ status: 'completed', effectState: 'confirmed', attempt: 2, childRunId: expect.any(String) })
      expect(runStore.list(undo.id)).toHaveLength(2)
      expect(new Set(runStore.list(undo.id).map((run) => run.id)).size).toBe(2)
      expect(externalKeys).toHaveLength(2)
      expect(externalKeys[1]).toBe(externalKeys[0])
      expect(externalKeys[0]).toContain(occurrenceId!)
      expect(retried.error).toBe(originalError)
      const reloadedStore = new WorkflowRunStore(dir)
      await reloadedStore.initialize()
      expect(reloadedStore.get(failed.id)?.compensationStack?.[0]).toMatchObject({ attempt: 2, childRunId: expect.any(String), childRunIds: [expect.any(String), expect.any(String)] })
    } finally { await service.stop() }
  })

  it('continues earlier real compensation entries after the latest occurrence is confirmed dispatched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-compensation-real-stack-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const undo = await workflowStore.create({
      id: 'undo-real-stack', name: 'Undo', description: '', permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['write'] }] },
      nodes: [{ id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } }, { id: 'undo', type: 'http', label: 'Undo', config: { method: 'POST', connectorId: 'crm', connectorPath: '/undo' }, position: { x: 200, y: 0 } }, { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } }],
      edges: [{ id: 'a', source: 'input', target: 'undo' }, { id: 'b', source: 'undo', target: 'output' }],
    })
    await runStore.enqueue({
      id: 'real-stack-parent', workflowId: 'source', workflowRevision: 1, status: 'failed', input: null, allowShellFile: false, nodeStates: [], events: [], error: 'source failed',
      compensationStack: ['first', 'second'].map((sourceNodeId) => ({ sourceNodeId, action: { type: 'workflow' as const, workflowId: undo.id }, status: 'pending' as const, effectState: 'none' as const })),
    })
    let calls = 0
    const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      connectorService: { request: async () => { calls += 1; if (calls === 1) throw new Error('unknown'); return { status: 200, ok: true, headers: {}, body: 'ok' } } },
    })
    try {
      const uncertain = await service.compensate('real-stack-parent')
      const latest = uncertain.compensationStack?.[1]
      expect(latest).toMatchObject({ status: 'failed', effectState: 'unknown' })
      await service.reconcileCompensation('real-stack-parent', { occurrenceId: latest!.occurrenceId!, outcome: 'dispatched', note: 'provider receipt found' })
      const completed = await service.compensate('real-stack-parent')
      expect(completed.compensationStack?.map((entry) => entry.status)).toEqual(['completed', 'completed'])
      expect(calls).toBe(2)
      expect(completed.error).toBe('source failed')
    } finally { await service.stop() }
  })

  it.each(['resume', 'remove', 'removeForWorkflow'] as const)('excludes %s while a real compensation child is executing', async (operation) => {
    const dir = await mkdtemp(join(tmpdir(), `ezdsh-workflow-compensation-exclusion-${operation}-`))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const child = await workflowStore.create({
      id: `blocking-undo-${operation}`, name: 'Blocking undo', description: '',
      nodes: [graph().nodes[0]!, { id: 'hold', type: 'ai-task', label: 'Hold', config: { instruction: 'hold', mode: 'single', skillIds: [], outputMode: 'text' }, position: { x: 200, y: 0 } }, graph().nodes[4]!],
      edges: [{ id: 'a', source: 'input', target: 'hold' }, { id: 'b', source: 'hold', target: 'output' }],
    })
    const source = await workflowStore.create({ id: `source-${operation}`, name: 'Source', description: '', nodes: [graph().nodes[0]!, graph().nodes[4]!], edges: [{ id: 'a', source: 'input', target: 'output' }] })
    await runStore.enqueue({
      id: `parent-${operation}`, workflowId: source.id, workflowRevision: source.revision, status: 'failed', input: null, allowShellFile: false, nodeStates: [], events: [], error: 'source failed',
      compensationStack: [{ sourceNodeId: 'write', action: { type: 'workflow', workflowId: child.id }, status: 'pending', effectState: 'none' }],
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const executing = new Promise<void>((resolve) => { entered = resolve })
    const service = new WorkflowRunService({ workflowStore, runStore, workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => { entered(); await gate; return 'undone' } },
    })
    const compensating = service.compensate(`parent-${operation}`)
    try {
      await executing
      const mutation = operation === 'resume'
        ? service.resume(`parent-${operation}`)
        : operation === 'remove'
          ? service.remove(`parent-${operation}`)
          : service.removeForWorkflow(source.id)
      await expect(mutation).rejects.toThrow(/执行|补偿|进行/u)
      release()
      await compensating
      expect(service.get(`parent-${operation}`)?.compensationStack?.[0]).toMatchObject({ status: 'completed', effectState: 'confirmed' })
    } finally { release(); await compensating.catch(() => undefined); await service.stop() }
  })

  it('excludes removal while a compensation reconciliation snapshot is being persisted', async () => {
    const { service, runStore } = await fixture()
    await service.initialize()
    const originalSave = runStore.save.bind(runStore)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const saving = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(runStore, 'save').mockImplementation(async (record) => {
      if (record.events.some((event) => event.type === 'compensation-effect-reconciled-not-dispatched')) {
        entered()
        await gate
      }
      return originalSave(record)
    })
    const reconciling = service.reconcileCompensation('run-compensation-review', { occurrenceId: 'run-compensation-review:compensation:write:ordinary', outcome: 'not-dispatched', note: 'checked' })
    try {
      await saving
      await expect(service.remove('run-compensation-review')).rejects.toThrow(/核对|进行/u)
      release()
      await reconciling
      expect(service.get('run-compensation-review')).toBeDefined()
    } finally { release(); await reconciling.catch(() => undefined); await service.stop() }
  })
})

describe('legacy reconciliation target backfill', () => {
  it.each(['ordinary-to-loop', 'loop-to-ordinary'] as const)('uses the immutable run revision for %s topology drift', async (direction) => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-target-backfill-'))
    const workflowStore = new WorkflowStore(dir)
    const runStore = new WorkflowRunStore(dir)
    const ordinaryNodes: WorkflowNode[] = [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'write', type: 'mcp', label: 'Historical write', config: { tool: 'write', arguments: {} }, position: { x: 200, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
    ]
    const loopNodes: WorkflowNode[] = [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'loop', type: 'loop', label: 'Historical loop', config: { maxIterations: 2 }, position: { x: 200, y: 0 } },
      { id: 'write', type: 'mcp', label: 'Historical write', config: { tool: 'write', arguments: {} }, position: { x: 400, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
    ]
    const initialNodes = direction === 'ordinary-to-loop' ? ordinaryNodes : loopNodes
    const initialEdges = direction === 'ordinary-to-loop'
      ? [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }]
      : [{ id: 'a', source: 'input', target: 'loop' }, { id: 'b', source: 'loop', sourcePort: 'loop-body' as const, target: 'write' }, { id: 'c', source: 'loop', target: 'output' }]
    const workflow = await workflowStore.create({ id: `legacy-${direction}`, name: direction, description: '', nodes: initialNodes, edges: initialEdges })
    const legacy: WorkflowRunRecord = {
      id: `run-${direction}`, workflowId: workflow.id, workflowRevision: workflow.revision, status: 'paused', input: 'payload', allowShellFile: false, events: [],
      nodeStates: direction === 'ordinary-to-loop'
        ? [{ nodeId: 'write', status: 'pending', effectState: 'unknown', input: 'ordinary-input' }]
        : [{ nodeId: 'loop', status: 'cancelled', loopIterations: [{ iterationId: 'iteration-0', iterationIndex: 0, input: 'loop-input', status: 'running', nodeStates: [{ nodeId: 'write', status: 'pending', effectState: 'unknown', input: 'loop-input' }] }] }],
    }
    await runStore.enqueue(legacy)
    await workflowStore.update(workflow.id, { ...workflow, nodes: direction === 'ordinary-to-loop' ? loopNodes : ordinaryNodes, edges: direction === 'ordinary-to-loop'
      ? [{ id: 'a', source: 'input', target: 'loop' }, { id: 'b', source: 'loop', sourcePort: 'loop-body', target: 'write' }, { id: 'c', source: 'loop', target: 'output' }]
      : [{ id: 'a', source: 'input', target: 'write' }, { id: 'b', source: 'write', target: 'output' }] })
    const service = new WorkflowRunService({ workflowStore, runStore: new WorkflowRunStore(dir), workflowRoot: dir, createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }), resolveEmployee: () => undefined })
    try {
      await service.initialize()
      const targets = service.get(legacy.id)?.effectReconciliationTargets
      expect(targets).toHaveLength(1)
      expect(targets?.[0]).toMatchObject(direction === 'ordinary-to-loop'
        ? { nodeId: 'write', nodeLabel: 'Historical write', input: 'ordinary-input' }
        : { nodeId: 'write', nodeLabel: 'Historical write', iterationId: 'iteration-0', loopNodeLabel: 'Historical loop', input: 'loop-input' })
    } finally { await service.stop() }
  })
})
