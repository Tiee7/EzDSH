import { describe, expect, it } from 'vitest'
import { createDefaultWorkflow, normalizeWorkflow, validateWorkflow } from '../../src/shared/workflow.js'

describe('workflow contract', () => {
  it('creates a valid starter graph', () => {
    const workflow = createDefaultWorkflow('Starter')
    expect(validateWorkflow(workflow)).toMatchObject({ valid: true, issues: [] })
    expect(workflow.schemaVersion).toBe(2)
    expect(workflow.nodes.map((node) => node.type)).toEqual(['input', 'ai-task', 'output'])
    expect(workflow.nodes[1]).toMatchObject({
      type: 'ai-task',
      label: '智能处理',
      config: { mode: 'single', outputMode: 'text', skillIds: [] },
    })
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
})
