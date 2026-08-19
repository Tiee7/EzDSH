import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalApiService } from '../../src/main/external-api/external-api-service.js'

const workspace = {
  workspaceId: 'workspace-1',
  path: '/work',
  title: 'Work',
  sessionIds: ['session-1'],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-02',
}

const services: ExternalApiService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
})

describe('ExternalApiService', () => {
  it('lists projects and includes their session summaries', async () => {
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([workspace]),
      listSessions: vi.fn().mockResolvedValue([
        { sessionId: 'session-1', updatedAt: 2, running: false, title: 'Task one' },
      ]),
    }
    const service = new ExternalApiService({
      getRuntimeUrl: () => 'http://runtime',
      createClient: () => client as never,
      port: 0,
    })
    services.push(service)
    await service.start()

    const response = await fetch(`${service.url}/api/external/v1/projects`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        id: 'workspace-1',
        title: 'Work',
        path: '/work',
        sessionIds: ['session-1'],
        sessions: [{ sessionId: 'session-1', updatedAt: 2, running: false, title: 'Task one' }],
      },
    ])
  })

  it('rejects an existing-session dispatch when the session is outside the project', async () => {
    const client = {
      listWorkspaces: vi.fn().mockResolvedValue([{ ...workspace, sessionIds: [] }]),
      listSessions: vi.fn().mockResolvedValue([]),
    }
    const service = new ExternalApiService({
      getRuntimeUrl: () => 'http://runtime',
      createClient: () => client as never,
      port: 0,
    })
    services.push(service)
    await service.start()

    const response = await fetch(`${service.url}/api/external/v1/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workspace-1',
        sessionMode: 'existing',
        sessionId: 'session-1',
        prompt: '执行',
      }),
    })

    expect(response.status).toBe(404)
  })
})
