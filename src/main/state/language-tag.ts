import { readFile, writeFile } from 'node:fs/promises'

interface LanguageTagDocument {
  visible?: unknown
}

/** Read the persisted top-right language shortcut flag, defaulting to visible. */
export async function readLanguageTagVisible(filePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as LanguageTagDocument
    return parsed.visible !== false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/** Persist the top-right language shortcut flag as a small state file. */
export async function writeLanguageTagVisible(filePath: string, visible: boolean): Promise<void> {
  await writeFile(
    filePath,
    `${JSON.stringify({ visible }, null, 2)}\n`,
    { mode: 0o600 }
  )
}
