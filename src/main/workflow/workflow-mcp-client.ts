import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { parse } from 'yaml'
import { isWorkflowValue, type WorkflowValue } from '../../shared/workflow.js'

export interface WorkflowMcpServer {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export interface WorkflowMcpClientOptions {
  patchPath?: string
  loadServers?: () => Promise<WorkflowMcpServer[]>
  callImpl?: (server: WorkflowMcpServer, toolName: string, argumentsValue: Record<string, WorkflowValue>) => Promise<unknown>
}

export interface McpToolReference {
  serverName: string
  toolName: string
}

/** Calls an installed MCP server directly, without a DSH coding-session prompt. */
export class WorkflowMcpClient {
  private readonly loadServers: () => Promise<WorkflowMcpServer[]>
  private readonly callImpl: NonNullable<WorkflowMcpClientOptions['callImpl']>

  constructor(options: WorkflowMcpClientOptions) {
    this.loadServers = options.loadServers ?? (() => loadMcpServersFromPatch(options.patchPath ?? ''))
    this.callImpl = options.callImpl ?? callConfiguredMcpTool
  }

  async call(tool: string, argumentsValue: Record<string, WorkflowValue>): Promise<WorkflowValue> {
    const reference = parseMcpToolReference(tool)
    const server = (await this.loadServers()).find((candidate) => candidate.serverName === reference.serverName)
    if (server === undefined) throw new Error(`未找到已安装的 MCP 服务：${reference.serverName}`)
    return normalizeMcpToolResult(await this.callImpl(server, reference.toolName, argumentsValue))
  }
}

/** Supports existing model-facing names and the unambiguous `server::tool` form. */
export function parseMcpToolReference(value: string): McpToolReference {
  const trimmed = value.trim()
  const modelFacing = /^mcp__([A-Za-z0-9_-]+)__(.+)$/u.exec(trimmed)
  const explicit = /^([A-Za-z0-9_-]+)::(.+)$/u.exec(trimmed)
  const match = modelFacing ?? explicit
  if (match === null || match[1] === undefined || match[2] === undefined || match[2].trim() === '') {
    throw new Error('MCP 工具名应使用 mcp__服务名__工具名 或 服务名::工具名。')
  }
  return { serverName: match[1], toolName: match[2].trim() }
}

export function normalizeMcpToolResult(result: unknown): WorkflowValue {
  const record = asMap(result)
  if (record !== undefined && isWorkflowValue(record.structuredContent)) return record.structuredContent
  const texts = (Array.isArray(record?.content) ? record.content : [])
    .map((part) => asMap(part))
    .filter((part): part is Record<string, unknown> => part !== undefined && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
  if (texts.length > 0) {
    const joined = texts.join('\n')
    try {
      const parsed = JSON.parse(joined) as unknown
      if (isWorkflowValue(parsed)) return parsed
    } catch {
      // Text results are valid workflow output too.
    }
    return joined
  }
  if (isWorkflowValue(result)) return result
  return JSON.stringify(result)
}

export async function loadMcpServersFromPatch(patchPath: string): Promise<WorkflowMcpServer[]> {
  if (patchPath === '') return []
  let document: unknown
  try {
    document = parse(await readFile(patchPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!Array.isArray(document)) return []
  const servers: WorkflowMcpServer[] = []
  for (const row of document) {
    const inserts = asMap(row)?.insert
    if (!Array.isArray(inserts)) continue
    for (const entry of inserts) {
      const item = asMap(entry)
      if (item?.name !== '@deepseek-ai/dsh-mcp-client' || item.disabled === true) continue
      const config = asMap(item.config)
      const serverName = typeof config?.serverName === 'string' ? config.serverName.trim() : ''
      if (serverName === '') continue
      if (config?.transport === 'stdio' && typeof config.command === 'string' && config.command.trim() !== '') {
        servers.push({
          serverName, transport: 'stdio', command: config.command,
          args: readStringArray(config.args), env: readStringMap(config.env),
          ...(typeof config.cwd === 'string' && config.cwd.trim() !== '' ? { cwd: config.cwd } : {}),
        })
      }
      if (config?.transport === 'streamable-http' && typeof config.url === 'string' && config.url.trim() !== '') {
        servers.push({ serverName, transport: 'streamable-http', url: config.url, headers: readStringMap(config.headers) })
      }
    }
  }
  return servers
}

async function callConfiguredMcpTool(server: WorkflowMcpServer, toolName: string, argumentsValue: Record<string, WorkflowValue>): Promise<unknown> {
  const client = new Client({ name: 'ezdsh-workflow', version: '1.0.0' })
  const transport = server.transport === 'stdio'
    ? new StdioClientTransport({
      command: server.command ?? '', args: server.args ?? [], cwd: server.cwd,
      env: { ...getDefaultEnvironment(), ...server.env },
    })
    : new StreamableHTTPClientTransport(new URL(server.url ?? ''), { requestInit: { headers: server.headers } })
  try {
    await client.connect(transport)
    return await client.request({ method: 'tools/call', params: { name: toolName, arguments: argumentsValue } }, CallToolResultSchema, { timeout: 120_000 })
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readStringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(asMap(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
