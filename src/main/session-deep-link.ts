export interface OpenDeepLinkedSessionOptions {
  sessionId: string
  unarchiveSession(sessionId: string): Promise<void>
  emitSession(sessionId: string): void
  onUnarchiveError?(error: Error): void
}

export async function openDeepLinkedSession(options: OpenDeepLinkedSessionOptions): Promise<void> {
  try {
    await options.unarchiveSession(options.sessionId)
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    options.onUnarchiveError?.(error)
  }
  options.emitSession(options.sessionId)
}
