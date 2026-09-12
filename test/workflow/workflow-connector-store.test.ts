import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'

describe('WorkflowConnectorStore', () => {
  it('normalizes, persists and defensively clones opt-in health configuration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-health-config-'))
    const store = new WorkflowConnectorStore(dir)
    const input = { id: 'crm', name: 'CRM', kind: 'http' as const, baseUrl: 'https://example.com/', allowedPathPrefixes: ['/v1'], healthProbe: { enabled: true, path: '/v1/health', expectedStatuses: [204, 200, 204] } }
    const saved = await store.upsert(input)
    expect(saved.healthProbe).toEqual({ enabled: true, path: '/v1/health', expectedStatuses: [204, 200], timeoutMs: 5000, ttlMs: 60000 })
    saved.healthProbe!.expectedStatuses.push(201)
    const reloaded = new WorkflowConnectorStore(dir)
    await reloaded.initialize()
    expect(reloaded.get('crm')!.healthProbe!.expectedStatuses).toEqual([204, 200])
    expect(store.get('crm')!.healthProbe!.expectedStatuses).toEqual([204, 200])
  })

  it.each([
    { path: '/v1/health?secret=x' }, { path: '//evil.test/' }, { path: '/v1/%252e%252e/admin' },
    { expectedStatuses: [] }, { expectedStatuses: [401] }, { timeoutMs: 999 }, { ttlMs: 300001 }, { method: 'POST' },
  ])('rejects unsafe health configuration %j', async (override) => {
    const store = new WorkflowConnectorStore(await mkdtemp(join(tmpdir(), 'ezdsh-health-config-')))
    await expect(store.upsert({ id: 'crm', name: 'CRM', kind: 'http', baseUrl: 'https://example.com/', allowedPathPrefixes: ['/v1'], healthProbe: { enabled: true, path: '/v1/health', expectedStatuses: [200], ...override } })).rejects.toThrow()
  })
  it('persists only connector metadata atomically with restrictive permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-connector-store-'))
    const store = new WorkflowConnectorStore(dir)
    await store.upsert({ id: 'crm', name: 'CRM', kind: 'http', baseUrl: 'https://api.example.test/', credentialRef: { id: 'crm-token' }, allowedPathPrefixes: ['/v1'] })
    expect(store.list()).toEqual([{ id: 'crm', name: 'CRM', kind: 'http', baseUrl: 'https://api.example.test/', credentialRef: { id: 'crm-token' }, allowedPathPrefixes: ['/v1'] }])
    const content = await readFile(join(dir, 'workflow-connectors.json'), 'utf8')
    expect(content).not.toContain('secret')
    expect((await stat(join(dir, 'workflow-connectors.json'))).mode & 0o777).toBe(0o600)
  })

  it('rejects non-HTTPS endpoints and traversal prefixes', async () => {
    const store = new WorkflowConnectorStore(await mkdtemp(join(tmpdir(), 'ezdsh-connector-store-')))
    await expect(store.upsert({ id: 'crm', name: 'CRM', kind: 'http', baseUrl: 'http://api.example.test/', allowedPathPrefixes: ['/v1'] })).rejects.toThrow(/HTTPS/u)
    await expect(store.upsert({ id: 'crm', name: 'CRM', kind: 'http', baseUrl: 'https://api.example.test/', allowedPathPrefixes: ['/v1/../admin'] })).rejects.toThrow(/路径/u)
  })

  it('canonicalizes IDs, URLs and path prefixes before dispatch lookups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezdsh-connector-normalize-'))
    const store = new WorkflowConnectorStore(dir)
    const saved = await store.upsert({
      id: ' api ', name: ' Example API ', kind: 'http', baseUrl: ' https://api.example.test ',
      credentialRef: { id: ' token ' }, allowedPathPrefixes: [' /v1 ', '/v1', ''],
    })
    expect(saved).toMatchObject({ id: 'api', name: 'Example API', baseUrl: 'https://api.example.test', credentialRef: { id: 'token' }, allowedPathPrefixes: ['/v1'] })
    expect(store.get('api')).toEqual(saved)
    expect(store.get(' api ')).toBeUndefined()
  })
})
