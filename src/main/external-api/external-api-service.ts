import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DshSessionClient, type DshSession, type DshSessionSummary, type DshWorkspaceSummary } from '../channel-bridge/dsh-session.js'
import type {
  ExternalDispatchRequest,
  ExternalDispatchResponse,
  ExternalProject,
  ExternalSessionCreateRequest,
  ExternalRunRequest,
} from '../../shared/external-api.js'
import { ExternalRunService, type ExternalRunServiceLike } from './external-run-service.js'

const MAX_BODY_BYTES = 1024 * 1024

interface ExternalApiClient {
  listWorkspaces(): Promise<DshWorkspaceSummary[]>
  listSessions(): Promise<DshSessionSummary[]>
  createWorkspace(path: string): Promise<{ workspace: DshWorkspaceSummary; created: boolean }>
  renameWorkspace(workspaceId: string, title: string): Promise<{ workspace: DshWorkspaceSummary }>
  createSession(params?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<DshSession>
  queuePrompt(sessionId: string, text: string): Promise<{ accepted: true }>
}

export interface ExternalApiOptions {
  getRuntimeUrl(): string | undefined
  port?: number
  createClient?: (runtimeUrl: string) => ExternalApiClient
  runService?: ExternalRunServiceLike
  createRunService?: (runtimeUrl: string) => ExternalRunServiceLike
  runStatePath?: string
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export class ExternalApiService {
  private server: ReturnType<typeof createServer> | undefined
  private boundPort: number | undefined
  private runService: ExternalRunServiceLike | undefined
  private runServiceRuntimeUrl: string | undefined

  constructor(private readonly options: ExternalApiOptions) {}

  get url(): string {
    if (this.boundPort === undefined) throw new Error('External API is not started')
    return `http://127.0.0.1:${String(this.boundPort)}`
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return

    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        this.server = undefined
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        const address = server.address() as AddressInfo | null
        if (address === null) {
          this.server = undefined
          reject(new Error('External API did not expose a listening address'))
          return
        }
        this.boundPort = address.port
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.options.port ?? 53260, '127.0.0.1')
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    this.boundPort = undefined
    await this.runService?.flush?.()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setCorsHeaders(response)

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const runEventsMatch = request.url?.match(/^\/api\/external\/v1\/runs\/([^/]+)\/events$/u)
    if (request.method === 'GET' && runEventsMatch !== null && runEventsMatch !== undefined) {
      await this.handleRunEvents(request, response, decodeURIComponent(runEventsMatch[1] ?? ''))
      return
    }

    try {
      const url = new URL(request.url ?? '/', this.url)
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined
      const result = await this.route(request.method ?? 'GET', url.pathname, body)
      const status = request.method === 'POST' && url.pathname === '/api/external/v1/runs' ? 202 : 200
      sendJson(response, status, result)
    } catch (error) {
      const httpError = error instanceof HttpError
        ? error
        : new HttpError(500, error instanceof Error ? error.message : String(error))
      sendJson(response, httpError.status, { error: httpError.message })
    }
  }

