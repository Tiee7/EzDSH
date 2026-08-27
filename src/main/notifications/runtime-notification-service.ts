import type { NotificationSignal } from '../../shared/notifications.js'
import { createRequire } from 'node:module'

/** Minimal JSON shape accepted from the DSH server-request SSE envelopes. */
export interface RuntimeMuxEnvelope {
  type: 'server-request'
  rpcId: string
  payload: Record<string, unknown>
}

/** Minimal JSON shape accepted from the DSH host event SSE envelopes. */
export interface RuntimeHostEnvelope {
  type: 'server-request'
  rpcId: string
  payload: Record<string, unknown>
}

export type RuntimeNotificationListener = (signal: NotificationSignal) => void

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined

const stringValue = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

const numberValue = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function signal(
  event: NotificationSignal['event'],
  sessionId: string,
  dedupeKey: string,
  detail?: string,
): NotificationSignal {
  return { event, sessionId, dedupeKey, ...(detail === undefined ? {} : { detail }) }
}

function clipDetail(value: string | undefined, maxLength = 240): string | undefined {
  const trimmed = value?.replace(/[\r\n]+/g, ' ').trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`
}

/** Extract the human-facing command title carried by a rendered tool-call view. */
function callTitle(view: unknown, argumentsRaw: string | undefined): string | undefined {
  const viewRecord = asRecord(view)
  const nested = viewRecord?.for === 'call' ? asRecord(viewRecord.view) : undefined
  const title = stringValue(nested?.title)
  if (title !== undefined) return clipDetail(title)

  if (argumentsRaw !== undefined) {
    try {
      const args = asRecord(JSON.parse(argumentsRaw))
      const command = stringValue(args?.command)
      if (command !== undefined) return clipDetail(command)
    } catch {
      // The Runtime's raw model input is allowed to be malformed; fall back to the tool name.
    }
  }
  return undefined
}

interface ToolCallRecord {
  title?: string
  arguments?: string
}

interface JobRecord {
  status: string
  label: string
}

/**
 * Converts the DSH Web event vocabulary into the six desktop notification
 * signals. The tracker is deliberately stateful: Runtime streams replay
 * pending requests and reconnects can repeat snapshots.
 */
export class RuntimeNotificationTracker {
  private readonly approvalKeys = new Set<string>()
  private readonly questionKeys = new Set<string>()
  private readonly completedTurnKeys = new Set<string>()
  private readonly toolCalls = new Map<string, Map<string, ToolCallRecord>>()
  private readonly jobs = new Map<string, Map<string, JobRecord>>()
  private readonly subagentParents = new Map<string, string>()
  private readonly subagentRunning = new Map<string, boolean>()

  consumeMux(envelope: RuntimeMuxEnvelope): NotificationSignal[] {
    const payload = envelope.payload
    const type = stringValue(payload.type)
    if (type === 'approval/requested') return this.consumeApproval(envelope)
    if (type === 'approval/resolved') {
      const sessionId = stringValue(payload.sessionId)
      const approvalId = stringValue(payload.approvalId)
      if (sessionId !== undefined && approvalId !== undefined) this.approvalKeys.delete(`approval:${sessionId}:${approvalId}`)
      return []
    }
    if (type === 'question/requested') return this.consumeQuestion(envelope)
    if (type === 'question/resolved') {
      const sessionId = stringValue(payload.sessionId)
      const questionRpcId = stringValue(payload.questionRpcId)
      if (sessionId !== undefined && questionRpcId !== undefined) this.questionKeys.delete(`question:${sessionId}:${questionRpcId}`)
      return []
    }
    if (type === 'stream/error') return [this.consumeStreamError(payload, envelope.rpcId)]
    if (type === 'session/event') return this.consumeSessionEvent(payload)
    if (type === 'session/jobs') return this.consumeJobs(payload)
    return []
  }

  consumeHost(envelope: RuntimeHostEnvelope): NotificationSignal[] {
    const payload = envelope.payload
    const type = stringValue(payload.type)
    if (type === 'host/session-added') {
      const sessionId = stringValue(payload.sessionId)
      const parentSessionId = stringValue(payload.parentSessionId)
      if (sessionId !== undefined && parentSessionId !== undefined && payload.origin === 'subagent') {
        this.subagentParents.set(sessionId, parentSessionId)
      }
      return []
    }

    if (type === 'host/session-status') {
      const sessionId = stringValue(payload.sessionId)
      if (sessionId === undefined || !this.subagentParents.has(sessionId) || typeof payload.running !== 'boolean') return []
      const wasRunning = this.subagentRunning.get(sessionId)
      this.subagentRunning.set(sessionId, payload.running)
      if (wasRunning === true && payload.running === false) {
        return [signal('subagent', sessionId, `subagent:${sessionId}`)]
      }
      return []
    }

    if (type === 'host/session-removed') {
      const sessionId = stringValue(payload.sessionId)
      if (sessionId !== undefined) {
        this.subagentParents.delete(sessionId)
        this.subagentRunning.delete(sessionId)
      }
      return []
    }

    if (type === 'host/agent-error') {
      const sessionId = stringValue(payload.sessionId)
      if (sessionId === undefined) return []
      return [signal('error', sessionId, `agent-error:${sessionId}:${envelope.rpcId}`, clipDetail(stringValue(payload.message)))]
    }
    if (type === 'stream/error') return [this.consumeStreamError(payload, envelope.rpcId)]
    return []
  }

  private consumeStreamError(payload: Record<string, unknown>, rpcId: string): NotificationSignal {
    const error = asRecord(payload.error)
    const sessionId = stringValue(payload.sessionId) ?? 'runtime'
    return signal('error', sessionId, `stream-error:${rpcId}`, clipDetail(stringValue(error?.message)) ?? 'Runtime event stream error')
  }

  private consumeApproval(envelope: RuntimeMuxEnvelope): NotificationSignal[] {
    const payload = envelope.payload
    const sessionId = stringValue(payload.sessionId)
    const approvalId = stringValue(payload.approvalId)
    if (sessionId === undefined || approvalId === undefined) return []
    const dedupeKey = `approval:${sessionId}:${approvalId}`
    if (this.approvalKeys.has(dedupeKey)) return []
    this.approvalKeys.add(dedupeKey)

    const callId = stringValue(payload.callId)
    const call = callId === undefined ? undefined : this.toolCalls.get(sessionId)?.get(callId)
    const detail = call?.title ?? callTitle(undefined, call?.arguments) ?? clipDetail(stringValue(payload.reason)) ?? stringValue(payload.toolName)
    return [signal('approval', sessionId, dedupeKey, detail)]
  }

  private consumeQuestion(envelope: RuntimeMuxEnvelope): NotificationSignal[] {
    const payload = envelope.payload
    const sessionId = stringValue(payload.sessionId)
    if (sessionId === undefined) return []
    const dedupeKey = `question:${sessionId}:${envelope.rpcId}`
    if (this.questionKeys.has(dedupeKey)) return []
    this.questionKeys.add(dedupeKey)
    const questions = Array.isArray(payload.questions) ? payload.questions : []
    const first = asRecord(questions[0])
    return [signal('question', sessionId, dedupeKey, clipDetail(stringValue(first?.question)))]
  }

  private consumeSessionEvent(payload: Record<string, unknown>): NotificationSignal[] {
    const sessionId = stringValue(payload.sessionId)
    const event = asRecord(payload.event)
    if (sessionId === undefined || event === undefined) return []
    const eventType = stringValue(event.type)
    const data = asRecord(event.data)

    if (eventType === 'tool/call' && data !== undefined) {
      const callId = stringValue(data.callId)
      if (callId !== undefined) {
        const calls = this.toolCalls.get(sessionId) ?? new Map<string, ToolCallRecord>()
        calls.set(callId, {
          title: callTitle(payload.view, stringValue(data.arguments)),
          arguments: stringValue(data.arguments),
        })
        this.toolCalls.set(sessionId, calls)
      }
      return []
    }

    if (eventType !== 'turn/end' || data === undefined) return []
    // A child session has its own host/session-status edge and is reported as
    // `subagent` once, rather than also producing a duplicate `task` sound.
    if (this.subagentParents.has(sessionId)) return []
    const seq = numberValue(event.seq)
    if (seq === undefined) return []
    const dedupeKey = `task:${sessionId}:${String(seq)}`
    if (this.completedTurnKeys.has(dedupeKey)) return []
    this.completedTurnKeys.add(dedupeKey)

    const reason = asRecord(data.reason)
    const reasonKind = stringValue(reason?.kind)
    if (reasonKind === 'error') {
      const error = asRecord(reason?.error)
      return [signal('error', sessionId, `error:${sessionId}:${String(seq)}`, clipDetail(stringValue(error?.message)))]
    }
    return [signal('task', sessionId, dedupeKey)]
  }

  private consumeJobs(payload: Record<string, unknown>): NotificationSignal[] {
    const sessionId = stringValue(payload.sessionId)
    if (sessionId === undefined || !Array.isArray(payload.jobs)) return []
    const previous = this.jobs.get(sessionId)
    const current = new Map<string, JobRecord>()
    const signals: NotificationSignal[] = []

    for (const rawJob of payload.jobs) {
      const job = asRecord(rawJob)
      const id = stringValue(job?.id)
      const status = stringValue(job?.status)
      const label = stringValue(job?.label) ?? id ?? 'Background job'
      if (id === undefined || status === undefined) continue
      current.set(id, { status, label })
      const before = previous?.get(id)
      if (before === undefined) continue
      if ((before.status === 'running' || before.status === 'stopping') && (status === 'completed' || status === 'killed')) {
        signals.push(signal('job', sessionId, `job:${sessionId}:${id}:${status}`, clipDetail(label)))
      } else if (status === 'failed' && before.status !== 'failed') {
        signals.push(signal('error', sessionId, `job-error:${sessionId}:${id}`, clipDetail(`${label}${stringValue(job?.detail) === undefined ? '' : `: ${stringValue(job?.detail)}`}`)))
      }
    }
    this.jobs.set(sessionId, current)
    return signals
  }
}

export interface RuntimeNotificationServiceOptions {
  /** @deprecated Only retained for isolated SSE fixtures; Runtime production transport is WebSocket. */
  fetchImpl?: typeof fetch
  webSocketFactory?: RuntimeWebSocketFactory
  onSignal: RuntimeNotificationListener
  reconnectDelayMs?: number
}

export interface RuntimeWebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void
  removeEventListener?(type: string, listener: (event: unknown) => void): void
  close(): void
}

export type RuntimeWebSocketFactory = (url: string) => RuntimeWebSocketLike

const require = createRequire(import.meta.url)
const defaultWebSocketFactory: RuntimeWebSocketFactory = (url) => {
  const WebSocketConstructor = require('ws') as new (address: string) => RuntimeWebSocketLike
  return new WebSocketConstructor(url)
}

/** Reconnecting reader for the DSH Web mux and host WebSocket event streams. */
export class RuntimeNotificationService {
  private readonly fetchImpl: typeof fetch | undefined
  private readonly webSocketFactory: RuntimeWebSocketFactory
  private readonly tracker = new RuntimeNotificationTracker()
  private readonly reconnectDelayMs: number
  private controller: AbortController | undefined
  private generation = 0

  constructor(private readonly options: RuntimeNotificationServiceOptions) {
    this.fetchImpl = options.fetchImpl
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
  }

  start(runtimeUrl: string): void {
    this.stop()
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    void this.runStream(runtimeUrl, '/api/events.mux', controller.signal, generation, (envelope) => {
      for (const notification of this.tracker.consumeMux(envelope)) this.options.onSignal(notification)
    })
    void this.runStream(runtimeUrl, '/api/events.host', controller.signal, generation, (envelope) => {
      for (const notification of this.tracker.consumeHost(envelope)) this.options.onSignal(notification)
    })
  }

  stop(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = undefined
  }

  private async runStream(
    runtimeUrl: string,
    path: string,
    signal: AbortSignal,
    generation: number,
    onEnvelope: (envelope: RuntimeMuxEnvelope) => void,
  ): Promise<void> {
    const base = runtimeUrl.endsWith('/') ? runtimeUrl.slice(0, -1) : runtimeUrl
    while (!signal.aborted && generation === this.generation) {
      try {
        if (this.options.webSocketFactory !== undefined || this.fetchImpl === undefined) {
          const socket = this.webSocketFactory(toWebSocketUrl(base, path))
          await readWebSocket(socket, signal, onEnvelope)
        } else {
          const response = await this.fetchImpl(`${base}${path}`, { signal })
          if (!response.ok || response.body === null) throw new Error(`Runtime event stream failed: HTTP ${String(response.status)}`)
          await readSse(response.body, signal, (envelope) => onEnvelope(envelope))
        }
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return
        console.warn(`[notifications] ${path} disconnected:`, error instanceof Error ? error.message : String(error))
      }
      if (!signal.aborted && generation === this.generation) await delay(this.reconnectDelayMs, signal)
    }
  }
}

function toWebSocketUrl(runtimeUrl: string, path: string): string {
  const url = new URL(path, `${runtimeUrl}/`)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  return url.toString()
}

function socketMessageText(event: unknown): string | undefined {
  const eventRecord = asRecord(event)
  const data = eventRecord?.data ?? event
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return undefined
}

function parseSocketEnvelope(event: unknown): RuntimeMuxEnvelope | undefined {
  const text = socketMessageText(event)
  if (text === undefined) return undefined
  try {
    const parsed = asRecord(JSON.parse(text))
    const payload = asRecord(parsed?.payload)
    if (parsed?.type !== 'server-request' || typeof parsed.rpcId !== 'string' || payload === undefined) return undefined
    return { type: 'server-request', rpcId: parsed.rpcId, payload }
  } catch {
    return undefined
  }
}

async function readWebSocket(
  socket: RuntimeWebSocketLike,
  signal: AbortSignal,
  onEnvelope: (envelope: RuntimeMuxEnvelope) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      socket.removeEventListener?.('message', onMessage)
      socket.removeEventListener?.('close', onClose)
      socket.removeEventListener?.('error', onError)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onMessage = (event: unknown): void => {
      const envelope = parseSocketEnvelope(event)
      if (envelope !== undefined) onEnvelope(envelope)
    }
    const onClose = (): void => finish()
    const onError = (event: unknown): void => {
      const detail = clipDetail(stringValue(asRecord(event)?.message))
      finish(new Error(detail === undefined ? 'Runtime event WebSocket failed' : detail))
    }
    const onAbort = (): void => {
      try {
        socket.close()
      } catch {
        // The socket may already have failed during shutdown.
      }
      finish()
    }

    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose, { once: true })
    socket.addEventListener('error', onError, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEnvelope: (envelope: RuntimeMuxEnvelope) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = chunk.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('')
        if (data !== '') {
          try {
            const parsed = JSON.parse(data) as unknown
            const envelope = asRecord(parsed)
            const payload = asRecord(envelope?.payload)
            if (envelope?.type === 'server-request' && typeof envelope.rpcId === 'string' && payload !== undefined) {
              onEnvelope({ type: 'server-request', rpcId: envelope.rpcId, payload })
            }
          } catch {
            // One malformed Runtime frame must not stop future notifications.
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
      signal.throwIfAborted()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
