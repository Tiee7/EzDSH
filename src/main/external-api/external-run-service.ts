import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ExternalRunEvent,
  ExternalRunRequest,
  ExternalRunSnapshot,
  ExternalRunStatus,
} from '../../shared/external-api.js'
import type { DshSession } from '../channel-bridge/dsh-session.js'

interface ExternalRunClient {
  createSession(params?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<DshSession>
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }>
  sendPromptAsync(
    sessionId: string,
    text: string,
    callbacks: {
      onAcknowledged(): void
      onDelta?(text: string): void
      onProgress(elapsedMs: number): void
      onComplete(text: string): void
      onError(error: string): void
    },
    options: { timeoutMs: number; statusIntervalMs: number },
  ): Promise<void>
}

export interface ExternalRunServiceOptions {
  createClient(): ExternalRunClient
  timeoutMs?: number
  statePath?: string
}

export interface ExternalRunServiceLike {
  create(request: ExternalRunRequest): Promise<{ runId: string; sessionId: string; status: ExternalRunStatus }>
  get(runId: string): ExternalRunSnapshot | undefined
  subscribe(runId: string, afterEventId: number, listener: (event: ExternalRunEvent) => void): () => void
  cancel(runId: string): ExternalRunSnapshot
  initialize?(): Promise<void>
  flush?(): Promise<void>
}

interface RunRecord {
  snapshot: ExternalRunSnapshot
  events: ExternalRunEvent[]
  listeners: Set<(event: ExternalRunEvent) => void>
  requestKey?: string
  outputFormat: 'text' | 'json'
  cancelled: boolean
}

interface PersistedRunRecord {
  snapshot: ExternalRunSnapshot
  events: ExternalRunEvent[]
  requestKey?: string
  outputFormat: 'text' | 'json'
}

