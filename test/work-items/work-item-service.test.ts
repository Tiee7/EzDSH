import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkItemService } from '../../src/main/work-items/work-item-service'
import { WorkItemStore, WorkItemStoreConflictError } from '../../src/main/work-items/work-item-store'
import { WorkItemValidationError } from '../../src/shared/work-items'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function service(): Promise<WorkItemService> {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-work-item-service-'))
  directories.push(directory)
  const store = new WorkItemStore(directory)
  const result = new WorkItemService(store)
  await result.initialize()
  return result
}

describe('WorkItemService', () => {
  it('validates and normalizes create requests before storing them', async () => {
    const subject = await service()
    const snapshot = await subject.create({
      requestId: ' create-1 ',
      title: ' 竞品简报 ',
      goal: ' 核实三项变化 ',
      acceptance: ' 附来源 ',
      scope: { resourceRefs: [] }
    })

    expect(snapshot.task).toMatchObject({ title: '竞品简报', revision: 1 })
    expect(snapshot.task.requirements[0]).toMatchObject({ goal: '核实三项变化', acceptance: '附来源' })
    await expect(subject.create({
      requestId: 'bad', title: ' ', goal: 'goal', acceptance: 'done', scope: { resourceRefs: [] }
    })).rejects.toBeInstanceOf(WorkItemValidationError)
  })

  it('records only a durable dispatch intent and replays it idempotently', async () => {
    const subject = await service()
    const created = await subject.create({
      requestId: 'create-1', title: 'Task', goal: 'Goal', acceptance: 'Done', scope: { resourceRefs: [] }
    })
    const request = {
      requestId: 'dispatch-1',
      taskId: created.task.id,
      expectedRevision: 1,
      executor: { kind: 'workflow' as const, workflowId: 'wf-1', workflowRevision: 2 },
      mode: 'initial' as const,
      input: { topic: 'AI' }
    }

    const first = await subject.recordDispatchIntent(request)
    const replay = await subject.recordDispatchIntent(request)

    expect(first.snapshot.task.revision).toBe(2)
    expect(first.stage).toBe('recorded')
    expect(first.snapshot.runs[0]).toMatchObject({ status: 'queued', rawStatus: 'dispatch-intent-recorded' })
    expect(replay).toEqual({ ...first, replayed: true })
    await expect(subject.recordDispatchIntent({ ...request, input: { topic: 'different' } }))
      .rejects.toBeInstanceOf(WorkItemStoreConflictError)
    expect(await subject.list({ workflowId: 'wf-1' })).toHaveLength(1)
  })
})
