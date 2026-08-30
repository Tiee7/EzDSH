import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'
import type { AddressInfo } from 'node:net'
import QRCode from 'qrcode'
import {
  DshSessionClient,
  type DshModelSelection,
  type DshSessionModels,
  type DshSessionHistoryResponse,
  type DshSessionSummary,
  type DshWorkspaceSummary,
} from '../channel-bridge/dsh-session.js'
import type {
  MobileDeviceSnapshot,
  MobilePendingPairing,
  MobileRemoteSnapshot,
  MobileRemoteStatus,
} from '../../shared/mobile-remote.js'
import { renderMobileLandingPage, renderMobilePage, renderPairingPage, type MobilePageLocale } from './mobile-pages.js'

const MAX_BODY_BYTES = 1024 * 1024
const PAIRING_TTL_MS = 5 * 60 * 1000
const PENDING_RETENTION_MS = 2 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const COOKIE_NAME = 'ezdsh_mobile'

interface MobileRuntimeClient {
  listWorkspaces(): Promise<DshWorkspaceSummary[]>
  listSessions(): Promise<DshSessionSummary[]>
  createSession(params?: { workspaceId?: string }): Promise<{ sessionId: string }>
  getSessionModels(sessionId: string): Promise<DshSessionModels>
  selectSessionModel(sessionId: string, selection: DshModelSelection): Promise<{ selected: DshModelSelection }>
  queuePrompt(sessionId: string, text: string): Promise<{ accepted: true }>
  cancelSession(sessionId: string): Promise<void>
  getSessionHistory(sessionId: string, options?: { maxMessages?: number }): Promise<DshSessionHistoryResponse>
}

interface PersistedDevice {
  id: string
  tokenHash: string
  label: string
  createdAt: string
  lastSeenAt: string
  expiresAt: number
}

interface PendingPairingRecord extends MobilePendingPairing {
  sessionId?: string
  sessionToken?: string
  settledAt?: number
}

interface PairingChallenge {
  token: string
  expiresAt: number
  url: string
  qrDataUrl: string
}

