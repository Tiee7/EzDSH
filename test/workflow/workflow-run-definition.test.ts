import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { computeWorkflowReleaseSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import type { EzDSHBridge } from '../../src/shared/contracts.js'
import type { WorkflowRelease } from '../../src/shared/workflow-operations.js'
import type { WorkflowDefinition, WorkflowRunRecord } from '../../src/shared/workflow.js'

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

const services: WorkflowRunService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  vi.clearAllMocks()
})

function definition(id: string, revision: number, label: string, middleId = `step-${String(revision)}`): WorkflowDefinition {
  const timestamp = '2026-09-12T00:00:00.000Z'
  return {
    schemaVersion: 2,
    id,
    name: label,
    description: '',
    revision,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: [
      { id: 'input', type: 'input', label: `${label} input`, config: {}, position: { x: 0, y: 0 } },
      { id: middleId, type: 'transform', label, config: { template: 'prepend', text: `${label}: ` }, position: { x: 200, y: 0 } },
      { id: 'output', type: 'output', label: `${label} output`, config: { contentMode: 'variable' }, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: `${middleId}-in`, source: 'input', target: middleId },
      { id: `${middleId}-out`, source: middleId, target: 'output' },
    ],
  }
}

function runRecord(workflow: Pick<WorkflowDefinition, 'id' | 'revision' | 'nodes'>, overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: `run-${workflow.id}-${String(workflow.revision)}`,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    origin: { kind: 'top-level' },
    status: 'completed',
    input: null,
    output: null,
    nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: 'completed', elapsedMs: 0 })),
    events: [],
    allowShellFile: false,
    allowCode: false,
    debug: false,
    ...overrides,
  }
}

function release(root: WorkflowDefinition, dependencies: WorkflowDefinition[] = []): WorkflowRelease {
  const timestamp = '2026-09-12T00:00:00.000Z'
  const snapshots = { workflowSnapshot: root, ...(dependencies.length === 0 ? {} : { workflowDependencies: dependencies }) }
  return {
    id: `release-${root.id}`,
    environmentId: 'customer-production',
    workflowId: root.id,
    workflowRevision: root.revision,
    contentSha256: computeWorkflowReleaseSha256(snapshots),
    workflowSnapshot: root,
    ...(dependencies.length === 0 ? {} : { workflowDependencies: dependencies }),
    status: 'published',
    connectorGrants: [],
    createdAt: timestamp,
    publishedAt: timestamp,
  }
}

function releaseIdentity(published: WorkflowRelease, traceId = 'trace-run-definition') {
  return {
    releaseId: published.id,
    environmentId: published.environmentId,
    traceId,
  }
}

function createService(
  directory: string,
  workflowStore: WorkflowStore,
  runStore: WorkflowRunStore,
  resolveReleasedWorkflow?: (releaseId: string) => WorkflowRelease | undefined,
): WorkflowRunService {
  const service = new WorkflowRunService({
    workflowStore,
    runStore,
    workflowRoot: directory,
    createClient: () => ({
      createSession: async () => ({ sessionId: 'unused' }),
      sendPrompt: async () => ({ text: 'unused' }),
    }),
    resolveEmployee: () => undefined,
    resolveReleasedWorkflow,
  })
  services.push(service)
  return service
}

async function createVersionedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-definition-'))
  const workflowStore = new WorkflowStore(directory)
  const v1Input = definition('workflow-history', 1, 'Version one', 'v1-step')
  const v1 = await workflowStore.create({
    id: v1Input.id,
    name: v1Input.name,
    description: v1Input.description,
    nodes: v1Input.nodes,
    edges: v1Input.edges,
  })
  const v2Input = definition(v1.id, 2, 'Version two', 'v2-step')
  const v2 = await workflowStore.update(v1.id, {
    revision: v1.revision,
    name: v2Input.name,
    description: v2Input.description,
    nodes: v2Input.nodes,
    edges: v2Input.edges,
  })
  const runStore = new WorkflowRunStore(directory)
  const run = await runStore.save(runRecord(v1))
  return { directory, workflowStore, runStore, run, v1, v2 }
}

