import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkArtifactService } from '../../src/main/work-items/work-artifact-service'
import { WorkItemStore, WorkItemStoreInputError } from '../../src/main/work-items/work-item-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(options?: ConstructorParameters<typeof WorkArtifactService>[2]) {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-artifacts-'))
  directories.push(directory)
  const stateDirectory = join(directory, 'state')
  const artifactDirectory = join(directory, 'artifacts')
  const store = new WorkItemStore(stateDirectory)
  await store.initialize()
  const task = await store.create({
    requestId: 'create', title: 'Report', goal: 'Write it', acceptance: 'Reviewed', scope: { resourceRefs: [] },
  })
  const dispatch = await store.recordDispatchIntent({
    requestId: 'dispatch', taskId: task.task.id, expectedRevision: 1,
    executor: { kind: 'employee', employeeId: 'writer' }, mode: 'initial', input: {},
  })
  const linked = await store.linkDispatch('dispatch', dispatch.commandId, {
    runId: 'run-1', status: 'completed', rawStatus: 'completed',
    capabilities: { cancel: false, resume: false, append: false },
  })
  const service = new WorkArtifactService(store, artifactDirectory, options)
  await service.initialize()
  return { directory, stateDirectory, artifactDirectory, store, service, snapshot: linked.snapshot }
}

function source(snapshot: Awaited<ReturnType<typeof setup>>['snapshot']) {
  return {
    requestId: 'artifact-text', taskId: snapshot.task.id,
    attemptId: snapshot.attempts[0]!.id, runId: 'run-1', requirementVersion: 1,
    contentVersion: 1, name: 'report.md',
  }
}

