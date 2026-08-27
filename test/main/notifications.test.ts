import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_EVENT_IDS,
  SOUND_IDS,
  normalizeNotificationSettings,
} from '../../src/shared/notifications.js'
import {
  RuntimeNotificationTracker,
  RuntimeNotificationService,
  type RuntimeHostEnvelope,
  type RuntimeMuxEnvelope,
  type RuntimeWebSocketLike,
} from '../../src/main/notifications/runtime-notification-service.js'

const mux = (payload: Record<string, unknown>, rpcId = 'rpc-1'): RuntimeMuxEnvelope => ({
  type: 'server-request',
  rpcId,
  payload,
})

const host = (payload: Record<string, unknown>, rpcId = 'rpc-1'): RuntimeHostEnvelope => ({
  type: 'server-request',
  rpcId,
  payload,
})

class FakeNotificationWebSocket implements RuntimeWebSocketLike {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.emit('close', {})
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  send(envelope: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(envelope) })
  }
}

describe('notification settings', () => {
  it('ships six event rows and twenty local sound definitions', () => {
    expect(NOTIFICATION_EVENT_IDS).toEqual(['question', 'approval', 'task', 'job', 'subagent', 'error'])
    expect(SOUND_IDS).toHaveLength(20)
    expect(DEFAULT_NOTIFICATION_SETTINGS).toMatchObject({
      master: true,
      nativeOn: true,
      volume: 100,
      questionOn: true,
      approvalOn: true,
      taskOn: true,
      jobOn: true,
      subagentOn: false,
      errorOn: true,
    })
  })

  it('normalizes malformed persisted values without allowing unknown sounds', () => {
    const result = normalizeNotificationSettings({
      master: 'yes',
      nativeOn: false,
      volume: 140,
      approvalSound: 'not-a-sound',
      taskOn: false,
    })

    expect(result.master).toBe(true)
    expect(result.nativeOn).toBe(false)
    expect(result.volume).toBe(100)
    expect(result.approvalSound).toBe(DEFAULT_NOTIFICATION_SETTINGS.approvalSound)
    expect(result.taskOn).toBe(false)
  })
})

describe('RuntimeNotificationTracker', () => {
  it('emits approval with the rendered command and ignores duplicate replay', () => {
    const tracker = new RuntimeNotificationTracker()

    expect(tracker.consumeMux(mux({
      type: 'session/event',
      sessionId: 'session-1',
      event: {
        type: 'tool/call',
        seq: 4,
        time: 1,
        data: { callId: 'call-1', name: 'bash', arguments: '{"command":"npm publish"}' },
      },
      view: { for: 'call', view: { card: 'terminal', title: 'npm publish' } },
    }))).toEqual([])

    const signal = tracker.consumeMux(mux({
      type: 'approval/requested',
      sessionId: 'session-1',
      approvalId: 'approval-1',
      toolName: 'bash',
      callId: 'call-1',
    }))

    expect(signal).toEqual([expect.objectContaining({
      event: 'approval',
      sessionId: 'session-1',
      detail: 'npm publish',
      dedupeKey: 'approval:session-1:approval-1',
    })])
    expect(tracker.consumeMux(mux({
      type: 'approval/requested',
      sessionId: 'session-1',
      approvalId: 'approval-1',
      toolName: 'bash',
      callId: 'call-1',
    }))).toEqual([])
  })

  it('tracks turn completion, turn errors, jobs, and subagents as distinct events', () => {
    const tracker = new RuntimeNotificationTracker()

    expect(tracker.consumeMux(mux({
      type: 'session/jobs',
      sessionId: 'session-1',
      jobs: [{ id: 'job-1', kind: 'bash', label: 'npm test', status: 'running' }],
    }))).toEqual([])
    expect(tracker.consumeMux(mux({
      type: 'session/jobs',
      sessionId: 'session-1',
      jobs: [{ id: 'job-1', kind: 'bash', label: 'npm test', status: 'completed', detail: 'exit code: 0' }],
    }))).toEqual([expect.objectContaining({ event: 'job', detail: 'npm test' })])
    expect(tracker.consumeMux(mux({
      type: 'session/event',
      sessionId: 'session-1',
      event: {
        type: 'turn/end',
        seq: 20,
        time: 2,
        data: { turn: 1, reason: { kind: 'completed' } },
      },
    }))).toEqual([expect.objectContaining({ event: 'task', dedupeKey: 'task:session-1:20' })])
    expect(tracker.consumeMux(mux({
      type: 'session/event',
      sessionId: 'session-1',
      event: {
        type: 'turn/end',
        seq: 21,
        time: 3,
        data: { turn: 2, reason: { kind: 'error', error: { message: 'Provider unavailable' } } },
      },
    }))).toEqual([expect.objectContaining({ event: 'error', detail: 'Provider unavailable' })])

    expect(tracker.consumeHost(host({
      type: 'host/session-added',
      sessionId: 'child-1',
      parentSessionId: 'session-1',
      origin: 'subagent',
      blank: false,
    }))).toEqual([])
    expect(tracker.consumeHost(host({ type: 'host/session-status', sessionId: 'child-1', running: true }))).toEqual([])
    expect(tracker.consumeHost(host({ type: 'host/session-status', sessionId: 'child-1', running: false }))).toEqual([
      expect.objectContaining({ event: 'subagent', sessionId: 'child-1' }),
    ])
  })

  it('turns stream errors into the common error event', () => {
    const tracker = new RuntimeNotificationTracker()

    expect(tracker.consumeMux(mux({
      type: 'stream/error',
      error: { code: 'internal', message: 'Event stream failed' },
    }, 'stream-rpc'))).toEqual([
      expect.objectContaining({ event: 'error', sessionId: 'runtime', detail: 'Event stream failed', dedupeKey: 'stream-error:stream-rpc' }),
    ])
  })

  it('uses questionRpcId when releasing a resolved question', () => {
    const tracker = new RuntimeNotificationTracker()
    const request = {
      type: 'question/requested',
      sessionId: 'session-1',
      questions: [{ id: 'q-1', question: 'Choose a target' }],
    }

    expect(tracker.consumeMux(mux(request, 'question-rpc'))).toHaveLength(1)
    expect(tracker.consumeMux(mux({
      type: 'question/resolved',
      sessionId: 'session-1',
      questionRpcId: 'question-rpc',
      outcome: 'answered',
    }, 'resolve-rpc'))).toEqual([])
    expect(tracker.consumeMux(mux(request, 'question-rpc'))).toHaveLength(1)
  })
})

