import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/shared/notifications.js'
import { readNotificationSettings, writeNotificationSettings } from '../../src/main/notifications/notification-settings.js'

describe('notification settings persistence', () => {
  it('defaults missing settings and persists normalized values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-notifications-'))
    const filePath = join(directory, 'notifications.json')

    try {
      await expect(readNotificationSettings(filePath)).resolves.toEqual(DEFAULT_NOTIFICATION_SETTINGS)
      await writeNotificationSettings(filePath, {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        volume: 120,
        approvalSound: 'bell',
      })

      expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ volume: 100, approvalSound: 'bell' })
      await expect(readNotificationSettings(filePath)).resolves.toMatchObject({ volume: 100, approvalSound: 'bell' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
