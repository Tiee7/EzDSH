import type { WorkflowHttpConnector } from '../../shared/workflow.js'
import type { WorkflowConnectorHealthEvidence, WorkflowConnectorHealthQuery, WorkflowConnectorHealthReason, WorkflowCustomerEnvironment, WorkflowOperationalHealthQuery, WorkflowRelease } from '../../shared/workflow-operations.js'
import type { WorkflowConnectorStore } from './workflow-connector-store.js'
import { normalizeHealthProbe } from './workflow-connector-store.js'
import type { WorkflowCredentialStore } from './workflow-credential-service.js'
import { assertPermission } from './workflow-connector-service.js'
import { verifyWorkflowReleaseIntegrity } from './workflow-release-integrity.js'
import type { WorkflowReleaseIntegrityFailure } from './workflow-release-store.js'
import { requestConnectorHealthStatus, resolveConnectorAddresses, type ConnectorResolver, type ConnectorHealthTransportInput } from './workflow-connector-health-transport.js'

export interface WorkflowConnectorHealthServiceOptions {
  connectors: WorkflowConnectorStore
  credentials: WorkflowCredentialStore
  resolveEnvironment: (id: string) => WorkflowCustomerEnvironment | undefined
  listReleases: () => WorkflowRelease[]
  listReleaseIntegrityFailures: () => WorkflowReleaseIntegrityFailure[]
  getAccessGeneration?: () => number
  /** Main-only dependency injection; never exposed through IPC. */
  resolver?: ConnectorResolver
  transport?: (input: ConnectorHealthTransportInput) => Promise<number>
  now?: () => number
}
interface Target { connector: WorkflowHttpConnector; release: WorkflowRelease; key: string }
interface CacheEntry { key: string; evidence: WorkflowConnectorHealthEvidence }
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export class WorkflowConnectorHealthService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly flights = new Map<string, { key: string; promise: Promise<WorkflowConnectorHealthEvidence> }>()
  private readonly lastChecks = new Map<string, number>()
  private active = 0
  private lastGlobalCheck = -Infinity
  private readonly now: () => number
  constructor(private readonly options: WorkflowConnectorHealthServiceOptions) { this.now = options.now ?? Date.now }

  /** Pure in-memory/control-plane read. It must never resolve DNS or a secret. */
  snapshot(query: WorkflowOperationalHealthQuery): WorkflowConnectorHealthEvidence[] {
    validateQuery(query, false)
    return this.options.connectors.list().flatMap((connector) => {
      const targetQuery = { workflowId: query.workflowId, environmentId: query.environmentId, connectorId: connector.id }
      const target = this.target(targetQuery)
      if (!target) return []
      const base = { ...targetQuery, releaseId: target.release.id }
      if (!connector.healthProbe?.enabled) return [{ ...base, state: 'disabled', reason: 'probe-disabled' } as WorkflowConnectorHealthEvidence]
      const identity = identityOf(targetQuery)
      if (this.flights.get(identity)?.key === target.key) return [{ ...base, state: 'checking', reason: 'checking' } as WorkflowConnectorHealthEvidence]
      const cached = this.cache.get(identity)
      if (!cached || cached.key !== target.key) return [{ ...base, state: 'unchecked', reason: 'not-checked' } as WorkflowConnectorHealthEvidence]
      const stale = this.now() >= Date.parse(cached.evidence.expiresAt!) || this.now() < Date.parse(cached.evidence.observedAt!)
      return [{ ...cached.evidence, ...(stale ? { state: 'stale' as const, reason: 'expired' as const } : {}) }]
    })
  }

  async check(query: WorkflowConnectorHealthQuery): Promise<WorkflowConnectorHealthEvidence> {
    validateQuery(query, true)
    const target = this.target(query)
    if (!target) return { ...query, state: 'blocked', reason: 'access-denied' }
    if (!target.connector.healthProbe?.enabled) return { ...query, releaseId: target.release.id, state: 'disabled', reason: 'probe-disabled' }
    const identity = identityOf(query)
    const flight = this.flights.get(identity)
    if (flight?.key === target.key) return { ...await flight.promise }
    const now = this.now()
    if (this.active >= 2 || now - this.lastGlobalCheck < 250 || now - (this.lastChecks.get(identity) ?? -Infinity) < 1000) {
      return { ...query, releaseId: target.release.id, state: 'blocked', reason: 'rate-limited' }
    }
    this.active++; this.lastGlobalCheck = now; this.lastChecks.set(identity, now)
    // Bound stale cache/rate bookkeeping in a long-lived desktop process.
    if (this.lastChecks.size > 256) this.lastChecks.delete(this.lastChecks.keys().next().value!)
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!)
    const promise = this.probe(query, target).finally(() => {
      this.active--
      if (this.flights.get(identity)?.promise === promise) this.flights.delete(identity)
    })
    this.flights.set(identity, { key: target.key, promise })
    return { ...await promise }
  }

  private target(query: WorkflowConnectorHealthQuery): Target | undefined {
    const environment = this.options.resolveEnvironment(query.environmentId)
    if (!environment || environment.id !== query.environmentId || environment.status !== 'active' || !environment.connectorIds.includes(query.connectorId)) return undefined
    const releases = this.options.listReleases().filter((release) => release.workflowId === query.workflowId && release.environmentId === query.environmentId && release.status === 'published')
    if (releases.length !== 1 || this.options.listReleaseIntegrityFailures().some((failure) => failure.workflowId === query.workflowId && failure.environmentId === query.environmentId && failure.status === 'published')) return undefined
    const release = releases[0]!
    if (!release.activation || !verifyWorkflowReleaseIntegrity(release)) return undefined
    try { assertPermission(release.workflowSnapshot.permissionPolicy, release.connectorGrants, query.connectorId, 'read') } catch { return undefined }
    const connector = this.options.connectors.get(query.connectorId)
    if (!connector) return undefined
    const key = JSON.stringify([release, environment, connector, this.options.connectors.getGeneration(), this.options.credentials.getGeneration(), this.options.getAccessGeneration?.() ?? 0])
    return { connector, release, key }
  }

  private async probe(query: WorkflowConnectorHealthQuery, target: Target): Promise<WorkflowConnectorHealthEvidence> {
    const start = Date.now()
    const controller = new AbortController()
    let ttlMs = 60000
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: Pick<WorkflowConnectorHealthEvidence, 'state' | 'reason' | 'status'>
    const assertCurrent = (): void => {
      if (controller.signal.aborted) throw new Error('timeout')
      if (this.target(query)?.key !== target.key) throw new Error('target-changed')
    }
    try {
      const config = normalizeHealthProbe(target.connector.healthProbe)
      ttlMs = config.ttlMs!
      const deadline = start + config.timeoutMs!
      const work = async (): Promise<number> => {
        const base = new URL(target.connector.baseUrl)
        const url = new URL(config.path.slice(1), base)
        if (url.origin !== base.origin || !pathAllowed(config.path, target.connector.allowedPathPrefixes)) throw new Error('configuration-invalid')
        const addresses = await resolveConnectorAddresses(url.hostname, this.options.resolver)
        assertCurrent()
        const headers: Record<string, string> = {}
        const ref = target.connector.credentialRef
        if (ref) {
          let credential: Awaited<ReturnType<WorkflowCredentialStore['resolve']>>
          try { credential = await this.options.credentials.resolve(ref.id) } catch { throw new Error('credential-unavailable') }
          assertCurrent()
          if (!credential) throw new Error('credential-unavailable')
          const scope = credential.metadata.scopes.find((scope) => scope.origin === url.origin && scope.methods.includes('GET') && (!scope.pathPrefixes?.length || pathAllowed(url.pathname, scope.pathPrefixes)))
          if (!scope || /^(?:host|connection|content-length|transfer-encoding|upgrade|te|trailer|proxy-authorization|proxy-connection)$/iu.test(scope.headerName)) throw new Error('credential-scope-denied')
          headers[scope.headerName] = credential.metadata.type === 'bearer-token' ? `${scope.prefix ?? 'Bearer'} ${credential.secret}` : `${scope.prefix ?? ''}${credential.secret}`
        }
        assertCurrent()
        if (Date.now() >= deadline) throw new Error('timeout')
        // No await between the final generation check and the pinned transport.
        return (this.options.transport ?? requestConnectorHealthStatus)({ url, addresses, headers, signal: controller.signal })
      }
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, Math.max(0, deadline - Date.now()))
      })
      const status = await Promise.race([work(), timeout])
      assertCurrent()
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('request-failed')
      result = config.expectedStatuses.includes(status) ? { state: 'reachable', reason: 'status-expected', status }
        : { state: 'failed', reason: status >= 300 && status < 400 ? 'redirect-blocked' : 'unexpected-status', status }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const allowed: WorkflowConnectorHealthReason[] = ['timeout', 'dns-failed', 'egress-blocked', 'credential-unavailable', 'credential-scope-denied', 'target-changed', 'configuration-invalid']
      const reason: WorkflowConnectorHealthReason = allowed.includes(code as WorkflowConnectorHealthReason) ? code as WorkflowConnectorHealthReason : 'request-failed'
      result = { state: ['timeout', 'dns-failed', 'request-failed'].includes(reason) ? 'failed' : 'blocked', reason }
    } finally { if (timer !== undefined) clearTimeout(timer) }
    if (this.target(query)?.key !== target.key) return { ...query, state: 'blocked', reason: 'target-changed' }
    const observedAt = this.now()
    const evidence: WorkflowConnectorHealthEvidence = { ...query, releaseId: target.release.id, ...result, observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(observedAt + ttlMs).toISOString(), durationMs: Math.max(0, Date.now() - start) }
    this.cache.set(identityOf(query), { key: target.key, evidence })
    return evidence
  }
}

function identityOf(query: WorkflowConnectorHealthQuery): string { return JSON.stringify([query.workflowId, query.environmentId, query.connectorId]) }
function pathAllowed(path: string, prefixes: string[]): boolean { return prefixes.some((prefix) => { const normalized = prefix.replace(/\/$/u, ''); return path === normalized || path.startsWith(`${normalized}/`) }) }
function validateQuery(query: unknown, connector: boolean): asserts query is WorkflowConnectorHealthQuery {
  const keys = connector ? ['workflowId', 'environmentId', 'connectorId'] : ['workflowId', 'environmentId']
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !keys.includes(key))
    || keys.some((key) => typeof (query as Record<string, unknown>)[key] !== 'string' || !ID.test((query as Record<string, string>)[key]!))) throw new Error('invalid-query')
}
