import type { WorkflowModelSelection } from '../../shared/workflow.js'
import type { WorkflowLightweightRequest } from './workflow-lightweight-client.js'

export interface WorkflowRuntimeSessionClient {
  createSession(params: { cwd: string }): Promise<{ sessionId: string }>
  selectSessionModel(sessionId: string, selection: { provider: string; model: string }): Promise<unknown>
  sendPrompt(sessionId: string, text: string): Promise<{ text: string }>
  getSessionHistory?(sessionId: string): Promise<unknown>
  cancelSession?(sessionId: string): Promise<void>
  archiveSession?(sessionId: string): Promise<unknown>
}

export interface WorkflowRuntimeClientOptions {
  cwd: string
  createClient: () => WorkflowRuntimeSessionClient
}

export interface WorkflowRuntimeContinuationSession {
  readonly sessionId: string
  complete(request: WorkflowLightweightRequest): Promise<string>
  cancel(): Promise<void>
  archive(): Promise<void>
}

/** Executes lightweight workflow prompts through the Runtime's registered adapters. */
export class WorkflowRuntimeClient {
  constructor(private readonly options: WorkflowRuntimeClientOptions) {}

  async complete(request: WorkflowLightweightRequest): Promise<string> {
    const signal = request.signal
    if (signal?.aborted) throw abortError()
    const session = await this.createSession(request.model)
    try {
      return await session.complete(request)
    } finally {
      await session.archive()
    }
  }

  async createSession(model?: WorkflowModelSelection): Promise<WorkflowRuntimeContinuationSession> {
    const client = this.options.createClient()
    const { sessionId } = await client.createSession({ cwd: this.options.cwd })
    if (model !== undefined) await this.selectModel(client, sessionId, model)
    return this.createContinuationSession(client, sessionId)
  }

  async resumeSession(sessionId: string, model?: WorkflowModelSelection): Promise<WorkflowRuntimeContinuationSession> {
    if (sessionId.trim() === '') throw new Error('Workflow generation session ID is required')
    const client = this.options.createClient()
    await client.getSessionHistory?.(sessionId)
    if (model !== undefined) await this.selectModel(client, sessionId, model)
    return this.createContinuationSession(client, sessionId)
  }

  private createContinuationSession(client: WorkflowRuntimeSessionClient, sessionId: string): WorkflowRuntimeContinuationSession {
    return {
      sessionId,
      complete: async (request) => {
        const signal = request.signal
        if (signal?.aborted) throw abortError()
        const cancel = (): void => {
          const cancellation = client.cancelSession?.(sessionId)
          if (cancellation !== undefined) void cancellation.catch(() => undefined)
        }
        if (signal?.aborted) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
        try {
          throwIfAborted(signal)
          const result = await withAbort(client.sendPrompt(sessionId, runtimePrompt(request)), signal)
          return result.text
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      },
      cancel: async () => {
        await client.cancelSession?.(sessionId)
      },
      archive: async () => {
        await client.archiveSession?.(sessionId)
      },
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw abortError()
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}
