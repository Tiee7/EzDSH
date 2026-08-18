import type { UserDataLayout } from '../../shared/state.js'
import { createConfigStorage, type ConfigStorage } from './config.js'
import { DshSessionClient } from './dsh-session.js'
import { FeishuAdapter } from './feishu.js'
import type { ChannelBridgeConfig, ChannelMessage, ChannelReply } from './types.js'
import type { DshSessionSummary, PairingState } from '../../shared/channel-bridge.js'

interface PairingChallenge {
  code: string
  expiresAt: number
}

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

export type { ChannelBridgeConfig }

export interface ChannelBridgeOptions {
  layout: UserDataLayout
  /** Returns the current DSH Runtime URL, or undefined if it is not running. */
  getRuntimeUrl(): string | undefined
}

export class ChannelBridgeService {
  private config: ChannelBridgeConfig
  private configStorage: ConfigStorage
  private adapter?: FeishuAdapter
  private running = false
  private activeTurns = new Map<string, boolean>()
  private pairing?: PairingChallenge
  private pairingTimer?: NodeJS.Timeout

  constructor(private readonly options: ChannelBridgeOptions) {
    this.config = {
      enabled: false,
      allowList: [],
      timeoutMs: 120_000,
      sessionTimeoutMs: 300_000,
      statusIntervalMs: 60_000,
    }
    this.configStorage = createConfigStorage(this.options.layout.state)
  }

  getConfigPath(): string {
    return this.configStorage.getConfigPath()
  }

