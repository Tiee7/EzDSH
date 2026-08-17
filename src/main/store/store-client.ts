/**
 * Remote curation API client. Fetches catalog lists, entry details, and
 * categories over HTTPS from the configured store origin, with a short-lived
 * per-query cache and a hard request timeout. The client never interprets
 * entry content; validation beyond URL shape and response status lives in the
 * audit engine.
 *
 * @module store-client
 */

import { STORE_API_BASE_URL, isStoreKind, type StoreCategory, type StoreEntry, type StoreKind, type StoreListResult } from '../../shared/store.js'

export interface StoreClientOptions {
  /** API origin; defaults to the shipped store URL. Must be https. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Request timeout in milliseconds. */
  timeoutMs?: number
  /** How long a cached list stays fresh. */
  cacheTtlMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CACHE_TTL_MS = 5 * 60_000

interface CacheSlot {
  readonly expiresAt: number
  readonly value: unknown
}

/** Query parameters for a catalog list call. */
export interface StoreListQuery {
  readonly category?: string
  readonly search?: string
  readonly page?: number
}

/** HTTPS client for the curated store API. */
export class StoreClient {
  private readonly baseUrl: URL
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly cache = new Map<string, CacheSlot>()

  constructor(options: StoreClientOptions = {}) {
    const base = options.baseUrl ?? STORE_API_BASE_URL
    this.baseUrl = new URL(base)
    if (this.baseUrl.protocol !== 'https:') {
      throw new Error(`StoreClient requires an https API origin: ${base}`)
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  /** List catalog entries of one kind. `force` bypasses the response cache. */
  async list(kind: StoreKind, query: StoreListQuery = {}, options: { force?: boolean } = {}): Promise<StoreListResult> {
    const params = new URLSearchParams({ kind })
    if (query.category !== undefined && query.category !== '') params.set('category', query.category)
    if (query.search !== undefined && query.search !== '') params.set('q', query.search)
    params.set('page', String(query.page ?? 1))
    return this.request(`/v1/store?${params.toString()}`, { cache: options.force !== true }) as Promise<StoreListResult>
  }

  /** Fetch one entry's detail. */
  async entry(kind: StoreKind, id: string): Promise<StoreEntry> {
    const path = `/v1/store/${kind}/${encodeURIComponent(id)}`
    const entry = await this.request(path, {}) as StoreEntry
    if (!isStoreKind(entry?.kind) || entry.kind !== kind || entry.id !== id) {
      throw new Error(`Store returned an entry whose kind or id does not match the request ${kind}/${id}`)
    }
    return entry
  }

  /** Fetch the category list. `force` bypasses the response cache. */
  async categories(options: { force?: boolean } = {}): Promise<StoreCategory[]> {
    return this.request('/v1/categories', { cache: options.force !== true }) as Promise<StoreCategory[]>
  }

  private async request(path: string, options: { cache?: boolean }): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    const cacheKey = url.toString()
    if (options.cache === true) {
      const slot = this.cache.get(cacheKey)
      if (slot !== undefined && slot.expiresAt > Date.now()) return slot.value
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new Error(`Store request failed: ${String(response.status)} ${url.pathname}`)
    }
    const value: unknown = await response.json()
    if (options.cache === true) {
      this.cache.set(cacheKey, { value, expiresAt: Date.now() + this.cacheTtlMs })
    }
    return value
  }
}
