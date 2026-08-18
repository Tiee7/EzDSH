export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey?: string
}

export interface ChannelBridgeConfig {
  enabled: boolean
  feishu?: FeishuConfig
  allowList: string[]
  workspace?: string
  timeoutMs: number
}
