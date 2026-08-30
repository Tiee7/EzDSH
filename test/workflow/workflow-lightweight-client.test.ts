import { describe, expect, it, vi } from 'vitest'
import { WorkflowLightweightClient, type WorkflowModelProfile } from '../../src/main/workflow/workflow-lightweight-client.js'

const openAiProfile: WorkflowModelProfile = {
  providerId: 'test-openai', modelId: 'gpt-test', api: 'openai-completions', baseUrl: 'https://models.example/v1', apiKey: 'secret',
}

describe('WorkflowLightweightClient', () => {
  it('calls an OpenAI-compatible model directly without creating a DSH session', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://models.example/v1/chat/completions')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' })
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-test', response_format: { type: 'json_object' } })
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 })
    })
    const client = new WorkflowLightweightClient({ resolveProfile: async () => openAiProfile, fetchImpl })

    await expect(client.complete({ prompt: 'summarize', systemPrompt: 'be concise', outputMode: 'json' })).resolves.toBe('{"ok":true}')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('uses Anthropic headers and extracts text blocks', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' })
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '完成' }] }), { status: 200 })
    })
    const client = new WorkflowLightweightClient({
      resolveProfile: async () => ({ ...openAiProfile, api: 'anthropic-messages', baseUrl: 'https://anthropic.example' }),
      fetchImpl,
    })

    await expect(client.complete({ prompt: 'do work', outputMode: 'text' })).resolves.toBe('完成')
  })

  it('returns actionable errors when the provider rejects a request', async () => {
    const client = new WorkflowLightweightClient({
      resolveProfile: async () => openAiProfile,
      fetchImpl: async () => new Response('invalid key', { status: 401, statusText: 'Unauthorized' }),
    })

    await expect(client.complete({ prompt: 'x', outputMode: 'text' })).rejects.toThrow('HTTP 401')
  })

  it('passes a run-level model selection to profile resolution and the request payload', async () => {
    const selection = { providerId: 'test-openai', modelId: 'gpt-selected' }
    const resolveProfile = vi.fn(async (requested?: typeof selection) => ({
      ...openAiProfile,
      modelId: requested?.modelId ?? openAiProfile.modelId,
    }))
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-selected' })
      return new Response(JSON.stringify({ choices: [{ message: { content: '完成' } }] }), { status: 200 })
    })
    const client = new WorkflowLightweightClient({ resolveProfile, fetchImpl })

    await expect(client.complete({ prompt: 'do work', outputMode: 'text', model: selection })).resolves.toBe('完成')
    expect(resolveProfile).toHaveBeenCalledWith(selection)
  })

  it('uses the Runtime adapter for the configured default and plugin-owned models', async () => {
    const runtimeComplete = vi.fn(async () => 'Codex 完成')
    const resolveProfile = vi.fn(async () => openAiProfile)
    const client = new WorkflowLightweightClient({ resolveProfile, completeWithRuntime: runtimeComplete })

    await expect(client.complete({ prompt: 'default', outputMode: 'text' })).resolves.toBe('Codex 完成')
    await expect(client.complete({
      prompt: 'selected',
      outputMode: 'text',
      model: { providerId: 'openai-codex', modelId: 'gpt-5.6-luna' },
    })).resolves.toBe('Codex 完成')
    expect(runtimeComplete).toHaveBeenCalledTimes(2)
    expect(resolveProfile).not.toHaveBeenCalled()
  })
})
