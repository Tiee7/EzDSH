import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WorkbenchImportError,
  previewWorkbenchImport,
  previewWorkbenchImportApplication,
  type WorkbenchImportReceipt,
} from '../../src/main/work-items/workbench-import'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'ezdsh-workbench-import-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function createWorkbenchFixture(): Promise<string> {
  const root = await temporaryDirectory()
  const data = join(root, 'data')
  const works = join(root, 'works')
  await mkdir(join(data, 'ai-proposals'), { recursive: true })
  await mkdir(join(works, 'reports'), { recursive: true })
  await writeJson(join(data, 'projects.json'), [
    { id: 'project-1', name: 'Alpha', description: 'Project context', status: 'active', dshProjectId: 'opaque-project' },
  ])
  await writeJson(join(data, 'tasks.json'), [
    {
      id: 'task-1', projectId: 'project-1', title: 'Same title', description: 'Prepare a report',
      acceptanceCriteria: 'Includes sources', status: 'done',
      execution: { status: 'completed', runId: 'run-task', sessionId: 'session-task', result: { saved: true } },
    },
    { id: 'task-2', projectId: 'project-1', title: 'Same title', description: 'A different task', status: 'todo' },
  ])
  await writeJson(join(data, 'ideas.json'), [
    { id: 'idea-1', title: 'Reusable template', content: 'Keep this as an idea', status: 'new' },
  ])
  await writeJson(join(data, 'workspace.json'), {
    generatedAt: '2026-09-10T00:00:00.000Z', projects: [], tasks: [], ideas: [],
  })
  await writeJson(join(data, 'dsh-queue.json'), {
    version: 1,
    items: [{
      id: 'queue-1', subjectType: 'task', subjectId: 'task-1', status: 'completed',
      runId: 'run-queue', sessionId: 'session-queue', runResult: 'done', prompt: 'must not appear in preview',
    }],
  })
  await writeJson(join(data, 'document-config.json'), { rootDir: works })
  await writeFile(join(works, 'reports', 'report.md'), '# Report\n')
  await writeJson(join(data, 'ai-proposals', 'proposal-1.json'), {
    id: 'proposal-1', status: 'applied', target: { entityType: 'task', entityId: 'task-1' },
    run: { runId: 'run-proposal', sessionId: 'session-proposal' },
    history: [{ status: 'failed', run: { runId: 'old-run' }, result: { error: true } }],
    result: { streamText: 'must not appear in preview' },
    appliedDocument: { path: 'reports/report.md' },
  })
  await writeFile(join(data, 'operations.jsonl'), [
    JSON.stringify({ id: 'operation-1', status: 'pending', changes: ['c1'], createdAt: '2026-08-19T00:00:00.000Z' }),
    JSON.stringify({ id: 'operation-1', status: 'complete', completedAt: '2026-08-19T00:00:01.000Z' }),
    '',
  ].join('\n'))
  return root
}

