import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowDeploymentService } from '../../src/main/workflow/workflow-deployment-service.js'
import { computeWorkflowDefinitionSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import { WorkflowEnvironmentStore } from '../../src/main/workflow/workflow-environment-store.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowConnectorService } from '../../src/main/workflow/workflow-connector-service.js'
import { WorkflowReleaseStore } from '../../src/main/workflow/workflow-release-store.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { WorkflowCustomerEnvironment, WorkflowRelease } from '../../src/shared/workflow-operations.js'
import type { WorkflowCreateInput, WorkflowDefinition, WorkflowNode, WorkflowRunRecord } from '../../src/shared/workflow.js'

afterEach(() => vi.restoreAllMocks())

function createEnvironment(overrides: Partial<WorkflowCustomerEnvironment> = {}): WorkflowCustomerEnvironment {
  return {
    id: 'customer-acme-staging',
    customerName: 'Acme',
    name: '预发布',
    kind: 'staging',
    status: 'active',
    connectorIds: ['crm'],
    allowShellFile: false,
    allowCode: false,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}

function createWorkflowInput(input: Partial<WorkflowCreateInput> & Pick<WorkflowCreateInput, 'name'>): WorkflowCreateInput {
  return {
    description: '',
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
    ],
    edges: [{ id: 'edge-output', source: 'input', target: 'output' }],
    ...input,
  }
}

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-deployment-'))
  const workflowStore = new WorkflowStore(dir)
  const environmentStore = new WorkflowEnvironmentStore(dir)
  const releaseStore = new WorkflowReleaseStore(dir, { now: () => '2026-09-03T09:00:00.000Z' })
  const connectorAuthorize = vi.fn(async () => undefined)
  const connectorRequest = vi.fn(async (request: { connectorId: string; method: string }) => ({
    status: 200,
    ok: true,
    body: { connectorId: request.connectorId, method: request.method },
  }))
  const runService = new WorkflowRunService({
    workflowStore,
    runStore: new WorkflowRunStore(dir),
    workflowRoot: dir,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
    resolveEmployee: () => undefined,
    lightweightClient: { complete: async () => 'unused' },
    mcpClient: { call: async () => 'unused' },
    connectorService: { authorize: connectorAuthorize, request: connectorRequest },
    allowLegacyHttp: false,
    resolveReleasedWorkflow: (releaseId) => releaseStore.get(releaseId),
  })
  const deploymentService = new WorkflowDeploymentService({
    workflowStore,
    environmentStore,
    releaseStore,
    runService,
  })
  return { dir, workflowStore, environmentStore, releaseStore, runService, deploymentService, connectorAuthorize, connectorRequest }
}

async function eventually(service: WorkflowRunService, runId: string): Promise<WorkflowRunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = service.get(runId)
    if (current !== undefined && ['completed', 'failed', 'cancelled', 'paused', 'waiting-approval'].includes(current.status)) return current
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('run did not finish in time')
}

function updateTransformNode(workflow: WorkflowDefinition, text: string): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => (
      node.id === 'transform' && node.type === 'transform'
        ? { ...node, config: { ...node.config, text } }
        : node
    )),
  }
}

