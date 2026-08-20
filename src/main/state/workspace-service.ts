import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface WorkspaceConfig {
  root: string
}

/** Keep the pointer outside the movable default userData directory. */
export function getWorkspaceConfigPath(appDataPath: string): string {
  return join(resolve(appDataPath), '.ezdsh-workspace.json')
}

function isInside(parent: string, candidate: string): boolean {
  const distance = relative(parent, candidate)
  return distance !== '' && !distance.startsWith(`..${sep}`) && distance !== '..' && !isAbsolute(distance)
}

export function isWorkspaceTargetInsideSource(sourceRoot: string, targetRoot: string): boolean {
  return isInside(resolve(sourceRoot), resolve(targetRoot))
}

function isCrossDeviceError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'EXDEV'
}

/** Read the persisted workspace root, falling back safely when it is absent or malformed. */
export async function readWorkspaceRoot(configPath: string, defaultRoot: string): Promise<string> {
  const fallback = resolve(defaultRoot)
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Partial<WorkspaceConfig>
    if (typeof parsed.root !== 'string' || !isAbsolute(parsed.root)) return fallback
    return resolve(parsed.root)
  } catch {
    return fallback
  }
}

/** Persist the workspace root outside the movable workspace itself. */
export async function writeWorkspaceRoot(configPath: string, root: string): Promise<void> {
  if (!isAbsolute(root)) throw new TypeError('Workspace root must be absolute')
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${configPath}.${String(process.pid)}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify({ root: resolve(root) } satisfies WorkspaceConfig, null, 2)}\n`, {
    mode: 0o600
  })
  await rename(temporaryPath, configPath)
}

/** Return false for missing or non-directory paths so a picker cannot treat them as an empty folder. */
export async function isDirectoryEmpty(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0
  } catch {
    return false
  }
}

async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
    return
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error
  }

  await cp(source, target, { recursive: true, force: false, errorOnExist: true })
  await rm(source, { recursive: true, force: false })
}

/** Move all workspace contents into an existing or newly-created empty directory. */
export async function moveWorkspaceContents(sourceRoot: string, targetRoot: string): Promise<void> {
  const source = resolve(sourceRoot)
  const target = resolve(targetRoot)
  if (source === target) throw new Error('Workspace target must be different from the current workspace')
  if (isWorkspaceTargetInsideSource(source, target)) throw new Error('Workspace target cannot be inside the current workspace')

  await mkdir(target, { recursive: true, mode: 0o700 })
  if (!(await isDirectoryEmpty(target))) throw new Error('Workspace target must be empty')

  const entries = await readdir(source)
  const moved: string[] = []
  try {
    for (const entry of entries) {
      await moveEntry(resolve(source, entry), resolve(target, entry))
      moved.push(entry)
    }
  } catch (error) {
    // Best-effort rollback keeps a failed migration recoverable when the filesystem allows it.
    for (const entry of moved.reverse()) {
      try {
        await moveEntry(resolve(target, entry), resolve(source, entry))
      } catch {
        // Preserve the original failure; the remaining files are still present in target.
      }
    }
    throw error
  }
}
