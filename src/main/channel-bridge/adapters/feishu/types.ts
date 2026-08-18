export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey?: string
}

export interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      union_id?: string
      user_id?: string
      open_id?: string
      name?: string
    }
    sender_type?: string
    tenant_key?: string
  }
  message?: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time?: string
    update_time?: string
    chat_id: string
    thread_id?: string
    chat_type: string
    message_type?: string
    content: string
    mentions?: unknown[]
    user_agent?: string
    lark_agent_context?: unknown
  }
}
