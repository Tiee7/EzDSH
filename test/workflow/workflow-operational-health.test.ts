import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowOperationalHealthService } from '../../src/main/workflow/workflow-operational-health-service.js'
import { computeWorkflowReleaseSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import { WorkflowReleaseStore } from '../../src/main/workflow/workflow-release-store.js'
import { createDefaultWorkflow, type WorkflowRunRecord } from '../../src/shared/workflow.js'
import type { WorkflowCustomerEnvironment, WorkflowObservationEvent, WorkflowRelease } from '../../src/shared/workflow-operations.js'
import type { WorkflowRunServiceOperationsSnapshot } from '../../src/main/workflow/workflow-run-service.js'

const NOW = '2026-09-12T10:00:00.000Z'
const ENVIRONMENT_ID = 'customer-acme-prod'
const WORKFLOW_ID = 'workflow-acme'

function createRelease(overrides: Partial<WorkflowRelease> = {}): WorkflowRelease {
  const workflowSnapshot = createDefaultWorkflow('Operational health')
  workflowSnapshot.id = WORKFLOW_ID
  const release: WorkflowRelease = {
    id: 'release-current',
    environmentId: ENVIRONMENT_ID,
    workflowId: WORKFLOW_ID,
    workflowRevision: workflowSnapshot.revision,
    workflowSnapshot,
    contentSha256: '',
    status: 'published',
    connectorGrants: [],
    createdAt: '2026-09-12T09:00:00.000Z',
    publishedAt: '2026-09-12T09:00:00.000Z',
    activation: { kind: 'publish', at: '2026-09-12T09:00:00.000Z' },
    ...overrides,
  }
  release.contentSha256 = overrides.contentSha256 ?? computeWorkflowReleaseSha256(release)
  return release
}

function createRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: 'run-current',
    workflowId: WORKFLOW_ID,
    workflowRevision: 1,
    environmentId: ENVIRONMENT_ID,
    releaseId: 'release-current',
    status: 'completed',
    input: {},
    nodeStates: [],
    events: [{ id: 'run-current-completed', time: '2026-09-12T09:30:00.000Z', type: 'run-completed' }],
    allowShellFile: false,
    startedAt: '2026-09-12T09:29:00.000Z',
    completedAt: '2026-09-12T09:30:00.000Z',
    ...overrides,
  }
}

function readyOperations(overrides: Partial<WorkflowRunServiceOperationsSnapshot> = {}): WorkflowRunServiceOperationsSnapshot {
  return {
    lifecycle: 'accepting',
    worker: {
      state: 'ready',
      consecutiveClaimFailures: 0,
      activeRunCount: 0,
      lastPollAttemptAt: '2026-09-12T09:59:59.000Z',
      lastPollSucceededAt: '2026-09-12T09:59:59.000Z',
    },
    ...overrides,
  }
}

function createService(input: {
  operations?: WorkflowRunServiceOperationsSnapshot
  releases?: WorkflowRelease[]
  runs?: WorkflowRunRecord[]
  observations?: WorkflowObservationEvent[]
  environment?: WorkflowCustomerEnvironment | null
  releaseIntegrityFailures?: ReturnType<WorkflowReleaseStore['listIntegrityFailures']>
} = {}): WorkflowOperationalHealthService {
  return new WorkflowOperationalHealthService({
    now: () => NOW,
    workerStaleAfterMs: 60_000,
    recentFailureWindowMs: 60 * 60 * 1000,
    getRunServiceOperations: () => input.operations ?? readyOperations(),
    listReleases: () => input.releases ?? [createRelease()],
    listRuns: () => input.runs ?? [createRun()],
    listObservations: () => input.observations ?? [],
    resolveEnvironment: () => input.environment === undefined ? {
      id: ENVIRONMENT_ID, customerName: 'Acme', name: 'Production', kind: 'production', status: 'active',
      connectorIds: [], allowShellFile: false, allowCode: false,
      createdAt: '2026-09-12T08:00:00.000Z', updatedAt: '2026-09-12T08:00:00.000Z',
    } : input.environment ?? undefined,
    listReleaseIntegrityFailures: () => input.releaseIntegrityFailures ?? [],
  })
}

