import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowConnectorService } from '../../src/main/workflow/workflow-connector-service.js'

afterEach(() => vi.unstubAllGlobals())

function policy(operations: ('read' | 'write')[] = ['read', 'write']) {
  return { connectors: [{ connectorId: 'api', operations }] }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-connectors-'))
  const credentials = new WorkflowCredentialStore(dir)
  await credentials.upsert({
    id: 'api-token',
    label: 'API token',
    type: 'bearer-token',
    scopes: [{ origin: 'https://api.example.test', methods: ['GET', 'POST'], headerName: 'Authorization', prefix: 'Bearer', pathPrefixes: ['/items'] }],
    secret: 'top-secret',
  })
  const connectors = new WorkflowConnectorStore(dir)
  await connectors.upsert({ id: 'api', name: 'Example API', kind: 'http', baseUrl: 'https://api.example.test/', credentialRef: { id: 'api-token' }, allowedPathPrefixes: ['/items'] })
  return { dir, credentials, connectors, service: new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }] }) }
}

describe('WorkflowCredentialStore', () => {
  it('persists encrypted credentials while metadata never exposes the secret', async () => {
    const { dir, credentials } = await setup()
    const metadata = credentials.get('api-token')!
    expect(metadata).toMatchObject({ id: 'api-token', configured: true, type: 'bearer-token' })
    expect(metadata).not.toHaveProperty('secret')
    expect(metadata).not.toHaveProperty('headers')
    expect(await readFile(join(dir, '.workflow-credentials.json'), 'utf8')).not.toContain('top-secret')
    const loaded = new WorkflowCredentialStore(dir)
    expect((await loaded.resolve('api-token'))?.secret).toBe('top-secret')
  })
})

describe('WorkflowConnectorService', () => {
  it('resolves templates, injects a scoped credential, sends an idempotency key, and redacts results', async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true, token: 'top-secret', nested: { value: 'top-secret' } }), { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'private=1', 'x-request-id': 'r1' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { service } = await setup()
    const result = await service.request({ connectorId: 'api', connectorPath: '/items', method: 'POST', query: { q: '{{value.topic}}' }, headers: { 'content-type': 'application/json' }, body: { value: '{{value.topic}}' }, idempotencyKey: 'publish-42', workflowPolicy: policy(['write']) }, { topic: 'ignored' }, { topic: 'hello' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://api.example.test/items?q=hello')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer top-secret', 'Idempotency-Key': 'publish-42', 'content-type': 'application/json' })
    expect(init?.body).toBe(JSON.stringify({ value: 'hello' }))
    expect(init?.redirect).toBe('error')
    expect(result).toEqual({ status: 201, ok: true, headers: { 'content-type': 'application/json', 'x-request-id': 'r1' }, body: { ok: true, token: '[REDACTED]', nested: { value: '[REDACTED]' } } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('denies an operation missing from the workflow policy before fetch', async () => {
    const { service } = await setup()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(service.request({ connectorId: 'api', connectorPath: '/items', method: 'POST', workflowPolicy: policy(['read']) })).rejects.toThrow(/未授权/u)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a per-run grant when one is supplied and rejects unsafe paths/headers', async () => {
    const { service } = await setup()
    await expect(service.request({ connectorId: 'api', connectorPath: '/items', method: 'GET', workflowPolicy: policy(['read']), runGrant: [{ connectorId: 'api', operations: ['write'] }] })).rejects.toThrow(/本次运行未授予/u)
    await expect(service.request({ connectorId: 'api', connectorPath: '//evil.test/', method: 'GET', workflowPolicy: policy(['read']) })).rejects.toThrow(/路径/u)
    await expect(service.request({ connectorId: 'api', connectorPath: '/items', method: 'GET', headers: { Authorization: 'spoof' }, workflowPolicy: policy(['read']) })).rejects.toThrow(/敏感请求头/u)
  })

  it('rejects a credential scope mismatch and private egress', async () => {
    const { service, connectors } = await setup()
    await expect(service.request({ connectorId: 'api', connectorPath: '/other', method: 'GET', workflowPolicy: policy(['read']) })).rejects.toThrow(/路径/u)
    await connectors.upsert({ id: 'api', name: 'Local', kind: 'http', baseUrl: 'https://127.0.0.1/', credentialRef: { id: 'api-token' }, allowedPathPrefixes: ['/items'] })
    await expect(service.request({ connectorId: 'api', connectorPath: '/items', method: 'GET', workflowPolicy: policy(['read']) })).rejects.toThrow(/内网/u)
  })

  it('fails closed when DNS cannot be resolved', async () => {
    const { connectors, credentials } = await setup()
    const fetchMock = vi.fn()
    const service = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => { throw new Error('resolver offline') }, fetchImpl: fetchMock as typeof fetch })
    await expect(service.request({ connectorId: 'api', connectorPath: '/items', method: 'GET', workflowPolicy: policy(['read']) })).rejects.toThrow(/无法解析/u)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours an already-aborted parent signal before dispatch', async () => {
    const { connectors, credentials } = await setup()
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true)
      throw new Error('aborted')
    })
    const requestService = new WorkflowConnectorService({ connectors, credentials, resolveHost: async () => [{ address: '93.184.216.34' }], fetchImpl: fetchMock as typeof fetch })
    await expect(requestService.request({ connectorId: 'api', connectorPath: '/items', method: 'GET', workflowPolicy: policy(['read']) }, null, null, controller.signal)).rejects.toThrow(/取消/u)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
