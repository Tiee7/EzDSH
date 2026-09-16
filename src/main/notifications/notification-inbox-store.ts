import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import {
  NOTIFICATION_INBOX_MAX_ITEMS,
  NOTIFICATION_INBOX_ITEM_ID_MAX_LENGTH,
  normalizeNotificationInboxSnapshot,
  normalizeNotificationSignal,
  type NotificationInboxItem,
  type NotificationInboxSnapshot,
  type NotificationSignal,
} from '../../shared/notifications.js'

interface NotificationInboxState {
  version: 1
  items: NotificationInboxItem[]
}

export interface NotificationInboxStoreOptions {
  fileName?: string
  now?: () => string
  idFactory?: () => string
  writeFile?: (path: string, data: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

export interface NotificationInboxAppendResult {
  item: NotificationInboxItem
  appended: boolean
}

const EMPTY_STATE: NotificationInboxState = { version: 1, items: [] }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function unreadCount(items: readonly NotificationInboxItem[]): number {
  return items.reduce((count, item) => count + (item.readAt === undefined && item.dismissedAt === undefined ? 1 : 0), 0)
}

function snapshotFromState(state: NotificationInboxState): NotificationInboxSnapshot {
  const items = state.items.map(clone)
  return { version: 1, items, unreadCount: unreadCount(items) }
}

/**
 * Main-process-owned durable notification inbox.
 *
 * The store is an attention surface, not a Runtime event log. It keeps at
 * most 200 signals, deduplicates by the Runtime-provided dedupe key, and
 * serializes all mutations before atomically replacing its JSON file.
 */
export class NotificationInboxStore {
  private readonly filePath: string
  private readonly now: () => string
  private readonly idFactory: () => string
  private state: NotificationInboxState = clone(EMPTY_STATE)
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private mutationChain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(snapshot: NotificationInboxSnapshot) => void>()

  constructor(
    stateDirectory: string,
    private readonly options: NotificationInboxStoreOptions = {},
  ) {
    this.filePath = join(stateDirectory, options.fileName ?? 'notification-inbox.json')
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        const normalized = normalizeNotificationInboxSnapshot(parsed)
        if (normalized === undefined) throw new Error('Unsupported notification inbox state')
        this.state = { version: 1, items: normalized.items.map(clone) }
      } catch (error) {
        if (!isNotFound(error)) throw error
        this.state = clone(EMPTY_STATE)
      }
      this.initialized = true
    })()
    this.initializationPromise = pending
    try {
      await pending
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined
    }
  }

  async list(): Promise<NotificationInboxItem[]> {
    this.assertInitialized()
    return this.state.items.map(clone)
  }

  async snapshot(): Promise<NotificationInboxSnapshot> {
    this.assertInitialized()
    return snapshotFromState(this.state)
  }

  /** Subscribe to successful durable changes. Listener failures are isolated. */
  onChanged(listener: (snapshot: NotificationInboxSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async append(signal: NotificationSignal): Promise<NotificationInboxAppendResult> {
    const normalized = normalizeNotificationSignal(signal)
    if (normalized === undefined) throw new Error('Invalid notification signal')
    return this.mutate(async () => {
      const existing = this.state.items.find((item) => item.signal.dedupeKey === normalized.dedupeKey)
      if (existing !== undefined) return { item: clone(existing), appended: false }

      const id = this.idFactory()
      if (typeof id !== 'string' || id.trim() === '' || id.trim().length > NOTIFICATION_INBOX_ITEM_ID_MAX_LENGTH) {
        throw new Error('Notification inbox item id is invalid')
      }
      if (this.state.items.some((item) => item.id === id.trim())) throw new Error('Notification inbox item id already exists')
      const item: NotificationInboxItem = {
        id: id.trim(),
        signal: normalized,
        createdAt: this.now(),
      }
      const items = [...this.state.items, item].slice(-NOTIFICATION_INBOX_MAX_ITEMS)
      await this.commit({ version: 1, items })
      this.emit()
      return { item: clone(item), appended: true }
    })
  }

  async markRead(id: string): Promise<NotificationInboxItem | undefined> {
    return this.mutate(async () => {
      const index = this.state.items.findIndex((item) => item.id === id)
      if (index < 0) return undefined
      const current = this.state.items[index]
      if (current.readAt !== undefined) return clone(current)
      const item: NotificationInboxItem = { ...clone(current), readAt: this.now() }
      const items = this.state.items.slice()
      items[index] = item
      await this.commit({ version: 1, items })
      this.emit()
      return clone(item)
    })
  }

  async dismiss(id: string): Promise<NotificationInboxItem | undefined> {
    return this.mutate(async () => {
      const index = this.state.items.findIndex((item) => item.id === id)
      if (index < 0) return undefined
      const current = this.state.items[index]
      if (current.dismissedAt !== undefined) return clone(current)
      const item: NotificationInboxItem = { ...clone(current), dismissedAt: this.now() }
      const items = this.state.items.slice()
      items[index] = item
      await this.commit({ version: 1, items })
      this.emit()
      return clone(item)
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized()
    const result = this.mutationChain.then(operation, operation)
    this.mutationChain = result.then(() => undefined, () => undefined)
    return result
  }

  private async commit(next: NotificationInboxState): Promise<void> {
    const items = next.items.map(clone).slice(-NOTIFICATION_INBOX_MAX_ITEMS)
    const state: NotificationInboxState = { version: 1, items }
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const serialized = `${JSON.stringify(state, null, 2)}\n`
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      if (this.options.writeFile) await this.options.writeFile(temporaryPath, serialized)
      else await writeFile(temporaryPath, serialized, { mode: 0o600 })
      await chmod(temporaryPath, 0o600)
      if (this.options.rename) await this.options.rename(temporaryPath, this.filePath)
      else await rename(temporaryPath, this.filePath)
      await chmod(this.filePath, 0o600)
      this.state = state
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private emit(): void {
    const snapshot = snapshotFromState(this.state)
    for (const listener of this.listeners) {
      try {
        listener(clone(snapshot))
      } catch {
        // The durable mutation already succeeded; observers cannot alter it.
      }
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('NotificationInboxStore must be initialized before use')
  }
}
