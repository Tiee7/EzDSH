/** Pure display helpers for the store UI: version comparison and audit badge mapping. */

import { STORE_CATEGORY_LABELS_ZH, type InstalledRecord, type StoreAuditLevel, type StoreCategory, type StoreEntry, type InstallPhase } from '../../shared/store.js'
import type { AppCopy, AppLocale } from '../../shared/locale.js'

export type StoreEntryType = 'plugin' | 'mcp'

/**
 * Compare two dotted version strings numerically part by part.
 * @returns positive when `left` is newer, negative when older, 0 when equal.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** Whether the installed record is older than the catalog entry. */
export function updateAvailable(installed: InstalledRecord | undefined, entry: StoreEntry): boolean {
  if (installed === undefined) return false
  return compareVersions(entry.version, installed.version) > 0
}

/** CSS tone class for one audit level badge. */
export function auditTone(level: StoreAuditLevel): string {
  if (level === 'verified') return 'badge-verified'
  if (level === 'basic') return 'badge-basic'
  return 'badge-unaudited'
}

/** Label for one audit level. */
export function auditLabel(copy: AppCopy, level: StoreAuditLevel): string {
  if (level === 'verified') return copy.auditVerified
  if (level === 'basic') return copy.auditBasic
  return copy.auditUnaudited
}

/** Identify the installable extension represented by a catalog entry. */
export function entryType(entry: StoreEntry): StoreEntryType | undefined {
  if (entry.plugin !== undefined) return 'plugin'
  if (entry.mcp !== undefined || entry.kind === 'mcp') return 'mcp'
  return undefined
}

/** Localized label for an entry type badge. */
export function entryTypeLabel(copy: AppCopy, type: StoreEntryType): string {
  return type === 'plugin' ? copy.storeEntryTypePlugin : copy.storeEntryTypeMcp
}

/** Display the Chinese category label in Chinese and the stable id in English. */
export function categoryLabel(category: StoreCategory, locale: AppLocale): string {
  if (locale === 'en') return category.id
  return STORE_CATEGORY_LABELS_ZH[category.id] ?? category.name
}

/** Progress text for one install phase. */
export function phaseLabel(copy: AppCopy, phase: InstallPhase): string {
  switch (phase) {
    case 'downloading': return copy.phaseDownloading
    case 'auditing': return copy.phaseAuditing
    case 'confirm-wait': return copy.storeAuditReport
    case 'installing': return copy.phaseInstalling
    case 'done': return copy.phaseDone
    case 'failed': return copy.phaseFailed
  }
}
