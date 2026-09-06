#!/usr/bin/env node

/** CI/publish-time structural gate for a Store catalog JSON payload. */

import { readFile } from 'node:fs/promises'

const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const NPM_SOURCE = /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[^\s/][^\s]*)?$/
const GITHUB_SOURCE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[A-Za-z0-9_.\/-]+)?$/

/** Return all admission errors without throwing on the first bad entry. */
export function checkCatalogPayload(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.entries
  if (!Array.isArray(entries)) return ['catalog must be an array or an object with an entries array']
  const errors = []
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object' || entry.plugin === undefined) continue
    const prefix = `entry ${entry.id ?? index}`
    if (entry.plugin === null || typeof entry.plugin !== 'object') {
      errors.push(`${prefix}: plugin config is invalid`)
      continue
    }
    if (entry.kind !== 'skill') errors.push(`${prefix}: plugin entries must use kind=skill`)
    if (entry.category !== 'plugin') errors.push(`${prefix}: plugin entries must use category=plugin`)
    const source = entry.plugin.source
    if (typeof source !== 'string' || (!NPM_SOURCE.test(source) && !GITHUB_SOURCE.test(source))) {
      errors.push(`${prefix}: plugin source is invalid`)
    }
    const packageName = entry.plugin.packageName
    if (packageName !== undefined && (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName))) {
      errors.push(`${prefix}: packageName is invalid`)
    }
    const verification = entry.plugin.verification
    if (verification?.allowBuilds !== undefined && (!Array.isArray(verification.allowBuilds) || verification.allowBuilds.some((spec) => typeof spec !== 'string' || spec.trim() === ''))) {
      errors.push(`${prefix}: verification allowBuilds must contain exact non-empty package specs`)
    }
  }
  return errors
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('Usage: node scripts/check-store-catalog.mjs <catalog.json>')
    process.exit(2)
  }
  try {
    const errors = checkCatalogPayload(JSON.parse(await readFile(file, 'utf8')))
    if (errors.length > 0) {
      for (const error of errors) console.error(`catalog: ${error}`)
      process.exit(1)
    }
    console.log('catalog: plugin admission checks passed')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
