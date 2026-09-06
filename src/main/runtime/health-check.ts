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

/**
 * Poll a local Runtime URL until it returns a successful HTTP response.
 *
 * DSH's printed browser URL is an authentication entry point. Never probe that
 * URL from the main process: its redirect and cookie belong to a different
 * client context from the renderer iframe, which can leave the iframe with an
 * authentication error on Runtime versions that treat the launch token as a
 * one-shot browser handoff.
 */
export async function waitForRuntimeHealthy(
  url: string,
  options: HealthCheckOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 150
  const fetchImpl = options.fetchImpl ?? fetch
  const deadline = Date.now() + timeoutMs
  const healthUrl = runtimeHealthUrl(url)

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remainingMs)
    try {
      const response = await fetchImpl(healthUrl, { method: 'GET', redirect: 'manual', signal: controller.signal })
      if (response.ok) return
    } catch (error) {
      if (error instanceof RuntimeHealthError) throw error
      // The server may still be binding. Connection failures are expected during startup.
    } finally {
      clearTimeout(timer)
    }

    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)))
  }

  throw new RuntimeHealthError(`Runtime did not become healthy within ${String(timeoutMs)}ms`)
}

/** Use a public static asset so the browser launch token remains renderer-owned. */
export function runtimeHealthUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('token')) return url
    parsed.pathname = '/manifest.webmanifest'
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return url
  }
}
