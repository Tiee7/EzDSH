export const STABLE_UPDATE_FEED_URL = 'https://update.ezdsh.com/updates/'
export const PREVIEW_UPDATE_FEED_URL = 'https://update.ezdsh.com/updates/preview/'
export const UPDATE_RESOLVE_URL = 'https://update.ezdsh.com/api/update/resolve'

export type UpdateCheckTrigger = 'startup' | 'manual'
export type UpdateChannel = 'stable' | 'preview'

export interface UpdateResolution {
  success: boolean
  feedUrl?: string
  fallbackFeedUrl?: string
  platform?: string
  arch?: string
  currentVersion?: string
  latestVersion?: string
  updateAvailable?: boolean
  trigger?: UpdateCheckTrigger
  language?: string
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'preparing'
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
