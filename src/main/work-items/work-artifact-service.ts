import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { WorkArtifact } from '../../shared/work-items.js'
import {
  WorkItemStore,
  WorkItemStoreConflictError,
  WorkItemStoreInputError,
  type WorkArtifactWriteIntent,
} from './work-item-store.js'

export interface WorkArtifactSource {
  requestId: string
  taskId: string
  attemptId: string
  runId: string
  requirementVersion: number
  contentVersion: number
  name: string
}

export interface WorkTextArtifactSource extends WorkArtifactSource {
  text: string
}

export interface WorkJsonArtifactSource extends WorkArtifactSource {
  value: unknown
}

export interface WorkFileArtifactSource extends WorkArtifactSource {
  sourcePath: string
}

export interface WorkArtifactServiceOptions {
  /** Main-owned authorization hook. It returns the path that is authorized for reading. */
  authorizeSourcePath?: (sourcePath: string) => Promise<string>
  /** Intended for an already selected workspace/test root; real paths must remain below it. */
  sourceRoot?: string
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertIdentifier(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new WorkItemStoreInputError(field, `${field} is invalid`)
  }
  return normalized
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkItemStoreInputError(field, `${field} must be a positive safe integer`)
  }
  return value
}

function assertName(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 255 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new WorkItemStoreInputError('name', 'name is invalid')
  }
  return normalized
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

function jsonBytes(value: unknown): Uint8Array {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value, null, 2)
  } catch {
    throw new WorkItemStoreInputError('value', 'value must be JSON serializable')
  }
  if (serialized === undefined) {
    throw new WorkItemStoreInputError('value', 'value must produce a JSON document')
  }
  return Buffer.from(`${serialized}\n`, 'utf8')
}

/**
 * Stores immutable artifact bytes outside executor logs. This class is Main-only:
 * callers cannot choose destination paths, and file sources need an explicit Main policy.
 */
export class WorkArtifactService {
  private initialized = false
  private artifactRootRealPath = ''
  private sourceRootRealPath: string | undefined
  private readonly requestTails = new Map<string, Promise<void>>()

