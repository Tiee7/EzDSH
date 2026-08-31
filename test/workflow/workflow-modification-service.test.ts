import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultWorkflow, type WorkflowModifyResult } from '../../src/shared/workflow.js'
import { WorkflowModificationService } from '../../src/main/workflow/workflow-modification-service.js'
import { WorkflowModificationStore } from '../../src/main/workflow/workflow-modification-store.js'

describe('WorkflowModificationService', () => {
  it('persists modification progress, results, and deletion metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-modification-history-'))
    const workflow = createDefaultWorkflow('短视频选题')
    const result: WorkflowModifyResult = {
      workflow: { ...workflow, name: '拆分后的短视频选题' },
      changes: [{ type: 'updated', targetId: workflow.nodes[1]?.id, targetLabel: workflow.nodes[1]?.label, details: '更新节点。' }],
      removedNodes: [],
    }
    const modify = vi.fn(async (_request, onProgress) => {
      await onProgress?.({ phase: 'analyzing', message: '正在分析。' })
      await onProgress?.({ phase: 'generating', message: '正在生成。' })
      return result
    })
    const service = new WorkflowModificationService({ store: new WorkflowModificationStore(dir), runService: { modify } as never })
    const updates: string[] = []
    service.watch((record) => updates.push(record.events.at(-1)?.message ?? ''))

    await expect(service.modify({ modificationId: 'modification-test', workflow, prompt: '拆分内容节点' })).resolves.toEqual(result)

    const record = await service.get('modification-test')
    expect(record).toMatchObject({ status: 'completed', workflow: result.workflow, changes: result.changes, removedNodes: [] })
    expect(record?.events.map((event) => event.phase)).toEqual(['preparing', 'analyzing', 'generating', 'completed'])
    expect(updates).toContain('正在生成。')
    const restored = new WorkflowModificationService({ store: new WorkflowModificationStore(dir), runService: { modify } as never })
    await expect(restored.list(workflow.id)).resolves.toHaveLength(1)
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ prompt: '拆分内容节点' }), expect.any(Function))
  })
})