  async initialize(): Promise<void> {
    this.config = await this.configStorage.loadConfig()
    if (this.config.enabled) {
      await this.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[channel-bridge] failed to initialize:', message)
      })
    }
  }

  async getConfig(): Promise<ChannelBridgeConfig> {
    return { ...this.config }
  }

  async setConfig(config: ChannelBridgeConfig): Promise<void> {
    const wasRunning = this.running
    const willRun = config.enabled

    this.config = { ...config }
    await this.configStorage.saveConfig(this.config)

    if (wasRunning && !willRun) {
      await this.stop()
    } else if (!wasRunning && willRun) {
      await this.start()
    } else if (willRun && wasRunning) {
      // Restart so credential/allowlist/session changes take effect.
      await this.stop()
      await this.start()
    }
  }

  async start(): Promise<void> {
    await this.stop()

    if (this.config.feishu === undefined) {
      throw new Error('Feishu configuration is missing')
    }

    this.adapter = new FeishuAdapter({
      config: this.config.feishu,
      allowList: this.config.allowList,
      onUnauthorizedMessage: (message) => this.handleUnauthorizedMessage(message),
      logger: console,
    })
    this.adapter.onMessage(async (message: ChannelMessage): Promise<ChannelReply | undefined> => {
      return this.handleMessage(this.adapter!, message)
    })

    await this.adapter.start()
    this.running = true
    console.log('[channel-bridge] Feishu long connection started')
  }

  async stop(): Promise<void> {
    await this.adapter?.stop()
    this.adapter = undefined
    this.running = false
    this.activeTurns.clear()
    this.cancelPairing()
  }

  get isRunning(): boolean {
    return this.running
  }

  async listSessions(): Promise<DshSessionSummary[]> {
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) {
      throw new Error('DSH Runtime 尚未启动')
    }

    const client = new DshSessionClient({
      baseUrl: runtimeUrl,
      timeoutMs: 10_000,
    })
    return client.listSessions()
  }

  getPairingState(): PairingState {
    if (this.pairing === undefined || Date.now() > this.pairing.expiresAt) {
      return { active: false }
    }
    return {
      active: true,
      code: this.pairing.code,
      expiresAt: new Date(this.pairing.expiresAt).toISOString(),
    }
  }

  async startPairing(): Promise<PairingState> {
    if (this.adapter === undefined) {
      throw new Error('远程控制未启动，请先保存配置并启用')
    }

    this.cancelPairing()

    const code = Math.floor(100_000 + Math.random() * 900_000).toString()
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS
    this.pairing = { code, expiresAt }
    this.pairingTimer = setTimeout(() => {
      this.cancelPairing()
    }, PAIRING_CODE_TTL_MS)

    console.log(`[channel-bridge] pairing challenge started: ${code}`)
    return this.getPairingState()
  }

  async cancelPairing(): Promise<void> {
    if (this.pairingTimer !== undefined) {
      clearTimeout(this.pairingTimer)
      this.pairingTimer = undefined
    }
    this.pairing = undefined
  }

  private async handleUnauthorizedMessage(message: ChannelMessage): Promise<ChannelReply | undefined> {
    if (message.chat?.type !== 'private') {
      return undefined
    }

    const state = this.getPairingState()
    if (!state.active || state.code === undefined) {
      return undefined
    }

    const text = message.content.text.trim()
    if (text !== state.code) {
      return undefined
    }

    const openId = message.from.id
    if (this.config.allowList.includes(openId)) {
      await this.cancelPairing()
      return {
        to: { userId: openId },
        content: '该用户已经在白名单中，无需重复配对。',
      }
    }

    const allowList = [...this.config.allowList, openId]
    this.config = { ...this.config, allowList }
    await this.configStorage.saveConfig(this.config)
    this.adapter?.updateAllowList(allowList)
    await this.cancelPairing()

    console.log(`[channel-bridge] paired with ${openId}`)
    return {
      to: { userId: openId },
      content: '配对成功，你已被加入白名单。现在可以直接发送消息使用远程控制。',
    }
  }

  private async handleMessage(
    adapter: FeishuAdapter,
    message: ChannelMessage,
  ): Promise<ChannelReply | undefined> {
    const text = message.content.text.trim()
    if (text === '') return undefined

    console.log(`[channel-bridge] ${message.adapter} message from ${message.from.id}: ${text}`)

    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) {
      return this.buildReply(message, '执行失败：DSH Runtime 尚未启动')
    }

    let sessionId: string
    try {
      sessionId = await this.ensureSession(runtimeUrl)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      return this.buildReply(message, `执行失败：${messageText}`)
    }

    if (this.activeTurns.has(sessionId)) {
      return this.buildReply(message, '当前会话已有任务在执行，请等待完成后再发送新消息。')
    }

    this.activeTurns.set(sessionId, true)

    const client = new DshSessionClient({
      baseUrl: runtimeUrl,
      timeoutMs: this.config.sessionTimeoutMs ?? 300_000,
    })

    const recipient: ChannelReply['to'] = {
      userId: message.chat?.type === 'private' ? message.from.id : undefined,
      chatId: message.chat?.type === 'group' ? message.chat.id : undefined,
    }

    void client
      .sendPromptAsync(
        sessionId,
        text,
        {
          onAcknowledged: () => {
            void this.safeSend(adapter, {
              to: recipient,
              content: '任务已收到，正在 DSH 会话中执行。完成后会回复结果。',
            })
          },
          onProgress: (elapsedMs) => {
            const seconds = Math.round(elapsedMs / 1000)
            void this.safeSend(adapter, {
              to: recipient,
              content: `任务仍在执行中，已运行 ${seconds} 秒…`,
            })
          },
          onComplete: (answer) => {
            this.activeTurns.delete(sessionId)
            void this.safeSend(adapter, {
              to: recipient,
              content: answer.length > 0 ? answer : 'DSH 没有返回任何输出。',
            })
          },
          onError: (error) => {
            this.activeTurns.delete(sessionId)
            void this.safeSend(adapter, {
              to: recipient,
              content: `执行失败：${error}`,
            })
          },
        },
        {
          timeoutMs: this.config.sessionTimeoutMs ?? 300_000,
          statusIntervalMs: this.config.statusIntervalMs ?? 60_000,
        },
      )
      .catch((error: unknown) => {
        this.activeTurns.delete(sessionId)
        const messageText = error instanceof Error ? error.message : String(error)
        void this.safeSend(adapter, { to: recipient, content: `执行失败：${messageText}` })
      })

    // Return immediately so Feishu gets a fast acknowledgement.
    return undefined
  }

  private async ensureSession(runtimeUrl: string): Promise<string> {
    if (this.config.sessionId !== undefined && this.config.sessionId.length > 0) {
      return this.config.sessionId
    }

    const client = new DshSessionClient({
      baseUrl: runtimeUrl,
      timeoutMs: 10_000,
    })
    const session = await client.createSession({ cwd: this.config.workspace })

    this.config = { ...this.config, sessionId: session.sessionId }
    await this.configStorage.saveConfig(this.config)
    console.log(`[channel-bridge] created remote-control session ${session.sessionId}`)

    return session.sessionId
  }

  private buildReply(message: ChannelMessage, content: string): ChannelReply {
    return {
      to: {
        userId: message.chat?.type === 'private' ? message.from.id : undefined,
        chatId: message.chat?.type === 'group' ? message.chat.id : undefined,
      },
      content,
    }
  }

  private async safeSend(adapter: FeishuAdapter, reply: ChannelReply): Promise<void> {
    try {
      await adapter.send(reply)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error('[channel-bridge] failed to send Feishu reply:', messageText)
    }
  }
}
