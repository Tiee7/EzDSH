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

export interface DshRuntimeProcess {
  pid: number
  ppid: number
  pgid?: number
  port?: number
  startedAt?: string
  command: string
  current: boolean
  ownedByEzDSH: boolean
}
