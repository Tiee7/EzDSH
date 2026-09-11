import { describe, expect, it, vi } from 'vitest'
import { WorkflowMcpClient, WorkflowMcpToolError, normalizeMcpToolResult, parseMcpToolReference, type WorkflowMcpServer } from '../../src/main/workflow/workflow-mcp-client.js'

const MCP_ERROR_PREFIX = 'MCP 工具调用失败：'
const MCP_ERROR_FALLBACK = 'MCP 工具返回失败结果。'

function captureMcpToolError(result: unknown): WorkflowMcpToolError {
  try {
    normalizeMcpToolResult(result)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowMcpToolError)
    return error as WorkflowMcpToolError
  }
  throw new Error('Expected normalizeMcpToolResult() to throw')
}

describe('workflow MCP client', () => {
  it('parses the public MCP naming convention without exposing a DSH session', () => {
    expect(parseMcpToolReference('mcp__calendar__create_event')).toEqual({ serverName: 'calendar', toolName: 'create_event' })
    expect(parseMcpToolReference('calendar::create_event')).toEqual({ serverName: 'calendar', toolName: 'create_event' })
    expect(() => parseMcpToolReference('create_event')).toThrow('MCP 工具名')
  })

  it('calls a configured server with JSON arguments and preserves structured content', async () => {
    const server: WorkflowMcpServer = { serverName: 'calendar', transport: 'streamable-http', url: 'https://mcp.example', headers: { Authorization: 'Bearer test' } }
    const callImpl = vi.fn(async (_server: WorkflowMcpServer, toolName: string, args: Record<string, unknown>) => {
      expect(toolName).toBe('create_event')
      expect(args).toEqual({ title: 'Planning', attendees: ['a@example.com'] })
      return { structuredContent: { id: 'event-1', created: true }, content: [] }
    })
    const client = new WorkflowMcpClient({ loadServers: async () => [server], callImpl })

    await expect(client.call('mcp__calendar__create_event', { title: 'Planning', attendees: ['a@example.com'] })).resolves.toEqual({ id: 'event-1', created: true })
    expect(callImpl).toHaveBeenCalledTimes(1)
  })

  it('normalizes text-only MCP responses into workflow-safe values', () => {
    expect(normalizeMcpToolResult({ content: [{ type: 'text', text: 'done' }] })).toBe('done')
    expect(normalizeMcpToolResult({ content: [{ type: 'text', text: '{"id":"42"}' }] })).toEqual({ id: '42' })
  })

  it.each([
    {
      name: 'text content',
      result: { isError: true, content: [{ type: 'text', text: `permission denied ${'x'.repeat(2_100)}` }] },
      diagnostic: 'permission denied',
    },
    {
      name: 'structured content',
      result: { isError: true, structuredContent: { code: 'permission_denied', retryable: false }, content: [] },
      diagnostic: '{"code":"permission_denied","retryable":false}',
    },
    {
      name: 'empty result',
      result: { isError: true, content: [] },
      diagnostic: MCP_ERROR_FALLBACK,
    },
  ])('rejects explicit MCP errors with bounded diagnostics from $name', async ({ result, diagnostic }) => {
    const client = new WorkflowMcpClient({
      loadServers: async () => [{ serverName: 'calendar', transport: 'streamable-http', url: 'https://mcp.example' }],
      callImpl: async () => result,
    })

    let rejection: unknown
    try {
      await client.call('calendar::create_event', {})
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({ name: 'WorkflowMcpToolError' })
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain(diagnostic)
    expect((rejection as Error).message.length).toBeLessThanOrEqual(MCP_ERROR_PREFIX.length + 2_000)
  })

  it.each([
    {
      name: 'a throwing structured-content toJSON',
      result: () => {
        const structuredContent = { code: 'permission_denied' }
        Object.defineProperty(structuredContent, 'toJSON', {
          enumerable: false,
          value: () => { throw new Error('untrusted toJSON escaped') },
        })
        return { isError: true, structuredContent, content: [] }
      },
    },
    {
      name: 'circular structured content',
      result: () => {
        const structuredContent: Record<string, unknown> = { code: 'circular' }
        structuredContent.self = structuredContent
        return { isError: true, structuredContent, content: [] }
      },
    },
    {
      name: 'a throwing text-content accessor',
      result: () => {
        const part = Object.defineProperty({}, 'type', {
          enumerable: true,
          get: () => { throw new Error('untrusted text accessor escaped') },
        })
        return { isError: true, structuredContent: { code: 'ignored_after_extraction_failure' }, content: [part] }
      },
    },
  ])('falls back safely for $name without leaking the original exception', ({ result }) => {
    const error = captureMcpToolError(result())

    expect(error.message).toBe(`${MCP_ERROR_PREFIX}${MCP_ERROR_FALLBACK}`)
    expect(error.message).not.toContain('escaped')
  })

  it('ignores blank text diagnostics and prefers valid structured content', () => {
    const structured = captureMcpToolError({
      isError: true,
      structuredContent: { code: 'permission_denied', retryable: false },
      content: [{ type: 'text', text: '   ' }, { type: 'text', text: '\n\t' }],
    })
    const empty = captureMcpToolError({
      isError: true,
      content: [{ type: 'text', text: '   \n\t' }],
    })

    expect(structured.message).toBe(`${MCP_ERROR_PREFIX}{"code":"permission_denied","retryable":false}`)
    expect(empty.message).toBe(`${MCP_ERROR_PREFIX}${MCP_ERROR_FALLBACK}`)
  })

  it('bounds only the diagnostic body to 2,000 UTF-16 code units', () => {
    const diagnostic = `${'a'.repeat(1_999)}😀tail`
    const error = captureMcpToolError({ isError: true, content: [{ type: 'text', text: diagnostic }] })
    const body = error.message.slice(MCP_ERROR_PREFIX.length)

    expect(body).toBe(diagnostic.slice(0, 2_000))
    expect(body).toHaveLength(2_000)
    expect(error.message).toHaveLength(MCP_ERROR_PREFIX.length + 2_000)
  })
})
