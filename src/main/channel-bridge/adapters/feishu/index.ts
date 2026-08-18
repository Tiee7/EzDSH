import * as lark from '@larksuiteoapi/node-sdk'
import type {
  ChannelAdapter,
  ChannelAdapterCreateOptions,
  ChannelAdapterFactory,
  ChannelMessage,
  ChannelMessageStatus,
  ChannelReply,
  Logger,
} from '../../types.js'
import type { FeishuConfig, FeishuMessageEvent } from './types.js'

export * from './types.js'

export interface FeishuAdapterOptions extends ChannelAdapterCreateOptions {
  config: FeishuConfig
}

const PROCESSING_EMOJI = 'RUNNING'
const ERROR_EMOJI = 'CROSS'

export class FeishuAdapter implements ChannelAdapter {
  readonly name = 'feishu'

  private readonly config: FeishuConfig
  private allowList: Set<string>
  private readonly logger: Logger
  private messageHandler?: (message: ChannelMessage) => Promise<ChannelReply | undefined>
  private client?: lark.Client
  private wsClient?: lark.WSClient
  private eventDispatcher?: lark.EventDispatcher
  /** Tracks reaction_id for each (messageId, emojiType) so we can delete it later. */
  private reactionIds = new Map<string, string>()

  constructor(private readonly options: FeishuAdapterOptions) {
    this.config = options.config
    this.allowList = new Set(options.allowList)
    this.logger = options.logger
  }

  onMessage(handler: (message: ChannelMessage) => Promise<ChannelReply | undefined>): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    await this.stop()

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })

    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.config.encryptKey,
      loggerLevel: lark.LoggerLevel.warn,
    }).register({
      'im.message.receive_v1': async (data) => {
        const reply = await this.handleReceiveEvent(data as FeishuMessageEvent)
        if (reply !== undefined) {
          await this.send(reply)
        }
      },
    })

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => {
        this.logger.info('[channel-bridge:feishu] long connection ready')
      },
      onError: (err) => {
        this.logger.error('[channel-bridge:feishu] long connection error:', err.message)
      },
      onReconnecting: () => {
        this.logger.warn('[channel-bridge:feishu] long connection reconnecting')
      },
      onReconnected: () => {
        this.logger.info('[channel-bridge:feishu] long connection reconnected')
      },
    })

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher })
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: false })
    this.wsClient = undefined
    this.eventDispatcher = undefined
    this.client = undefined
  }

  updateAllowList(allowList: string[]): void {
    this.allowList = new Set(allowList)
  }

  async send(reply: ChannelReply): Promise<void> {
    if (this.client === undefined) {
      throw new Error('Feishu adapter is not started')
    }

    const receiveId = reply.to.userId ?? reply.to.chatId
    if (receiveId === undefined) {
      throw new Error('Feishu reply requires userId or chatId')
    }

    const receiveIdType = reply.to.userId !== undefined ? 'open_id' : 'chat_id'

    const response = await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: reply.content }),
      },
    })

    if (response.code !== 0) {
      throw new Error(`Feishu send message failed: ${response.code} ${response.msg}`)
    }
  }

  async setStatus(messageId: string, status: ChannelMessageStatus): Promise<void> {
    if (this.client === undefined) {
      throw new Error('Feishu adapter is not started')
    }

    if (messageId === '') {
      return
    }

    if (status === 'processing') {
      await this.addReaction(messageId, PROCESSING_EMOJI)
    } else if (status === 'done') {
      await this.removeReaction(messageId, PROCESSING_EMOJI)
    } else if (status === 'error') {
      await this.removeReaction(messageId, PROCESSING_EMOJI)
      await this.addReaction(messageId, ERROR_EMOJI)
    }
    // 'received' does not need a visible reaction.
  }

  private reactionKey(messageId: string, emojiType: string): string {
    return `${messageId}:${emojiType}`
  }

  async handleReceiveEvent(event: FeishuMessageEvent): Promise<ChannelReply | undefined> {
    const message = this.normalizeMessage(event)
    if (message === undefined || message.chat === undefined) {
      return undefined
    }

    this.logger.info(
      `[channel-bridge:feishu] message from ${message.from.id} in ${message.chat.id}: ${message.content.text}`,
    )

    if (!this.allowList.has(message.from.id)) {
      const customReply = await this.options.onUnauthorizedMessage?.(message)
      if (customReply !== undefined) {
        return customReply
      }
      return {
        to: { userId: message.chat.type === 'private' ? message.from.id : undefined },
        content: '你不在白名单中，无法使用远程控制。',
      }
    }

    const handler = this.messageHandler
    if (handler === undefined) {
      return undefined
    }

    return await handler(message)
  }

  private normalizeMessage(event: FeishuMessageEvent): ChannelMessage | undefined {
    const senderId = event.sender?.sender_id
    const message = event.message
    if (senderId === undefined || message === undefined) {
      return undefined
    }

    const openId = senderId.open_id
    if (openId === undefined) {
      return undefined
    }

    const chatType = message.chat_type === 'p2p' ? 'private' : 'group'
    const chatId = message.chat_id
    const content = parseFeishuContent(message.content)

    return {
      adapter: this.name,
      messageId: message.message_id ?? '',
      from: { id: openId, name: senderId.name },
      chat: { id: chatId, type: chatType },
      content: { type: 'text', text: content },
      timestamp: Date.now(),
    }
  }

  private async addReaction(messageId: string, emojiType: string): Promise<void> {
    if (this.client === undefined) return
    try {
      const response = (await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })) as { code: number; msg?: string; data?: { reaction_id?: string } }
      if (response.code !== 0) {
        this.logger.warn(`[channel-bridge:feishu] add reaction failed: ${response.code} ${response.msg}`)
        return
      }
      const reactionId = response.data?.reaction_id
      if (reactionId !== undefined) {
        this.reactionIds.set(this.reactionKey(messageId, emojiType), reactionId)
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      this.logger.warn(`[channel-bridge:feishu] add reaction error: ${messageText}`)
    }
  }

  private async removeReaction(messageId: string, emojiType: string): Promise<void> {
    if (this.client === undefined) return
    const key = this.reactionKey(messageId, emojiType)
    const reactionId = this.reactionIds.get(key)
    if (reactionId === undefined) {
      // We can only delete a reaction if we previously recorded its reaction_id.
      return
    }
    try {
      const response = (await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })) as { code: number; msg?: string }
      if (response.code !== 0) {
        this.logger.warn(`[channel-bridge:feishu] remove reaction failed: ${response.code} ${response.msg}`)
        return
      }
      this.reactionIds.delete(key)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      this.logger.warn(`[channel-bridge:feishu] remove reaction error: ${messageText}`)
    }
  }
}

function parseFeishuContent(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed.text ?? ''
  } catch {
    return raw
  }
}

export const feishuAdapterFactory: ChannelAdapterFactory = {
  name: 'feishu',
  create(options: ChannelAdapterCreateOptions): ChannelAdapter {
    return new FeishuAdapter({ ...options, config: options.config as FeishuConfig })
  },
}
