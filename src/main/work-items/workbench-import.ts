import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

type UnknownRecord = Record<string, unknown>

export type WorkbenchImportCandidateKind = 'task' | 'idea'
export type WorkbenchImportHistoryKind = 'task-execution' | 'queue-run' | 'proposal-run' | 'proposal-history'

export interface WorkbenchImportHistoryPreview {
  sourceKey: string
  kind: WorkbenchImportHistoryKind
  status: string
  runId?: string
  sessionId?: string
  resultAvailable: boolean
}

export interface WorkbenchImportFileReference {
  relativePath: string
  size?: number
  contentHash?: string
  status: 'available' | 'missing' | 'unsafe'
  linkedSourceKeys: string[]
}

export interface WorkbenchImportProjectPreview {
  sourceId: string
  name: string
  description: string
  status: string
  projectRef?: string
  contentHash: string
}

export interface WorkbenchImportOperationPreview {
  sourceKey: string
  status: string
  changeCount: number
  recordedAt?: string
}

export interface WorkbenchImportCandidate {
  sourceKey: string
  targetId: string
  kind: WorkbenchImportCandidateKind
  legacyId: string
  projectSourceId?: string
  title: string
  goal: string
  acceptance: string
  originalStatus: string
  proposedStatus: 'open' | 'active' | 'review' | 'cancelled'
  acceptanceEvidence: Array<'legacy-criteria' | 'legacy-done-status'>
  humanAccepted: false
  history: WorkbenchImportHistoryPreview[]
  fileReferences: string[]
  contentHash: string
}

export interface WorkbenchImportConflict {
  code:
    | 'DUPLICATE_SOURCE_ID'
    | 'MISSING_SOURCE_FILE'
    | 'MISSING_PROJECT'
    | 'MISSING_FILE_REFERENCE'
    | 'UNSAFE_FILE_REFERENCE'
  sourceKey: string
  detail: string
}

export interface WorkbenchImportPreview {
  format: 'ezdsh-workbench-v1'
  sourceId: string
  sourceHash: string
  sourceDirectory: string
  dataDirectory: string
  projects: WorkbenchImportProjectPreview[]
  operations: WorkbenchImportOperationPreview[]
  candidates: WorkbenchImportCandidate[]
  files: WorkbenchImportFileReference[]
  conflicts: WorkbenchImportConflict[]
  summary: {
    projects: number
    tasks: number
    ideas: number
    histories: number
    operations: number
    files: number
    conflicts: number
  }
}

export interface WorkbenchImportReceipt {
  sourceId: string
  sourceKey: string
  targetId: string
  contentHash: string
}

export interface WorkbenchImportItemPreview extends WorkbenchImportReceipt {
  action: 'create' | 'duplicate' | 'conflict'
  reason?: string
}

export interface WorkbenchImportApplicationPreview {
  sourceId: string
  sourceHash: string
  plannedCount: number
  createdCount: number
  duplicateCount: number
  conflictCount: number
  items: WorkbenchImportItemPreview[]
}

export class WorkbenchImportError extends Error {
  readonly code: 'INVALID_SOURCE' | 'UNKNOWN_FORMAT' | 'CORRUPT_SOURCE' | 'UNSAFE_PATH'
  readonly path?: string

  constructor(
    code: WorkbenchImportError['code'],
    message: string,
    path?: string,
  ) {
    super(message)
    this.name = 'WorkbenchImportError'
    this.code = code
    this.path = path
  }
}

const MAX_JSON_BYTES = 10 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
const MAX_DOCUMENTS = 10_000

/**
 * Reads the legacy Workbench format and returns an inert mapping preview.
 * It never creates a WorkItem, copies a file, or invokes an execution service.
 */
