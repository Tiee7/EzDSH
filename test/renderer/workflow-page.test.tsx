import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as workflowPage from '../../src/renderer/workflow/WorkflowPage.js'
import { getAppCopy } from '../../src/shared/locale.js'
import { createDefaultWorkflow, type WorkflowDefinition, type WorkflowNodeType, type WorkflowRunRecord } from '../../src/shared/workflow.js'
import { ReactFlow, type Edge, type Node } from '@xyflow/react'

function graphWithRemovedNode(): WorkflowDefinition {
  const workflow = createDefaultWorkflow('Graph')
  const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')
  if (aiTask === undefined) throw new Error('starter graph should contain an AI task')
  return workflow
}

describe('WorkflowPage regressions', () => {
  it('shows the saved AI generation prompt in workflow metadata', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowMetadataDialog
      copy={getAppCopy('zh')}
      name="生成工作流"
      description=""
      generationPrompt="生成一个处理客户反馈的工作流"
      onChangeName={vi.fn()}
      onChangeDescription={vi.fn()}
      onChangeGenerationPrompt={vi.fn()}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />)

    expect(markup).toContain('AI 生成提示词')
    expect(markup).toContain('生成一个处理客户反馈的工作流')
  })

  it('marks the currently running canvas node for an execution indicator', () => {
    const workflow = createDefaultWorkflow('Execution status')
    const runningNode = workflow.nodes.find((node) => node.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-running', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'running', input: 'brief', events: [],
      nodeStates: workflow.nodes.map((node) => ({ nodeId: node.id, status: node.id === runningNode.id ? 'running' : 'pending', elapsedMs: 0 })),
    }

    const node = workflowPage.workflowFlowNodes(workflow, run).find((candidate) => candidate.id === runningNode.id)

    expect(node).toMatchObject({
      className: 'workflow-flow-node-running',
      data: { status: 'running', isRunning: true },
    })
  })

  it('adds the personal employee name to the canvas node data without replacing its role label', () => {
    const workflow = createDefaultWorkflow('Employee labels')
    const source = workflow.nodes.find((node) => node.type === 'ai-task')!
    const employeeNode = { ...source, type: 'employee', label: '事实核查', config: { employeeId: 'reviewer', instruction: '审核', outputMode: 'text' } } as never
    const next = { ...workflow, nodes: workflow.nodes.map((node) => node.id === source.id ? employeeNode : node) }
    const flowNode = workflowPage.workflowFlowNodes(next, undefined, undefined, [], [{
      schemaVersion: 2, version: 1, id: 'reviewer', displayName: '顾言', name: '审核员', role: '事实核查专员', description: '', businessBoundary: '', systemPrompt: '审核', operatingGuidelines: [], qualityStandards: [], capabilities: [], skillIds: [], enabled: true, builtIn: false, createdAt: '', updatedAt: '',
    }]).find((node) => node.id === source.id)

    expect(flowNode).toMatchObject({ data: { label: '事实核查', employeeName: '顾言' } })
  })

  it('keeps canvas deletions and edge deletions when inspector edits the workflow', () => {
    const workflow = graphWithRemovedNode()
    const agent = workflow.nodes.find((node) => node.type === 'ai-task')!
    const visibleNodes: Node[] = workflow.nodes
      .filter((node) => node.id !== agent.id)
      .map((node) => ({ id: node.id, position: node.position, data: { label: node.label, nodeType: node.type }, type: 'default' }))
    const visibleEdges: Edge[] = []

    const merged = workflowPage.mergeFlowStateIntoWorkflow(workflow, visibleNodes, visibleEdges)
    const edited = {
      ...merged,
      nodes: merged.nodes.map((node) => node.id === workflow.nodes[0]?.id ? { ...node, label: 'Edited input' } : node),
    }

    expect(edited.nodes.some((node) => node.id === agent.id)).toBe(false)
    expect(edited.edges).toEqual([])
  })

  it('removes a selected node together with every connected edge', () => {
    const workflow = graphWithRemovedNode()
    const agent = workflow.nodes.find((node) => node.type === 'ai-task')!
    const next = workflowPage.removeWorkflowNode(workflow, agent.id)

    expect(next.nodes.some((node) => node.id === agent.id)).toBe(false)
    expect(next.edges.some((edge) => edge.source === agent.id || edge.target === agent.id)).toBe(false)
  })

  it('keeps fixed start and end nodes when deleting or duplicating a selection', () => {
    const workflow = createDefaultWorkflow('Fixed terminals')
    const start = workflow.nodes.find((node) => node.type === 'input')!
    const end = workflow.nodes.find((node) => node.type === 'output')!

    const deleted = workflowPage.removeWorkflowSelection(workflow, { nodeIds: [start.id, end.id] })
    const duplicated = workflowPage.duplicateWorkflowNodes([start, end], (node) => `${node.id}-copy`)

    expect(deleted.nodes).toEqual(workflow.nodes)
    expect(deleted.edges).toEqual(workflow.edges)
    expect(duplicated).toEqual([])
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).not.toContain('input')
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).not.toContain('output')
  })

  it('restores the deleted node and its relationships with undo', () => {
    const workflow = graphWithRemovedNode()
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const deleted = workflowPage.removeWorkflowSelection(workflow, { nodeId: node.id })
    const history = workflowPage.recordWorkflowHistory(workflowPage.createWorkflowHistory(workflow), deleted)

    const restored = workflowPage.undoWorkflowHistory(history)

    expect(restored.present.nodes).toEqual(workflow.nodes)
    expect(restored.present.edges).toEqual(workflow.edges)
  })

  it('removes only the selected relationship when deleting an edge', () => {
    const workflow = graphWithRemovedNode()
    const edge = workflow.edges[0]
    if (edge === undefined) throw new Error('starter graph should contain an edge')

    const next = workflowPage.removeWorkflowSelection(workflow, { edgeId: edge.id })

    expect(next.nodes).toEqual(workflow.nodes)
    expect(next.edges).toHaveLength(workflow.edges.length - 1)
    expect(next.edges.some((candidate) => candidate.id === edge.id)).toBe(false)
  })

  it('removes selected nodes and relationships together', () => {
    const workflow = graphWithRemovedNode()
    const edge = workflow.edges.find((candidate) => workflow.nodes.find((node) => node.id === candidate.source)?.type === 'ai-task')
    if (edge === undefined) throw new Error('starter graph should contain an edge')

    const next = workflowPage.removeWorkflowSelection(workflow, { edgeId: edge.id, nodeIds: [edge.source] })

    expect(next.nodes.some((node) => node.id === edge.source)).toBe(false)
    expect(next.edges.some((candidate) => candidate.id === edge.id)).toBe(false)
  })

  it('removes every deletable selected node and records the batch as one undoable graph change', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.filter((node) => node.type === 'ai-task')
    const deleted = workflowPage.removeWorkflowSelection(workflow, { nodeIds: selectedNodes.map((node) => node.id) })
    const history = workflowPage.recordWorkflowHistory(workflowPage.createWorkflowHistory(workflow), deleted)

    expect(deleted.nodes).toHaveLength(workflow.nodes.length - selectedNodes.length)
    expect(deleted.edges.every((edge) => !selectedNodes.some((node) => edge.source === node.id || edge.target === node.id))).toBe(true)
    expect(history.past).toHaveLength(1)
    expect(workflowPage.undoWorkflowHistory(history).present).toEqual(workflow)
  })

  it('aligns all selected nodes without changing their other coordinate', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.slice(0, 3)
    const positioned = {
      ...workflow,
      nodes: workflow.nodes.map((node, index) => selectedNodes.includes(node)
        ? { ...node, position: [{ x: 80, y: 70 }, { x: 320, y: 180 }, { x: 540, y: 310 }][selectedNodes.indexOf(node)]! }
        : { ...node, position: { x: 900 + index * 20, y: 900 + index * 20 } }),
    }
    const selectedIds = selectedNodes.map((node) => node.id)

    const left = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'left')
    const centered = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'center-horizontal')
    const bottom = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'bottom')

    expect(left.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 70 },
      { x: 80, y: 180 },
      { x: 80, y: 310 },
    ])
    expect(centered.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 310, y: 70 },
      { x: 310, y: 180 },
      { x: 310, y: 310 },
    ])
    expect(bottom.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 310 },
      { x: 320, y: 310 },
      { x: 540, y: 310 },
    ])
  })

  it('distributes selected nodes evenly along either axis', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.slice(0, 3)
    const positioned = {
      ...workflow,
      nodes: workflow.nodes.map((node, index) => selectedNodes.includes(node)
        ? { ...node, position: [{ x: 80, y: 70 }, { x: 360, y: 180 }, { x: 540, y: 310 }][selectedNodes.indexOf(node)]! }
        : { ...node, position: { x: 900 + index * 20, y: 900 + index * 20 } }),
    }
    const selectedIds = selectedNodes.map((node) => node.id)

    const horizontal = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'distribute-horizontal')
    const vertical = workflowPage.alignWorkflowNodes(positioned, selectedIds, 'distribute-vertical')

    expect(horizontal.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 70 },
      { x: 310, y: 180 },
      { x: 540, y: 310 },
    ])
    expect(vertical.nodes.filter((node) => selectedIds.includes(node.id)).map((node) => node.position)).toEqual([
      { x: 80, y: 70 },
      { x: 360, y: 190 },
      { x: 540, y: 310 },
    ])
  })

  it('supports undo and redo for workflow edits and clears redo after a new branch', () => {
    const workflow = graphWithRemovedNode()
    const agent = workflow.nodes.find((node) => node.type === 'ai-task')!
    const edited = workflowPage.removeWorkflowNode(workflow, agent.id)
    const history = workflowPage.recordWorkflowHistory(workflowPage.createWorkflowHistory(workflow), edited)

    const undone = workflowPage.undoWorkflowHistory(history)
    expect(undone.present.nodes).toHaveLength(workflow.nodes.length)
    expect(undone.future).toHaveLength(1)

    const redone = workflowPage.redoWorkflowHistory(undone)
    expect(redone.present.nodes).toHaveLength(edited.nodes.length)
    expect(redone.present.nodes.some((node) => node.id === agent.id)).toBe(false)

    const branched = workflowPage.recordWorkflowHistory(redone, { ...redone.present, name: 'New branch' })
    expect(branched.future).toHaveLength(0)
  })

  it('does not treat editing controls as canvas delete targets', () => {
    expect(workflowPage.isWorkflowFormElement({ tagName: 'TEXTAREA', isContentEditable: false } as HTMLElement)).toBe(true)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'INPUT', isContentEditable: false } as HTMLElement)).toBe(true)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'DIV', isContentEditable: false } as HTMLElement)).toBe(false)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'DIV', isContentEditable: true } as HTMLElement)).toBe(true)
  })

  it('recognizes undo and redo shortcuts for both macOS and Windows', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('undo')
    expect(workflowPage.workflowKeyboardAction({ key: 'z', metaKey: false, ctrlKey: true, shiftKey: true })).toBe('redo')
    expect(workflowPage.workflowKeyboardAction({ key: 'y', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('redo')
    expect(workflowPage.workflowKeyboardAction({ key: 'z', metaKey: false, ctrlKey: false, shiftKey: false })).toBeUndefined()
  })

  it('recognizes Cmd/Ctrl+A as the canvas select-all shortcut', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 'a', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('select-all')
    expect(workflowPage.workflowKeyboardAction({ key: 'A', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('select-all')
  })

  it('recognizes Cmd/Ctrl+S as the canvas save shortcut', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 's', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('save')
    expect(workflowPage.workflowKeyboardAction({ key: 'S', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('save')
    expect(workflowPage.workflowKeyboardAction({ key: 's', metaKey: true, ctrlKey: false, shiftKey: true })).toBeUndefined()
  })

  it('recognizes Cmd/Ctrl+C and Cmd/Ctrl+V as canvas node copy and paste shortcuts', () => {
    expect(workflowPage.workflowKeyboardAction({ key: 'c', metaKey: true, ctrlKey: false, shiftKey: false })).toBe('copy')
    expect(workflowPage.workflowKeyboardAction({ key: 'V', metaKey: false, ctrlKey: true, shiftKey: false })).toBe('paste')
    expect(workflowPage.workflowKeyboardAction({ key: 'c', metaKey: true, ctrlKey: false, shiftKey: true })).toBeUndefined()
  })

  it('duplicates selected nodes with a fresh id, independent config, and an offset position', () => {
    const workflow = createDefaultWorkflow('Duplicate')
    const source = workflow.nodes.find((node) => node.type === 'ai-task')!

    const duplicate = workflowPage.duplicateWorkflowNodes([source], () => 'ai-task-copy', { x: 48, y: 32 })[0]!

    expect(duplicate).toMatchObject({ id: 'ai-task-copy', type: source.type, label: source.label, position: { x: source.position.x + 48, y: source.position.y + 32 } })
    expect(duplicate.config).toEqual(source.config)
    expect(duplicate.config).not.toBe(source.config)
  })

  it('offers start fields and declared upstream outputs as named node-input variables', () => {
    const workflow = createDefaultWorkflow('Variable options')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const research = workflow.nodes.find((node) => node.type === 'ai-task')!
    const target = workflow.nodes.find((node) => node.type === 'output')!
    research.outputVariables = [{ name: 'summary', description: '调研结论' }, { name: 'sources' }]

    expect(workflowPage.getWorkflowVariableOptions(workflow, target.id)).toEqual(expect.arrayContaining([
      { sourceNodeId: input.id, sourcePath: undefined, label: '开始 · task' },
      { sourceNodeId: research.id, sourcePath: undefined, label: '智能处理 · result' },
      { sourceNodeId: research.id, sourcePath: 'summary', label: '智能处理 · summary' },
      { sourceNodeId: research.id, sourcePath: 'sources', label: '智能处理 · sources' },
    ]))
  })

  it('does not offer downstream nodes as variable sources', () => {
    const workflow = createDefaultWorkflow('Variable direction')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!

    const options = workflowPage.getWorkflowVariableOptions(workflow, aiTask.id)

    expect(options.some((option) => option.sourceNodeId === input.id)).toBe(true)
    expect(options.some((option) => option.sourceNodeId === workflow.nodes.find((node) => node.type === 'output')!.id)).toBe(false)
  })

  it('selects every workflow node without changing node data', () => {
    const nodes: Node[] = [
      { id: 'first', position: { x: 20, y: 40 }, data: { label: 'First' }, selected: false },
      { id: 'second', position: { x: 120, y: 140 }, data: { label: 'Second' } },
    ]

    const selected = workflowPage.selectAllWorkflowNodes(nodes)

    expect(selected.map((node) => node.selected)).toEqual([true, true])
    expect(selected.map((node) => ({ id: node.id, position: node.position, data: node.data }))).toEqual(nodes.map((node) => ({ id: node.id, position: node.position, data: node.data })))
  })

  it('preserves selected nodes when canvas data is rebuilt after an operation', () => {
    const nodes: Node[] = [
      { id: 'first', position: { x: 20, y: 40 }, data: { label: 'First' }, selected: false },
      { id: 'second', position: { x: 120, y: 140 }, data: { label: 'Second' }, selected: false },
      { id: 'third', position: { x: 220, y: 240 }, data: { label: 'Third' }, selected: false },
    ]

    const rebuilt = workflowPage.preserveWorkflowNodeSelection(nodes, ['first', 'third'])

    expect(rebuilt.map((node) => node.selected)).toEqual([true, false, true])
  })

  it('uses a left input and right output for every ordinary canvas node', () => {
    expect(workflowPage.workflowNodeHandleLayout('ai-task')).toEqual({ input: 'left', output: 'right' })
    expect(workflowPage.workflowNodeHandleLayout('input')).toEqual({ output: 'right' })
    expect(workflowPage.workflowNodeHandleLayout('output')).toEqual({ input: 'left' })
    expect(workflowPage.workflowNodeHandleLayout('condition')).toEqual({ input: 'left', output: 'right' })
  })

  it('provides a distinct accessible type icon for every workflow node type', () => {
    const types: WorkflowNodeType[] = ['input', 'ai-task', 'employee', 'skill', 'mcp', 'parallel', 'loop', 'sleep', 'condition', 'approval', 'transform', 'text-merge', 'output', 'shell', 'file']

    for (const type of types) {
      const markup = renderToStaticMarkup(<workflowPage.WorkflowNodeTypeIcon type={type} />)
      expect(markup).toContain(`data-node-icon="${type}"`)
      expect(markup).toContain(`workflow-node-type-${type}`)
    }
  })

  it('uses Chinese names for every flow-control node', () => {
    const labelFor = (workflowPage as unknown as { workflowNodeTypeLabel?: (type: WorkflowNodeType) => string }).workflowNodeTypeLabel

    expect((['parallel', 'loop', 'sleep', 'condition', 'approval', 'transform', 'text-merge'] as WorkflowNodeType[]).map((type) => labelFor?.(type))).toEqual([
      '并行处理',
      '循环遍历',
      '等待',
      '条件判断',
      '人工审批',
      '数据转换',
      '文本合并',
    ])
  })

  it('exposes text merge as an addable flow-control node', () => {
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).toContain('text-merge' as never)
  })

  it('exposes sleep as an addable flow-control node', () => {
    expect(workflowPage.WORKFLOW_ADDABLE_NODE_TYPES).toContain('sleep' as never)
  })

  it('uses Chinese labels for condition operators and transform modes', () => {
    const conditionLabel = (workflowPage as unknown as { workflowConditionOperatorLabel?: (operator: string) => string }).workflowConditionOperatorLabel
    const transformLabel = (workflowPage as unknown as { workflowTransformTemplateLabel?: (template: string) => string }).workflowTransformTemplateLabel

    expect(['truthy', 'equals', 'not-equals', 'contains', 'greater-than', 'less-than'].map((operator) => conditionLabel?.(operator))).toEqual([
      '为真', '等于', '不等于', '包含', '大于', '小于',
    ])
    expect(['identity', 'json', 'extract-text', 'prepend', 'append', 'replace', 'text'].map((template) => transformLabel?.(template))).toEqual([
      '传递原值', '转为 JSON', '提取文本', '前置文本', '追加文本', '替换文本', '自定义文本',
    ])
  })

  it('inserts a workflow variable token at the editor selection', () => {
    expect(workflowPage.insertWorkflowVariableToken('请结合 继续写作', 'research', 4, 4)).toEqual({
      value: '请结合 {{research}}继续写作',
      cursor: 16,
    })
    expect(workflowPage.insertWorkflowVariableToken('旧变量', 'outline', 0, 3)).toEqual({
      value: '{{outline}}',
      cursor: 11,
    })
  })

  it('summarizes node-local inputs on the canvas card', () => {
    const workflow = createDefaultWorkflow('Variable card')
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!
    aiTask.inputBindings = [
      { id: 'binding-topic', name: 'topic', sourceNodeId: workflow.nodes[0]!.id, required: true },
      { id: 'binding-research', name: 'research', sourceNodeId: workflow.nodes[1]!.id, sourcePath: 'summary', required: true },
    ]

    aiTask.outputVariables = [{ name: 'summary' }, { name: 'sources' }]
    const flowNode = workflowPage.workflowFlowNodes(workflow).find((node) => node.id === aiTask.id)
    expect(flowNode?.data.inputVariables).toEqual(['topic', 'research'])
    expect(flowNode?.data.outputVariables).toEqual(['summary', 'sources'])
    expect(flowNode?.height).toBe(112)
  })

  it('shows non-linear variable dependencies in execution relationships without duplicating flow edges', () => {
    const workflow = createDefaultWorkflow('Variable relationships')
    const inputNode = workflow.nodes.find((node) => node.type === 'input')!
    const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')!
    const outputNode = workflow.nodes.find((node) => node.type === 'output')!
    const variableOnlyWorkflow = {
      ...workflow,
      edges: workflow.edges.filter((edge) => edge.target !== outputNode.id),
      nodes: workflow.nodes.map((node) => node.id === outputNode.id ? { ...node, inputBindings: [{ id: 'output-result', name: 'result', sourceNodeId: aiTask.id, required: true }] } : node),
    }

    const executionEdges = workflowPage.workflowExecutionEdges(variableOnlyWorkflow)

    expect(executionEdges).toHaveLength(variableOnlyWorkflow.edges.length + 1)
    expect(executionEdges.at(-1)).toMatchObject({ source: aiTask.id, target: outputNode.id, className: 'workflow-variable-dependency-edge' })
    expect(executionEdges.filter((edge) => edge.source === inputNode.id && edge.target === aiTask.id)).toHaveLength(1)
  })

  it('maps the persisted default output port to the custom node default handle', () => {
    const workflow = createDefaultWorkflow('Default port')
    const edge = workflow.edges[0]!
    const input = workflow.nodes[0]!
    const target = workflow.nodes[1]!
    const persistedDefaultPortWorkflow = {
      ...workflow,
      edges: [{ ...edge, source: input.id, target: target.id, sourcePort: 'default' as const }],
    }

    expect(workflowPage.workflowFlowEdges(persistedDefaultPortWorkflow)[0]?.sourceHandle).toBeUndefined()
  })

  it('renders loop body and continuation ports on their distinct handles', () => {
    const workflow = createDefaultWorkflow('Loop ports')
    const loop = workflow.nodes.find((node) => node.type === 'ai-task')!
    const output = workflow.nodes.find((node) => node.type === 'output')!
    const body = workflow.nodes.find((node) => node.type === 'input')!
    const withLoopPorts = {
      ...workflow,
      edges: [
        { id: 'loop-body', source: loop.id, target: body.id, sourcePort: 'loop-body' as const },
        { id: 'loop-next', source: loop.id, target: output.id, sourcePort: 'loop-next' as const },
      ],
    }

    expect(workflowPage.workflowFlowEdges(withLoopPorts).map((edge) => edge.sourceHandle)).toEqual(['loop-body', 'loop-next'])
  })

  it('maps switch case and default ports to their visible handles', () => {
    const workflow = createDefaultWorkflow('Switch ports')
    const route = { id: 'route', type: 'switch' as const, label: '路由', config: { cases: [{ id: 'urgent', label: '紧急', value: 'urgent' }] }, position: { x: 220, y: 0 } }
    const output = { ...workflow.nodes.find((node) => node.type === 'output')!, inputBindings: [] }
    const withSwitchPorts = { ...workflow, nodes: [...workflow.nodes.filter((node) => node.type !== 'ai-task' && node.type !== 'output'), route, output], edges: [
      { id: 'case', source: route.id, target: output.id, sourcePort: 'switch:urgent' as const },
      { id: 'default', source: route.id, target: output.id, sourcePort: 'default' as const },
    ] }

    expect(workflowPage.workflowFlowEdges(withSwitchPorts).map((edge) => edge.sourceHandle)).toEqual(['switch:urgent', 'default'])
    expect(workflowPage.workflowFlowEdges(withSwitchPorts).map((edge) => edge.label)).toEqual(['紧急', '默认'])
  })

  it('builds editor edges from the persisted workflow graph even when transient edge state is empty', () => {
    const workflow = createDefaultWorkflow('Persisted graph')

    const canvasEdges = workflowPage.workflowCanvasEdges(workflow, [])

    expect(canvasEdges).toHaveLength(workflow.edges.length)
    expect(canvasEdges.map((edge) => [edge.source, edge.target])).toEqual(workflow.edges.map((edge) => [edge.source, edge.target]))
  })

  it('keeps measured node geometry when execution history is opened directly', () => {
    const workflow = createDefaultWorkflow('Direct execution history')

    const executionNodes = workflowPage.workflowExecutionFlowNodes(workflow)

    expect(executionNodes).toHaveLength(workflow.nodes.length)
    expect(executionNodes.every((node) => node.measured?.width === node.width && node.measured?.height === node.height)).toBe(true)
  })

  it('uses an execution-only node position without changing the workflow definition position', () => {
    const workflow = createDefaultWorkflow('Execution layout')
    const input = workflow.nodes.find((node) => node.type === 'input')!
    const originalPosition = { ...input.position }
    const executionNodes = workflowPage.workflowExecutionFlowNodes(workflow, undefined, undefined, [], { [input.id]: { x: 920, y: 140 } })

    expect(executionNodes.find((node) => node.id === input.id)?.position).toEqual({ x: 920, y: 140 })
    expect(workflow.nodes.find((node) => node.id === input.id)?.position).toEqual(originalPosition)
  })

  it('automatically lays out a graph by dependency depth instead of trusting overlapping positions', () => {
    const workflow = createDefaultWorkflow('Automatic layout')
    const overlapping = { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })) }

    const laidOut = workflowPage.layoutWorkflowNodes(overlapping)

    expect(laidOut.nodes.map((node) => node.position)).toEqual([
      { x: 80, y: 180 },
      { x: 344, y: 180 },
      { x: 608, y: 180 },
    ])
  })

  it('uses drag selection by default and Space to pan the workflow canvas', () => {
    expect(workflowPage.WORKFLOW_CANVAS_INTERACTION_PROPS).toMatchObject({
      selectionOnDrag: true,
      panOnDrag: false,
      panActivationKeyCode: 'Space',
    })
  })

  it('keeps execution topology read-only while allowing node dragging', () => {
    expect(workflowPage.WORKFLOW_EXECUTION_CANVAS_INTERACTION_PROPS).toMatchObject({
      nodesDraggable: true,
      nodesConnectable: false,
      edgesReconnectable: false,
      deleteKeyCode: null,
    })
  })

  it('centers the canvas when the minimap is clicked and lets the minimap pan directly', () => {
    expect(workflowPage.WORKFLOW_MINIMAP_INTERACTION_PROPS).toEqual({ pannable: true })

    const setCenter = vi.fn(async () => true)
    workflowPage.centerWorkflowFromMiniMap(setCenter, { x: 120, y: 80 }, 1.25)

    expect(setCenter).toHaveBeenCalledWith(120, 80, { duration: 180, zoom: 1.25 })
  })

  it('derives named launch fields from input nodes and builds a structured run payload', () => {
    const workflow = createDefaultWorkflow('Run setup')
    const fields = workflowPage.getWorkflowLaunchFields(workflow)

    expect(fields).toEqual([{ id: workflow.nodes[0]?.id, key: 'task', label: '开始' }])
    expect(workflowPage.buildWorkflowLaunchInput(fields, { task: '准备今天的选题' })).toEqual({ task: '准备今天的选题' })
  })

  it('parses typed launch fields before starting the workflow', () => {
    const fields = [
      { id: 'count', key: 'count', label: '数量', type: 'number' as const },
      { id: 'enabled', key: 'enabled', label: '启用', type: 'boolean' as const },
      { id: 'items', key: 'items', label: '项目', type: 'json' as const },
    ]

    expect(workflowPage.buildWorkflowLaunchInput(fields, {
      count: '3',
      enabled: 'false',
      items: '["A", "B"]',
    })).toEqual({ count: 3, enabled: false, items: ['A', 'B'] })
  })

  it('parses workspace file and file-list launch fields', () => {
    const fields = [
      { id: 'document', key: 'document', label: '文档', type: 'file' as const },
      { id: 'attachments', key: 'attachments', label: '附件', type: 'file-list' as const },
    ]
    expect(workflowPage.buildWorkflowLaunchInput(fields, { document: 'docs/a.txt', attachments: 'docs/a.txt\ndocs/b.txt' })).toEqual({ document: 'docs/a.txt', attachments: ['docs/a.txt', 'docs/b.txt'] })
  })

  it('preserves JSON value types entered in a condition setting', () => {
    const parseValue = (workflowPage as unknown as { parseWorkflowConditionValue?: (value: string) => unknown }).parseWorkflowConditionValue

    expect(parseValue?.('3')).toBe(3)
    expect(parseValue?.('false')).toBe(false)
    expect(parseValue?.('["A", "B"]')).toEqual(['A', 'B'])
    expect(parseValue?.('普通文本')).toBe('普通文本')
  })

  it('derives multiple launch fields and field-level variable sources from structured input nodes', () => {
    const workflow = createDefaultWorkflow('Structured run setup')
    const input = workflow.nodes[0]
    if (input?.type !== 'input') throw new Error('starter graph should contain an input node')
    input.config = {
      fields: [
        { name: 'topic', label: '主题', type: 'string', required: true },
        { name: 'audience', label: '受众', type: 'string', required: false, defaultValue: '产品经理' },
      ],
    }
    const target = workflow.nodes.find((node) => node.type === 'output')!

    expect(workflowPage.getWorkflowLaunchFields(workflow)).toEqual([
      { id: `${input.id}-1`, key: 'topic', label: '主题', required: true },
      { id: `${input.id}-2`, key: 'audience', label: '受众', defaultValue: '产品经理', required: false },
    ])
    expect(workflowPage.getWorkflowVariableOptions(workflow, target.id)).toEqual(expect.arrayContaining([
      { sourceNodeId: input.id, sourcePath: 'topic', label: '开始 · 主题' },
      { sourceNodeId: input.id, sourcePath: 'audience', label: '开始 · 受众' },
    ]))
    expect(workflowPage.workflowFlowNodes(workflow)[0]?.data.inputVariables).toEqual(['主题', '受众'])
  })

  it('serializes portable workflow JSON and creates a safe download name', () => {
    const workflow = createDefaultWorkflow('公司/财务分析: 2026')
    const serialized = workflowPage.serializeWorkflowExport(workflow, '2026-08-31T00:00:00.000Z')

    expect(workflowPage.workflowExportFileName(workflow.name)).toBe('公司-财务分析-2026.json')
    expect(JSON.parse(serialized)).toMatchObject({ format: 'ezdsh.workflow', formatVersion: 1, workflow: { id: workflow.id } })
    expect(serialized.endsWith('\n')).toBe(true)
  })

  it('bundles referenced employee profiles in exported workflow JSON', () => {
    const workflow = createDefaultWorkflow('Employee export')
    const employeeNode = workflow.nodes.find((node) => node.type === 'ai-task')!
    const employeeWorkflow = {
      ...workflow,
      nodes: workflow.nodes.map((node) => node.id === employeeNode.id
        ? { ...node, type: 'employee', config: { employeeId: 'finance-analyst', instruction: '分析数据。', outputMode: 'text' } } as never
        : node),
    }
    const employees = [{
      schemaVersion: 2,
      version: 1,
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
      builtIn: false,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    }]

    expect(JSON.parse(workflowPage.serializeWorkflowExport(employeeWorkflow, undefined, employees))).toMatchObject({ employees: [{ id: 'finance-analyst', name: '财务分析师' }] })
  })

  it('exposes each persisted node output and error for execution debugging', () => {
    const workflow = createDefaultWorkflow('Debug run')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-debug',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'failed',
      input: { task: '检查节点输出' },
      output: 'partial output',
      nodeStates: [{ nodeId: node.id, status: 'failed', startedAt: '2026-08-30T00:00:00.000Z', completedAt: '2026-08-30T00:00:01.000Z', output: { draft: 'partial output' }, error: '模型响应超时' }],
      events: [],
      allowShellFile: false,
    }

    const detail = workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)
    expect(detail).toMatchObject({
      node: { id: node.id, label: node.label },
      state: { status: 'failed', output: { draft: 'partial output' }, error: '模型响应超时' },
    })
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={detail} statusLabel={() => '运行失败'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    expect(markup).toContain('节点结果')
    expect(markup).toContain('partial output')
    expect(markup).toContain('模型响应超时')
  })

  it('shows the final output only without a selected node, and the node output after selection', () => {
    const workflow = createDefaultWorkflow('Output selection')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-output-selection',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: { task: '查看结果' },
      output: 'FINAL_OUTPUT_ONLY',
      nodeStates: [{ nodeId: node.id, status: 'completed', output: 'NODE_OUTPUT_ONLY' }],
      events: [],
      allowShellFile: false,
    }

    const finalMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    const nodeMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(finalMarkup).toContain('FINAL')
    expect(finalMarkup).not.toContain('NODE')
    expect(nodeMarkup).toContain('NODE')
    expect(nodeMarkup).not.toContain('FINAL')
  })

  it('shows run input and node input/output, with upstream navigation for derived input', () => {
    const workflow = createDefaultWorkflow('Input output selection')
    const inputNode = workflow.nodes.find((candidate) => candidate.type === 'input')!
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-input-output-selection',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: { task: '手工输入' },
      output: { final: '最终结果' },
      nodeStates: [
        { nodeId: inputNode.id, status: 'completed', input: { task: '手工输入' }, output: { task: '上游结果' } },
        { nodeId: node.id, status: 'completed', input: { long: '上游节点输出' }, output: { result: '节点结果' } },
      ],
      events: [],
      allowShellFile: false,
    }

    const finalMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    const nodeMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} onSelectNode={vi.fn()} />,
    )

    expect(finalMarkup).toContain('运行输入')
    expect(finalMarkup).toContain('手工输入')
    expect(finalMarkup).toContain('最终结果')
    expect(nodeMarkup).toContain('节点输入')
    expect(nodeMarkup).toContain('节点输出')
    expect(nodeMarkup).toContain(`${node.label} · 节点输出`)
    expect(nodeMarkup).toContain('上游节点输出')
    expect(nodeMarkup).toContain('到上游')
  })

  it('shows the selected node prompt and configuration in a collapsed section', () => {
    const workflow = createDefaultWorkflow('Node configuration history')
    const node = workflow.nodes.find((candidate) => candidate.type === 'ai-task')!
    const run: WorkflowRunRecord = {
      id: 'run-node-configuration',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: { task: '对比提示词和结果' },
      output: '最终结果',
      nodeStates: [{ nodeId: node.id, status: 'completed', input: { task: '输入' }, output: '节点结果' }],
      events: [],
      allowShellFile: false,
    }

    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} nodeDetail={workflowPage.getWorkflowNodeRunDetail(workflow, run, node.id)} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(markup).toContain('节点提示词与配置')
    expect(markup).toContain('请完成输入任务，并给出清晰、可执行的结果。')
    expect(markup).toMatch(/<details class="workflow-node-configuration"[^>]*>/u)
    expect(markup).not.toMatch(/<details class="workflow-node-configuration"[^>]*\bopen(?:=""|="open")?/u)
  })

  it('provides output copy, floating-window, and font-size controls', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={{ result: '可复制结果' }} onCopy={vi.fn()} onOpenWindow={vi.fn()} fontScale={1} onIncreaseFont={vi.fn()} onDecreaseFont={vi.fn()} />,
    )

    expect(markup).toContain('复制结果')
    expect(markup).toContain('在浮层中打开')
    expect(markup).toContain('减小字体')
    expect(markup).toContain('增大字体')
  })

  it('clamps the execution detail height while dragging the split line', () => {
    expect(workflowPage.clampWorkflowExecutionDetailHeight(80, 900)).toBe(180)
    expect(workflowPage.clampWorkflowExecutionDetailHeight(420, 900)).toBe(420)
    expect(workflowPage.clampWorkflowExecutionDetailHeight(900, 900)).toBe(660)
  })

  it('keeps floating result windows reachable and constrains all four resize edges', () => {
    expect(workflowPage.clampWorkflowOutputWindowPosition({ x: -40, y: -80 }, { width: 400, height: 300 }, 900, 700)).toEqual({ x: 12, y: 12 })
    expect(workflowPage.clampWorkflowOutputWindowPosition({ x: 800, y: 650 }, { width: 400, height: 300 }, 900, 700)).toEqual({ x: 488, y: 388 })

    const start = { edge: 'left' as const, startX: 100, startY: 100, startLeft: 200, startTop: 80, startWidth: 420, startHeight: 300 }
    expect(workflowPage.resizeWorkflowOutputWindow(start, 400, 100, 900, 700)).toEqual({ position: { x: 300, y: 80 }, size: { width: 320, height: 300 } })

    const right = { ...start, edge: 'right' as const }
    expect(workflowPage.resizeWorkflowOutputWindow(right, 900, 100, 900, 700)).toEqual({ position: { x: 200, y: 80 }, size: { width: 688, height: 300 } })

    const top = { ...start, edge: 'top' as const }
    expect(workflowPage.resizeWorkflowOutputWindow(top, 100, 500, 900, 700)).toEqual({ position: { x: 200, y: 140 }, size: { width: 420, height: 240 } })

    const bottom = { ...start, edge: 'bottom' as const }
    expect(workflowPage.resizeWorkflowOutputWindow(bottom, 100, 900, 900, 700)).toEqual({ position: { x: 200, y: 80 }, size: { width: 420, height: 608 } })
  })

  it('summarizes run history and identifies the first unviewed record', () => {
    const runs: WorkflowRunRecord[] = [
      { id: 'run-new', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: {}, output: 'new', nodeStates: [], events: [], allowShellFile: false },
      { id: 'run-old', workflowId: 'workflow-1', workflowRevision: 1, status: 'failed', input: {}, nodeStates: [], events: [], allowShellFile: false },
    ]

    expect(workflowPage.summarizeWorkflowRuns(runs, new Set(['run-old']))).toEqual({ count: 2, unviewedCount: 1, firstUnviewedRun: runs[0] })
    expect(workflowPage.summarizeWorkflowRuns(runs, new Set(['run-new', 'run-old']))).toEqual({ count: 2, unviewedCount: 0 })
  })

  it('only allows an explicit action on the visible execution page to mark a finished run viewed', () => {
    const completed: WorkflowRunRecord = { id: 'run-viewed', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: {}, nodeStates: [], events: [], allowShellFile: false }

    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: true, workspaceView: 'executions', userAction: true })).toBe(true)
    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: false, workspaceView: 'executions', userAction: true })).toBe(false)
    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: true, workspaceView: 'editor', userAction: true })).toBe(false)
    expect(workflowPage.workflowRunShouldBeMarkedViewed(completed, { pageActive: true, workspaceView: 'executions', userAction: false })).toBe(false)
    expect(workflowPage.workflowRunShouldBeMarkedViewed({ ...completed, status: 'running' }, { pageActive: true, workspaceView: 'executions', userAction: true })).toBe(false)
  })

  it('exposes run history actions and keeps active records protected from deletion', () => {
    const workflow = createDefaultWorkflow('Run actions')
    const run: WorkflowRunRecord = { id: 'run-actions', workflowId: workflow.id, workflowRevision: workflow.revision, status: 'completed', input: {}, nodeStates: [], events: [], allowShellFile: false }
    const markup = renderToStaticMarkup(<workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} onMarkUnread={vi.fn()} onDelete={vi.fn()} canMarkUnread canDelete />)

    expect(markup).toContain('aria-label="标记未读"')
    expect(markup).toContain('title="标记未读"')
    expect(markup).toContain('aria-label="删除记录"')
    expect(markup).toContain('title="删除记录"')
    expect(workflowPage.workflowRunCanDelete('completed')).toBe(true)
    expect(workflowPage.workflowRunCanDelete('running')).toBe(false)
    expect(workflowPage.workflowRunCanDelete('waiting-approval')).toBe(false)
  })

  it('auto-detects structured JSON strings while keeping ordinary text as Markdown', () => {
    expect(workflowPage.detectWorkflowOutputView({ title: '研究报告', items: ['一', '二'] })).toBe('json')
    expect(workflowPage.detectWorkflowOutputView('{"title":"研究报告","items":["一","二"]}')).toBe('json')
    expect(workflowPage.detectWorkflowOutputView('# 研究报告\n\n这是一段普通文本。')).toBe('markdown')
    expect(workflowPage.detectWorkflowOutputView('{这不是 JSON}')).toBe('markdown')
  })

  it('renders readable Markdown and JSON output views with explicit toggles', () => {
    const markdownMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'# 研究报告\n\n- 第一项\n- 第二项\n\n**结论**'} />,
    )
    expect(markdownMarkup).toContain('workflow-output-viewer')
    expect(markdownMarkup).toContain('Markdown')
    expect(markdownMarkup).toContain('JSON')
    expect(markdownMarkup).toContain('<h1>研究报告</h1>')
    expect(markdownMarkup).toContain('<li>第一项</li>')
    expect(markdownMarkup).toContain('<strong>结论</strong>')

    const jsonMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'{"title":"研究报告","items":["一","二"]}'} />,
    )
    expect(jsonMarkup).toContain('workflow-output-json')
    expect(jsonMarkup).toContain('workflow-json-tree')
    expect(jsonMarkup).toContain('title')
    expect(jsonMarkup).toContain('items')
    expect(jsonMarkup).toContain('<details')
    expect(jsonMarkup).toContain('全部展开')
    expect(jsonMarkup).toContain('全部收起')

    const collapsedTree = renderToStaticMarkup(<workflowPage.WorkflowJsonTree value={{ outer: { inner: 'value' } }} />)
    const expandedTree = renderToStaticMarkup(<workflowPage.WorkflowJsonTree value={{ outer: { inner: 'value' } }} expandAll />)
    expect((collapsedTree.match(/<details/g) ?? []).length).toBe(2)
    expect((collapsedTree.match(/<details[^>]*open(?:="")?/gu) ?? []).length).toBe(1)
    expect((expandedTree.match(/<details[^>]*open(?:="")?/gu) ?? []).length).toBe(2)
  })

  it('preserves real and escaped line breaks in Markdown output', () => {
    const escaped = renderToStaticMarkup(<workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'第一行\\n第二行'} />)
    const actual = renderToStaticMarkup(<workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={'第一行\n第二行'} />)
    expect(escaped).toContain('<br')
    expect(actual).toContain('<br')
  })

  it('renders Markdown tables in normal and floating result viewers', () => {
    const table = '| 节点 | 耗时 |\n| --- | ---: |\n| 调研 | 1.2 秒 |\n| 审核 | 2.4 秒 |'
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputViewer copy={getAppCopy('zh')} value={table} />,
    )
    const floatingMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputFloatingWindows copy={getAppCopy('zh')} windows={[{ id: 'table', title: '表格结果', value: table }]} fontScale={1} onClose={vi.fn()} onCopy={vi.fn()} onIncreaseFont={vi.fn()} onDecreaseFont={vi.fn()} />,
    )

    expect(markup).toContain('<table')
    expect(markup).toContain('<th>节点</th>')
    expect(markup).toContain('<td>2.4 秒</td>')
    expect(floatingMarkup).toContain('<table')
  })

  it('formats node execution time with millisecond precision and zero for legacy records', () => {
    expect(workflowPage.formatWorkflowNodeDuration()).toBe('0.0秒')
    expect(workflowPage.formatWorkflowNodeDuration(1_234)).toBe('1.2秒')
    expect(workflowPage.formatWorkflowNodeDuration(61_234)).toBe('1分1.2秒')
    expect(workflowPage.formatWorkflowNodeDuration(3_661_234)).toBe('1时1分1.2秒')
  })

  it('renders draggable result windows and a compact execution heading', () => {
    const workflow = createDefaultWorkflow('Compact execution')
    const run: WorkflowRunRecord = {
      id: 'run-compact-heading',
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      status: 'completed',
      input: {},
      output: 'done',
      nodeStates: [],
      events: [],
      allowShellFile: false,
      startedAt: '2026-08-30T12:47:45.232Z',
    }
    const reviewMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={run} statusLabel={() => '运行完成'} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )
    const windowsMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputFloatingWindows copy={getAppCopy('zh')} windows={[{ id: 'final', title: '最终结果', value: { ok: true } }]} fontScale={1} onClose={vi.fn()} onCopy={vi.fn()} onIncreaseFont={vi.fn()} onDecreaseFont={vi.fn()} />,
    )

    expect(reviewMarkup).toContain('workflow-execution-compact-heading')
    expect(reviewMarkup).toContain('run-compact-heading')
    expect(reviewMarkup).not.toContain('2026-08-30T12:47:45.232Z')
    expect(windowsMarkup).toContain('workflow-output-window-resize-top')
    expect(windowsMarkup).toContain('workflow-output-window-resize-right')
    expect(windowsMarkup).toContain('workflow-output-window-resize-bottom')
    expect(windowsMarkup).toContain('workflow-output-window-resize-left')
    expect(windowsMarkup).toContain('workflow-output-window-drag-handle')
  })

  it('keeps result window coordinates stable and raises the most recently focused window', () => {
    const first = workflowPage.createWorkflowOutputWindowState('first', '第一个', 'first', 0)
    const second = workflowPage.createWorkflowOutputWindowState('second', '第二个', 'second', 1)
    const focused = workflowPage.focusWorkflowOutputWindow([first, second], 'first')

    expect(first.position).toEqual({ x: 18, y: 96 })
    expect(second.position.x).toBeGreaterThan(first.position.x)
    expect(focused.find((window) => window.id === 'first')?.zIndex).toBeGreaterThan(focused.find((window) => window.id === 'second')?.zIndex ?? 0)
  })

  it('opens a new result window above every previously focused window', () => {
    const first = workflowPage.createWorkflowOutputWindowState('first', '第一个', 'first', 0)
    const second = workflowPage.createWorkflowOutputWindowState('second', '第二个', 'second', 1)
    const previouslyFocused = workflowPage.focusWorkflowOutputWindow([first, second], 'first')

    const opened = workflowPage.openWorkflowOutputWindow(previouslyFocused, 'third', '第三个', 'third')

    expect(opened.find((window) => window.id === 'third')?.zIndex).toBeGreaterThan(Math.max(...previouslyFocused.map((window) => window.zIndex ?? 0)))
  })

  it('uses status-specific colors in the minimap and provides a map toggle component', () => {
    expect(workflowPage.workflowMiniMapNodeColor('completed')).toBe('#1f8a5c')
    expect(workflowPage.workflowMiniMapNodeColor('failed')).toBe('#c2453a')
    expect(workflowPage.workflowMiniMapNodeColor('pending')).toBe('#9ca3af')
    expect(workflowPage.WorkflowCanvasTools).toBeTypeOf('function')

    const markup = renderToStaticMarkup(
      <ReactFlow nodes={[]} edges={[]}>
        <workflowPage.WorkflowCanvasTools copy={getAppCopy('zh')} showMiniMap onToggleMiniMap={vi.fn()} />
      </ReactFlow>,
    )
    expect(markup).toContain('workflow-minimap-control-button')
    expect(markup).not.toContain('workflow-minimap-toggle')
  })

  it('renders launch setup separately while run history remains read-only', () => {
    const workflow = createDefaultWorkflow('Run setup')
    const fields = workflowPage.getWorkflowLaunchFields(workflow)
    const launchMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowRunLaunchDialog
        copy={getAppCopy('zh')}
        fields={fields}
        values={{ task: '' }}
        modelOptions={[{ providerId: 'deepseek-official', providerName: 'DeepSeek', modelId: 'deepseek-chat', modelName: 'DeepSeek Chat' }]}
        modelSelection={undefined}
        allowShellFile={false}
        allowCode={false}
        debug={false}
        busy={false}
        modelLoading={false}
        onChangeValue={vi.fn()}
        onChangeModel={vi.fn()}
        onRefreshModels={vi.fn()}
        onChangeAllowShellFile={vi.fn()}
        onChangeAllowCode={vi.fn()}
        onChangeDebug={vi.fn()}
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    )
    const historyMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowExecutionReview copy={getAppCopy('zh')} run={undefined} statusLabel={() => ''} onCancel={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onResume={vi.fn()} />,
    )

    expect(launchMarkup).toContain('配置运行')
    expect(launchMarkup).toContain('开始运行')
    expect(launchMarkup).toContain('使用默认模型')
    expect(launchMarkup).toContain('DeepSeek Chat')
    expect(launchMarkup).toContain('刷新模型')
    expect(launchMarkup).toContain('workflow-launch-note')
    expect(launchMarkup).toContain('允许 Shell / 文件节点')
    expect(historyMarkup).not.toContain('运行输入')
    expect(historyMarkup).not.toContain('允许 Shell / 文件节点')
    expect(historyMarkup).not.toContain('调试运行')
  })

  it('offers variable or custom text content for the fixed end node', () => {
    const workflow = createDefaultWorkflow('End output settings')
    const end = workflow.nodes.find((node) => node.type === 'output')!
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputNodeSettings workflow={workflow} node={end} onChange={vi.fn()} />,
    )
    const textMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowOutputNodeSettings workflow={workflow} node={{ ...end, config: { contentMode: 'text', text: '结果：{{result}}' } }} onChange={vi.fn()} />,
    )

    expect(markup).toContain('输出内容来源')
    expect(markup).toContain('变量')
    expect(markup).toContain('自定义文本')
    expect(markup).toContain('如需再次处理')
    expect(markup).toContain('输入变量')
    expect(textMarkup).toContain('插入变量')
    expect(markup).not.toContain('添加输出变量')
    expect(markup.indexOf('输入变量')).toBeLessThan(markup.indexOf('输出内容来源'))
  })

  it('uses a stable row key while an output variable name is edited', () => {
    const rowKey = (workflowPage as unknown as { workflowOutputVariableRowKey?: (index: number) => string }).workflowOutputVariableRowKey

    expect(rowKey?.(0)).toBe('output-variable-0')
    expect(rowKey?.(1)).toBe('output-variable-1')
  })

  it('offers employees and lightweight AI processing without the retired content template entry point', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" developerMode />)

    expect(markup).toContain('workflow-page-browser')
    expect(markup).toContain('workflow-browser-content')
    expect(markup).toContain('workflow-employee-select')
    expect(markup).toContain('智能处理')
    expect(markup).toContain('专业员工')
    expect(markup).toContain('导入')
    expect(markup).toContain('从剪贴板导入')
    expect(markup).toContain('workflow-import-split')
    expect(markup).not.toContain('导入 JSON')
    expect(markup).not.toContain('短视频内容运营')
    expect(markup).not.toContain('Employee ID')
    expect(markup).not.toContain('Agent')
  })

  it('migrates legacy Agent wording before a workflow enters the editor', () => {
    expect(workflowPage.userFacingWorkflowText('交给 DSH Agent 处理', 'zh')).toContain('智能处理')
    expect(workflowPage.userFacingWorkflowText('交给 DSH Agent 处理', 'zh')).not.toContain('Agent')
    expect(workflowPage.userFacingWorkflowText('Use an Agent', 'en')).toBe('Use an AI Processing')
  })

  it('keeps the workflow browser separate from the full workspace shell', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" />)

    expect(markup).not.toContain('workflow-layout')
    expect(markup).not.toContain('workflow-inspector')
    expect(markup).toContain('选择一个工作流开始')
  })

  it('renders a dismiss action for workflow status messages', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowToast message="工作流已保存" copy={getAppCopy('zh')} onDismiss={vi.fn()} />,
    )

    expect(markup).toContain('工作流已保存')
    expect(markup).toContain('关闭提示')
  })

  it('renders a dismiss action for workflow errors', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowErrorBanner message="保存失败" copy={getAppCopy('zh')} onDismiss={vi.fn()} />,
    )

    expect(markup).toContain('保存失败')
    expect(markup).toContain('关闭提示')
  })

  it('keeps editor history keyboard-only and uses a green save action', () => {
    const draftMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowEditorActions copy={getAppCopy('zh')} draft busy={false} runDisabled={false} runLabel="运行" onCancel={vi.fn()} onSave={vi.fn()} onExport={vi.fn()} onRun={vi.fn()} />,
    )
    const editMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowEditorActions copy={getAppCopy('zh')} draft={false} busy={false} runDisabled={false} runLabel="运行" onCancel={vi.fn()} onSave={vi.fn()} onExport={vi.fn()} onRun={vi.fn()} />,
    )

    expect(draftMarkup).not.toContain('撤销')
    expect(draftMarkup).not.toContain('重做')
    expect(draftMarkup).toContain('保存')
    expect(draftMarkup).toContain('workflow-save-button')
    expect(editMarkup).toContain('取消编辑')
    expect(editMarkup).toContain('导出')
    expect(editMarkup).toContain('到文件')
    expect(editMarkup).toContain('到剪贴板')
    expect(editMarkup).toContain('workflow-export-menu')
    expect(editMarkup).not.toContain('导出 JSON')
    expect(editMarkup.indexOf('导出')).toBeLessThan(editMarkup.indexOf('保存'))
  })

  it('renders common actions in the workflow canvas context menu', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowContextMenu
        copy={getAppCopy('zh')}
        target="node"
        x={24}
        y={36}
        canUndo
        canRedo
        busy={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onDelete={vi.fn()}
        onFitView={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(markup).toContain('role="menu"')
    expect(markup).toContain('撤销')
    expect(markup).toContain('重做')
    expect(markup).toContain('删除节点')
    expect(markup).toContain('适配画布')
    expect(markup).toContain('保存')
    expect(markup).toContain('⌘S')
    expect(markup).toContain('运行')
  })

  it('renders alignment actions only for a multi-node context menu', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowContextMenu
        copy={getAppCopy('zh')}
        target="node"
        x={24}
        y={36}
        selectedNodeCount={3}
        canUndo={false}
        canRedo={false}
        busy={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onDelete={vi.fn()}
        onAlign={vi.fn()}
        onFitView={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(markup).toContain('左对齐')
    expect(markup).toContain('水平居中')
    expect(markup).toContain('右对齐')
    expect(markup).toContain('顶端对齐')
    expect(markup).toContain('垂直居中')
    expect(markup).toContain('底端对齐')
    expect(markup).toContain('水平平均排布')
    expect(markup).toContain('垂直平均排布')
  })

  it('renders selection actions for the multi-node selection context menu', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowContextMenu
        copy={getAppCopy('zh')}
        target="selection"
        x={24}
        y={36}
        selectedNodeCount={3}
        canUndo={false}
        canRedo={false}
        busy={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onDelete={vi.fn()}
        onAlign={vi.fn()}
        onFitView={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(markup).toContain('删除选中内容')
    expect(markup).toContain('左对齐')
    expect(markup).toContain('底端对齐')
  })

  it('keeps the context menu inside the viewport when opened near an edge', () => {
    expect(workflowPage.clampWorkflowContextMenuPosition(980, 860, 260, 340, 1024, 900)).toEqual({ left: 756, top: 552 })
    expect(workflowPage.clampWorkflowContextMenuPosition(2, 3, 260, 340, 1024, 900)).toEqual({ left: 8, top: 8 })
  })

  it('offers an undo action for a recently deleted workflow toast', () => {
    const markup = renderToStaticMarkup(
      <workflowPage.WorkflowToast message="工作流已删除" actionLabel="撤销删除" copy={getAppCopy('zh')} onAction={vi.fn()} onDismiss={vi.fn()} />,
    )

    expect(markup).toContain('撤销删除')
  })
})
