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
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
      // DSH 0.1.2 exchanges the launch token for an auth cookie with a redirect.
      // A legacy Runtime still responds directly with 200.
      if (hasRuntimeToken(url)) {
        if (response.status !== 303) {
          throw new RuntimeHealthError(`Runtime token exchange expected 303, got ${String(response.status)}`)
        }
        if (!hasDshAuthCookie(response.headers.get('set-cookie'))) {
          throw new RuntimeHealthError('Runtime token exchange returned 303 without a dsh-auth-* Set-Cookie header')
        }
        return
      }
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

function hasRuntimeToken(url: string): boolean {
  try {
    return new URL(url).searchParams.has('token')
  } catch {
    return false
  }
}

function hasDshAuthCookie(setCookie: string | null): boolean {
  return setCookie !== null && /(?:^|,\s*)dsh-auth-[^=;]+=/iu.test(setCookie)
}
