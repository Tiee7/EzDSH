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
}
