import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'

describe('WorkflowConnectorStore', () => {
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
