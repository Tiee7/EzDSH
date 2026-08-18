export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey?: string
}

export interface ChannelBridgeConfig {
  enabled: boolean
  feishu?: FeishuConfig
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