describe('RuntimeNotificationService', () => {
  it('opens the Runtime event endpoints as WebSocket downlinks', async () => {
    const urls: string[] = []
    const sockets: FakeNotificationWebSocket[] = []
    const webSocketFactory = (url: string): RuntimeWebSocketLike => {
      urls.push(url)
      const socket = new FakeNotificationWebSocket()
      sockets.push(socket)
      return socket
    }
    const service = new RuntimeNotificationService({
      webSocketFactory,
      reconnectDelayMs: 60_000,
      onSignal: () => undefined,
    })

    service.start('http://127.0.0.1:3690/')
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.stop()

    expect(sockets).toHaveLength(2)
    expect(urls.sort()).toEqual([
      'ws://127.0.0.1:3690/api/events.host',
      'ws://127.0.0.1:3690/api/events.mux',
    ])
  })

  it('forwards JSON frames received from WebSocket downlinks', async () => {
    const signals: string[] = []
    let resolveSignals: () => void = () => undefined
    const signalsReady = new Promise<void>((resolve) => { resolveSignals = resolve })
    const webSocketFactory = (url: string): RuntimeWebSocketLike => {
      const socket = new FakeNotificationWebSocket()
      queueMicrotask(() => {
        const payload = url.endsWith('.mux')
          ? { type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'bash' }
          : { type: 'host/agent-error', sessionId: 'session-1', message: 'Host unavailable' }
        socket.send({ type: 'server-request', rpcId: url, payload })
      })
      return socket
    }
    const service = new RuntimeNotificationService({
      webSocketFactory,
      reconnectDelayMs: 60_000,
      onSignal: (signal) => {
        signals.push(signal.event)
        if (signals.length === 2) resolveSignals()
      },
    })

    service.start('http://127.0.0.1:3690/')
    await signalsReady
    service.stop()

    expect(signals.sort()).toEqual(['approval', 'error'])
  })

  it('reads mux and host SSE streams and forwards their signals', async () => {
    const signals: string[] = []
    let resolveSignals: () => void = () => undefined
    const signalsReady = new Promise<void>((resolve) => { resolveSignals = resolve })
    const fetchImpl: typeof fetch = async (input) => {
      const path = String(input)
      const payload = path.endsWith('.mux')
        ? { type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'bash' }
        : { type: 'host/agent-error', sessionId: 'session-1', message: 'Host unavailable' }
      const frame = JSON.stringify({ type: 'server-request', rpcId: path, payload })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`))
          controller.close()
        },
      })
      return new Response(body, { status: 200 })
    }
    const service = new RuntimeNotificationService({
      fetchImpl,
      reconnectDelayMs: 60_000,
      onSignal: (signal) => {
        signals.push(signal.event)
        if (signals.length === 2) resolveSignals()
      },
    })

    service.start('http://127.0.0.1:3690/')
    await signalsReady
    service.stop()

    expect(signals.sort()).toEqual(['approval', 'error'])
  })
})
