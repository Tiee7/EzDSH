import { describe, expect, it } from 'vitest'
import { createDefaultWorkflow, createWorkflowExportDocument, formatWorkflowValidationIssues, normalizeWorkflow, parseWorkflowExportDocument, validateWorkflow } from '../../src/shared/workflow.js'

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
