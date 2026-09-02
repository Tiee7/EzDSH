import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type {
  WorkflowConnectorGrant,
  WorkflowConnectorOperation,
  WorkflowCredentialMetadata,
  WorkflowCredentialScope,
  WorkflowHttpConnector,
  WorkflowHttpMethod,
  WorkflowHttpResponseMode,
  WorkflowPermissionPolicy,
  WorkflowValue,
} from '../../shared/workflow.js'
import { WorkflowCredentialStore } from './workflow-credential-service.js'
import { WorkflowConnectorStore } from './workflow-connector-store.js'

export interface WorkflowConnectorRequest {
  connectorId: string
  connectorPath: string
  method: WorkflowHttpMethod
  headers?: Record<string, string>
  query?: Record<string, unknown>
  body?: unknown
  responseMode?: WorkflowHttpResponseMode
  timeoutMs?: number
  /** A stable key supplied by the run; write requests receive it as a header. */
  idempotencyKey?: string
  /** Saved workflow permission declaration. Missing policy is deny-by-default. */
  workflowPolicy?: WorkflowPermissionPolicy
  /** Optional per-run grant, which can only narrow the saved policy. */
  runGrant?: WorkflowConnectorGrant[]
}

export interface WorkflowConnectorResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: WorkflowValue
}

export interface WorkflowConnectorServiceOptions {
  connectors: WorkflowConnectorStore
  credentials: WorkflowCredentialStore
  /** Injectable for tests and environments with a custom resolver. */
  resolveHost?: (hostname: string) => Promise<Array<{ address: string }>>
  fetchImpl?: typeof fetch
  maxResponseBytes?: number
}

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
])
const SENSITIVE_RESPONSE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
])
const SAFE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/u

/**
 * Managed HTTP connector executor. URL construction, egress, permission and
 * credential checks all happen in the main process immediately before fetch.
 */
export class WorkflowConnectorService {
  private readonly resolveHost: (hostname: string) => Promise<Array<{ address: string }>>
  private readonly fetchImpl: typeof fetch
  private readonly maxResponseBytes: number