export interface MobileRemoteOptions {
  statePath: string
  getRuntimeUrl(): string | undefined
  appIconPath?: string
  getLocale?: () => string
  port?: number
  createClient?: (runtimeUrl: string) => MobileRuntimeClient
  getLanAddresses?: () => string[]
  tunnelCommand?: string
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface MobileMessage {
  role: 'user' | 'assistant'
  text: string
  seq: number
}

export class MobileRemoteService {
  private server: ReturnType<typeof createServer> | undefined
  private boundPort: number | undefined
  private status: MobileRemoteStatus = 'stopped'
  private message: string | undefined
  private tunnelProcess: ChildProcess | undefined
  private publicUrl: string | undefined
  private pairingChallenge: PairingChallenge | undefined
  private pendingPairings = new Map<string, PendingPairingRecord>()
  private devices = new Map<string, PersistedDevice>()
  private activeStreams = new Set<() => void>()
  private persistChain: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(private readonly options: MobileRemoteOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const raw = JSON.parse(await readFile(this.options.statePath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return
      const now = Date.now()
      for (const item of raw) {
        if (!isRecord(item)) continue
        if (
          typeof item.id !== 'string' ||
          typeof item.tokenHash !== 'string' ||
          typeof item.label !== 'string' ||
          typeof item.createdAt !== 'string' ||
          typeof item.lastSeenAt !== 'string' ||
          typeof item.expiresAt !== 'number' ||
          item.expiresAt <= now
        ) continue
        this.devices.set(item.id, {
          id: item.id,
          tokenHash: item.tokenHash,
          label: item.label,
          createdAt: item.createdAt,
          lastSeenAt: item.lastSeenAt,
          expiresAt: item.expiresAt,
        })
      }
    } catch {
      // The file is optional on first launch and may be unreadable after a manual cleanup.
    }
  }

  snapshot(): MobileRemoteSnapshot {
    this.cleanupExpired()
    return {
      status: this.status,
      port: this.boundPort,
      lanUrls: this.getLanUrls(),
      publicUrl: this.publicUrl,
      publicAccess: this.tunnelProcess !== undefined && this.publicUrl !== undefined,
      pairing: this.pairingChallenge === undefined || this.pairingChallenge.expiresAt <= Date.now()
        ? { active: false }
        : {
            active: true,
            url: this.pairingChallenge.url,
            qrDataUrl: this.pairingChallenge.qrDataUrl,
            expiresAt: new Date(this.pairingChallenge.expiresAt).toISOString(),
          },
      pendingPairings: [...this.pendingPairings.values()].map(({ sessionId: _sessionId, sessionToken: _sessionToken, settledAt: _settledAt, ...pairing }) => pairing),
      devices: [...this.devices.values()].map(toDeviceSnapshot),
      message: this.message,
    }
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return
    this.status = 'starting'
    this.message = undefined
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          const httpError = error instanceof HttpError ? error : new HttpError(500, error instanceof Error ? error.message : String(error))
          sendJson(response, httpError.status, { error: httpError.message })
        } else if (!response.writableEnded) {
          response.end()
        }
      })
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          const address = server.address() as AddressInfo | null
          if (address === null) {
            reject(new Error('Mobile remote service did not expose a listening address'))
            return
          }
          this.boundPort = address.port
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.options.port ?? 0, '0.0.0.0')
      })
      this.status = 'ready'
    } catch (error) {
      this.server = undefined
      this.boundPort = undefined
      this.status = 'error'
      this.message = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.stopPublicAccess()
    this.pairingChallenge = undefined
    this.pendingPairings.clear()
    for (const close of [...this.activeStreams]) close()
    const server = this.server
    if (server !== undefined) {
      this.server = undefined
      this.boundPort = undefined
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.status = 'stopped'
    this.message = undefined
    await this.persistChain
  }

  async startPairing(): Promise<MobileRemoteSnapshot> {
    await this.start()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    const url = `${this.getPairingBaseUrl()}/pair?token=${encodeURIComponent(token)}`
    const qrDataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 })
    this.pairingChallenge = { token, expiresAt, url, qrDataUrl }
    return this.snapshot()
  }

  cancelPairing(): MobileRemoteSnapshot {
    this.pairingChallenge = undefined
    return this.snapshot()
  }

  approvePairing(requestId: string): MobileRemoteSnapshot {
    const request = this.pendingPairings.get(requestId)
    if (request === undefined || request.status !== 'pending') throw new HttpError(404, 'Pairing request not found')
    if (Date.now() >= Date.parse(request.expiresAt)) {
      request.status = 'rejected'
      request.settledAt = Date.now()
      throw new HttpError(410, 'Pairing request expired')
    }
    const token = randomBytes(32).toString('base64url')
    const now = new Date().toISOString()
    const device: PersistedDevice = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      label: inferDeviceLabel(request.userAgent),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    this.devices.set(device.id, device)
    request.status = 'approved'
    request.sessionId = device.id
    request.sessionToken = token
    request.settledAt = Date.now()
    void this.persistDevices()
    return this.snapshot()
  }

  rejectPairing(requestId: string): MobileRemoteSnapshot {
    const request = this.pendingPairings.get(requestId)
    if (request === undefined || request.status !== 'pending') throw new HttpError(404, 'Pairing request not found')
    request.status = 'rejected'
    request.settledAt = Date.now()
    return this.snapshot()
  }

  disconnectDevice(deviceId: string): MobileRemoteSnapshot {
    this.devices.delete(deviceId)
    void this.persistDevices()
    return this.snapshot()
  }

  async startPublicAccess(): Promise<MobileRemoteSnapshot> {
    await this.start()
    if (this.publicUrl !== undefined && this.tunnelProcess !== undefined) return this.snapshot()
    const port = this.boundPort
    if (port === undefined) throw new Error('Mobile remote service is not listening')
    const command = this.options.tunnelCommand ?? process.env.EZDSH_MOBILE_TUNNEL_COMMAND ?? 'cloudflared'
    const child = (this.options.spawnProcess ?? defaultSpawn)(command, ['tunnel', '--url', `http://127.0.0.1:${String(port)}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.tunnelProcess = child
    child.once('exit', () => {
      if (this.tunnelProcess !== child) return
      this.tunnelProcess = undefined
      this.publicUrl = undefined
      this.message = '公网访问通道已断开，请重新开启。'
    })
    this.message = '正在建立公网访问通道…'

    try {
      this.publicUrl = await waitForTunnelUrl(child)
      this.message = undefined
      return this.snapshot()
    } catch (error) {
      if (this.tunnelProcess === child) this.tunnelProcess = undefined
      this.publicUrl = undefined
      this.message = error instanceof Error ? error.message : String(error)
      child.kill()
      throw error
    }
  }

  async stopPublicAccess(): Promise<MobileRemoteSnapshot> {
    const child = this.tunnelProcess
    this.tunnelProcess = undefined
    this.publicUrl = undefined
    if (child !== undefined && !child.killed) child.kill()
    if (this.status === 'ready') this.message = undefined
    return this.snapshot()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    if (request.method === 'GET' && url.pathname === '/app-icon') {
      if (this.options.appIconPath === undefined) throw new HttpError(404, 'App icon not found')
      const image = await readFile(this.options.appIconPath).catch(() => undefined)
      if (image === undefined) throw new HttpError(404, 'App icon not found')
      response.writeHead(200, {
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': 'image/png',
        'Content-Length': String(image.byteLength),
      })
      response.end(image)
      return
    }

    if (request.method === 'GET' && url.pathname === '/') {
      if (this.readDevice(request) !== undefined) {
        response.writeHead(302, { Location: '/mobile' })
        response.end()
      } else {
        sendHtml(response, renderMobileLandingPage(this.mobileLocale()))
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/pair') {
      this.handlePairRequest(request, response, url.searchParams.get('token'))
      return
    }
    if (request.method === 'GET' && url.pathname === '/pair/status') {
      this.handlePairStatus(request, response, url.searchParams.get('id'))
      return
    }
    if (request.method === 'GET' && url.pathname === '/mobile') {
      this.requireDevice(request)
      sendHtml(response, renderMobilePage({ locale: this.mobileLocale() }))
      return
    }

    if (!url.pathname.startsWith('/api/mobile/')) throw new HttpError(404, 'route not found')
    const device = this.requireDevice(request)
    this.assertSameOrigin(request)

    const streamMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)\/stream$/u)
    if (request.method === 'GET' && streamMatch !== null) {
      this.streamSession(request, response, device, decodePathSegment(streamMatch[1]))
      return
    }

    const body = request.method === 'POST' ? await readJsonBody(request) : undefined

    if (request.method === 'GET' && url.pathname === '/api/mobile/state') {
      sendJson(response, 200, await this.getState())
      return
    }

    const historyMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)\/history$/u)
    if (request.method === 'GET' && historyMatch !== null) {
      const sessionId = decodePathSegment(historyMatch[1])
      const history = await this.getHistory(sessionId)
      this.touchDevice(device)
      sendJson(response, 200, history)
      return
    }

    const modelsMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)\/models$/u)
    if (request.method === 'GET' && modelsMatch !== null) {
      const sessionId = decodePathSegment(modelsMatch[1])
      const models = await this.getClient().getSessionModels(sessionId)
      this.touchDevice(device)
      sendJson(response, 200, models)
      return
    }

    const modelMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)\/model$/u)
    if (request.method === 'POST' && modelMatch !== null) {
      const sessionId = decodePathSegment(modelMatch[1])
      const input = asRecord(body)
      const selection: DshModelSelection = {
        provider: requiredString(input.provider, 'provider', 200),
        model: requiredString(input.model, 'model', 500),
        ...optionalString(input.reasoningEffort) === undefined
          ? {}
          : { reasoningEffort: optionalString(input.reasoningEffort) },
      }
      const result = await this.getClient().selectSessionModel(sessionId, selection)
      this.touchDevice(device)
      sendJson(response, 200, result)
      return
    }

    const promptMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)\/prompt$/u)
    if (request.method === 'POST' && promptMatch !== null) {
      const sessionId = decodePathSegment(promptMatch[1])
      const input = asRecord(body)
      const text = requiredString(input.text, 'text', 20_000)
      const client = this.getClient()
      await client.queuePrompt(sessionId, text)
      this.touchDevice(device)
      sendJson(response, 200, { accepted: true, sessionId })
      return
    }

    const cancelMatch = url.pathname.match(/^\/api\/mobile\/sessions\/([^/]+)\/cancel$/u)
    if (request.method === 'POST' && cancelMatch !== null) {
      const sessionId = decodePathSegment(cancelMatch[1])
      await this.getClient().cancelSession(sessionId)
      this.touchDevice(device)
      sendJson(response, 200, { accepted: true, sessionId })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/mobile/sessions') {
      const input = asRecord(body)
      const workspaceId = optionalString(input.workspaceId)
      const created = await this.getClient().createSession(workspaceId === undefined ? undefined : { workspaceId })
      this.touchDevice(device)
      sendJson(response, 200, created)
      return
    }

    throw new HttpError(404, 'route not found')
  }

  private handlePairRequest(request: IncomingMessage, response: ServerResponse, token: string | null): void {
    const challenge = this.pairingChallenge
    if (challenge === undefined || token === null || challenge.expiresAt <= Date.now() || !safeEqual(token, challenge.token)) {
      throw new HttpError(410, 'Pairing link is invalid or expired')
    }
    const requestId = randomUUID()
    const now = Date.now()
    this.pendingPairings.set(requestId, {
      requestId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      userAgent: headerString(request.headers['user-agent']),
      address: request.socket.remoteAddress,
      status: 'pending',
    })
    this.pairingChallenge = undefined
    sendHtml(response, renderPairingPage(requestId, this.mobileLocale()))
  }

  private handlePairStatus(request: IncomingMessage, response: ServerResponse, requestId: string | null): void {
    if (requestId === null) throw new HttpError(400, 'Pairing request ID is required')
    const pairing = this.pendingPairings.get(requestId)
    if (pairing === undefined) throw new HttpError(404, 'Pairing request not found')
    if (pairing.status === 'pending' && Date.now() >= Date.parse(pairing.expiresAt)) {
      pairing.status = 'rejected'
      pairing.settledAt = Date.now()
    }
    if (pairing.status === 'approved' && pairing.sessionToken !== undefined) {
      const secure = forwardedProtocol(request) === 'https'
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(pairing.sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}${secure ? '; Secure' : ''}`)
      sendJson(response, 200, { status: 'approved', redirect: '/mobile' })
      return
    }
    sendJson(response, 200, { status: pairing.status })
  }

  private async getState(): Promise<{ runtimeReady: boolean; workspaces: DshWorkspaceSummary[]; sessions: DshSessionSummary[] }> {
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) return { runtimeReady: false, workspaces: [], sessions: [] }
    const client = this.getClient()
    const [workspaces, sessions] = await Promise.all([client.listWorkspaces(), client.listSessions()])
    return { runtimeReady: true, workspaces, sessions }
  }

  private async getHistory(sessionId: string): Promise<{
    messages: MobileMessage[]
    events: DshSessionHistoryResponse['events']
    projections?: unknown
    running: boolean
  }> {
    const client = this.getClient()
    const [history, sessions] = await Promise.all([
      client.getSessionHistory(sessionId, { maxMessages: 200 }),
      client.listSessions(),
    ])
    const current = sessions.find((session) => session.sessionId === sessionId)
    return {
      messages: history.events.map(toMobileMessage).filter((message): message is MobileMessage => message !== undefined),
      events: history.events,
      projections: history.projections,
      running: current?.running === true,
    }
  }

  private streamSession(
    request: IncomingMessage,
    response: ServerResponse,
    device: PersistedDevice,
    sessionId: string,
  ): void {
    let closed = false
    let timer: NodeJS.Timeout | undefined
    let lastPayload = ''
    const close = (): void => {
      if (closed) return
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      request.removeListener('close', close)
      this.activeStreams.delete(close)
      if (!response.writableEnded) response.end()
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders()
    this.activeStreams.add(close)
    request.once('close', close)

    const poll = async (): Promise<void> => {
      if (closed) return
      if (!this.devices.has(device.id) || device.expiresAt <= Date.now()) {
        response.write('event: disconnected\ndata: {}\n\n')
        close()
        return
      }

      let nextDelay = 2_200
      try {
        const history = await this.getHistory(sessionId)
        if (closed) return
        const payload = JSON.stringify(history)
        if (payload !== lastPayload) {
          lastPayload = payload
          response.write(`event: snapshot\ndata: ${payload}\n\n`)
        } else {
          response.write(': keep-alive\n\n')
        }
        nextDelay = history.running ? 700 : 2_200
        this.touchDevice(device)
      } catch (error) {
        if (closed) return
        const message = error instanceof Error ? error.message : String(error)
        response.write(`event: status\ndata: ${JSON.stringify({ ok: false, message })}\n\n`)
        nextDelay = 2_500
      }
      if (!closed) timer = setTimeout(() => { void poll() }, nextDelay)
    }

    void poll()
  }

  private getClient(): MobileRuntimeClient {
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) throw new HttpError(503, 'DSH Runtime 尚未启动')
    return (this.options.createClient ?? ((baseUrl: string) => new DshSessionClient({ baseUrl, timeoutMs: 10_000 })))(runtimeUrl)
  }

  private requireDevice(request: IncomingMessage): PersistedDevice {
    const device = this.readDevice(request)
    if (device === undefined) throw new HttpError(401, 'Mobile device is not paired')
    return device
  }

  private readDevice(request: IncomingMessage): PersistedDevice | undefined {
    const raw = parseCookies(request.headers.cookie)[COOKIE_NAME]
    if (raw === undefined) return undefined
    let token: string
    try {
      token = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    const tokenHash = hashToken(token)
    for (const device of this.devices.values()) {
      if (device.expiresAt <= Date.now()) continue
      if (safeEqual(tokenHash, device.tokenHash)) return device
    }
    return undefined
  }

  private touchDevice(device: PersistedDevice): void {
    if (Date.now() - Date.parse(device.lastSeenAt) < 60_000) return
    const now = new Date().toISOString()
    device.lastSeenAt = now
    device.expiresAt = Date.now() + SESSION_TTL_MS
    void this.persistDevices()
  }

  private assertSameOrigin(request: IncomingMessage): void {
    const origin = headerString(request.headers.origin)
    if (origin === undefined) return
    const host = headerString(request.headers['x-forwarded-host']) ?? headerString(request.headers.host)
    if (host === undefined) throw new HttpError(403, 'Origin is not allowed')
    const expected = `${forwardedProtocol(request)}://${host.split(',')[0]?.trim() ?? host}`
    try {
      if (new URL(origin).origin !== expected) throw new HttpError(403, 'Origin is not allowed')
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(403, 'Origin is not allowed')
    }
  }

  private getPairingBaseUrl(): string {
    if (this.publicUrl !== undefined) return this.publicUrl
    return this.getLanUrls()[0] ?? `http://127.0.0.1:${String(this.boundPort ?? 0)}`
  }

  private mobileLocale(): MobilePageLocale {
    return this.options.getLocale?.() === 'en' ? 'en' : 'zh'
  }

  private getLanUrls(): string[] {
    if (this.boundPort === undefined) return []
    const addresses = this.options.getLanAddresses?.() ?? defaultLanAddresses()
    const urls = addresses.map((address) => `http://${formatHost(address)}:${String(this.boundPort)}`)
    return urls.length > 0 ? urls : [`http://127.0.0.1:${String(this.boundPort)}`]
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [id, device] of this.devices) {
      if (device.expiresAt <= now) this.devices.delete(id)
    }
    for (const [id, pairing] of this.pendingPairings) {
      if ((pairing.settledAt !== undefined && pairing.settledAt + PENDING_RETENTION_MS <= now) || Date.parse(pairing.expiresAt) + PENDING_RETENTION_MS <= now) {
        this.pendingPairings.delete(id)
      }
    }
    if (this.pairingChallenge !== undefined && this.pairingChallenge.expiresAt <= now) this.pairingChallenge = undefined
  }

  private async persistDevices(): Promise<void> {
    const records = [...this.devices.values()]
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 })
      await writeFile(this.options.statePath, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600 })
    }).catch(() => undefined)
    await this.persistChain
  }
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, options)
}

function waitForTunnelUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timeout = setTimeout(() => finish(new Error('公网访问通道启动超时，请确认已安装 cloudflared 并可在 PATH 中找到。')), 20_000)
    const finish = (error?: Error, url?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error !== undefined) reject(error)
      else if (url !== undefined) resolve(url)
      else reject(new Error('公网访问通道未返回可用地址'))
    }
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      const match = output.match(/https:\/\/[a-z0-9.-]+\.trycloudflare\.com/iu)
      if (match?.[0] !== undefined) finish(undefined, match[0])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (!settled) finish(new Error(code === 127 ? '未找到 cloudflared，请先安装后重试。' : `公网访问通道已退出（code=${String(code)}）`))
    })
  })
}

function toMobileMessage(entry: { event: { type: string; seq: number; data: unknown } }): MobileMessage | undefined {
  const type = entry.event.type
  const role = type === 'assistant/message' ? 'assistant' : type.startsWith('user/') ? 'user' : undefined
  if (role === undefined) return undefined
  const text = readMessageText(entry.event.data)
  return text === '' ? undefined : { role, text, seq: entry.event.seq }
}

function readMessageText(data: unknown): string {
  if (!isRecord(data)) return ''
  const message = isRecord(data.message) ? data.message : data
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!isRecord(block)) return ''
    return typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : ''
  }).join('')
}

