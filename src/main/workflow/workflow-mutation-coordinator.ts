import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeWorkflow, validateWorkflow } from '../../shared/workflow.js'
import { isPersistedRunRecord } from './workflow-run-store.js'
import type { WorkflowRunStore } from './workflow-run-store.js'
import type { WorkflowStore } from './workflow-store.js'

const FILES = ['workflow-versions.json', 'workflows.json', 'workflow-runs.json', 'workflow-tombstones.json'] as const
type StateFile = typeof FILES[number]
const JOURNAL = 'workflow-mutation-intent.json'
type Image = { file: StateFile; beforeDigest: string; afterDigest: string; after: string }
type Intent = { schemaVersion: 1; operationId: string; kind: 'save' | 'delete'; images: Image[] }
export type WorkflowTombstones = { schemaVersion: 1; workflowIds: string[]; runIds: string[]; protectedRunIds: string[] }
export type WorkflowSaveImages = { definitions: unknown; versions: unknown }
export type WorkflowDeleteImages = WorkflowSaveImages & { runs: unknown; tombstones: WorkflowTombstones }
const emptyTombstones = (): WorkflowTombstones => ({ schemaVersion: 1, workflowIds: [], runIds: [], protectedRunIds: [] })
const digest = (value: string | undefined): string => createHash('sha256').update(value === undefined ? 'absent' : `present:${value}`).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join(',') === keys.sort().join(',') }
function ids(value: unknown): value is string[] { return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.trim() !== '') && new Set(value).size === value.length }

function validateImage(file: StateFile, raw: string): void {
  const value: unknown = JSON.parse(raw)
  const workflow = (item: unknown): boolean => { const normalized = normalizeWorkflow(item); return normalized !== undefined && validateWorkflow(normalized).valid }
  let valid = false
  if (file === 'workflows.json') valid = Array.isArray(value) && value.every(workflow) && new Set(value.map((item) => item.id)).size === value.length
  if (file === 'workflow-versions.json') valid = object(value) && Object.entries(value).every(([id, revisions]) => object(revisions) && Object.entries(revisions).every(([revision, item]) => workflow(item) && object(item) && item.id === id && item.revision === Number(revision) && Number.isSafeInteger(Number(revision)) && Number(revision) > 0))
  if (file === 'workflow-runs.json') {
    const runs = Array.isArray(value) ? value : object(value) && value.schemaVersion === 1 && Array.isArray(value.runs) ? value.runs : undefined
    valid = runs !== undefined && runs.every(isPersistedRunRecord) && new Set(runs.map((run) => run.id)).size === runs.length
  }
  if (file === 'workflow-tombstones.json') valid = object(value) && exactKeys(value, ['schemaVersion', 'workflowIds', 'runIds', 'protectedRunIds']) && value.schemaVersion === 1 && ids(value.workflowIds) && ids(value.runIds) && ids(value.protectedRunIds) && !value.runIds.some((id) => (value.protectedRunIds as string[]).includes(id))
  if (!valid) throw new Error(`WORKFLOW_MUTATION_INVALID_IMAGE: ${file}`)
}

/** One Main process only. Atomic rename provides process-crash recovery, not a
 * power-loss durability guarantee. This journal supports exactly two mutations. */
export class WorkflowMutationCoordinator {
  // Main's current store owners. Public definition deletion reuses the run
  // owner rather than constructing a second independently cached writer.
  workflowStore: WorkflowStore | undefined
  runStore: WorkflowRunStore | undefined
  private tail: Promise<void> = Promise.resolve()
  private initialization: Promise<void> | undefined
  private blocked: unknown
  private tombstones = emptyTombstones()
  readonly stateDir: string
  constructor(stateDir: string) { this.stateDir = resolve(stateDir) }

