import { APP_VERSION } from '../../shared/app-identity.js'
import { STORE_API_BASE_URL, type StoreKind } from '../../shared/store.js'

export type InstallReportKind = StoreKind | 'plugin'

export interface InstallErrorReport {
  readonly kind: InstallReportKind
  readonly entryId: string
  readonly errorCode: string
  readonly errorMessage?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface InstallErrorReporterOptions {
  /** Hub origin; defaults to the shipped store URL. Must be HTTPS. */
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly dedupeWindowMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_DEDUPE_WINDOW_MS = 60_000
const MAX_MESSAGE_LENGTH = 500
const MAX_DETAIL_DEPTH = 3
const MAX_DETAIL_ITEMS = 32
const SENSITIVE_DETAIL_KEY = /token|secret|password|authorization|cookie|credential|private.?key/i
const ABSOLUTE_POSIX_PATH_PATTERN = /(^|[\s("'`=])\/[^\s"'`),;]+/g
const ABSOLUTE_WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`),;]+/g

/** Best-effort Hub reporter; all transport failures are intentionally ignored. */
export class InstallErrorReporter {
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly dedupeWindowMs: number
  private readonly recent = new Map<string, number>()

  constructor(options: InstallErrorReporterOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? STORE_API_BASE_URL)
    if (baseUrl.protocol !== 'https:') throw new Error(`InstallErrorReporter requires an https API origin: ${baseUrl}`)
    this.endpoint = new URL('/v1/install-report', baseUrl).toString()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS
  }

  async report(input: InstallErrorReport): Promise<void> {
    const detail = sanitizeDetail(input.detail)
    const report = {
      kind: input.kind,
      entryId: input.entryId,
      errorCode: input.errorCode,
      ...(input.errorMessage === undefined ? {} : { errorMessage: sanitizeString(input.errorMessage, MAX_MESSAGE_LENGTH) }),
      clientVersion: APP_VERSION,
      ...(detail === undefined ? {} : { detail })
    }
    const key = JSON.stringify(report)
    const now = Date.now()
    for (const [recentKey, timestamp] of this.recent) {
      if (now - timestamp >= this.dedupeWindowMs) this.recent.delete(recentKey)
    }
    if (this.recent.has(key)) return
    this.recent.set(key, now)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        signal: controller.signal
      })
    } catch {
      // Reporting must never affect the install result.
    } finally {
      clearTimeout(timer)
    }
  }
}

function sanitizeString(value: string, maxLength: number): string {
  return value
    .replace(ABSOLUTE_POSIX_PATH_PATTERN, '$1[path]')
    .replace(ABSOLUTE_WINDOWS_PATH_PATTERN, '[path]')
    .slice(0, maxLength)
}

function sanitizeDetail(value: Readonly<Record<string, unknown>> | undefined, depth = 0): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || depth >= MAX_DETAIL_DEPTH) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_DETAIL_ITEMS)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue
    const sanitized = sanitizeDetailValue(item, depth + 1)
    if (sanitized !== undefined) result[key] = sanitized
  }
  return result
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeString(value, 300)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ITEMS).map((item) => sanitizeDetailValue(item, depth)).filter((item) => item !== undefined)
  }
  if (typeof value === 'object' && value !== null) return sanitizeDetail(value as Readonly<Record<string, unknown>>, depth)
  return undefined
}