export async function previewWorkbenchImport(sourceDirectory: string): Promise<WorkbenchImportPreview> {
  const sourceRoot = await verifiedDirectory(sourceDirectory, 'sourceDirectory')
  const layout = await locateLayout(sourceRoot)
  const conflicts: WorkbenchImportConflict[] = []
  const manifest = new Map<string, string>()

  const entityFiles = ['projects.json', 'tasks.json', 'ideas.json'] as const
  const entityValues = new Map<(typeof entityFiles)[number], unknown[] | undefined>()
  for (const name of entityFiles) {
    const value = await readOptionalJson(join(layout.dataRoot, name), manifest)
    if (value !== undefined && !Array.isArray(value)) {
      throw corrupt(join(layout.dataRoot, name), `${name} must contain an array`)
    }
    entityValues.set(name, value as unknown[] | undefined)
  }

  const workspace = await readOptionalJson(join(layout.dataRoot, 'workspace.json'), manifest)
  // workspace.json is a generated dashboard cache; it must not change the
  // portable source identity when its generatedAt or summary changes.
  manifest.delete(join(layout.dataRoot, 'workspace.json'))
  if (workspace !== undefined && !isRecord(workspace)) {
    throw corrupt(join(layout.dataRoot, 'workspace.json'), 'workspace.json must contain an object')
  }

  const hasCanonicalEntityFile = entityFiles.some((name) => entityValues.get(name) !== undefined)
  if (!hasCanonicalEntityFile && workspace === undefined && !layout.hasWorkbenchMarker) {
    const entries = await readdir(sourceRoot)
    if (entries.length > 0) {
      throw new WorkbenchImportError('UNKNOWN_FORMAT', 'directory is not a recognized Workbench source', sourceRoot)
    }
  }

  const workspaceRecord = isRecord(workspace) ? workspace : undefined
  const projects = sourceArray(entityValues.get('projects.json'), workspaceRecord?.projects, 'projects', layout, conflicts, manifest)
  const tasks = sourceArray(entityValues.get('tasks.json'), workspaceRecord?.tasks, 'tasks', layout, conflicts, manifest)
  const ideas = sourceArray(entityValues.get('ideas.json'), workspaceRecord?.ideas, 'ideas', layout, conflicts, manifest)

  const queue = await readOptionalJson(join(layout.dataRoot, 'dsh-queue.json'), manifest)
  if (queue !== undefined && !isRecord(queue)) {
    throw corrupt(join(layout.dataRoot, 'dsh-queue.json'), 'dsh-queue.json must contain an object')
  }
  const queueItems = queue === undefined ? [] : recordArray(queue.items, 'dsh-queue.json.items', layout.dataRoot)
  const operations = await readOperations(layout.dataRoot, manifest)

  const proposals = await readProposals(layout.dataRoot, manifest)
  const documentRoot = await locateDocumentRoot(layout, manifest, conflicts)
  const files = documentRoot === undefined
    ? []
    : await readDocumentReferences(documentRoot, layout.sourceRoot, manifest)

  const projectRecords = records(projects, 'projects', layout.dataRoot)
  const taskRecords = records(tasks, 'tasks', layout.dataRoot)
  const ideaRecords = records(ideas, 'ideas', layout.dataRoot)
  // The content hash is portable, while sourceId identifies the selected
  // Workbench instance. Without a persisted legacy UUID, the canonical source
  // path is the only stable namespace available; two independent copies must
  // not share receipts merely because their entities happen to have the same IDs.
  const sourceIdentity = stableStringify({ format: 'ezdsh-workbench-v1', layout: 'data-v1', sourceRoot: slash(layout.sourceRoot) })
  const sourceId = `workbench-${digest(sourceIdentity).slice(0, 24)}`

  const seenKeys = new Set<string>()
  const projectPreviews = projectRecords.map((project, index) => {
    const legacyId = requiredLegacyId(project, `project-${index + 1}`)
    const sourceKey = `project:${legacyId}`
    noteDuplicate(sourceKey, seenKeys, conflicts)
    const projectContent = {
      legacyId,
      name: text(project.name, 'Untitled project'),
      description: text(project.description),
      status: text(project.status, 'unknown'),
      projectRef: optionalText(project.dshProjectId),
    }
    return {
      sourceId: legacyId,
      name: projectContent.name,
      description: projectContent.description,
      status: projectContent.status,
      ...(projectContent.projectRef === undefined ? {} : { projectRef: projectContent.projectRef }),
      contentHash: digest(stableStringify(projectContent)),
    }
  })
  const projectIds = new Set(projectPreviews.map((project) => project.sourceId))

  const proposalHistories = collectProposalHistories(proposals, files)
  const queueHistories = collectQueueHistories(queueItems)
  const candidates: WorkbenchImportCandidate[] = []
  for (const [kind, values] of [['task', taskRecords], ['idea', ideaRecords]] as const) {
    values.forEach((record, index) => {
      const legacyId = requiredLegacyId(record, `${kind}-${index + 1}`)
      const sourceKey = `${kind}:${legacyId}`
      noteDuplicate(sourceKey, seenKeys, conflicts)
      const projectSourceId = kind === 'task' ? optionalText(record.projectId) : undefined
      if (projectSourceId !== undefined && !projectIds.has(projectSourceId)) {
        conflicts.push({
          code: 'MISSING_PROJECT', sourceKey,
          detail: `referenced project does not exist: ${projectSourceId}`,
        })
      }
      const taskExecution = kind === 'task' && isRecord(record.execution)
        ? [historyPreview(`${sourceKey}:execution`, 'task-execution', record.execution)]
        : []
      const history = [
        ...taskExecution,
        ...(queueHistories.get(sourceKey) ?? []),
        ...(proposalHistories.histories.get(sourceKey) ?? []),
      ]
      const fileReferences = [...(proposalHistories.fileLinks.get(sourceKey) ?? [])].sort()
      const originalStatus = text(record.status, 'unknown')
      const acceptance = kind === 'task' ? text(record.acceptanceCriteria) : ''
      const acceptanceEvidence: WorkbenchImportCandidate['acceptanceEvidence'] = []
      if (acceptance) acceptanceEvidence.push('legacy-criteria')
      if (kind === 'task' && originalStatus === 'done') acceptanceEvidence.push('legacy-done-status')
      const content = {
        sourceKey,
        kind,
        projectSourceId,
        title: text(record.title, kind === 'task' ? 'Untitled task' : 'Untitled idea'),
        goal: kind === 'task' ? text(record.description) : text(record.content),
        acceptance,
        originalStatus,
        history,
        fileReferences,
      }
      candidates.push({
      sourceKey,
      targetId: stableTargetId(sourceId, sourceKey),
        kind,
        legacyId,
        ...(projectSourceId === undefined ? {} : { projectSourceId }),
        title: content.title,
        goal: content.goal,
        acceptance,
        originalStatus,
        proposedStatus: proposedStatus(originalStatus),
        acceptanceEvidence,
        humanAccepted: false,
        history,
        fileReferences,
        contentHash: digest(stableStringify(content)),
      })
    })
  }

  const linked = new Map<string, string[]>()
  for (const candidate of candidates) {
    for (const filePath of candidate.fileReferences) {
      const values = linked.get(filePath) ?? []
      values.push(candidate.sourceKey)
      linked.set(filePath, values)
    }
  }
  const linkedFiles = files
    .map((file) => ({ ...file, linkedSourceKeys: linked.get(file.relativePath) ?? file.linkedSourceKeys }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  for (const conflict of proposalHistories.conflicts) conflicts.push(conflict)

  const portableManifest = [...manifest.entries()].map(([path, hash]) => [
    path.startsWith('document:') || path.startsWith('workspace-fallback:') ? path : slash(relative(layout.sourceRoot, path)),
    hash,
  ] as const).sort(([left], [right]) => left.localeCompare(right))
  const sourceHash = digest(stableStringify(portableManifest))
  const histories = candidates.reduce((count, candidate) => count + candidate.history.length, 0)
  return {
    format: 'ezdsh-workbench-v1',
    sourceId,
    sourceHash,
    sourceDirectory: layout.sourceRoot,
    dataDirectory: layout.dataRoot,
    projects: projectPreviews,
    operations,
    candidates,
    files: linkedFiles,
    conflicts,
    summary: {
      projects: projectPreviews.length,
      tasks: candidates.filter((candidate) => candidate.kind === 'task').length,
      ideas: candidates.filter((candidate) => candidate.kind === 'idea').length,
      histories,
      operations: operations.length,
      files: linkedFiles.length,
      conflicts: conflicts.length,
    },
  }
}

/**
 * Produces per-item receipts for a future importer. This function is also inert:
 * callers must explicitly persist accepted receipts and create business records elsewhere.
 */
export function previewWorkbenchImportApplication(
  preview: WorkbenchImportPreview,
  existingReceipts: readonly WorkbenchImportReceipt[] = [],
): WorkbenchImportApplicationPreview {
  const receipts = new Map(existingReceipts.map((receipt) => [`${receipt.sourceId}\u0000${receipt.sourceKey}`, receipt]))
  const items = preview.candidates.map<WorkbenchImportItemPreview>((candidate) => {
    const base: WorkbenchImportReceipt = {
      sourceId: preview.sourceId,
      sourceKey: candidate.sourceKey,
      targetId: candidate.targetId,
      contentHash: candidate.contentHash,
    }
    const sourceConflict = preview.conflicts.some((conflict) =>
      conflict.sourceKey === candidate.sourceKey
      || conflict.sourceKey.startsWith(`${candidate.sourceKey}:`)
      || conflict.detail.includes(candidate.sourceKey)
      || (conflict.code === 'MISSING_SOURCE_FILE' && conflict.sourceKey === `file:${candidate.kind}s.json`)
      || (conflict.code === 'MISSING_FILE_REFERENCE' || conflict.code === 'UNSAFE_FILE_REFERENCE')
        && candidate.fileReferences.some((reference) => conflict.detail.includes(reference)))
    const existing = receipts.get(`${preview.sourceId}\u0000${candidate.sourceKey}`)
    if (sourceConflict) return { ...base, action: 'conflict', reason: 'source preview contains unresolved relationship or file conflicts' }
    if (existing === undefined) return { ...base, action: 'create' }
    if (existing.targetId === candidate.targetId && existing.contentHash === candidate.contentHash) {
      return { ...base, action: 'duplicate' }
    }
    return { ...base, action: 'conflict', reason: 'source identity was previously mapped with different content or target' }
  })
  return {
    sourceId: preview.sourceId,
    sourceHash: preview.sourceHash,
    plannedCount: items.length,
    createdCount: items.filter((item) => item.action === 'create').length,
    duplicateCount: items.filter((item) => item.action === 'duplicate').length,
    conflictCount: items.filter((item) => item.action === 'conflict').length,
    items,
  }
}

interface WorkbenchLayout {
  sourceRoot: string
  dataRoot: string
  hasWorkbenchMarker: boolean
}

async function locateLayout(sourceRoot: string): Promise<WorkbenchLayout> {
  if (basename(sourceRoot) === 'data') {
    return { sourceRoot: dirname(sourceRoot), dataRoot: sourceRoot, hasWorkbenchMarker: true }
  }
  const dataPath = join(sourceRoot, 'data')
  const dataStat = await optionalLstat(dataPath)
  if (dataStat !== undefined) {
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new WorkbenchImportError('UNSAFE_PATH', 'Workbench data must be a real directory', dataPath)
    }
    return { sourceRoot, dataRoot: await realpath(dataPath), hasWorkbenchMarker: true }
  }
  const directMarkers = await Promise.all(
    ['projects.json', 'tasks.json', 'ideas.json', 'workspace.json'].map((name) => optionalLstat(join(sourceRoot, name))),
  )
  return { sourceRoot, dataRoot: sourceRoot, hasWorkbenchMarker: directMarkers.some(Boolean) }
}

async function verifiedDirectory(input: string, field: string): Promise<string> {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\u0000')) {
    throw new WorkbenchImportError('INVALID_SOURCE', `${field} must be a non-empty path`)
  }
  const candidate = resolve(input)
  let details
  try {
    details = await lstat(candidate)
  } catch (error) {
    throw new WorkbenchImportError('INVALID_SOURCE', `${field} cannot be read: ${errorMessage(error)}`, candidate)
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new WorkbenchImportError('UNSAFE_PATH', `${field} must be a real directory`, candidate)
  }
  return realpath(candidate)
}

