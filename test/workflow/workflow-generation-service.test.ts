import { mkdtemp, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowGenerationService } from '../../src/main/workflow/workflow-generation-service.js'
import { WorkflowGenerationStore } from '../../src/main/workflow/workflow-generation-store.js'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import { WorkflowJsonParseError } from '../../src/main/workflow/dsh-workflow-adapter.js'
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
      workflowRoot: dir,
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
    expect(result.workflow.generationPrompt).toBe('生成短视频选题工作流')
    expect(record).toMatchObject({ id: 'generation-test', status: 'completed', phase: 'completed', model: { providerId: 'provider-a', modelId: 'model-a' }, workflow: { name: '短视频选题' } })
    expect(record?.events.map((event) => event.phase)).toEqual(expect.arrayContaining(['preparing', 'planning-employees', 'creating-employees', 'generating-workflow', 'validating', 'completed']))
    expect(updates.some((update) => update === 'generating-workflow:running')).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls.every(([request]) => request.model?.providerId === 'provider-a' && request.model?.modelId === 'model-a')).toBe(true)

    const restored = new WorkflowGenerationService({ runService, store: new WorkflowGenerationStore(dir) })
    await expect(restored.list()).resolves.toEqual([record])
  })

  it('cancels an in-flight generation and keeps a durable user-terminated history record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-cancel-'))
    const runService = {
      generate: vi.fn(async (_request, _onProgress, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
        throw new Error('模型请求已取消')
      }),
    }
    const service = new WorkflowGenerationService({ store: new WorkflowGenerationStore(dir), runService: runService as never })
    const generation = service.generate({ generationId: 'generation-cancel', prompt: '生成一个可取消的工作流' }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(runService.generate).toHaveBeenCalled())

    const cancelled = await service.cancel('generation-cancel')

    expect(cancelled).toMatchObject({ status: 'cancelled', phase: 'cancelled', error: '用户终止了工作流生成。' })
    expect(cancelled.events.at(-1)).toMatchObject({ phase: 'cancelled', status: 'cancelled', message: '用户终止了工作流生成。' })
    expect((runService.generate.mock.calls[0] as unknown[])[2]).toBeInstanceOf(AbortSignal)
    const generationError = await generation
    expect(generationError).toMatchObject({ message: '模型请求已取消' })
    await expect(service.get('generation-cancel')).resolves.toMatchObject({ status: 'cancelled', prompt: '生成一个可取消的工作流' })
    const restored = new WorkflowGenerationService({ runService: runService as never, store: new WorkflowGenerationStore(dir) })
    await expect(restored.get('generation-cancel')).resolves.toMatchObject({ status: 'cancelled', prompt: '生成一个可取消的工作流' })
  })

  it('resumes a failed generation from its durable checkpoint and keeps the generation session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-resume-'))
    const workflow = createDefaultWorkflow('恢复后的工作流')
    const checkpoint = {
      phase: 'generating-workflow' as const,
      createdEmployees: [],
      warnings: [],
      sessionId: 'generation-session-1',
      lastModelOutput: '{"nodes":',
    }
    const store = new WorkflowGenerationStore(dir)
    await store.save({
      id: 'generation-resume',
      prompt: '生成一个可恢复的工作流',
      name: '可恢复工作流',
      status: 'failed',
      phase: 'failed',
      createEmployees: false,
      events: [{ phase: 'failed', status: 'failed', message: 'AI 返回的 Workflow 不是有效 JSON', time: '2026-08-31T10:00:03.000Z' }],
      workflow: undefined,
      createdEmployees: [],
      startedAt: '2026-08-31T10:00:00.000Z',
      completedAt: '2026-08-31T10:00:03.000Z',
      error: 'AI 返回的 Workflow 不是有效 JSON',
      checkpoint,
    })
    const generate = vi.fn(async (_request, _onProgress, _signal, options) => {
      expect(options.checkpoint).toEqual(checkpoint)
      return { workflow, createdEmployees: [] }
    })
    const service = new WorkflowGenerationService({ store, runService: { generate } as never })

    const queued = await service.resume('generation-resume')

    expect(queued).toMatchObject({ id: 'generation-resume', status: 'running', checkpoint })
    await vi.waitFor(async () => expect((await service.get('generation-resume'))).toMatchObject({ status: 'completed', workflow: { name: '恢复后的工作流' }, checkpoint }))
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: 'generation-resume', prompt: '生成一个可恢复的工作流', createEmployees: false }),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.objectContaining({ checkpoint, resumeMessage: 'AI 返回的 Workflow 不是有效 JSON' }),
    )
  })

  it('uses the persisted generation session for the resumed workflow request and archives it only after success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-session-'))
    const workflowStore = new WorkflowStore(dir)
    const session = {
      sessionId: 'generation-session-1',
      complete: vi.fn(async () => JSON.stringify(createDefaultWorkflow('续接草稿'))),
      cancel: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    }
    const createGenerationSession = vi.fn(async () => session)
    const lightweightComplete = vi.fn(async () => { throw new Error('不应创建新的轻量请求') })
    const runService = new WorkflowRunService({
      workflowStore,
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      lightweightClient: { complete: lightweightComplete },
      createGenerationSession,
    })
    const checkpoints: string[] = []
    const result = await runService.generate(
      { generationId: 'generation-session', prompt: '续接一个工作流', name: '续接草稿', model: { providerId: 'provider-a', modelId: 'model-a' } },
      undefined,
      undefined,
      {
        checkpoint: { phase: 'generating-workflow', createdEmployees: [], warnings: [], sessionId: 'generation-session-1' },
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint.phase),
        resumeMessage: 'AI 返回的 Workflow 不是有效 JSON',
      },
    )

    expect(result.workflow.name).toBe('续接草稿')
    expect(createGenerationSession).toHaveBeenCalledWith({ sessionId: 'generation-session-1', model: { providerId: 'provider-a', modelId: 'model-a' } })
    expect(session.complete).toHaveBeenCalledTimes(1)
    expect(session.complete).toHaveBeenCalledWith(expect.objectContaining({ outputMode: 'json' }))
    expect(session.complete.mock.calls[0]?.[0].prompt).toContain('这是一次从断点继续的生成')
    expect(lightweightComplete).not.toHaveBeenCalled()
    expect(session.archive).toHaveBeenCalledTimes(1)
    expect(checkpoints).toContain('validating')
  })

  it('keeps an interrupted session resumable after a model response cannot be parsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-session-failure-'))
    const session = {
      sessionId: 'generation-session-failure',
      complete: vi.fn(async () => 'not-json'),
      cancel: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
    }
    const runService = new WorkflowRunService({
      workflowStore: new WorkflowStore(dir),
      runStore: new WorkflowRunStore(dir),
      workflowRoot: dir,
      createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
      resolveEmployee: () => undefined,
      createGenerationSession: async () => session,
    })

    await expect(runService.generate({ prompt: '生成一个会失败的工作流' }, undefined, undefined, {
      onCheckpoint: vi.fn(),
    })).rejects.toThrow('AI 返回的 Workflow 不是有效 JSON')

    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(session.archive).not.toHaveBeenCalled()
  })

  it('persists the absolute diagnostic log path when generation fails on model JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-diagnostics-'))
    const rawModelOutput = "{ 'name': 'invalid' }"
    const service = new WorkflowGenerationService({
      stateDir: dir,
      runService: {
        generate: vi.fn(async () => {
          throw new WorkflowJsonParseError('Expected double-quoted property name in JSON at position 3753', rawModelOutput, 'embedded-document')
        }),
      } as never,
    })

    await expect(service.generate({ generationId: 'generation-diagnostics', prompt: '生成一个工作流' })).rejects.toThrow(/详细错误日志：/u)

    const record = await service.get('generation-diagnostics')
    expect(record?.diagnosticLogPath).toBeDefined()
    expect(isAbsolute(record?.diagnosticLogPath ?? '')).toBe(true)
    expect(record?.error).toContain(record?.diagnosticLogPath ?? '')
    const diagnostic = await readFile(record?.diagnosticLogPath ?? '', 'utf8')
    expect(diagnostic).toContain('model-output')
    expect(diagnostic).toContain(rawModelOutput)
  })

  it('turns a generation left running by an app restart into a resumable failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-generation-restart-'))
    const store = new WorkflowGenerationStore(dir)
    await store.save({
      id: 'generation-restart',
      prompt: '重启后继续这个工作流',
      name: '重启恢复',
      status: 'running',
      phase: 'generating-workflow',
      events: [{ phase: 'generating-workflow', status: 'running', message: '正在生成工作流结构。', time: '2026-08-31T10:00:00.000Z' }],
      createdEmployees: [],
      startedAt: '2026-08-31T10:00:00.000Z',
      checkpoint: { phase: 'generating-workflow', createdEmployees: [], warnings: [], sessionId: 'generation-session-restart' },
    })

    const restarted = new WorkflowGenerationService({ stateDir: dir, store, runService: { generate: vi.fn() } as never })

    await restarted.initialize()

    await expect(restarted.get('generation-restart')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('应用重启导致生成任务中断，可从断点继续。'),
      checkpoint: { phase: 'generating-workflow', sessionId: 'generation-session-restart' },
    })
    const restartedRecord = await restarted.get('generation-restart')
    expect(restartedRecord?.diagnosticLogPath).toBeDefined()
    expect(isAbsolute(restartedRecord?.diagnosticLogPath ?? '')).toBe(true)
  })
})
