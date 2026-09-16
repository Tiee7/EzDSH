import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { toEzDSHError, type IpcResult } from '../../shared/errors.js'
import {
  WORK_ITEM_LIMITS,
  WorkItemValidationError,
  validateWorkActionAnswerRequest,
  validateWorkArtifactAcceptRequest,
  validateWorkTaskArchiveRequest,
  validateWorkTaskCancelRequest,
  validateWorkTaskCreateRequest,
  validateWorkTaskExecuteRequest,
  validateWorkTaskRunDetailRequest,
  validateWorkTaskRevisionRequest,
  validateWorkRunControlRequest,
  type WorkItemQuery,
  type WorkArtifact,
  type WorkMaterialAuthorization,
  type WorkMaterialAuthorizer,
  type WorkMaterialInput,
  type WorkMaterialRef,
  type WorkItemsBridge,
  type WorkScope,
  type WorkTaskSnapshot,
} from '../../shared/work-items.js'
import { deriveWorkbenchAttention, type WorkbenchAttentionSnapshot } from '../../shared/workbench-attention.js'
import { validateWorkItemProjectContextQuery } from '../../shared/project-context.js'
import type { WorkItemProjectContextService } from '../project-context/work-item-project-context-service.js'
import type { WorkDispatchIntentReceipt } from './work-item-store.js'

export const WORK_ITEM_IPC_CHANNELS = [
  'work-items:list',
  'work-items:attention',
  'work-items:get',
  'work-items:get-run-detail',
  'work-items:project-context',
  'work-items:create',
  'work-items:execute',
  'work-items:revise',
  'work-items:cancel-task',
  'work-items:archive',
  'work-items:accept-artifact',
  'work-items:open-artifact',
  'work-items:control-run',
  'work-items:answer-action',
] as const

export const WORK_ITEM_CHANGED_CHANNEL = 'work-items:changed'

type WorkItemReadService = Pick<WorkItemsBridge, 'list' | 'get' | 'create' | 'revise' | 'archive' | 'acceptArtifact' | 'openArtifact'> & {
  /** Main-only durable lookup; omitted from the renderer bridge. */
  getDispatchIntent?: (requestId: string) => Promise<WorkDispatchIntentReceipt | undefined>
}
type WorkItemRunDetailsService = Pick<WorkItemsBridge, 'getRunDetail'>
type WorkItemProjectContextServicePort = Pick<WorkItemProjectContextService, 'read'>
type WorkItemExecutionService = Pick<WorkItemsBridge, 'execute'>
type WorkItemCancellationService = Pick<WorkItemsBridge, 'cancelTask'>
type WorkItemActionService = Pick<WorkItemsBridge, 'controlRun' | 'answerAction'>
export type WorkItemExecutionOperation = 'execute' | 'control-run' | 'answer-action'

export interface WorkItemIpcServices {
  workItems: WorkItemReadService
  runDetails?: WorkItemRunDetailsService
  projectContext?: WorkItemProjectContextServicePort
  execution: WorkItemExecutionService
  cancellation: WorkItemCancellationService
  actions: WorkItemActionService
  assertExecutionAvailable?: (operation: WorkItemExecutionOperation, request: unknown) => void
  authorizeScope?: (scope: WorkScope) => Promise<WorkScope>
}

export class WorkItemScopeUnauthorizedError extends Error {
  readonly code = 'WORK_ITEM_SCOPE_UNAUTHORIZED'

  constructor(message = 'Work item cwd must resolve inside the active workspace') {
    super(message)
    this.name = 'WorkItemScopeUnauthorizedError'
  }
}

export class WorkItemWorkspaceUnavailableError extends Error {
  readonly code = 'WORK_ITEM_WORKSPACE_UNAVAILABLE'

  constructor() {
    super('Work item workspace is not accepting requests')
    this.name = 'WorkItemWorkspaceUnavailableError'
  }
}

/** Owns one workspace's IPC admission and listeners until switch or shutdown. */
export class WorkItemIpcWorkspaceScope {
  private accepting = true
  private readonly pending = new Set<Promise<unknown>>()
  private readonly ownedListeners: Array<() => void>
  private disposal: Promise<void> | undefined

  constructor(
    readonly services: WorkItemIpcServices,
    listenerDisposers: ReadonlyArray<() => void> = [],
  ) {
    this.ownedListeners = [...listenerDisposers]
  }

  invoke<T>(operation: (services: WorkItemIpcServices) => Promise<T> | T): Promise<T> {
    if (!this.accepting) return Promise.reject(new WorkItemWorkspaceUnavailableError())
    const result = Promise.resolve().then(() => operation(this.services))
    this.pending.add(result)
    void result.finally(() => this.pending.delete(result)).catch(() => undefined)
    return result
  }

