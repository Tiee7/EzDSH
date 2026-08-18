/**
 * WeCom (Enterprise WeChat) channel adapter for EzDSH.
 *
 * Implements a self-built application (自建应用) callback server and uses the
 * official WeCom message/send API for replies.
 */

import { createServer } from 'node:http'
import { createHash, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * @typedef {object} WeComConfig
 * @property {string} corpId
 * @property {string} corpSecret
 * @property {number} agentId
 * @property {string} token - callback verification token
 * @property {string} encodingAESKey - 43-character Base64-encoded AES key
 * @property {number} [callbackPort=8081] - local port for callback server
 * @property {string} [baseUrl='https://qyapi.weixin.qq.com/cgi-bin']
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
 * @typedef {object} Logger
 * @property {(message: string, ...args: unknown[]) => void} info
 * @property {(message: string, ...args: unknown[]) => void} error
 * @property {(message: string, ...args: unknown[]) => void} warn
 */

/**
 * @typedef {object} ChannelAdapterCreateOptions
 * @property {unknown} config
 * @property {string[]} allowList
 * @property {Logger} logger
 * @property {(message: ChannelMessage) => Promise<ChannelReply | undefined>} [onUnauthorizedMessage]
 */

const DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin'
const DEFAULT_CALLBACK_PORT = 8081
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * @param {unknown} value
 * @returns {value is WeComConfig}
 */
function isWeComConfig(value) {
  if (typeof value !== 'object' || value === null) return false
  const obj = /** @type {Record<string, unknown>} */ (value)
  return (
    typeof obj.corpId === 'string' &&
    typeof obj.corpSecret === 'string' &&
    typeof obj.agentId === 'number' &&
    typeof obj.token === 'string' &&
    typeof obj.encodingAESKey === 'string'
  )
}

/**
 * @param {string} encodingAESKey
 * @returns {Buffer}
 */
function decodeAESKey(encodingAESKey) {
  return Buffer.from(encodingAESKey + '=', 'base64')
}

/**
 * @param {string} token
 * @param {string} timestamp
 * @param {string} nonce
 * @param {string} encrypted
 * @returns {string}
 */
function computeSignature(token, timestamp, nonce, encrypted) {
  const sorted = [token, timestamp, nonce, encrypted].sort().join('')
  return createHash('sha1').update(sorted).digest('hex')
}

/**
 * Decrypt WeCom AES-CBC message.
 * Format: random(16) + msg_len(4, network order) + msg + corpid
 *
 * @param {string} encrypted
 * @param {Buffer} aesKey
 * @returns {{ message: string, corpId: string }}
 */
function decryptWeComMessage(encrypted, aesKey) {
  const iv = aesKey.slice(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false)
  let decrypted = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()])

  // PKCS#7 unpadding
  const padLength = decrypted[decrypted.length - 1]
  if (padLength > 0 && padLength <= 32) {
    decrypted = decrypted.slice(0, decrypted.length - padLength)
  }

  const randomLength = 16
  const msgLength = decrypted.readUInt32BE(randomLength)
  const message = decrypted.slice(randomLength + 4, randomLength + 4 + msgLength).toString('utf8')
  const corpId = decrypted.slice(randomLength + 4 + msgLength).toString('utf8')
  return { message, corpId }
}

/**
 * Parse WeCom XML callback body.
 * @param {string} xml
 * @returns {Record<string, string>}
 */
function parseXml(xml) {
  const result = /** @type {Record<string, string>} */ ({})
  const regex = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g
  let match
  while ((match = regex.exec(xml)) !== null) {
    result[match[1]] = match[2] ?? match[3] ?? ''
  }
  return result
}

/**
 * Build minimal WeCom XML response.
 * @param {string} toUserName
 * @param {string} fromUserName
 * @param {string} content
 * @returns {string}
 */
function buildTextReplyXml(toUserName, fromUserName, content) {
  const now = Math.floor(Date.now() / 1000)
  return `<xml>
<ToUserName><![CDATA[${toUserName}]]></ToUserName>
<FromUserName><![CDATA[${fromUserName}]]></FromUserName>
<CreateTime>${now}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`
}

class WeComClient {
  /**
   * @param {WeComConfig} config
   * @param {Logger} logger
   */
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.accessToken = undefined
    this.tokenExpiresAt = 0
  }

  async ensureAccessToken() {
    if (this.accessToken !== undefined && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken
    }

    const url = `${this.config.baseUrl ?? DEFAULT_BASE_URL}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.corpSecret)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`WeCom gettoken failed: ${response.status} ${await response.text()}`)
    }
    const data = await response.json()
    if (data.errcode !== 0) {
      throw new Error(`WeCom gettoken error: ${data.errcode} ${data.errmsg}`)
    }
    this.accessToken = data.access_token
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000
    return this.accessToken
  }

  /**
   * @param {string} userId
   * @param {string} content
   */
  async sendTextMessage(userId, content) {
    const accessToken = await this.ensureAccessToken()
    const url = `${this.config.baseUrl ?? DEFAULT_BASE_URL}/message/send?access_token=${accessToken}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userId,
        msgtype: 'text',
        agentid: this.config.agentId,
        text: { content }
      })
    })
    if (!response.ok) {
      throw new Error(`WeCom send message failed: ${response.status} ${await response.text()}`)
    }
    const data = await response.json()
    if (data.errcode !== 0) {
      throw new Error(`WeCom send message error: ${data.errcode} ${data.errmsg}`)
    }
  }
}

