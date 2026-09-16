import { isWorkflowValue } from '../../shared/workflow.js'
import type {
  WorkExecutor,
  WorkMaterialRef,
  WorkTaskCreateRequest,
  WorkTaskExecuteRequest,
  WorkTaskSnapshot,
} from '../../shared/work-items.js'

export type WorkItemCreateExecutor = { kind: 'none' } | WorkExecutor

export type WorkItemCreateExecutionDraft = Omit<
  WorkTaskExecuteRequest,
  'taskId' | 'expectedRevision'
>

export interface WorkItemCreateSubmissionInput {
  title: string
  goal: string
  acceptance: string
  projectId?: string
  cwd?: string
  /** Explicit paths relative to the work item's selected working directory. */
  materialPaths?: readonly string[]
  executor: WorkItemCreateExecutor
  executionInput: unknown
  createRequestId: string
  executeRequestId: string
}

export interface WorkItemCreateSubmission {
  create: WorkTaskCreateRequest
  execute?: WorkItemCreateExecutionDraft
}

function required(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${field} is required`)
  return normalized
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? undefined : normalized
}

const MAX_LOCAL_MATERIAL_PATHS = 100
const FNV_OFFSET_BASIS_64 = 14695981039346656037n
const FNV_PRIME_64 = 1099511628211n
const UINT64_MASK = 0xffffffffffffffffn

/**
 * Normalize only the syntax that is safe to represent as a work-item-relative
 * path. This deliberately does not touch the filesystem or resolve symlinks;
 * Main remains the authority for existence and authorization.
 */
export function normalizeLocalMaterialPath(value: string): string {
  const candidate = value.trim().replaceAll('\\', '/')
  if (candidate === '') throw new Error('Material path must not be blank')
  if (/^[A-Za-z]:/.test(candidate) || candidate.startsWith('/')) {
    throw new Error('Material paths must be relative to the workspace')
  }
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error('Material paths must not contain control characters')
  }
  const segments = candidate.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('Material paths must stay inside the workspace')
  }
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/')
  if (normalized === '') throw new Error('Material path must name a file')
  return normalized
}

/** Parse one manually entered local path per line and remove exact duplicates. */
export function parseLocalMaterialPaths(value: string | readonly string[] | undefined): string[] {
  const candidates = value === undefined
    ? []
    : typeof value === 'string'
      ? value.split(/\r?\n/u)
      : [...value]
  const paths: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    const path = normalizeLocalMaterialPath(candidate)
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  if (paths.length > MAX_LOCAL_MATERIAL_PATHS) {
    throw new Error(`A work item can include at most ${MAX_LOCAL_MATERIAL_PATHS} materials`)
  }
  return paths
}

/** Stable, renderer-only identity for a normalized local path. */
export function localMaterialId(path: string): string {
  const normalized = normalizeLocalMaterialPath(path)
  const bytes = new TextEncoder().encode(normalized)
  let hash = FNV_OFFSET_BASIS_64
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME_64) & UINT64_MASK
  }
  return `material-local-${hash.toString(16).padStart(16, '0')}`
}

export function buildLocalMaterialRefs(value: string | readonly string[] | undefined): WorkMaterialRef[] {
  return parseLocalMaterialPaths(value).map((path) => ({
    kind: 'local-file',
    materialId: localMaterialId(path),
    label: path.split('/').at(-1),
    path,
  }))
}

/**
 * Builds the two-step direct-creation submission without inventing the task
 * identity that only Main can assign after create succeeds.
 */
export function buildWorkItemCreateSubmission(
  input: WorkItemCreateSubmissionInput,
): WorkItemCreateSubmission {
  const projectId = optional(input.projectId)
  const cwd = optional(input.cwd)
  const materialRefs = buildLocalMaterialRefs(input.materialPaths)
  const create: WorkTaskCreateRequest = {
    requestId: required(input.createRequestId, 'createRequestId'),
    title: required(input.title, 'title'),
    goal: required(input.goal, 'goal'),
    acceptance: required(input.acceptance, 'acceptance'),
    scope: {
      ...(projectId === undefined ? {} : { projectId }),
      ...(cwd === undefined ? {} : { cwd }),
      resourceRefs: [],
      ...(materialRefs.length === 0 ? {} : { materialRefs }),
    },
  }

  if (input.executor.kind === 'none') return { create }
  if (input.executor.kind === 'workflow' && !isWorkflowValue(input.executionInput)) {
    throw new Error('workflow executionInput must be a finite JSON-safe value')
  }

  return {
    create,
    execute: {
      requestId: required(input.executeRequestId, 'executeRequestId'),
      executor: { ...input.executor },
      mode: 'initial',
      input: input.executionInput,
      ...(materialRefs.length === 0 ? {} : {
        materialInputs: materialRefs.map(({ materialId }) => ({ materialId })),
      }),
    },
  }
}

/** Add the authoritative identity from create; this is the only finalization point. */
export function finalizeWorkItemCreateExecution(
  draft: WorkItemCreateExecutionDraft,
  created: WorkTaskSnapshot,
): WorkTaskExecuteRequest {
  return {
    ...draft,
    taskId: created.task.id,
    expectedRevision: created.task.revision,
  }
}
