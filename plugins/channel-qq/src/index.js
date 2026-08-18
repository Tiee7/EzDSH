/**
 * QQ channel adapter for EzDSH.
 *
 * Connects to a OneBot 11 implementation (NapCatQQ, LLOneBot, Lagrange.Onebot,
 * etc.) through its WebSocket event stream and HTTP API.
 */

/**
 * @typedef {object} QQConfig
 * @property {string} wsUrl - OneBot 11 event WebSocket URL, e.g. ws://localhost:3001
 * @property {string} httpUrl - OneBot 11 HTTP API URL, e.g. http://localhost:3001
 * @property {string} [accessToken] - Optional authorization token
 */

/**
 * @typedef {object} ChannelMessage
 * @property {string} adapter
 * @property {string} messageId
 * @property {{ id: string, name?: string }} from
 * @property {{ id: string, type: 'private' | 'group', name?: string }} [chat]
 * @property {{ type: 'text', text: string }} content
 * @property {number} timestamp
 */

/**
 * @typedef {object} ChannelReply
 * @property {{ userId?: string, chatId?: string }} to
 * @property {string} content
 */

/**
 * @typedef {'received' | 'processing' | 'done' | 'error'} ChannelMessageStatus
 */

/**
 * @typedef {object} ChannelAdapterCreateOptions
 * @property {unknown} config
 * @property {string[]} allowList
 * @property {Logger} logger
 * @property {(message: ChannelMessage) => Promise<ChannelReply | undefined>} [onUnauthorizedMessage]
 */

/**
 * @typedef {object} Logger
 * @property {(message: string, ...args: unknown[]) => void} info
 * @property {(message: string, ...args: unknown[]) => void} error
 * @property {(message: string, ...args: unknown[]) => void} warn
 */

/**
 * @param {unknown} value
 * @returns {value is QQConfig}
 */
function isQQConfig(value) {
  if (typeof value !== 'object' || value === null) return false
  const obj = /** @type {Record<string, unknown>} */ (value)
  return typeof obj.wsUrl === 'string' && typeof obj.httpUrl === 'string'
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function extractText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === 'object' && part !== null ? part.text ?? '' : String(part))).join('')
  }
  return String(value ?? '')
}

