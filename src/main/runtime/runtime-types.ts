export type RuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export interface RuntimeSnapshot {
  phase: RuntimePhase
  pid?: number
  port?: number
  url?: string
  launchDirectory: string
  logPath: string
  startedAt?: string
  message?: string
}
