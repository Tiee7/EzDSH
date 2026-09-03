import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkflowObservationStore } from '../../src/main/workflow/workflow-observation-store.js'
import { WorkflowObservabilityService } from '../../src/main/workflow/workflow-observability-service.js'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'
import { normalizeWorkflowRelease, type WorkflowRunRecord } from '../../src/shared/workflow-operations.js'

function createRunRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'run-acme-1',
    workflowId: 'workflow-acme-1',
    workflowRevision: 3,
    environmentId: 'customer-acme-prod',
    releaseId: 'release-acme-1',
    traceId: 'trace-acme-1',
    status: 'failed',
    input: {
      prompt: 'private prompt',
      headers: { Authorization: 'Bearer top-secret' },
      query: 'confidential',
      body: 'sensitive body',
    },
    output: {
      raw: 'secret output',
    },
    nodeStates: [],
    events: [
      {
        id: 'event-run-started',
        time: '2026-09-03T09:00:00.000Z',
        type: 'run-started',
        message: 'prompt=private prompt',
      },
      {
        id: 'event-effect-dispatched',
        time: '2026-09-03T09:01:00.000Z',
        type: 'node-effect-dispatched',
        nodeId: 'http-node',
        message: 'Authorization: Bearer top-secret body=sensitive body',
      },
      {
        id: 'event-node-failed',
        time: '2026-09-03T09:02:00.000Z',
        type: 'node-failed',
        nodeId: 'http-node',
        message: 'raw response: secret output',
      },
    ],
    allowShellFile: false,
    ...overrides,
  }
}

