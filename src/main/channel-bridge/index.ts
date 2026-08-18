import type { UserDataLayout } from '../../shared/state.js'
import { createConfigStorage, type ConfigStorage } from './config.js'
import { runDshHeadless } from './dsh.js'
import { FeishuAdapter } from './feishu.js'
import { ChannelBridgeServer } from './server.js'
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
  private server: ChannelBridgeServer

  constructor(private readonly options: ChannelBridgeOptions) {
    this.config = { enabled: false, port: 17891, allowList: [], timeoutMs: 120_000 }
    this.configStorage = createConfigStorage(this.options.layout.state)
    this.server = new ChannelBridgeServer({ port: 0, adapters: new Map() })
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
    const wasRunning = this.config.enabled
    const willRun = config.enabled

    this.config = { ...config }
    await this.configStorage.saveConfig(this.config)

    if (wasRunning && !willRun) {
      await this.stop()
    } else if (!wasRunning && willRun) {
      await this.start()
    } else if (willRun && this.config.port !== this.server.port) {
      await this.stop()
      await this.start()
    }
  }

  async start(): Promise<void> {
    await this.stop()

    const adapters = this.buildAdapters()
    this.server = new ChannelBridgeServer({ port: this.config.port, adapters })
    await this.server.start()

    for (const adapter of adapters.values()) {
      await adapter.start()
    }

    console.log(`[channel-bridge] listening on http://127.0.0.1:${this.config.port}`)
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  get isRunning(): boolean {
    return this.server.port !== 0
  }

  private buildAdapters(): Map<string, FeishuAdapter> {
    const adapters = new Map<string, FeishuAdapter>()

    if (this.config.feishu !== undefined) {
      const adapter = new FeishuAdapter(this.config.feishu, this.config.allowList)
      adapter.onMessage(async (message: ChannelMessage): Promise<ChannelReply | undefined> => {
        return this.handleMessage(adapter, message)
      })
      adapters.set(adapter.name, adapter)
    }

    return adapters
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
