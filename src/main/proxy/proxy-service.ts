import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProxyAgent, request } from 'undici'
import {
  PROXY_PROTOCOLS,
  type ProxyProfile,
  type ProxyProfileInput,
  type ProxyProtocol,
  type ProxySettingsSnapshot,
  type ProxyTestResult,
} from '../../shared/proxy.js'

interface StoredProxyProfile {
  id: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  bypass: string[]
}

interface PersistedProxyDocument {
  activeProxyId?: string
  profiles: StoredProxyProfile[]
}

interface ProxyServiceOptions {
  configPath: string
  applyRuntime: () => Promise<void>
  requestImpl?: typeof request
  testUrl?: string
  testTimeoutMs?: number
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const
const LOOPBACK_BYPASS = ['127.0.0.1', 'localhost', '::1']
const DEFAULT_PROXY_TEST_URL = 'https://example.com/'
const DEFAULT_PROXY_TEST_TIMEOUT_MS = 10_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === 'string' && (PROXY_PROTOCOLS as readonly string[]).includes(value)
}

function normalizedBypass(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(entries
    .flatMap((entry) => String(entry).split(/[\r\n,]/u))
    .map((entry) => entry.trim())
    .filter(Boolean))]
}

function readPort(value: unknown): number | undefined {
  const port = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

function normalizeStoredProfile(value: unknown): StoredProxyProfile | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === 'string' && value.id.trim() !== '' ? value.id.trim() : undefined
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const protocol = isProxyProtocol(value.protocol) ? value.protocol : undefined
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  const port = readPort(value.port)
  if (id === undefined || name === '' || protocol === undefined || host === '' || port === undefined) return undefined
  return {
    id,
    name,
    protocol,
    host,
    port,
    ...(typeof value.username === 'string' && value.username.trim() !== '' ? { username: value.username.trim() } : {}),
    ...(typeof value.password === 'string' && value.password !== '' ? { password: value.password } : {}),
    bypass: normalizedBypass(value.bypass),
  }
}

function validateHost(host: string): void {
  if (host === '' || /[\s/@\\?#]/u.test(host) || host.includes('://')) {
    throw new Error('代理地址无效')
  }
}

function normalizeInput(input: ProxyProfileInput, existing?: StoredProxyProfile): StoredProxyProfile {
  if (!isProxyProtocol(input.protocol)) throw new Error('代理协议无效')
  const name = input.name.trim()
  if (name === '') throw new Error('代理名称不能为空')
  const host = input.host.trim()
  validateHost(host)
  const port = readPort(input.port)
  if (port === undefined) throw new Error('代理端口必须是 1 到 65535 之间的整数')

  const id = input.id?.trim() || existing?.id || randomUUID()
  const password = input.password !== undefined && input.password !== ''
    ? input.password
    : existing?.password
  const username = input.username?.trim() || undefined
  if (password !== undefined && username === undefined) {
    throw new Error('配置代理密码时必须填写用户名')
  }
  const profile: StoredProxyProfile = {
    id,
    name,
    protocol: input.protocol,
    host,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    bypass: normalizedBypass(input.bypass),
  }
  try {
    proxyUrl(profile)
  } catch {
    throw new Error('代理地址无效')
  }
  return profile
}

function proxyUrl(profile: StoredProxyProfile): string {
  const host = profile.host.includes(':') && !profile.host.startsWith('[')
    ? `[${profile.host}]`
    : profile.host
  const url = new URL(`${profile.protocol}://${host}:${String(profile.port)}`)
  if (profile.username !== undefined) url.username = profile.username
  if (profile.password !== undefined) url.password = profile.password
  return url.toString()
}

function publicProfile(profile: StoredProxyProfile): ProxyProfile {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    ...(profile.username === undefined ? {} : { username: profile.username }),
    passwordConfigured: profile.password !== undefined,
    bypass: [...profile.bypass],
  }
}

