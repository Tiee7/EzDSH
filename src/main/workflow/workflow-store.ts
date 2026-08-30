import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { WORKFLOW_SCHEMA_VERSION, cloneWorkflow, createDefaultWorkflow, normalizeWorkflow, validateWorkflow, type WorkflowCreateInput, type WorkflowDefinition, type WorkflowUpdateInput } from '../../shared/workflow.js'

const FILE_NAME = 'workflows.json'

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function cloneList(items: Iterable<WorkflowDefinition>): WorkflowDefinition[] {
  return Array.from(items, (item) => cloneWorkflow(item))
}

export class WorkflowStore {
  private readonly filePath: string
  private readonly workflows = new Map<string, WorkflowDefinition>()
  private initialized = false

  constructor(stateDir: string) {
    this.filePath = join(stateDir, FILE_NAME)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const workflow = normalizeWorkflow(item)
          if (workflow !== undefined && validateWorkflow(workflow).valid) this.workflows.set(workflow.id, workflow)
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    this.initialized = true
  }

  list(): WorkflowDefinition[] {
    return cloneList(this.workflows.values()).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).reverse()
  }

  get(id: string): WorkflowDefinition | undefined {
    const workflow = this.workflows.get(id)
    return workflow === undefined ? undefined : cloneWorkflow(workflow)
  }

  async create(input: WorkflowCreateInput): Promise<WorkflowDefinition> {
    await this.initialize()
    const timestamp = new Date().toISOString()
    const workflow = normalizeWorkflow({
      ...createDefaultWorkflow(input.name),
      ...input,
      id: input.id ?? `workflow-${randomUUID()}`,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      revision: 1,
      enabled: input.enabled !== false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    if (workflow === undefined) throw new Error('Invalid workflow document')
    const result = validateWorkflow(workflow)
    if (!result.valid) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
    if (this.workflows.has(workflow.id)) throw new Error(`Workflow already exists: ${workflow.id}`)
    this.workflows.set(workflow.id, workflow)
    await this.persist()
    return cloneWorkflow(workflow)
  }

  async update(id: string, input: WorkflowUpdateInput): Promise<WorkflowDefinition> {
    await this.initialize()
    const current = this.workflows.get(id)
    if (current === undefined) throw new Error(`Workflow not found: ${id}`)
    if (input.revision !== undefined && input.revision !== current.revision) throw new Error('Workflow changed elsewhere; reload before saving')
    const workflow = normalizeWorkflow({
      ...current,
      ...input,
      id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
    })
    if (workflow === undefined) throw new Error('Invalid workflow document')
    const result = validateWorkflow(workflow)
    if (!result.valid) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
    this.workflows.set(id, workflow)
    await this.persist()
    return cloneWorkflow(workflow)
  }

  async remove(id: string): Promise<void> {
    await this.initialize()
    if (!this.workflows.delete(id)) throw new Error(`Workflow not found: ${id}`)
    await this.persist()
  }

  async duplicate(id: string): Promise<WorkflowDefinition> {
    const source = this.workflows.get(id)
    if (source === undefined) throw new Error(`Workflow not found: ${id}`)
    const idMap = new Map(source.nodes.map((node) => [node.id, `${node.id}-copy-${randomUUID().slice(0, 6)}`]))
    return this.create({
      name: `${source.name} copy`,
      description: source.description,
      nodes: source.nodes.map((node) => ({ ...cloneWorkflow(node), id: idMap.get(node.id) as string })),
      edges: source.edges.map((edge) => ({ ...edge, id: `${edge.id}-copy-${randomUUID().slice(0, 6)}`, source: idMap.get(edge.source) as string, target: idMap.get(edge.target) as string })),
    })
  }

  async markLastRun(workflowId: string, runId: string): Promise<void> {
    const workflow = this.workflows.get(workflowId)
    if (workflow === undefined) return
    workflow.lastRunId = runId
    workflow.updatedAt = new Date().toISOString()
    await this.persist()
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.filePath, this.list())
  }
}
