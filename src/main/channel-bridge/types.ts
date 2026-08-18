/**
 * Channel Bridge types.
 *
 * Design follows OpenClaw's channel-plugin pattern: a thin gateway plus
 * platform-specific adapters that all speak the same message shape.
 */

export interface ChannelMessage {
  /** Platform adapter that produced this message. */
  adapter: string
  /** Opaque message id from the platform. */
  messageId: string
  /** Sender identity on the platform. */
  from: {
    id: string
    name?: string
  }
  /** Conversation context (group or private). */
  chat?: {
    id: string
    type: 'private' | 'group'
    name?: string
  }
  /** Normalized content. */
  content: {
    type: 'text'
    text: string
  }
  /** Unix timestamp in milliseconds. */
  timestamp: number
}

export interface ChannelReply {
  /** Recipient on the platform. */
  to: {
    userId?: string
    chatId?: string
  }
  /** Plain-text reply. */
  content: string
  /** Optional platform-specific hints. */
  options?: {
    /** Mention these user ids in the reply. */
    mention?: string[]
    /** Reply to a specific platform message id. */
    replyToMessageId?: string
  }
}

/** Every adapter must implement this interface. */
export interface ChannelAdapter {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(reply: ChannelReply): Promise<void>
}

export type { ChannelBridgeConfig, FeishuConfig } from '../../shared/channel-bridge.js'
import type { ChannelBridgeConfig } from '../../shared/channel-bridge.js'

export const DEFAULT_CHANNEL_BRIDGE_CONFIG: ChannelBridgeConfig = {
  enabled: false,
  allowList: [],
  timeoutMs: 120_000,
  sessionTimeoutMs: 300_000,
}
