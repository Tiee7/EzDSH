import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkflowObservationStore } from '../../src/main/workflow/workflow-observation-store.js'
import type { WorkflowObservationEvent } from '../../src/shared/workflow-operations.js'

function createObservation(id: string, overrides: Partial<WorkflowObservationEvent> = {}): WorkflowObservationEvent {
  return {
    id,
    environmentId: 'customer-acme-prod',
    releaseId: 'release-acme-1',
    runId: 'run-acme-1',
    traceId: 'trace-acme-1',
    nodeId: 'node-1',
    time: '2026-09-03T09:00:00.000Z',
    kind: 'node',
    action: 'node-started',
    severity: 'info',
    outcome: 'started',
    ...overrides,
  }
}

describe('WorkflowObservationStore', () => {
  it('loads valid JSONL entries across restart, skips invalid rows, returns clones, and enforces private permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observations-load-'))
    await chmod(dir, 0o755)
    const filePath = join(dir, 'workflow-observations.jsonl')
    const validOldest = createObservation('observation-oldest', {
      nodeId: 'node-oldest',
      time: '2026-09-03T08:59:00.000Z',
      action: 'node-completed',
      outcome: 'succeeded',
    })
    const validSameTimeFirst = createObservation('observation-same-time-1', {
      nodeId: 'node-same-time-1',
      time: '2026-09-03T09:00:00.000Z',
      kind: 'effect',
      action: 'node-effect-dispatched',
      outcome: 'unknown',
    })
    const validSameTimeSecond = createObservation('observation-same-time-2', {
      nodeId: 'node-same-time-2',
      time: '2026-09-03T09:00:00.000Z',
      environmentId: 'customer-acme-staging',
      action: 'node-retry',
      severity: 'warning',
      outcome: 'unknown',
    })
    await writeFile(filePath, [
      JSON.stringify(validSameTimeFirst),
      JSON.stringify({ ...validSameTimeFirst, releaseId: 'release-duplicate-should-skip' }),
      '{"id":"broken-json"',
      JSON.stringify({ ...validOldest, message: 'Authorization: secret' }),
      JSON.stringify(validOldest),
      JSON.stringify({ ...validSameTimeSecond, payload: { output: 'private' } }),
      JSON.stringify(validSameTimeSecond),
      '',
    ].join('\n'), { mode: 0o666 })
    await chmod(filePath, 0o666)

    const store = new WorkflowObservationStore(dir)
    await store.initialize()

    expect(store.list().map((event) => event.id)).toEqual([
      'observation-oldest',
      'observation-same-time-1',
      'observation-same-time-2',
    ])
    expect(store.list('customer-acme-staging').map((event) => event.id)).toEqual(['observation-same-time-2'])
    const cloned = store.list()[0]!
    cloned.nodeId = 'mutated'
    expect(store.list()[0]?.nodeId).toBe('node-oldest')
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)

    const reloaded = new WorkflowObservationStore(dir)
    await reloaded.initialize()
    expect(reloaded.list()).toEqual(store.list())
  })

  it('appends only normalized metadata and deduplicates duplicate event ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-observations-append-'))
    const store = new WorkflowObservationStore(dir)
    const first = createObservation('observation-1', {
      nodeId: 'node-1',
      time: '2026-09-03T09:10:00.000Z',
      kind: 'run',
      action: 'run-started',
      outcome: 'started',
    })
    const second = createObservation('observation-2', {
      nodeId: 'node-2',
      time: '2026-09-03T09:10:00.000Z',
      kind: 'effect',
      action: 'node-effect-confirmed',
      outcome: 'succeeded',
    })

    await Promise.all([
      store.append(first),
      store.append({ ...first, releaseId: 'release-duplicate-ignored' }),
      store.append(second),
    ])

    expect(store.list()).toEqual([first, second])
    const persisted = await readFile(join(dir, 'workflow-observations.jsonl'), 'utf8')
    expect(persisted.trim().split('\n')).toHaveLength(2)
    expect(persisted).not.toContain('release-duplicate-ignored')
  })
})
