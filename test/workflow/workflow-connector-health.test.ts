import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowConnectorHealthService } from '../../src/main/workflow/workflow-connector-health-service.js'
import { WorkflowConnectorStore } from '../../src/main/workflow/workflow-connector-store.js'
import { WorkflowCredentialStore } from '../../src/main/workflow/workflow-credential-service.js'
import { computeWorkflowReleaseSha256 } from '../../src/main/workflow/workflow-release-integrity.js'
import { createDefaultWorkflow } from '../../src/shared/workflow.js'
import type { WorkflowCustomerEnvironment, WorkflowRelease } from '../../src/shared/workflow-operations.js'

const query = { workflowId: 'wf', environmentId: 'env', connectorId: 'api' }
const targetQuery = { workflowId: 'wf', environmentId: 'env' }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ezdsh-health-'))
  const connectors = new WorkflowConnectorStore(dir)
  const credentials = new WorkflowCredentialStore(dir)
  await credentials.initialize()
  await connectors.upsert({ id: 'api', name: 'API', kind: 'http', baseUrl: 'https://example.com/', allowedPathPrefixes: ['/v1'], healthProbe: { enabled: true, path: '/v1/health', expectedStatuses: [200], timeoutMs: 1000, ttlMs: 10000 } })
  const workflowSnapshot = createDefaultWorkflow('Test'); workflowSnapshot.id = 'wf'
  workflowSnapshot.permissionPolicy = { connectors: [{ connectorId: 'api', operations: ['read'] }] }
  const release: WorkflowRelease = { id: 'rel', workflowId: 'wf', environmentId: 'env', workflowRevision: workflowSnapshot.revision, workflowSnapshot, status: 'published', contentSha256: '', connectorGrants: [{ connectorId: 'api', operations: ['read'] }], createdAt: '2026-09-12T00:00:00.000Z', publishedAt: '2026-09-12T00:00:00.000Z', activation: { at: '2026-09-12T00:00:00.000Z', kind: 'publish' } }
  release.contentSha256 = computeWorkflowReleaseSha256(release)
  const environment: WorkflowCustomerEnvironment = { id: 'env', customerName: 'Test', name: 'Test', kind: 'development', status: 'active', connectorIds: ['api'], allowCode: false, allowShellFile: false, createdAt: release.createdAt, updatedAt: release.createdAt }
  const transport = vi.fn(async () => 200)
  const resolver = vi.fn(async () => [{ address: '8.8.8.8' }])
  let time = Date.parse('2026-09-12T12:00:00Z')
  const options = { connectors, credentials, listReleases: () => [release], listReleaseIntegrityFailures: () => [], resolveEnvironment: () => environment, transport, resolver, now: () => time }
  const service = new WorkflowConnectorHealthService(options)
  return { service, options, transport, resolver, connectors, credentials, release, environment, advance: (ms: number) => { time += ms } }
}