describe('WorkflowOperationalHealthService', () => {
  it.each([
    ['new', 'unhealthy', 'service-not-accepting'],
    ['stopping', 'unhealthy', 'service-not-accepting'],
    ['stopped', 'unhealthy', 'service-not-accepting'],
    ['initializing', 'unknown', 'service-initializing'],
  ] as const)('reports lifecycle %s before deployment evidence', (lifecycle, status, reason) => {
    const service = createService({
      operations: readyOperations({ lifecycle, worker: { state: 'stopped', consecutiveClaimFailures: 0, activeRunCount: 0 } }),
      releases: [],
      runs: [],
    })

    expect(service.getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })).toMatchObject({
      workflowId: WORKFLOW_ID,
      environmentId: ENVIRONMENT_ID,
      status,
      reason,
      observedAt: NOW,
      service: { lifecycle },
      release: { state: 'unchecked' },
      execution: { state: 'unchecked' },
    })
  })

  it.each([
    [{ state: 'stopped', consecutiveClaimFailures: 0, activeRunCount: 0 }, 'unhealthy', 'worker-stopped'],
    [{ state: 'stopping', consecutiveClaimFailures: 0, activeRunCount: 0 }, 'unhealthy', 'worker-stopped'],
    [{ state: 'backing-off', consecutiveClaimFailures: 2, activeRunCount: 0, lastPollFailedAt: '2026-09-12T09:59:59.000Z' }, 'degraded', 'worker-backing-off'],
    [{ state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 0 }, 'unknown', 'worker-never-polled'],
    [{ state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 0, lastPollSucceededAt: '2026-09-12T09:58:59.999Z' }, 'degraded', 'worker-stale'],
  ] as const)('reports worker truth before release truth: %s', (worker, status, reason) => {
    const service = createService({ operations: readyOperations({ worker }), releases: [], runs: [] })
    expect(service.getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })).toMatchObject({
      status,
      reason,
      worker,
      release: { state: 'missing' },
    })
  })

  it('does not use recent business observations as worker freshness evidence', () => {
    const service = createService({
      operations: readyOperations({ worker: { state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 0 } }),
      observations: [{
        id: 'recent-business-event', environmentId: ENVIRONMENT_ID, releaseId: 'release-current', runId: 'run-current',
        time: '2026-09-12T09:59:59.999Z', kind: 'run', action: 'run-completed', severity: 'info', outcome: 'succeeded',
      }],
    })
    expect(service.getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })).toMatchObject({
      status: 'unknown', reason: 'worker-never-polled',
    })
  })

  it('does not call a busy Worker stale during a long claimed execution', () => {
    const service = createService({
      operations: readyOperations({ worker: {
        state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 1,
        lastPollSucceededAt: '2026-09-12T09:00:00.000Z',
        activeRunHeartbeatAt: '2026-09-12T09:59:59.000Z',
      } }),
      runs: [createRun({ status: 'running', completedAt: undefined, events: [] })],
    })
    expect(service.getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })).toMatchObject({
      status: 'unknown', reason: 'no-terminal-run-after-activation', worker: { activeRunCount: 1 },
    })
  })

  it('requires a fresh active heartbeat but accepts global single-Worker activity as liveness', () => {
    const staleActive = createService({
      operations: readyOperations({ worker: {
        state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 1,
        lastPollSucceededAt: '2026-09-12T09:00:00.000Z',
        activeRunHeartbeatAt: '2026-09-12T09:58:00.000Z',
      } }),
      runs: [createRun({ status: 'running', completedAt: undefined, events: [] })],
    }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(staleActive).toMatchObject({ status: 'degraded', reason: 'worker-stale' })

    const unrelatedActive = createService({
      operations: readyOperations({ worker: {
        state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 1,
        lastPollSucceededAt: '2026-09-12T09:00:00.000Z',
        activeRunHeartbeatAt: '2026-09-12T09:59:59.000Z',
      } }),
      runs: [createRun({ id: 'run-other', workflowId: 'workflow-other', status: 'running', completedAt: undefined, events: [] })],
    }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(unrelatedActive).toMatchObject({ status: 'unknown', reason: 'no-terminal-run-after-activation' })
  })

  it('reports a confirmed active lease loss before otherwise fresh poll evidence', () => {
    const health = createService({
      operations: readyOperations({ worker: {
        state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 1,
        lastPollSucceededAt: '2026-09-12T09:59:59.000Z',
        activeRunLeaseLostAt: '2026-09-12T09:59:59.500Z',
      } }),
    }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(health).toMatchObject({ status: 'degraded', reason: 'worker-active-lease-lost' })
  })

  it('reports missing and inactive execution environments instead of reusing historical success', () => {
    const missing = createService({ environment: null }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(missing).toMatchObject({ status: 'unhealthy', reason: 'environment-not-found', environment: { state: 'missing' } })

    const disabledEnvironment: WorkflowCustomerEnvironment = {
      id: ENVIRONMENT_ID, customerName: 'Acme', name: 'Production', kind: 'production', status: 'disabled',
      connectorIds: [], allowShellFile: false, allowCode: false,
      createdAt: '2026-09-12T08:00:00.000Z', updatedAt: '2026-09-12T09:59:00.000Z',
    }
    const disabled = createService({ environment: disabledEnvironment }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(disabled).toMatchObject({ status: 'unhealthy', reason: 'environment-not-active', environment: { state: 'inactive', status: 'disabled' } })
  })

  it('retains ambiguous release evidence while preserving the specified Worker-first reason', () => {
    const health = createService({
      operations: readyOperations({ worker: { state: 'backing-off', consecutiveClaimFailures: 2, activeRunCount: 0 } }),
      releases: [createRelease(), createRelease({ id: 'release-duplicate' })],
    }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(health).toMatchObject({
      status: 'degraded', reason: 'worker-backing-off', release: { state: 'multiple-published' }, execution: { state: 'unchecked' },
    })
  })

  it('reports missing, duplicate, corrupt, and legacy-activation releases explicitly', () => {
    const missing = createService({ releases: [], runs: [] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(missing).toMatchObject({ status: 'unknown', reason: 'no-current-release', release: { state: 'missing' } })

    const duplicate = createService({ releases: [createRelease(), createRelease({ id: 'release-duplicate' })], runs: [] })
      .getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(duplicate).toMatchObject({ status: 'unhealthy', reason: 'multiple-current-releases', release: { state: 'multiple-published' } })

    const corrupt = createService({ releases: [createRelease({ contentSha256: '0'.repeat(64) })], runs: [] })
      .getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(corrupt).toMatchObject({
      status: 'unhealthy', reason: 'release-integrity-failed',
      release: { state: 'integrity-failed', id: 'release-current', revision: 1 },
    })

    const legacy = createService({ releases: [createRelease({ activation: undefined })], runs: [] })
      .getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(legacy).toMatchObject({
      status: 'unknown', reason: 'release-activation-unknown',
      release: { state: 'active', id: 'release-current', revision: 1 },
    })
    expect(legacy.release.activation).toBeUndefined()
  })

  it('surfaces a persisted release rejected for digest corruption as unhealthy identity-only evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-release-integrity-'))
    const corrupt = createRelease({ contentSha256: '0'.repeat(64) })
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: [corrupt] }))
    const releaseStore = new WorkflowReleaseStore(directory, { now: () => NOW })
    await releaseStore.initialize()

    expect(releaseStore.list()).toEqual([])
    expect(releaseStore.listIntegrityFailures()).toEqual([{
      id: 'release-current', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, workflowRevision: 1, status: 'published',
      detectedAt: NOW, reason: 'digest-mismatch',
    }])
    const health = createService({
      releases: releaseStore.list(),
      releaseIntegrityFailures: releaseStore.listIntegrityFailures(),
      runs: [],
    }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(health).toMatchObject({
      status: 'unhealthy', reason: 'release-integrity-failed',
      release: { state: 'integrity-failed', id: 'release-current', revision: 1 },
    })
  })

  it('persists only strict integrity identities across unrelated writes and clears them on a trusted replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-integrity-ledger-'))
    const corrupt = createRelease({ contentSha256: '0'.repeat(64) })
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: [corrupt] }))
    const releaseStore = new WorkflowReleaseStore(directory, { now: () => NOW })
    await releaseStore.initialize()

    const other = createRelease({ id: 'release-other', environmentId: 'customer-other' })
    other.workflowId = 'workflow-other'
    other.workflowSnapshot.id = 'workflow-other'
    other.contentSha256 = computeWorkflowReleaseSha256(other)
    await releaseStore.publish(other)

    const reloaded = new WorkflowReleaseStore(directory, { now: () => '2026-09-12T11:00:00.000Z' })
    await reloaded.initialize()
    expect(reloaded.listIntegrityFailures()).toEqual([{
      id: 'release-current', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, workflowRevision: 1, status: 'published',
      detectedAt: NOW, reason: 'digest-mismatch',
    }])
    expect(JSON.stringify(reloaded.listIntegrityFailures())).not.toMatch(/snapshot|connector|grant|node|secret/i)

    await reloaded.publish(createRelease())
    expect(reloaded.listIntegrityFailures()).toEqual([])
    const recovered = new WorkflowReleaseStore(directory)
    await recovered.initialize()
    expect(recovered.listIntegrityFailures()).toEqual([])
    expect(recovered.get('release-current')).toBeDefined()
  })

  it('captures safe identity for malformed releases and fails closed on a malformed integrity sidecar', async () => {
    const malformedDirectory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-malformed-release-'))
    const malformed = { ...createRelease(), activation: { kind: 'invalid', at: NOW } }
    await writeFile(join(malformedDirectory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: [malformed] }))
    const malformedStore = new WorkflowReleaseStore(malformedDirectory, { now: () => NOW })
    await malformedStore.initialize()
    expect(malformedStore.listIntegrityFailures()).toEqual([{
      id: 'release-current', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, workflowRevision: 1, status: 'published',
      detectedAt: NOW, reason: 'invalid-release',
    }])

    const badLedgerDirectory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-bad-ledger-'))
    await writeFile(join(badLedgerDirectory, 'workflow-release-integrity-failures.json'), JSON.stringify({
      version: 1,
      failures: [{ id: 'release-current', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, workflowRevision: 1, status: 'published', detectedAt: NOW, reason: 'digest-mismatch', snapshot: { secret: true } }],
    }))
    await expect(new WorkflowReleaseStore(badLedgerDirectory).initialize()).rejects.toThrow(/integrity ledger/i)
  })

  it('reconciles a trusted replacement after a crash between the release and sidecar writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-integrity-recovery-'))
    const replacement = createRelease({ activation: { kind: 'publish', at: '2026-09-12T10:01:00.000Z' } })
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: [replacement] }))
    await writeFile(join(directory, 'workflow-release-integrity-failures.json'), JSON.stringify({
      version: 1,
      failures: [{
        id: 'release-corrupt-old', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, workflowRevision: 1,
        status: 'published', detectedAt: NOW, reason: 'digest-mismatch',
      }],
      pendingResolution: {
        workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, releaseId: 'release-current',
        kind: 'publish', startedAt: '2026-09-12T10:01:00.000Z',
      },
    }))
    const recovered = new WorkflowReleaseStore(directory)
    await recovered.initialize()
    expect(recovered.list()).toHaveLength(1)
    expect(recovered.listIntegrityFailures()).toEqual([])

    const reloaded = new WorkflowReleaseStore(directory)
    await reloaded.initialize()
    expect(reloaded.listIntegrityFailures()).toEqual([])
  })

  it('does not confuse an unrelated publish with resolution of a valid plus corrupt double publish', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-integrity-isolation-'))
    const valid = createRelease({ id: 'release-valid' })
    const corrupt = createRelease({ id: 'release-corrupt', contentSha256: '0'.repeat(64) })
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: [valid, corrupt] }))
    const initial = new WorkflowReleaseStore(directory, { now: () => NOW })
    await initial.initialize()
    expect(initial.list()).toHaveLength(1)
    expect(initial.listIntegrityFailures()).toHaveLength(1)

    const other = createRelease({ id: 'release-other', environmentId: 'customer-other' })
    other.workflowId = 'workflow-other'
    other.workflowSnapshot.id = 'workflow-other'
    other.contentSha256 = computeWorkflowReleaseSha256(other)
    await initial.publish(other)

    const reloaded = new WorkflowReleaseStore(directory)
    await reloaded.initialize()
    expect(reloaded.listIntegrityFailures()).toMatchObject([{
      id: 'release-corrupt', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, status: 'published',
    }])
  })

  it.each([
    ['valid-first', (valid: WorkflowRelease, corrupt: WorkflowRelease) => [valid, corrupt]],
    ['corrupt-first', (valid: WorkflowRelease, corrupt: WorkflowRelease) => [corrupt, valid]],
  ] as const)('fails closed for a duplicate release id regardless of persisted order: %s', async (_case, order) => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-operational-duplicate-release-id-'))
    const valid = createRelease()
    const corrupt = createRelease({ contentSha256: '0'.repeat(64) })
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: order(valid, corrupt) }))

    const store = new WorkflowReleaseStore(directory, { now: () => NOW })
    await store.initialize()

    expect(store.list()).toEqual([])
    expect(store.listIntegrityFailures()).toEqual([{
      id: 'release-current', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID, workflowRevision: 1,
      status: 'published', detectedAt: NOW, reason: 'duplicate-release-id',
    }])
  })

  it('requires a terminal run for the exact workflow, environment, release, and activation', () => {
    const service = createService({
      runs: [
        createRun({ id: 'before-activation', completedAt: '2026-09-12T08:59:59.999Z' }),
        createRun({ id: 'other-workflow', workflowId: 'workflow-other', completedAt: '2026-09-12T09:59:00.000Z' }),
        createRun({ id: 'other-environment', environmentId: 'customer-other', completedAt: '2026-09-12T09:59:00.000Z' }),
        createRun({ id: 'other-release', releaseId: 'release-other', completedAt: '2026-09-12T09:59:00.000Z' }),
      ],
    })
    expect(service.getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })).toMatchObject({
      status: 'unknown', reason: 'no-terminal-run-after-activation',
      release: { state: 'active', id: 'release-current', revision: 1, activation: { kind: 'publish', at: '2026-09-12T09:00:00.000Z' } },
      execution: { state: 'none' },
    })
  })

  it.each([
    ['failed', 'latest-run-failed'],
    ['cancelled', 'latest-run-cancelled'],
  ] as const)('reports latest %s execution as degraded', (runStatus, reason) => {
    const run = createRun({ status: runStatus, id: `run-${runStatus}`, completedAt: '2026-09-12T09:50:00.000Z' })
    const health = createService({ runs: [run] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(health).toMatchObject({
      status: 'degraded', reason,
      execution: { state: runStatus, runId: `run-${runStatus}`, time: '2026-09-12T09:50:00.000Z' },
    })
  })

  it('uses failure-first durable semantics when terminal runs share a timestamp', () => {
    const time = '2026-09-12T09:50:00.000Z'
    const health = createService({ runs: [
      createRun({ id: 'z-completed', status: 'completed', completedAt: time }),
      createRun({ id: 'a-failed', status: 'failed', completedAt: time }),
    ] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(health).toMatchObject({ status: 'degraded', reason: 'latest-run-failed', execution: { state: 'failed', time } })
  })

  it('is healthy only after completion and degrades an unresolved recent failure for the current release', () => {
    const unresolvedFailure: WorkflowObservationEvent = {
      id: 'node-failed-after-completion', environmentId: ENVIRONMENT_ID, releaseId: 'release-current', runId: 'run-current',
      time: '2026-09-12T09:31:00.000Z', kind: 'node', action: 'node-failed', severity: 'error', outcome: 'failed',
    }
    const degraded = createService({ observations: [
      { ...unresolvedFailure, workflowId: 'not-a-contract-field' } as WorkflowObservationEvent,
      { ...unresolvedFailure, id: 'other-release-failure', releaseId: 'release-other', time: '2026-09-12T09:59:00.000Z' },
      { ...unresolvedFailure, id: 'other-environment-failure', environmentId: 'customer-other', time: '2026-09-12T09:59:00.000Z' },
    ] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(degraded).toMatchObject({ status: 'degraded', reason: 'recent-failures', execution: { state: 'completed', runId: 'run-current' } })

    const healthy = createService({ observations: [
      { ...unresolvedFailure, id: 'failure-before-success', time: '2026-09-12T09:29:30.000Z' },
      { ...unresolvedFailure, id: 'other-workflow-release', releaseId: 'release-other', time: '2026-09-12T09:59:00.000Z' },
    ] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID })
    expect(healthy).toMatchObject({ status: 'healthy', reason: 'healthy', execution: { state: 'completed', time: '2026-09-12T09:30:00.000Z' } })
  })

  it('treats same-millisecond failure evidence conservatively unless a later appended completion resolves it', () => {
    const time = '2026-09-12T09:30:00.000Z'
    const failure: WorkflowObservationEvent = {
      id: 'same-time-failure', environmentId: ENVIRONMENT_ID, releaseId: 'release-current', runId: 'run-current',
      time, kind: 'node', action: 'node-failed', severity: 'error', outcome: 'failed',
    }
    const completion: WorkflowObservationEvent = {
      id: 'same-time-completion', environmentId: ENVIRONMENT_ID, releaseId: 'release-current', runId: 'run-current',
      time, kind: 'run', action: 'run-completed', severity: 'info', outcome: 'succeeded',
    }
    expect(createService({ observations: [failure] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'degraded', reason: 'recent-failures' })
    expect(createService({ observations: [failure, completion] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'healthy', reason: 'healthy' })
  })

  it('skips malformed persisted terminal events instead of failing the health request', () => {
    const malformed = createRun({
      status: 'failed',
      completedAt: undefined,
      events: [null as never, {} as never, { id: 'invalid-time', time: 'not-a-time', type: 'run-failed' }],
    })
    expect(createService({ runs: [malformed] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'unknown', reason: 'no-terminal-run-after-activation', execution: { state: 'none' } })
  })

  it.each([
    { runId: 'run-current', time: '2026-09-13T09:30:00.000Z' },
    { runId: 'unverified-run', time: '2026-09-12T09:30:00.000Z' },
    { runId: 'run-current', time: '2026-09-12T09:31:00.000Z' },
  ])('does not let an unverified recovery observation resolve a tied failure: %s', (recovery) => {
    const failure: WorkflowObservationEvent = {
      id: 'tied-failure', environmentId: ENVIRONMENT_ID, releaseId: 'release-current', runId: 'run-current',
      time: '2026-09-12T09:30:00.000Z', kind: 'node', action: 'node-failed', severity: 'error', outcome: 'failed',
    }
    const completion: WorkflowObservationEvent = {
      ...failure, ...recovery, id: 'unverified-completion', kind: 'run', action: 'run-completed', severity: 'info', outcome: 'succeeded',
    }
    expect(createService({ observations: [failure, completion] })
      .getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'degraded', reason: 'recent-failures' })
  })

  it('persists a redacted target identity when a corrupt published release has an invalid revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-health-invalid-revision-'))
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify([
      createRelease(),
      { ...createRelease({ id: 'release-invalid-revision' }), workflowRevision: 'secret-token-invalid-revision' },
    ]))
    const store = new WorkflowReleaseStore(directory, { now: () => NOW })
    await store.initialize()
    expect(store.listIntegrityFailures()).toEqual([{
      id: 'release-invalid-revision', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID,
      workflowRevision: 0, status: 'published', detectedAt: NOW, reason: 'invalid-release',
    }])
    await store.publish(createRelease({ id: 'release-other-environment', environmentId: 'customer-other' }))
    const reloaded = new WorkflowReleaseStore(directory)
    await reloaded.initialize()
    expect(reloaded.listIntegrityFailures()).toEqual(store.listIntegrityFailures())
    const sidecar = await readFile(join(directory, 'workflow-release-integrity-failures.json'), 'utf8')
    expect(sidecar).not.toContain('secret-token')
    expect(sidecar).not.toMatch(/workflowSnapshot|connectorGrants|input|output/)
    expect(createService({ releases: reloaded.list(), releaseIntegrityFailures: reloaded.listIntegrityFailures() })
      .getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'unhealthy', reason: 'multiple-current-releases' })
  })

  it('rejects invalid query identities before reading operational state', () => {
    let reads = 0
    const service = new WorkflowOperationalHealthService({
      getRunServiceOperations: () => { reads += 1; return readyOperations() },
      listReleases: () => [], listRuns: () => [], listObservations: () => [], resolveEnvironment: () => undefined,
      listReleaseIntegrityFailures: () => [],
    })
    expect(() => service.getOperationalHealth({ workflowId: '', environmentId: ENVIRONMENT_ID })).toThrow(/workflow/i)
    expect(() => service.getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: '../escape' })).toThrow(/environment/i)
    expect(reads).toBe(0)
  })

  it('does not accept a future poll timestamp as current evidence', () => {
    const future = '2026-09-13T10:00:00.000Z'
    expect(createService({ operations: readyOperations({ worker: {
      state: 'ready', consecutiveClaimFailures: 0, activeRunCount: 0, lastPollSucceededAt: future,
    } }) }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'degraded', reason: 'worker-stale' })
  })

  it('does not accept a future execution timestamp as current evidence', () => {
    const future = '2026-09-13T10:00:00.000Z'
    expect(createService({ runs: [createRun({ completedAt: future })] })
      .getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'unknown', reason: 'no-terminal-run-after-activation' })
  })

  it.each([
    { id: 'secret token from malformed record' },
    { completedAt: ['2026-09-12T09:30:00.000Z'] as unknown as string, events: [] },
    { workflowRevision: 2 },
  ])('rejects malformed execution evidence: %s', (overrides) => {
    const run = createRun(overrides)
    expect(createService({ runs: [run] }).getOperationalHealth({ workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID }))
      .toMatchObject({ status: 'unknown', reason: 'no-terminal-run-after-activation' })
  })

  it('does not resolve integrity failures using an older activation with the same release id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-health-old-activation-'))
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify({ version: 1, releases: [createRelease()] }))
    await writeFile(join(directory, 'workflow-release-integrity-failures.json'), JSON.stringify({
      version: 1,
      failures: [{ id: 'release-corrupt', workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID,
        workflowRevision: 1, status: 'published', detectedAt: NOW, reason: 'digest-mismatch' }],
      pendingResolution: { workflowId: WORKFLOW_ID, environmentId: ENVIRONMENT_ID,
        releaseId: 'release-current', kind: 'rollback', startedAt: NOW },
    }))
    const store = new WorkflowReleaseStore(directory)
    await store.initialize()
    expect(store.listIntegrityFailures()).toHaveLength(1)
  })

  it('keeps release evidence unchanged until a replacement is durably written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-health-write-failure-'))
    const store = new WorkflowReleaseStore(directory, { now: () => NOW })
    await store.publish(createRelease())
    const before = store.list()
    let rejectWrite!: (error: Error) => void
    vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist')
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject }))
    const publishing = store.publish(createRelease({ id: 'release-replacement' }))
    const rejection = expect(publishing).rejects.toThrow('ENOSPC')
    await vi.waitFor(() => expect(rejectWrite).toBeDefined())
    const during = store.list()
    rejectWrite(new Error('ENOSPC'))
    await rejection
    expect(during).toEqual(before)
    expect(store.list()).toEqual(before)
    await expect(store.publish(createRelease({ id: 'release-replacement' }))).resolves.toMatchObject({ id: 'release-replacement' })
  })

  it('detects duplicate canonical ids even when one persisted spelling contains whitespace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-health-canonical-duplicate-'))
    const valid = createRelease()
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify([valid, { ...valid, id: ' release-current ' }]))
    const store = new WorkflowReleaseStore(directory)
    await store.initialize()
    expect(store.list()).toEqual([])
    expect(store.listIntegrityFailures()).toMatchObject([{ id: 'release-current', reason: 'duplicate-release-id' }])
  })

  it('retains integrity evidence if final sidecar cleanup fails and reconciles on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-health-sidecar-failure-'))
    await writeFile(join(directory, 'workflow-releases.json'), JSON.stringify([createRelease({ contentSha256: '0'.repeat(64) })]))
    const store = new WorkflowReleaseStore(directory, { now: () => NOW })
    await store.initialize()
    const persistence = store as unknown as { persistIntegrityFailures(...args: unknown[]): Promise<void> }
    const originalPersist = persistence.persistIntegrityFailures.bind(store)
    vi.spyOn(persistence, 'persistIntegrityFailures').mockImplementationOnce(originalPersist)
      .mockRejectedValueOnce(new Error('sidecar ENOSPC'))
    await expect(store.publish(createRelease({ id: 'release-replacement' }))).rejects.toThrow('sidecar ENOSPC')
    expect(store.listIntegrityFailures()).toHaveLength(1)
    const recovered = new WorkflowReleaseStore(directory)
    await recovered.initialize()
    expect(recovered.listIntegrityFailures()).toEqual([])
    expect(recovered.get('release-replacement')).toMatchObject({ status: 'published', activation: { kind: 'publish', at: NOW } })
  })
})
