import { createHash } from 'node:crypto'
import type { DshSessionSummary, DshWorkspaceSummary } from '../channel-bridge/dsh-session.js'
import { DshSessionClient } from '../channel-bridge/dsh-session.js'
import type { ConversationMessage, ConversationSnapshot } from '../../shared/conversation-work.js'

const MAX_MESSAGES = 80
const MAX_MESSAGE_LENGTH = 20_000
const MAX_TOTAL_MESSAGE_LENGTH = 60_000

export interface ConversationServiceOptions {
  getRuntimeUrl(): string | undefined
}

/** Main-owned, read-only bridge from a DSH Session to a bounded conversion snapshot. */
export class ConversationService {
  constructor(private readonly options: ConversationServiceOptions) {}

  async listSessions(): Promise<DshSessionSummary[]> {
    return this.client().listSessions()
  }

  async getSnapshot(sessionId: string): Promise<ConversationSnapshot | undefined> {
    const normalized = sessionId.trim()
    if (normalized === '' || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new Error('Conversation session id is invalid')
    }
    const client = this.client()
    const sessions = await client.listSessions()
    const session = sessions.find((candidate) => candidate.sessionId === normalized)
    if (session === undefined) return undefined
    const [history, workspaces] = await Promise.all([
      client.getSessionHistory(normalized, { maxMessages: 200 }),
      client.listWorkspaces().catch(() => [] as DshWorkspaceSummary[]),
    ])
    const events = history.events
      .map((entry) => entry.event)
      .sort((left, right) => left.seq - right.seq)
    const messageEvents = events.filter((event) =>
      (event.type === 'user/message' || event.type === 'assistant/message') && isConversationMessage(event.type, event.data),
    )
    const parsedMessages = messageEvents
      .map((event): ConversationMessage | undefined => {
        const text = messageText(event.data)
        if (text === undefined) return undefined
        return {
          role: event.type === 'user/message' ? 'user' : 'assistant',
          text,
          seq: event.seq,
          time: event.time,
        }
      })
      .filter((message): message is ConversationMessage => message !== undefined)
    const bounded = boundMessages(parsedMessages.slice(-MAX_MESSAGES))
    const throughSeq = events.length === 0 ? -1 : Math.max(...events.map((event) => event.seq))
    const workspace = workspaces.find((candidate) => candidate.sessionIds.includes(normalized))
    const snapshotHash = createHash('sha256')
      .update(JSON.stringify({ sessionId: normalized, throughSeq, messages: bounded.messages }), 'utf8')
      .digest('hex')
    return {
      session: { ...session },
      ...(workspace === undefined ? {} : { projectId: workspace.workspaceId, cwd: workspace.path }),
      throughSeq,
      snapshotHash,
      truncated: history.hasMore || parsedMessages.length > MAX_MESSAGES || bounded.truncated,
      messages: bounded.messages,
    }
  }

  private client(): DshSessionClient {
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) throw new Error('DSH Runtime 尚未启动')
    return new DshSessionClient({ baseUrl: runtimeUrl, timeoutMs: 15_000 })
  }
}

function messageText(data: unknown): string | undefined {
  const record = isRecord(data) ? data : undefined
  const message = record !== undefined && isRecord(record.message) ? record.message : record
  const content = message?.content
  if (typeof content === 'string') return clip(content)
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
  return clip(text)
}

function clip(value: string): string | undefined {
  const normalized = value.trim()
  if (normalized === '') return undefined
  return normalized.length <= MAX_MESSAGE_LENGTH ? normalized : `${normalized.slice(0, MAX_MESSAGE_LENGTH)}\n…`
}

function boundMessages(messages: ConversationMessage[]): { messages: ConversationMessage[]; truncated: boolean } {
  const bounded: ConversationMessage[] = []
  let total = 0
  let truncated = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const available = MAX_TOTAL_MESSAGE_LENGTH - total
    if (available <= 0) {
      truncated = true
      break
    }
    const message = messages[index]
    if (message === undefined) continue
    const text = message.text.length <= available
      ? message.text
      : available <= 2 ? message.text.slice(0, available) : `${message.text.slice(0, available - 2)}\n…`
    if (text.length < message.text.length) truncated = true
    bounded.unshift({ ...message, text })
    total += text.length
  }
  return { messages: bounded, truncated }
}

function isConversationMessage(type: string, data: unknown): boolean {
  const record = isRecord(data) ? data : undefined
  const message = record !== undefined && isRecord(record.message) ? record.message : record
  const source = message !== undefined && isRecord(message.source)
    ? message.source
    : record !== undefined && isRecord(record.source) ? record.source : undefined
  const kind = source?.kind
  if (kind === undefined) return true
  if (type === 'user/message') return kind === 'user'
  return kind !== 'plugin' && kind !== 'system'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
