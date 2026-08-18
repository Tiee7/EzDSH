export interface ChannelBridgeConfig {
  enabled: boolean
  /** Adapter-specific configurations keyed by adapter name. */
  adapters: Record<string, unknown>
  /** Target DSH session ID. If empty, a new session is created on first message. */
  sessionId?: string
  allowList: string[]
  workspace?: string
  timeoutMs: number
  /** How long to wait for the DSH session to finish a turn (ms). */
  sessionTimeoutMs?: number
  /** How often to send a progress update while a turn is running (ms). */
  statusIntervalMs?: number
}

export interface DshSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank?: boolean
  title?: string
}

export interface PairingState {
  /** Whether a pairing challenge is currently active. */
  active: boolean
  /** The 6-digit code the user must send to the bot, if active. */
  code?: string
  /** ISO timestamp when the challenge expires. */
  expiresAt?: string
}
