import { mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { WORKFLOW_SCHEMA_VERSION, cloneWorkflow, createDefaultWorkflow, formatWorkflowValidationIssues, normalizeWorkflow, validateWorkflow, type WorkflowCreateInput, type WorkflowDefinition, type WorkflowUpdateInput } from '../../shared/workflow.js'
import { WorkflowMutationCoordinator, workflowMutationCoordinator, type WorkflowSaveImages } from './workflow-mutation-coordinator.js'

const FILE_NAME = 'workflows.json'
const VERSIONS_FILE_NAME = 'workflow-versions.json'

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
  private readonly versionsFilePath: string
  private readonly workflows = new Map<string, WorkflowDefinition>()
  private readonly versions = new Map<string, Map<number, WorkflowDefinition>>()
  private initialized = false
  private initializationPromise: Promise<void> | undefined
  readonly mutations: WorkflowMutationCoordinator

  constructor(stateDir: string, mutations = workflowMutationCoordinator(stateDir)) {
    this.mutations = mutations
    this.filePath = join(stateDir, FILE_NAME)
    this.versionsFilePath = join(stateDir, VERSIONS_FILE_NAME)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initializationPromise ??= this.load()
    return this.initializationPromise
  }

  private async load(): Promise<void> {
    await this.mutations.initialize()
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const normalized = normalizeWorkflow(item)
          const workflow = normalized === undefined ? undefined : ensureFixedTerminalNodes(normalized)
          if (workflow !== undefined && validateWorkflow(workflow).valid && !this.mutations.isWorkflowDeleted(workflow.id)) this.workflows.set(workflow.id, workflow)
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    try {
      const versionsRaw = JSON.parse(await readFile(this.versionsFilePath, 'utf8')) as unknown
      if (versionsRaw !== null && typeof versionsRaw === 'object' && !Array.isArray(versionsRaw)) {
        for (const [workflowId, entries] of Object.entries(versionsRaw)) {
          if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue
          const snapshots = new Map<number, WorkflowDefinition>()
          for (const [revision, value] of Object.entries(entries)) {
            const parsedRevision = Number(revision)
            const snapshot = normalizeWorkflow(value)
            if (Number.isInteger(parsedRevision) && snapshot !== undefined && validateWorkflow(snapshot).valid) {
              if (snapshot.id !== workflowId || snapshot.revision !== parsedRevision) continue
              snapshots.set(parsedRevision, snapshot)
            }
          }
          if (snapshots.size > 0) this.versions.set(workflowId, snapshots)
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    for (const workflow of this.workflows.values()) {
      const snapshots = this.versions.get(workflow.id) ?? new Map<number, WorkflowDefinition>()
      if (!snapshots.has(workflow.revision)) snapshots.set(workflow.revision, cloneWorkflow(workflow))
      this.versions.set(workflow.id, snapshots)
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

  getRevision(id: string, revision: number): WorkflowDefinition | undefined {
    const snapshot = this.versions.get(id)?.get(revision)
    return snapshot === undefined ? undefined : cloneWorkflow(snapshot)
  }

  async create(input: WorkflowCreateInput): Promise<WorkflowDefinition> {
    await this.initialize()
    return this.mutations.run(() => this.createLocked(input))
  }

  private async createLocked(input: WorkflowCreateInput): Promise<WorkflowDefinition> {
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
    this.mutations.assertWorkflowWritable(workflow.id)
    await this.saveWorkflow(workflow, true)
    return cloneWorkflow(workflow)
  }

  async update(id: string, input: WorkflowUpdateInput): Promise<WorkflowDefinition> {
    await this.initialize()
    return this.mutations.run(async () => {
    this.mutations.assertWorkflowWritable(id)
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
    await this.saveWorkflow(workflow, true)
    return cloneWorkflow(workflow)
    })
  }

  async remove(id: string): Promise<void> {
    await this.initialize()
    const { WorkflowRunStore } = await import('./workflow-run-store.js')
    const runs = new WorkflowRunStore(dirname(this.filePath), undefined, this.mutations)
    await runs.deleteWorkflow(this, id, true)
  }

  async duplicate(id: string): Promise<WorkflowDefinition> {
    await this.initialize()
    return this.mutations.run(async () => {
    this.mutations.assertWorkflowWritable(id)
    const source = this.workflows.get(id)
    if (source === undefined) throw new Error(`Workflow not found: ${id}`)
    const idMap = new Map(source.nodes.map((node) => [node.id, `${node.id}-copy-${randomUUID().slice(0, 6)}`]))
    return this.createLocked({
      name: `${source.name} copy`,
      description: source.description,
      ...(source.generationPrompt === undefined ? {} : { generationPrompt: source.generationPrompt }),
      ...(source.permissionPolicy === undefined ? {} : { permissionPolicy: cloneWorkflow(source.permissionPolicy) }),
      nodes: source.nodes.map((node) => ({
        ...cloneWorkflow(node),
        id: idMap.get(node.id) as string,
        ...(node.inputBindings === undefined ? {} : {
          inputBindings: node.inputBindings.map((binding) => ({ ...binding, sourceNodeId: idMap.get(binding.sourceNodeId) ?? binding.sourceNodeId })),
        }),
      })),
      edges: source.edges.map((edge) => ({ ...edge, id: `${edge.id}-copy-${randomUUID().slice(0, 6)}`, source: idMap.get(edge.source) as string, target: idMap.get(edge.target) as string })),
    })
    })
  }

  async markLastRun(workflowId: string, runId: string): Promise<void> {
    await this.initialize()
    await this.mutations.run(async () => {
    const workflow = this.workflows.get(workflowId)
    if (workflow === undefined) return
    this.mutations.assertWorkflowWritable(workflowId)
    await this.saveWorkflow({ ...workflow, lastRunId: runId, updatedAt: new Date().toISOString() }, false)
    })
  }

  private async persist(images: WorkflowSaveImages): Promise<void> {
    await this.mutations.save(images)
  }

  private async saveWorkflow(workflow: WorkflowDefinition, recordRevision: boolean): Promise<void> {
    const definitions = new Map(this.workflows)
    const versions = new Map(this.versions)
    definitions.set(workflow.id, cloneWorkflow(workflow))
    if (recordRevision) {
      const snapshots = new Map(versions.get(workflow.id))
      const existing = snapshots.get(workflow.revision)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(workflow)) throw new Error('WORKFLOW_REVISION_CONFLICT')
      snapshots.set(workflow.revision, cloneWorkflow(workflow))
      versions.set(workflow.id, snapshots)
    }
    const images = this.images(definitions, versions)
    await this.persist(images)
    this.publish(images)
  }

  private images(definitions = this.workflows, versions = this.versions): WorkflowSaveImages {
    return { definitions: cloneList(definitions.values()), versions: Object.fromEntries(Array.from(versions, ([id, snapshots]) => [id, Object.fromEntries(snapshots)])) }
  }

  /** Called only while the shared writer is held. Historical snapshots remain
   * archival: deleting an editable definition never loads it from versions. */
  deletionImages(id: string, removeDefinition: boolean): WorkflowSaveImages {
    const definitions = new Map(this.workflows)
    if (removeDefinition && !definitions.delete(id)) throw new Error(`Workflow not found: ${id}`)
    // Conservatively retain exact historical revisions, including transitive
    // sub-workflow pins whose release graph is owned by another store.
    return this.images(definitions)
  }

  publish(images: WorkflowSaveImages): void {
    this.workflows.clear()
    for (const workflow of images.definitions as WorkflowDefinition[]) this.workflows.set(workflow.id, cloneWorkflow(workflow))
    this.versions.clear()
    for (const [id, revisions] of Object.entries(images.versions as Record<string, Record<string, WorkflowDefinition>>)) this.versions.set(id, new Map(Object.entries(revisions).map(([revision, workflow]) => [Number(revision), cloneWorkflow(workflow)])))
  }
}
