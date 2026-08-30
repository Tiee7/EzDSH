import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

interface WorkspaceStorageDocument {
  unit?: unknown
  global?: unknown
  tables?: unknown
  [key: string]: unknown
}

interface WorkspaceGlobalState {
  archivedSessionIds?: unknown
  [key: string]: unknown
}

interface JsonObject {
  [key: string]: unknown
}

/**
 * Remove one archived session from the JSON workspace store.
 *
 * Older published DSH Runtimes expose archiveSession but do not expose the
 * matching unarchiveSession RPC. The desktop app uses this small compatibility
 * path only after stopping that Runtime, so its in-memory store cannot race the
 * durable file update; the caller must start the Runtime again afterwards.
 */
export async function removeArchivedSessionFromStore(
  dshHome: string,
  sessionId: string,
): Promise<boolean> {
  const path = join(dshHome, 'storages', 'workspace.json')
  const document = JSON.parse(await readFile(path, 'utf8')) as WorkspaceStorageDocument
  if (!isRecord(document.global)) return false

  const archivedSessionIds = document.global.archivedSessionIds
  if (!Array.isArray(archivedSessionIds) || !archivedSessionIds.includes(sessionId)) return false

  const nextGlobal: WorkspaceGlobalState = {
    ...document.global,
    archivedSessionIds: archivedSessionIds.filter((id): id is string => typeof id === 'string' && id !== sessionId),
  }
  await writeJsonAtomically(path, { ...document, global: nextGlobal })
  return true
}

/**
 * Permanently remove one archived session from the legacy DSH stores.
 *
 * This deliberately accepts only ids that are still in the archive index. The
 * caller stops the Runtime first, so the on-disk edits cannot be overwritten
 * by its in-memory workspace or projection stores.
 */
export async function deleteArchivedSessionFromStore(
  dshHome: string,
  sessionId: string,
): Promise<boolean> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  const workspacePath = join(dshHome, 'storages', 'workspace.json')
  const document = JSON.parse(await readFile(workspacePath, 'utf8')) as WorkspaceStorageDocument
  if (!isRecord(document.global)) return false

  const archivedSessionIds = document.global.archivedSessionIds
  if (!Array.isArray(archivedSessionIds) || !archivedSessionIds.includes(sessionId)) return false

  const nextGlobal: WorkspaceGlobalState = {
    ...document.global,
    archivedSessionIds: archivedSessionIds.filter((id) => id !== sessionId),
  }
  const nextDocument = removeSessionFromWorkspaceRecords({ ...document, global: nextGlobal }, sessionId)
  await writeJsonAtomically(workspacePath, nextDocument)
  await removeSessionFromProjectionCache(dshHome, sessionId)
  await removeSessionArtifacts(dshHome, sessionId)
  return true
}

function removeSessionFromWorkspaceRecords(
  document: WorkspaceStorageDocument,
  sessionId: string,
): WorkspaceStorageDocument {
  if (!isRecord(document.tables) || !isRecord(document.tables.workspaces)) return document

  const workspaces = Object.fromEntries(
    Object.entries(document.tables.workspaces).map(([workspaceId, value]) => {
      if (!isRecord(value) || !Array.isArray(value.sessionIds)) return [workspaceId, value]
      return [workspaceId, {
        ...value,
        sessionIds: value.sessionIds.filter((id) => id !== sessionId),
      }]
    }),
  )
  return {
    ...document,
    tables: {
      ...document.tables,
      workspaces,
    },
  }
}

async function removeSessionFromProjectionCache(dshHome: string, sessionId: string): Promise<void> {
  const path = join(dshHome, 'storages', 'session_projcache.json')
  let document: JsonObject
  try {
    document = JSON.parse(await readFile(path, 'utf8')) as JsonObject
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }

  if (!isRecord(document.tables) || !isRecord(document.tables.sessions)) return
  if (!Object.hasOwn(document.tables.sessions, sessionId)) return

  const sessions = { ...document.tables.sessions }
  delete sessions[sessionId]
  await writeJsonAtomically(path, {
    ...document,
    tables: {
      ...document.tables,
      sessions,
    },
  })
}

async function removeSessionArtifacts(dshHome: string, sessionId: string): Promise<void> {
  const sessionsRoot = join(dshHome, 'sessions')
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }

  const encodedId = encodeSessionSegment(sessionId)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsRoot, project.name)
    const sessionPath = join(projectPath, encodedId)
    try {
      const info = await lstat(sessionPath)
      if (info.isDirectory()) await rm(sessionPath, { recursive: true, force: false })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }

    // Support the flat legacy layout used by older JSONL persistence builds.
    for (const suffix of ['.jsonl', '.jsonl.zstd']) {
      const logPath = join(projectPath, `${encodedId}${suffix}`)
      try {
        const info = await lstat(logPath)
        if (info.isFile()) await rm(logPath, { force: false })
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
  }
}

function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty session id')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      encoded += character
    } else {
      encoded += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return encoded
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