  ownListeners(disposers: ReadonlyArray<() => void>): void {
    if (!this.accepting) {
      for (const dispose of disposers) dispose()
      return
    }
    this.ownedListeners.push(...disposers)
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.accepting = false
    for (const dispose of this.ownedListeners.splice(0)) {
      try { dispose() } catch { /* Continue releasing the rest of this workspace's listeners. */ }
    }
    this.disposal = Promise.allSettled([...this.pending]).then(() => undefined)
    return this.disposal
  }
}

export function createWorkItemIpcWorkspaceScope(
  services: WorkItemIpcServices,
  listenerDisposers: ReadonlyArray<() => void> = [],
): WorkItemIpcWorkspaceScope {
  return new WorkItemIpcWorkspaceScope(services, listenerDisposers)
}

/** Creates a Main-owned authorizer rooted at the canonical active workspace. */
export async function createWorkItemScopeAuthorizer(
  workspaceRoot: string,
): Promise<(scope: WorkScope) => Promise<WorkScope>> {
  const canonicalRoot = await realpath(workspaceRoot)
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new WorkItemScopeUnauthorizedError('Active workspace root must be a directory')
  }

  return async (scope) => {
    const materialRefs = scope.materialRefs?.map((ref) => ({ ...ref }))
    if (scope.cwd === undefined) return {
      ...scope,
      resourceRefs: [...scope.resourceRefs],
      ...(materialRefs === undefined ? {} : { materialRefs }),
    }
    const candidate = resolve(canonicalRoot, scope.cwd)
    const canonicalCwd = await canonicalizeWorkspacePath(canonicalRoot, candidate)
    return {
      ...scope,
      cwd: canonicalCwd,
      resourceRefs: [...scope.resourceRefs],
      ...(materialRefs === undefined ? {} : { materialRefs }),
    }
  }
}

export interface WorkItemMaterialAuthorizerOptions {
  /** Generated artifacts must still pass the existing Main integrity verifier. */
  verifyArtifact?: (artifact: WorkArtifact) => Promise<boolean>
}

/**
 * Creates the narrow Main resolver used by WorkItemExecutionService. This
 * resolves only explicit typed selections, records a content fingerprint, and
 * rejects material kinds whose backing store or network grant is not wired.
 * Legacy `scope.resourceRefs` are intentionally ignored.
 */
export async function createWorkItemMaterialAuthorizer(
  workspaceRoot: string,
  options: WorkItemMaterialAuthorizerOptions = {},
): Promise<WorkMaterialAuthorizer> {
  const canonicalRoot = await realpath(workspaceRoot)
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new WorkItemScopeUnauthorizedError('Active workspace root must be a directory')
  }

  return async ({ task, inputs }): Promise<WorkMaterialAuthorization[]> => {
    const refs = new Map((task.task.scope.materialRefs ?? []).map((ref) => [ref.materialId, ref]))
    const authorizedAt = new Date().toISOString()
    return Promise.all(inputs.map(async (input) => {
      const ref = refs.get(input.materialId)
      if (ref === undefined) throw materialUnauthorized(`Material ${input.materialId} is not declared by this work item`)
      const authorization = await authorizeMaterial(canonicalRoot, task, ref, options)
      if (input.expectedVersion !== undefined && input.expectedVersion !== authorization.version) {
        throw materialUnauthorized(`Material ${input.materialId} changed since it was selected`)
      }
      return { ...authorization, authorizedAt }
    }))
  }
}

async function authorizeMaterial(
  canonicalRoot: string,
  task: WorkTaskSnapshot,
  ref: WorkMaterialRef,
  options: WorkItemMaterialAuthorizerOptions,
): Promise<Omit<WorkMaterialAuthorization, 'authorizedAt'>> {
  if (ref.kind === 'local-file') {
    const base = task.task.scope.cwd ?? canonicalRoot
    const candidate = resolve(base, ref.path)
    const canonicalPath = await canonicalizeMaterialFile(canonicalRoot, candidate)
    const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const bytes = await handle.readFile()
      const fingerprint = createHash('sha256').update(bytes).digest('hex')
      return { materialId: ref.materialId, kind: ref.kind, version: fingerprint, fingerprint }
    } finally {
      await handle.close()
    }
  }
  if (ref.kind === 'generated-artifact') {
    const artifact = task.artifacts.find((candidate) =>
      candidate.id === ref.artifactId && candidate.contentVersion === ref.contentVersion)
    if (artifact === undefined) throw materialUnauthorized(`Generated artifact ${ref.artifactId} is not attached to this work item`)
    if (options.verifyArtifact === undefined || !await options.verifyArtifact(artifact)) {
      throw materialUnauthorized(`Generated artifact ${ref.artifactId} failed Main integrity verification`)
    }
    return { materialId: ref.materialId, kind: ref.kind, version: artifact.contentHash, fingerprint: artifact.contentHash }
  }
  if (ref.kind === 'project-document') {
    throw materialUnauthorized(`Project document ${ref.documentId} has no Main document resolver yet`)
  }
  throw materialUnauthorized(`External link ${ref.url} requires an explicit network grant before execution`)
}

