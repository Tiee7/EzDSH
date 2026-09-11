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

  it('records deployment metadata and reports no observations, recent failures, rollbacks, and sticky release failures', async () => {
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
      status: 'degraded',
      observedAt: '2026-09-03T10:00:00.000Z',
      reason: 'latest-run-failed',
    })

    const persisted = await readFile(join(dir, 'workflow-observations.jsonl'), 'utf8')
    expect(persisted).toContain('"action":"release-rolled-back"')
    expect(persisted).toContain('"action":"release-published"')
    expect(persisted).not.toContain('customer prompt: secret')
  })

  it('records explicit approval outcomes while retaining ambiguous legacy approval resolutions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-approval-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({ store })

    await service.observeRun(createRunRecord({
      events: [
        { id: 'event-approval-resolved', time: '2026-09-03T09:00:00.000Z', type: 'approval-resolved', nodeId: 'approval' },
        { id: 'event-approval-rejected', time: '2026-09-03T09:01:00.000Z', type: 'approval-rejected', nodeId: 'approval' },
      ],
    }))

    const [legacyObservation, rejectedObservation] = store.list()
    expect(legacyObservation).toMatchObject({ action: 'approval-resolved', severity: 'info', outcome: 'unknown' })
    expect(rejectedObservation).toMatchObject({ action: 'approval-rejected', severity: 'warning', outcome: 'failed' })
  })

  it('restores healthy when a later same-release completion supersedes a recent failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-recent-recovery-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T10:00:00.000Z',
      recentFailureWindowMs: 60_000,
    })

    await service.observeRun(createRunRecord({
      id: 'run-failed-release-a',
      releaseId: 'release-a',
      events: [{ id: 'event-failed-release-a', time: '2026-09-03T09:59:10.000Z', type: 'run-failed' }],
    }))
    await service.observeRun(createRunRecord({
      id: 'run-completed-release-a',
      releaseId: 'release-a',
      events: [{ id: 'event-completed-release-a', time: '2026-09-03T09:59:30.000Z', type: 'run-completed' }],
    }))

    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'healthy', reason: 'healthy' })
  })

  it('keeps a newer node failure degraded after an older same-release completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-newer-node-failure-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T10:00:00.000Z',
      recentFailureWindowMs: 60_000,
    })

    await service.observeRun(createRunRecord({
      id: 'run-completed-release-a',
      releaseId: 'release-a',
      events: [{ id: 'event-completed-release-a', time: '2026-09-03T09:59:20.000Z', type: 'run-completed' }],
    }))
    await service.observeRun(createRunRecord({
      id: 'run-node-failed-release-a',
      releaseId: 'release-a',
      events: [{ id: 'event-node-failed-release-a', time: '2026-09-03T09:59:30.000Z', type: 'node-failed', nodeId: 'node-a' }],
    }))

    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'degraded', reason: 'recent-failures' })
  })

  it('keeps old approval rejections degraded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-approval-rejection-health-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T12:00:00.000Z',
      recentFailureWindowMs: 60_000,
    })

    await service.observeRun(createRunRecord({
      releaseId: 'release-a',
      events: [{ id: 'event-old-approval-rejected', time: '2026-09-03T08:00:00.000Z', type: 'approval-rejected', nodeId: 'approval' }],
    }))

    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'degraded', reason: 'latest-run-failed' })
  })

  it('keeps failed releases degraded until a later success for the same release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-sticky-failure-'))
    const store = new WorkflowObservationStore(dir)
    let observedAt = '2026-09-03T10:00:00.000Z'
    const service = new WorkflowObservabilityService({
      store,
      now: () => observedAt,
      recentFailureWindowMs: 60_000,
    })

    await service.observeRun(createRunRecord({
      id: 'run-failed-release-a',
      releaseId: 'release-a',
      events: [{ id: 'event-failed-release-a', time: '2026-09-03T08:00:00.000Z', type: 'run-failed' }],
    }))
    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'degraded', reason: 'latest-run-failed' })

    await service.observeRun(createRunRecord({
      id: 'run-completed-release-b',
      releaseId: 'release-b',
      events: [{ id: 'event-completed-release-b', time: '2026-09-03T09:00:00.000Z', type: 'run-completed' }],
    }))
    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'degraded', reason: 'latest-run-failed' })

    await service.observeRun(createRunRecord({
      id: 'run-completed-release-a',
      releaseId: 'release-a',
      events: [{ id: 'event-completed-release-a', time: '2026-09-03T10:01:00.000Z', type: 'run-completed' }],
    }))
    observedAt = '2026-09-03T12:00:00.000Z'
    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'healthy', reason: 'healthy' })
  })

  it('uses append order when terminal signals share the same millisecond', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-tie-'))
    const store = new WorkflowObservationStore(dir)
    const service = new WorkflowObservabilityService({
      store,
      now: () => '2026-09-03T12:00:00.000Z',
      recentFailureWindowMs: 60_000,
    })
    const time = '2026-09-03T08:00:00.000Z'

    await service.observeRun(createRunRecord({ events: [{ id: 'z-failed-first', time, type: 'run-failed' }] }))
    await service.observeRun(createRunRecord({ events: [{ id: 'a-completed-later', time, type: 'run-completed' }] }))

    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'healthy', reason: 'healthy' })
  })

  it('treats a same-millisecond run completion after a recent node failure as healthy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observability-recent-tie-'))
    const store = new WorkflowObservationStore(dir)
    const time = '2026-09-03T11:59:59.999Z'
    const service = new WorkflowObservabilityService({ store, now: () => '2026-09-03T12:00:00.000Z', recentFailureWindowMs: 60_000 })
    await service.observeRun(createRunRecord({ events: [
      { id: 'node-failed-first', time, type: 'node-failed', nodeId: 'write' },
      { id: 'run-completed-later', time, type: 'run-completed' },
    ] }))
    expect(service.health('customer-acme-prod')).toMatchObject({ status: 'healthy', reason: 'healthy' })
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