  constructor(
    private readonly store: WorkItemStore,
    private readonly artifactRoot: string,
    private readonly options: WorkArtifactServiceOptions = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.initialize()
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 })
    this.artifactRootRealPath = await realpath(this.artifactRoot)
    if (this.options.sourceRoot !== undefined) {
      this.sourceRootRealPath = await realpath(this.options.sourceRoot)
    }
    this.initialized = true

    // A crash after file rename but before WorkItem metadata commit leaves a recorded
    // intent. Only an exact, verified task-owned file is linked during recovery.
    for (const receipt of await this.store.pendingArtifactWrites()) {
      const artifact = this.artifactFromIntent(receipt)
      if (await this.verifyStoredArtifact(artifact)) {
        await this.store.completeArtifactWrite(receipt.requestId, receipt.artifactId, (candidate) =>
          this.verifyStoredArtifact(candidate)
        )
      } else {
        await this.isolateInvalidDestination(receipt)
      }
    }
  }

  saveText(input: WorkTextArtifactSource): Promise<WorkArtifact> {
    return this.save(input, 'text', Buffer.from(input.text, 'utf8'))
  }

  saveJson(input: WorkJsonArtifactSource): Promise<WorkArtifact> {
    return this.save(input, 'json', jsonBytes(input.value))
  }

  async snapshotFile(input: WorkFileArtifactSource): Promise<WorkArtifact> {
    this.assertInitialized()
    const normalizedInput = { ...input, name: assertName(input.name) }
    const requestId = assertIdentifier(normalizedInput.requestId, 'requestId')
    const existing = await this.store.getArtifactWrite(requestId)
    if (existing !== undefined) {
      const replay = await this.store.beginArtifactWrite(this.intentFor(
        normalizedInput,
        'file',
        existing.contentHash,
        existing.artifactId,
        existing.storedPath,
        normalizedInput.sourcePath,
      ))
      const candidate = replay.artifact ?? this.artifactFromIntent(replay)
      if (await this.verifyStoredArtifact(candidate)) {
        if (replay.stage === 'linked' && replay.artifact !== undefined) return replay.artifact
        const completed = await this.store.completeArtifactWrite(replay.requestId, replay.artifactId, (artifact) =>
          this.verifyStoredArtifact(artifact)
        )
        return completed.artifact!
      }
    }
    const sourcePath = await this.authorizedSourcePath(normalizedInput.sourcePath)
    const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const sourceStat = await handle.stat()
      if (!sourceStat.isFile()) throw new WorkItemStoreInputError('sourcePath', 'sourcePath must be a regular file')
      return await this.save(normalizedInput, 'file', await handle.readFile(), normalizedInput.sourcePath)
    } finally {
      await handle.close()
    }
  }

  async read(artifact: WorkArtifact): Promise<Buffer> {
    this.assertInitialized()
    const bytes = await this.readVerifiedArtifact(artifact)
    if (bytes === undefined) {
      throw new WorkItemStoreConflictError(
        'ARTIFACT_CONFLICT',
        `Artifact ${artifact.id} stored content is missing or invalid`,
      )
    }
    return Buffer.from(bytes)
  }

  async verifyStoredArtifact(artifact: WorkArtifact): Promise<boolean> {
    this.assertInitialized()
    return (await this.readVerifiedArtifact(artifact)) !== undefined
  }

  private async save(
    raw: WorkArtifactSource,
    kind: WorkArtifact['kind'],
    bytes: Uint8Array,
    sourceRef?: string,
  ): Promise<WorkArtifact> {
    this.assertInitialized()
    const requestId = assertIdentifier(raw.requestId, 'requestId')
    return this.serializeRequest(requestId, async () => {
      const normalizedRaw = { ...raw, name: assertName(raw.name) }
      const existing = await this.store.getArtifactWrite(requestId)
      const artifactId = existing?.artifactId
        ?? createHash('sha256').update(`${assertIdentifier(normalizedRaw.taskId, 'taskId')}\u0000${requestId}`).digest('hex')
      const taskId = assertIdentifier(normalizedRaw.taskId, 'taskId')
      const storedPath = existing?.storedPath ?? this.destinationPath(taskId, artifactId, normalizedRaw.name)
      const intent = this.intentFor(normalizedRaw, kind, sha256(bytes), artifactId, storedPath, sourceRef)
      const receipt = await this.store.beginArtifactWrite(intent)
      if (receipt.stage === 'linked' && receipt.artifact !== undefined) {
        if (!await this.verifyStoredArtifact(receipt.artifact)) {
          throw new WorkItemStoreConflictError(
            'ARTIFACT_CONFLICT',
            `Artifact ${receipt.artifactId} stored content is missing or invalid`,
          )
        }
        return receipt.artifact
      }

      const candidate = this.artifactFromIntent(receipt)
      if (!await this.verifyStoredArtifact(candidate)) {
        await this.isolateInvalidDestination(receipt)
        await this.writeAtomically(receipt.storedPath, bytes)
      }
      const completed = await this.store.completeArtifactWrite(receipt.requestId, receipt.artifactId, (artifact) =>
        this.verifyStoredArtifact(artifact)
      )
      if (completed.artifact === undefined) throw new Error(`Artifact ${completed.artifactId} was not linked`)
      return completed.artifact
    })
  }

  private intentFor(
    raw: WorkArtifactSource,
    kind: WorkArtifact['kind'],
    contentHash: string,
    artifactId: string,
    storedPath: string,
    sourceRef?: string,
  ): WorkArtifactWriteIntent {
    return {
      requestId: assertIdentifier(raw.requestId, 'requestId'),
      artifactId,
      taskId: assertIdentifier(raw.taskId, 'taskId'),
      attemptId: assertIdentifier(raw.attemptId, 'attemptId'),
      runId: assertIdentifier(raw.runId, 'runId'),
      requirementVersion: assertPositiveInteger(raw.requirementVersion, 'requirementVersion'),
      contentVersion: assertPositiveInteger(raw.contentVersion, 'contentVersion'),
      contentHash,
      kind,
      name: assertName(raw.name),
      storedPath,
      ...(sourceRef === undefined ? {} : { sourceRef }),
    }
  }

  private artifactFromIntent(input: WorkArtifactWriteIntent): WorkArtifact {
    return {
      id: input.artifactId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      runId: input.runId,
      requirementVersion: input.requirementVersion,
      contentVersion: input.contentVersion,
      contentHash: input.contentHash,
      kind: input.kind,
      name: input.name,
      storedPath: input.storedPath,
      createdAt: '',
    }
  }

  private destinationPath(taskId: string, artifactId: string, name: string): string {
    const taskDirectory = createHash('sha256').update(taskId).digest('hex')
    const extension = extname(basename(name)).slice(0, 16)
    return resolve(this.artifactRootRealPath, taskDirectory, `${artifactId}${extension || '.data'}`)
  }

  private async writeAtomically(destination: string, bytes: Uint8Array): Promise<void> {
    if (!isWithin(this.artifactRootRealPath, destination)) {
      throw new WorkItemStoreInputError('storedPath', 'artifact destination escapes the artifact root')
    }
    const destinationDirectory = dirname(destination)
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
    if ((await lstat(destinationDirectory)).isSymbolicLink()) {
      throw new WorkItemStoreInputError('storedPath', 'artifact destination directory must not be a symbolic link')
    }
    const destinationDirectoryRealPath = await realpath(destinationDirectory)
    if (!isWithin(this.artifactRootRealPath, destinationDirectoryRealPath)) {
      throw new WorkItemStoreInputError('storedPath', 'artifact destination directory escapes the artifact root')
    }
    const temporaryPath = `${destination}.${randomUUID()}.tmp`
    try {
      if (this.options.writeFile) await this.options.writeFile(temporaryPath, bytes)
      else await writeFile(temporaryPath, bytes, { mode: 0o600, flag: 'wx' })
      if (this.options.rename) await this.options.rename(temporaryPath, destination)
      else await rename(temporaryPath, destination)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async readOwnedFile(storedPath: string): Promise<Buffer> {
    if ((await lstat(storedPath)).isSymbolicLink()) {
      throw new WorkItemStoreInputError('storedPath', 'artifact path must not be a symbolic link')
    }
    const storedDirectory = dirname(resolve(storedPath))
    if (await realpath(storedDirectory) !== storedDirectory) {
      throw new WorkItemStoreInputError('storedPath', 'artifact directory must not contain symbolic links')
    }
    const resolvedPath = await realpath(storedPath)
    if (!isWithin(this.artifactRootRealPath, resolvedPath)) {
      throw new WorkItemStoreInputError('storedPath', 'artifact path escapes the artifact root')
    }
    const handle = await open(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!(await handle.stat()).isFile()) {
        throw new WorkItemStoreInputError('storedPath', 'artifact path is not a regular file')
      }
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }

  private async isolateInvalidDestination(intent: WorkArtifactWriteIntent): Promise<void> {
    const expectedPath = this.destinationPath(intent.taskId, intent.artifactId, intent.name)
    if (resolve(intent.storedPath) !== expectedPath || !isWithin(this.artifactRootRealPath, expectedPath)) {
      throw new WorkItemStoreInputError('storedPath', 'pending artifact destination is not task-owned')
    }
    const destinationDirectory = dirname(expectedPath)
    try {
      if ((await lstat(destinationDirectory)).isSymbolicLink()) {
        throw new WorkItemStoreInputError('storedPath', 'artifact destination directory must not be a symbolic link')
      }
      if (await realpath(destinationDirectory) !== destinationDirectory) {
        throw new WorkItemStoreInputError('storedPath', 'artifact destination directory escapes its task-owned path')
      }
      await lstat(expectedPath)
      await rename(expectedPath, `${expectedPath}.invalid-${randomUUID()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async readVerifiedArtifact(artifact: WorkArtifact): Promise<Buffer | undefined> {
    try {
      if (resolve(artifact.storedPath) !== this.destinationPath(artifact.taskId, artifact.id, artifact.name)) {
        return undefined
      }
      const bytes = await this.readOwnedFile(artifact.storedPath)
      return sha256(bytes) === artifact.contentHash ? bytes : undefined
    } catch {
      return undefined
    }
  }

  private async authorizedSourcePath(sourcePath: string): Promise<string> {
    const candidate = this.options.authorizeSourcePath
      ? await this.options.authorizeSourcePath(sourcePath)
      : this.sourceRootRealPath === undefined
        ? undefined
        : resolve(this.sourceRootRealPath, sourcePath)
    if (candidate === undefined) {
      throw new WorkItemStoreInputError('sourcePath', 'file snapshot requires an explicit Main source path policy')
    }
    const candidateRealPath = await realpath(candidate)
    if (this.sourceRootRealPath !== undefined && !isWithin(this.sourceRootRealPath, candidateRealPath)) {
      throw new WorkItemStoreInputError('sourcePath', 'sourcePath escapes the authorized source root')
    }
    return candidateRealPath
  }

  private async serializeRequest<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.requestTails.get(requestId) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
    const tail = previous.then(() => current)
    this.requestTails.set(requestId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (this.requestTails.get(requestId) === tail) this.requestTails.delete(requestId)
    }
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkArtifactService must be initialized before use')
  }
}
