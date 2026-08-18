export interface AdapterConfig {
  /** Platform-specific settings. */
  [key: string]: unknown
  /** Whether this adapter is enabled. */
  enabled?: boolean
  /** Target DSH session ID for this adapter. Falls back to the global sessionId. */
  sessionId?: string
  /** Whitelisted user IDs for this adapter. Falls back to the global allowList. */
  allowList?: string[]
}

export interface ChannelBridgeConfig {
  /** Adapter-specific configurations keyed by adapter name. */
  adapters: Record<string, AdapterConfig>
  /** Global fallback target DSH session ID. */
  sessionId?: string
  /** Global fallback whitelist. */
  allowList?: string[]
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
