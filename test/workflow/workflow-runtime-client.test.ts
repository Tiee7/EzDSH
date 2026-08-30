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
})
