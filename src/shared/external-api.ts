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
