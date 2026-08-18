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

export type ChannelMessageStatus = 'received' | 'processing' | 'done' | 'error'

/** Logger interface used by adapters. */
export interface Logger {
  info(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Every adapter must implement this interface. */
export interface ChannelAdapter {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(reply: ChannelReply): Promise<void>
  /** Update the runtime allowlist without restarting the adapter. */
  updateAllowList(allowList: string[]): void
  /** Optional: mark the processing status of a message on the platform. */
  setStatus?(messageId: string, status: ChannelMessageStatus): Promise<void>
}

export interface ChannelAdapterCreateOptions {
  config: unknown
  allowList: string[]
  logger: Logger
  /** Invoked for messages from users not in the allowlist. Return a reply to override the default deny message. */
  onUnauthorizedMessage?: (message: ChannelMessage) => Promise<ChannelReply | undefined>
}

export interface ChannelAdapterFactory {
  readonly name: string
  create(options: ChannelAdapterCreateOptions): ChannelAdapter
}

export type { ChannelBridgeConfig } from '../../shared/channel-bridge.js'
import type { ChannelBridgeConfig } from '../../shared/channel-bridge.js'

export const DEFAULT_CHANNEL_BRIDGE_CONFIG: ChannelBridgeConfig = {
  enabled: false,
  adapters: {},
  allowList: [],
  timeoutMs: 120_000,
  sessionTimeoutMs: 300_000,
  statusIntervalMs: 60_000,
}