async function canonicalizeMaterialFile(canonicalRoot: string, candidate: string): Promise<string> {
  let entry
  try {
    entry = await lstat(candidate)
  } catch {
    throw materialUnauthorized('Selected local material does not exist')
  }
  if (entry.isSymbolicLink()) throw materialUnauthorized('Selected local material must not be a symbolic link')
  const canonicalCandidate = await realpath(candidate)
  if (!isWithinWorkspace(canonicalRoot, canonicalCandidate)) {
    throw materialUnauthorized('Selected local material escapes the active workspace')
  }
  if (!(await stat(canonicalCandidate)).isFile()) throw materialUnauthorized('Selected local material must be a regular file')
  return canonicalCandidate
}

function materialUnauthorized(message: string): Error {
  return Object.assign(new Error(message), { code: 'WORK_ITEM_MATERIAL_UNAUTHORIZED' })
}

export interface WorkItemIpcWorkspaceInitializer<Restored> {
  restore(): Promise<Restored>
  construct(restored: Restored): WorkItemIpcServices
  attachListeners(
    services: WorkItemIpcServices,
    restored: Restored,
    scope: WorkItemIpcWorkspaceScope,
  ): ReadonlyArray<() => void>
}

/** Opens IPC admission only after durable state recovery and listener ownership are complete. */
export async function initializeWorkItemIpcWorkspace<Restored>(
  initializer: WorkItemIpcWorkspaceInitializer<Restored>,
): Promise<WorkItemIpcWorkspaceScope> {
  const restored = await initializer.restore()
  const services = initializer.construct(restored)
  const scope = createWorkItemIpcWorkspaceScope(services)
  const listeners = initializer.attachListeners(services, restored, scope)
  scope.ownListeners(listeners)
  return scope
}

interface IpcMainRegistrar {
  handle(channel: string, listener: (event: unknown, request?: unknown) => Promise<IpcResult<unknown>>): void
}

export function registerWorkItemIpc(
  ipcMain: IpcMainRegistrar,
  resolveScope: () => WorkItemIpcWorkspaceScope | undefined,
  isDeveloperMode: () => boolean = () => true,
): void {
  const register = (
    channel: typeof WORK_ITEM_IPC_CHANNELS[number],
    operation: (services: WorkItemIpcServices, request: unknown) => Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (_event, request): Promise<IpcResult<unknown>> => {
      try {
        const scope = resolveScope()
        if (scope === undefined) throw new WorkItemWorkspaceUnavailableError()
        return { ok: true, data: await scope.invoke((services) => operation(services, request)) }
      } catch (error) {
        return { ok: false, error: toEzDSHError(error, randomUUID()) }
      }
    })
  }

  register('work-items:list', (services, input) => services.workItems.list(validateWorkItemQuery(input)))
  register('work-items:attention', async (services): Promise<WorkbenchAttentionSnapshot> => {
    if (!isDeveloperMode()) throw new Error('Workbench attention is available only in developer mode')
    const snapshots = await services.workItems.list({ includeArchived: false })
    return deriveWorkbenchAttention(snapshots)
  })
  register('work-items:get', (services, input) => services.workItems.get(validateTaskId(input)))
  register('work-items:get-run-detail', (services, input) => {
    if (services.runDetails === undefined) throw new Error('Work item run details are unavailable')
    const request = validateWorkTaskRunDetailRequest(input)
    return services.runDetails.getRunDetail(request.taskId, request.runId)
  })
  register('work-items:project-context', (services, input) => {
    if (services.projectContext === undefined) throw new Error('Project context is unavailable')
    return services.projectContext.read(validateWorkItemProjectContextQuery(input))
  })
  register('work-items:create', async (services, input) => {
    const request = validateWorkTaskCreateRequest(input)
    const scope = services.authorizeScope === undefined
      ? request.scope
      : await services.authorizeScope(request.scope)
    return services.workItems.create({ ...request, scope })
  })
  register('work-items:execute', async (services, input) => {
    const request = validateWorkTaskExecuteRequest(input)
    if (services.authorizeScope !== undefined) {
      const snapshot = await services.workItems.get(request.taskId)
      if (snapshot === undefined) {
        throw Object.assign(new Error(`Work item task ${request.taskId} was not found`), { code: 'TASK_NOT_FOUND' })
      }
      const authorized = await services.authorizeScope(snapshot.task.scope)
      if (authorized.cwd !== snapshot.task.scope.cwd) {
        throw new WorkItemScopeUnauthorizedError('Stored work item cwd is not canonical for the active workspace')
      }
    }
    services.assertExecutionAvailable?.('execute', request)
    return services.execution.execute(request)
  })
  register('work-items:revise', (services, input) => services.workItems.revise(validateWorkTaskRevisionRequest(input)))
  register('work-items:cancel-task', (services, input) => services.cancellation.cancelTask(validateWorkTaskCancelRequest(input)))
  register('work-items:archive', (services, input) => services.workItems.archive(validateWorkTaskArchiveRequest(input)))
  register('work-items:accept-artifact', (services, input) => services.workItems.acceptArtifact(validateWorkArtifactAcceptRequest(input)))
  register('work-items:open-artifact', (services, input) => {
    const request = validateArtifactOpenRequest(input)
    return services.workItems.openArtifact(request.taskId, request.artifactId)
  })
  register('work-items:control-run', (services, input) => {
    const request = validateWorkRunControlRequest(input)
    services.assertExecutionAvailable?.('control-run', request)
    return services.actions.controlRun(request)
  })
  register('work-items:answer-action', (services, input) => {
    const request = validateWorkActionAnswerRequest(input)
    services.assertExecutionAvailable?.('answer-action', request)
    return services.actions.answerAction(request)
  })
}