async function readOptionalJson(path: string, manifest: Map<string, string>): Promise<unknown | undefined> {
  const bytes = await readOptionalRegularFile(path, MAX_JSON_BYTES)
  if (bytes === undefined) return undefined
  manifest.set(path, digest(bytes))
  if (bytes.length === 0 || bytes.toString('utf8').trim() === '') return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw corrupt(path, `invalid JSON: ${errorMessage(error)}`)
  }
}

async function readOptionalRegularFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const details = await optionalLstat(path)
  if (details === undefined) return undefined
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new WorkbenchImportError('UNSAFE_PATH', 'source file must be a regular file and not a symbolic link', path)
  }
  if (details.size > maxBytes) throw corrupt(path, `source file exceeds ${maxBytes} bytes`)
  return readFile(path)
}

function sourceArray(
  canonical: unknown[] | undefined,
  workspaceValue: unknown,
  name: string,
  layout: WorkbenchLayout,
  conflicts: WorkbenchImportConflict[],
  manifest: Map<string, string>,
): unknown[] {
  if (canonical !== undefined) return canonical
  if (workspaceValue !== undefined) {
    if (!Array.isArray(workspaceValue)) throw corrupt(join(layout.dataRoot, 'workspace.json'), `workspace.${name} must be an array`)
    conflicts.push({
      code: 'MISSING_SOURCE_FILE', sourceKey: `file:${name}.json`,
      detail: `${name}.json is missing; preview uses workspace.json fallback`,
    })
    // Generated dashboard metadata (for example generatedAt) is ignored, but
    // fallback entity content is still source evidence and must affect sourceHash.
    manifest.set(`workspace-fallback:${name}.json`, digest(stableStringify(workspaceValue)))
    return workspaceValue
  }
  if (layout.hasWorkbenchMarker) {
    conflicts.push({ code: 'MISSING_SOURCE_FILE', sourceKey: `file:${name}.json`, detail: `${name}.json is missing` })
  }
  return []
}

