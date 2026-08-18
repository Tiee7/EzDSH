import type { UserDataLayout } from '../../shared/state.js'
import { createConfigStorage, type ConfigStorage } from './config.js'
import { DshSessionClient } from './dsh-session.js'
import { FeishuAdapter } from './feishu.js'
import type { ChannelBridgeConfig, ChannelMessage, ChannelReply } from './types.js'

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

  constructor(private readonly options: ChannelBridgeOptions) {
    this.config = { enabled: false, allowList: [], timeoutMs: 120_000, sessionTimeoutMs: 300_000 }
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
  }

  get isRunning(): boolean {
    return this.running
  }

  private async handleMessage(
    adapter: FeishuAdapter,
    message: ChannelMessage,
  ): Promise<ChannelReply | undefined> {
    const text = message.content.text.trim()
    if (text === '') return undefined

    console.log(`[channel-bridge] ${message.adapter} message from ${message.from.id}: ${text}`)

    try {
      const runtimeUrl = this.options.getRuntimeUrl()
      if (runtimeUrl === undefined) {
        throw new Error('DSH Runtime 尚未启动')
      }

      const sessionId = await this.ensureSession(runtimeUrl)
      const client = new DshSessionClient({
        baseUrl: runtimeUrl,
        timeoutMs: this.config.sessionTimeoutMs ?? 300_000,
      })

      const result = await client.sendPrompt(sessionId, text)

      return {
        to: {
          userId: message.chat?.type === 'private' ? message.from.id : undefined,
          chatId: message.chat?.type === 'group' ? message.chat.id : undefined,
        },
        content: result.text.length > 0 ? result.text : 'DSH 没有返回任何输出。',
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      return {
        to: {
          userId: message.chat?.type === 'private' ? message.from.id : undefined,
          chatId: message.chat?.type === 'group' ? message.chat.id : undefined,
        },
        content: `执行失败：${messageText}`,
      }
    }
  }

  private async ensureSession(runtimeUrl: string): Promise<string> {
    if (this.config.sessionId !== undefined && this.config.sessionId.length > 0) {
      return this.config.sessionId
    }

    const client = new DshSessionClient({
      baseUrl: runtimeUrl,
      timeoutMs: this.config.sessionTimeoutMs ?? 300_000,
    })
    const session = await client.createSession({ cwd: this.config.workspace })

    this.config = { ...this.config, sessionId: session.sessionId }
    await this.configStorage.saveConfig(this.config)
    console.log(`[channel-bridge] created remote-control session ${session.sessionId}`)

    return session.sessionId
  }
}
