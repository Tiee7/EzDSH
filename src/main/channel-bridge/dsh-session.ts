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
}

interface SessionCreateRequest {
  sessionId?: string
  cwd?: string
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

export class DshSessionClient {
  private readonly pollIntervalMs: number

  constructor(private readonly options: DshSessionClientOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500
  }

  async createSession(params?: { sessionId?: string; cwd?: string }): Promise<DshSession> {
    const body: SessionCreateRequest = {
      sessionId: params?.sessionId,
      cwd: params?.cwd,
    }

    const response = await this.post<SessionCreateResponse>('/api/session.create', body)
    return { sessionId: response.sessionId }
  }

  async listSessions(): Promise<DshSessionSummary[]> {
    const response = await this.post<SessionListResponse>('/api/session.list', {})
    return response.items.map((item) => ({
      sessionId: item.sessionId,
      updatedAt: item.updatedAt,
      running: item.running,
      blank: item.blank,
    }))
  }

  async sendPrompt(sessionId: string, text: string): Promise<DshSendResult> {
    const sinceSeq = await this.getCurrentMaxSeq(sessionId)

    const promptBody: SessionPromptRequest = {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }

    await this.post<SessionPromptResponse>('/api/session.prompt', promptBody)

    const answer = await this.waitForAssistantText(sessionId, sinceSeq)
    return { text: answer }
  }

  private async getCurrentMaxSeq(sessionId: string): Promise<number> {
    const history = await this.post<SessionHistoryResponse>('/api/session.history', {
      sessionId,
    } as SessionHistoryRequest)

    if (history.events.length === 0) return -1
    return Math.max(...history.events.map((entry) => entry.event.seq))
  }

  private async waitForAssistantText(sessionId: string, sinceSeq: number): Promise<string> {
    const deadline = Date.now() + this.options.timeoutMs
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
        return extractAssistantText(collectedEvents)
      }

      await sleep(this.pollIntervalMs)
    }

    throw new Error('DSH session turn timed out')
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/$/u, '')}${path}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`DSH API ${path} failed: ${response.status} ${text}`)
    }

    return (await response.json()) as T
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
