import { describe, expect, it, vi } from 'vitest'
import { WorkflowMcpClient, normalizeMcpToolResult, parseMcpToolReference, type WorkflowMcpServer } from '../../src/main/workflow/workflow-mcp-client.js'

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
      diagnostic: 'MCP 工具返回失败结果。',
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
    expect((rejection as Error).message.length).toBeLessThanOrEqual('MCP 工具调用失败：'.length + 2_000)
  })
})
