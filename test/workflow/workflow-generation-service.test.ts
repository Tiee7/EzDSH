import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowGenerationService } from '../../src/main/workflow/workflow-generation-service.js'
import { WorkflowGenerationStore } from '../../src/main/workflow/workflow-generation-store.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'

describe('workflow generation service', () => {
  it('persists a fixed generation pipeline and streams progress while using the selected model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-service-'))
    const workflowStore = new WorkflowStore(dir)
    const complete = vi.fn()
      .mockResolvedValueOnce('{"employees":[]}')
      .mockResolvedValueOnce(JSON.stringify(createDefaultWorkflow('生成草稿')))
    const runService = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workspaceRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      listEmployees: () => [],
      createEmployee: async () => { throw new Error('not expected') },
      lightweightClient: {
        complete,
      },
    })
    const service = new WorkflowGenerationService({ runService, store: new WorkflowGenerationStore(dir) })
    const updates: string[] = []
    service.watch((record) => updates.push(`${record.phase}:${record.status}`))

    const result = await service.generate({ generationId: 'generation-test', prompt: '生成短视频选题工作流', name: '短视频选题', model: { providerId: 'provider-a', modelId: 'model-a' } })
    const record = await service.get('generation-test')

    expect(result.workflow.name).toBe('短视频选题')
    expect(record).toMatchObject({ id: 'generation-test', status: 'completed', phase: 'completed', model: { providerId: 'provider-a', modelId: 'model-a' }, workflow: { name: '短视频选题' } })
    expect(record?.events.map((event) => event.phase)).toEqual(expect.arrayContaining(['preparing', 'planning-employees', 'creating-employees', 'generating-workflow', 'validating', 'completed']))
    expect(updates.some((update) => update === 'generating-workflow:running')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls.every(([request]) => request.model?.providerId === 'provider-a' && request.model?.modelId === 'model-a')).toBe(true)

    const restored = new WorkflowGenerationService({ runService, store: new WorkflowGenerationStore(dir) })
    await expect(restored.list()).resolves.toEqual([record])
  })
})
