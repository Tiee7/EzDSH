/**
 * Skill bundle installer: writes verified, audited files under
 * `<dshHome>/skills/` where `dsh-skill-filesystem` discovers them without a
 * runtime restart. Installs are transactional — any write failure removes the
 * partially written bundle — and refuse to touch a skill that already exists
 * on disk. Bundles always install in the directory form (`<id>/SKILL.md`).
 *
 * @module skill-installer
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { DownloadedBundle, DownloadedFile } from './downloader.js'
import { skillsDir } from './install-paths.js'
import type { StoreEntry } from '../../shared/store.js'

/** Public skill-name grammar enforced by dsh-skill. */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Raised when the on-disk target already holds a skill this install did not own. */
export class SkillConflictError extends Error {
  constructor(skillId: string) {
    super(`Skill "${skillId}" already exists on disk; uninstall it first`)
    this.name = 'SkillConflictError'
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
 * Install one audited skill bundle.
 * @param dshHome - the DSH home directory.
 * @param skillEntry - the catalog entry (its id names the skill directory).
 * @param bundle - verified download whose file paths live under `<id>/`.
 * @throws SkillConflictError when the target skill already exists.
 * @throws when a file lands outside the skill directory or a write fails (rolled back).
 */
export async function installSkillBundle(
  dshHome: string,
  skillEntry: StoreEntry,
  bundle: DownloadedBundle | readonly DownloadedFile[]
): Promise<void> {
  const skillId = skillEntry.id
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error(`Skill id ${JSON.stringify(skillId)} is not kebab-case`)
  }
  const files = 'files' in bundle ? bundle.files : bundle
  if (files.length === 0) throw new Error('Skill bundle is empty')

  const skillRoot = join(skillsDir(dshHome), skillId)
  const targets: Array<{ file: DownloadedFile; target: string }> = []
  for (const file of files) {
    const insideSkill = relative(skillRoot, join(skillsDir(dshHome), file.path))
    if (insideSkill === '' || insideSkill === '..' || insideSkill.startsWith(`..${sep}`) || insideSkill.startsWith('../')) {
      throw new Error(`Bundle file ${file.path} is outside the skill directory ${skillId}`)
    }
    targets.push({ file, target: join(skillsDir(dshHome), file.path) })
  }

  if (await fileExists(skillRoot)) throw new SkillConflictError(skillId)

  try {
    for (const { file, target } of targets) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, file.bytes, { mode: 0o600 })
    }
  } catch (error) {
    await rm(skillRoot, { recursive: true, force: true })
    throw error
  }
}

/**
 * Remove an installed skill (directory bundle or flat markdown file).
 * @param dshHome - the DSH home directory.
 * @param skillId - the skill name.
 * @returns whether anything was removed.
 */
export async function uninstallSkill(dshHome: string, skillId: string): Promise<boolean> {
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error(`Skill id ${JSON.stringify(skillId)} is not kebab-case`)
  }
  let removed = false
  const directory = join(skillsDir(dshHome), skillId)
  if (await fileExists(directory)) {
    await rm(directory, { recursive: true, force: true })
    removed = true
  }
  const flat = join(skillsDir(dshHome), `${skillId}.md`)
  if (await fileExists(flat)) {
    await rm(flat, { force: true })
    removed = true
  }
  return removed
}