class WeComCallbackServer {
  /**
   * @param {WeComConfig} config
   * @param {Logger} logger
   */
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.server = undefined
    this.messageHandler = undefined
    this.aesKey = decodeAESKey(config.encodingAESKey)
  }

  /**
   * @param {(message: ChannelMessage) => Promise<ChannelReply | undefined>} handler
   */
  onMessage(handler) {
    this.messageHandler = handler
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      const port = this.config.callbackPort ?? DEFAULT_CALLBACK_PORT
      this.server.listen(port, () => {
        this.logger.info(`[channel-bridge:wecom] callback server listening on port ${port}`)
        resolve(undefined)
      })
      this.server.once('error', reject)
    })
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server === undefined) {
        resolve(undefined)
        return
      }
      this.server.close(() => resolve(undefined))
      this.server = undefined
    })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const query = url.searchParams
      const signature = query.get('msg_signature') ?? ''
      const timestamp = query.get('timestamp') ?? ''
      const nonce = query.get('nonce') ?? ''

      if (req.method === 'GET') {
        const echostr = query.get('echostr') ?? ''
        const expected = computeSignature(this.config.token, timestamp, nonce, echostr)
        if (signature !== expected) {
          this.logger.warn('[channel-bridge:wecom] callback verification signature mismatch')
          res.statusCode = 403
          res.end('Forbidden')
          return
        }
        res.statusCode = 200
        res.end(echostr)
        return
      }

      if (req.method === 'POST') {
        const body = await readRequestBody(req)
        const parsed = parseXml(body)
        const encrypted = parsed.Encrypt ?? ''
        const expected = computeSignature(this.config.token, timestamp, nonce, encrypted)
        if (signature !== expected) {
          this.logger.warn('[channel-bridge:wecom] message signature mismatch')
          res.statusCode = 403
          res.end('Forbidden')
          return
        }

        const { message } = decryptWeComMessage(encrypted, this.aesKey)
        const msg = parseXml(message)

        if (msg.MsgType !== 'text' || msg.Content === undefined || msg.Content === '') {
          res.statusCode = 200
          res.end('success')
          return
        }

        const channelMessage = {
          adapter: 'wecom',
          messageId: msg.MsgId ?? `${Date.now()}`,
          from: { id: msg.FromUserName },
          chat: { id: msg.FromUserName, type: 'private' },
          content: { type: 'text', text: msg.Content },
          timestamp: Date.now()
        }

        const reply = await this.messageHandler?.(channelMessage)
        if (reply !== undefined) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/xml')
          res.end(buildTextReplyXml(msg.FromUserName, msg.ToUserName, reply.content))
          return
        }

        res.statusCode = 200
        res.end('success')
        return
      }

      res.statusCode = 405
      res.end('Method Not Allowed')
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      this.logger.error('[channel-bridge:wecom] callback request error:', messageText)
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class WeComAdapter {
  name = 'wecom'

  /**
   * @param {ChannelAdapterCreateOptions & { config: WeComConfig }} options
   */
  constructor(options) {
    this.options = options
    this.config = options.config
    this.allowList = new Set(options.allowList)
    this.logger = options.logger
    this.messageHandler = undefined
    this.client = new WeComClient(this.config, this.logger)
    this.server = new WeComCallbackServer(this.config, this.logger)
    this.server.onMessage((message) => this.handleMessage(message))
  }

  /**
   * @param {(message: ChannelMessage) => Promise<ChannelReply | undefined>} handler
   */
  onMessage(handler) {
    this.messageHandler = handler
  }

  async start() {
    await this.server.start()
  }

  async stop() {
    await this.server.stop()
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
    const userId = reply.to.userId ?? reply.to.chatId
    if (userId === undefined) {
      throw new Error('WeCom reply requires userId or chatId')
    }
    await this.client.sendTextMessage(userId, reply.content)
  }

  /**
   * WeCom self-built apps do not expose message status/reactions.
   */
  async setStatus() {
    // no-op
  }

  /**
   * @param {ChannelMessage} message
   * @returns {Promise<ChannelReply | undefined>}
   */
  async handleMessage(message) {
    this.logger.info(`[channel-bridge:wecom] message from ${message.from.id}: ${message.content.text}`)

    if (!this.allowList.has(message.from.id)) {
      const customReply = await this.options.onUnauthorizedMessage?.(message)
      if (customReply !== undefined) {
        return customReply
      }
      return { to: { userId: message.from.id }, content: '你不在白名单中，无法使用远程控制。' }
    }

    const handler = this.messageHandler
    if (handler === undefined) return undefined
    return await handler(message)
  }
}

/**
 * @param {ChannelAdapterCreateOptions} options
 * @returns {WeComAdapter}
 */
function createWeComAdapter(options) {
  if (!isWeComConfig(options.config)) {
    throw new Error('Invalid WeCom adapter config: corpId, corpSecret, agentId, token, encodingAESKey are required')
  }
  return new WeComAdapter(/** @type {ChannelAdapterCreateOptions & { config: WeComConfig }} */ (options))
}

export const wecomAdapterFactory = {
  name: 'wecom',
  create: createWeComAdapter
}