async function canonicalizeWorkspacePath(canonicalRoot: string, candidate: string): Promise<string> {
  let existingAncestor = candidate
  for (;;) {
    try {
      await lstat(existingAncestor)
      break
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) throw new WorkItemScopeUnauthorizedError()
      existingAncestor = parent
    }
  }

  const canonicalAncestor = await realpath(existingAncestor)
  if (!(await stat(canonicalAncestor)).isDirectory()) {
    throw new WorkItemScopeUnauthorizedError('Work item cwd must be a directory or a path below one')
  }
  const canonicalCandidate = resolve(canonicalAncestor, relative(existingAncestor, candidate))
  if (!isWithinWorkspace(canonicalRoot, canonicalAncestor) || !isWithinWorkspace(canonicalRoot, canonicalCandidate)) {
    throw new WorkItemScopeUnauthorizedError()
  }
  return canonicalCandidate
}

function isWithinWorkspace(canonicalRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(canonicalRoot, candidate)
  return pathFromRoot === ''
    || (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function validateWorkItemQuery(value: unknown): WorkItemQuery {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkItemValidationError('INVALID_TYPE', '$', '$ must be an object')
  }
  const query = value as Record<string, unknown>
  for (const field of Object.keys(query)) {
    if (!['projectId', 'employeeId', 'workflowId', 'includeArchived'].includes(field)) {
      throw new WorkItemValidationError('UNKNOWN_FIELD', field, `${field} is not allowed`)
    }
  }
  return {
    ...(query.projectId === undefined ? {} : { projectId: validateIdentifier(query.projectId, 'projectId') }),
    ...(query.employeeId === undefined ? {} : { employeeId: validateIdentifier(query.employeeId, 'employeeId') }),
    ...(query.workflowId === undefined ? {} : { workflowId: validateIdentifier(query.workflowId, 'workflowId') }),
    ...(query.includeArchived === undefined ? {} : { includeArchived: validateBoolean(query.includeArchived, 'includeArchived') }),
  }
}

function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new WorkItemValidationError('INVALID_TYPE', path, `${path} must be a boolean`)
  }
  return value
}

function validateTaskId(value: unknown): string {
  return validateIdentifier(value, 'taskId')
}

function validateArtifactOpenRequest(value: unknown): { taskId: string; artifactId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkItemValidationError('INVALID_TYPE', '$', '$ must be an object')
  }
  const request = value as Record<string, unknown>
  for (const field of Object.keys(request)) {
    if (field !== 'taskId' && field !== 'artifactId') throw new WorkItemValidationError('UNKNOWN_FIELD', field, `${field} is not allowed`)
  }
  return {
    taskId: validateIdentifier(request.taskId, 'taskId'),
    artifactId: validateIdentifier(request.artifactId, 'artifactId'),
  }
}

function validateIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new WorkItemValidationError('INVALID_TYPE', path, `${path} must be a string`)
  const normalized = value.trim()
  if (normalized === '') throw new WorkItemValidationError('EMPTY_STRING', path, `${path} must not be blank`)
  if (normalized.length > WORK_ITEM_LIMITS.id) {
    throw new WorkItemValidationError('STRING_TOO_LONG', path, `${path} exceeds ${WORK_ITEM_LIMITS.id} characters`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new WorkItemValidationError('INVALID_VALUE', path, `${path} must not contain control characters`)
  }
  return normalized
}
