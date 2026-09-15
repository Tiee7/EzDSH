import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkArtifactService } from '../../src/main/work-items/work-artifact-service'
import { WorkItemService } from '../../src/main/work-items/work-item-service'
import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-revisions-'))
  directories.push(directory)
  const store = new WorkItemStore(join(directory, 'state'))
  const setupService = new WorkItemService(store)
  await setupService.initialize()
  const created = await setupService.create({
    requestId: 'create', title: 'Report', goal: 'First goal', acceptance: 'First checks', scope: { resourceRefs: [] },
  })
  const dispatch = await setupService.recordDispatchIntent({
    requestId: 'dispatch', taskId: created.task.id, expectedRevision: 1,
    executor: { kind: 'employee', employeeId: 'writer' }, mode: 'initial', input: {},
  })
  const linked = await setupService.linkDispatch('dispatch', dispatch.commandId, {
    runId: 'run-old', status: 'completed', rawStatus: 'completed',
    capabilities: { cancel: false, resume: false, append: false },
  })
  const artifacts = new WorkArtifactService(store, join(directory, 'artifacts'))
  await artifacts.initialize()
  const service = new WorkItemService(store, (artifact) => artifacts.verifyStoredArtifact(artifact))
  return { directory, store, service, artifacts, snapshot: linked.snapshot }
}

async function saveArtifact(fixture: Awaited<ReturnType<typeof setup>>, overrides = {}) {
  return fixture.artifacts.saveText({
    requestId: 'artifact-old', taskId: fixture.snapshot.task.id,
    attemptId: fixture.snapshot.attempts[0]!.id, runId: 'run-old', requirementVersion: 1,
    contentVersion: 1, name: 'report.md', text: 'accepted text', ...overrides,
  })
}

