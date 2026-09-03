import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { normalizeWorkflowCustomerEnvironment, type WorkflowCustomerEnvironment } from '../../shared/workflow-operations.js'

const FILE_NAME = 'workflow-customer-environments.json'

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function cloneEnvironment(environment: WorkflowCustomerEnvironment): WorkflowCustomerEnvironment {
  return {
    id: environment.id,
    customerName: environment.customerName,
    name: environment.name,
    kind: environment.kind,
    status: environment.status,
    connectorIds: [...environment.connectorIds],
    allowShellFile: environment.allowShellFile,
    allowCode: environment.allowCode,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(filePath))
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

export class WorkflowEnvironmentStore {
  private readonly filePath: string
  private readonly environments = new Map<string, WorkflowCustomerEnvironment>()
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  private mutationChain: Promise<void> = Promise.resolve()

  constructor(stateDir: string) {
    this.filePath = join(stateDir, FILE_NAME)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise !== undefined) return this.initializationPromise
    const pending = (async () => {
      await ensurePrivateDirectory(dirname(this.filePath))
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        const entries = Array.isArray(parsed)
          ? parsed
          : isRecord(parsed) && Array.isArray(parsed.environments)
            ? parsed.environments
            : []
        this.environments.clear()
        for (const value of entries) {
          const environment = normalizeWorkflowCustomerEnvironment(value)
          if (environment !== undefined) this.environments.set(environment.id, cloneEnvironment(environment))
        }
      } catch (error) {
        if (!isNotFound(error)) throw error
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

  list(): WorkflowCustomerEnvironment[] {
    return Array.from(this.environments.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneEnvironment)
  }

  get(id: string): WorkflowCustomerEnvironment | undefined {
    const environment = this.environments.get(id)
    return environment === undefined ? undefined : cloneEnvironment(environment)
  }

  async upsert(input: WorkflowCustomerEnvironment): Promise<WorkflowCustomerEnvironment> {
    await this.initialize()
    const normalized = normalizeWorkflowCustomerEnvironment(input)
    if (normalized === undefined) throw new Error('Invalid workflow customer environment')
    return this.mutate(async () => {
      this.environments.set(normalized.id, cloneEnvironment(normalized))
      await this.persist()
      return cloneEnvironment(normalized)
    })
  }

  async remove(id: string): Promise<boolean> {
    await this.initialize()
    return this.mutate(async () => {
      const removed = this.environments.delete(id)
      if (removed) await this.persist()
      return removed
    })
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, {
      version: 1,
      environments: this.list().map((environment) => cloneEnvironment(environment)),
    })
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation)
    this.mutationChain = result.then(() => undefined, () => undefined)
    return result
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}
