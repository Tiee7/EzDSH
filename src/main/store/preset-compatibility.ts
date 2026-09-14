/** Targeted, non-evaluating repair for presets authored before persona used `prefix`. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { presetsDir } from './install-paths.js'

/** Preset id grammar enforced by dsh-agent-presets discovery. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const PERSONA_PLUGIN = '@deepseek-ai/dsh-persona'
const COMPOSITION_FILE = 'agent.cordis.yml'

/**
 * Rename the legacy persona config key using YAML source ranges. Parsing never
 * evaluates `!!js`; unrelated bytes, scalar style, tags, and comments survive.
 * Aliases, anchored maps, and merge maps are left alone because their effects
 * can extend beyond the selected persona entry.
 */
export function normalizeLegacyPresetPersona(bytes: Buffer): Buffer {
  const source = bytes.toString('utf8')
  const document = parseDocument(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }]
  })
  if (document.errors.length > 0) {
    throw new Error(`Cannot repair preset YAML: ${document.errors.map((error) => error.message).join('; ')}`)
  }
  const edits: Array<{ start: number; end: number; value: string }> = []
  const visitRows = (rows: unknown): void => {
    if (!isSeq(rows) || rows.anchor) return
    for (const row of rows.items) {
      if (!isMap(row) || row.anchor) continue
      const config = row.get('config', true)
      if (row.get('group') === true) {
        visitRows(config)
        continue
      }
      if (row.get('name') !== PERSONA_PLUGIN || !isMap(config) || config.anchor || config.has('<<') || config.has('prefix')) continue
      const legacy = config.items.find((pair) => isScalar(pair.key) && pair.key.value === 'text')
      if (!legacy || !isScalar(legacy.key) || legacy.key.anchor || !legacy.key.range || !isScalar(legacy.value) || typeof legacy.value.value !== 'string') continue
      const [start, end] = legacy.key.range
      const value = legacy.key.type === 'QUOTE_SINGLE' ? "'prefix'" : legacy.key.type === 'QUOTE_DOUBLE' ? '"prefix"' : 'prefix'
      edits.push({ start, end, value })
    }
  }
  visitRows(document.contents)
  if (edits.length === 0) return bytes
  let normalized = source
  for (const { start, end, value } of edits.sort((left, right) => right.start - left.start)) {
    normalized = normalized.slice(0, start) + value + normalized.slice(end)
  }
  return Buffer.from(normalized, 'utf8')
}

export interface PresetPersonaRepairResult {
  repaired: Array<{ id: string; path: string; backupPath: string }>
  failed: Array<{ id: string; path: string; error: string }>
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Repair each real local preset independently before Runtime startup. A unique
 * backup remains beside the composition, outside preset-directory discovery.
 * A same-directory rename atomically replaces the composition after backup.
 */
export async function repairLegacyPresetPersonas(dshHome: string): Promise<PresetPersonaRepairResult> {
  const result: PresetPersonaRepairResult = { repaired: [], failed: [] }
  const root = presetsDir(dshHome)
  let entries: string[]
  try {
    if (!(await lstat(root)).isDirectory()) return result
    entries = await readdir(root)
  } catch (error) {
    if (!isMissing(error)) result.failed.push({ id: '.agent-presets', path: root, error: String(error) })
    return result
  }
  for (const id of entries.sort()) {
    if (!PRESET_ID_PATTERN.test(id)) continue
    const directory = join(root, id)
    const path = join(directory, COMPOSITION_FILE)
    let temporaryPath: string | undefined
    let compositionFound = false
    try {
      const directoryStat = await lstat(directory)
      if (!directoryStat.isDirectory()) continue
      const originalStat = await lstat(path)
      if (!originalStat.isFile()) continue
      compositionFound = true
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let original: Buffer
      try {
        original = await file.readFile()
      } finally {
        await file.close()
      }
      const normalized = normalizeLegacyPresetPersona(original)
      if (normalized === original) continue
      const suffix = randomUUID()
      const backupPath = join(directory, `${COMPOSITION_FILE}.persona-text-${suffix}.bak`)
      temporaryPath = join(directory, `.${COMPOSITION_FILE}.persona-prefix-${suffix}.tmp`)
      await writeFile(backupPath, original, { flag: 'wx', mode: originalStat.mode & 0o777 })
      await writeFile(temporaryPath, normalized, { flag: 'wx', mode: originalStat.mode & 0o777 })
      const currentDirectoryStat = await lstat(directory)
      const currentStat = await lstat(path)
      if (!currentDirectoryStat.isDirectory() || currentDirectoryStat.ino !== directoryStat.ino || currentDirectoryStat.dev !== directoryStat.dev ||
        !currentStat.isFile() || currentStat.ino !== originalStat.ino || currentStat.dev !== originalStat.dev ||
        currentStat.size !== originalStat.size || currentStat.mtimeMs !== originalStat.mtimeMs) {
        throw new Error('Preset changed during persona repair; the current composition was not replaced')
      }
      await rename(temporaryPath, path)
      temporaryPath = undefined
      result.repaired.push({ id, path, backupPath })
    } catch (error) {
      if (compositionFound || !isMissing(error)) result.failed.push({ id, path, error: String(error) })
    } finally {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => {})
    }
  }
  return result
}