describe('previewWorkbenchImport', () => {
  it('maps real Workbench entity, run, proposal, operation, and document shapes without changing the source', async () => {
    const root = await createWorkbenchFixture()
    const before = await treeHash(root)

    const first = await previewWorkbenchImport(root)
    const second = await previewWorkbenchImport(root)

    expect(await treeHash(root)).toBe(before)
    expect(second).toEqual(first)
    expect(first.summary).toEqual({
      projects: 1, tasks: 2, ideas: 1, histories: 4, operations: 2, files: 1, conflicts: 0,
    })
    const completed = first.candidates.find((candidate) => candidate.sourceKey === 'task:task-1')!
    expect(completed).toMatchObject({
      kind: 'task', title: 'Same title', goal: 'Prepare a report', acceptance: 'Includes sources',
      originalStatus: 'done', proposedStatus: 'review',
      acceptanceEvidence: ['legacy-criteria', 'legacy-done-status'], humanAccepted: false,
      fileReferences: ['reports/report.md'],
    })
    expect(completed.history.map((entry) => entry.kind)).toEqual([
      'task-execution', 'queue-run', 'proposal-run', 'proposal-history',
    ])
    expect(first.files[0]).toMatchObject({
      relativePath: 'reports/report.md', status: 'available', linkedSourceKeys: ['task:task-1'],
    })
    expect(first.operations).toHaveLength(2)
    expect(JSON.stringify(first)).not.toContain('must not appear in preview')
  })

  it('uses stable source identity and per-item receipts for duplicate and interrupted import previews', async () => {
    const root = await createWorkbenchFixture()
    const preview = await previewWorkbenchImport(root)

    const copiedRoot = await temporaryDirectory('ezdsh-workbench-copy-')
    await cp(root, copiedRoot, { recursive: true })
    await writeJson(join(copiedRoot, 'data', 'document-config.json'), { rootDir: join(copiedRoot, 'works') })
    const copied = await previewWorkbenchImport(copiedRoot)
    expect(copied.sourceId).not.toBe(preview.sourceId)
    expect(copied.sourceHash).toBe(preview.sourceHash)
    expect(copied.candidates.find((item) => item.sourceKey === 'task:task-1')?.targetId)
      .not.toBe(preview.candidates.find((item) => item.sourceKey === 'task:task-1')?.targetId)

    const initial = previewWorkbenchImportApplication(preview)
    expect(initial.createdCount).toBe(3)
    expect(initial.duplicateCount).toBe(0)

    const partialReceipt: WorkbenchImportReceipt[] = [initial.items[0]!]
    const resumed = previewWorkbenchImportApplication(preview, partialReceipt)
    expect(resumed.createdCount).toBe(2)
    expect(resumed.duplicateCount).toBe(1)

    const completed = previewWorkbenchImportApplication(preview, initial.items)
    expect(completed.createdCount).toBe(0)
    expect(completed.duplicateCount).toBe(3)
    expect(new Set(preview.candidates.filter((item) => item.title === 'Same title').map((item) => item.targetId)).size).toBe(2)

    const tasksPath = join(root, 'data', 'tasks.json')
    const tasks = JSON.parse(await readFile(tasksPath, 'utf8')) as Array<Record<string, unknown>>
    tasks[0]!.description = 'Changed source content'
    await writeJson(tasksPath, tasks)
    const changed = await previewWorkbenchImport(root)
    expect(changed.sourceId).toBe(preview.sourceId)
    expect(changed.sourceHash).not.toBe(preview.sourceHash)
    const conflict = previewWorkbenchImportApplication(changed, initial.items)
    expect(conflict.conflictCount).toBe(1)
    expect(conflict.items[0]?.action).toBe('conflict')

    const stableTarget = preview.candidates.find((candidate) => candidate.sourceKey === 'task:task-1')?.targetId
    tasks.push({ id: 'task-3', projectId: 'project-1', title: 'Added later', description: 'Another task', status: 'todo' })
    await writeJson(tasksPath, tasks)
    const expanded = await previewWorkbenchImport(root)
    expect(expanded.candidates.find((candidate) => candidate.sourceKey === 'task:task-1')?.targetId).toBe(stableTarget)

    await writeJson(join(root, 'data', 'workspace.json'), { generatedAt: '2099-01-01T00:00:00.000Z', projects: [], tasks: [], ideas: [] })
    const cacheChanged = await previewWorkbenchImport(root)
    expect(cacheChanged.sourceHash).toBe(expanded.sourceHash)
  })

  it('normalizes the root and data directory aliases to one receipt namespace', async () => {
    const root = await createWorkbenchFixture()
    const fromRoot = await previewWorkbenchImport(root)
    const fromData = await previewWorkbenchImport(join(root, 'data'))
    expect(fromData.sourceDirectory).toBe(fromRoot.sourceDirectory)
    expect(fromData.sourceId).toBe(fromRoot.sourceId)
    expect(fromData.candidates.find((item) => item.sourceKey === 'task:task-1')?.targetId)
      .toBe(fromRoot.candidates.find((item) => item.sourceKey === 'task:task-1')?.targetId)
    const application = previewWorkbenchImportApplication(fromData, previewWorkbenchImportApplication(fromRoot).items)
    expect(application.duplicateCount).toBe(fromData.candidates.length)
    expect(application.createdCount).toBe(0)
  })

  it('keeps ideas independent and never upgrades legacy done to accepted completion', async () => {
    const root = await createWorkbenchFixture()
    const preview = await previewWorkbenchImport(root)

    expect(preview.candidates.find((candidate) => candidate.kind === 'idea')).toMatchObject({
      sourceKey: 'idea:idea-1', goal: 'Keep this as an idea', proposedStatus: 'open', humanAccepted: false,
    })
    expect(preview.candidates.find((candidate) => candidate.legacyId === 'task-1')).not.toHaveProperty('acceptedArtifactIds')
  })

  it('reports missing relationships and file references, and does not follow traversal paths', async () => {
    const root = await temporaryDirectory()
    const data = join(root, 'data')
    const works = join(root, 'works')
    await mkdir(join(data, 'ai-proposals'), { recursive: true })
    await mkdir(works)
    await writeJson(join(data, 'projects.json'), [])
    await writeJson(join(data, 'tasks.json'), [
      { id: 'task-1', projectId: 'missing-project', title: 'Task', status: 'todo' },
    ])
    await writeJson(join(data, 'ideas.json'), [])
    await writeJson(join(data, 'document-config.json'), { rootDir: works })
    await writeJson(join(data, 'ai-proposals', 'missing.json'), {
      target: { entityType: 'task', entityId: 'task-1' }, appliedDocument: { path: 'missing.md' },
    })
    await writeJson(join(data, 'ai-proposals', 'traversal.json'), {
      target: { entityType: 'task', entityId: 'task-1' }, appliedDocument: { path: '../outside.md' },
    })
    await writeFile(join(root, 'outside.md'), 'outside')

    const preview = await previewWorkbenchImport(root)

    expect(preview.conflicts.map((conflict) => conflict.code)).toEqual(expect.arrayContaining([
      'MISSING_PROJECT', 'MISSING_FILE_REFERENCE', 'UNSAFE_FILE_REFERENCE',
    ]))
    expect(preview.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'missing.md', status: 'missing', linkedSourceKeys: ['task:task-1'] }),
      expect.objectContaining({ relativePath: '../outside.md', status: 'unsafe', linkedSourceKeys: ['task:task-1'] }),
    ]))
    expect(preview.candidates[0]?.fileReferences).toEqual(['missing.md'])
    const application = previewWorkbenchImportApplication(preview)
    expect(application.items.find((item) => item.sourceKey === 'task:task-1')).toMatchObject({ action: 'conflict' })
    expect(application.createdCount).toBe(0)
  })

  it('fails closed for an external document root and symbolic-link sources', async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory('ezdsh-workbench-outside-')
    const data = join(root, 'data')
    await mkdir(data)
    await writeJson(join(data, 'projects.json'), [])
    await writeJson(join(data, 'tasks.json'), [])
    await writeJson(join(data, 'ideas.json'), [])
    await writeJson(join(data, 'document-config.json'), { rootDir: outside })

    const preview = await previewWorkbenchImport(root)
    expect(preview.conflicts).toContainEqual(expect.objectContaining({ code: 'UNSAFE_FILE_REFERENCE' }))

    const linkedRoot = join(await temporaryDirectory(), 'linked-workbench')
    await symlink(root, linkedRoot)
    await expect(previewWorkbenchImport(linkedRoot)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })

    const unsafeDataRoot = await temporaryDirectory()
    await symlink(data, join(unsafeDataRoot, 'data'))
    await expect(previewWorkbenchImport(unsafeDataRoot)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('accepts an empty source but rejects corrupt and unknown formats', async () => {
    const empty = await temporaryDirectory()
    const preview = await previewWorkbenchImport(empty)
    expect(preview.summary).toEqual({
      projects: 0, tasks: 0, ideas: 0, histories: 0, operations: 0, files: 0, conflicts: 0,
    })

    const corrupt = await temporaryDirectory()
    await mkdir(join(corrupt, 'data'))
    await writeFile(join(corrupt, 'data', 'tasks.json'), '{not json')
    await expect(previewWorkbenchImport(corrupt)).rejects.toBeInstanceOf(WorkbenchImportError)
    await expect(previewWorkbenchImport(corrupt)).rejects.toMatchObject({ code: 'CORRUPT_SOURCE' })

    const unknown = await temporaryDirectory()
    await writeJson(join(unknown, 'random.json'), { hello: 'world' })
    await expect(previewWorkbenchImport(unknown)).rejects.toMatchObject({ code: 'UNKNOWN_FORMAT' })
  })

  it('marks every entity from a workspace fallback as conflicted and hashes fallback content', async () => {
    const root = await temporaryDirectory()
    const data = join(root, 'data')
    await mkdir(data)
    await writeJson(join(data, 'workspace.json'), {
      generatedAt: '2026-09-15T00:00:00.000Z',
      projects: [],
      tasks: [{ id: 'task-fallback', title: 'Fallback', description: 'A', status: 'todo' }],
      ideas: [],
    })
    const first = await previewWorkbenchImport(root)
    const item = previewWorkbenchImportApplication(first).items[0]
    expect(item).toMatchObject({ action: 'conflict', reason: expect.stringContaining('unresolved') })
    await writeJson(join(data, 'workspace.json'), {
      generatedAt: '2099-01-01T00:00:00.000Z',
      projects: [],
      tasks: [{ id: 'task-fallback', title: 'Fallback', description: 'B', status: 'todo' }],
      ideas: [],
    })
    const changed = await previewWorkbenchImport(root)
    expect(changed.sourceHash).not.toBe(first.sourceHash)

    const copiedContainer = await temporaryDirectory('ezdsh-workbench-fallback-copy-')
    const copiedRoot = join(copiedContainer, 'nested', 'workbench')
    await mkdir(dirname(copiedRoot), { recursive: true })
    await cp(root, copiedRoot, { recursive: true })
    const copied = await previewWorkbenchImport(copiedRoot)
    expect(copied.sourceHash).toBe(changed.sourceHash)
    expect(copied.candidates[0]?.targetId).not.toBe(changed.candidates[0]?.targetId)
  })

  it('rejects malformed queue and operation history instead of inventing historical runs', async () => {
    const root = await temporaryDirectory()
    const data = join(root, 'data')
    await mkdir(data)
    await writeJson(join(data, 'projects.json'), [])
    await writeJson(join(data, 'tasks.json'), [])
    await writeJson(join(data, 'ideas.json'), [])
    await writeJson(join(data, 'dsh-queue.json'), { items: {} })
    await expect(previewWorkbenchImport(root)).rejects.toMatchObject({ code: 'CORRUPT_SOURCE' })

    await writeJson(join(data, 'dsh-queue.json'), { items: [] })
    await writeFile(join(data, 'operations.jsonl'), '{bad json}\n')
    await expect(previewWorkbenchImport(root)).rejects.toMatchObject({ code: 'CORRUPT_SOURCE' })
  })
})

async function treeHash(root: string): Promise<string> {
  const files: Array<{ path: string; hash: string }> = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.shift()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        const details = await lstat(path)
        const bytes = await readFile(path)
        files.push({
          path: relative(root, path),
          hash: createHash('sha256').update(bytes).update(String(details.mode & 0o777)).digest('hex'),
        })
      }
    }
  }
  return createHash('sha256').update(JSON.stringify(files.sort((left, right) => left.path.localeCompare(right.path)))).digest('hex')
}
