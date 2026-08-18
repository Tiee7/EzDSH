import type { UserDataLayout } from '../../shared/state.js'
import { createConfigStorage, type ConfigStorage } from './config.js'
import { runDshHeadless } from './dsh.js'
import { FeishuAdapter } from './feishu.js'
import type { ChannelBridgeConfig, ChannelMessage, ChannelReply } from './types.js'

export type { ChannelBridgeConfig }

export interface ChannelBridgeOptions {
  layout: UserDataLayout
  runtimeEntryPath: string
  runtimeCommandPath: string | undefined
}

export class ChannelBridgeService {
  private config: ChannelBridgeConfig
  private configStorage: ConfigStorage
  private adapter?: FeishuAdapter
  private running = false

  constructor(private readonly options: ChannelBridgeOptions) {
    this.config = { enabled: false, allowList: [], timeoutMs: 120_000 }
    this.configStorage = createConfigStorage(this.options.layout.state)
  }

  getConfigPath(): string {
    return this.configStorage.getConfigPath()
  }

  async initialize(): Promise<void> {
    this.config = await this.configStorage.loadConfig()
    if (this.config.enabled) {
      await this.start()
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
      // Restart so credential/allowlist changes take effect.
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
      const result = await runDshHeadless(text, {
        nodeCommand: this.options.runtimeCommandPath ?? process.execPath,
        runtimeEntryPath: this.options.runtimeEntryPath,
        cwd: this.config.workspace,
        timeoutMs: this.config.timeoutMs,
      })

      let replyText = result.answer
      if (replyText.length === 0) {
        replyText = 'DSH 没有返回任何输出。'
      }

      return {
        to: {
          userId: message.chat?.type === 'private' ? message.from.id : undefined,
          chatId: message.chat?.type === 'group' ? message.chat.id : undefined,
        },
        content: replyText,
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
}
