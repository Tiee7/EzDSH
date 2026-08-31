import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { WORKFLOW_SCHEMA_VERSION, cloneWorkflow, createDefaultWorkflow, formatWorkflowValidationIssues, normalizeWorkflow, validateWorkflow, type WorkflowCreateInput, type WorkflowDefinition, type WorkflowUpdateInput } from '../../shared/workflow.js'

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

function availableId(base: string, occupied: Set<string>): string {
  if (!occupied.has(base)) return base
  let suffix = 2
  while (occupied.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

/** Persisted workflows predating fixed terminals are repaired once when loaded. */
function ensureFixedTerminalNodes(workflow: WorkflowDefinition): WorkflowDefinition {
  const missingInput = !workflow.nodes.some((node) => node.type === 'input')
  const missingOutput = !workflow.nodes.some((node) => node.type === 'output')
  if (!missingInput && !missingOutput) return workflow

  const nodes = [...workflow.nodes]
  const edges = [...workflow.edges]
  const bodyNodes = nodes.filter((node) => node.type !== 'input' && node.type !== 'output')
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edgeIds = new Set(edges.map((edge) => edge.id))
  const left = bodyNodes.length === 0 ? 80 : Math.min(...bodyNodes.map((node) => node.position.x)) - 300
  const right = bodyNodes.length === 0 ? 720 : Math.max(...bodyNodes.map((node) => node.position.x)) + 300
  const y = bodyNodes[0]?.position.y ?? 180

  const addEdge = (source: string, target: string): void => {
    if (edges.some((edge) => edge.source === source && edge.target === target)) return
    const id = availableId(`edge-${source}-${target}`, edgeIds)
    edgeIds.add(id)
    edges.push({ id, source, target })
  }

  if (missingInput) {
    const id = availableId(`${workflow.id}-input`, nodeIds)
    nodeIds.add(id)
    nodes.unshift({ id, type: 'input', label: '开始', config: { name: 'task' }, position: { x: left, y } })
    const roots = bodyNodes.filter((node) => !edges.some((edge) => edge.target === node.id && bodyNodes.some((candidate) => candidate.id === edge.source)))
    const targets = roots.length > 0 ? roots : nodes.filter((node) => node.type === 'output')
    for (const target of targets) addEdge(id, target.id)
  }

  if (missingOutput) {
    const id = availableId(`${workflow.id}-output`, nodeIds)
    nodeIds.add(id)
    nodes.push({ id, type: 'output', label: '结束', config: { contentMode: 'variable' }, position: { x: right, y } })
    const leaves = bodyNodes.filter((node) => !edges.some((edge) => edge.source === node.id && bodyNodes.some((candidate) => candidate.id === edge.target)))
    const sources = leaves.length > 0 ? leaves : nodes.filter((node) => node.type === 'input')
    for (const source of sources) addEdge(source.id, id)
  }

  return { ...workflow, nodes, edges }
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
          const normalized = normalizeWorkflow(item)
          const workflow = normalized === undefined ? undefined : ensureFixedTerminalNodes(normalized)
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
    if (!result.valid) throw new Error(formatWorkflowValidationIssues(workflow, result.issues, '创建工作流'))
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
    if (!result.valid) throw new Error(formatWorkflowValidationIssues(workflow, result.issues, '保存工作流'))
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
      nodes: source.nodes.map((node) => ({
        ...cloneWorkflow(node),
        id: idMap.get(node.id) as string,
        ...(node.inputBindings === undefined ? {} : {
          inputBindings: node.inputBindings.map((binding) => ({ ...binding, sourceNodeId: idMap.get(binding.sourceNodeId) ?? binding.sourceNodeId })),
        }),
      })),
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
