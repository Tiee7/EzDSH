import type { AppLocale } from './locale.js'

/** Shared notification vocabulary used by the Runtime observer and both UI surfaces. */

/** The six user-facing notification events. */
export const NOTIFICATION_EVENT_IDS = ['question', 'approval', 'task', 'job', 'subagent', 'error'] as const
export type NotificationEventId = (typeof NOTIFICATION_EVENT_IDS)[number]

/** Twenty short sounds synthesized locally with WebAudio. */
export const SOUND_IDS = [
  'soft-ping',
  'blip',
  'tick',
  'pulse',
  'bubble-pop',
  'double-pop',
  'plop',
  'bloop',
  'wobble',
  'chime',
  'bell',
  'crystal',
  'music-box',
  'wind-chime',
  'rise',
  'complete',
  'climb',
  'sparkle',
  'alert',
  'knock',
] as const
export type SoundId = (typeof SOUND_IDS)[number]

/** Persisted notification preferences. */
export interface NotificationSettings {
  master: boolean
  nativeOn: boolean
  volume: number
  questionOn: boolean
  questionSound: SoundId
  approvalOn: boolean
  approvalSound: SoundId
  taskOn: boolean
  taskSound: SoundId
  jobOn: boolean
  jobSound: SoundId
  subagentOn: boolean
  subagentSound: SoundId
  errorOn: boolean
  errorSound: SoundId
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  master: true,
  nativeOn: true,
  volume: 100,
  questionOn: true,
  questionSound: 'chime',
  approvalOn: true,
  approvalSound: 'pulse',
  taskOn: true,
  taskSound: 'complete',
  jobOn: true,
  jobSound: 'sparkle',
  subagentOn: false,
  subagentSound: 'soft-ping',
  errorOn: true,
  errorSound: 'alert',
}

/** A notification raised by the DSH Runtime event stream. */
export interface NotificationSignal {
  event: NotificationEventId
  sessionId: string
  /** A short command, question, job label, or error message when available. */
  detail?: string
  /** Stable within the Runtime stream; used to prevent replay duplicates. */
  dedupeKey: string
}

/**
 * Limits for the durable inbox. Notification details originate in a Runtime
 * event stream, so they must remain bounded before they cross the persistence
 * boundary. The inbox is intentionally small and is an attention surface,
 * rather than an event log.
 */
export const NOTIFICATION_INBOX_MAX_ITEMS = 200 as const
export const NOTIFICATION_SESSION_ID_MAX_LENGTH = 512 as const
export const NOTIFICATION_DEDUPE_KEY_MAX_LENGTH = 512 as const
export const NOTIFICATION_DETAIL_MAX_LENGTH = 4_000 as const
export const NOTIFICATION_INBOX_ITEM_ID_MAX_LENGTH = 128 as const

/** A notification retained in the Main-owned durable attention inbox. */
export interface NotificationInboxItem {
  id: string
  signal: NotificationSignal
  createdAt: string
  readAt?: string
  dismissedAt?: string
}

/** Durable inbox state exposed to the Renderer and change listeners. */
export interface NotificationInboxSnapshot {
  version: 1
  items: NotificationInboxItem[]
  unreadCount: number
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > maximum ? trimmed.slice(0, maximum) : trimmed
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) return undefined
  return value
}

function notificationEventValue(value: unknown): NotificationEventId | undefined {
  return typeof value === 'string' && (NOTIFICATION_EVENT_IDS as readonly string[]).includes(value)
    ? value as NotificationEventId
    : undefined
}

/** Normalize a Runtime signal before it is persisted or sent across IPC. */
export function normalizeNotificationSignal(value: unknown): NotificationSignal | undefined {
  if (!isRecord(value)) return undefined
  const event = notificationEventValue(value.event)
  const sessionId = boundedText(value.sessionId, NOTIFICATION_SESSION_ID_MAX_LENGTH)
  const dedupeKey = boundedText(value.dedupeKey, NOTIFICATION_DEDUPE_KEY_MAX_LENGTH)
  if (event === undefined || sessionId === undefined || dedupeKey === undefined) return undefined
  const detail = value.detail === undefined ? undefined : boundedText(value.detail, NOTIFICATION_DETAIL_MAX_LENGTH)
  return {
    event,
    sessionId,
    ...(detail === undefined ? {} : { detail }),
    dedupeKey,
  }
}

/** Normalize one persisted inbox item; malformed entries are rejected. */
export function normalizeNotificationInboxItem(value: unknown): NotificationInboxItem | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, NOTIFICATION_INBOX_ITEM_ID_MAX_LENGTH)
  const signal = normalizeNotificationSignal(value.signal)
  const createdAt = timestampValue(value.createdAt)
  if (id === undefined || signal === undefined || createdAt === undefined) return undefined
  const readAt = value.readAt === undefined ? undefined : timestampValue(value.readAt)
  const dismissedAt = value.dismissedAt === undefined ? undefined : timestampValue(value.dismissedAt)
  if ((value.readAt !== undefined && readAt === undefined) || (value.dismissedAt !== undefined && dismissedAt === undefined)) return undefined
  return {
    id,
    signal,
    createdAt,
    ...(readAt === undefined ? {} : { readAt }),
    ...(dismissedAt === undefined ? {} : { dismissedAt }),
  }
}

