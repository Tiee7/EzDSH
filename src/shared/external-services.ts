/** User-managed processes that may optionally start after the DSH Runtime is ready. */
export const EXTERNAL_SERVICE_STATES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
  'exited',
] as const

export type ExternalServiceState = (typeof EXTERNAL_SERVICE_STATES)[number]

export interface ExternalServiceDefinition {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  autoStart: boolean
}

/** Evidence from the current startup attempt, never persisted as service configuration. */
export interface ExternalServiceStartupIssue {
  code: 'cwd-missing' | 'cwd-not-directory' | 'cwd-inaccessible'
    | 'command-not-found' | 'command-not-executable' | 'command-unavailable' | 'unknown'
  path?: string
}

export interface ExternalServiceSnapshot extends ExternalServiceDefinition {
  state: ExternalServiceState
  pid?: number
  exitCode?: number | null
  signal?: string
  error?: string
  startupIssue?: ExternalServiceStartupIssue
}

export type ExternalServiceCreateInput = Omit<ExternalServiceDefinition, 'id'> & { id?: string }
export type ExternalServiceUpdateInput = Partial<Omit<ExternalServiceDefinition, 'id'>>
