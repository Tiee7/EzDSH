import type { DshSessionSummary } from './channel-bridge.js'

/** Renderer-safe text extracted from a Harness conversation. */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  text: string
  seq: number
  time: number
}

/** A bounded, immutable view of the conversation used for an explicit conversion preview. */
export interface ConversationSnapshot {
  session: DshSessionSummary
  projectId?: string
  cwd?: string
  throughSeq: number
  snapshotHash: string
  truncated: boolean
  messages: ConversationMessage[]
}

export interface ConversationWorkOrigin {
  kind: 'conversation'
  sessionId: string
  throughSeq: number
  snapshotHash: string
}

export interface ConversationWorkInput {
  kind: 'conversation'
  sessionId: string
  throughSeq: number
  snapshotHash: string
  messages: ConversationMessage[]
}
