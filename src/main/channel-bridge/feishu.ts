import type { ChannelAdapter, ChannelMessage, ChannelReply, FeishuConfig } from './types.js'

const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis'

interface TenantAccessTokenResponse {
  code: number
  msg: string
  tenant_access_token?: string
  expire?: number
}

export class FeishuAdapter implements ChannelAdapter {
  readonly name = 'feishu'

  private accessToken?: string
  private tokenExpiresAt = 0
  private messageHandler?: (message: ChannelMessage) => Promise<ChannelReply | undefined>

  constructor(
    private readonly config: FeishuConfig,
    private readonly allowList: string[],
  ) {}

  onMessage(handler: (message: ChannelMessage) => Promise<ChannelReply | undefined>): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    // No long-lived connection for Feishu webhooks; we just validate credentials.
    await this.ensureToken()
  }

  async stop(): Promise<void> {
    this.accessToken = undefined
    this.tokenExpiresAt = 0
  }

  /**
   * Parse an incoming Feishu event payload and forward it to the handler.
   * Returns the platform challenge if this is a URL verification request.
   */
  async handleWebhook(payload: unknown): Promise<{ challenge?: string; reply?: ChannelReply }> {
    const event = payload as Record<string, unknown>

    // URL verification handshake.
    if (typeof event.challenge === 'string') {
      return { challenge: event.challenge }
    }

    const feishuEvent = event.event as Record<string, unknown> | undefined
    if (feishuEvent === undefined) {
      return {}
    }

    const message = this.normalizeMessage(feishuEvent)
    if (message === undefined) {
      return {}
    }

    if (!this.allowList.includes(message.from.id)) {
      return {
        reply: {
          to: { userId: message.from.id },
          content: '你不在白名单中，无法使用远程控制。',
        },
      }
    }

    const handler = this.messageHandler
    if (handler === undefined) {
      return {}
    }

    const reply = await handler(message)
    return reply === undefined ? {} : { reply }
  }

  async send(reply: ChannelReply): Promise<void> {
    await this.ensureToken()

    const receiveId = reply.to.userId ?? reply.to.chatId
    if (receiveId === undefined) {
      throw new Error('Feishu reply requires userId or chatId')
    }

    const receiveIdType = reply.to.userId !== undefined ? 'open_id' : 'chat_id'

    const response = await fetch(
      `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: reply.content }),
        }),
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Feishu send message failed: ${response.status} ${body}`)
    }
  }

  private normalizeMessage(event: Record<string, unknown>): ChannelMessage | undefined {
    const sender = event.sender as Record<string, unknown> | undefined
    const senderId = sender?.sender_id as Record<string, string> | undefined
    const message = event.message as Record<string, unknown> | undefined

    if (senderId === undefined || message === undefined) {
      return undefined
    }

    const openId = senderId.open_id
    if (openId === undefined) {
      return undefined
    }

    const chatType = message.chat_type === 'p2p' ? 'private' : 'group'
    const chatId = typeof message.chat_id === 'string' ? message.chat_id : undefined
    const content = parseFeishuContent(message.content)

    return {
      adapter: this.name,
      messageId: String(message.message_id ?? ''),
      from: { id: openId, name: senderId.name ?? senderId.name },
      chat: chatId === undefined ? undefined : { id: chatId, type: chatType },
      content: { type: 'text', text: content },
      timestamp: Date.now(),
    }
  }

  private async ensureToken(): Promise<void> {
    if (this.accessToken !== undefined && Date.now() < this.tokenExpiresAt - 60_000) {
      return
    }

    const response = await fetch(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    })

    const result = (await response.json()) as TenantAccessTokenResponse
    if (result.code !== 0 || result.tenant_access_token === undefined) {
      throw new Error(`Failed to get Feishu tenant access token: ${result.code} ${result.msg}`)
    }

    this.accessToken = result.tenant_access_token
    this.tokenExpiresAt = Date.now() + (result.expire ?? 7200) * 1000
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
