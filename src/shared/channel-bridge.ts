export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
}

export interface ChannelBridgeConfig {
  enabled: boolean
  port: number
  feishu?: FeishuConfig
  allowList: string[]
  workspace?: string
  timeoutMs: number
}