  private async route(method: string, pathname: string, body: unknown): Promise<unknown> {
    if (method === 'GET' && pathname === '/api/external/v1/health') {
      return { ok: true, runtimeReady: this.options.getRuntimeUrl() !== undefined }
    }

    if (method === 'POST' && pathname === '/api/external/v1/runs') {
      const runService = await this.getRunServiceReady()
      return runService.create(parseRunRequest(body))
    }

    const runMatch = pathname.match(/^\/api\/external\/v1\/runs\/([^/]+)$/u)
    if (runMatch !== null && method === 'GET') {
      const snapshot = (await this.getRunServiceReady()).get(decodeURIComponent(runMatch[1] ?? ''))
      if (snapshot === undefined) throw new HttpError(404, 'Run not found')
      return snapshot
    }

    const cancelMatch = pathname.match(/^\/api\/external\/v1\/runs\/([^/]+)\/cancel$/u)
    if (cancelMatch !== null && method === 'POST') {
      try {
        return (await this.getRunServiceReady()).cancel(decodeURIComponent(cancelMatch[1] ?? ''))
      } catch (error) {
        if (error instanceof Error && error.message === 'Run not found') throw new HttpError(404, error.message)
        throw error
      }
    }

    const client = this.getClient()

    if (method === 'GET' && pathname === '/api/external/v1/projects') {
      return this.listProjects(client)
    }

    if (method === 'POST' && pathname === '/api/external/v1/projects') {
      const input = asRecord(body)
      const path = requiredString(input.path, 'path')
      const created = await client.createWorkspace(path)
      let workspace = created.workspace
      const title = optionalString(input.title)
      if (title !== undefined && title !== workspace.title) {
        workspace = (await client.renameWorkspace(workspace.workspaceId, title)).workspace
      }
      return toProject(workspace, [])
    }

    if (method === 'POST' && pathname === '/api/external/v1/sessions') {
      return this.createSession(client, body)
    }

    const promptMatch = pathname.match(/^\/api\/external\/v1\/sessions\/([^/]+)\/prompts$/u)
    if (method === 'POST' && promptMatch !== null) {
      const input = asRecord(body)
      const prompt = requiredString(input.text, 'text')
      const sessionId = decodeURIComponent(promptMatch[1] ?? '')
      await client.queuePrompt(sessionId, prompt)
      return { accepted: true, sessionId }
    }

    if (method === 'POST' && pathname === '/api/external/v1/dispatch') {
      return this.dispatch(client, body)
    }

    throw new HttpError(404, 'route not found')
  }

  private getClient(): ExternalApiClient {
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) throw new HttpError(503, 'DSH Runtime 尚未启动')
    return (this.options.createClient ?? ((baseUrl: string) => new DshSessionClient({ baseUrl, timeoutMs: 10_000 })))(runtimeUrl)
  }

  private getRunService(): ExternalRunServiceLike {
    if (this.options.runService !== undefined) return this.options.runService
    const runtimeUrl = this.options.getRuntimeUrl()
    if (runtimeUrl === undefined) throw new HttpError(503, 'DSH Runtime 尚未启动')
    if (this.runService === undefined || this.runServiceRuntimeUrl !== runtimeUrl) {
      this.runService = (this.options.createRunService ?? ((baseUrl: string) => new ExternalRunService({
        createClient: () => new DshSessionClient({ baseUrl, timeoutMs: 10 * 60 * 1000 }),
        statePath: this.options.runStatePath,
      })))(runtimeUrl)
      this.runServiceRuntimeUrl = runtimeUrl
    }
    return this.runService
  }

  private async getRunServiceReady(): Promise<ExternalRunServiceLike> {
    const service = this.getRunService()
    await service.initialize?.()
    return service
  }