function records(values: unknown[], label: string, root: string): UnknownRecord[] {
  return values.map((value, index) => {
    if (!isRecord(value)) throw corrupt(join(root, `${label}.json`), `${label}[${index}] must be an object`)
    return value
  })
}

async function readProposals(dataRoot: string, manifest: Map<string, string>): Promise<Array<{ name: string; value: UnknownRecord }>> {
  const directory = join(dataRoot, 'ai-proposals')
  const details = await optionalLstat(directory)
  if (details === undefined) return []
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new WorkbenchImportError('UNSAFE_PATH', 'ai-proposals must be a real directory', directory)
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.') && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
  const proposals = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new WorkbenchImportError('UNSAFE_PATH', 'proposal must be a regular file', join(directory, entry.name))
    }
    const value = await readOptionalJson(join(directory, entry.name), manifest)
    if (!isRecord(value)) throw corrupt(join(directory, entry.name), 'proposal must contain an object')
    proposals.push({ name: entry.name.slice(0, -5), value })
  }
  return proposals
}

async function readOperations(
  dataRoot: string,
  manifest: Map<string, string>,
): Promise<WorkbenchImportOperationPreview[]> {
  const path = join(dataRoot, 'operations.jsonl')
  const bytes = await readOptionalRegularFile(path, MAX_JSON_BYTES)
  if (bytes === undefined) return []
  manifest.set(path, digest(bytes))
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
  return lines.map((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      throw corrupt(path, `invalid JSONL at line ${index + 1}: ${errorMessage(error)}`)
    }
    if (!isRecord(value)) throw corrupt(path, `operation at line ${index + 1} must be an object`)
    const operationId = optionalText(value.id) ?? `line-${index + 1}`
    const recordedAt = optionalText(value.completedAt) ?? optionalText(value.createdAt)
    return {
      sourceKey: `operation:${operationId}:${index + 1}`,
      status: text(value.status, 'unknown'),
      changeCount: Array.isArray(value.changes) ? value.changes.length : 0,
      ...(recordedAt === undefined ? {} : { recordedAt }),
    }
  })
}

