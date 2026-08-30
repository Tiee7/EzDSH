import type { WorkflowModelSelection } from '../../shared/workflow.js'
import type { WorkflowLightweightRequest } from './workflow-lightweight-client.js'

export interface WorkflowRuntimeSessionClient {
  createSession(params: { cwd: string }): Promise<{ sessionId: string }>
  selectSessionModel(sessionId: string, selection: { provider: string; model: string }): Promise<unknown>
  sendPrompt(sessionId: string, text: string): Promise<{ text: string }>
  cancelSession?(sessionId: string): Promise<void>
  archiveSession?(sessionId: string): Promise<unknown>
}

export interface WorkflowRuntimeClientOptions {
  cwd: string
  createClient: () => WorkflowRuntimeSessionClient
}

/** Executes lightweight workflow prompts through the Runtime's registered adapters. */
export class WorkflowRuntimeClient {
  constructor(private readonly options: WorkflowRuntimeClientOptions) {}

  async complete(request: WorkflowLightweightRequest): Promise<string> {
    if (request.signal?.aborted === true) throw abortError()
    const client = this.options.createClient()
    const { sessionId } = await client.createSession({ cwd: this.options.cwd })
    const cancel = (): void => { void client.cancelSession?.(sessionId) }
    request.signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (request.model !== undefined) await this.selectModel(client, sessionId, request.model)
      const result = await client.sendPrompt(sessionId, runtimePrompt(request))
      return result.text
    } finally {
      request.signal?.removeEventListener('abort', cancel)
      await client.archiveSession?.(sessionId)
    }
  }

  private async selectModel(client: WorkflowRuntimeSessionClient, sessionId: string, model: WorkflowModelSelection): Promise<void> {
    await client.selectSessionModel(sessionId, { provider: model.providerId, model: model.modelId })
  }
}

function runtimePrompt(request: WorkflowLightweightRequest): string {
  return [
    request.systemPrompt?.trim() === '' || request.systemPrompt === undefined
      ? ''
      : `系统指令：\n${request.systemPrompt.trim()}`,
    request.outputMode === 'json'
      ? '输出要求：只输出一个有效 JSON 文档，不要解释，不要使用 Markdown 代码围栏。'
      : '',
    request.prompt,
  ].filter(Boolean).join('\n\n')
}

function abortError(): Error {
  const error = new Error('Workflow model request was cancelled')
  error.name = 'AbortError'
  return error
}
