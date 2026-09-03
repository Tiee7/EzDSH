import { describe, expect, it } from 'vitest'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'
import { computeWorkflowDefinitionSha256, computeWorkflowReleaseSha256, verifyWorkflowReleaseIntegrity } from '../../src/main/workflow/workflow-release-integrity.js'
import { deriveEnvironmentConnectorGrants, normalizeWorkflowCustomerEnvironment, normalizeWorkflowObservationEvent, normalizeWorkflowRelease, workflowReleaseSummary } from '../../src/shared/workflow-operations.js'

describe('workflow operations contracts', () => {
  it('rejects production shell capability while accepting a valid environment', () => {
    const common = {
      id: 'customer-acme-prod', customerName: 'Acme', name: '生产', kind: 'production',
      status: 'active', connectorIds: ['crm', 'crm'], allowCode: false,
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    }
    expect(normalizeWorkflowCustomerEnvironment({ ...common, allowShellFile: true })).toBeUndefined()
    expect(normalizeWorkflowCustomerEnvironment({ ...common, allowShellFile: false, allowCode: true })).toBeUndefined()
    expect(normalizeWorkflowCustomerEnvironment({ ...common, allowShellFile: false })?.connectorIds).toEqual(['crm'])
  })

  it('keeps a validated release digest in its snapshot-free summary', () => {
    const workflowSnapshot = createDefaultWorkflow('发布快照')
    workflowSnapshot.permissionPolicy = { connectors: [{ connectorId: 'crm', operations: ['read'] }] }
    const raw = {
      id: 'release-acme-1', environmentId: 'customer-acme-prod', workflowId: workflowSnapshot.id,
      workflowRevision: workflowSnapshot.revision, workflowSnapshot,
      contentSha256: 'a'.repeat(64), status: 'published', connectorGrants: [{ connectorId: 'crm', operations: ['read'] }],
      createdAt: '2026-09-03T00:00:00.000Z', publishedAt: '2026-09-03T00:00:00.000Z',
    }
    const release = normalizeWorkflowRelease(raw)
    expect(release).toMatchObject({ contentSha256: raw.contentSha256, status: 'published' })
    raw.workflowSnapshot.name = '已篡改'
    expect(release?.workflowSnapshot.name).toBe('发布快照')
    expect(workflowReleaseSummary(release!)).toEqual({
      id: raw.id, environmentId: raw.environmentId, workflowId: raw.workflowId, workflowRevision: raw.workflowRevision,
      contentSha256: raw.contentSha256, status: 'published', createdAt: raw.createdAt, publishedAt: raw.publishedAt,
    })
    expect(normalizeWorkflowRelease({ ...raw, contentSha256: 'not-a-digest' })).toBeUndefined()
  })

  it('rejects release grants that exceed the snapshot connector policy', () => {
    const workflowSnapshot = createDefaultWorkflow('最小授权')
    workflowSnapshot.permissionPolicy = { connectors: [{ connectorId: 'crm', operations: ['read'] }] }
    expect(normalizeWorkflowRelease({
      id: 'release-acme-escalation', environmentId: 'customer-acme-prod', workflowId: workflowSnapshot.id,
      workflowRevision: workflowSnapshot.revision, workflowSnapshot, contentSha256: 'a'.repeat(64), status: 'published',
      connectorGrants: [{ connectorId: 'crm', operations: ['write'] }],
      createdAt: '2026-09-03T00:00:00.000Z', publishedAt: '2026-09-03T00:00:00.000Z',
    })).toBeUndefined()
  })

  it('rejects every static HTTP header from a release snapshot', () => {
    for (const [headerName, value] of Object.entries({ Authorization: 'Bearer secret', 'X-Custom-Auth': 'private' })) {
      const workflowSnapshot = createDefaultWorkflow('无秘密快照')
      workflowSnapshot.nodes.push({
        id: 'request', type: 'http', label: '请求', position: { x: 200, y: 0 },
        config: { method: 'GET', url: 'https://api.example.com/orders', headers: { [headerName]: value }, responseMode: 'json' },
      })
      const raw = {
        id: `release-acme-${headerName}`, environmentId: 'customer-acme-prod', workflowId: workflowSnapshot.id,
        workflowRevision: workflowSnapshot.revision, workflowSnapshot, contentSha256: 'a'.repeat(64), status: 'published', connectorGrants: [],
        createdAt: '2026-09-03T00:00:00.000Z', publishedAt: '2026-09-03T00:00:00.000Z',
      }
      expect(normalizeWorkflowRelease(raw)).toBeUndefined()
      expect(() => computeWorkflowDefinitionSha256(workflowSnapshot)).toThrow(/HTTP header/u)
    }
  })

  it('normalizes observations only from fixed metadata', () => {
    const event = {
      id: 'observation-run-1', environmentId: 'customer-acme-prod', releaseId: 'release-acme-1', runId: 'run-1', traceId: 'trace-1',
      time: '2026-09-03T00:00:00.000Z', kind: 'run', action: 'run-started', severity: 'info', outcome: 'started',
    }
    expect(normalizeWorkflowObservationEvent(event)).toEqual(event)
    expect(normalizeWorkflowObservationEvent({ ...event, action: 'customer prompt: secret' })).toBeUndefined()
    expect(normalizeWorkflowObservationEvent({ ...event, message: 'Authorization: secret body=private' })).toBeUndefined()
    expect(normalizeWorkflowObservationEvent({ ...event, payload: { prompt: 'private' } })).toBeUndefined()
  })

  it('verifies a canonical snapshot digest and rejects mutation or mismatch', () => {
    const workflowSnapshot = createDefaultWorkflow('完整性快照')
    const contentSha256 = computeWorkflowDefinitionSha256(workflowSnapshot)
    const release = normalizeWorkflowRelease({
      id: 'release-acme-integrity', environmentId: 'customer-acme-prod', workflowId: workflowSnapshot.id,
      workflowRevision: workflowSnapshot.revision, workflowSnapshot, contentSha256, status: 'published', connectorGrants: [],
      createdAt: '2026-09-03T00:00:00.000Z', publishedAt: '2026-09-03T00:00:00.000Z',
    })!
    expect(verifyWorkflowReleaseIntegrity(release)).toBe(true)
    expect(computeWorkflowDefinitionSha256(Object.fromEntries(Object.entries(workflowSnapshot).reverse()) as typeof workflowSnapshot)).toBe(contentSha256)
    expect(verifyWorkflowReleaseIntegrity({ ...release, contentSha256: 'b'.repeat(64) })).toBe(false)
    release.workflowSnapshot.name = '已篡改'
    expect(verifyWorkflowReleaseIntegrity(release)).toBe(false)
  })

  it('covers dependency snapshots in release integrity and normalization', () => {
    const workflowSnapshot = createDefaultWorkflow('父流程')
    workflowSnapshot.nodes = [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      { id: 'child', type: 'sub-workflow', label: 'Child', config: { workflowId: 'workflow-child', version: 3, waitForCompletion: true }, position: { x: 200, y: 0 } },
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
    ]
    workflowSnapshot.edges = [{ id: 'a', source: 'input', target: 'child' }, { id: 'b', source: 'child', target: 'output' }]
    workflowSnapshot.permissionPolicy = { connectors: [{ connectorId: 'crm', operations: ['read'] }] }
    const dependency = createDefaultWorkflow('子流程')
    dependency.id = 'workflow-child'
    dependency.revision = 3
    dependency.permissionPolicy = { connectors: [{ connectorId: 'billing', operations: ['write'] }] }
    const release = normalizeWorkflowRelease({
      id: 'release-acme-deps',
      environmentId: 'customer-acme-prod',
      workflowId: workflowSnapshot.id,
      workflowRevision: workflowSnapshot.revision,
      workflowSnapshot,
      workflowDependencies: [dependency],
      contentSha256: computeWorkflowReleaseSha256({
        workflowSnapshot,
        workflowDependencies: [dependency],
      }),
      status: 'published',
      connectorGrants: [{ connectorId: 'crm', operations: ['read'] }, { connectorId: 'billing', operations: ['write'] }],
      createdAt: '2026-09-03T00:00:00.000Z',
      publishedAt: '2026-09-03T00:00:00.000Z',
    })!
    expect(release.workflowDependencies).toHaveLength(1)
    expect(verifyWorkflowReleaseIntegrity(release)).toBe(true)
    dependency.name = '已篡改子流程'
    expect(release.workflowDependencies[0]?.name).toBe('子流程')
    release.workflowDependencies[0]!.name = '已篡改快照'
    expect(verifyWorkflowReleaseIntegrity(release)).toBe(false)
  })

  it('intersects workflow connector policy with the environment allowlist', () => {
    const workflow = createDefaultWorkflow('受限连接器')
    workflow.permissionPolicy = {
      connectors: [
        { connectorId: 'crm', operations: ['read', 'write'] },
        { connectorId: 'billing', operations: ['read'] },
      ],
    }
    const environment = normalizeWorkflowCustomerEnvironment({
      id: 'customer-acme-staging', customerName: 'Acme', name: '预发布', kind: 'staging', status: 'active',
      connectorIds: ['crm'], allowShellFile: true, allowCode: true,
      createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    })!
    expect(deriveEnvironmentConnectorGrants(workflow, environment)).toEqual([
      { connectorId: 'crm', operations: ['read', 'write'] },
    ])
  })
})
