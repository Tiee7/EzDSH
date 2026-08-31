import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefaultWorkflow, validateWorkflow } from '../../src/shared/workflow.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'

describe('workflow stores', () => {
  it('loads legacy Agent workflows as schema V2 AI tasks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-migration-'))
    await writeFile(join(dir, 'workflows.json'), JSON.stringify([{
      schemaVersion: 1,
      id: 'legacy-workflow',
      name: 'Legacy workflow',
      description: '',
      revision: 1,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      nodes: [{
        id: 'agent-1',
        type: 'agent',
        label: 'Agent',
        config: { instruction: '总结输入' },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    }]))

    const store = new WorkflowStore(dir)
    await store.initialize()

    const migrated = store.list()[0]
    expect(migrated).toMatchObject({
      schemaVersion: 2,
    })
    expect(migrated?.nodes.map((node) => ({ type: node.type, label: node.label }))).toEqual([
      { type: 'input', label: '开始' },
      { type: 'ai-task', label: '智能处理' },
      { type: 'output', label: '结束' },
    ])
    expect(migrated?.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['legacy-workflow-input', 'agent-1'],
      ['agent-1', 'legacy-workflow-output'],
    ])
    expect(validateWorkflow(migrated!)).toMatchObject({ valid: true })
  })

  it('persists definitions and remaps IDs when duplicating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-'))
    const store = new WorkflowStore(dir)
    const created = await store.create(createDefaultWorkflow('Persisted'))
    const copy = await store.duplicate(created.id)
    expect(copy.id).not.toBe(created.id)
    expect(copy.edges.every((edge) => copy.nodes.some((node) => node.id === edge.source) && copy.nodes.some((node) => node.id === edge.target))).toBe(true)
    expect(copy.nodes.flatMap((node) => node.inputBindings ?? []).every((binding) => copy.nodes.some((node) => node.id === binding.sourceNodeId))).toBe(true)
    const reloaded = new WorkflowStore(dir)
    await reloaded.initialize()
    expect(reloaded.list().map((workflow) => workflow.name)).toEqual(['Persisted copy', 'Persisted'])
    expect(JSON.parse(await readFile(join(dir, 'workflows.json'), 'utf8'))).toHaveLength(2)
  })

  it('turns interrupted runs into paused records on startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-runs-'))
    const record = {
      id: 'run-1', workflowId: 'workflow-1', workflowRevision: 1, status: 'running', input: 'hello',
      nodeStates: [{ nodeId: 'input', status: 'running' }], events: [], allowShellFile: false,
    }
    await writeFile(join(dir, 'workflow-runs.json'), JSON.stringify([record]))
    const store = new WorkflowRunStore(dir)
    await store.initialize()
    const paused = await store.pauseActiveRuns()
    expect(paused[0]?.status).toBe('paused')
    expect(store.get('run-1')?.error).toContain('暂停')
  })

  it('prunes only expired terminal runs and keeps active or unexpired history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-retention-'))
    const store = new WorkflowRunStore(dir)
    await store.initialize()
    const now = new Date('2026-08-30T00:00:00.000Z')
    await store.save({
      id: 'expired-completed', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: null,
      nodeStates: [], events: [], allowShellFile: false, completedAt: '2026-08-01T00:00:00.000Z', retentionExpiresAt: '2026-08-29T23:59:59.000Z',
    })
    await store.save({
      id: 'fresh-completed', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: null,
      nodeStates: [], events: [], allowShellFile: false, completedAt: '2026-08-29T00:00:00.000Z', retentionExpiresAt: '2026-08-31T00:00:00.000Z',
    })
    await store.save({
      id: 'active-with-old-expiry', workflowId: 'workflow-1', workflowRevision: 1, status: 'running', input: null,
      nodeStates: [], events: [], allowShellFile: false, retentionExpiresAt: '2026-08-01T00:00:00.000Z',
    })

    expect(await store.pruneExpired(now)).toEqual(['expired-completed'])
    expect(store.list().map((record) => record.id).sort()).toEqual(['active-with-old-expiry', 'fresh-completed'])
  })

  it('removes a run and persists the deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-run-delete-'))
    const store = new WorkflowRunStore(dir)
    await store.save({ id: 'run-delete', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: null, nodeStates: [], events: [], allowShellFile: false })

    expect(await store.remove('run-delete')).toBe(true)
    expect(store.get('run-delete')).toBeUndefined()
    const reloaded = new WorkflowRunStore(dir)
    await reloaded.initialize()
    expect(reloaded.get('run-delete')).toBeUndefined()
    expect(await store.remove('run-delete')).toBe(false)
  })
})
