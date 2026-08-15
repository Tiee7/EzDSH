import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UserDataLayout } from '../../shared/state.js'

export const CURRENT_STATE_VERSION = 1

interface StateManifest {
  version: number
}

/** Read the small EzDSH state manifest without treating a missing file as an error. */
export async function readStateVersion(layout: UserDataLayout): Promise<number> {
  try {
    const raw = await readFile(join(layout.state, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StateManifest>
    return typeof parsed.version === 'number' && Number.isInteger(parsed.version)
      ? parsed.version
      : 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/** Create the initial manifest. Future migrations can extend this function without changing paths. */
export async function writeCurrentStateVersion(layout: UserDataLayout): Promise<void> {
  await writeFile(
    join(layout.state, 'manifest.json'),
    `${JSON.stringify({ version: CURRENT_STATE_VERSION } satisfies StateManifest, null, 2)}\n`,
    { mode: 0o600 }
  )
}