describe('WorkflowDeploymentService', () => {
  it('pins a release snapshot and still starts from it after the source workflow changes or is removed', async () => {
    const { workflowStore, environmentStore, deploymentService, runService } = await createFixture()
    await environmentStore.upsert(createEnvironment())
    const workflow = await workflowStore.create(createWorkflowInput({
      name: '发布快照',
      permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['write'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'transform', type: 'transform', label: 'Transform', config: { template: 'prepend', text: 'release:' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'edge-transform', source: 'input', target: 'transform' },
        { id: 'edge-output', source: 'transform', target: 'output' },
      ],
    }))

    const release = await deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-staging' })
    expect(release.contentSha256).toBe(computeWorkflowDefinitionSha256(release.workflowSnapshot))

    await workflowStore.update(workflow.id, updateTransformNode(workflow, 'changed-after-publish:'))
    await workflowStore.remove(workflow.id)

    const initialRun = await deploymentService.start(release.id, '42')
    const run = await eventually(runService, initialRun.id)

    expect(run).toMatchObject({
      workflowId: workflow.id,
      workflowRevision: release.workflowRevision,
      environmentId: 'customer-acme-staging',
      releaseId: release.id,
      output: 'release:42',
    })
    expect(run.traceId).toEqual(expect.any(String))
  })

  it('intersects environment connector allowlist with workflow policy and uses release grants as the start baseline', async () => {
    const { workflowStore, environmentStore, deploymentService } = await createFixture()
    await environmentStore.upsert(createEnvironment({ connectorIds: ['crm'] }))
    const workflow = await workflowStore.create(createWorkflowInput({
      name: '连接器权限',
      permissionPolicy: {
        connectors: [
          { connectorId: 'crm', operations: ['read', 'write'] },
          { connectorId: 'billing', operations: ['read'] },
        ],
      },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'request', type: 'http', label: 'Request', config: { method: 'POST', connectorId: 'crm', connectorPath: '/orders', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'edge-request', source: 'input', target: 'request' },
        { id: 'edge-output', source: 'request', target: 'output' },
      ],
    }))

    const release = await deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-staging' })
    expect(release.connectorGrants).toEqual([{ connectorId: 'crm', operations: ['read', 'write'] }])

    const run = await deploymentService.start(release.id, { orderId: '42' }, {
      allowShellFile: true,
      allowCode: true,
      connectorGrants: [
        { connectorId: 'crm', operations: ['write'] },
        { connectorId: 'billing', operations: ['read'] },
      ],
    })

    expect(run).toMatchObject({
      environmentId: 'customer-acme-staging',
      releaseId: release.id,
      allowShellFile: false,
      allowCode: false,
      connectorGrants: [{ connectorId: 'crm', operations: ['write'] }],
    })
  })

  it('publishes child managed connector grants into the parent release and passes them to the child run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-deployment-child-'))
    const childRunDirectory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-deployment-child-run-'))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const workflowStore = new WorkflowStore(directory)
    const environmentStore = new WorkflowEnvironmentStore(directory)
    const releaseStore = new WorkflowReleaseStore(directory, { now: () => '2026-09-03T09:00:00.000Z' })
    const credentials = new WorkflowCredentialStore(directory)
    const connectors = new WorkflowConnectorStore(directory)
    await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/items'] })
    const connectorService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] })

    const child = await workflowStore.create(createWorkflowInput({
      id: 'workflow-child-connector',
      name: 'child-connector',
      permissionPolicy: { connectors: [{ connectorId: 'api', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'request', type: 'http', label: 'Request', config: { method: 'GET', connectorId: 'api', connectorPath: '/items', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'child-a', source: 'input', target: 'request' }, { id: 'child-b', source: 'request', target: 'output' }],
    }))
    const parent = await workflowStore.create(createWorkflowInput({
      id: 'workflow-parent-release',
      name: 'parent-release',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'child', type: 'sub-workflow', label: 'Child', config: { workflowId: child.id, waitForCompletion: true }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'parent-a', source: 'input', target: 'child' }, { id: 'parent-b', source: 'child', target: 'output' }],
    }))
    await environmentStore.upsert(createEnvironment({ connectorIds: ['api'] }))

    const childRunService = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(childRunDirectory),
      workflowRoot: childRunDirectory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
    })
    const runService = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(directory),
      workflowRoot: directory,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      connectorService,
      allowLegacyHttp: false,
      resolveReleasedWorkflow: (releaseId) => releaseStore.get(releaseId),
      executeSubWorkflow: async (childWorkflowId, input, waitForCompletion, version, childOptions) => {
        const childRun = await childRunService.start(childWorkflowId, input, { ...(childOptions ?? {}), ...(typeof version === 'number' ? { workflowRevision: version } : {}) })
        if (!waitForCompletion) return { runId: childRun.id }
        const settled = await eventually(childRunService, childRun.id)
        if (settled.status !== 'completed') throw new Error(settled.error ?? '子工作流执行失败')
        return settled.output ?? null
      },
    })
    const deploymentService = new WorkflowDeploymentService({
      workflowStore,
      environmentStore,
      releaseStore,
      runService,
    })

    const release = await deploymentService.publish({ workflowId: parent.id, environmentId: 'customer-acme-staging' })
    expect(release.connectorGrants).toEqual([{ connectorId: 'api', operations: ['read'] }])

    const initialRun = await deploymentService.start(release.id, { customerId: '42' })
    const completed = await eventually(runService, initialRun.id)

    expect(completed.status).toBe('completed')
    expect(completed.connectorGrants).toEqual([{ connectorId: 'api', operations: ['read'] }])
    expect(completed.output).toEqual({ status: 200, ok: true, headers: { 'content-type': 'application/json' }, body: { ok: true } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await childRunService.stop()
    await runService.stop()
  })

  it('rejects production releases that use raw URL HTTP, latest sub-workflows, or shell/file/code nodes', async () => {
    const { workflowStore, environmentStore, deploymentService } = await createFixture()
    await environmentStore.upsert(createEnvironment({ id: 'customer-acme-prod', name: '生产', kind: 'production' }))

    const cases: Array<{ name: string; node: WorkflowNode; message: RegExp }> = [
      {
        name: 'raw-http',
        node: { id: 'request', type: 'http', label: 'Request', config: { method: 'GET', url: 'https://api.example.com/orders', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        message: /HTTP|连接器|生产/u,
      },
      {
        name: 'latest-child',
        node: { id: 'child', type: 'sub-workflow', label: 'Child', config: { workflowId: 'workflow-child', version: 'latest' }, position: { x: 200, y: 0 } },
        message: /latest|生产/u,
      },
      {
        name: 'shell',
        node: { id: 'shell', type: 'shell', label: 'Shell', config: { command: 'echo', args: ['hello'] }, position: { x: 200, y: 0 } },
        message: /Shell|生产/u,
      },
      {
        name: 'file',
        node: { id: 'file', type: 'file', label: 'File', config: { operation: 'read', path: 'notes.txt' }, position: { x: 200, y: 0 } },
        message: /File|生产/u,
      },
      {
        name: 'code',
        node: { id: 'code', type: 'code', label: 'Code', config: { language: 'nodejs', code: 'return 1' }, position: { x: 200, y: 0 } },
        message: /代码|生产/u,
      },
    ]

    for (const testCase of cases) {
      const workflow = await workflowStore.create(createWorkflowInput({
        id: `workflow-${testCase.name}`,
        name: testCase.name,
        nodes: [
          { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
          testCase.node,
          { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
        ],
        edges: [
          { id: `edge-${testCase.name}-1`, source: 'input', target: testCase.node.id },
          { id: `edge-${testCase.name}-2`, source: testCase.node.id, target: 'output' },
        ],
      }))
      await expect(deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-prod' })).rejects.toThrow(testCase.message)
    }
  })

  it('rejects managed connector releases whose connector path or operation falls outside environment grants', async () => {
    const { workflowStore, environmentStore, deploymentService } = await createFixture()
    await environmentStore.upsert(createEnvironment({ connectorIds: ['crm'] }))

    const fakeMissingPathWorkflow = {
      schemaVersion: 2,
      id: 'workflow-missing-path',
      name: 'missing-path',
      description: '',
      revision: 1,
      enabled: true,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'request', type: 'http', label: 'Request', config: { method: 'GET', connectorId: 'crm', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'input', target: 'request' }, { id: 'b', source: 'request', target: 'output' }],
      permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['read'] }] },
    } satisfies WorkflowDefinition
    const fakeDeploymentService = new WorkflowDeploymentService({
      workflowStore: {
        initialize: async () => undefined,
        get: (id: string) => id === fakeMissingPathWorkflow.id ? fakeMissingPathWorkflow : undefined,
        getRevision: () => undefined,
      } as WorkflowStore,
      environmentStore,
      releaseStore: {
        initialize: async () => undefined,
      } as WorkflowReleaseStore,
      runService: {
        startReleased: async () => { throw new Error('should not start') },
      } as WorkflowRunService,
    })
    await expect(fakeDeploymentService.publish({ workflowId: fakeMissingPathWorkflow.id, environmentId: 'customer-acme-staging' })).rejects.toThrow(/路径|path/u)

    const disallowedWrite = await workflowStore.create(createWorkflowInput({
      id: 'workflow-disallowed-write',
      name: 'disallowed-write',
      permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['read'] }] },
      nodes: [
        { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'request', type: 'http', label: 'Request', config: { method: 'POST', connectorId: 'crm', connectorPath: '/orders', url: '', headers: {}, responseMode: 'json' }, position: { x: 200, y: 0 } },
        { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
      ],
      edges: [{ id: 'c', source: 'input', target: 'request' }, { id: 'd', source: 'request', target: 'output' }],
    }))
    await expect(deploymentService.publish({ workflowId: disallowedWrite.id, environmentId: 'customer-acme-staging' })).rejects.toThrow(/连接器|授权|grant/u)
  })

  it('rejects publish or start when the target environment is disabled or archived', async () => {
    const { workflowStore, environmentStore, deploymentService } = await createFixture()
    const workflow = await workflowStore.create(createWorkflowInput({ name: '环境状态' }))
    await environmentStore.upsert(createEnvironment({ status: 'disabled' }))
    await expect(deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-staging' })).rejects.toThrow(/环境|active/u)

    await environmentStore.upsert(createEnvironment({ status: 'active' }))
    const release = await deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-staging' })
    await environmentStore.upsert(createEnvironment({ status: 'archived' }))
    await expect(deploymentService.start(release.id, null)).rejects.toThrow(/环境|active|archived/u)
  })

  it('starts only published releases with valid integrity', async () => {
    const fixture = await createFixture()
    const { workflowStore, environmentStore, deploymentService, releaseStore } = fixture
    await environmentStore.upsert(createEnvironment())
    const workflow = await workflowStore.create(createWorkflowInput({ name: 'published-only' }))
    const first = await deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-staging' })
    await workflowStore.update(workflow.id, { ...workflow, name: 'published-only-v2' })
    const second = await deploymentService.publish({ workflowId: workflow.id, environmentId: 'customer-acme-staging', workflowRevision: 2 })

    expect(releaseStore.get(first.id)?.status).toBe('superseded')
    await expect(deploymentService.start(first.id, null)).rejects.toThrow(/已发布|published/u)
    await expect(deploymentService.start(second.id, null)).resolves.toMatchObject({ releaseId: second.id })

    const tamperedRelease = {
      ...second,
      contentSha256: 'b'.repeat(64),
    } satisfies WorkflowRelease
    const invalidService = new WorkflowDeploymentService({
      workflowStore,
      environmentStore,
      releaseStore: {
        initialize: async () => undefined,
        get: () => tamperedRelease,
      } as WorkflowReleaseStore,
      runService: fixture.runService,
    })
    await expect(invalidService.start(second.id, null)).rejects.toThrow(/integrity|完整/u)
  })
})