  private async handleRunEvents(request: IncomingMessage, response: ServerResponse, runId: string): Promise<void> {
    try {
      const service = await this.getRunServiceReady()
      const snapshot = service.get(runId)
      if (snapshot === undefined) {
        sendJson(response, 404, { error: 'Run not found' })
        return
      }

      const header = request.headers['last-event-id']
      const parsed = Number(Array.isArray(header) ? header[0] : header ?? '0')
      const afterEventId = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      response.flushHeaders()

      let closed = false
      let heartbeat: NodeJS.Timeout | undefined
      let unsubscribe = () => {}
      const close = (): void => {
        if (closed) return
        closed = true
        unsubscribe()
        if (heartbeat !== undefined) clearInterval(heartbeat)
        if (!response.writableEnded) response.end()
      }
      request.once('close', close)
      const writeEvent = (event: { id: number; type: string; data: Record<string, unknown> }): void => {
        if (closed || response.writableEnded) return
        response.write(`id: ${String(event.id)}\n`)
        response.write(`event: ${event.type}\n`)
        response.write(`data: ${JSON.stringify(event.data)}\n\n`)
      }
      unsubscribe = service.subscribe(runId, afterEventId, writeEvent)

      const current = service.get(runId)
      if (current !== undefined && isTerminalRunStatus(current.status)) {
        close()
        return
      }
      heartbeat = setInterval(() => {
        if (!closed && !response.writableEnded) response.write(': keep-alive\n\n')
      }, 15_000)
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof HttpError ? error.status : 500
        sendJson(response, status, { error: error instanceof Error ? error.message : String(error) })
      } else if (!response.writableEnded) {
        response.end()
      }
    }
  }

  private async listProjects(client: ExternalApiClient): Promise<ExternalProject[]> {
    const [workspaces, sessions] = await Promise.all([client.listWorkspaces(), client.listSessions()])
    const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]))
    return workspaces.map((workspace) => toProject(
      workspace,
      workspace.sessionIds.flatMap((sessionId) => {
        const session = sessionsById.get(sessionId)
        return session === undefined ? [] : [session]
      }),
    ))
  }

  private async createSession(client: ExternalApiClient, body: unknown): Promise<{ sessionId: string; projectId?: string }> {
    const input = asRecord(body) as ExternalSessionCreateRequest
    const projectId = optionalString(input.projectId)
    const cwd = optionalString(input.cwd)
    if (projectId !== undefined && cwd !== undefined) {
      throw new HttpError(400, 'projectId and cwd cannot be used together')
    }
    if (projectId === undefined && cwd === undefined && optionalString(input.sessionId) === undefined) {
      throw new HttpError(400, 'projectId or cwd is required')
    }

    if (projectId !== undefined) {
      const workspaces = await client.listWorkspaces()
      if (!workspaces.some((workspace) => workspace.workspaceId === projectId)) {
        throw new HttpError(404, 'DSH project not found')
      }
    }

    const session = await client.createSession({
      workspaceId: projectId,
      cwd,
      sessionId: optionalString(input.sessionId),
    })
    return projectId === undefined ? { sessionId: session.sessionId } : { sessionId: session.sessionId, projectId }
  }

  private async dispatch(client: ExternalApiClient, body: unknown): Promise<ExternalDispatchResponse> {
    const input = asRecord(body) as Partial<ExternalDispatchRequest>
    const projectId = requiredString(input.projectId, 'projectId')
    const prompt = requiredString(input.prompt, 'prompt')
    const sessionMode = input.sessionMode
    if (sessionMode !== 'new' && sessionMode !== 'existing') {
      throw new HttpError(400, 'sessionMode must be new or existing')
    }

    const workspaces = await client.listWorkspaces()
    const project = workspaces.find((workspace) => workspace.workspaceId === projectId)
    if (project === undefined) throw new HttpError(404, 'DSH project not found')

    let sessionId: string
    if (sessionMode === 'new') {
      sessionId = (await client.createSession({ workspaceId: projectId })).sessionId
    } else {
      const requestedSessionId = requiredString(input.sessionId, 'sessionId')
      if (!project.sessionIds.includes(requestedSessionId)) {
        throw new HttpError(404, 'DSH session is not in the selected project')
      }
      sessionId = requestedSessionId
    }

    await client.queuePrompt(sessionId, prompt)
    return { accepted: true, projectId, sessionId, sessionMode }
  }

  private setCorsHeaders(response: ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
}

function toProject(workspace: DshWorkspaceSummary, sessions: DshSessionSummary[]): ExternalProject {
  return {
    id: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
    sessionIds: [...workspace.sessionIds],
    sessions,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value)
  if (result === undefined) throw new HttpError(400, `${name} is required`)
  return result
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result === '' ? undefined : result
}

function parseRunRequest(body: unknown): ExternalRunRequest {
  const input = asRecord(body)
  const prompt = requiredString(input.prompt, 'prompt')
  const sessionMode = input.sessionMode
  if (sessionMode !== undefined && sessionMode !== 'new' && sessionMode !== 'existing') {
    throw new HttpError(400, 'sessionMode must be new or existing')
  }
  const projectId = optionalString(input.projectId)
  const normalizedSessionMode = sessionMode === undefined ? 'new' : sessionMode
  if (normalizedSessionMode === 'new' && projectId === undefined) {
    throw new HttpError(400, 'projectId is required for a new Run')
  }
  const output = input.output === undefined ? undefined : asRecord(input.output)
  const format = output?.format
  if (format !== undefined && format !== 'text' && format !== 'json') {
    throw new HttpError(400, 'output.format must be text or json')
  }
  const client = input.client === undefined ? undefined : asRecord(input.client)
  return {
    projectId,
    sessionMode: normalizedSessionMode,
    sessionId: optionalString(input.sessionId),
    prompt,
    archiveSession: input.archiveSession === true,
    output: format === undefined ? undefined : { format },
    client: client === undefined
      ? undefined
      : { name: optionalString(client.name), requestId: optionalString(client.requestId) },
  }
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'request body must be valid JSON')
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(payload)
}
