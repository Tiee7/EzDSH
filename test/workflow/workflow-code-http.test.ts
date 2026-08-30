import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunService } from '../../src/main/workflow/workflow-run-service.js'
import { WorkflowRunStore } from '../../src/main/workflow/workflow-run-store.js'
import { WorkflowStore } from '../../src/main/workflow/workflow-store.js'
import type { WorkflowNode } from '../../src/shared/workflow.js'

afterEach(() => vi.unstubAllGlobals())

async function runNode(node: WorkflowNode, input: unknown, options: { allowCode?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ezdsh-workflow-code-http-'))
  const workflowStore = new WorkflowStore(directory)
  const workflow = await workflowStore.create({
    id: `workflow-${node.id}`,
    name: node.label,
    description: '',
    nodes: [
      { id: 'input', type: 'input', label: 'Input', config: {}, position: { x: 0, y: 0 } },
      node,
      { id: 'output', type: 'output', label: 'Output', config: {}, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'edge-input', source: 'input', target: node.id },
      { id: 'edge-output', source: node.id, target: 'output' },
    ],
  })
  const service = new WorkflowRunService({
    workflowStore,
    runStore: new WorkflowRunStore(directory),
    workspaceRoot: directory,
    createClient: () => ({ createSession: async () => ({ sessionId: 'unused' }), sendPrompt: async () => ({ text: 'unused' }) }),
    resolveEmployee: () => undefined,
    lightweightClient: { complete: async () => 'unused' },
    mcpClient: { call: async () => 'unused' },
  })
  const record = await service.start(workflow.id, input, options)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = service.get(record.id)
    if (current !== undefined && ['completed', 'failed', 'cancelled'].includes(current.status)) return current
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('run did not finish in time')
}

describe('workflow HTTP and code nodes', () => {
  it('runs Node.js code with input and previous values when explicitly authorized', async () => {
    const result = await runNode({ id: 'node-code', type: 'code', label: 'Node code', config: { language: 'nodejs', code: 'return { doubled: input.value * 2 };', timeoutMs: 10_000 }, position: { x: 200, y: 0 } }, { value: 21 }, { allowCode: true })
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ doubled: 42 })
  })

  it('runs Python3 code and blocks code nodes without explicit authorization', async () => {
    const blocked = await runNode({ id: 'python-code', type: 'code', label: 'Python code', config: { language: 'python3', code: 'result = {"answer": input["value"] + 1}', timeoutMs: 10_000 }, position: { x: 200, y: 0 } }, { value: 2 })
    expect(blocked.status).toBe('failed')
    expect(blocked.error).toContain('代码节点需要运行时显式授权')
    const allowed = await runNode({ id: 'python-code', type: 'code', label: 'Python code', config: { language: 'python3', code: 'result = {"answer": input["value"] + 1}', timeoutMs: 10_000 }, position: { x: 200, y: 0 } }, { value: 2 }, { allowCode: true })
    expect(allowed.status).toBe('completed')
    expect(allowed.output).toEqual({ answer: 3 })
  })

  it('calls an HTTP API, resolves query/body templates, and parses JSON responses', async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/search?term=%7B%22topic%22%3A%22workflow%22%7D')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ topic: 'workflow' }))
      return new Response(JSON.stringify({ items: ['ok'] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await runNode({ id: 'http', type: 'http', label: 'HTTP', config: { method: 'POST', url: 'https://api.example.com/search', headers: { 'X-Test': '{{value}}' }, query: { term: '{{value}}' }, body: '{{value}}', responseMode: 'json', timeoutMs: 10_000 }, position: { x: 200, y: 0 } }, { topic: 'workflow' })
    expect(result.status).toBe('completed')
    expect(result.output).toMatchObject({ status: 200, ok: true, body: { items: ['ok'] } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
