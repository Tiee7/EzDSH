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
