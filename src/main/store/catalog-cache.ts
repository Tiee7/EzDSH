/**
 * Persisted snapshot of the last successful remote catalog refresh
 * (`state/store-catalog.json`). Serving list/entry/categories from this
 * snapshot keeps every store surface offline-capable; only an explicit
 * refresh re-fetches. Writes are atomic (temp file + rename).
 *
 * @module catalog-cache
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { STORE_KINDS, type StoreCategory, type StoreEntry, type StoreKind } from '../../shared/store.js'

/** One persisted remote catalog snapshot. */
export interface CachedCatalog {
  readonly fetchedAt: string
  readonly categories: readonly StoreCategory[]
  readonly byKind: Readonly<Record<StoreKind, readonly StoreEntry[]>>
}

function isEntryArray(value: unknown): value is readonly StoreEntry[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'object' && entry !== null
      && typeof (entry as StoreEntry).id === 'string'
      && typeof (entry as StoreEntry).kind === 'string')
}

/**
 * Read a catalog snapshot; returns undefined for a missing or malformed file.
 * @param filePath - cache file location.
 */
export async function readCatalogCache(filePath: string): Promise<CachedCatalog | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Partial<CachedCatalog> & { byKind?: unknown }
  if (typeof candidate.fetchedAt !== 'string' || !Array.isArray(candidate.categories)) return undefined
  if (typeof candidate.byKind !== 'object' || candidate.byKind === null) return undefined
  const byKind = {} as Record<StoreKind, readonly StoreEntry[]>
  for (const kind of STORE_KINDS) {
    const rows = (candidate.byKind as Record<string, unknown>)[kind]
    byKind[kind] = isEntryArray(rows) ? rows : []
  }
  return { fetchedAt: candidate.fetchedAt, categories: candidate.categories, byKind }
}

/** Atomically persist a catalog snapshot. */
export async function writeCatalogCache(filePath: string, catalog: CachedCatalog): Promise<void> {
  const tempFile = join(dirname(filePath), `.${basename(filePath)}.tmp-${String(Date.now())}`)
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(tempFile, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 })
  await rename(tempFile, filePath)
}
