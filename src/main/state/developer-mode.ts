import { readFile, writeFile } from 'node:fs/promises'

interface DeveloperModeDocument {
  enabled?: unknown
}

/** Read the persisted developer-mode flag, defaulting to disabled on first launch. */
export async function readDeveloperMode(filePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as DeveloperModeDocument
    return parsed.enabled === true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Persist the developer-mode flag as a small, permission-restricted state file. */
export async function writeDeveloperMode(filePath: string, enabled: boolean): Promise<void> {
  await writeFile(
    filePath,
    `${JSON.stringify({ enabled }, null, 2)}\n`,
    { mode: 0o600 }
  )
}
