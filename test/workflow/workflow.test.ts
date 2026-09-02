import { describe, expect, it } from 'vitest'
import { createDefaultWorkflow, createWorkflowExportDocument, formatWorkflowValidationIssues, normalizeWorkflow, parseWorkflowExportDocument, validateWorkflow, type WorkflowNode } from '../../src/shared/workflow.js'

describe('workflow contract', () => {
  it('creates a valid starter graph', () => {
    const workflow = createDefaultWorkflow('Starter')
    expect(validateWorkflow(workflow)).toMatchObject({ valid: true, issues: [] })
    expect(workflow.schemaVersion).toBe(2)
    expect(workflow.nodes.map((node) => node.type)).toEqual(['input', 'ai-task', 'output'])
    expect(workflow.nodes[0]).toMatchObject({ type: 'input', label: '开始' })
    expect(workflow.nodes.at(-1)).toMatchObject({ type: 'output', label: '结束', config: { contentMode: 'variable' } })
    expect(workflow.nodes[1]).toMatchObject({
      type: 'ai-task',
      label: '智能处理',
      config: { mode: 'single', outputMode: 'text', skillIds: [] },
    })
  })

  it('requires the fixed start and end nodes', () => {
    const workflow = createDefaultWorkflow('Fixed terminals')
    const start = workflow.nodes.find((node) => node.type === 'input')!
    const end = workflow.nodes.find((node) => node.type === 'output')!

    const withoutStart = validateWorkflow({ ...workflow, nodes: workflow.nodes.filter((node) => node.type !== 'input') })
    const withoutEnd = validateWorkflow({ ...workflow, nodes: workflow.nodes.filter((node) => node.type !== 'output') })
    const withDuplicateStart = validateWorkflow({ ...workflow, nodes: [...workflow.nodes, { ...start, id: 'duplicate-start' }] })
    const withDuplicateEnd = validateWorkflow({ ...workflow, nodes: [...workflow.nodes, { ...end, id: 'duplicate-end' }] })

    expect(withoutStart.issues.some((issue) => issue.message.includes('开始节点'))).toBe(true)
    expect(withoutEnd.issues.some((issue) => issue.message.includes('结束节点'))).toBe(true)
    expect(withDuplicateStart.issues.some((issue) => issue.message.includes('只能包含一个开始节点'))).toBe(true)
    expect(withDuplicateEnd.issues.some((issue) => issue.message.includes('只能包含一个结束节点'))).toBe(true)
  })

  it('requires structural loop body and continuation ports', () => {
    const workflow = createDefaultWorkflow('Structural loop')
    const start = workflow.nodes.find((node) => node.type === 'input')!
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!
    const end = { ...workflow.nodes.find((node) => node.type === 'output')!, inputBindings: [] }
    const loop = { ...aiTask, id: 'loop', type: 'loop' as const, label: '循环遍历', config: { maxIterations: 5 }, position: { x: 220, y: 0 } }
    const body = { ...aiTask, id: 'body', label: '循环体', position: { x: 220, y: 160 } }
    const valid = validateWorkflow({ ...workflow, nodes: [start, loop, body, end], edges: [
      { id: 'start-loop', source: start.id, target: loop.id },
      { id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' },
      { id: 'loop-next', source: loop.id, target: end.id, sourcePort: 'loop-next' },
    ] })
    expect(valid).toMatchObject({ valid: true, issues: [] })
    const portable = createWorkflowExportDocument({ ...workflow, nodes: [start, loop, body, end], edges: [
      { id: 'start-loop', source: start.id, target: loop.id },
      { id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' },
      { id: 'loop-next', source: loop.id, target: end.id, sourcePort: 'loop-next' },
    ] }, '2026-08-31T00:00:00.000Z')
    expect(parseWorkflowExportDocument(JSON.parse(JSON.stringify(portable))).workflow.nodes.find((node) => node.id === 'loop')?.config).toEqual({ maxIterations: 5 })

    const missingBody = validateWorkflow({ ...workflow, nodes: [start, loop, body, end], edges: [
      { id: 'start-loop', source: start.id, target: loop.id },
      { id: 'loop-next', source: loop.id, target: end.id, sourcePort: 'loop-next' },
    ] })
    expect(missingBody.issues.some((issue) => issue.message.includes('下方的循环体节点'))).toBe(true)
  })

  it('validates switch case ports and its default branch', () => {
    const workflow = createDefaultWorkflow('Switch')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const output = { ...workflow.nodes.find((node) => node.type === 'output')!, inputBindings: [] }
    const route = { id: 'route', type: 'switch' as const, label: '路由', config: { cases: [{ id: 'yes', label: '是', value: 'yes' }, { id: 'no', label: '否', value: 'no' }] }, position: { x: 240, y: 0 } }
    const yes = { ...workflow.nodes.find((node) => node.type === 'ai-task')!, id: 'yes-handler', position: { x: 480, y: -100 }, inputBindings: [] }
    const valid = validateWorkflow({ ...workflow, nodes: [input, route, yes, output], edges: [
      { id: 'input-route', source: input.id, target: route.id },
      { id: 'route-yes', source: route.id, target: yes.id, sourcePort: 'switch:yes' },
      { id: 'route-no', source: route.id, target: output.id, sourcePort: 'switch:no' },
      { id: 'route-default', source: route.id, target: output.id, sourcePort: 'default' },
      { id: 'yes-output', source: yes.id, target: output.id },
    ] })
    expect(valid).toMatchObject({ valid: true, issues: [] })

    const missingDefault = validateWorkflow({ ...workflow, nodes: [input, route, yes, output], edges: [
      { id: 'input-route', source: input.id, target: route.id },
      { id: 'route-yes', source: route.id, target: yes.id, sourcePort: 'switch:yes' },
      { id: 'route-no', source: route.id, target: output.id, sourcePort: 'switch:no' },
      { id: 'yes-output', source: yes.id, target: output.id },
    ] })
    expect(missingDefault.issues.some((issue) => issue.message.includes('default'))).toBe(true)
  })

  it('normalizes legacy and custom end-node output content', () => {
    const workflow = createDefaultWorkflow('Output content')
    const raw = JSON.parse(JSON.stringify(workflow)) as { nodes: Array<{ type: string; config: Record<string, unknown> }> }
    const output = raw.nodes.find((node) => node.type === 'output')!
    output.config = { contentMode: 'text', text: '自定义完成文案' }

    expect(normalizeWorkflow(raw)?.nodes.find((node) => node.type === 'output')).toMatchObject({
      config: { contentMode: 'text', text: '自定义完成文案' },
    })

    output.config = {}
    expect(normalizeWorkflow(raw)?.nodes.find((node) => node.type === 'output')).toMatchObject({
      config: { contentMode: 'variable' },
    })
  })

  it('preserves structured input fields for multi-parameter workflows', () => {
    const workflow = normalizeWorkflow({
      id: 'structured-input',
      name: 'Structured input',
      nodes: [{
        id: 'start',
        type: 'input',
        label: '开始输入',
        config: {
          fields: [
            { name: 'topic', label: '主题', type: 'string', required: true },
            { name: 'audience', label: '受众', type: 'string', required: false, defaultValue: '产品经理' },
          ],
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    })

    expect(workflow?.nodes[0]).toMatchObject({
      config: {
        fields: [
          { name: 'topic', label: '主题', type: 'string', required: true },
          { name: 'audience', label: '受众', type: 'string', required: false, defaultValue: '产品经理' },
        ],
      },
    })
  })

  it('round-trips the versioned JSON export envelope', () => {
    const workflow = createDefaultWorkflow('Portable workflow')
    const document = createWorkflowExportDocument(workflow, '2026-08-31T00:00:00.000Z')

    expect(document).toMatchObject({
      format: 'ezdsh.workflow',
      formatVersion: 1,
      exportedAt: '2026-08-31T00:00:00.000Z',
    })
    expect(parseWorkflowExportDocument(JSON.parse(JSON.stringify(document)))).toMatchObject({ workflow })
  })

  it('rejects malformed or unsupported workflow JSON before persistence', () => {
    expect(() => parseWorkflowExportDocument({})).toThrow('Workflow JSON')
    expect(() => parseWorkflowExportDocument({ format: 'ezdsh.workflow', formatVersion: 99, exportedAt: '2026-08-31T00:00:00.000Z', workflow: {} })).toThrow('文件版本')

    const workflow = createDefaultWorkflow('Invalid portable workflow')
    const malformedNodeDocument = createWorkflowExportDocument({
      ...workflow,
      nodes: [...workflow.nodes, { id: 'unknown', type: 'not-a-node', label: 'Unknown', config: {}, position: { x: 0, y: 0 } } as never],
    })
    expect(() => parseWorkflowExportDocument(malformedNodeDocument)).toThrow('Schema V2 节点')

    const document = createWorkflowExportDocument({
      ...workflow,
      nodes: workflow.nodes.map((node, index) => index === 1
        ? { ...node, config: { ...node.config, instruction: '' } } as never
        : node),
    })
    expect(() => parseWorkflowExportDocument(document)).toThrow('不能为空')
  })

  it('bundles referenced employee profiles and validates them on import', () => {
    const workflow = createDefaultWorkflow('Employee workflow')
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!
    const employee = {
      id: 'finance-analyst',
      name: '财务分析师',
      role: '财务研究专员',
      description: '分析财务数据。',
      businessBoundary: '只做客观分析。',
      systemPrompt: '你是一名财务研究专员。',
      operatingGuidelines: ['核对数据来源。'],
      qualityStandards: ['结论可复核。'],
      capabilities: ['research'] as const,
      skillIds: [],
      enabled: true,
    }
    const employeeWorkflow = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === aiTask.id
        ? { ...node, type: 'employee', config: { employeeId: employee.id, instruction: '分析上游数据。', outputMode: 'text' } } as never
        : node),
    }
    const document = createWorkflowExportDocument(employeeWorkflow, '2026-08-31T00:00:00.000Z', [{
      ...employee,
      schemaVersion: 2,
      version: 1,
      builtIn: false,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    }])

    expect(document.employees).toEqual([employee])
    expect(parseWorkflowExportDocument(JSON.parse(JSON.stringify(document)))).toMatchObject({ workflow: employeeWorkflow, employees: [employee] })
    expect(() => parseWorkflowExportDocument({ ...document, employees: [{ ...employee, capabilities: ['not-supported'] }] })).toThrow('capabilities')
  })

  it('migrates a V1 Agent node to a V2 AI task', () => {
    const workflow = normalizeWorkflow({
      schemaVersion: 1,
      id: 'legacy-agent',
      name: 'Legacy',
      nodes: [{
        id: 'agent-1',
        type: 'agent',
        label: 'Agent',
        config: { instruction: '总结输入', systemPrompt: '保持简洁' },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    })

    expect(workflow).toMatchObject({ schemaVersion: 2 })
    expect(workflow?.nodes[0]).toMatchObject({
      type: 'ai-task',
      label: '智能处理',
      config: {
        instruction: '总结输入',
        systemPrompt: '保持简洁',
        mode: 'single',
        outputMode: 'text',
        skillIds: [],
      },
    })
  })

  it('validates professional employee configuration', () => {
    const workflow = createDefaultWorkflow('V2')
    workflow.nodes.push({
      id: 'employee-1',
      type: 'employee',
      label: '专业员工',
      config: { employeeId: '', instruction: '完成任务', outputMode: 'json' },
      position: { x: 0, y: 0 },
    } as never)

    const invalid = validateWorkflow(workflow)
    expect(invalid.issues.some((issue) => issue.message.includes('员工'))).toBe(true)
  })

  it('normalizes unknown persisted nodes away and rejects unsafe graph documents', () => {
    const workflow = normalizeWorkflow({
      id: 'workflow-test',
      name: 'Unsafe',
      nodes: [
        { id: 'a', type: 'agent', label: 'A', config: { instruction: 'x' }, position: { x: 0, y: 0 } },
        { id: 'bad', type: 'not-a-node', label: 'bad', config: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'loop', source: 'a', target: 'a' }],
    })
    expect(workflow?.nodes).toHaveLength(1)
    expect(workflow?.nodes[0]?.type).toBe('ai-task')
    expect(validateWorkflow(workflow!)).toMatchObject({ valid: false })
    expect(validateWorkflow(workflow!).issues.some((issue) => issue.message.includes('循环'))).toBe(true)
  })

  it('rejects executable control characters and absolute file paths', () => {
    const workflow = createDefaultWorkflow('Security')
    workflow.nodes.push(
      { id: 'shell', type: 'shell', label: 'Shell', config: { command: 'echo; rm', args: [] }, position: { x: 0, y: 0 } },
      { id: 'file', type: 'file', label: 'File', config: { operation: 'read', path: '/etc/passwd' }, position: { x: 0, y: 0 } },
    )
    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.message).join(' ')).toContain('控制字符')
    expect(result.issues.map((issue) => issue.message).join(' ')).toContain('相对路径')
  })

  it('accepts file input fields and strict AI output schemas', () => {
    const workflow = normalizeWorkflow({
      id: 'typed-inputs', name: 'Typed inputs', nodes: [
        { id: 'start', type: 'input', label: '开始', config: { fields: [
          { name: 'document', type: 'file', required: true },
          { name: 'attachments', type: 'file-list', required: false },
        ] }, position: { x: 0, y: 0 } },
        { id: 'ai', type: 'ai-task', label: '提取', config: {
          instruction: '提取', mode: 'single', skillIds: [], outputMode: 'json',
          outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        }, position: { x: 240, y: 0 } },
        { id: 'end', type: 'output', label: '结束', config: {}, position: { x: 480, y: 0 } },
      ],
      edges: [{ id: 'a', source: 'start', target: 'ai' }, { id: 'b', source: 'ai', target: 'end' }],
    })
    expect(workflow?.nodes[0]).toMatchObject({ config: { fields: [{ name: 'document', type: 'file' }, { name: 'attachments', type: 'file-list' }] } })
    expect(workflow?.nodes[1]).toMatchObject({ config: { outputSchema: { type: 'object', required: ['title'] } } })
    expect(validateWorkflow(workflow!)).toMatchObject({ valid: true, issues: [] })
  })

  it('rejects encoded traversal in managed connector paths and normalizes permission IDs', () => {
    const workflow = createDefaultWorkflow('Managed connector')
    const http: WorkflowNode = {
      id: 'http', type: 'http', label: '请求',
      config: { method: 'GET', url: '', connectorId: 'api', connectorPath: '/v1/%2e%2e/admin', headers: {}, responseMode: 'json' },
      position: { x: 240, y: 0 },
    }
    const output = workflow.nodes.find((node) => node.type === 'output')!
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const candidate = {
      ...workflow,
      permissionPolicy: { connectors: [{ connectorId: ' api ', operations: ['read'] as const }] },
      nodes: [input, http, { ...output, inputBindings: [] }],
      edges: [{ id: 'input-http', source: input.id, target: http.id }, { id: 'http-output', source: http.id, target: output.id }],
    }
    const normalized = normalizeWorkflow(candidate)
    expect(normalized?.permissionPolicy).toEqual({ connectors: [{ connectorId: 'api', operations: ['read'] }] })
    expect(validateWorkflow(normalized!).issues.some((issue) => issue.path.endsWith('connectorPath'))).toBe(true)
  })

  it('validates the P0 deterministic data and sub-workflow nodes', () => {
    const workflow = createDefaultWorkflow('P0 nodes')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const output = workflow.nodes.find((node) => node.type === 'output')!
    const nodes: WorkflowNode[] = [
      input!,
      { id: 'sub', type: 'sub-workflow', label: '子流程', config: { workflowId: 'child', waitForCompletion: true }, position: { x: 120, y: 0 } },
      { id: 'object', type: 'object-builder', label: '组装', config: { fields: { title: '{{value}}' } }, position: { x: 240, y: 0 } },
      { id: 'list', type: 'list-operator', label: '列表', config: { operation: 'filter', path: 'status', value: 'ok' }, position: { x: 360, y: 0 } },
      { id: 'merge', type: 'merge', label: '合并', config: { operation: 'append' }, position: { x: 480, y: 0 } },
      { ...output!, inputBindings: [{ id: 'result', name: 'result', sourceNodeId: 'merge', required: true }] },
    ]
    const edges = nodes.slice(0, -1).map((node, index) => ({ id: `e-${index}`, source: node.id, target: nodes[index + 1]!.id }))
    expect(validateWorkflow({ ...workflow, nodes, edges })).toMatchObject({ valid: true, issues: [] })
  })

  it('accepts an explicit structured-extract contract', () => {
    const workflow = createDefaultWorkflow('Structured extract')
    const extraction: WorkflowNode = { id: 'extract', type: 'structured-extract', label: '提取', config: { schema: { type: 'object', properties: { title: { type: 'string', description: '标题' } }, required: ['title'], additionalProperties: false }, maxRetries: 3 }, position: { x: 300, y: 0 } }
    const nodes = [workflow.nodes[0]!, extraction, workflow.nodes[workflow.nodes.length - 1]!]
    const output = nodes[2]!
    if (output.type !== 'output') throw new Error('expected output')
    output.inputBindings = [{ id: 'result', name: 'result', sourceNodeId: extraction.id, required: true }]
    expect(validateWorkflow({ ...workflow, nodes, edges: [{ id: 'a', source: nodes[0]!.id, target: extraction.id }, { id: 'b', source: extraction.id, target: output.id }] })).toMatchObject({ valid: true, issues: [] })
  })

  it('formats validation errors with the workflow action and exact node context', () => {
    const workflow = createDefaultWorkflow('短视频内容运营')
    const node = workflow.nodes[1]!
    const invalidWorkflow = {
      ...workflow,
      nodes: workflow.nodes.map((candidate) => candidate.id === node.id
        ? { ...candidate, label: '脚本文案员工', type: 'employee', config: { employeeId: 'writer', instruction: '', outputMode: 'text' } } as never
        : candidate),
    }
    const result = validateWorkflow(invalidWorkflow)

    const message = formatWorkflowValidationIssues(invalidWorkflow, result.issues, '保存')

    expect(message).toContain('Workflow「短视频内容运营」')
    expect(message).toContain('保存')
    expect(message).toContain('脚本文案员工')
    expect(message).toContain(node.id)
    expect(message).toContain('专业员工节点指令不能为空')
  })
})
