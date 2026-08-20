import type { DshSessionSummary } from './channel-bridge.js'

export const EXTERNAL_API_DEFAULT_PORT = 53260

export interface ExternalProject {
  id: string
  title: string
  path: string
  sessionIds: string[]
  sessions: DshSessionSummary[]
}

export interface ExternalSessionCreateRequest {
  projectId?: string
  cwd?: string
  sessionId?: string
}

export interface ExternalDispatchRequest {
  projectId: string
  sessionMode: 'new' | 'existing'
  sessionId?: string
  prompt: string
}

export interface ExternalDispatchResponse {
  accepted: true
  projectId: string
  sessionId: string
  sessionMode: 'new' | 'existing'
}

export type ExternalRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ExternalRunEventType = 'queued' | 'started' | 'delta' | 'completed' | 'failed' | 'cancelled'

export interface ExternalRunRequest {
  projectId?: string
  sessionMode?: 'new' | 'existing'
  sessionId?: string
  prompt: string
  /** Archive a newly-created session until a user opens its conversation. */
  archiveSession?: boolean
  output?: { format?: 'text' | 'json' }
  client?: { name?: string; requestId?: string }
}

export interface ExternalRunSnapshot {
  runId: string
  sessionId: string
  status: ExternalRunStatus
  text: string
  result?: unknown
  error?: string
  createdAt: string
  updatedAt: string
}

export interface ExternalRunEvent {
  id: number
  runId: string
  type: ExternalRunEventType
  at: string
  data: Record<string, unknown>
}
