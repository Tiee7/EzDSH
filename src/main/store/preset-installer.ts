/**
 * Preset installer: writes verified, audited preset directories under
 * `<dshHome>/.agent-presets/<id>/` where `dsh-agent-presets` rediscovers them
 * on every roster read — no runtime restart. A locally installed preset may
 * not claim deployment trust, so a `trust` key in the bundled `preset.yml` is
 * stripped on write.
 *
 * @module preset-installer
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { DownloadedBundle, DownloadedFile } from './downloader.js'
import { presetsDir } from './install-paths.js'
import type { StoreEntry } from '../../shared/store.js'

/** Preset id grammar enforced by dsh-agent-presets discovery. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Display-metadata file whose `trust` key never survives a local install. */
const METADATA_FILE = 'preset.yml'

/** Composition file that makes a directory a preset. */
const COMPOSITION_FILE = 'agent.cordis.yml'

/** Raised when the target preset already exists on disk. */
export class PresetConflictError extends Error {
  constructor(presetId: string) {
    super(`Preset "${presetId}" already exists on disk; uninstall it first`)
    this.name = 'PresetConflictError'
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Install one audited preset bundle.
 * @param dshHome - the DSH home directory.
 * @param presetEntry - the catalog entry (its id names the preset directory).
 * @param bundle - verified download containing `agent.cordis.yml` under `<id>/`.
 * @throws PresetConflictError when the target preset exists.
 * @throws when the composition is missing, a file escapes the preset directory, or a write fails (rolled back).
 */
export async function installPresetBundle(
  dshHome: string,
  presetEntry: StoreEntry,
  bundle: DownloadedBundle | readonly DownloadedFile[]
): Promise<void> {
  const presetId = presetEntry.id
  if (!PRESET_ID_PATTERN.test(presetId)) {
    throw new Error(`Preset id ${JSON.stringify(presetId)} does not match ${PRESET_ID_PATTERN.source}`)
  }
  const files = 'files' in bundle ? bundle.files : bundle
  const presetRoot = join(presetsDir(dshHome), presetId)
  const hasComposition = files.some((file) => file.path === join(presetId, COMPOSITION_FILE) || file.path === `${presetId}/${COMPOSITION_FILE}`)
  if (!hasComposition) {
    throw new Error(`Preset bundle must contain ${presetId}/${COMPOSITION_FILE}`)
  }

  const targets: Array<{ file: DownloadedFile; target: string; bytes: Buffer }> = []
  for (const file of files) {
    const insidePreset = relative(presetRoot, join(presetsDir(dshHome), file.path))
    if (insidePreset === '' || insidePreset === '..' || insidePreset.startsWith(`..${sep}`) || insidePreset.startsWith('../')) {
      throw new Error(`Bundle file ${file.path} is outside the preset directory ${presetId}`)
    }
    let bytes = file.bytes
    if (file.path === `${presetId}/${METADATA_FILE}`) {
      bytes = stripTrustKey(bytes)
    }
    targets.push({ file, target: join(presetsDir(dshHome), file.path), bytes })
  }

  if (await fileExists(presetRoot)) throw new PresetConflictError(presetId)

  try {
    for (const { target, bytes } of targets) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { mode: 0o600 })
    }
  } catch (error) {
    await rm(presetRoot, { recursive: true, force: true })
    throw error
  }
}

/**
 * Remove a locally installed preset directory.
 * @param dshHome - the DSH home directory.
 * @param presetId - the preset id (directory basename).
 * @returns whether the preset existed and was removed.
 */
export async function uninstallPreset(dshHome: string, presetId: string): Promise<boolean> {
  if (!PRESET_ID_PATTERN.test(presetId)) {
    throw new Error(`Preset id ${JSON.stringify(presetId)} does not match ${PRESET_ID_PATTERN.source}`)
  }
  const presetRoot = join(presetsDir(dshHome), presetId)
  if (!(await fileExists(presetRoot))) return false
  await rm(presetRoot, { recursive: true, force: true })
  return true
}

/**
 * Remove a top-level `trust` key from preset metadata bytes so a locally
 * installed preset cannot claim shipped trust levels.
 * @param bytes - the original `preset.yml` content.
 * @returns metadata bytes without a `trust` key; parse failures pass through
 *   unchanged and degrade in dsh-agent-presets' own metadata reader.
 */
function stripTrustKey(bytes: Buffer): Buffer {
  const text = bytes.toString('utf8')
  if (!/^trust:/m.test(text)) return bytes
  const lines = text.split('\n').filter((line) => !/^trust:/.test(line))
  return Buffer.from(lines.join('\n'), 'utf8')
}