  async initialize(): Promise<void> {
    this.initialization ??= this.recover()
    return this.initialization
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.initialize()
      this.assertAvailable()
      return operation()
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Public operational evidence contains no storage errors or journal payloads. */
  get recoveryRequired(): boolean { return this.blocked !== undefined }
  assertAvailable(): void { if (this.recoveryRequired) throw new Error('WORKFLOW_MUTATION_RECOVERY_REQUIRED', { cause: this.blocked }) }
  assertWorkflowWritable(id: string): void { this.assertAvailable(); if (this.tombstones.workflowIds.includes(id)) throw new Error(`WORKFLOW_TOMBSTONED: ${id}`) }
  assertRunWritable(id: string, workflowId: string, released = false): void { this.assertAvailable(); if (!released) this.assertWorkflowWritable(workflowId); if (this.tombstones.runIds.includes(id)) throw new Error(`WORKFLOW_RUN_TOMBSTONED: ${id}`) }
  isWorkflowDeleted(id: string): boolean { return this.tombstones.workflowIds.includes(id) }
  isRunProtected(id: string): boolean { return this.tombstones.protectedRunIds.includes(id) }
  snapshotTombstones(): WorkflowTombstones { return structuredClone(this.tombstones) }

  async save(images: WorkflowSaveImages): Promise<void> {
    await this.commit('save', [['workflow-versions.json', images.versions], ['workflows.json', images.definitions]])
  }

  async delete(images: WorkflowDeleteImages): Promise<void> {
    await this.commit('delete', [['workflow-tombstones.json', images.tombstones], ['workflows.json', images.definitions], ['workflow-versions.json', images.versions], ['workflow-runs.json', images.runs]])
    this.tombstones = structuredClone(images.tombstones)
  }

  private async read(file: StateFile | typeof JOURNAL): Promise<string | undefined> {
    const path = join(this.stateDir, file)
    try {
      if (!(await lstat(path)).isFile()) throw new Error(`WORKFLOW_MUTATION_UNSAFE_FILE: ${file}`)
      return await readFile(path, 'utf8')
    } catch (error) { if (missing(error)) return undefined; throw error }
  }

  private async write(file: StateFile | typeof JOURNAL, value: string): Promise<void> {
    await this.read(file) // Reject symlinks, directories and other non-regular targets.
    const path = join(this.stateDir, file)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, value, { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error }) }
  }

  private async commit(kind: Intent['kind'], values: Array<[StateFile, unknown]>): Promise<void> {
    this.assertAvailable()
    if (await this.read(JOURNAL) !== undefined) throw new Error('WORKFLOW_MUTATION_PENDING')
    const images: Image[] = []
    for (const [file, value] of values) {
      const after = json(value)
      validateImage(file, after)
      const before = await this.read(file)
      // The legacy loader may skip malformed run rows for display. Destructive
      // cleanup must not turn those unknown rows into silent data loss.
      if (kind === 'delete' && file === 'workflow-runs.json' && before !== undefined) validateImage(file, before)
      images.push({ file, beforeDigest: digest(before), afterDigest: digest(after), after })
    }
    const intent: Intent = { schemaVersion: 1, operationId: randomUUID(), kind, images }
    // From intent publication onward failures require roll-forward on restart.
    try {
      await this.write(JOURNAL, json(intent))
      await this.apply(intent)
    } catch (error) { this.blocked = error; throw error }
  }

  private parse(raw: string): Intent {
    const value: unknown = JSON.parse(raw)
    if (!object(value) || !exactKeys(value, ['schemaVersion', 'operationId', 'kind', 'images']) || value.schemaVersion !== 1 || typeof value.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.operationId) || !['save', 'delete'].includes(String(value.kind)) || !Array.isArray(value.images)) throw new Error('WORKFLOW_MUTATION_INVALID_INTENT')
    const expected = value.kind === 'save' ? ['workflow-versions.json', 'workflows.json'] : ['workflow-tombstones.json', 'workflows.json', 'workflow-versions.json', 'workflow-runs.json']
    if (value.images.length !== expected.length) throw new Error('WORKFLOW_MUTATION_INVALID_INTENT')
    for (const [index, image] of value.images.entries()) {
      if (!object(image) || !exactKeys(image, ['file', 'beforeDigest', 'afterDigest', 'after']) || image.file !== expected[index] || typeof image.after !== 'string' || typeof image.beforeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(image.beforeDigest) || image.afterDigest !== digest(image.after)) throw new Error('WORKFLOW_MUTATION_INVALID_INTENT')
      validateImage(image.file as StateFile, image.after)
    }
    return value as unknown as Intent
  }

  private async apply(intent: Intent, recovering = false): Promise<void> {
    // Validate every participant before touching any. Unknown content is never overwritten.
    for (const image of intent.images) {
      const actual = digest(await this.read(image.file))
      if (actual !== image.beforeDigest && actual !== image.afterDigest) throw new Error(`WORKFLOW_MUTATION_DIGEST_CONFLICT: ${image.file}`)
    }
    for (const image of intent.images) {
      const actual = digest(await this.read(image.file))
      if (recovering && actual === image.afterDigest) continue
      if (actual !== image.beforeDigest && actual !== image.afterDigest) throw new Error(`WORKFLOW_MUTATION_DIGEST_CONFLICT: ${image.file}`)
      await this.write(image.file, image.after)
    }
    await unlink(join(this.stateDir, JOURNAL))
  }

  private async recover(): Promise<void> {
    try {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      if (!(await lstat(this.stateDir)).isDirectory() || (await lstat(this.stateDir)).isSymbolicLink()) throw new Error('WORKFLOW_MUTATION_UNSAFE_DIRECTORY')
      await chmod(this.stateDir, 0o700)
      const raw = await this.read(JOURNAL)
      if (raw !== undefined) await this.apply(this.parse(raw), true)
      for (const file of FILES) await this.read(file)
      const tombstones = await this.read('workflow-tombstones.json')
      if (tombstones !== undefined) { validateImage('workflow-tombstones.json', tombstones); this.tombstones = JSON.parse(tombstones) as WorkflowTombstones }
    } catch (error) { this.blocked = error; throw error }
  }
}

const coordinators = new Map<string, WorkflowMutationCoordinator>()
export function workflowMutationCoordinator(stateDir: string): WorkflowMutationCoordinator {
  const key = resolve(stateDir)
  let coordinator = coordinators.get(key)
  if (coordinator === undefined) { coordinator = new WorkflowMutationCoordinator(key); coordinators.set(key, coordinator) }
  return coordinator
}
