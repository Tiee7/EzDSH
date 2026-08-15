export const RUNTIME_TIMEOUT = 'RUNTIME_TIMEOUT' as const

export class RuntimeHealthError extends Error {
  readonly code = RUNTIME_TIMEOUT

  constructor(message: string) {
    super(message)
    this.name = 'RuntimeHealthError'
  }
}

export interface HealthCheckOptions {
  timeoutMs?: number
  intervalMs?: number
  fetchImpl?: typeof fetch
}

/** Poll a local Runtime URL until it returns a successful HTTP response. */
export async function waitForRuntimeHealthy(
  url: string,
  options: HealthCheckOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const fetchImpl = options.fetchImpl ?? fetch
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remainingMs)
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal })
      if (response.ok) return
    } catch {
      // The server may still be binding. Connection failures are expected during startup.
    } finally {
      clearTimeout(timer)
    }

    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)))
  }

  throw new RuntimeHealthError(`Runtime did not become healthy within ${String(timeoutMs)}ms`)
}