class OneBotClient {
  /**
   * @param {QQConfig} config
   * @param {Logger} logger
   */
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.ws = undefined
    this.messageHandler = undefined
    this.reconnectTimer = undefined
    this.intentionallyStopped = false
  }

  /**
   * @param {(event: object) => void} handler
   */
  onEvent(handler) {
    this.messageHandler = handler
  }

  async start() {
    this.intentionallyStopped = false
    await this.connect()
  }

  stop() {
    this.intentionallyStopped = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws !== undefined) {
      this.ws.close()
      this.ws = undefined
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.config.wsUrl, [], {
          headers: this.config.accessToken !== undefined
            ? { Authorization: `Bearer ${this.config.accessToken}` }
            : undefined
        })
        ws.onopen = () => {
          this.logger.info('[channel-bridge:qq] websocket connected')
          this.ws = ws
          resolve(undefined)
        }
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(/** @type {string} */ (event.data))
            this.messageHandler?.(data)
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error)
            this.logger.warn('[channel-bridge:qq] failed to parse event:', messageText)
          }
        }
        ws.onerror = (error) => {
          this.logger.error('[channel-bridge:qq] websocket error:', error.message ?? 'unknown')
          if (this.ws === undefined) {
            reject(new Error(`QQ websocket connection failed: ${error.message ?? 'unknown'}`))
          }
        }
        ws.onclose = () => {
          this.ws = undefined
          this.logger.warn('[channel-bridge:qq] websocket closed')
          if (!this.intentionallyStopped) {
            this.scheduleReconnect()
          }
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  scheduleReconnect() {
    if (this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect().catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error)
        this.logger.warn('[channel-bridge:qq] reconnect failed:', messageText)
      })
    }, 5000)
  }

  /**
   * @param {string} action
   * @param {object} params
   */
  async callApi(action, params) {
    const headers = { 'Content-Type': 'application/json' }
    if (this.config.accessToken !== undefined) {
      headers.Authorization = `Bearer ${this.config.accessToken}`
    }
    const response = await fetch(`${this.config.httpUrl}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params)
    })
    if (!response.ok) {
      throw new Error(`OneBot API ${action} failed: ${response.status} ${await response.text()}`)
    }
    return response.json()
  }
}

export class QQAdapter {
  name = 'qq'

  /**
   * @param {ChannelAdapterCreateOptions & { config: QQConfig }} options
   */
  constructor(options) {
    this.options = options
    this.config = options.config
    this.allowList = new Set(options.allowList)
    this.logger = options.logger
    this.messageHandler = undefined
    this.client = new OneBotClient(this.config, this.logger)
    this.client.onEvent((event) => this.handleEvent(event))
  }

  /**
   * @param {(message: ChannelMessage) => Promise<ChannelReply | undefined>} handler
   */
  onMessage(handler) {
    this.messageHandler = handler
  }

  async start() {
    await this.client.start()
  }

  async stop() {
    this.client.stop()
  }

  /**
   * @param {string[]} allowList
   */
  updateAllowList(allowList) {
    this.allowList = new Set(allowList)
  }

  /**
   * @param {ChannelReply} reply
   */
  async send(reply) {
    if (reply.to.userId !== undefined) {
      await this.client.callApi('send_private_msg', {
        user_id: Number(reply.to.userId),
        message: reply.content
      })
    } else if (reply.to.chatId !== undefined) {
      await this.client.callApi('send_group_msg', {
        group_id: Number(reply.to.chatId),
        message: reply.content
      })
    } else {
      throw new Error('QQ reply requires userId or chatId')
    }
  }

  /**
   * OneBot 11 has no native message reaction/status API, so this is a no-op.
   */
  async setStatus() {
    // no-op
  }

  /**
   * @param {object} event
   */
  async handleEvent(event) {
    if (event.post_type !== 'message') return

    const message = this.normalizeMessage(event)
    if (message === undefined) return

    this.logger.info(`[channel-bridge:qq] message from ${message.from.id}: ${message.content.text}`)

    if (!this.allowList.has(message.from.id)) {
      const customReply = await this.options.onUnauthorizedMessage?.(message)
      if (customReply !== undefined) {
        await this.send(customReply)
      }
      return
    }

    const handler = this.messageHandler
    if (handler === undefined) return

    const reply = await handler(message)
    if (reply !== undefined) {
      await this.send(reply)
    }
  }

  /**
   * @param {object} event
   * @returns {ChannelMessage | undefined}
   */
  normalizeMessage(event) {
    const userId = event.user_id
    const messageId = event.message_id
    const messageType = event.message_type
    const text = extractText(event.message)

    if (userId === undefined || messageId === undefined || text === '') {
      return undefined
    }

    /** @type {'private' | 'group'} */
    const chatType = messageType === 'group' ? 'group' : 'private'

    return {
      adapter: this.name,
      messageId: String(messageId),
      from: { id: String(userId) },
      chat: {
        id: messageType === 'group' ? String(event.group_id ?? userId) : String(userId),
        type: chatType
      },
      content: { type: 'text', text },
      timestamp: Date.now()
    }
  }
}

/**
 * @param {ChannelAdapterCreateOptions} options
 * @returns {QQAdapter}
 */
function createQQAdapter(options) {
  if (!isQQConfig(options.config)) {
    throw new Error('Invalid QQ adapter config: wsUrl and httpUrl are required')
  }
  return new QQAdapter(/** @type {ChannelAdapterCreateOptions & { config: QQConfig }} */ (options))
}

export const qqAdapterFactory = {
  name: 'qq',
  create: createQQAdapter
}