describe('managed connector health', () => {
  it.each(['Host', 'Connection', 'Transfer-Encoding'])('rejects credential header %s that could change transport routing', async (headerName) => {
    const f = await fixture()
    await f.credentials.upsert({ id: 'token', label: 'Token', type: 'api-key', secret: 'secret', scopes: [{ origin: 'https://example.com', methods: ['GET'], headerName }] })
    await f.connectors.upsert({ ...f.connectors.get('api')!, credentialRef: { id: 'token' } })
    expect((await f.service.check(query)).reason).toBe('credential-scope-denied')
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('revalidates credential generation after asynchronous secret resolution', async () => {
    const f = await fixture()
    await f.credentials.upsert({ id: 'token', label: 'Token', type: 'api-key', secret: 'secret', scopes: [{ origin: 'https://example.com', methods: ['GET'], headerName: 'X-Api-Key' }] })
    await f.connectors.upsert({ ...f.connectors.get('api')!, credentialRef: { id: 'token' } })
    const old = await f.credentials.resolve('token')
    let finish!: (value: typeof old) => void
    vi.spyOn(f.credentials, 'resolve').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.service.check(query)
    await vi.waitFor(() => expect(f.credentials.resolve).toHaveBeenCalled())
    await f.credentials.remove('token'); finish(old)
    expect((await pending).reason).toBe('target-changed'); expect(f.transport).not.toHaveBeenCalled()
  })
  it('ignores late transport success when activation changes', async () => {
    const f = await fixture()
    let finish!: (value: number) => void
    f.transport.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.service.check(query)
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalled())
    f.release.activation = { kind: 'rollback', at: '2026-09-12T11:00:00Z' }; finish(200)
    expect((await pending).reason).toBe('target-changed')
    expect(f.service.snapshot(targetQuery)[0].state).toBe('unchecked')
  })
  it('is read-only until explicit check and defaults old connectors to disabled', async () => {
    const f = await fixture()
    expect(f.service.snapshot(targetQuery)[0].state).toBe('unchecked')
    expect(f.transport).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled()
    await f.connectors.upsert({ ...f.connectors.get('api')!, healthProbe: undefined })
    expect((await f.service.check(query)).state).toBe('disabled')
    expect(f.transport).not.toHaveBeenCalled()
  })
  it.each([200, 401, 403, 429, 500, 503, 302])('returns only bounded status evidence for %s', async (status) => {
    const f = await fixture(); f.transport.mockResolvedValue(status)
    const result = await f.service.check(query)
    expect(result.state).toBe(status === 200 ? 'reachable' : 'failed')
    expect(result.status).toBe(status)
    expect(Object.keys(result).sort()).toEqual(['connectorId', 'durationMs', 'environmentId', 'expiresAt', 'observedAt', 'reason', 'releaseId', 'state', 'status', 'workflowId'].sort())
  })
  it('single-flights requests, expires evidence and clears it on restart/config/credential generation', async () => {
    const f = await fixture()
    let finish!: (value: number) => void
    f.transport.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = f.service.check(query); const second = f.service.check(query)
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledOnce())
    expect(f.service.snapshot(targetQuery)[0].state).toBe('checking')
    finish(200); await Promise.all([first, second])
    expect(f.service.snapshot(targetQuery)[0].state).toBe('reachable')
    f.advance(10001); expect(f.service.snapshot(targetQuery)[0].state).toBe('stale')
    expect(new WorkflowConnectorHealthService(f.options).snapshot(targetQuery)[0].state).toBe('unchecked')
    await f.connectors.upsert(f.connectors.get('api')!)
    expect(f.service.snapshot(targetQuery)[0].state).toBe('unchecked')
  })
  it.each(['query', 'url', 'headers', 'body', 'path', 'timeoutMs'])('rejects renderer override %s before DNS', async (key) => {
    const f = await fixture()
    await expect(f.service.check({ ...query, [key]: 'secret' })).rejects.toThrow('invalid-query')
    expect(f.resolver).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled()
  })
  it.each(['environment', 'allowlist', 'grant', 'policy', 'activation', 'integrity', 'multiple'])('fails closed on %s access', async (kind) => {
    const f = await fixture()
    if (kind === 'environment') f.environment.status = 'disabled'
    if (kind === 'allowlist') f.environment.connectorIds = []
    if (kind === 'grant') f.release.connectorGrants = []
    if (kind === 'policy') { f.release.workflowSnapshot.permissionPolicy = {}; f.release.contentSha256 = computeWorkflowReleaseSha256(f.release) }
    if (kind === 'activation') f.release.activation = undefined
    if (kind === 'integrity') f.release.contentSha256 = '0'.repeat(64)
    if (kind === 'multiple') f.options.listReleases = () => [f.release, { ...f.release, id: 'duplicate' }]
    expect((await f.service.check(query)).state).toBe('blocked')
    expect(f.service.snapshot(targetQuery)).toEqual([])
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('revalidates revoked access after slow DNS and never caches late success', async () => {
    const f = await fixture()
    let finish!: (value: Array<{address: string}>) => void
    f.resolver.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.service.check(query)
    await vi.waitFor(() => expect(f.resolver).toHaveBeenCalledOnce())
    f.environment.connectorIds = []
    finish([{ address: '8.8.8.8' }])
    expect((await pending).state).toBe('blocked'); expect(f.transport).not.toHaveBeenCalled()
  })
  it('bounds DNS/credential preparation by deadline and forbids late dispatch', async () => {
    const f = await fixture()
    let finish!: (value: Array<{address: string}>) => void
    f.resolver.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const result = await f.service.check(query)
    expect(result.reason).toBe('timeout')
    finish([{ address: '8.8.8.8' }]); await new Promise((resolve) => setImmediate(resolve))
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('uses credential GET/origin/path scope and rotation invalidates evidence without leaking secrets', async () => {
    const f = await fixture()
    await f.credentials.upsert({ id: 'token', label: 'Token', type: 'bearer-token', secret: 'ULTRA-SECRET', scopes: [{ origin: 'https://example.com', methods: ['GET'], pathPrefixes: ['/v1/health'], headerName: 'Authorization' }] })
    await f.connectors.upsert({ ...f.connectors.get('api')!, credentialRef: { id: 'token' } })
    expect((await f.service.check(query)).state).toBe('reachable')
    expect(f.transport.mock.calls[0]?.[0]).toMatchObject({ headers: { Authorization: 'Bearer ULTRA-SECRET' } })
    await f.credentials.upsert({ id: 'token', label: 'Token', type: 'bearer-token', secret: 'ROTATED', scopes: [{ origin: 'https://example.com', methods: ['GET'], headerName: 'Authorization' }] })
    expect(f.service.snapshot(targetQuery)[0].state).toBe('unchecked')
    await f.credentials.remove('token'); f.advance(6000)
    const result = await f.service.check(query)
    expect(result.state).toBe('blocked'); expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(f.transport).toHaveBeenCalledOnce()
  })
  it('does not expose error text and rate limits repeated checks', async () => {
    const f = await fixture(); f.transport.mockRejectedValue(new Error('https://secret.invalid/?token=SECRET'))
    expect((await f.service.check(query)).reason).toBe('request-failed')
    expect((await f.service.check(query)).reason).toBe('rate-limited')
    expect(f.transport).toHaveBeenCalledOnce()
  })
})