/** Persist and apply the single active DSH Runtime proxy without exposing credentials to the renderer. */
export class ProxyService {
  private state: PersistedProxyDocument = { profiles: [] }
  private initialized = false
  private operationChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: ProxyServiceOptions) {}

  async initialize(): Promise<void> {
    const document = await this.readDocument()
    this.state = document
    this.initialized = true
  }

  snapshot(): ProxySettingsSnapshot {
    this.assertInitialized()
    const activeProxyId = this.state.activeProxyId
    return {
      ...(activeProxyId === undefined ? {} : { activeProxyId }),
      enabled: activeProxyId !== undefined,
      profiles: this.state.profiles.map(publicProfile),
    }
  }

  getRuntimeEnvironment(baseEnvironment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    this.assertInitialized()
    const environment = { ...baseEnvironment }
    for (const key of PROXY_ENV_KEYS) delete environment[key]

    const active = this.activeProfile()
    if (active === undefined) return environment

    const url = proxyUrl(active)
    const bypass = [...new Set([...LOOPBACK_BYPASS, ...active.bypass])].join(',')
    environment.HTTP_PROXY = url
    environment.HTTPS_PROXY = url
    environment.ALL_PROXY = url
    environment.NO_PROXY = bypass
    environment.NODE_USE_ENV_PROXY = '1'
    return environment
  }

  save(input: ProxyProfileInput): Promise<ProxySettingsSnapshot> {
    return this.enqueue(async () => {
      this.assertInitialized()
      const existing = input.id === undefined ? undefined : this.state.profiles.find((profile) => profile.id === input.id)
      const profile = normalizeInput(input, existing)
      const wasActive = this.state.activeProxyId === profile.id
      const index = this.state.profiles.findIndex((candidate) => candidate.id === profile.id)
      if (index < 0) this.state.profiles.push(profile)
      else this.state.profiles[index] = profile
      await this.persist()
      if (wasActive) await this.options.applyRuntime()
      return this.snapshot()
    })
  }

  activate(id: string | undefined): Promise<ProxySettingsSnapshot> {
    return this.enqueue(async () => {
      this.assertInitialized()
      if (id !== undefined && !this.state.profiles.some((profile) => profile.id === id)) {
        throw new Error('找不到要启用的代理')
      }
      if (this.state.activeProxyId === id) return this.snapshot()
      this.state.activeProxyId = id
      await this.persist()
      await this.options.applyRuntime()
      return this.snapshot()
    })
  }

  async test(id: string): Promise<ProxyTestResult> {
    this.assertInitialized()
    const profile = this.state.profiles.find((candidate) => candidate.id === id)
    if (profile === undefined) throw new Error('找不到要测试的代理')

    const agent = new ProxyAgent(proxyUrl(profile))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.testTimeoutMs ?? DEFAULT_PROXY_TEST_TIMEOUT_MS)
    try {
      const response = await (this.options.requestImpl ?? request)(this.options.testUrl ?? DEFAULT_PROXY_TEST_URL, {
        method: 'GET',
        dispatcher: agent,
        signal: controller.signal,
        headers: { 'user-agent': 'EzDSH proxy test' },
      })
      await response.body.dump({ limit: 1_024, signal: controller.signal })
      const reachable = response.statusCode >= 200 && response.statusCode < 500 && response.statusCode !== 407
      return {
        reachable,
        statusCode: response.statusCode,
        ...(reachable ? {} : { error: `代理返回 HTTP ${String(response.statusCode)}` }),
      }
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? error.message : '代理连接失败',
      }
    } finally {
      clearTimeout(timeout)
      await agent.close().catch(() => undefined)
    }
  }

  remove(id: string): Promise<ProxySettingsSnapshot> {
    return this.enqueue(async () => {
      this.assertInitialized()
      const previousLength = this.state.profiles.length
      this.state.profiles = this.state.profiles.filter((profile) => profile.id !== id)
      if (this.state.profiles.length === previousLength) return this.snapshot()
      const wasActive = this.state.activeProxyId === id
      if (wasActive) this.state.activeProxyId = undefined
      await this.persist()
      if (wasActive) await this.options.applyRuntime()
      return this.snapshot()
    })
  }

  private activeProfile(): StoredProxyProfile | undefined {
    return this.state.activeProxyId === undefined
      ? undefined
      : this.state.profiles.find((profile) => profile.id === this.state.activeProxyId)
  }

  private async readDocument(): Promise<PersistedProxyDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.options.configPath, 'utf8')) as unknown
      if (!isRecord(parsed)) return { profiles: [] }
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.map(normalizeStoredProfile).filter((profile): profile is StoredProxyProfile => profile !== undefined)
        : []
      const activeProxyId = typeof parsed.activeProxyId === 'string'
        && profiles.some((profile) => profile.id === parsed.activeProxyId)
        ? parsed.activeProxyId
        : undefined
      return { ...(activeProxyId === undefined ? {} : { activeProxyId }), profiles }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [] }
      throw error
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.configPath), { recursive: true, mode: 0o700 })
    await writeFile(this.options.configPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    await chmod(this.options.configPath, 0o600)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation)
    this.operationChain = run.then(() => undefined, () => undefined)
    return run
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('代理服务尚未初始化')
  }
}