export class ExternalRunService implements ExternalRunServiceLike {
  private readonly runs = new Map<string, RunRecord>()
  private readonly requestKeys = new Map<string, string>()
  private readonly timeoutMs: number
  private readonly ready: Promise<void>
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: ExternalRunServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
    this.ready = this.loadState()
  }

  async initialize(): Promise<void> {
    await this.ready
  }

  async flush(): Promise<void> {
    await this.ready
    await this.persistChain
  }

  async create(request: ExternalRunRequest): Promise<{ runId: string; sessionId: string; status: ExternalRunStatus }> {
    await this.ready
    const prompt = request.prompt.trim()
    if (prompt === '') throw new Error('prompt is required')

    const requestKey = this.getRequestKey(request)
    if (requestKey !== undefined) {
      const existingRunId = this.requestKeys.get(requestKey)
      if (existingRunId !== undefined) {
        const existing = this.runs.get(existingRunId)
        if (existing !== undefined) {
          return this.createdResponse(existing.snapshot)
        }
      }
    }

    const sessionId = await this.resolveSession(request)
    const now = new Date().toISOString()
    const runId = randomUUID()
    const record: RunRecord = {
      snapshot: {
        runId,
        sessionId,
        status: 'queued',
        text: '',
        createdAt: now,
        updatedAt: now,
      },
      events: [],
      listeners: new Set(),
      requestKey,
      outputFormat: request.output?.format === 'json' ? 'json' : 'text',
      cancelled: false,
    }
    this.runs.set(runId, record)
    if (requestKey !== undefined) this.requestKeys.set(requestKey, runId)
    this.publish(record, 'queued', {})

    const response = this.createdResponse(record.snapshot)
    void this.start(record, prompt)
    return response
  }

  get(runId: string): ExternalRunSnapshot | undefined {
    const record = this.runs.get(runId)
    return record === undefined ? undefined : cloneSnapshot(record.snapshot)
  }

  events(runId: string): ExternalRunEvent[] {
    const record = this.runs.get(runId)
    return record === undefined ? [] : record.events.map(cloneEvent)
  }

  subscribe(runId: string, afterEventId: number, listener: (event: ExternalRunEvent) => void): () => void {
    const record = this.runs.get(runId)
    if (record === undefined) throw new Error('Run not found')
    for (const event of record.events) {
      if (event.id > afterEventId) listener(cloneEvent(event))
    }
    record.listeners.add(listener)
    return () => record.listeners.delete(listener)
  }

  cancel(runId: string): ExternalRunSnapshot {
    const record = this.runs.get(runId)
    if (record === undefined) throw new Error('Run not found')
    if (record.snapshot.status === 'queued' || record.snapshot.status === 'running') {
      record.cancelled = true
      this.setStatus(record, 'cancelled', { reason: 'client-requested' })
    }
    return cloneSnapshot(record.snapshot)
  }

  private async resolveSession(request: ExternalRunRequest): Promise<string> {
    if (request.sessionMode === 'existing') {
      const sessionId = request.sessionId?.trim()
      if (sessionId === undefined || sessionId === '') throw new Error('sessionId is required for an existing session')
      return sessionId
    }
    const client = this.options.createClient()
    const session = await client.createSession({
      workspaceId: request.projectId,
    })
    if (request.archiveSession === true) await client.archiveSession(session.sessionId)
    return session.sessionId
  }

  private async start(record: RunRecord, prompt: string): Promise<void> {
    try {
      await this.options.createClient().sendPromptAsync(
        record.snapshot.sessionId,
        prompt,
        {
          onAcknowledged: () => {
            if (!record.cancelled) this.setStatus(record, 'running', {})
          },
          onDelta: (text) => {
            if (record.cancelled) return
            record.snapshot.text += text
            record.snapshot.updatedAt = new Date().toISOString()
            this.publish(record, 'delta', { text, accumulatedText: record.snapshot.text })
          },
          onProgress: () => {},
          onComplete: (text) => {
            if (record.cancelled) return
            record.snapshot.text = text
            record.snapshot.updatedAt = new Date().toISOString()
            let result: unknown
            if (record.outputFormat === 'json') {
              try {
                result = JSON.parse(text) as unknown
              } catch {
                result = undefined
              }
            }
            if (result !== undefined) record.snapshot.result = result
            this.setStatus(record, 'completed', { text, ...(result === undefined ? {} : { result }) })
          },
          onError: (error) => {
            if (record.cancelled) return
            record.snapshot.error = error
            this.setStatus(record, 'failed', { error })
          },
        },
        { timeoutMs: this.timeoutMs, statusIntervalMs: this.timeoutMs },
      )
    } catch (error) {
      if (record.cancelled) return
      const message = error instanceof Error ? error.message : String(error)
      record.snapshot.error = message
      this.setStatus(record, 'failed', { error: message })
    }
  }

  private setStatus(record: RunRecord, status: ExternalRunStatus, data: Record<string, unknown>): void {
    record.snapshot.status = status
    record.snapshot.updatedAt = new Date().toISOString()
    this.publish(record, status === 'running' ? 'started' : status, data)
  }

  private publish(record: RunRecord, type: ExternalRunEvent['type'], data: Record<string, unknown>): void {
    const event: ExternalRunEvent = {
      id: record.events.length + 1,
      runId: record.snapshot.runId,
      type,
      at: new Date().toISOString(),
      data,
    }
    record.events.push(event)
    this.persist()
    for (const listener of record.listeners) listener(cloneEvent(event))
  }

  private async loadState(): Promise<void> {
    const statePath = this.options.statePath
    if (statePath === undefined) return
    let raw: string
    try {
      raw = await readFile(statePath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return
      throw error
    }
    if (raw.trim() === '') return

    const parsed = JSON.parse(raw) as { runs?: PersistedRunRecord[] }
    let recoveredNonTerminal = false
    for (const persisted of parsed.runs ?? []) {
      if (!persisted?.snapshot?.runId || !persisted.snapshot.sessionId) continue
      const snapshot = { ...persisted.snapshot }
      const events = Array.isArray(persisted.events) ? persisted.events : []
      if (snapshot.status === 'queued' || snapshot.status === 'running') {
        const error = 'EzDSH restarted before this Run completed; the partial result was retained and can be retried.'
        snapshot.status = 'failed'
        snapshot.error = error
        snapshot.updatedAt = new Date().toISOString()
        events.push({
          id: events.length + 1,
          runId: snapshot.runId,
          type: 'failed',
          at: snapshot.updatedAt,
          data: { error, reason: 'service-restarted' },
        })
        recoveredNonTerminal = true
      }
      const record: RunRecord = {
        snapshot,
        events,
        listeners: new Set(),
        requestKey: persisted.requestKey,
        outputFormat: persisted.outputFormat === 'json' ? 'json' : 'text',
        cancelled: snapshot.status === 'cancelled',
      }
      this.runs.set(record.snapshot.runId, record)
      if (record.requestKey !== undefined) this.requestKeys.set(record.requestKey, record.snapshot.runId)
    }
    if (recoveredNonTerminal) {
      this.persist()
      await this.persistChain
    }
  }

  private persist(): void {
    const statePath = this.options.statePath
    if (statePath === undefined) return
    this.persistChain = this.persistChain.then(async () => {
      const payload = JSON.stringify({
        runs: Array.from(this.runs.values()).map((record): PersistedRunRecord => ({
          snapshot: record.snapshot,
          events: record.events,
          requestKey: record.requestKey,
          outputFormat: record.outputFormat,
        })),
      }, null, 2)
      await mkdir(dirname(statePath), { recursive: true })
      const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(tempPath, payload, 'utf8')
      await rename(tempPath, statePath)
    }).catch((error: unknown) => {
      console.error('[external-api] failed to persist Run state:', error)
    })
  }

  private getRequestKey(request: ExternalRunRequest): string | undefined {
    const name = request.client?.name?.trim()
    const requestId = request.client?.requestId?.trim()
    if (!name || !requestId) return undefined
    return `${name}:${requestId}`
  }

  private createdResponse(snapshot: ExternalRunSnapshot): { runId: string; sessionId: string; status: ExternalRunStatus } {
    return { runId: snapshot.runId, sessionId: snapshot.sessionId, status: snapshot.status }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function cloneSnapshot(snapshot: ExternalRunSnapshot): ExternalRunSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ExternalRunSnapshot
}

function cloneEvent(event: ExternalRunEvent): ExternalRunEvent {
  return JSON.parse(JSON.stringify(event)) as ExternalRunEvent
}
