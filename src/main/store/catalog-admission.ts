import type { StoreEntry } from '../../shared/store.js'
import { validatePluginSource } from './dsh-plugin-installer.js'

const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/

/**
 * Validate the non-negotiable part of catalog admission.
 *
 * This is a structural catalog check, not a Hub-side installability gate.
 * Third-party plugin sources may be published before EzDSH has run an isolated
 * install. Installability is decided by the install pipeline at install time;
 * optional verification metadata may improve that pipeline but is not required
 * for directory visibility.
 */
export function catalogAdmission(entry: StoreEntry): { ok: boolean; reasons: readonly string[] } {
  if (entry.plugin === undefined) return { ok: true, reasons: [] }
  if (entry.plugin === null || typeof entry.plugin !== 'object') {
    return { ok: false, reasons: ['DSH plugin config is invalid.'] }
  }

  const reasons: string[] = []
  if (entry.kind !== 'skill') reasons.push('DSH plugin entries must use kind=skill.')
  if (entry.category !== 'plugin') reasons.push('DSH plugin entries must use category=plugin.')
  try {
    validatePluginSource(entry.plugin)
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error))
  }

  const packageName = entry.plugin.packageName
  if (packageName !== undefined && (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName))) {
    reasons.push(`Invalid DSH plugin package name: ${packageName}`)
  }
  return { ok: reasons.length === 0, reasons }
}

/** Throw a catalog admission error with all reasons preserved for diagnostics. */
export function assertCatalogAdmission(entry: StoreEntry): void {
  const result = catalogAdmission(entry)
  if (result.ok) return
  throw new Error(`Catalog entry rejected: ${result.reasons.join(' ')}`)
}
