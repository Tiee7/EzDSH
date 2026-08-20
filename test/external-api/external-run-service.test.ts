import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalRunService } from '../../src/main/external-api/external-run-service.js'

function fakeClient() {
  const client = {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    archiveSession: vi.fn().mockResolvedValue({ archivedSessionIds: ['session-1'] }),
    queuePrompt: vi.fn().mockResolvedValue({ accepted: true as const }),
    sendPromptAsync: vi.fn(async (_sessionId: string, _prompt: string, callbacks: {
      onAcknowledged(): void
      onDelta?(text: string): void
      onProgress(elapsedMs: number): void
      onComplete(text: string): void
      onError(error: string): void
    }) => {
      callbacks.onAcknowledged()
      callbacks.onDelta?.('第一段')
      callbacks.onDelta?.('第二段')
      callbacks.onComplete('第一段第二段')
    }),
  }
  return client
}

async function waitForRun(service: ExternalRunService, runId: string, status: 'completed' | 'failed' | 'cancelled') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = service.get(runId)
    if (snapshot?.status === status) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Run ${runId} did not reach ${status}`)
}

describe('ExternalRunService', () => {
  it('creates a new session and publishes replayable Run events', async () => {
    const client = fakeClient()
    const service = new ExternalRunService({ createClient: () => client })
    const created = await service.create({
      projectId: 'workspace-1',
      sessionMode: 'new',
      prompt: '展开任务',
      output: { format: 'json' },
      client: { name: 'workbench', requestId: 'proposal-1' },
    })

    await waitForRun(service, created.runId, 'completed')
    const events = service.events(created.runId)

    expect(events.map((event) => event.type)).toEqual([
      'queued', 'started', 'delta', 'delta', 'completed',
    ])
    expect(events.at(-1)?.data).toMatchObject({ text: '第一段第二段' })
  })

  it('does not create a second DSH request when the same client request is retried', async () => {
    const client = fakeClient()
    const service = new ExternalRunService({ createClient: () => client })
    const request = {
      projectId: 'workspace-1',
      sessionMode: 'new' as const,
      prompt: '展开',
      client: { name: 'workbench', requestId: 'proposal-1' },
    }

    const first = await service.create(request)
    const second = await service.create(request)

    expect(second.runId).toBe(first.runId)
    expect(client.createSession).toHaveBeenCalledTimes(1)
  })

  it('archives a newly-created session when the caller marks the run as an AI expansion', async () => {
    const client = fakeClient()
    const service = new ExternalRunService({ createClient: () => client })

    await service.create({
      projectId: 'workspace-1',
      sessionMode: 'new',
      prompt: '展开',
      archiveSession: true,
    })

    expect(client.archiveSession).toHaveBeenCalledWith('session-1')
  })

  it('restores a completed Run from the EzDSH state ledger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-ledger-'))
    const statePath = join(directory, 'external-runs.json')
    try {
      const first = new ExternalRunService({ createClient: () => fakeClient(), statePath })
      const created = await first.create({ prompt: '保存结果' })
      await waitForRun(first, created.runId, 'completed')
      await first.flush()

      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { runs: Array<{ snapshot: { runId: string } }> }
      expect(persisted.runs.some((run) => run.snapshot.runId === created.runId)).toBe(true)

      const second = new ExternalRunService({ createClient: () => fakeClient(), statePath })
      await second.initialize()
      expect(second.get(created.runId)).toMatchObject({
        runId: created.runId,
        status: 'completed',
        text: '第一段第二段',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('converges an interrupted Run to a retryable failed state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezdsh-run-recovery-'))
    const statePath = join(directory, 'external-runs.json')
    try {
      await writeFile(statePath, JSON.stringify({ runs: [{
        snapshot: {
          runId: 'run-interrupted', sessionId: 'session-interrupted', status: 'running', text: '已生成一半',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
        },
        events: [], outputFormat: 'json',
      }] }))
      const service = new ExternalRunService({ createClient: () => fakeClient(), statePath })
      await service.initialize()
      expect(service.get('run-interrupted')).toMatchObject({ status: 'failed', text: '已生成一半' })
      expect(service.events('run-interrupted').at(-1)?.type).toBe('failed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
