import { describe, expect, it, vi } from 'vitest'
import { WorkflowRuntimeClient } from '../../src/main/workflow/workflow-runtime-client.js'

describe('WorkflowRuntimeClient', () => {
  it('runs plugin-owned models through an isolated Runtime session', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'workflow-runtime-session' }))
    const selectSessionModel = vi.fn(async () => ({
      selected: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
    }))
    const sendPrompt = vi.fn(async () => ({ text: 'Codex 完成' }))
    const archiveSession = vi.fn(async () => undefined)
    const client = new WorkflowRuntimeClient({
      cwd: '/workspace',
      createClient: () => ({ createSession, selectSessionModel, sendPrompt, archiveSession }),
    })

    await expect(client.complete({
      systemPrompt: '只输出结果',
      prompt: '执行任务',
      outputMode: 'text',
      model: { providerId: 'openai-codex', modelId: 'gpt-5.6-luna' },
    })).resolves.toBe('Codex 完成')

    expect(createSession).toHaveBeenCalledWith({ cwd: '/workspace' })
    expect(selectSessionModel).toHaveBeenCalledWith('workflow-runtime-session', {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
    })
    expect(sendPrompt).toHaveBeenCalledWith('workflow-runtime-session', expect.stringContaining('只输出结果'))
    expect(sendPrompt).toHaveBeenCalledWith('workflow-runtime-session', expect.stringContaining('执行任务'))
    expect(archiveSession).toHaveBeenCalledWith('workflow-runtime-session')
  })

  it('rejects promptly and cancels the Runtime session when the signal is aborted', async () => {
    let resolvePrompt!: (result: { text: string }) => void
    const createSession = vi.fn(async () => ({ sessionId: 'workflow-runtime-session' }))
    const sendPrompt = vi.fn(() => new Promise<{ text: string }>((resolve) => { resolvePrompt = resolve }))
    const cancelSession = vi.fn(async () => undefined)
    const archiveSession = vi.fn(async () => undefined)
    const client = new WorkflowRuntimeClient({
      cwd: '/workspace',
      createClient: () => ({ createSession, selectSessionModel: vi.fn(async () => undefined), sendPrompt, cancelSession, archiveSession }),
    })
    const controller = new AbortController()
    const completion = client.complete({ prompt: '执行任务', outputMode: 'text', signal: controller.signal })

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalled())
    controller.abort()

    const outcome = await Promise.race([
      completion.then(() => 'completed', () => 'rejected'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(outcome).toBe('rejected')
    expect(cancelSession).toHaveBeenCalledWith('workflow-runtime-session')
    expect(archiveSession).toHaveBeenCalledWith('workflow-runtime-session')
    resolvePrompt({ text: 'late response' })
  })

  it('reopens a persisted session for a continuation without creating or archiving another session', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'new-session' }))
    const selectSessionModel = vi.fn(async () => undefined)
    const sendPrompt = vi.fn(async () => ({ text: '续接完成' }))
    const archiveSession = vi.fn(async () => undefined)
    const client = new WorkflowRuntimeClient({
      cwd: '/workspace',
      createClient: () => ({ createSession, selectSessionModel, sendPrompt, archiveSession }),
    })

    const continuation = await client.resumeSession('persisted-session', { providerId: 'openai-codex', modelId: 'gpt-5.6-luna' })
    await expect(continuation.complete({ prompt: '修复上一次输出', outputMode: 'json' })).resolves.toBe('续接完成')

    expect(createSession).not.toHaveBeenCalled()
    expect(selectSessionModel).toHaveBeenCalledWith('persisted-session', { provider: 'openai-codex', model: 'gpt-5.6-luna' })
    expect(sendPrompt).toHaveBeenCalledWith('persisted-session', expect.stringContaining('修复上一次输出'))
    expect(archiveSession).not.toHaveBeenCalled()
    await continuation.archive()
    expect(archiveSession).toHaveBeenCalledWith('persisted-session')
  })
})
