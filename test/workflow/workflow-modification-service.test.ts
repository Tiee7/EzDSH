import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultWorkflow, type WorkflowModifyResult } from '../../src/shared/workflow.js'
import { WorkflowModificationService } from '../../src/main/workflow/workflow-modification-service.js'
import { WorkflowModificationStore } from '../../src/main/workflow/workflow-modification-store.js'
import { WorkflowJsonParseError } from '../../src/main/workflow/dsh-workflow-adapter.js'

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
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ prompt: '拆分内容节点' }), expect.any(Function), expect.any(AbortSignal))
  })

  it('cancels an in-flight modification and keeps a durable user-terminated history record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-modification-cancel-'))
    const workflow = createDefaultWorkflow('短视频选题')
    const modify = vi.fn(async (_request, _onProgress, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('模型请求已取消')
    })
    const service = new WorkflowModificationService({ store: new WorkflowModificationStore(dir), runService: { modify } as never })
    const modification = service.modify({ modificationId: 'modification-cancel', workflow, prompt: '停止这次修改' }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(modify).toHaveBeenCalled())

    const cancelled = await service.cancel('modification-cancel')

    expect(cancelled).toMatchObject({ status: 'cancelled', phase: 'cancelled', error: '用户终止了 AI 修改。' })
    expect(cancelled.events.at(-1)).toMatchObject({ phase: 'cancelled', status: 'cancelled', message: '用户终止了 AI 修改。' })
    expect((modify.mock.calls[0] as unknown[])[2]).toBeInstanceOf(AbortSignal)
    const modificationError = await modification
    expect(modificationError).toMatchObject({ message: '模型请求已取消' })
    await expect(service.get('modification-cancel')).resolves.toMatchObject({ status: 'cancelled', prompt: '停止这次修改' })
    const restored = new WorkflowModificationService({ runService: { modify } as never, store: new WorkflowModificationStore(dir) })
    await expect(restored.get('modification-cancel')).resolves.toMatchObject({ status: 'cancelled', prompt: '停止这次修改' })
  })

  it('persists the absolute diagnostic log path when modification fails on model JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-modification-diagnostics-'))
    const workflow = createDefaultWorkflow('短视频选题')
    const rawModelOutput = "{ 'name': 'invalid' }"
    const service = new WorkflowModificationService({
      stateDir: dir,
      runService: {
        modify: vi.fn(async () => {
          throw new WorkflowJsonParseError('Expected double-quoted property name in JSON at position 3753', rawModelOutput, 'embedded-document')
        }),
      } as never,
    })

    await expect(service.modify({ modificationId: 'modification-diagnostics', workflow, prompt: '修改这个工作流' })).rejects.toThrow(/详细错误日志：/u)

    const record = await service.get('modification-diagnostics')
    expect(record?.diagnosticLogPath).toBeDefined()
    expect(isAbsolute(record?.diagnosticLogPath ?? '')).toBe(true)
    expect(record?.error).toContain(record?.diagnosticLogPath ?? '')
    const diagnostic = await readFile(record?.diagnosticLogPath ?? '', 'utf8')
    expect(diagnostic).toContain('model-output')
    expect(diagnostic).toContain(rawModelOutput)
  })
})
