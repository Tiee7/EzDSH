import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validateMethodId, validateMethodInput, validateMethodVersion, type EmployeeWorkMethod, type EmployeeWorkMethodCreate, type EmployeeWorkMethodUpdate } from '../../shared/employee-methods.js'

export interface WorkMethodServiceOptions {
  configPath: string
  ownerExists: (employeeId: string) => boolean
  workflowExists: (id: string, revision: number) => boolean | Promise<boolean>
}

/** Serialized writes publish in-memory state only after atomic disk replacement succeeds. */
export class WorkMethodService {
  private records: EmployeeWorkMethod[] = []
  private initialized?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: WorkMethodServiceOptions) {}

  initialize(): Promise<void> {
    return this.initialized ??= this.load().catch((error: unknown) => { this.initialized = undefined; throw error })
  }
  private async load(): Promise<void> {
    let raw: unknown
    try { raw = JSON.parse(await readFile(this.options.configPath, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!Array.isArray(raw)) throw new Error('Invalid methods store')
    const ids = new Set<string>()
    this.records = raw.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid method record')
      const value = item as EmployeeWorkMethod
      const allowed = ['schemaVersion', 'id', 'employeeId', 'name', 'description', 'workflowId', 'workflowRevision', 'version', 'createdAt', 'updatedAt']
      if (Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== 1) throw new Error('Invalid method record fields')
      validateMethodId(value.id); validateMethodId(value.employeeId); validateMethodVersion(value.version)
      if (ids.has(value.id)) throw new Error('Duplicate method ID')
      ids.add(value.id)
      if (![value.createdAt, value.updatedAt].every((date) => typeof date === 'string' && Number.isFinite(Date.parse(date)))) throw new Error('Invalid method timestamp')
      const input = validateMethodInput({ name: value.name, description: value.description, workflowId: value.workflowId, workflowRevision: value.workflowRevision }) as EmployeeWorkMethodCreate
      return { ...value, ...input }
    })
  }
  private owner(employeeId: string): void {
    validateMethodId(employeeId)
    if (!this.options.ownerExists(employeeId)) throw new Error('Method owner does not exist')
  }
  private find(employeeId: string, id: string): EmployeeWorkMethod | undefined {
    this.owner(employeeId); validateMethodId(id)
    const method = this.records.find((item) => item.id === id)
    if (method && method.employeeId !== employeeId) throw new Error('Method belongs to another employee')
    return method
  }
  async list(employeeId: string): Promise<EmployeeWorkMethod[]> {
    await this.initialize(); this.owner(employeeId)
    return this.records.filter((method) => method.employeeId === employeeId).map((method) => ({ ...method }))
  }
  async get(employeeId: string, id: string): Promise<EmployeeWorkMethod | undefined> {
    await this.initialize()
    const value = this.find(employeeId, id)
    return value ? { ...value } : undefined
  }
  async snapshot(employeeId: string, id: string): Promise<EmployeeWorkMethod> {
    const value = await this.get(employeeId, id)
    if (!value) throw new Error('Method not found')
    return value
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async persist(records: EmployeeWorkMethod[]): Promise<void> {
    await mkdir(dirname(this.options.configPath), { recursive: true, mode: 0o700 })
    const temp = `${this.options.configPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600 })
      await rename(temp, this.options.configPath)
      this.records = records
    } finally { await rm(temp, { force: true }) }
  }
  create(employeeId: string, input: EmployeeWorkMethodCreate): Promise<EmployeeWorkMethod> {
    const normalized = validateMethodInput(input) as EmployeeWorkMethodCreate
    return this.mutate(async () => {
      await this.initialize(); this.owner(employeeId)
      if (!await this.options.workflowExists(normalized.workflowId, normalized.workflowRevision)) throw new Error('Workflow revision does not exist')
      const now = new Date().toISOString()
      const value: EmployeeWorkMethod = { ...normalized, schemaVersion: 1, employeeId, id: randomUUID(), version: 1, createdAt: now, updatedAt: now }
      await this.persist([...this.records, value])
      return { ...value }
    })
  }
  update(employeeId: string, id: string, input: EmployeeWorkMethodUpdate): Promise<EmployeeWorkMethod> {
    const { expectedVersion, ...patch } = validateMethodInput(input, true) as EmployeeWorkMethodUpdate
    return this.mutate(async () => {
      await this.initialize()
      const old = this.find(employeeId, id)
      if (!old) throw new Error('Method not found')
      if (old.version !== expectedVersion) throw new Error('Method version conflict')
      const value = { ...old, ...patch, version: old.version + 1, updatedAt: new Date().toISOString() }
      validateMethodVersion(value.version)
      if (!await this.options.workflowExists(value.workflowId, value.workflowRevision)) throw new Error('Workflow revision does not exist')
      await this.persist(this.records.map((entry) => entry.id === id ? value : entry))
      return { ...value }
    })
  }
  remove(employeeId: string, id: string, expectedVersion: number): Promise<void> {
    validateMethodVersion(expectedVersion)
    return this.mutate(async () => {
      await this.initialize()
      const old = this.find(employeeId, id)
      if (!old) throw new Error('Method not found')
      if (old.version !== expectedVersion) throw new Error('Method version conflict')
      await this.persist(this.records.filter((entry) => entry.id !== id))
    })
  }
}
