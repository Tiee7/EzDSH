import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  WorkflowCredentialMetadata,
  WorkflowCredentialScope,
  WorkflowCredentialType,
  WorkflowHttpMethod,
} from '../../shared/workflow.js'

export interface WorkflowCredentialInput {
  id: string
  label: string
  type: WorkflowCredentialType
  scopes: WorkflowCredentialScope[]
  /** Plaintext exists only for this call and is encrypted before persistence. */
  secret?: string
}

export interface WorkflowCredentialProtector {
  readonly available?: boolean
  encrypt(secret: string): Promise<string> | string
  decrypt(ciphertext: string): Promise<string> | string
}

export interface WorkflowSafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface WorkflowCredentialStoreOptions {
  fileName?: string
  protector?: WorkflowCredentialProtector
}

/** Adapter for Electron safeStorage; production composition should inject it. */
export function createSafeStorageProtector(storage: WorkflowSafeStorageLike): WorkflowCredentialProtector {
  return {
    get available() { return storage.isEncryptionAvailable() },
    encrypt: (secret) => storage.encryptString(secret).toString('base64url'),
    decrypt: (ciphertext) => storage.decryptString(Buffer.from(ciphertext, 'base64url')),
  }
}

interface PersistedCredential {
  id: string
  label: string
  type: WorkflowCredentialType
  scopes: WorkflowCredentialScope[]
  encryptedSecret?: string
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const HEADER_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const METHODS = new Set<WorkflowHttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Main-process-only credential vault. The persisted document contains only
 * encrypted secret blobs and non-sensitive metadata; metadata APIs never
 * return a secret or an authentication header.
 */
export class WorkflowCredentialStore {
  private readonly filePath: string
  private readonly keyPath: string
  private readonly credentials = new Map<string, PersistedCredential>()
  private readonly protector: WorkflowCredentialProtector
  private mutationChain: Promise<void> = Promise.resolve()
  private initialized = false
  private initializationPromise: Promise<void> | undefined

  constructor(stateDir: string, options: WorkflowCredentialStoreOptions = {}) {
    this.filePath = join(stateDir, options.fileName ?? '.workflow-credentials.json')
    this.keyPath = `${this.filePath}.key`
    this.protector = options.protector ?? new LocalAeadProtector(this.keyPath)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      try {
        const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        const entries = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.credentials) ? raw.credentials : []
        for (const value of entries) {
          const parsed = parsePersistedCredential(value)
          if (parsed !== undefined) this.credentials.set(parsed.id, parsed)
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      this.initialized = true
    })()
    this.initializationPromise = pending
    try {
      await pending
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined
    }
  }

  listMetadata(): WorkflowCredentialMetadata[] {
    return [...this.credentials.values()].map((credential) => metadataOf(credential))
  }

  /** Compatibility alias; it is metadata-only by design. */
  list(): WorkflowCredentialMetadata[] {
    return this.listMetadata()
  }

  getMetadata(id: string): WorkflowCredentialMetadata | undefined {
    const credential = this.credentials.get(id)
    return credential === undefined ? undefined : metadataOf(credential)
  }

  /** Compatibility alias; callers must use resolveSecret() for dispatch. */
  get(id: string): WorkflowCredentialMetadata | undefined {
    return this.getMetadata(id)
  }

  async resolveSecret(id: string): Promise<string | undefined> {
    await this.initialize()
    const credential = this.credentials.get(id)
    if (credential?.encryptedSecret === undefined) return undefined
    if (this.protector.available === false) throw new Error('凭证加密服务不可用。')
    return this.protector.decrypt(credential.encryptedSecret)
  }

  /** Resolve a secret for a main-process connector without exposing it via metadata. */
  async resolve(id: string): Promise<{ metadata: WorkflowCredentialMetadata; secret: string } | undefined> {
    await this.initialize()
    const metadata = this.getMetadata(id)
    if (metadata === undefined) return undefined
    const secret = await this.resolveSecret(id)
    return secret === undefined ? undefined : { metadata, secret }
  }

  async upsert(input: WorkflowCredentialInput): Promise<WorkflowCredentialMetadata> {
    await this.initialize()
    validateCredentialInput(input)
    const normalizedScopes = input.scopes.flatMap(parseScope)
    return this.mutate(async () => {
      const id = input.id.trim()
      const previous = this.credentials.get(id)
      let encryptedSecret = previous?.encryptedSecret
      if (input.secret !== undefined) {
        if (this.protector.available === false) throw new Error('凭证加密服务不可用，拒绝保存明文凭证。')
        if (input.secret.trim() === '') throw new Error('凭证内容不能为空。')
        if (/[\u0000-\u001f\u007f\u0080-\u009f]/u.test(input.secret)) throw new Error('凭证内容包含无效控制字符。')
        encryptedSecret = await this.protector.encrypt(input.secret)
      }
      const next: PersistedCredential = {
        id,
        label: input.label.trim(),
        type: input.type,
        scopes: normalizedScopes.map(cloneScope),
        ...(encryptedSecret === undefined ? {} : { encryptedSecret }),
      }
      this.credentials.set(next.id, next)
      await this.persist()
      return metadataOf(next)
    })
  }

  /** Compatibility alias for the old service name. */
  async set(input: WorkflowCredentialInput): Promise<WorkflowCredentialMetadata> {
    return this.upsert(input)
  }

