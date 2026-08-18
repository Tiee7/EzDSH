import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ChannelAdapter } from './types.js'

export interface ChannelBridgeServerOptions {
  port: number
  adapters: Map<string, ChannelAdapter>
}

export class ChannelBridgeServer {
  private server?: Server

  constructor(private readonly options: ChannelBridgeServerOptions) {}

  async start(): Promise<void> {
    if (this.server !== undefined) return

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.options.port, '127.0.0.1', () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === undefined) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = undefined
        resolve()
      })
    })
  }

  get port(): number {
    return this.options.port
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    const adapter = this.resolveAdapter(url)
    if (adapter === undefined) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unknown adapter route' }))
      return
    }

    try {
      const body = await readJsonBody(req)

      if ('challenge' in (body as Record<string, unknown>)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ challenge: (body as Record<string, string>).challenge }))
        return
      }

      // Cast to FeishuAdapter; in the future this dispatch should be generic.
      const feishu = adapter as unknown as {
        handleWebhook(payload: unknown): Promise<{ challenge?: string; reply?: unknown }>
      }
      const result = await feishu.handleWebhook(body)

      if (result.challenge !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ challenge: result.challenge }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
  }

  private resolveAdapter(url: string): ChannelAdapter | undefined {
    const match = /^\/webhook\/([a-z0-9-]+)$/i.exec(url)
    if (match === null) return undefined
    return this.options.adapters.get(match[1])
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}
