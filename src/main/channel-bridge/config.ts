import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdapterConfig } from '../../shared/channel-bridge.js'
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
        const parsed = JSON.parse(raw) as Partial<ChannelBridgeConfig> & { feishu?: unknown }
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

interface LegacyConfig extends Partial<ChannelBridgeConfig> {
  feishu?: unknown
  enabled?: boolean
}

function mergeConfig(override: LegacyConfig): ChannelBridgeConfig {
  const adapters: Record<string, AdapterConfig> = {}

  for (const [name, cfg] of Object.entries(override.adapters ?? {})) {
    adapters[name] = cfg !== undefined && typeof cfg === 'object' ? ({ ...cfg } as AdapterConfig) : {}
  }

  // Backward compatibility: legacy top-level `feishu` field moves under `adapters.feishu`.
  if (override.feishu !== undefined && adapters.feishu === undefined) {
    adapters.feishu = override.feishu as AdapterConfig
  }

  // Backward compatibility: copy global sessionId/allowList into each adapter config
  // so that each platform can manage its own session and whitelist independently.
  for (const cfg of Object.values(adapters)) {
    if (override.sessionId !== undefined && cfg.sessionId === undefined) {
      cfg.sessionId = override.sessionId
    }
    if (override.allowList !== undefined && cfg.allowList === undefined) {
      cfg.allowList = override.allowList
    }
    // Backward compatibility: the legacy top-level `enabled` flag becomes per-adapter.
    if (override.enabled !== undefined && cfg.enabled === undefined) {
      cfg.enabled = override.enabled
    }
  }

  return {
    adapters,
    sessionId: override.sessionId,
    allowList: override.allowList ?? (DEFAULT_CHANNEL_BRIDGE_CONFIG.allowList ?? []),
    workspace: override.workspace ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.workspace,
    timeoutMs: override.timeoutMs ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.timeoutMs,
    sessionTimeoutMs: override.sessionTimeoutMs ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.sessionTimeoutMs,
    statusIntervalMs: override.statusIntervalMs ?? DEFAULT_CHANNEL_BRIDGE_CONFIG.statusIntervalMs,
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