  async remove(id: string): Promise<boolean> {
    await this.initialize()
    return this.mutate(async () => {
      const removed = this.credentials.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  /** Compatibility alias for the old service name. */
  async delete(id: string): Promise<boolean> {
    return this.remove(id)
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, `${JSON.stringify({ version: 1, credentials: [...this.credentials.values()] }, null, 2)}\n`, { mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, this.filePath)
    await chmod(this.filePath, 0o600)
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation)
    this.mutationChain = result.then(() => undefined, () => undefined)
    return result
  }
}

/** AES-256-GCM protector used when Electron safeStorage is not injected. */
class LocalAeadProtector implements WorkflowCredentialProtector {
  readonly available = true
  private keyPromise: Promise<Buffer> | undefined

  constructor(private readonly keyPath: string) {}

  async encrypt(secret: string): Promise<string> {
    const key = await this.key()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`
  }

  async decrypt(ciphertext: string): Promise<string> {
    const [version, ivText, tagText, dataText] = ciphertext.split('.')
    if (version !== 'v1' || ivText === undefined || tagText === undefined || dataText === undefined) throw new Error('凭证密文格式无效。')
    const decipher = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(ivText, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8')
  }

  private async key(): Promise<Buffer> {
    if (this.keyPromise !== undefined) return this.keyPromise
    this.keyPromise = (async () => {
      try {
        const existing = await readFile(this.keyPath)
        if (existing.length === 32) return existing
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const key = randomBytes(32)
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 })
      await writeFile(this.keyPath, key, { mode: 0o600 })
      await chmod(this.keyPath, 0o600)
      return key
    })()
    return this.keyPromise
  }
}

function parsePersistedCredential(value: unknown): PersistedCredential | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || (value.type !== 'bearer-token' && value.type !== 'api-key') || !Array.isArray(value.scopes)) return undefined
  if (!ID_PATTERN.test(value.id) || value.label.trim() === '') return undefined
  const scopes = value.scopes.flatMap((scope) => parseScope(scope))
  if (scopes.length === 0 || scopes.length !== value.scopes.length) return undefined
  if (value.encryptedSecret !== undefined && typeof value.encryptedSecret !== 'string') return undefined
  return { id: value.id, label: value.label, type: value.type, scopes, ...(typeof value.encryptedSecret === 'string' ? { encryptedSecret: value.encryptedSecret } : {}) }
}

function parseScope(value: unknown): WorkflowCredentialScope[] {
  if (!isRecord(value) || typeof value.origin !== 'string' || !Array.isArray(value.methods) || typeof value.headerName !== 'string') return []
  const methods = value.methods.filter((method): method is WorkflowHttpMethod => typeof method === 'string' && METHODS.has(method as WorkflowHttpMethod))
  if (methods.length === 0 || methods.length !== value.methods.length || !HEADER_PATTERN.test(value.headerName)) return []
  let origin: URL
  try { origin = new URL(value.origin) } catch { return [] }
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') return []
  const pathPrefixes = value.pathPrefixes === undefined ? undefined : Array.isArray(value.pathPrefixes) && value.pathPrefixes.every((path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !path.includes('://') && !path.includes('?') && !path.includes('#') && !path.split('/').includes('..') && !decodePathSafe(path).split('/').includes('..')) ? value.pathPrefixes : undefined
  if (value.pathPrefixes !== undefined && pathPrefixes === undefined) return []
  const prefix = value.prefix === undefined ? undefined : typeof value.prefix === 'string' && value.prefix !== '' && value.prefix.length <= 64 && !/[\u0000-\u001f\u007f\u0080-\u009f]/u.test(value.prefix) ? value.prefix : undefined
  if (value.prefix !== undefined && prefix === undefined) return []
  return [{ origin: origin.origin, methods: [...new Set(methods)], headerName: value.headerName, ...(prefix === undefined ? {} : { prefix }), ...(pathPrefixes === undefined ? {} : { pathPrefixes: [...pathPrefixes] }) }]
}

function decodePathSafe(value: string): string {
  try { return decodeURIComponent(value) } catch { return '\u0000' }
}

function validateCredentialInput(input: WorkflowCredentialInput): void {
  if (!ID_PATTERN.test(input.id.trim())) throw new Error('凭证 ID 格式无效。')
  if (input.label.trim() === '') throw new Error('凭证名称不能为空。')
  if (input.type !== 'bearer-token' && input.type !== 'api-key') throw new Error('凭证类型无效。')
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) throw new Error('凭证至少需要一个访问范围。')
  if (input.secret !== undefined && /[\u0000-\u001f\u007f\u0080-\u009f]/u.test(input.secret)) throw new Error('凭证内容包含无效控制字符。')
  for (const scope of input.scopes) {
    if (parseScope(scope).length !== 1) throw new Error('凭证访问范围无效。')
  }
}

function metadataOf(value: PersistedCredential): WorkflowCredentialMetadata {
  return { id: value.id, label: value.label, type: value.type, configured: value.encryptedSecret !== undefined, scopes: value.scopes.map(cloneScope) }
}

function cloneScope(scope: WorkflowCredentialScope): WorkflowCredentialScope {
  return { origin: scope.origin, methods: [...scope.methods], headerName: scope.headerName, ...(scope.prefix === undefined ? {} : { prefix: scope.prefix }), ...(scope.pathPrefixes === undefined ? {} : { pathPrefixes: [...scope.pathPrefixes] }) }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