async function locateDocumentRoot(
  layout: WorkbenchLayout,
  manifest: Map<string, string>,
  conflicts: WorkbenchImportConflict[],
): Promise<string | undefined> {
  const configPath = join(layout.dataRoot, 'document-config.json')
  const config = await readOptionalJson(configPath, manifest)
  // The legacy config stores an absolute machine-local path. Document bytes below
  // are the portable source evidence; the absolute path itself is not.
  manifest.delete(configPath)
  if (config !== undefined && !isRecord(config)) {
    throw corrupt(configPath, 'document-config.json must contain an object')
  }
  const configured = isRecord(config) ? optionalText(config.rootDir) : undefined
  const candidate = configured === undefined
    ? join(layout.dataRoot, 'documents')
    : isAbsolute(configured) ? resolve(configured) : resolve(layout.sourceRoot, configured)
  const details = await optionalLstat(candidate)
  if (details === undefined) {
    const candidateParent = await realpath(dirname(candidate)).catch(() => undefined)
    if (candidateParent !== undefined && !isWithin(layout.sourceRoot, candidateParent)) {
      conflicts.push({
        code: 'UNSAFE_FILE_REFERENCE', sourceKey: 'document-config:rootDir',
        detail: 'document root escapes the selected Workbench source',
      })
    }
    return undefined
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    conflicts.push({
      code: 'UNSAFE_FILE_REFERENCE', sourceKey: 'document-config:rootDir',
      detail: 'document root is not a real directory',
    })
    return undefined
  }
  const resolved = await realpath(candidate)
  if (!isWithin(layout.sourceRoot, resolved)) {
    conflicts.push({
      code: 'UNSAFE_FILE_REFERENCE', sourceKey: 'document-config:rootDir',
      detail: 'document root resolves outside the selected Workbench source',
    })
    return undefined
  }
  return resolved
}

