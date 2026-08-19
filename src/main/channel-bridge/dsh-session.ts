import { randomUUID } from 'node:crypto'

/**
 * Minimal DSH Runtime session client used by the channel bridge.
 *
 * Calls the local `dsh web` HTTP API (e.g. /api/session.create,
 * /api/session.prompt, /api/session.history) and extracts the final
 * assistant text, excluding reasoning/thinking blocks.
 */

export interface DshSessionClientOptions {
  /** Base URL of the running DSH Runtime, e.g. http://127.0.0.1:8080 */
  baseUrl: string
  /** Max time to wait for a turn to complete (ms). */
  timeoutMs: number
  /** Polling interval while waiting for the turn (ms). */
  pollIntervalMs?: number
}

export interface DshSession {
  sessionId: string
}

export interface DshSendResult {
  text: string
}

export interface DshSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank?: boolean
  title?: string
}

export interface DshWorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface TurnTrackerCallbacks {
  /** Called after the prompt has been queued in DSH. */
  onAcknowledged(): void
  /** Called every `statusIntervalMs` while the turn is still running. */
  onProgress(elapsedMs: number): void
  /** Called once the turn ends and a final text answer is available. */
  onComplete(text: string): void
  /** Called when the turn exceeds `timeoutMs` without completing. */
  onError(error: string): void
}

interface SessionCreateRequest {
  sessionId?: string
  cwd?: string
  workspaceId?: string
}

interface SessionCreateResponse {
  sessionId: string
}

interface SessionPromptRequest {
  sessionId: string
  mode: 'queue' | 'steer'
  content: Array<{ type: 'text'; text: string }>
}

interface SessionPromptResponse {
  accepted: true
  command?: {
    kind: 'success'
    text?: string
  }
}

interface WorkspaceListResponse {
  items: DshWorkspaceSummary[]
  archivedSessionIds: string[]
}

interface WorkspaceCreateResponse {
  workspace: DshWorkspaceSummary
  created: boolean
}

interface WorkspaceRenameResponse {
  workspace: DshWorkspaceSummary
}

interface SessionHistoryRequest {
  sessionId: string
  beforeSeq?: number
  maxMessages?: number
}

interface SessionHistoryResponse {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: unknown
}

interface SessionListResponse {
  items: SessionSummaryWire[]
}

interface SessionSummaryWire {
  sessionId: string
  updatedAt: number
  running: boolean
  blank?: boolean
}

interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
  ignorable?: true
}

interface RpcRequestEnvelope<T> {
  type: 'client-request'
  rpcId: string
  method: string
  payload: T
}

interface RpcResponseEnvelope<T> {
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } }
}

export class DshSessionClient {
  private readonly pollIntervalMs: number

  constructor(private readonly options: DshSessionClientOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500
  }

  async createSession(params?: { sessionId?: string; cwd?: string; workspaceId?: string }): Promise<DshSession> {
    const body: SessionCreateRequest = {
      sessionId: params?.sessionId,
      cwd: params?.cwd,
      workspaceId: params?.workspaceId,
    }

    const response = await this.post<SessionCreateResponse>('/api/session.create', body)
    return { sessionId: response.sessionId }
  }

  async listWorkspaces(): Promise<DshWorkspaceSummary[]> {
    const response = await this.post<WorkspaceListResponse>('/api/workspace.list', {})
    return response.items
  }

