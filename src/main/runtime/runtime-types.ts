export type RuntimePhase = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
export type RuntimeMode = 'normal' | 'safe'

export interface RuntimeSnapshot {
  phase: RuntimePhase
  mode: RuntimeMode
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
