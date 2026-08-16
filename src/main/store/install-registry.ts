/**
 * On-disk registry of store-installed entries (`state/installed.json`).
 * Records are the source of truth for "installed" badges, update detection,
 * and uninstall routing; writes are atomic (temp file + rename).
 *
 * @module install-registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { InstalledRecord, StoreKind } from '../../shared/store.js'

/** Atomic-file JSON registry of installed store entries. */
export class InstallRegistry {
  constructor(private readonly filePath: string) {}

  /** Every record, ordered by install time. */
  async list(): Promise<InstalledRecord[]> {
    const records = await this.load()
    return [...records].sort((left, right) => left.installedAt.localeCompare(right.installedAt))
  }

  /** One record by kind and id. */
  async find(kind: StoreKind, id: string): Promise<InstalledRecord | undefined> {
    const records = await this.load()
    return records.find((record) => record.kind === kind && record.id === id)
  }

  /** Insert or replace the record for a kind+id pair. */
  async upsert(record: InstalledRecord): Promise<void> {
    const records = await this.load()
    const index = records.findIndex((candidate) => candidate.kind === record.kind && candidate.id === record.id)
    if (index >= 0) records[index] = record
    else records.push(record)
    await this.save(records)
  }

  /** Delete the record for a kind+id pair. */
  async remove(kind: StoreKind, id: string): Promise<boolean> {
    const records = await this.load()
    const index = records.findIndex((candidate) => candidate.kind === kind && candidate.id === id)
    if (index < 0) return false
    records.splice(index, 1)
    await this.save(records)
    return true
  }

  private async load(): Promise<InstalledRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((value): value is InstalledRecord =>
        typeof value === 'object' && value !== null
        && typeof (value as InstalledRecord).kind === 'string'
        && typeof (value as InstalledRecord).id === 'string'
        && typeof (value as InstalledRecord).version === 'string')
    } catch {
      return []
    }
  }

  private async save(records: readonly InstalledRecord[]): Promise<void> {
    const tempFile = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp-${String(Date.now())}`)
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
    await rename(tempFile, this.filePath)
  }
}