describe('WorkflowObservabilityService', () => {
  it('observes only safe run metadata, preserves node ids, skips ad-hoc runs, and deduplicates repeated events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-run-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T09:30:00.000Z',
      recentFailureWindowMs: 60_000,
    })
    const record = createRunRecord()

    await service.observeRun(record)
    await service.observeRun(record)
    await service.observeRun(createRunRecord({
      id: 'run-ad-hoc',
      environmentId: undefined,
      releaseId: undefined,
      traceId: undefined,
      events: [{
        id: 'event-ad-hoc',
        time: '2026-09-03T09:05:00.000Z',
        type: 'run-started',
        message: 'should not persist',
      }],
    }))

    expect(store.list()).toEqual([
      {
        id: 'event-run-started',
        environmentId: 'customer-acme-prod',
        releaseId: 'release-acme-1',
        runId: 'run-acme-1',
        traceId: 'trace-acme-1',
        time: '2026-09-03T09:00:00.000Z',
        kind: 'run',
        action: 'run-started',
        severity: 'info',
        outcome: 'started',
      },
      {
        id: 'event-effect-dispatched',
        environmentId: 'customer-acme-prod',
        releaseId: 'release-acme-1',
        runId: 'run-acme-1',
        traceId: 'trace-acme-1',
        nodeId: 'http-node',
        time: '2026-09-03T09:01:00.000Z',
        kind: 'effect',
        action: 'node-effect-dispatched',
        severity: 'info',
        outcome: 'unknown',
      },
      {
        id: 'event-node-failed',
        environmentId: 'customer-acme-prod',
        releaseId: 'release-acme-1',
        runId: 'run-acme-1',
        traceId: 'trace-acme-1',
        nodeId: 'http-node',
        time: '2026-09-03T09:02:00.000Z',
        kind: 'node',
        action: 'node-failed',
        severity: 'error',
        outcome: 'failed',
      },
    ])
    const persisted = await readFile(join(dir, 'workflow-observations.jsonl'), 'utf8')
    expect(persisted).not.toMatch(/private prompt|top-secret|sensitive body|secret output|Authorization|headers|query|body|raw response/u)
  })

  it('records deployment metadata and reports no-observations, recent failures, rolled back releases, and healthy states', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-health-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T10:00:00.000Z',
      recentFailureWindowMs: 60_000,
    })

    expect(service.health('customer-empty')).toEqual({
      environmentId: 'customer-empty',
      status: 'unknown',
      observedAt: '2026-09-03T10:00:00.000Z',
      reason: 'no-observations',
    })

    await service.observeRun(createRunRecord({
      id: 'run-recent-failure',
      environmentId: 'customer-failure',
      releaseId: 'release-failure-1',
      traceId: 'trace-failure-1',
      events: [{
        id: 'event-recent-failure',
        time: '2026-09-03T09:59:01.000Z',
        type: 'run-failed',
        message: 'customer prompt: secret',
      }],
    }))
    expect(service.health('customer-failure')).toEqual({
      environmentId: 'customer-failure',
      status: 'degraded',
      observedAt: '2026-09-03T10:00:00.000Z',
      reason: 'recent-failures',
    })

    await service.recordDeployment({
      id: 'deployment-rollback-1',
      environmentId: 'customer-rollback',
      releaseId: 'release-rollback-1',
      time: '2026-09-03T09:58:00.000Z',
      action: 'release-rolled-back',
      traceId: 'trace-rollback-1',
    })
    expect(service.health('customer-rollback')).toEqual({
      environmentId: 'customer-rollback',
      status: 'unhealthy',
      observedAt: '2026-09-03T10:00:00.000Z',
      reason: 'release-rolled-back',
    })

    await service.observeRun(createRunRecord({
      id: 'run-old-failure',
      environmentId: 'customer-healthy',
      releaseId: 'release-healthy-1',
      traceId: 'trace-healthy-1',
      events: [{
        id: 'event-old-failure',
        time: '2026-09-03T09:59:00.000Z',
        type: 'run-failed',
        message: 'too old for recent-failure boundary',
      }],
    }))
    await service.recordDeployment({
      id: 'deployment-published-1',
      environmentId: 'customer-healthy',
      releaseId: 'release-healthy-2',
      time: '2026-09-03T10:00:00.000Z',
      action: 'release-published',
    })
    expect(service.health('customer-healthy')).toEqual({
      environmentId: 'customer-healthy',
      status: 'healthy',
      observedAt: '2026-09-03T10:00:00.000Z',
      reason: 'healthy',
    })

    const persisted = await readFile(join(dir, 'workflow-observations.jsonl'), 'utf8')
    expect(persisted).toContain('"action":"release-rolled-back"')
    expect(persisted).toContain('"action":"release-published"')
    expect(persisted).not.toContain('customer prompt: secret')
  })

  it('records each release lifecycle event with a unique observation id and the supplied lifecycle time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-release-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T11:00:00.000Z',
    })
    const workflowSnapshot = createDefaultWorkflow('发布记录')
    workflowSnapshot.permissionPolicy = { connectors: [{ connectorId: 'crm', operations: ['read'] }] }
    const release = normalizeWorkflowRelease({
      id: 'release-record-1',
      environmentId: 'customer-acme-prod',
      workflowId: workflowSnapshot.id,
      workflowRevision: workflowSnapshot.revision,
      workflowSnapshot,
      contentSha256: 'a'.repeat(64),
      status: 'published',
      connectorGrants: [{ connectorId: 'crm', operations: ['read'] }],
      createdAt: '2026-09-03T10:00:00.000Z',
      publishedAt: '2026-09-03T10:00:00.000Z',
    })!

    await service.recordDeployment(release, '2026-09-03T10:00:00.000Z')
    release.status = 'superseded'
    await service.recordDeployment(release, '2026-09-03T10:01:00.000Z')
    release.status = 'rolled-back'
    await service.recordDeployment(release, '2026-09-03T10:02:00.000Z')

    const observations = store.list()
    expect(observations).toHaveLength(3)
    expect(new Set(observations.map((event) => event.id)).size).toBe(3)
    expect(observations.map((event) => event.action)).toEqual([
      'release-published',
      'release-superseded',
      'release-rolled-back',
    ])
    expect(observations.map((event) => event.time)).toEqual([
      '2026-09-03T10:00:00.000Z',
      '2026-09-03T10:01:00.000Z',
      '2026-09-03T10:02:00.000Z',
    ])
    expect(observations.every((event) => event.releaseId === 'release-record-1')).toBe(true)
    expect(JSON.stringify(observations)).not.toContain('发布记录')
  })
})
