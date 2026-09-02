import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { WorkflowHttpConnector } from '../../shared/workflow.js'

export interface WorkflowConnectorStoreOptions {
  fileName?: string
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/**
 * Main-process-only connector registry. A connector is a non-secret endpoint
 * declaration; credentials are kept in WorkflowCredentialStore and are never
 * copied into this file.
 */
export class WorkflowConnectorStore {
  private readonly filePath: string
  private readonly connectors = new Map<string, WorkflowHttpConnector>()
  private mutationChain: Promise<void> = Promise.resolve()
  private initialized = false
  private initializationPromise: Promise<void> | undefined

  constructor(stateDir: string, options: WorkflowConnectorStoreOptions = {}) {
    this.filePath = join(stateDir, options.fileName ?? 'workflow-connectors.json')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      try {
        const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        const entries = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.connectors) ? raw.connectors : []
        for (const value of entries) {
          const connector = parseConnector(value)
          if (connector !== undefined) this.connectors.set(connector.id, connector)
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

  list(): WorkflowHttpConnector[] {
    return [...this.connectors.values()].map(cloneConnector)
  }

  get(id: string): WorkflowHttpConnector | undefined {
    const connector = this.connectors.get(id)
    return connector === undefined ? undefined : cloneConnector(connector)
  }

  async upsert(input: WorkflowHttpConnector): Promise<WorkflowHttpConnector> {
    await this.initialize()
    const next = normalizeConnector(input)
    validateConnector(next)
    return this.mutate(async () => {
      this.connectors.set(next.id, next)
      await this.persist()
      return cloneConnector(next)
    })
  }

  /** Compatibility alias for main-process callers. */
  async set(input: WorkflowHttpConnector): Promise<WorkflowHttpConnector> {
    return this.upsert(input)
  }

  async remove(id: string): Promise<boolean> {
    await this.initialize()
    return this.mutate(async () => {
      const removed = this.connectors.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, `${JSON.stringify({ version: 1, connectors: [...this.connectors.values()] }, null, 2)}\n`, { mode: 0o600 })
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

export function cloneConnector(connector: WorkflowHttpConnector): WorkflowHttpConnector {
  return {
    id: connector.id,
    name: connector.name,
    kind: 'http',
    baseUrl: connector.baseUrl,
    ...(connector.credentialRef === undefined ? {} : { credentialRef: { id: connector.credentialRef.id } }),
    allowedPathPrefixes: [...connector.allowedPathPrefixes],
  }
}

export function validateConnector(input: WorkflowHttpConnector): void {
  if (!ID_PATTERN.test(input.id.trim())) throw new Error('连接器 ID 格式无效。')
  if (input.name.trim() === '') throw new Error('连接器名称不能为空。')
  let base: URL
  try { base = new URL(input.baseUrl) } catch { throw new Error('连接器 Base URL 无效。') }
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') throw new Error('连接器只允许不含凭据的 HTTPS Base URL。')
  if (base.pathname !== '/' && !base.pathname.endsWith('/')) throw new Error('连接器 Base URL 路径必须以 / 结尾。')
  if (!Array.isArray(input.allowedPathPrefixes) || input.allowedPathPrefixes.length === 0) throw new Error('连接器至少需要一个允许路径前缀。')
  for (const prefix of input.allowedPathPrefixes) validatePathPrefix(prefix)
  if (input.credentialRef !== undefined && !ID_PATTERN.test(input.credentialRef.id.trim())) throw new Error('连接器凭证引用无效。')
}

/** Normalize user/IPC input before it becomes the canonical registry key. */
function normalizeConnector(input: WorkflowHttpConnector): WorkflowHttpConnector {
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    kind: 'http',
    baseUrl: input.baseUrl.trim(),
    ...(input.credentialRef === undefined || input.credentialRef.id.trim() === '' ? {} : { credentialRef: { id: input.credentialRef.id.trim() } }),
    allowedPathPrefixes: Array.isArray(input.allowedPathPrefixes)
      ? [...new Set(input.allowedPathPrefixes.map((prefix) => prefix.trim()).filter(Boolean))]
      : [],
  }
}

function parseConnector(value: unknown): WorkflowHttpConnector | undefined {
  if (!isRecord(value) || value.kind !== 'http' || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.baseUrl !== 'string' || !Array.isArray(value.allowedPathPrefixes)) return undefined
  const credentialRef = isRecord(value.credentialRef) && typeof value.credentialRef.id === 'string' ? { id: value.credentialRef.id } : undefined
  const connector = normalizeConnector({
    id: value.id,
    name: value.name,
    kind: 'http' as const,
    baseUrl: value.baseUrl,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    allowedPathPrefixes: value.allowedPathPrefixes.filter((prefix): prefix is string => typeof prefix === 'string'),
  })
  try {
    validateConnector(connector)
    return cloneConnector(connector)
  } catch {
    return undefined
  }
}

function validatePathPrefix(value: string): void {
  if (value === '' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('://') || value.split('/').includes('..') || value.includes('?') || value.includes('#')) throw new Error('连接器允许路径前缀必须是安全的同源路径。')
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw new Error('连接器允许路径前缀编码无效。') }
  if (decoded.split('/').includes('..')) throw new Error('连接器允许路径前缀不能包含路径穿越。')
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
