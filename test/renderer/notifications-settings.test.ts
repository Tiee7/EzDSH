import { describe, expect, it } from 'vitest'
import { SETTINGS_TAB_IDS } from '../../src/renderer/settings/settings-navigation.js'
import { notificationPreviewSound } from '../../src/renderer/notifications/audio.js'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/shared/notifications.js'

describe('notification settings navigation', () => {
  it('places Notifications directly below General', () => {
    expect(SETTINGS_TAB_IDS.slice(0, 2)).toEqual(['general', 'notifications'])
  })
})

describe('notification sound preview', () => {
  it('selects the configured sound even when the event is disabled', () => {
    const settings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      taskOn: false,
      taskSound: 'bell' as const,
    }

    expect(notificationPreviewSound(settings, 'task')).toBe('bell')
  })
})
