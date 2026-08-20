import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalApiService } from '../../src/main/external-api/external-api-service.js'
import { ExternalRunService } from '../../src/main/external-api/external-run-service.js'

const services: ExternalApiService[] = []

function createRunService() {
  const client = {
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    archiveSession: vi.fn().mockResolvedValue({ archivedSessionIds: ['session-1'] }),
    sendPromptAsync: vi.fn(async (_sessionId: string, _prompt: string, callbacks: {
      onAcknowledged(): void
      onDelta?(text: string): void
      onProgress(elapsedMs: number): void
      onComplete(text: string): void
      onError(error: string): void
    }) => {
      callbacks.onAcknowledged()
      callbacks.onDelta?.('{"summary":"完成"}')
      callbacks.onComplete('{"summary":"完成"}')
    }),
  }
  return new ExternalRunService({ createClient: () => client })
}

function createService(runService: ExternalRunService) {
  const service = new ExternalApiService({
    getRuntimeUrl: () => 'http://runtime',
    createRunService: () => runService,
    port: 0,
  })
  services.push(service)
  return service
}

async function createCompletedRun(service: ExternalApiService): Promise<string> {
  const response = await fetch(`${service.url}/api/external/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'workspace-1',
      sessionMode: 'new',
      prompt: '展开',
      output: { format: 'json' },
      client: { name: 'workbench', requestId: 'proposal-1' },
    }),
  })
  const body = await response.json() as { runId: string }
  return body.runId
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
})

describe('ExternalApiService Run API', () => {
  it('rejects a new Run without an explicit DSH project binding', async () => {
    const runService = createRunService()
    const create = vi.spyOn(runService, 'create')
    const service = createService(runService)
    await service.start()

    const response = await fetch(`${service.url}/api/external/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionMode: 'new', prompt: '不得落到默认工作区' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'projectId is required for a new Run' })
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a Run without exposing Workbench fields', async () => {
    const service = createService(createRunService())
    await service.start()

    const response = await fetch(`${service.url}/api/external/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workspace-1',
        sessionMode: 'new',
        prompt: '展开任务',
        archiveSession: true,
        output: { format: 'json' },
        client: { name: 'workbench', requestId: 'proposal-1' },
        taskId: 'must-not-cross-the-boundary',
      }),
    })

    expect(response.status).toBe(202)
    const created = await response.json()
    expect(created).toMatchObject({ status: 'queued', sessionId: 'session-1' })
    expect(created).not.toHaveProperty('taskId')
    expect(created).not.toHaveProperty('ideaId')
  })

  it('replays missed SSE events from Last-Event-ID', async () => {
    const runService = createRunService()
    const service = createService(runService)
    await service.start()
    const runId = await createCompletedRun(service)

    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = await fetch(`${service.url}/api/external/v1/runs/${runId}/events`, {
      headers: { 'Last-Event-ID': '2' },
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('id: 3')
    expect(text).toContain('event: delta')
    expect(text).toContain('event: completed')
    expect(text).not.toContain('id: 2')
  })

  it('returns a persisted snapshot for a Run', async () => {
    const service = createService(createRunService())
    await service.start()
    const runId = await createCompletedRun(service)

    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = await fetch(`${service.url}/api/external/v1/runs/${runId}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      runId,
      sessionId: 'session-1',
      status: 'completed',
      result: { summary: '完成' },
    })
  })
})