describe('WorkArtifactService', () => {
  it('stores immutable text and JSON bytes with SHA-256 metadata and survives restart', async () => {
    const fixture = await setup()
    const text = '# exact report\n'
    const artifact = await fixture.service.saveText({ ...source(fixture.snapshot), text })
    const json = await fixture.service.saveJson({
      ...source(fixture.snapshot), requestId: 'artifact-json', contentVersion: 2,
      name: 'report.json', value: { verified: true },
    })

    expect(artifact.contentHash).toBe(createHash('sha256').update(text).digest('hex'))
    expect(await fixture.service.read(artifact)).toEqual(Buffer.from(text))
    expect(await fixture.service.read(json)).toEqual(Buffer.from('{\n  "verified": true\n}\n'))
    expect((await fixture.store.get(fixture.snapshot.task.id))?.artifacts).toHaveLength(2)

    const reopenedStore = new WorkItemStore(fixture.stateDirectory)
    const reopened = new WorkArtifactService(reopenedStore, fixture.artifactDirectory)
    await reopened.initialize()
    const persisted = (await reopenedStore.get(fixture.snapshot.task.id))!.artifacts[0]!
    expect(await reopened.read(persisted)).toEqual(Buffer.from(text))
    await expect(reopened.saveText({ ...source(fixture.snapshot), text })).resolves.toEqual(persisted)

    const normalized = await reopened.saveText({
      ...source(fixture.snapshot), requestId: 'trimmed-name', contentVersion: 3,
      name: ' report.md ', text: 'normalized name',
    })
    expect(normalized.name).toBe('report.md')
    expect(normalized.storedPath.endsWith('.md')).toBe(true)
    expect(await reopened.read(normalized)).toEqual(Buffer.from('normalized name'))
  })

  it('snapshots only a Main-authorized regular file and rejects root and symlink escapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-source-policy-'))
    directories.push(directory)
    const sourceRoot = join(directory, 'selected')
    await mkdir(sourceRoot)
    await writeFile(join(sourceRoot, 'inside.txt'), 'inside')
    await writeFile(join(directory, 'outside.txt'), 'outside')
    await symlink(join(directory, 'outside.txt'), join(sourceRoot, 'escape.txt'))
    const fixture = await setup({ sourceRoot })

    const artifact = await fixture.service.snapshotFile({
      ...source(fixture.snapshot), requestId: 'file', name: 'inside.txt', sourcePath: 'inside.txt',
    })
    expect(await fixture.service.read(artifact)).toEqual(Buffer.from('inside'))
    await rm(join(sourceRoot, 'inside.txt'))
    await expect(fixture.service.snapshotFile({
      ...source(fixture.snapshot), requestId: 'file', name: 'inside.txt', sourcePath: 'inside.txt',
    })).resolves.toEqual(artifact)
    await expect(fixture.service.snapshotFile({
      ...source(fixture.snapshot), requestId: 'escape', name: 'escape.txt', sourcePath: 'escape.txt',
    })).rejects.toBeInstanceOf(WorkItemStoreInputError)
    await expect(fixture.service.snapshotFile({
      ...source(fixture.snapshot), requestId: 'traversal', name: 'outside.txt', sourcePath: '../outside.txt',
    })).rejects.toBeInstanceOf(WorkItemStoreInputError)

    const noPolicy = await setup()
    await expect(noPolicy.service.snapshotFile({
      ...source(noPolicy.snapshot), requestId: 'no-policy', name: 'inside.txt', sourcePath: join(sourceRoot, 'inside.txt'),
    })).rejects.toMatchObject({ path: 'sourcePath' })
  })

  it('does not register an artifact when the atomic file write fails', async () => {
    const fixture = await setup({
      writeFile: async () => { throw new Error('simulated copy failure') },
    })
    await expect(fixture.service.saveText({ ...source(fixture.snapshot), text: 'never delivered' }))
      .rejects.toThrow('simulated copy failure')
    expect((await fixture.store.get(fixture.snapshot.task.id))?.artifacts).toEqual([])
    expect(await fixture.store.pendingArtifactWrites()).toHaveLength(1)
  })

  it('durably reserves each run content version across competing requests and restart', async () => {
    let writes = 0
    const fixture = await setup({
      writeFile: async (path, bytes) => {
        writes += 1
        if (writes === 1) throw new Error('first copy failed')
        await writeFile(path, bytes)
      },
    })
    await expect(fixture.service.saveText({ ...source(fixture.snapshot), requestId: 'version-a', text: 'A' }))
      .rejects.toThrow('first copy failed')
    await expect(fixture.service.saveText({ ...source(fixture.snapshot), requestId: 'version-b', text: 'B' }))
      .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })

    const reopenedStore = new WorkItemStore(fixture.stateDirectory)
    const reopened = new WorkArtifactService(reopenedStore, fixture.artifactDirectory)
    await reopened.initialize()
    const artifact = await reopened.saveText({ ...source(fixture.snapshot), requestId: 'version-a', text: 'A' })
    expect(artifact.contentVersion).toBe(1)
    expect((await reopenedStore.get(fixture.snapshot.task.id))!.artifacts).toEqual([artifact])
    expect(await reopenedStore.pendingArtifactWrites()).toEqual([])
  })

  it('allows only one different request to reserve a run content version concurrently', async () => {
    const fixture = await setup()
    const results = await Promise.allSettled([
      fixture.service.saveText({ ...source(fixture.snapshot), requestId: 'racer-a', text: 'A' }),
      fixture.service.saveText({ ...source(fixture.snapshot), requestId: 'racer-b', text: 'B' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await fixture.store.get(fixture.snapshot.task.id))!.artifacts).toHaveLength(1)
  })

  it('fails closed when reopening pre-fix linked receipts that share a run content version', async () => {
    const fixture = await setup()
    const first = await fixture.service.saveText({
      ...source(fixture.snapshot), requestId: 'legacy-a', contentVersion: 1, text: 'A',
    })
    const second = await fixture.service.saveText({
      ...source(fixture.snapshot), requestId: 'legacy-b', contentVersion: 2, text: 'B',
    })
    const statePath = join(fixture.stateDirectory, 'work-items.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      tasks: Record<string, { task: { revision: number }; artifacts: Array<{ id: string; contentVersion: number }> }>
      requests: Record<string, { receipt: {
        requestId: string
        artifactId: string
        taskId: string
        attemptId: string
        runId: string
        requirementVersion: number
        contentVersion: number
        contentHash: string
        kind: 'text' | 'json' | 'file'
        name: string
        storedPath: string
        sourceRef?: string
        artifact: { contentVersion: number }
      } }>
    }
    const conflictingReceipt = state.requests['legacy-b']!.receipt
    conflictingReceipt.contentVersion = 1
    conflictingReceipt.artifact.contentVersion = 1
    state.tasks[fixture.snapshot.task.id]!.artifacts.find((artifact) => artifact.id === second.id)!.contentVersion = 1
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const reopened = new WorkItemStore(fixture.stateDirectory)
    await expect(reopened.initialize()).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    const replayInput = {
      requestId: conflictingReceipt.requestId,
      artifactId: conflictingReceipt.artifactId,
      taskId: conflictingReceipt.taskId,
      attemptId: conflictingReceipt.attemptId,
      runId: conflictingReceipt.runId,
      requirementVersion: conflictingReceipt.requirementVersion,
      contentVersion: conflictingReceipt.contentVersion,
      contentHash: conflictingReceipt.contentHash,
      kind: conflictingReceipt.kind,
      name: conflictingReceipt.name,
      storedPath: conflictingReceipt.storedPath,
      ...(conflictingReceipt.sourceRef === undefined ? {} : { sourceRef: conflictingReceipt.sourceRef }),
    }
    await expect(reopened.beginArtifactWrite(replayInput)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(reopened.completeArtifactWrite('legacy-b', second.id, async () => true))
      .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(reopened.acceptArtifact({
      requestId: 'accept-conflict', taskId: fixture.snapshot.task.id,
      expectedRevision: state.tasks[fixture.snapshot.task.id]!.task.revision,
      artifactId: first.id, contentVersion: 1, requirementVersion: 1,
    }, async () => true)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(reopened.acceptArtifact({
      requestId: 'accept-other-conflict', taskId: fixture.snapshot.task.id,
      expectedRevision: state.tasks[fixture.snapshot.task.id]!.task.revision,
      artifactId: second.id, contentVersion: 1, requirementVersion: 1,
    }, async () => true)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(reopened.get(fixture.snapshot.task.id)).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
  })

  it('isolates an invalid exact destination even when the replacement write fails', async () => {
    const fixture = await setup({
      writeFile: async () => { throw new Error('replacement write failed') },
    })
    for (const [index, invalidKind] of ['file', 'directory'].entries()) {
      const request = {
        ...source(fixture.snapshot), requestId: `poison-${invalidKind}`,
        contentVersion: index + 1, text: `content-${index}`,
      }
      await expect(fixture.service.saveText(request)).rejects.toThrow('replacement write failed')
      const receipt = (await fixture.store.getArtifactWrite(request.requestId))!
      if (invalidKind === 'file') await writeFile(receipt.storedPath, 'wrong bytes')
      else await mkdir(receipt.storedPath)

      await expect(fixture.service.saveText(request)).rejects.toThrow('replacement write failed')
      await expect(access(receipt.storedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(dirname(receipt.storedPath))).some((name) =>
        name.startsWith(`${receipt.artifactId}.md.invalid-`)
      )).toBe(true)
    }
    expect((await fixture.store.get(fixture.snapshot.task.id))!.artifacts).toEqual([])
    expect(await fixture.store.pendingArtifactWrites()).toHaveLength(2)

    const reopenedStore = new WorkItemStore(fixture.stateDirectory)
    const reopened = new WorkArtifactService(reopenedStore, fixture.artifactDirectory, {
      writeFile: async () => { throw new Error('still unavailable') },
    })
    await reopened.initialize()
    expect((await reopenedStore.get(fixture.snapshot.task.id))!.artifacts).toEqual([])
    expect(await reopenedStore.pendingArtifactWrites()).toHaveLength(2)
  })

  it('reconciles an exact file left after rename when metadata commit failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-artifact-recovery-'))
    directories.push(directory)
    const stateDirectory = join(directory, 'state')
    let replacements = 0
    const store = new WorkItemStore(stateDirectory, {
      rename: async (from, to) => {
        replacements += 1
        if (replacements === 5) throw new Error('metadata commit interrupted')
        await rename(from, to)
      },
    })
    await store.initialize()
    const created = await store.create({
      requestId: 'create', title: 'Report', goal: 'Write it', acceptance: 'Reviewed', scope: { resourceRefs: [] },
    })
    const dispatch = await store.recordDispatchIntent({
      requestId: 'dispatch', taskId: created.task.id, expectedRevision: 1,
      executor: { kind: 'employee', employeeId: 'writer' }, mode: 'initial', input: {},
    })
    const linked = await store.linkDispatch('dispatch', dispatch.commandId, {
      runId: 'run-1', status: 'completed', rawStatus: 'completed',
      capabilities: { cancel: false, resume: false, append: false },
    })
    const artifactDirectory = join(directory, 'artifacts')
    const first = new WorkArtifactService(store, artifactDirectory)
    await first.initialize()
    await expect(first.saveText({ ...source(linked.snapshot), text: 'recover me' }))
      .rejects.toThrow('metadata commit interrupted')

    const reopenedStore = new WorkItemStore(stateDirectory)
    const reopened = new WorkArtifactService(reopenedStore, artifactDirectory)
    await reopened.initialize()
    const artifacts = (await reopenedStore.get(created.task.id))!.artifacts
    expect(artifacts).toHaveLength(1)
    expect(await reopened.read(artifacts[0]!)).toEqual(Buffer.from('recover me'))
  })
})