describe('WorkItem requirement revision and artifact acceptance', () => {
  it('keeps immutable requirement history and replays a revision request', async () => {
    const fixture = await setup()
    const request = {
      requestId: 'revise-1', taskId: fixture.snapshot.task.id,
      expectedRevision: fixture.snapshot.task.revision, goal: 'Second goal', acceptance: 'Second checks',
    }
    const revised = await fixture.service.revise(request)
    const replay = await fixture.service.revise(request)

    expect(revised.task).toMatchObject({ revision: 3, currentRequirementVersion: 2, status: 'open' })
    expect(revised.task.activeAttemptId).toBeUndefined()
    expect(revised.task.requirements).toMatchObject([
      { version: 1, goal: 'First goal' }, { version: 2, goal: 'Second goal' },
    ])
    expect(revised.runs).toEqual(fixture.snapshot.runs)
    expect(replay).toEqual(revised)
    await expect(fixture.service.revise({ ...request, goal: 'Conflicting goal' }))
      .rejects.toBeInstanceOf(WorkItemStoreConflictError)
  })

  it('accepts an exact current artifact once across concurrent callers and completes only on acceptance', async () => {
    const fixture = await setup()
    expect(fixture.snapshot.task.status).toBe('active')
    const artifact = await saveArtifact(fixture)
    const beforeAcceptance = (await fixture.service.get(fixture.snapshot.task.id))!
    expect(beforeAcceptance.task.status).toBe('active')
    const request = {
      requestId: 'accept-1', taskId: fixture.snapshot.task.id,
      expectedRevision: beforeAcceptance.task.revision, artifactId: artifact.id,
      contentVersion: artifact.contentVersion, requirementVersion: artifact.requirementVersion,
    }

    const [first, second] = await Promise.all([
      fixture.service.acceptArtifact(request), fixture.service.acceptArtifact({ ...request }),
    ])
    expect(first).toEqual(second)
    expect(first.task.status).toBe('completed')
    expect(first.task.acceptedArtifactIds).toEqual([artifact.id])

    const reopenedStore = new WorkItemStore(join(fixture.directory, 'state'))
    const reopenedArtifacts = new WorkArtifactService(reopenedStore, join(fixture.directory, 'artifacts'))
    await reopenedArtifacts.initialize()
    const reopenedService = new WorkItemService(
      reopenedStore,
      (candidate) => reopenedArtifacts.verifyStoredArtifact(candidate),
    )
    await expect(reopenedService.acceptArtifact(request)).resolves.toEqual(first)

    const anotherReceipt = await fixture.service.acceptArtifact({
      ...request, requestId: 'accept-from-other-page', expectedRevision: first.task.revision,
    })
    expect(anotherReceipt.task.revision).toBe(first.task.revision)
    expect(anotherReceipt.task.acceptedArtifactIds).toEqual([artifact.id])
    await expect(fixture.service.acceptArtifact({ ...request, artifactId: 'different' }))
      .rejects.toBeInstanceOf(WorkItemStoreConflictError)
  })

  it('rejects stale task, requirement and content versions without consuming request ids', async () => {
    const fixture = await setup()
    const artifact = await saveArtifact(fixture)
    const current = (await fixture.service.get(fixture.snapshot.task.id))!
    const base = {
      requestId: 'accept', taskId: current.task.id, expectedRevision: current.task.revision,
      artifactId: artifact.id, contentVersion: 1, requirementVersion: 1,
    }
    await expect(fixture.service.acceptArtifact({ ...base, expectedRevision: current.task.revision - 1 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(fixture.service.acceptArtifact({ ...base, contentVersion: 2 }))
      .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })

    const revised = await fixture.service.revise({
      requestId: 'revise', taskId: current.task.id, expectedRevision: current.task.revision,
      goal: 'New goal', acceptance: 'New checks',
    })
    await expect(fixture.service.acceptArtifact({
      ...base, requestId: 'stale-requirement', expectedRevision: revised.task.revision,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect((await fixture.service.get(current.task.id))!.task.acceptedArtifactIds).toEqual([])
  })

  it('preserves accepted artifacts through later requirements and late old-run drafts', async () => {
    const fixture = await setup()
    const accepted = await saveArtifact(fixture)
    const before = (await fixture.service.get(fixture.snapshot.task.id))!
    const acceptedSnapshot = await fixture.service.acceptArtifact({
      requestId: 'accept', taskId: before.task.id, expectedRevision: before.task.revision,
      artifactId: accepted.id, contentVersion: 1, requirementVersion: 1,
    })
    const revised = await fixture.service.revise({
      requestId: 'revise', taskId: before.task.id, expectedRevision: acceptedSnapshot.task.revision,
      goal: 'New audience', acceptance: 'New audience confirms',
    })
    const late = await saveArtifact(fixture, {
      requestId: 'late-old-run', contentVersion: 2, name: 'late.md', text: 'late old result',
    })
    const afterLate = (await fixture.service.get(before.task.id))!

    expect(revised.task.acceptedArtifactIds).toEqual([accepted.id])
    expect(afterLate.task.acceptedArtifactIds).toEqual([accepted.id])
    expect(afterLate.task.status).toBe('open')
    expect(afterLate.artifacts.map((artifact) => artifact.id)).toEqual([accepted.id, late.id])
  })

  it('keeps accepted content readable after unrelated run-log cleanup and rejects hash damage', async () => {
    const fixture = await setup()
    const logs = join(fixture.directory, 'workflow-logs')
    await writeFile(logs, 'temporary log')
    const artifact = await saveArtifact(fixture)
    await rm(logs, { force: true })
    expect(await fixture.artifacts.read(artifact)).toEqual(Buffer.from('accepted text'))

    await writeFile(artifact.storedPath, 'tampered')
    const current = (await fixture.service.get(fixture.snapshot.task.id))!
    await expect(fixture.service.acceptArtifact({
      requestId: 'damaged', taskId: current.task.id, expectedRevision: current.task.revision,
      artifactId: artifact.id, contentVersion: 1, requirementVersion: 1,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect((await fixture.service.get(current.task.id))!.task.status).toBe('active')
  })

  it('fails closed when acceptance is not wired to the trusted artifact-root verifier', async () => {
    const fixture = await setup()
    const artifact = await saveArtifact(fixture)
    const current = (await fixture.service.get(fixture.snapshot.task.id))!
    const unwired = new WorkItemService(fixture.store)

    await expect(unwired.acceptArtifact({
      requestId: 'unwired', taskId: current.task.id, expectedRevision: current.task.revision,
      artifactId: artifact.id, contentVersion: 1, requirementVersion: 1,
    })).rejects.toThrow('trusted artifact verifier')
    expect((await fixture.service.get(current.task.id))!.task.acceptedArtifactIds).toEqual([])
  })
})
