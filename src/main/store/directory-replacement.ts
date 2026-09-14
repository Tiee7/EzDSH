import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Replace one Store-managed directory while keeping the previous version
 * recoverable. The old directory is restored if writing or persistence fails.
 */
export async function replaceDirectoryWithRollback(input: {
  readonly dshHome: string
  readonly kind: 'skill' | 'preset'
  readonly id: string
  readonly target: string
  readonly prepareReplacement: (stagingHome: string) => Promise<string>
  readonly persist: () => Promise<void>
}): Promise<{ backupPath?: string }> {
  const transactionRoot = join(
    dirname(input.dshHome),
    'backups',
    'store-updates',
    `${input.kind}-${input.id}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  )
  const stagingHome = join(transactionRoot, 'staging')
  const backupPath = join(transactionRoot, 'previous')
  let replacement: string
  try {
    replacement = await input.prepareReplacement(stagingHome)
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const hadPrevious = await exists(input.target)
  if (hadPrevious) {
    try {
      await mkdir(transactionRoot, { recursive: true, mode: 0o700 })
      await rename(input.target, backupPath)
    } catch (error) {
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  let replacementMoved = false
  try {
    await mkdir(dirname(input.target), { recursive: true, mode: 0o700 })
    await rename(replacement, input.target)
    replacementMoved = true
    await input.persist()
    await rm(stagingHome, { recursive: true, force: true }).catch(() => undefined)
    if (!hadPrevious) await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
    return hadPrevious ? { backupPath } : {}
  } catch (error) {
    if (replacementMoved) await rm(input.target, { recursive: true, force: true })
    if (hadPrevious) {
      try {
        await rename(backupPath, input.target)
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `Store update failed and ${input.kind} ${input.id} could not be restored`)
      }
    }
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
