import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelBridgeConfig } from './types.js'
import { DEFAULT_CHANNEL_BRIDGE_CONFIG } from './types.js'

const CONFIG_FILE_NAME = 'channel-bridge.json'

export interface ConfigStorage {
  getConfigPath(): string
  loadConfig(): Promise<ChannelBridgeConfig>
  saveConfig(config: ChannelBridgeConfig): Promise<void>
}

export function createConfigStorage(stateDir: string): ConfigStorage {
  const configPath = join(stateDir, CONFIG_FILE_NAME)

  return {
    getConfigPath(): string {
      return configPath
    },

    async loadConfig(): Promise<ChannelBridgeConfig> {
      try {
        const raw = await readFile(configPath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<ChannelBridgeConfig>
        return mergeConfig(parsed)
      } catch (error) {
        if (isNotFound(error)) return { ...DEFAULT_CHANNEL_BRIDGE_CONFIG }
        throw error
      }
    },

    async saveConfig(config: ChannelBridgeConfig): Promise<void> {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    },
  }
}

function mergeConfig(override: Partial<ChannelBridgeConfig>): ChannelBridgeConfig {
  return {
    enabled: override.enabled ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.enabled,
    feishu: override.feishu,
    sessionId: override.sessionId,
    allowList: override.allowList ?? [...DEFAULT_CHANNEL_BRIDGE_CONFIG.allowList],
    workspace: override.workspace ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.workspace,
    timeoutMs: override.timeoutMs ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.timeoutMs,
    sessionTimeoutMs: override.sessionTimeoutMs ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.sessionTimeoutMs,
    statusIntervalMs: override.statusIntervalMs ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.statusIntervalMs,
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
