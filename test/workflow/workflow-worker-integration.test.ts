import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowConnectorService } from '../../src/main/workflow/workflow-connector-service.js'

afterEach(() => vi.unstubAllGlobals())

async function eventually<T>(read: () => T | undefined, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read()
    if (value !== undefined && predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true in time')
}

describe('workflow durable worker integration', () => {
  it('returns a queued record with durable queue metadata before the Worker completes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-transform',
      name: 'Worker transform',
      description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'prepend', text: 'done: ' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'input-transform', source: 'input', target: 'transform' },
        { id: 'transform-output', source: 'transform', target: 'output' },
      ],
    })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
    })

    const initial = await service.start(workflow.id, 'hello', { idempotencyKey: 'transform-42' })

    expect(initial.status).toBe('queued')
    expect(initial.queue).toMatchObject({ enqueuedAt: expect.any(String), availableAt: expect.any(String) })
    const completed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed')
    expect(completed.output).toBe('done: hello')
    expect(completed.queue?.lease).toBeUndefined()
    await service.stop()
  })

  it('executes a managed connector only when the saved policy grants it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-connector',
      name: 'Worker connector',
      description: '',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'http', type: 'http', label: 'Fetch', config: { method: 'GET', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'input-http', source: 'input', target: 'http' },
        { id: 'http-output', source: 'http', target: 'output' },
      ],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const initial = await service.start(workflow.id, { topic: 'hello' }, { connectorGrants: [{ connectorId: 'api', operations: ['read'] }] })
    const completed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed' || record.status === 'failed')
    expect(completed.status).toBe('completed')
    expect(completed.output).toEqual({ status: 200, ok: true, headers: { 'content-type': 'application/json' }, body: { ok: true } })
    await service.stop()
  })

  it('records a policy denial as a failed node without inventing an uncertain effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-connector-denied',
      name: 'Denied connector',
      description: '',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'http', type: 'http', label: 'Write', config: { method: 'POST', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'input-http', source: 'input', target: 'http' }, { id: 'http-output', source: 'http', target: 'output' }],
    })
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const initial = await service.start(workflow.id, null)
    const failed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed' || record.status === 'failed' || record.status === 'paused')
    expect(failed.status).toBe('failed')
    const httpState = failed.nodeStates.find((state) => state.nodeId === 'http')
    expect(httpState?.status).toBe('failed')
    expect(httpState?.effectState).toBeUndefined()
    await service.stop()
  })

  it('requires an explicit one-run grant for a managed connector even when policy allows it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-connector-grant', name: 'Grant required', description: '',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'http', type: 'http', label: 'Fetch', config: { method: 'GET', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'input-http', source: 'input', target: 'http' }, { id: 'http-output', source: 'http', target: 'output' }],
    })
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const initial = await service.start(workflow.id, null)
    const failed = await eventually(() => service.get(initial.id), (record) => record.status === 'failed' || record.status === 'paused')
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/本次运行未授予|未授予/u)
    await service.stop()
  })

  it('persists a deterministic retry as queued work instead of sleeping inside the Worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-worker-'))
    const workflowStore = new WorkflowStore(directory)
    const workflow = await workflowStore.create({
      id: 'workflow-worker-retry', name: 'Retry', description: '',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-task', label: 'AI', config: { instruction: 'answer', mode: 'single', skillIds: [], outputMode: 'text' }, retryPolicy: { maxAttempts: 2, baseDelayMs: 40, maxDelayMs: 40, jitterRatio: 0 }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'input-ai', source: 'input', target: 'ai' }, { id: 'ai-output', source: 'ai', target: 'output' }],
    })
    let attempts = 0
    const service = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: vi.fn(async () => { attempts += 1; if (attempts === 1) throw new Error('temporary provider failure'); return 'done' }) },
    })
    const initial = await service.start(workflow.id, null)
    const retryQueued = await eventually(() => service.get(initial.id), (record) => record.events.some((event) => event.type === 'node-retry'))
    expect(retryQueued.status).toBe('queued')
    expect(retryQueued.nodeStates.find((state) => state.nodeId === 'ai')).toMatchObject({ status: 'pending', attempt: 1, nextAttemptAt: expect.any(String) })
    const completed = await eventually(() => service.get(initial.id), (record) => record.status === 'completed' || record.status === 'failed')
    expect(completed.status).toBe('completed')
    expect(completed.output).toBe('done')
    expect(attempts).toBe(2)
    await service.stop()
  })
})
