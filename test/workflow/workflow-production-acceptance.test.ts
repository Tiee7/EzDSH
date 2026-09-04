import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowConnectorService } from '../../src/main/workflow/workflow-connector-service.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowDeploymentService } from '../../src/main/workflow/workflow-deployment-service.js'
import { WorkflowEnvironmentStore } from '../../src/main/workflow/workflow-environment-store.js'
import { WorkflowObservationStore } from '../../src/main/workflow/workflow-observation-store.js'
import { WorkflowObservabilityService } from '../../src/main/workflow/workflow-observability-service.js'
import { WorkflowReleaseStore } from '../../src/main/workflow/workflow-release-store.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { workflowReleaseSummary } from '../../src/shared/workflow-operations.js'
import type { WorkflowRunRecord } from '../../src/shared/workflow.js'

async function eventually(service: WorkflowRunService, runId: string): Promise<WorkflowRunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = service.get(runId)
    if (current !== undefined && ['completed', 'failed', 'cancelled', 'paused', 'waiting-approval'].includes(current.status)) return current
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('run did not settle in time')
}

describe('workflow production-candidate acceptance', () => {
  it('runs a pinned managed-connector release through approval, redacted observation, supersede, and rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-production-acceptance-'))
    const workflowStore = new WorkflowStore(dir)
    const environmentStore = new WorkflowEnvironmentStore(dir)
    const releaseStore = new WorkflowReleaseStore(dir, { now: () => '2026-09-04T01:00:00.000Z' })
    const observationStore = new WorkflowObservationStore(dir)
    const observations = new WorkflowObservabilityService({
      store: observationStore,
      now: () => '2026-09-04T01:10:00.000Z',
      recentFailureWindowMs: 60_000,
    })
    const credentials = new WorkflowCredentialStore(dir)
    const connectors = new WorkflowConnectorStore(dir)
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as { order: string; secret: string }
      return new Response(JSON.stringify({
        rawResponseBody: 'raw-response-body',
        order: requestBody.order,
        echoedRuntimeSecret: requestBody.secret,
        connectorSecret: 'connector-secret',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const connectorService = new WorkflowConnectorService({
      connectors,
      credentials,
      resolveHost: async () => [{ address: '93.184.216.34' }],
      fetchImpl: fetchImpl as typeof fetch,
    })
    const runService = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: async () => 'unused' },
      mcpClient: { call: async () => 'unused' },
      connectorService,
      allowLegacyHttp: false,
      resolveReleasedWorkflow: (releaseId) => releaseStore.get(releaseId),
    })
    const deployments = new WorkflowDeploymentService({ workflowStore, environmentStore, releaseStore, runService })

    await environmentStore.upsert({
      id: 'customer-acme-production',
      customerName: 'Acme',
      name: '生产',
      kind: 'production',
      status: 'active',
      connectorIds: ['crm'],
      allowShellFile: false,
      allowCode: false,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    })
    await credentials.upsert({
      id: 'crm-token',
      label: 'CRM production token',
      type: 'bearer-token',
      scopes: [{ origin: 'https://crm.example.test', methods: ['POST'], headerName: 'Authorization', prefix: 'Bearer', pathPrefixes: ['/orders'] }],
      secret: 'connector-secret',
    })
    await connectors.upsert({
      id: 'crm',
      name: 'Acme CRM',
      kind: 'http',
      baseUrl: 'https://crm.example.test/',
      credentialRef: { id: 'crm-token' },
      allowedPathPrefixes: ['/orders'],
    })
    const workflow = await workflowStore.create({
      name: '生产验收',
      description: 'A deterministic production release fixture',
      permissionPolicy: { connectors: [{ connectorId: 'crm', operations: ['write'] }] },
      nodes: [
        { id: 'entry', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
        { id: 'approval', type: 'approval', label: 'Approve', config: { message: 'Approve the managed CRM write' }, position: { x: 200, y: 0 } },
        { id: 'crm-write', type: 'http', label: 'Write CRM', config: { method: 'POST', connectorId: 'crm', connectorPath: '/orders', url: '', headers: {}, body: { order: '{{value.order}}', secret: '{{value.runtimeSecret}}' }, responseMode: 'json' }, position: { x: 400, y: 0 } },
        { id: 'result', type: 'output', label: 'Output', config: {}, position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: 'entry-approval', source: 'entry', target: 'approval' },
        { id: 'approval-crm', source: 'approval', target: 'crm-write' },
        { id: 'crm-result', source: 'crm-write', target: 'result' },
      ],
    })

    const first = await deployments.publish({ workflowId: workflow.id, environmentId: 'customer-acme-production' })
    expect(first.workflowSnapshot).toMatchObject({ name: '生产验收', revision: workflow.revision })
    await observations.recordDeployment(first, '2026-09-04T01:00:00.000Z')
    const pendingRun = await deployments.start(first.id, {
      order: 'order-42',
      runtimeSecret: 'runtime-secret',
      Authorization: 'Bearer runtime-authorization',
    })
    const awaitingApproval = await eventually(runService, pendingRun.id)
    expect(awaitingApproval.status).toBe('waiting-approval')

    await observations.observeRun(awaitingApproval)
    await runService.approve(awaitingApproval.id, true)
    const completed = await eventually(runService, awaitingApproval.id)
    expect(completed).toMatchObject({ status: 'completed', releaseId: first.id, environmentId: 'customer-acme-production' })
    expect(completed.output).toMatchObject({
      body: { rawResponseBody: 'raw-response-body', order: 'order-42', echoedRuntimeSecret: '[REDACTED]' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await observations.observeRun(completed)

    const changed = await workflowStore.update(workflow.id, {
      ...workflow,
      name: '生产验收 v2',
    })
    const second = await deployments.publish({ workflowId: changed.id, environmentId: 'customer-acme-production' })
    expect(first.workflowSnapshot).toMatchObject({ name: '生产验收', revision: workflow.revision })
    expect(second.workflowRevision).toBeGreaterThan(first.workflowRevision)
    await observations.recordDeployment(releaseStore.get(first.id)!, '2026-09-04T01:01:00.000Z')
    await observations.recordDeployment(second, '2026-09-04T01:02:00.000Z')
    expect(releaseStore.get(first.id)?.status).toBe('superseded')

    const restored = await deployments.rollback(first.id)
    expect(restored).toMatchObject({ id: first.id, status: 'published' })
    expect(releaseStore.get(second.id)?.status).toBe('rolled-back')
    await observations.recordDeployment({
      environmentId: 'customer-acme-production',
      releaseId: second.id,
      action: 'release-rolled-back',
      time: '2026-09-04T01:03:00.000Z',
    })
    expect(observations.health('customer-acme-production')).toMatchObject({ status: 'unhealthy', reason: 'release-rolled-back' })

    const rollbackRun = await deployments.start(first.id, {
      order: 'order-42',
      runtimeSecret: 'runtime-secret',
      Authorization: 'Bearer runtime-authorization',
    })
    const rollbackAwaitingApproval = await eventually(runService, rollbackRun.id)
    expect(rollbackAwaitingApproval).toMatchObject({ status: 'waiting-approval', workflowRevision: first.workflowRevision })
    await runService.approve(rollbackAwaitingApproval.id, true)
    const rollbackCompleted = await eventually(runService, rollbackAwaitingApproval.id)
    expect(rollbackCompleted).toMatchObject({
      status: 'completed',
      workflowRevision: first.workflowRevision,
      output: { body: { rawResponseBody: 'raw-response-body', order: 'order-42' } },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await observations.observeRun(rollbackCompleted)

    const releaseSummaries = [workflowReleaseSummary(first), workflowReleaseSummary(second), workflowReleaseSummary(restored)]
    const observedEvents = observations.list('customer-acme-production')
    const publicData = JSON.stringify({ releases: releaseSummaries, observations: observedEvents })
    const persistedReleaseData = await readFile(join(dir, 'workflow-releases.json'), 'utf8')
    const persistedObservationData = await readFile(join(dir, 'workflow-observations.jsonl'), 'utf8')
    const persistedReleases = JSON.parse(persistedReleaseData) as {
      releases: Array<{ id: string; workflowSnapshot: { name: string; revision: number } }>
    }

    expect(persistedReleases.releases.find((release) => release.id === first.id)).toMatchObject({
      workflowSnapshot: { name: '生产验收', revision: workflow.revision },
    })
    expect(publicData).not.toMatch(/order-42|runtime-secret|connector-secret|runtime-authorization|Authorization|raw-response-body/u)
    expect(persistedReleaseData).not.toMatch(/order-42|runtime-secret|connector-secret|runtime-authorization|Authorization|raw-response-body/u)
    expect(persistedObservationData).not.toMatch(/order-42|runtime-secret|connector-secret|runtime-authorization|Authorization|raw-response-body/u)
    expect(releaseSummaries.every((release) => !('workflowSnapshot' in release) && !('connectorGrants' in release))).toBe(true)
    expect(observedEvents.every((event) => !('input' in event) && !('output' in event) && !('message' in event))).toBe(true)
  })
})
