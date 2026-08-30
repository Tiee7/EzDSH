import { describe, expect, it } from 'vitest'
import { SETTINGS_TAB_IDS } from '../../src/renderer/settings/settings-navigation.js'
import { notificationPreviewSound } from '../../src/renderer/notifications/audio.js'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/shared/notifications.js'
import { recoveryDeleteApiAvailable, recoveryVerificationLabel } from '../../src/renderer/settings/RecoverySection.js'
import { getAppCopy } from '../../src/shared/locale.js'

describe('notification settings navigation', () => {
  it('includes Network proxy as a separate settings tab', () => {
    expect(SETTINGS_TAB_IDS).toContain('proxy')
  })

  it('labels the Notifications tab as Notifications and messages', () => {
    expect(getAppCopy('zh').settingsTabNotifications).toBe('通知和消息')
  })

  it('places Backup & recovery directly below Notifications', () => {
    expect(SETTINGS_TAB_IDS.slice(1, 3)).toEqual(['notifications', 'recovery'])
  })

  it('places Session management directly below Backup & recovery', () => {
    expect(SETTINGS_TAB_IDS.slice(2, 4)).toEqual(['recovery', 'sessions'])
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

describe('recovery verification action', () => {
  it('changes the action label to the result for the verified snapshot', () => {
    const copy = getAppCopy('zh')

    expect(recoveryVerificationLabel(copy, 'snapshot-a', undefined)).toBe('校验备份')
    expect(recoveryVerificationLabel(copy, 'snapshot-a', {
      ok: true,
      snapshotName: 'snapshot-a',
      expectedSha256: 'expected',
      actualSha256: 'expected',
    })).toBe('校验通过')
    expect(recoveryVerificationLabel(copy, 'snapshot-b', {
      ok: true,
      snapshotName: 'snapshot-a',
      expectedSha256: 'expected',
      actualSha256: 'expected',
    })).toBe('校验备份')
  })

  it('detects when an older Preload bridge cannot delete snapshots', () => {
    expect(recoveryDeleteApiAvailable(undefined)).toBe(false)
    expect(recoveryDeleteApiAvailable(() => Promise.resolve())).toBe(true)
  })
})
