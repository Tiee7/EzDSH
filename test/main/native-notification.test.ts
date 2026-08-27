import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSignal,
  type NotificationSettings,
} from '../../src/shared/notifications.js'
import { NativeNotificationService } from '../../src/main/notifications/native-notification-service.js'

interface FakeNotification {
  options: Record<string, unknown>
  shown: boolean
  on(event: 'click' | 'action', listener: (...args: unknown[]) => void): FakeNotification
  show(): void
  click(): void
  action(): void
}

function createFakeNotificationFactory(list: FakeNotification[]) {
  return (options: Record<string, unknown>): FakeNotification => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const notification: FakeNotification = {
      options,
      shown: false,
      click: () => listeners.get('click')?.(),
      action: () => listeners.get('action')?.({}, 0),
    }
    Object.assign(notification, {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
        return notification
      },
      show: () => { notification.shown = true },
    })
    list.push(notification)
    return notification
  }
}

describe('NativeNotificationService', () => {
  it('shows an approval notification with a review action and routes clicks back to the session', () => {
    const notifications: FakeNotification[] = []
    const review = vi.fn()
    const service = new NativeNotificationService({
      createNotification: createFakeNotificationFactory(notifications),
      getSettings: () => DEFAULT_NOTIFICATION_SETTINGS,
      getLocale: () => 'en',
      onReview: review,
    })
    const signal: NotificationSignal = {
      event: 'approval',
      sessionId: 'session-1',
      detail: 'npm publish',
      dedupeKey: 'approval:session-1:approval-1',
    }

    service.notify(signal)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].options).toMatchObject({
      title: 'Agent needs approval',
      body: 'Run:\nnpm publish',
      silent: true,
      actions: [{ type: 'button', text: 'Review' }],
    })
    expect(notifications[0].shown).toBe(true)

    notifications[0].click()
    expect(review).toHaveBeenCalledWith('session-1')
  })

  it('does not show disabled event types or when desktop notifications are off', () => {
    const notifications: FakeNotification[] = []
    const settings: NotificationSettings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      taskOn: false,
    }
    const service = new NativeNotificationService({
      createNotification: createFakeNotificationFactory(notifications),
      getSettings: () => settings,
      getLocale: () => 'en',
      onReview: vi.fn(),
    })

    service.notify({ event: 'task', sessionId: 'session-1', dedupeKey: 'task:1' })

    expect(notifications).toHaveLength(0)

    service.notify({ event: 'approval', sessionId: 'session-1', dedupeKey: 'approval:1' })
    expect(notifications).toHaveLength(1)

    const mutedService = new NativeNotificationService({
      createNotification: createFakeNotificationFactory(notifications),
      getSettings: () => ({ ...settings, nativeOn: false }),
      getLocale: () => 'en',
      onReview: vi.fn(),
    })
    mutedService.notify({ event: 'approval', sessionId: 'session-1', dedupeKey: 'approval:2' })
    expect(notifications).toHaveLength(1)
  })
})
