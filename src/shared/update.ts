export const STABLE_UPDATE_FEED_URL = 'https://update.ezdsh.com/updates/'
export const PREVIEW_UPDATE_FEED_URL = 'https://update.ezdsh.com/updates/preview/'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'failed'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  percent?: number
  message?: string
  lastCheckedAt?: string
}
