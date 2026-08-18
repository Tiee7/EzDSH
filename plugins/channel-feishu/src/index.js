import * as lark from '@larksuiteoapi/node-sdk'

const PROCESSING_EMOJI = 'RUNNING'
const ERROR_EMOJI = 'CROSS'

/**
 * Feishu / Lark channel adapter for EzDSH.
 *
 * Implements the runtime ChannelAdapter contract:
 *   name, onMessage, start, stop, send, updateAllowList, setStatus
 */
export class FeishuAdapter {
  name = 'feishu'

  /**
   * @param {object} options
   * @param {import('./types.js').FeishuConfig} options.config
   * @param {string[]} options.allowList
   * @param {import('./types.js').Logger} options.logger
   * @param {(message: import('./types.js').ChannelMessage) => Promise<import('./types.js').ChannelReply | undefined>} [options.onUnauthorizedMessage]
   */
  constructor(options) {
    this.options = options
    this.config = options.config
    this.allowList = new Set(options.allowList)
    this.logger = options.logger
    this.messageHandler = undefined
    this.client = undefined
    this.wsClient = undefined
    this.eventDispatcher = undefined
    /** @type {Map<string, string>} */
    this.reactionIds = new Map()
  }

  /**
   * @param {(message: import('./types.js').ChannelMessage) => Promise<import('./types.js').ChannelReply | undefined>} handler
   */
  onMessage(handler) {
    this.messageHandler = handler
  }

  async start() {
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
        const reply = await this.handleReceiveEvent(data)
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

  async stop() {
    this.wsClient?.close({ force: false })
    this.wsClient = undefined
    this.eventDispatcher = undefined
    this.client = undefined
    this.reactionIds.clear()
  }

  /**
   * @param {string[]} allowList
   */
  updateAllowList(allowList) {
    this.allowList = new Set(allowList)
  }

  /**
   * @param {import('./types.js').ChannelReply} reply
   */
  async send(reply) {
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

  /**
   * @param {string} messageId
   * @param {import('./types.js').ChannelMessageStatus} status
   */
  async setStatus(messageId, status) {
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

  /**
   * @param {import('./types.js').FeishuMessageEvent} event
   * @returns {Promise<import('./types.js').ChannelReply | undefined>}
   */
  async handleReceiveEvent(event) {
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

  /**
   * @param {import('./types.js').FeishuMessageEvent} event
   * @returns {import('./types.js').ChannelMessage | undefined}
   */
  normalizeMessage(event) {
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

  /**
   * @param {string} messageId
   * @param {string} emojiType
   */
  reactionKey(messageId, emojiType) {
    return `${messageId}:${emojiType}`
  }

  /**
   * @param {string} messageId
   * @param {string} emojiType
   */
  async addReaction(messageId, emojiType) {
    if (this.client === undefined) return
    try {
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
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

  /**
   * @param {string} messageId
   * @param {string} emojiType
   */
  async removeReaction(messageId, emojiType) {
    if (this.client === undefined) return
    const key = this.reactionKey(messageId, emojiType)
    const reactionId = this.reactionIds.get(key)
    if (reactionId === undefined) {
      return
    }
    try {
      const response = await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
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

/**
 * @param {unknown} raw
 * @returns {string}
 */
function parseFeishuContent(raw) {
  if (typeof raw !== 'string') return ''
  try {
    const parsed = JSON.parse(raw)
    return parsed.text ?? ''
  } catch {
    return raw
  }
}

/**
 * @param {import('./types.js').ChannelAdapterCreateOptions} options
 * @returns {FeishuAdapter}
 */
function createFeishuAdapter(options) {
  return new FeishuAdapter({ ...options, config: options.config })
}

/**
 * Channel adapter factory exported for EzDSH loader.
 */
export const feishuAdapterFactory = {
  name: 'feishu',
  create: createFeishuAdapter,
}
