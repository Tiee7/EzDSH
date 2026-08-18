import * as lark from '@larksuiteoapi/node-sdk'
import type { ChannelAdapter, ChannelMessage, ChannelReply, FeishuConfig } from './types.js'

export interface FeishuAdapterOptions {
  config: FeishuConfig
  allowList: string[]
  logger?: {
    info(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
  }
}

export class FeishuAdapter implements ChannelAdapter {
  readonly name = 'feishu'

  private readonly config: FeishuConfig
  private readonly allowList: Set<string>
  private readonly logger: NonNullable<FeishuAdapterOptions['logger']>
  private messageHandler?: (message: ChannelMessage) => Promise<ChannelReply | undefined>
  private client?: lark.Client
  private wsClient?: lark.WSClient
  private eventDispatcher?: lark.EventDispatcher

  constructor(private readonly options: FeishuAdapterOptions) {
    this.config = options.config
    this.allowList = new Set(options.allowList)
    this.logger = options.logger ?? console
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

  async handleReceiveEvent(event: FeishuMessageEvent): Promise<ChannelReply | undefined> {
    const message = this.normalizeMessage(event)
    if (message === undefined || message.chat === undefined) {
      return undefined
    }

    this.logger.info(
      `[channel-bridge:feishu] message from ${message.from.id} in ${message.chat.id}: ${message.content.text}`,
    )

    if (!this.allowList.has(message.from.id)) {
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
}

export interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      union_id?: string
      user_id?: string
      open_id?: string
      name?: string
    }
    sender_type?: string
    tenant_key?: string
  }
  message?: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time?: string
    update_time?: string
    chat_id: string
    thread_id?: string
    chat_type: string
    message_type?: string
    content: string
    mentions?: unknown[]
    user_agent?: string
    lark_agent_context?: unknown
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
