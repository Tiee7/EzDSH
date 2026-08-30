import type { ProviderApiProtocol } from '../../shared/providers.js'
import type { WorkflowModelSelection } from '../../shared/workflow.js'

export interface WorkflowModelProfile {
  providerId: string
  modelId: string
  api: ProviderApiProtocol
  baseUrl: string
  /** Main-process only. Never pass this value through IPC. */
  apiKey: string
}

export interface WorkflowLightweightRequest {
  prompt: string
  systemPrompt?: string
  outputMode: 'text' | 'json'
  model?: WorkflowModelSelection
  signal?: AbortSignal
}

export interface WorkflowLightweightClientOptions {
  resolveProfile: (selection?: WorkflowModelSelection) => Promise<WorkflowModelProfile>
  fetchImpl?: typeof fetch
}

/**
 * A stateless model path for lightweight workflow processing and generation.
 * It deliberately has no DSH session dependency and leaves no chat artifact.
 */
export class WorkflowLightweightClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: WorkflowLightweightClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async complete(request: WorkflowLightweightRequest): Promise<string> {
    const profile = await this.options.resolveProfile(request.model)
    switch (profile.api) {
      case 'anthropic-messages': return this.completeAnthropic(profile, request)
      case 'openai-responses': return this.completeOpenAiResponses(profile, request)
      case 'openai-completions': return this.completeOpenAiCompletions(profile, request)
    }
  }

  private async completeOpenAiCompletions(profile: WorkflowModelProfile, request: WorkflowLightweightRequest): Promise<string> {
    const messages = [
      ...(request.systemPrompt?.trim() ? [{ role: 'system', content: request.systemPrompt }] : []),
      { role: 'user', content: request.prompt },
    ]
    const payload = {
      model: profile.modelId,
      messages,
      temperature: 0.2,
      ...(request.outputMode === 'json' ? { response_format: { type: 'json_object' } } : {}),
    }
    const response = await this.request(profile, 'chat/completions', payload, request.signal)
    const content = asMap(asArray(response.choices)?.[0])
    const message = asMap(content?.message)
    return extractText(message?.content, 'OpenAI Chat Completions')
  }

  private async completeOpenAiResponses(profile: WorkflowModelProfile, request: WorkflowLightweightRequest): Promise<string> {
    const payload = {
      model: profile.modelId,
      ...(request.systemPrompt?.trim() ? { instructions: request.systemPrompt } : {}),
      input: request.prompt,
      ...(request.outputMode === 'json' ? { text: { format: { type: 'json_object' } } } : {}),
    }
    const response = await this.request(profile, 'responses', payload, request.signal)
    if (typeof response.output_text === 'string' && response.output_text.trim() !== '') return response.output_text
    for (const output of asArray(response.output) ?? []) {
      const content = asMap(output)
      for (const part of asArray(content?.content) ?? []) {
        const text = asMap(part)?.text
        if (typeof text === 'string' && text.trim() !== '') return text
      }
    }
    throw new Error('OpenAI Responses 未返回可用文本')
  }

  private async completeAnthropic(profile: WorkflowModelProfile, request: WorkflowLightweightRequest): Promise<string> {
    const payload = {
      model: profile.modelId,
      max_tokens: 4096,
      ...(request.systemPrompt?.trim() ? { system: request.systemPrompt } : {}),
      messages: [{ role: 'user', content: request.prompt }],
    }
    const response = await this.request(profile, 'messages', payload, request.signal, true)
    const texts = (asArray(response.content) ?? [])
      .map((part) => asMap(part))
      .filter((part): part is Record<string, unknown> => part !== undefined && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
    if (texts.length === 0) throw new Error('Anthropic Messages 未返回可用文本')
    return texts.join('\n')
  }

  private async request(
    profile: WorkflowModelProfile,
    path: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    anthropic = false,
  ): Promise<Record<string, unknown>> {
    const url = `${profile.baseUrl.replace(/\/+$/u, '')}/${path}`
    const headers: Record<string, string> = anthropic
      ? { 'content-type': 'application/json', 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', Authorization: `Bearer ${profile.apiKey}` }
    const response = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${String(response.status)}${text.trim() === '' ? '' : `：${text.slice(0, 500)}`}`)
    try {
      const parsed = JSON.parse(text) as unknown
      if (!isMap(parsed)) throw new Error('not an object')
      return parsed
    } catch {
      throw new Error('模型服务返回不是有效 JSON')
    }
  }
}

function extractText(value: unknown, source: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (Array.isArray(value)) {
    const text = value.map((part) => asMap(part)?.text).filter((part): part is string => typeof part === 'string').join('\n')
    if (text.trim() !== '') return text
  }
  throw new Error(`${source} 未返回可用文本`)
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  return isMap(value) ? value : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}
