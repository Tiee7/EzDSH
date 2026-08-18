import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { DownloadedBundle, DownloadedFile } from './downloader.js'
import { channelAdaptersDir } from './install-paths.js'
import type { StoreEntry } from '../../shared/store.js'
import { SKILL_ID_PATTERN } from './skill-installer.js'

/** Raised when the on-disk target already holds a channel adapter this install did not own. */
export class ChannelAdapterConflictError extends Error {
  constructor(adapterId: string) {
    super(`Channel adapter "${adapterId}" already exists on disk; uninstall it first`)
    this.name = 'ChannelAdapterConflictError'
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
 * Install one channel adapter bundle.
 * @param dshHome - the DSH home directory.
 * @param entry - the catalog entry (its id names the adapter directory).
 * @param bundle - verified download whose file paths live under `<id>/`.
 * @throws ChannelAdapterConflictError when the target adapter already exists.
 * @throws when a file lands outside the adapter directory or a write fails (rolled back).
 */
export async function installChannelAdapterBundle(
  dshHome: string,
  entry: StoreEntry,
  bundle: DownloadedBundle | readonly DownloadedFile[],
): Promise<void> {
  const adapterId = entry.id
  if (!SKILL_ID_PATTERN.test(adapterId)) {
    throw new Error(`Channel adapter id ${JSON.stringify(adapterId)} is not kebab-case`)
  }
  const files = 'files' in bundle ? bundle.files : bundle
  if (files.length === 0) throw new Error('Channel adapter bundle is empty')

  const adapterRoot = join(channelAdaptersDir(dshHome), adapterId)
  const targets: Array<{ file: DownloadedFile; target: string }> = []
  for (const file of files) {
    const insideAdapter = relative(adapterRoot, join(channelAdaptersDir(dshHome), file.path))
    if (insideAdapter === '' || insideAdapter === '..' || insideAdapter.startsWith(`..${sep}`) || insideAdapter.startsWith('../')) {
      throw new Error(`Bundle file ${file.path} is outside the channel adapter directory ${adapterId}`)
    }
    targets.push({ file, target: join(channelAdaptersDir(dshHome), file.path) })
  }

  if (await fileExists(adapterRoot)) throw new ChannelAdapterConflictError(adapterId)

  try {
    for (const { file, target } of targets) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, file.bytes, { mode: 0o600 })
    }
  } catch (error) {
    await rm(adapterRoot, { recursive: true, force: true })
    throw error
  }
}

/**
 * Remove an installed channel adapter.
 * @param dshHome - the DSH home directory.
 * @param adapterId - the adapter id.
 * @returns whether anything was removed.
 */
export async function uninstallChannelAdapter(dshHome: string, adapterId: string): Promise<boolean> {
  if (!SKILL_ID_PATTERN.test(adapterId)) {
    throw new Error(`Channel adapter id ${JSON.stringify(adapterId)} is not kebab-case`)
  }
  let removed = false
  const directory = join(channelAdaptersDir(dshHome), adapterId)
  if (await fileExists(directory)) {
    await rm(directory, { recursive: true, force: true })
    removed = true
  }
  return removed
}
