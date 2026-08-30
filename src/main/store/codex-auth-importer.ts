import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Document, parseDocument } from 'yaml'

const CODEX_AUTH_FILENAME = join('.codex', 'auth.json')
const CODEX_OAUTH_REF = 'OPENAI_CODEX_OAUTH'

interface CodexAuthFile {
  auth_mode?: unknown
  tokens?: {
    access_token?: unknown
    refresh_token?: unknown
    account_id?: unknown
  }
}

interface CodexOAuthRecord {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function accessTokenExpiry(accessToken: string): number | undefined {
  const payload = accessToken.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) return undefined
    const expires = decoded.exp * 1000
    return expires > Date.now() ? expires : undefined
  } catch {
    return undefined
  }
}

function parseCodexOAuthRecord(value: unknown): CodexOAuthRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const auth = value as CodexAuthFile
  if (auth.auth_mode !== 'chatgpt' || auth.tokens === undefined) return undefined
  const access = auth.tokens.access_token
  const refresh = auth.tokens.refresh_token
  const accountId = auth.tokens.account_id
  if (!nonEmptyString(access) || !nonEmptyString(refresh) || !nonEmptyString(accountId)) return undefined
  const expires = accessTokenExpiry(access)
  if (expires === undefined) return undefined
  return { type: 'oauth', access, refresh, expires, accountId }
}

function existingRef(document: Document): unknown {
  return document.getIn(['refs', CODEX_OAUTH_REF])
}

async function loadDocument(credentialsPath: string): Promise<Document | undefined> {
  try {
    const text = await readFile(credentialsPath, 'utf8')
    const document = parseDocument(text)
    if (document.errors.length > 0) return undefined
    return document
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Document({})
    throw error
  }
}

/**
 * Reuse the official Codex CLI's ChatGPT OAuth session when EzDSH has no
 * dsh-codex credential of its own. The import is one-way and idempotent:
 * existing DSH credentials are never overwritten and only the OAuth record
 * needed by dsh-codex is copied into the DSH credential seam.
 */
export async function importCodexAuth(
  credentialsPath: string,
  authPath = join(homedir(), CODEX_AUTH_FILENAME),
  markerPath = join(dirname(credentialsPath), '.codex-auth-imported'),
): Promise<boolean> {
  if (await isImportMarked(markerPath)) return false

  let auth: unknown
  try {
    auth = JSON.parse(await readFile(authPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return false
  }
  const record = parseCodexOAuthRecord(auth)
  if (record === undefined) return false

  const document = await loadDocument(credentialsPath)
  if (document === undefined) return false
  if (existingRef(document) !== undefined) {
    await markImportComplete(markerPath)
    return false
  }
  document.setIn(['version'], 1)
  document.setIn(['refs', CODEX_OAUTH_REF], JSON.stringify(record))

  await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 })
  await writeFileAtomic(credentialsPath, document.toString(), { mode: 0o600, dirMode: 0o700 })
  await markImportComplete(markerPath)
  return true
}

async function isImportMarked(markerPath: string): Promise<boolean> {
  try {
    await readFile(markerPath, 'utf8')
    return true
  } catch (error) {
    // Fail closed when the marker cannot be inspected. A permission or I/O
    // error should not cause a credential to be copied unexpectedly.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

async function markImportComplete(markerPath: string): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 })
  await writeFileAtomic(markerPath, 'imported\n', { mode: 0o600, dirMode: 0o700 })
}