  async createWorkspace(path: string): Promise<WorkspaceCreateResponse> {
    return this.post<WorkspaceCreateResponse>('/api/workspace.create', { path })
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceRenameResponse> {
    return this.post<WorkspaceRenameResponse>('/api/workspace.rename', { workspaceId, title })
  }

  async listSessions(): Promise<DshSessionSummary[]> {
    const response = await this.post<SessionListResponse>('/api/session.list', {})
    const items = response.items.map((item) => ({
      sessionId: item.sessionId,
      updatedAt: item.updatedAt,
      running: item.running,
      blank: item.blank,
    }))

    const titles = await Promise.all(
      items.map((item) => this.getSessionTitle(item.sessionId).catch(() => undefined)),
    )

    return items.map((item, index) => ({
      ...item,
      title: titles[index],
    }))
  }

  async getSessionTitle(sessionId: string): Promise<string | undefined> {
    const history = await this.post<SessionHistoryResponse>('/api/session.history', {
      sessionId,
      maxMessages: 100,
    } as SessionHistoryRequest)

    const titleEvents = history.events
      .map((entry) => entry.event)
      .filter((event) => event.type === 'session/title')

    if (titleEvents.length === 0) return undefined

    const latest = titleEvents.reduce((a, b) => (a.seq > b.seq ? a : b))
    const data = latest.data as { title?: string } | undefined
    const title = data?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  }

  async sendPrompt(sessionId: string, text: string): Promise<DshSendResult> {
    return new Promise((resolve, reject) => {
      void this.sendPromptAsync(
        sessionId,
        text,
        {
          onAcknowledged: () => {},
          onProgress: () => {},
          onComplete: (answer) => {
            resolve({ text: answer })
          },
          onError: (error) => {
            reject(new Error(error))
          },
        },
        {
          timeoutMs: this.options.timeoutMs,
          statusIntervalMs: this.options.timeoutMs,
        },
      )
    })
  }

  async queuePrompt(sessionId: string, text: string): Promise<SessionPromptResponse> {
    return this.post<SessionPromptResponse>('/api/session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    } satisfies SessionPromptRequest)
  }

  async sendPromptAsync(
    sessionId: string,
    text: string,
    callbacks: TurnTrackerCallbacks,
    options: { timeoutMs: number; statusIntervalMs: number },
  ): Promise<void> {
    const sinceSeq = await this.getCurrentMaxSeq(sessionId)

    await this.queuePrompt(sessionId, text)
    callbacks.onAcknowledged()

    const startTime = Date.now()
    const deadline = startTime + options.timeoutMs
    let nextStatusTime = startTime + options.statusIntervalMs
    const collectedEvents: SessionEvent[] = []
    const seenSeqs = new Set<number>()

    while (Date.now() < deadline) {
      const history = await this.post<SessionHistoryResponse>('/api/session.history', {
        sessionId,
      } as SessionHistoryRequest)

      const events = history.events.map((entry) => entry.event)
      for (const event of events) {
        if (event.seq > sinceSeq && !seenSeqs.has(event.seq)) {
          seenSeqs.add(event.seq)
          collectedEvents.push(event)
        }
      }

      const turnEnd = collectedEvents.find((event) => event.type === 'turn/end')
      if (turnEnd !== undefined) {
        callbacks.onComplete(extractAssistantText(collectedEvents))
        return
      }

      const now = Date.now()
      if (now >= nextStatusTime) {
        callbacks.onProgress(now - startTime)
        nextStatusTime = now + options.statusIntervalMs
      }

      await sleep(this.pollIntervalMs)
    }

    callbacks.onError('DSH session turn timed out')
  }

  private async getCurrentMaxSeq(sessionId: string): Promise<number> {
    const history = await this.post<SessionHistoryResponse>('/api/session.history', {
      sessionId,
    } as SessionHistoryRequest)

    if (history.events.length === 0) return -1
    return Math.max(...history.events.map((entry) => entry.event.seq))
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/$/u, '')}${path}`
    const method = path.replace(/^\/api\//u, '')
    const envelope: RpcRequestEnvelope<unknown> = {
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: body,
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`DSH API ${path} failed: ${response.status} ${text}`)
    }

    const rpcResponse = (await response.json()) as RpcResponseEnvelope<T>
    if (!rpcResponse.result.ok) {
      throw new Error(`DSH API ${path} error: ${rpcResponse.result.error.code} ${rpcResponse.result.error.message}`)
    }
    return rpcResponse.result.value
  }
}

function extractAssistantText(events: SessionEvent[]): string {
  const assistantMessages = events.filter((event) => event.type === 'assistant/message')
  const parts: string[] = []

  for (const event of assistantMessages) {
    const data = event.data as Record<string, unknown> | undefined
    const message = data?.message as Record<string, unknown> | undefined
    const content = message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (isTextBlock(block)) {
        parts.push(block.text)
      }
    }
  }

  return parts.join('').trim()
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).type === 'text' &&
    typeof (value as Record<string, unknown>).text === 'string'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