async function readDocumentReferences(
  documentRoot: string,
  sourceRoot: string,
  manifest: Map<string, string>,
): Promise<WorkbenchImportFileReference[]> {
  const files: WorkbenchImportFileReference[] = []
  const queue = [documentRoot]
  while (queue.length > 0) {
    const directory = queue.shift()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new WorkbenchImportError('UNSAFE_PATH', 'documents must not contain symbolic links', path)
      }
      if (entry.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (files.length >= MAX_DOCUMENTS) throw corrupt(documentRoot, `document count exceeds ${MAX_DOCUMENTS}`)
      const bytes = await readOptionalRegularFile(path, MAX_DOCUMENT_BYTES)
      if (bytes === undefined) continue
      const relativePath = slash(relative(documentRoot, path))
      const contentHash = digest(bytes)
      manifest.set(`document:${slash(relative(sourceRoot, path))}`, contentHash)
      files.push({ relativePath, size: bytes.length, contentHash, status: 'available', linkedSourceKeys: [] })
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function collectQueueHistories(items: UnknownRecord[]): Map<string, WorkbenchImportHistoryPreview[]> {
  const histories = new Map<string, WorkbenchImportHistoryPreview[]>()
  items.forEach((item, index) => {
    const subjectType = optionalText(item.subjectType)
    const subjectId = optionalText(item.subjectId)
    if ((subjectType !== 'task' && subjectType !== 'idea') || subjectId === undefined) return
    const sourceKey = `${subjectType}:${subjectId}`
    const values = histories.get(sourceKey) ?? []
    values.push(historyPreview(`queue:${optionalText(item.id) ?? index + 1}`, 'queue-run', item))
    histories.set(sourceKey, values)
  })
  return histories
}

function collectProposalHistories(
  proposals: Array<{ name: string; value: UnknownRecord }>,
  files: WorkbenchImportFileReference[],
): {
  histories: Map<string, WorkbenchImportHistoryPreview[]>
  fileLinks: Map<string, Set<string>>
  conflicts: WorkbenchImportConflict[]
} {
  const histories = new Map<string, WorkbenchImportHistoryPreview[]>()
  const fileLinks = new Map<string, Set<string>>()
  const conflicts: WorkbenchImportConflict[] = []
  const filePaths = new Set(files.map((file) => file.relativePath))
  for (const proposal of proposals) {
    const target = isRecord(proposal.value.target) ? proposal.value.target : undefined
    const entityType = target === undefined ? undefined : optionalText(target.entityType)
    const entityId = target === undefined ? undefined : optionalText(target.entityId)
    if ((entityType !== 'task' && entityType !== 'idea') || entityId === undefined) continue
    const sourceKey = `${entityType}:${entityId}`
    const values = histories.get(sourceKey) ?? []
    if (isRecord(proposal.value.run)) {
      values.push(historyPreview(`proposal:${proposal.name}:run`, 'proposal-run', {
        ...proposal.value.run,
        status: proposal.value.status,
        result: proposal.value.result,
      }))
    }
    const prior = Array.isArray(proposal.value.history) ? proposal.value.history : []
    prior.forEach((entry, index) => {
      if (isRecord(entry)) values.push(historyPreview(`proposal:${proposal.name}:history:${index + 1}`, 'proposal-history', entry))
    })
    histories.set(sourceKey, values)

    const appliedDocument = isRecord(proposal.value.appliedDocument) ? proposal.value.appliedDocument : undefined
    const documentPath = appliedDocument === undefined ? undefined : optionalText(appliedDocument.path)
    if (documentPath === undefined) continue
    const normalized = normalizeRelativeDocumentPath(documentPath)
    if (normalized === undefined) {
      conflicts.push({
        code: 'UNSAFE_FILE_REFERENCE', sourceKey,
        detail: `unsafe applied document path: ${documentPath}`,
      })
      files.push({ relativePath: documentPath, status: 'unsafe', linkedSourceKeys: [sourceKey] })
      continue
    }
    if (!filePaths.has(normalized)) {
      conflicts.push({
        code: 'MISSING_FILE_REFERENCE', sourceKey,
        detail: `applied document is missing: ${normalized}`,
      })
      files.push({ relativePath: normalized, status: 'missing', linkedSourceKeys: [sourceKey] })
      filePaths.add(normalized)
    }
    const links = fileLinks.get(sourceKey) ?? new Set<string>()
    links.add(normalized)
    fileLinks.set(sourceKey, links)
  }
  return { histories, fileLinks, conflicts }
}

function historyPreview(sourceKey: string, kind: WorkbenchImportHistoryKind, value: UnknownRecord): WorkbenchImportHistoryPreview {
  const nested = isRecord(value.run) ? value.run : isRecord(value.execution) ? value.execution : undefined
  const resultAvailable = value.result !== undefined && value.result !== null
    || value.runResult !== undefined && value.runResult !== null
    || nested?.result !== undefined && nested.result !== null
    || nested?.runResult !== undefined && nested.runResult !== null
  const runId = optionalText(value.runId) ?? optionalText(nested?.runId)
  const sessionId = optionalText(value.sessionId) ?? optionalText(nested?.sessionId)
  return {
    sourceKey,
    kind,
    status: text(value.status ?? value.runStatus, 'unknown'),
    ...(runId === undefined ? {} : { runId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    resultAvailable,
  }
}

function proposedStatus(status: string): WorkbenchImportCandidate['proposedStatus'] {
  if (status === 'done' || status === 'completed') return 'review'
  if (status === 'in_progress' || status === 'running' || status === 'active') return 'active'
  if (status === 'cancelled') return 'cancelled'
  return 'open'
}

function stableTargetId(sourceId: string, sourceKey: string): string {
  return `import-${digest(`ezdsh-workbench-v1\u0000${sourceId}\u0000${sourceKey}`).slice(0, 24)}`
}

function sourceIds(values: UnknownRecord[]): string[] {
  return values.map((value, index) => requiredLegacyId(value, `missing-${index + 1}`)).sort()
}

function requiredLegacyId(value: UnknownRecord, fallback: string): string {
  return optionalText(value.id) ?? fallback
}

function noteDuplicate(sourceKey: string, seen: Set<string>, conflicts: WorkbenchImportConflict[]): void {
  if (seen.has(sourceKey)) {
    conflicts.push({ code: 'DUPLICATE_SOURCE_ID', sourceKey, detail: `duplicate source identity: ${sourceKey}` })
  }
  seen.add(sourceKey)
}

function normalizeRelativeDocumentPath(value: string): string | undefined {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

function recordArray(value: unknown, label: string, root: string): UnknownRecord[] {
  if (!Array.isArray(value)) throw corrupt(join(root, label), `${label} must be an array`)
  return records(value, label, root)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function slash(value: string): string {
  return value.split(sep).join('/')
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function corrupt(path: string, message: string): WorkbenchImportError {
  return new WorkbenchImportError('CORRUPT_SOURCE', message, path)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
