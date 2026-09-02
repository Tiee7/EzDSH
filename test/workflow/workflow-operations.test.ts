import { describe, expect, it } from 'vitest'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'
import { computeWorkflowDefinitionSha256, verifyWorkflowReleaseIntegrity } from '../../src/main/workflow/workflow-release-integrity.js'
import { deriveEnvironmentConnectorGrants, normalizeWorkflowCustomerEnvironment, normalizeWorkflowRelease, workflowReleaseSummary } from '../../src/shared/workflow-operations.js'

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