describe('WorkflowRunService.getRunDefinition', () => {
  it('returns the exact ordinary revision instead of the current workflow', async () => {
    const fixture = await createVersionedFixture()
    const service = createService(fixture.directory, fixture.workflowStore, fixture.runStore)

    const result = await service.getRunDefinition(fixture.run.id)

    expect(result).toEqual(fixture.v1)
    expect(result?.nodes.map((node) => node.id)).toContain('v1-step')
    expect(result?.nodes.map((node) => node.id)).not.toContain('v2-step')
  })

  it('returns the ordinary revision when the current definition is absent', async () => {
    const fixture = await createVersionedFixture()
    await writeFile(join(fixture.directory, 'workflows.json'), '[]\n')
    const historicalStore = new WorkflowStore(fixture.directory)
    const service = createService(fixture.directory, historicalStore, fixture.runStore)

    await expect(service.getRunDefinition(fixture.run.id)).resolves.toEqual(fixture.v1)
    expect(historicalStore.get(fixture.v1.id)).toBeUndefined()
  })

  it('returns undefined when the exact ordinary revision is absent even if current exists', async () => {
    const fixture = await createVersionedFixture()
    await writeFile(join(fixture.directory, 'workflow-versions.json'), `${JSON.stringify({ [fixture.v2.id]: { [String(fixture.v2.revision)]: fixture.v2 } }, null, 2)}\n`)
    const incompleteStore = new WorkflowStore(fixture.directory)
    const service = createService(fixture.directory, incompleteStore, fixture.runStore)

    await expect(service.getRunDefinition(fixture.run.id)).resolves.toBeUndefined()
    expect(incompleteStore.get(fixture.v2.id)).toEqual(fixture.v2)
  })

  it('returns a release root snapshot after the source workflow is deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-release-definition-'))
    const snapshot = definition('workflow-released', 1, 'Released snapshot')
    const published = release(snapshot)
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, releaseIdentity(published)))
    const workflowStore = new WorkflowStore(directory)
    const service = createService(directory, workflowStore, runStore, () => published)

    await expect(service.getRunDefinition(run.id)).resolves.toEqual(snapshot)
    expect(workflowStore.get(snapshot.id)).toBeUndefined()
  })

  it('returns an exact dependency snapshot for a released child run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-release-dependency-'))
    const root = definition('workflow-root', 4, 'Released root')
    const dependency = definition('workflow-child', 7, 'Released child')
    const published = release(root, [dependency])
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(dependency, releaseIdentity(published)))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    await expect(service.getRunDefinition(run.id)).resolves.toEqual(dependency)
  })

  it('returns undefined for a missing release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-missing-release-'))
    const snapshot = definition('workflow-missing-release', 1, 'Missing release')
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, { releaseId: 'release-missing', environmentId: 'customer-production', traceId: 'trace-missing' }))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => undefined)

    await expect(service.getRunDefinition(run.id)).resolves.toBeUndefined()
  })

  it('returns undefined for a tampered release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-tampered-release-'))
    const snapshot = definition('workflow-tampered-release', 1, 'Original release')
    const published = release(snapshot)
    const tampered = { ...published, workflowSnapshot: { ...published.workflowSnapshot, name: 'Tampered release' } }
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, releaseIdentity(published)))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => tampered)

    await expect(service.getRunDefinition(run.id)).resolves.toBeUndefined()
  })

  it('returns undefined when a release has no exact workflow revision match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-release-mismatch-'))
    const snapshot = definition('workflow-release-mismatch', 1, 'Release v1')
    const published = release(snapshot)
    const mismatchedRun = runRecord({ ...snapshot, revision: 2 }, releaseIdentity(published))
    const runStore = new WorkflowRunStore(directory)
    await runStore.save(mismatchedRun)
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    await expect(service.getRunDefinition(mismatchedRun.id)).resolves.toBeUndefined()
  })

  it('returns undefined for an integrity-valid but invalid workflow definition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-invalid-definition-'))
    const invalid = definition('workflow-invalid-release', 1, 'Invalid release')
    invalid.nodes = invalid.nodes.filter((node) => node.id !== 'output')
    invalid.edges = invalid.edges.filter((edge) => edge.target !== 'output')
    const published = release(invalid)
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(invalid, releaseIdentity(published)))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    await expect(service.getRunDefinition(run.id)).resolves.toBeUndefined()
  })

  it('returns a fresh sanitized clone that cannot mutate stored history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-sanitized-definition-'))
    const snapshot = definition('workflow-sanitized-release', 1, 'Sanitized release')
    const snapshotWithSecrets = Object.assign(snapshot, {
      credential: 'secret-token',
      observations: [{ output: 'private output' }],
      input: { private: true },
      output: { private: true },
    })
    const published = release(snapshotWithSecrets)
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, releaseIdentity(published)))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    const first = await service.getRunDefinition(run.id)
    expect(first).not.toHaveProperty('credential')
    expect(first).not.toHaveProperty('observations')
    expect(first).not.toHaveProperty('input')
    expect(first).not.toHaveProperty('output')
    expect(first).not.toHaveProperty('connectorGrants')
    expect(first).not.toHaveProperty('environmentId')
    if (first !== undefined) {
      first.name = 'Caller mutation'
      first.nodes[1]!.label = 'Caller mutation'
      first.edges.splice(0)
    }

    const second = await service.getRunDefinition(run.id)
    expect(second).toEqual(definition(snapshot.id, snapshot.revision, 'Sanitized release'))
  })

  it.each(['releaseId', 'environmentId', 'traceId'] as const)('does not fall back to an ordinary revision when only %s marks a released-shaped run', async (marker) => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-incomplete-release-identity-'))
    const workflowStore = new WorkflowStore(directory)
    const input = definition('workflow-incomplete-release-identity', 1, 'Stored ordinary revision')
    const stored = await workflowStore.create({ id: input.id, name: input.name, description: '', nodes: input.nodes, edges: input.edges })
    const published = release(stored)
    const identity = marker === 'releaseId'
      ? { releaseId: published.id }
      : marker === 'environmentId'
        ? { environmentId: published.environmentId }
        : { traceId: 'trace-incomplete-identity' }
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(stored, identity))
    const service = createService(directory, workflowStore, runStore, () => published)

    await expect(service.getRunDefinition(run.id)).resolves.toBeUndefined()
  })

  it('returns undefined when a complete released identity disagrees with its release environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-release-environment-mismatch-'))
    const snapshot = definition('workflow-release-environment-mismatch', 1, 'Released snapshot')
    const published = release(snapshot)
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, {
      ...releaseIdentity(published),
      environmentId: 'different-production',
    }))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    await expect(service.getRunDefinition(run.id)).resolves.toBeUndefined()
  })

  it('returns undefined when a released identity contains a blank marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-blank-release-identity-'))
    const snapshot = definition('workflow-blank-release-identity', 1, 'Released snapshot')
    const published = release(snapshot)
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, releaseIdentity(published, '   ')))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    await expect(service.getRunDefinition(run.id)).resolves.toBeUndefined()
  })

  it('removes lastRunId from an ordinary revision and still returns a deep clone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-ordinary-last-run-id-'))
    const workflowStore = new WorkflowStore(directory)
    const input = definition('workflow-ordinary-last-run-id', 1, 'Ordinary snapshot')
    const stored = await workflowStore.create({
      id: input.id,
      name: input.name,
      description: input.description,
      nodes: input.nodes,
      edges: input.edges,
      lastRunId: 'run-editor-current',
    })
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(stored))
    const service = createService(directory, workflowStore, runStore)

    const first = await service.getRunDefinition(run.id)
    expect(first).not.toHaveProperty('lastRunId')
    if (first !== undefined) first.nodes[1]!.label = 'Caller mutation'
    const second = await service.getRunDefinition(run.id)
    expect(second).not.toHaveProperty('lastRunId')
    expect(second?.nodes[1]?.label).toBe('Ordinary snapshot')
  })

  it('removes lastRunId from a released snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-release-last-run-id-'))
    const snapshot = { ...definition('workflow-release-last-run-id', 1, 'Released snapshot'), lastRunId: 'run-editor-current' }
    const published = release(snapshot)
    const runStore = new WorkflowRunStore(directory)
    const run = await runStore.save(runRecord(snapshot, releaseIdentity(published)))
    const service = createService(directory, new WorkflowStore(directory), runStore, () => published)

    const result = await service.getRunDefinition(run.id)
    expect(result).not.toHaveProperty('lastRunId')
    expect(result?.name).toBe(snapshot.name)
  })

  it('returns undefined for a missing run and rejects invalid ids', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-definition-input-'))
    const service = createService(directory, new WorkflowStore(directory), new WorkflowRunStore(directory))

    await expect(service.getRunDefinition('run-missing')).resolves.toBeUndefined()
    await expect(service.getRunDefinition('   ')).rejects.toThrow(/Invalid workflow run ID/u)
    await expect(service.getRunDefinition(null as never)).rejects.toThrow(/Invalid workflow run ID/u)
  })
})

