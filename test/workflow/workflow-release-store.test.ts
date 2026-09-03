import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeWorkflowDefinitionSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import { WorkflowReleaseStore } from '../../src/main/workflow/workflow-release-store.js'
import { createDefaultWorkflow, type WorkflowDefinition } from '../../src/shared/workflow.js'
import type { WorkflowRelease } from '../../src/shared/workflow-operations.js'

function createWorkflowSnapshot(name = '发布快照'): WorkflowDefinition {
  const workflow = createDefaultWorkflow(name)
  workflow.permissionPolicy = { connectors: [{ connectorId: 'crm', operations: ['read'] }] }
  return workflow
}

function createRelease(id: string, overrides: Partial<WorkflowRelease> = {}): WorkflowRelease {
  const workflowSnapshot = overrides.workflowSnapshot ?? createWorkflowSnapshot()
  const contentSha256 = overrides.contentSha256 ?? computeWorkflowDefinitionSha256(workflowSnapshot)
  return {
    id,
    environmentId: 'customer-acme-prod',
    workflowId: workflowSnapshot.id,
    workflowRevision: workflowSnapshot.revision,
    contentSha256,
    workflowSnapshot,
    status: 'published',
    connectorGrants: [{ connectorId: 'crm', operations: ['read'] }],
    createdAt: '2026-09-03T00:00:00.000Z',
    publishedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}

describe('WorkflowReleaseStore', () => {
  it('persists verified releases across restart with restrictive permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-'))
    await chmod(dir, 0o755)
    const store = new WorkflowReleaseStore(dir, { now: () => '2026-09-03T09:00:00.000Z' })
    const saved = await store.publish(createRelease('release-1', { unexpectedSecret: 'private' } as Partial<WorkflowRelease>))

    expect(saved).toMatchObject({
      id: 'release-1',
      status: 'published',
      createdAt: '2026-09-03T09:00:00.000Z',
      publishedAt: '2026-09-03T09:00:00.000Z',
    })
    expect(await readFile(join(dir, 'workflow-releases.json'), 'utf8')).not.toContain('unexpectedSecret')
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'workflow-releases.json'))).mode & 0o777).toBe(0o600)

    const reloaded = new WorkflowReleaseStore(dir)
    await reloaded.initialize()
    expect(reloaded.get('release-1')).toEqual(saved)
  })

  it('returns clones and skips invalid persisted release records on startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-invalid-'))
    const valid = createRelease('release-valid')
    await writeFile(join(dir, 'workflow-releases.json'), JSON.stringify([
      valid,
      { ...createRelease('release-bad-digest'), contentSha256: 'b'.repeat(64) },
      { id: 'release-incomplete' },
    ]))

    const store = new WorkflowReleaseStore(dir)
    await store.initialize()

    const loaded = store.get('release-valid')!
    loaded.workflowSnapshot.name = '已篡改'
    expect(store.get('release-valid')?.workflowSnapshot.name).toBe(valid.workflowSnapshot.name)
    expect(store.list().map((release) => release.id)).toEqual(['release-valid'])
  })

  it('rejects digest mismatches and static HTTP headers during publish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-reject-'))
    const store = new WorkflowReleaseStore(dir)
    await expect(store.publish(createRelease('release-bad-digest', { contentSha256: 'b'.repeat(64) }))).rejects.toThrow(/integrity|release/i)

    const workflowSnapshot = createWorkflowSnapshot('带头部')
    workflowSnapshot.nodes.push({
      id: 'request',
      type: 'http',
      label: '请求',
      position: { x: 200, y: 0 },
      config: { method: 'GET', url: 'https://api.example.com/orders', headers: { Authorization: 'Bearer secret' }, responseMode: 'json' },
    })
    await expect(store.publish(createRelease('release-static-header', {
      workflowSnapshot,
      workflowId: workflowSnapshot.id,
      workflowRevision: workflowSnapshot.revision,
      contentSha256: 'a'.repeat(64),
    }))).rejects.toThrow(/header|release/i)
  })

  it('rejects non-published inputs and duplicate release ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-invalid-status-'))
    const store = new WorkflowReleaseStore(dir, { now: () => '2026-09-03T09:00:00.000Z' })

    await expect(store.publish(createRelease('release-superseded', { status: 'superseded' }))).rejects.toThrow(/published|release/i)
    await expect(store.publish(createRelease('release-rolled-back', { status: 'rolled-back' }))).rejects.toThrow(/published|release/i)

    await store.publish(createRelease('release-1'))
    await expect(store.publish(createRelease('release-1'))).rejects.toThrow(/duplicate|exists|release/i)
  })

  it('overrides input timestamps with the store clock during publish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-time-'))
    const store = new WorkflowReleaseStore(dir, { now: () => '2026-09-03T10:15:00.000Z' })
    const saved = await store.publish(createRelease('release-time', {
      createdAt: '2020-01-01T00:00:00.000Z',
      publishedAt: '2020-01-01T00:00:00.000Z',
    }))

    expect(saved.createdAt).toBe('2026-09-03T10:15:00.000Z')
    expect(saved.publishedAt).toBe('2026-09-03T10:15:00.000Z')
    expect(store.get('release-time')?.createdAt).toBe('2026-09-03T10:15:00.000Z')
    expect(store.get('release-time')?.publishedAt).toBe('2026-09-03T10:15:00.000Z')
  })

  it('supersedes the active release for one workflow and environment atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-supersede-'))
    const store = new WorkflowReleaseStore(dir)
    const workflowSnapshot = createWorkflowSnapshot('同一工作流')
    const first = await store.publish(createRelease('release-1', { workflowSnapshot, workflowId: workflowSnapshot.id, workflowRevision: workflowSnapshot.revision }))
    const second = await store.publish(createRelease('release-2', { workflowSnapshot, workflowId: workflowSnapshot.id, workflowRevision: workflowSnapshot.revision }))

    expect(store.get(first.id)?.status).toBe('superseded')
    expect(store.get(second.id)?.status).toBe('published')
    expect(store.list().map((release) => release.id)).toEqual(['release-2', 'release-1'])
  })

  it('rolls back to a superseded release without deleting history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-rollback-'))
    const store = new WorkflowReleaseStore(dir)
    const workflowSnapshot = createWorkflowSnapshot('回滚工作流')
    await store.publish(createRelease('release-1', { workflowSnapshot, workflowId: workflowSnapshot.id, workflowRevision: workflowSnapshot.revision }))
    await store.publish(createRelease('release-2', { workflowSnapshot, workflowId: workflowSnapshot.id, workflowRevision: workflowSnapshot.revision }))

    const restored = await store.rollback('release-1')
    expect(restored.status).toBe('published')
    expect(store.get('release-1')?.status).toBe('published')
    expect(store.get('release-2')?.status).toBe('rolled-back')
    expect(store.list().map((release) => `${release.id}:${release.status}`)).toEqual([
      'release-1:published',
      'release-2:rolled-back',
    ])
  })

  it('serializes concurrent publish calls so no release is lost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-releases-concurrent-'))
    const store = new WorkflowReleaseStore(dir)
    const workflowSnapshot = createWorkflowSnapshot('并发工作流')

    await Promise.all([
      store.publish(createRelease('release-1', { workflowSnapshot, workflowId: workflowSnapshot.id, workflowRevision: workflowSnapshot.revision })),
      store.publish(createRelease('release-2', { workflowSnapshot, workflowId: workflowSnapshot.id, workflowRevision: workflowSnapshot.revision })),
    ])

    const releases = store.list()
    expect(releases).toHaveLength(2)
    expect(releases.map((release) => release.id).sort()).toEqual(['release-1', 'release-2'])
    expect(releases.filter((release) => release.status === 'published')).toHaveLength(1)
    expect(releases.filter((release) => release.status === 'superseded')).toHaveLength(1)
  })
})