function toDeviceSnapshot(device: PersistedDevice): MobileDeviceSnapshot {
  return { id: device.id, label: device.label, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(html)
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
}

function parseCookies(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {}
  return Object.fromEntries(raw.split(';').flatMap((part) => {
    const separator = part.indexOf('=')
    if (separator < 0) return []
    return [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]]
  }))
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function defaultLanAddresses(): string[] {
  const result: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      if (!result.includes(entry.address)) result.push(entry.address)
    }
  }
  return result
}

function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

function forwardedProtocol(request: IncomingMessage): string {
  return (headerString(request.headers['x-forwarded-proto']) ?? 'http').split(',')[0]?.trim() === 'https' ? 'https' : 'http'
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, 'Request body must be an object')
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 500) throw new HttpError(400, 'Invalid string value')
  return value
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new HttpError(400, `${name} must be a non-empty string under ${String(maxLength)} characters`)
  }
  return value.trim()
}

function decodePathSegment(value: string | undefined): string {
  if (value === undefined) throw new HttpError(400, 'Invalid path')
  try {
    const decoded = decodeURIComponent(value)
    if (decoded === '' || decoded.includes('/') || decoded.includes('\\')) throw new Error('invalid path')
    return decoded
  } catch {
    throw new HttpError(400, 'Invalid path')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inferDeviceLabel(userAgent: string | undefined): string {
  if (userAgent === undefined) return '手机浏览器'
  if (/iPhone|iPad/iu.test(userAgent)) return 'Apple 设备'
  if (/Android/iu.test(userAgent)) return 'Android 设备'
  return '手机浏览器'
}
