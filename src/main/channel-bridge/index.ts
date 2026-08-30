import type { UserDataLayout } from '../../shared/state.js'
import { AdapterRegistry } from './adapter-registry.js'
import { createConfigStorage, type ConfigStorage } from './config.js'
import { DshApiError, DshSessionClient } from './dsh-session.js'
import {
  deleteArchivedSessionFromStore,
  removeArchivedSessionFromStore,
} from './archived-session-store.js'
import type {
  ChannelAdapter,
  ChannelBridgeConfig,
  ChannelMessage,
  ChannelMessageStatus,
  ChannelReply,
  Logger,
} from './types.js'
import { DEFAULT_CHANNEL_BRIDGE_CONFIG } from './types.js'
import type { AdapterConfig, DshSessionSummary, PairingState } from '../../shared/channel-bridge.js'

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
  /** Returns whether destructive Session maintenance is currently enabled. */
  isDeveloperMode?(): boolean
  /** Stop and start the Runtime around legacy workspace-store compatibility writes. */
  stopRuntime?(): Promise<void>
  startRuntime?(): Promise<void>
  /** Registry of available channel adapters. */
  registry: AdapterRegistry
}

export class ChannelBridgeService {
  private config: ChannelBridgeConfig
  private configStorage: ConfigStorage
  private adapters = new Map<string, ChannelAdapter>()
  private running = false
  private activeTurns = new Map<string, boolean>()
  private pairing?: PairingChallenge
  private pairingTimer?: NodeJS.Timeout
  private archiveMutation: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ChannelBridgeOptions) {
    this.config = { ...DEFAULT_CHANNEL_BRIDGE_CONFIG }
    this.configStorage = createConfigStorage(this.options.layout.state)
  }

  getConfigPath(): string {
    return this.configStorage.getConfigPath()
  }

  async initialize(): Promise<void> {
    this.config = await this.configStorage.loadConfig()
    if (this.hasEnabledAdapter()) {
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
    this.config = { ...config }
    await this.configStorage.saveConfig(this.config)

    // Restart whenever the config changes so that enable/credential/session/allowlist
    // updates take effect immediately.
    await this.stop()
    if (this.hasEnabledAdapter()) {
      await this.start()
    }
  }

  async start(): Promise<void> {
    await this.stop()

    const enabledAdapters = Object.entries(this.config.adapters).filter(
      ([, rawConfig]) =>
        rawConfig !== undefined &&
        rawConfig !== null &&
        (rawConfig as AdapterConfig).enabled === true,
    )

    if (enabledAdapters.length === 0) {
      return
    }

    const logger: Logger = console
    const results = await Promise.allSettled(
      enabledAdapters.map(async ([name, rawConfig]) => {
        const adapterConfig = (rawConfig ?? {}) as AdapterConfig
        const adapter = this.options.registry.create(name, {
          config: adapterConfig,
          allowList: adapterConfig.allowList ?? this.config.allowList ?? [],
          onUnauthorizedMessage: (message) => this.handleUnauthorizedMessage(adapter, message),
          logger,
        })
        adapter.onMessage(async (message: ChannelMessage): Promise<ChannelReply | undefined> => {
          return this.handleMessage(adapter, message)
        })
        await adapter.start()
        this.adapters.set(name, adapter)
        console.log(`[channel-bridge] adapter "${name}" started`)
      }),
    )

    const failures = results
      .map((result, index) => ({ result, name: enabledAdapters[index]?.[0] ?? 'unknown' }))
      .filter(({ result }) => result.status === 'rejected')
      .map(({ name, result }) => {
        const reason = result.status === 'rejected' ? (result.reason as Error).message : 'unknown'
        return `"${name}": ${reason}`
      })

    if (failures.length > 0) {
      console.error(`[channel-bridge] adapter start failures: ${failures.join('; ')}`)
    }

    if (this.adapters.size === 0) {
      throw new Error(`所有 adapter 启动失败: ${failures.join('; ')}`)
    }

    this.running = true
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.stop()),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        const messageText = result.reason instanceof Error ? result.reason.message : String(result.reason)
        console.error('[channel-bridge] adapter stop error:', messageText)
      }
    }
    this.adapters.clear()
    this.running = false
    this.activeTurns.clear()
    this.cancelPairing()
  }

  get isRunning(): boolean {
    return this.running
  }

  private hasEnabledAdapter(): boolean {
    return Object.values(this.config.adapters).some(
      (cfg) => cfg !== undefined && cfg !== null && (cfg as AdapterConfig).enabled === true,
    )
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

  async listArchivedSessions(): Promise<DshSessionSummary[]> {
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) {
      throw new Error('DSH Runtime 尚未启动')
    }

    const client = new DshSessionClient({
      baseUrl: runtimeUrl,
      timeoutMs: 10_000,
    })
    return client.listArchivedSessions()
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    await this.enqueueArchiveMutation(async () => {
      const runtimeUrl = this.options.getRuntimeUrl()
      if (runtimeUrl === undefined) {
        throw new Error('DSH Runtime 尚未启动')
      }

      const client = new DshSessionClient({
        baseUrl: runtimeUrl,
        timeoutMs: 10_000,
      })
      try {
        await client.unarchiveSession(sessionId)
      } catch (error) {
        if (!(error instanceof DshApiError) || error.status !== 404) throw error
        if (this.options.stopRuntime === undefined || this.options.startRuntime === undefined) {
          throw new Error('当前 DSH Runtime 不支持恢复归档 Session，请重启应用后重试')
        }

        await this.options.stopRuntime()
        try {
          await removeArchivedSessionFromStore(this.options.layout.harness, sessionId)
        } finally {
          await this.options.startRuntime()
        }
      }
    })
  }

  async deleteArchivedSession(sessionId: string): Promise<void> {
    await this.enqueueArchiveMutation(async () => {
      if (this.options.isDeveloperMode?.() !== true) {
        throw new Error('永久删除归档会话仅在开发者模式下可用')
      }
      if (this.options.getRuntimeUrl() === undefined) {
        throw new Error('DSH Runtime 尚未启动')
      }
      if (this.options.stopRuntime === undefined || this.options.startRuntime === undefined) {
        throw new Error('当前 DSH Runtime 不支持永久删除归档 Session，请重启应用后重试')
      }

      await this.options.stopRuntime()
      try {
        const deleted = await deleteArchivedSessionFromStore(this.options.layout.harness, sessionId)
        if (!deleted) throw new Error('Session 已不在归档列表中')
      } finally {
        await this.options.startRuntime()
      }
    })
  }

  private enqueueArchiveMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.archiveMutation.then(operation, operation)
    this.archiveMutation = run.then(() => undefined, () => undefined)
    return run
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
    if (this.adapters.size === 0) {
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

  private async handleUnauthorizedMessage(
    adapter: ChannelAdapter,
    message: ChannelMessage,
  ): Promise<ChannelReply | undefined> {
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
    const adapterConfig = (this.config.adapters[adapter.name] ?? {}) as AdapterConfig
    const baseAllowList = adapterConfig.allowList ?? this.config.allowList ?? []

    if (baseAllowList.includes(openId)) {
      await this.cancelPairing()
      return {
        to: { userId: openId },
        content: '该用户已经在白名单中，无需重复配对。',
      }
    }

    const allowList = [...baseAllowList, openId]
    const nextAdapters = {
      ...this.config.adapters,
      [adapter.name]: { ...adapterConfig, allowList },
    }
    this.config = { ...this.config, adapters: nextAdapters }
    await this.configStorage.saveConfig(this.config)
    adapter.updateAllowList(allowList)
    await this.cancelPairing()

    console.log(`[channel-bridge] paired with ${openId}`)
    return {
      to: { userId: openId },
      content: '配对成功，你已被加入白名单。现在可以直接发送消息使用远程控制。',
    }
  }

  private async handleMessage(
    adapter: ChannelAdapter,
    message: ChannelMessage,
  ): Promise<ChannelReply | undefined> {
    const text = message.content.text.trim()
    if (text === '') return undefined

    console.log(`[channel-bridge] ${message.adapter} message from ${message.from.id}: ${text}`)

    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) {
      return this.buildReply(message, '执行失败：DSH Runtime 尚未启动')
    }

    const adapterConfig = (this.config.adapters[adapter.name] ?? {}) as AdapterConfig
    const fallbackSessionId = adapterConfig.sessionId ?? this.config.sessionId

    let sessionId: string
    try {
      sessionId = await this.ensureSession(adapter.name, runtimeUrl, fallbackSessionId)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      return this.buildReply(message, `执行失败：${messageText}`)
    }

    if (this.activeTurns.has(sessionId)) {
      return this.buildReply(message, '当前会话已有任务在执行，请等待完成后再发送新消息。')
    }

    this.activeTurns.set(sessionId, true)
    await this.safeSetStatus(adapter, message.messageId, 'processing')

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
            void this.safeSetStatus(adapter, message.messageId, 'done').finally(() => {
              void this.safeSend(adapter, {
                to: recipient,
                content: answer.length > 0 ? answer : 'DSH 没有返回任何输出。',
              })
            })
          },
          onError: (error) => {
            this.activeTurns.delete(sessionId)
            void this.safeSetStatus(adapter, message.messageId, 'error').finally(() => {
              void this.safeSend(adapter, {
                to: recipient,
                content: `执行失败：${error}`,
              })
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
        void this.safeSetStatus(adapter, message.messageId, 'error').finally(() => {
          void this.safeSend(adapter, { to: recipient, content: `执行失败：${messageText}` })
        })
      })

    // Return immediately so the adapter can acknowledge the platform quickly.
    return undefined
  }

  private async ensureSession(
    adapterName: string,
    runtimeUrl: string,
    fallbackSessionId?: string,
  ): Promise<string> {
    if (fallbackSessionId !== undefined && fallbackSessionId.length > 0) {
      return fallbackSessionId
    }

    const client = new DshSessionClient({
      baseUrl: runtimeUrl,
      timeoutMs: 10_000,
    })
    const session = await client.createSession({ cwd: this.config.workspace })

    const adapterConfig = (this.config.adapters[adapterName] ?? {}) as AdapterConfig
    const nextAdapters = {
      ...this.config.adapters,
      [adapterName]: { ...adapterConfig, sessionId: session.sessionId },
    }
    this.config = { ...this.config, adapters: nextAdapters }
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

  private async safeSend(adapter: ChannelAdapter, reply: ChannelReply): Promise<void> {
    try {
      await adapter.send(reply)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error(`[channel-bridge] failed to send reply via ${adapter.name}:`, messageText)
    }
  }

  private async safeSetStatus(
    adapter: ChannelAdapter,
    messageId: string,
    status: ChannelMessageStatus,
  ): Promise<void> {
    if (adapter.setStatus === undefined || messageId === '') {
      return
    }
    try {
      await adapter.setStatus(messageId, status)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error(`[channel-bridge] failed to set status on ${adapter.name}:`, messageText)
    }
  }
}
