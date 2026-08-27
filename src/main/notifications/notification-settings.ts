import { readFile, writeFile } from 'node:fs/promises'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
  type NotificationSettings,
} from '../../shared/notifications.js'

/** Load notification preferences from the workspace state directory. */
export async function readNotificationSettings(filePath: string): Promise<NotificationSettings> {
  try {
    return normalizeNotificationSettings(JSON.parse(await readFile(filePath, 'utf8')) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_NOTIFICATION_SETTINGS }
    throw error
  }
}

/** Persist normalized notification preferences as a permission-restricted state file. */
export async function writeNotificationSettings(filePath: string, settings: NotificationSettings): Promise<void> {
  await writeFile(
    filePath,
    `${JSON.stringify(normalizeNotificationSettings(settings), null, 2)}\n`,
    { mode: 0o600 },
  )
}