  constructor(private readonly options: WorkflowConnectorServiceOptions) {
    this.resolveHost = options.resolveHost ?? (async (hostname) => {
      return lookup(hostname, { all: true, verbatim: true })
    })
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxResponseBytes = Math.max(1_024, Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 50 * 1024 * 1024))
  }

  /** Validate URL, egress, permission and credential scope without dispatching. */
  async authorize(request: WorkflowConnectorRequest, input: WorkflowValue = null, previous: WorkflowValue = null): Promise<void> {
    await this.prepare(request, input, previous)
  }

  /** Descriptive alias used by integrations that treat connectors as actions. */
  async executeHttp(request: WorkflowConnectorRequest, input: WorkflowValue = null, previous: WorkflowValue = null, parentSignal?: AbortSignal): Promise<WorkflowConnectorResponse> {
    return this.request(request, input, previous, parentSignal)
  }

  async request(
    request: WorkflowConnectorRequest,
    input: WorkflowValue = null,
    previous: WorkflowValue = null,
    parentSignal?: AbortSignal,
  ): Promise<WorkflowConnectorResponse> {
    const prepared = await this.prepare(request, input, previous)
    const { url, method, headers, resolvedBody, credential } = prepared
    const requestInit: RequestInit = {
      method,
      headers,
      redirect: 'error',
    }
    if (resolvedBody !== undefined && method !== 'GET') {
      if (typeof resolvedBody === 'string') requestInit.body = resolvedBody
      else {
        requestInit.body = JSON.stringify(resolvedBody)
        if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
      }
    }
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (parentSignal?.aborted === true) controller.abort()
    parentSignal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), clampTimeout(request.timeoutMs))
    try {
      let response: Response
      try {
        response = await this.fetchImpl(url, { ...requestInit, signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted) throw new Error(parentSignal?.aborted === true ? '连接器请求已取消。' : '连接器请求超时。')
        // Do not return a native fetch error: its message can contain a URL
        // with caller-controlled query values and would leak into run history.
        throw new Error('连接器请求失败。')
      }
      const text = await readResponseText(response, this.maxResponseBytes)
      const responseHeaders = redactHeaders(response.headers, credential?.secret)
      const body = parseBody(text, response, request.responseMode ?? 'auto', credential?.secret)
      if (!response.ok) {
        const detail = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)
        throw new Error(`连接器请求失败（${response.status}）：${detail}`)
      }
      return { status: response.status, ok: response.ok, headers: responseHeaders, body }
    } finally {
      clearTimeout(timeout)
      parentSignal?.removeEventListener('abort', onAbort)
    }
  }

  private async prepare(request: WorkflowConnectorRequest, input: WorkflowValue, previous: WorkflowValue): Promise<PreparedConnectorRequest> {
    const connector = this.options.connectors.get(request.connectorId)
    if (connector === undefined) throw new Error(`未找到连接器：${request.connectorId}`)
    const method = request.method.toUpperCase() as WorkflowHttpMethod
    assertMethod(method)
    const operation = method === 'GET' ? 'read' : 'write'
    assertPermission(request.workflowPolicy, request.runGrant, connector.id, operation)
    const url = await this.resolveUrl(connector, request.connectorPath)
    const credential = connector.credentialRef === undefined
      ? undefined
      : await this.resolveCredential(connector, url, method)
    const headers = this.buildHeaders(request.headers, credential, method, request.idempotencyKey, input, previous)
    const query = resolveTemplate(request.query, input, previous)
    if (query !== undefined) appendQuery(url, query)
    const resolvedBody = request.body === undefined ? undefined : resolveTemplate(request.body, input, previous)
    return { connector, url, method, headers, resolvedBody, credential }
  }

  private async resolveUrl(connector: WorkflowHttpConnector, connectorPath: string): Promise<URL> {
    const base = parseBaseUrl(connector.baseUrl)
    await assertPublicHost(base.hostname, this.resolveHost)
    assertRelativePath(connectorPath)
    const decodedPath = decodePath(connectorPath)
    const decodedRelativePath = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`
    // Treat connectorPath as a path inside the connector base. A leading /
    // is cosmetic and never changes the origin or escapes a base pathname.
    const url = new URL(connectorPath.replace(/^\//u, ''), base)
    if (url.origin !== base.origin) throw new Error('连接器请求不能跨越 Base URL 的来源。')
    const relativePath = connectorRelativePath(base, url)
    if (!isAllowedPath(relativePath, connector.allowedPathPrefixes) || !isAllowedPath(decodedRelativePath, connector.allowedPathPrefixes)) throw new Error('连接器请求路径不在允许范围内。')
    return url
  }

  private async resolveCredential(connector: WorkflowHttpConnector, url: URL, method: WorkflowHttpMethod): Promise<ResolvedCredential> {
    const credentialRef = connector.credentialRef
    if (credentialRef === undefined) throw new Error('连接器未配置凭证。')
    const credential = await this.options.credentials.resolve(credentialRef.id)
    if (credential === undefined) throw new Error(`未找到凭证：${credentialRef.id}`)
    const scope = credential.metadata.scopes.find((candidate) => scopeAllows(candidate, url, method))
    if (scope === undefined) throw new Error('凭证访问范围不允许当前连接器请求。')
    return { ...credential, scope }
  }

  private buildHeaders(
    configured: Record<string, string> | undefined,
    credential: ResolvedCredential | undefined,
    method: WorkflowHttpMethod,
    idempotencyKey: string | undefined,
    input: WorkflowValue,
    previous: WorkflowValue,
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(configured ?? {})) {
      if (!SAFE_HEADER_NAME.test(name) || /[\u0000-\u001f\u007f\u0080-\u009f]/u.test(value)) throw new Error('连接器请求头无效。')
      if (SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase())) throw new Error(`连接器请求不允许自带敏感请求头：${name}`)
      const resolved = resolveTemplate(value, input, previous)
      if (typeof resolved !== 'string') throw new Error('连接器请求头值必须是字符串。')
      headers[name] = resolved
    }
    if (credential !== undefined) {
      const scope = credential.scope
      const value = credential.metadata.type === 'bearer-token'
        ? `${scope.prefix ?? 'Bearer'} ${credential.secret}`
        : `${scope.prefix ?? ''}${credential.secret}`
      headers[scope.headerName] = value
    }
    if (method !== 'GET' && idempotencyKey !== undefined) {
      if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error('幂等键格式无效。')
      headers['Idempotency-Key'] = idempotencyKey
    }
    return headers
  }
}

function connectorRelativePath(base: URL, url: URL): string {
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  if (basePath === '' || basePath === '/') return url.pathname
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) throw new Error('连接器请求路径不能离开 Base URL 路径。')
  return url.pathname.slice(basePath.length) || '/'
}

interface PreparedConnectorRequest {
  connector: WorkflowHttpConnector
  url: URL
  method: WorkflowHttpMethod
  headers: Record<string, string>
  resolvedBody: unknown
  credential?: ResolvedCredential
}

interface ResolvedCredential {
  metadata: WorkflowCredentialMetadata
  secret: string
  scope: WorkflowCredentialScope
}

/** Compatibility export for callers that used the old HTTP connector name. */
export { WorkflowConnectorService as WorkflowHttpConnector }

export function assertPermission(
  policy: WorkflowPermissionPolicy | undefined,
  grants: WorkflowConnectorGrant[] | undefined,
  connectorId: string,
  operation: WorkflowConnectorOperation,
): void {
  const permission = policy?.connectors?.find((candidate) => candidate.connectorId === connectorId)
  if (permission === undefined || !permission.operations.includes(operation)) throw new Error(`工作流未授权连接器 ${connectorId} 的 ${operation} 操作。`)
  if (grants !== undefined) {
    const grant = grants.find((candidate) => candidate.connectorId === connectorId)
    if (grant === undefined || !grant.operations.includes(operation)) throw new Error(`本次运行未授予连接器 ${connectorId} 的 ${operation} 操作。`)
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('连接器 Base URL 无效。') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new Error('连接器只允许不含凭据的 HTTPS Base URL。')
  if (url.pathname !== '/' && !url.pathname.endsWith('/')) throw new Error('连接器 Base URL 路径必须以 / 结尾。')
  return url
}

function assertMethod(value: string): asserts value is WorkflowHttpMethod {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value)) throw new Error('连接器请求方法无效。')
}

function assertRelativePath(path: string): void {
  if (typeof path !== 'string' || path === '' || path.startsWith('//') || path.includes('\\') || path.includes('://') || path.includes('?') || path.includes('#')) throw new Error('连接器路径必须是安全的同源相对路径。')
  if (path.split('/').includes('..')) throw new Error('连接器路径不能包含路径穿越。')
  const decoded = decodePath(path)
  if (decoded.split('/').includes('..') || decoded.startsWith('//') || decoded.includes('\\')) throw new Error('连接器路径不能包含编码路径穿越。')
}

function decodePath(path: string): string {
  try { return decodeURIComponent(path) } catch { throw new Error('连接器路径编码无效。') }
}

function isAllowedPath(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    return pathname === normalized || pathname.startsWith(`${normalized}/`)
  })
}

async function assertPublicHost(hostname: string, resolver: (hostname: string) => Promise<Array<{ address: string }>>): Promise<void> {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (isPrivateHostname(lower) || isPrivateAddress(lower)) throw new Error('连接器目标地址属于本机、内网或链路本地地址。')
  let addresses: Array<{ address: string }>
  try {
    addresses = await resolver(hostname)
  } catch {
    throw new Error('连接器目标地址无法解析，已拒绝请求。')
  }
  if (addresses.length === 0) throw new Error('连接器目标地址无法解析，已拒绝请求。')
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('连接器目标解析到了本机、内网或链路本地地址。')
}

function isPrivateHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a >= 224
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
    if (mappedIpv4 !== undefined) return isPrivateAddress(mappedIpv4)
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
  }
  return false
}

function appendQuery(url: URL, query: unknown): void {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw new Error('连接器查询参数必须是 JSON 对象。')
  for (const [key, value] of Object.entries(query)) {
    if (/[\r\n]/u.test(key) || !isWorkflowValueLike(value)) throw new Error('连接器查询参数无效。')
    url.searchParams.set(key, renderScalar(value))
  }
}

function resolveTemplate(value: unknown, input: WorkflowValue, previous: WorkflowValue): any {
  if (typeof value === 'string') {
    if (value.trim() === '{{input}}') return cloneJson(input)
    if (value.trim() === '{{value}}') return cloneJson(previous)
    const variables: Record<string, unknown> = {
      input,
      value: previous,
      ...(isObject(previous) ? previous : {}),
    }
    return value
      .replaceAll('{{input}}', renderScalar(input))
      .replaceAll('{{value}}', renderScalar(previous))
      .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/gu, (token, path: string) => {
        const [name, ...parts] = path.split('.')
        const root = name === undefined ? undefined : variables[name]
        const selected = root === undefined ? undefined : parts.reduce<unknown>((current, key) => isObject(current) ? current[key] : undefined, root)
        return selected === undefined ? token : renderScalar(selected)
      })
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, input, previous))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, input, previous)]))
  return value
}

function scopeAllows(scope: WorkflowCredentialScope, url: URL, method: WorkflowHttpMethod): boolean {
  if (scope.origin !== url.origin || !scope.methods.includes(method)) return false
  if (scope.pathPrefixes === undefined || scope.pathPrefixes.length === 0) return true
  return isAllowedPath(url.pathname, scope.pathPrefixes)
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('连接器响应超过大小限制。')
    return text
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('连接器响应超过大小限制。')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseBody(text: string, response: Response, mode: WorkflowHttpResponseMode, secret?: string): WorkflowValue {
  const redacted = redactValue(text, secret)
  if (mode === 'text') return redacted
  if (mode === 'json' || response.headers.get('content-type')?.toLowerCase().includes('application/json') === true) {
    try { return redactValue(JSON.parse(text) as WorkflowValue, secret) }
    catch { if (mode === 'json') throw new Error('连接器响应不是有效 JSON。') }
  }
  return redacted
}

function redactHeaders(headers: Headers, secret?: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    if (SENSITIVE_RESPONSE_HEADERS.has(name.toLowerCase())) continue
    result[name] = redactString(value, secret)
  }
  return result
}

function redactValue(value: unknown, secret?: string): any {
  if (typeof value === 'string') return redactString(value, secret)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, any> = {}
    for (const [key, item] of Object.entries(value)) {
      if (/(?:authorization|cookie|token|secret|password|api[-_]?key)/iu.test(key)) result[key] = '[REDACTED]'
      else result[key] = redactValue(item, secret)
    }
    return result
  }
  return value
}

function redactString(value: string, secret?: string): string {
  return secret === undefined || secret === '' ? value : value.split(secret).join('[REDACTED]')
}

function clampTimeout(timeoutMs: number | undefined): number {
  return Math.max(1_000, Math.min(timeoutMs ?? 120_000, 10 * 60 * 1_000))
}

function isWorkflowValueLike(value: unknown): value is WorkflowValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isWorkflowValueLike)
  return typeof value === 'object' && value !== null && Object.values(value).every(isWorkflowValueLike)
}

function renderScalar(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
