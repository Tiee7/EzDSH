import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeWorkflowObservationEvent, type WorkflowObservationEvent } from '../../shared/workflow-operations.js'

const FILE_NAME = 'workflow-observations.jsonl'

interface StoredObservationEntry {
  event: WorkflowObservationEvent
  order: number
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function cloneObservation(event: WorkflowObservationEvent): WorkflowObservationEvent {
  return {
    id: event.id,
    environmentId: event.environmentId,
    ...(event.releaseId === undefined ? {} : { releaseId: event.releaseId }),
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
    time: event.time,
    kind: event.kind,
    action: event.action,
    severity: event.severity,
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export class WorkflowObservationStore {
  private readonly filePath: string
  private readonly observations = new Map<string, StoredObservationEntry>()
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private mutationChain: Promise<void> = Promise.resolve()
  private nextOrder = 0

  constructor(stateDir: string) {
    this.filePath = join(stateDir, FILE_NAME)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await ensurePrivateDirectory(dirname(this.filePath))
      this.observations.clear()
      this.nextOrder = 0
      try {
        const content = await readFile(this.filePath, 'utf8')
        for (const line of content.split(/\r?\n/u)) {
          const trimmed = line.trim()
          if (trimmed === '') continue
          let parsed: unknown
          try {
            parsed = JSON.parse(trimmed) as unknown
          } catch {
            continue
          }
          const event = normalizeWorkflowObservationEvent(parsed)
          if (event === undefined || this.observations.has(event.id)) continue
          this.observations.set(event.id, { event: cloneObservation(event), order: this.nextOrder })
          this.nextOrder += 1
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      await chmod(this.filePath, 0o600).catch((error) => {
        if (!isNotFound(error)) throw error
      })
      this.initialized = true
    })()
    this.initializationPromise = pending
    try {
      await pending
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined
    }
  }

  list(environmentId?: string): WorkflowObservationEvent[] {
    return Array.from(this.observations.values())
      .filter(({ event }) => environmentId === undefined || event.environmentId === environmentId)
      .sort((left, right) => {
        const byTime = left.event.time.localeCompare(right.event.time)
        if (byTime !== 0) return byTime
        return left.order - right.order
      })
      .map(({ event }) => cloneObservation(event))
  }

  async append(input: WorkflowObservationEvent): Promise<WorkflowObservationEvent> {
    await this.initialize()
    const normalized = normalizeWorkflowObservationEvent(input)
    if (normalized === undefined) throw new Error('Invalid workflow observation event')
    return this.mutate(async () => {
      const existing = this.observations.get(normalized.id)
      if (existing !== undefined) return cloneObservation(existing.event)
      const snapshot = cloneObservation(normalized)
      await appendFile(this.filePath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(this.filePath, 0o600)
      this.observations.set(snapshot.id, { event: snapshot, order: this.nextOrder })
      this.nextOrder += 1
      return cloneObservation(snapshot)
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation)
    this.mutationChain = result.then(() => undefined, () => undefined)
    return result
  }
}