/** Normalize durable inbox JSON and enforce retention and dedupe invariants. */
export function normalizeNotificationInboxSnapshot(value: unknown): NotificationInboxSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return undefined
  const items: NotificationInboxItem[] = []
  const ids = new Set<string>()
  const dedupeKeys = new Set<string>()
  for (const candidate of value.items) {
    const item = normalizeNotificationInboxItem(candidate)
    if (item === undefined || ids.has(item.id) || dedupeKeys.has(item.signal.dedupeKey)) continue
    ids.add(item.id)
    dedupeKeys.add(item.signal.dedupeKey)
    items.push(item)
  }
  const retained = items.slice(-NOTIFICATION_INBOX_MAX_ITEMS)
  return {
    version: 1,
    items: retained,
    unreadCount: retained.reduce((count, item) => count + (item.readAt === undefined && item.dismissedAt === undefined ? 1 : 0), 0),
  }
}

export interface NotificationText {
  title: string
  body: string
  review: string
}

/** Localized copy for the native desktop notification surface. */
export function getNotificationText(locale: AppLocale, notification: NotificationSignal): NotificationText {
  if (locale === 'zh') {
    switch (notification.event) {
      case 'question':
        return { title: 'Agent 等待你的回答', body: notification.detail ?? 'Agent 正在等待你的回答。', review: '查看' }
      case 'approval':
        return { title: 'Agent 需要批准', body: notification.detail === undefined ? '有一个工具调用等待批准。' : `运行：\n${notification.detail}`, review: '查看' }
      case 'task':
        return { title: '回合已完成', body: 'Agent 已完成当前回合。', review: '查看' }
      case 'job':
        return { title: '后台任务已完成', body: notification.detail ?? '后台任务已完成。', review: '查看' }
      case 'subagent':
        return { title: '子 Agent 已完成', body: '一个子 Agent 已完成工作。', review: '查看' }
      case 'error':
        return { title: 'EzDSH 出错', body: notification.detail ?? '当前回合遇到错误。', review: '查看' }
    }
  }

  switch (notification.event) {
    case 'question':
      return { title: 'Agent needs your answer', body: notification.detail ?? 'The agent is waiting for your answer.', review: 'Review' }
    case 'approval':
      return { title: 'Agent needs approval', body: notification.detail === undefined ? 'A tool call is waiting for your approval.' : `Run:\n${notification.detail}`, review: 'Review' }
    case 'task':
      return { title: 'Turn complete', body: 'The agent finished the current turn.', review: 'Review' }
    case 'job':
      return { title: 'Background job finished', body: notification.detail ?? 'A background job finished.', review: 'Review' }
    case 'subagent':
      return { title: 'Subagent finished', body: 'A subagent finished its work.', review: 'Review' }
    case 'error':
      return { title: 'EzDSH error', body: notification.detail ?? 'The current turn ended with an error.', review: 'Review' }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function volumeValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(100, Math.round(value)))
}

function soundValue(value: unknown, fallback: SoundId): SoundId {
  return typeof value === 'string' && (SOUND_IDS as readonly string[]).includes(value)
    ? value as SoundId
    : fallback
}

/** Normalize a JSON value read from disk or received across IPC. */
export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const source = isRecord(value) ? value : {}
  return {
    master: booleanValue(source.master, DEFAULT_NOTIFICATION_SETTINGS.master),
    nativeOn: booleanValue(source.nativeOn, DEFAULT_NOTIFICATION_SETTINGS.nativeOn),
    volume: volumeValue(source.volume, DEFAULT_NOTIFICATION_SETTINGS.volume),
    questionOn: booleanValue(source.questionOn, DEFAULT_NOTIFICATION_SETTINGS.questionOn),
    questionSound: soundValue(source.questionSound, DEFAULT_NOTIFICATION_SETTINGS.questionSound),
    approvalOn: booleanValue(source.approvalOn, DEFAULT_NOTIFICATION_SETTINGS.approvalOn),
    approvalSound: soundValue(source.approvalSound, DEFAULT_NOTIFICATION_SETTINGS.approvalSound),
    taskOn: booleanValue(source.taskOn, DEFAULT_NOTIFICATION_SETTINGS.taskOn),
    taskSound: soundValue(source.taskSound, DEFAULT_NOTIFICATION_SETTINGS.taskSound),
    jobOn: booleanValue(source.jobOn, DEFAULT_NOTIFICATION_SETTINGS.jobOn),
    jobSound: soundValue(source.jobSound, DEFAULT_NOTIFICATION_SETTINGS.jobSound),
    subagentOn: booleanValue(source.subagentOn, DEFAULT_NOTIFICATION_SETTINGS.subagentOn),
    subagentSound: soundValue(source.subagentSound, DEFAULT_NOTIFICATION_SETTINGS.subagentSound),
    errorOn: booleanValue(source.errorOn, DEFAULT_NOTIFICATION_SETTINGS.errorOn),
    errorSound: soundValue(source.errorSound, DEFAULT_NOTIFICATION_SETTINGS.errorSound),
  }
}
