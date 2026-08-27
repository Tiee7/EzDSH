import {
  getNotificationText,
  type NotificationEventId,
  type NotificationSettings,
  type NotificationSignal,
} from '../../shared/notifications.js'
import type { AppLocale } from '../../shared/locale.js'

export interface NativeNotificationOptions {
  title: string
  body: string
  silent: boolean
  actions?: Array<{ type: 'button'; text: string }>
}

export interface NativeNotificationLike {
  on(event: 'click', listener: () => void): NativeNotificationLike
  on(event: 'action', listener: (event: unknown, index: number) => void): NativeNotificationLike
  show(): void
}

export interface NativeNotificationServiceOptions {
  createNotification(options: NativeNotificationOptions): NativeNotificationLike
  getSettings(): NotificationSettings
  getLocale(): AppLocale
  onReview(sessionId: string): void
}

function eventEnabled(settings: NotificationSettings, event: NotificationEventId): boolean {
  switch (event) {
    case 'question': return settings.questionOn
    case 'approval': return settings.approvalOn
    case 'task': return settings.taskOn
    case 'job': return settings.jobOn
    case 'subagent': return settings.subagentOn
    case 'error': return settings.errorOn
  }
}

/** Presents Runtime signals as native OS notifications when the user enables them. */
export class NativeNotificationService {
  constructor(private readonly options: NativeNotificationServiceOptions) {}

  notify(notification: NotificationSignal): void {
    const settings = this.options.getSettings()
    if (!settings.nativeOn || !eventEnabled(settings, notification.event)) return

    const text = getNotificationText(this.options.getLocale(), notification)
    const canReview = notification.sessionId !== 'runtime'
    const needsReview = canReview && (notification.event === 'question' || notification.event === 'approval')
    const nativeOptions: NativeNotificationOptions = {
      title: text.title,
      body: text.body,
      silent: true,
      ...(needsReview ? { actions: [{ type: 'button', text: text.review }] } : {}),
    }

    try {
      const nativeNotification = this.options.createNotification(nativeOptions)
      const review = () => this.options.onReview(notification.sessionId)
      if (canReview) nativeNotification.on('click', review)
      if (needsReview) nativeNotification.on('action', review)
      nativeNotification.show()
    } catch (error) {
      console.warn('[notifications] unable to show native notification:', error instanceof Error ? error.message : String(error))
    }
  }
}