describe('run definition IPC contract', () => {
  let preloadBridge: EzDSHBridge | undefined

  async function loadPreloadBridge(): Promise<EzDSHBridge> {
    if (preloadBridge === undefined) {
      await import('../../src/preload/index.js')
      preloadBridge = preloadElectron.exposeInMainWorld.mock.calls.find(([name]) => name === 'EzDSH')?.[1] as EzDSHBridge | undefined
    }
    if (preloadBridge === undefined) throw new Error('Preload bridge was not exposed')
    return preloadBridge
  }

  async function registerHandler(service: { getRunDefinition(runId: string): Promise<WorkflowDefinition | undefined> } | undefined) {
    const module = await import('../../src/main/workflow/workflow-run-definition-ipc.js')
    let handler: ((_event: unknown, runId: unknown) => Promise<unknown>) | undefined
    const ipcMain = {
      handle: vi.fn((channel: string, listener: (_event: unknown, runId: unknown) => Promise<unknown>) => {
        if (channel === 'workflow-runs:get-definition') handler = listener
      }),
    }
    module.registerWorkflowRunDefinitionIpc(ipcMain, () => service)
    if (handler === undefined) throw new Error('Run definition handler was not registered')
    return handler
  }

  it('exposes the preload bridge on the workflow-runs:get-definition channel', async () => {
    const expected = definition('workflow-bridge', 1, 'Bridge definition')
    preloadElectron.invoke.mockResolvedValue({ ok: true, data: expected })
    const bridge = await loadPreloadBridge()

    await expect(bridge.workflows.getRunDefinition('run-bridge')).resolves.toEqual(expected)
    expect(preloadElectron.invoke).toHaveBeenCalledWith('workflow-runs:get-definition', 'run-bridge')
  })

  it('rejects and unwraps an IpcResult failure in preload', async () => {
    const bridge = await loadPreloadBridge()
    preloadElectron.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'RUN_DEFINITION_DENIED', message: 'Run definition denied', requestId: 'request-preload', retryable: false },
    })

    await expect(bridge.workflows.getRunDefinition('run-denied')).rejects.toMatchObject({
      message: 'Run definition denied',
      code: 'RUN_DEFINITION_DENIED',
      requestId: 'request-preload',
      retryable: false,
    })
  })

  it('registers an executable Main handler that returns success data', async () => {
    const expected = definition('workflow-handler', 1, 'Handler definition')
    const handler = await registerHandler({ getRunDefinition: vi.fn(async () => expected) })

    await expect(handler({}, 'run-handler')).resolves.toEqual({ ok: true, data: expected })
  })

  it('treats a missing run definition as a successful undefined result', async () => {
    const handler = await registerHandler({ getRunDefinition: vi.fn(async () => undefined) })

    await expect(handler({}, 'run-missing')).resolves.toEqual({ ok: true, data: undefined })
  })

  it('returns the existing failure envelope for invalid input', async () => {
    const handler = await registerHandler({ getRunDefinition: vi.fn(async () => { throw new Error('Invalid workflow run ID') }) })

    await expect(handler({}, null)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Invalid workflow run ID', requestId: expect.any(String), retryable: true },
    })
  })

  it('returns the existing failure envelope when the service fails', async () => {
    const failure = Object.assign(new Error('Run store unavailable'), { code: 'RUN_STORE_UNAVAILABLE' })
    const handler = await registerHandler({ getRunDefinition: vi.fn(async () => { throw failure }) })

    await expect(handler({}, 'run-failure')).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUN_STORE_UNAVAILABLE', message: 'Run store unavailable', requestId: expect.any(String), retryable: true },
    })
  })

  it('returns the existing failure envelope when the workflow service is unavailable', async () => {
    const handler = await registerHandler(undefined)

    await expect(handler({}, 'run-handler')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Workflow service is not ready', requestId: expect.any(String), retryable: true },
    })
  })
})
