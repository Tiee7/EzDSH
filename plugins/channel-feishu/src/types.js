/**
 * @typedef {object} FeishuConfig
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} [encryptKey]
 */

/**
 * @typedef {object} FeishuMessageEvent
 * @property {object} [sender]
 * @property {object} [sender.sender_id]
 * @property {string} [sender.sender_id.open_id]
 * @property {string} [sender.sender_id.name]
 * @property {object} [message]
 * @property {string} message.message_id
 * @property {string} message.chat_id
 * @property {string} message.chat_type
 * @property {string} message.content
 */

/**
 * @typedef {'received' | 'processing' | 'done' | 'error'} ChannelMessageStatus
 */

/**
 * @typedef {object} ChannelMessage
 * @property {string} adapter
 * @property {string} messageId
 * @property {{ id: string, name?: string }} from
 * @property {{ id: string, type: 'private' | 'group', name?: string }} [chat]
 * @property {{ type: 'text', text: string }} content
 * @property {number} timestamp
 */

/**
 * @typedef {object} ChannelReply
 * @property {{ userId?: string, chatId?: string }} to
 * @property {string} content
 */

/**
 * @typedef {object} ChannelAdapterCreateOptions
 * @property {unknown} config
 * @property {string[]} allowList
 * @property {Logger} logger
 * @property {(message: ChannelMessage) => Promise<ChannelReply | undefined>} [onUnauthorizedMessage]
 */

/**
 * @typedef {object} Logger
 * @property {(message: string, ...args: unknown[]) => void} info
 * @property {(message: string, ...args: unknown[]) => void} error
 * @property {(message: string, ...args: unknown[]) => void} warn
 */

export {}
