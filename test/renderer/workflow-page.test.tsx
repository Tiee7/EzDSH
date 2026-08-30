import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as workflowPage from '../../src/renderer/workflow/WorkflowPage.js'
import { getAppCopy } from '../../src/shared/locale.js'
import { createDefaultWorkflow, type WorkflowDefinition, type WorkflowRunRecord } from '../../src/shared/workflow.js'
import { ReactFlow, type Edge, type Node } from '@xyflow/react'

function graphWithRemovedNode(): WorkflowDefinition {
  const workflow = createDefaultWorkflow('Graph')
  const aiTask = workflow.nodes.find((node) => node.type === 'ai-task')
  if (aiTask === undefined) throw new Error('starter graph should contain an AI task')
  return workflow
}

describe('WorkflowPage regressions', () => {
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
    const edge = workflow.edges[0]
    if (edge === undefined) throw new Error('starter graph should contain an edge')

    const next = workflowPage.removeWorkflowSelection(workflow, { edgeId: edge.id, nodeIds: [edge.source] })

    expect(next.nodes.some((node) => node.id === edge.source)).toBe(false)
    expect(next.edges.some((candidate) => candidate.id === edge.id)).toBe(false)
  })

  it('removes every selected node and records the batch as one undoable graph change', () => {
    const workflow = graphWithRemovedNode()
    const selectedNodes = workflow.nodes.filter((node) => node.type === 'ai-task' || node.type === 'output')
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

  it('builds editor edges from the persisted workflow graph even when transient edge state is empty', () => {
    const workflow = createDefaultWorkflow('Persisted graph')

    const canvasEdges = workflowPage.workflowCanvasEdges(workflow, [])

    expect(canvasEdges).toHaveLength(workflow.edges.length)
    expect(canvasEdges.map((edge) => [edge.source, edge.target])).toEqual(workflow.edges.map((edge) => [edge.source, edge.target]))
  })

  it('uses drag selection by default and Space to pan the workflow canvas', () => {
    expect(workflowPage.WORKFLOW_CANVAS_INTERACTION_PROPS).toMatchObject({
      selectionOnDrag: true,
      panOnDrag: false,
      panActivationKeyCode: 'Space',
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

    expect(fields).toEqual([{ id: workflow.nodes[0]?.id, key: 'task', label: '输入' }])
    expect(workflowPage.buildWorkflowLaunchInput(fields, { task: '准备今天的选题' })).toEqual({ task: '准备今天的选题' })
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
    expect(nodeMarkup).toContain('上游节点输出')
    expect(nodeMarkup).toContain('到上游')
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

  it('summarizes run history and identifies the first unviewed record', () => {
    const runs: WorkflowRunRecord[] = [
      { id: 'run-new', workflowId: 'workflow-1', workflowRevision: 1, status: 'completed', input: {}, output: 'new', nodeStates: [], events: [], allowShellFile: false },
      { id: 'run-old', workflowId: 'workflow-1', workflowRevision: 1, status: 'failed', input: {}, nodeStates: [], events: [], allowShellFile: false },
    ]

    expect(workflowPage.summarizeWorkflowRuns(runs, new Set(['run-old']))).toEqual({ count: 2, unviewedCount: 1, firstUnviewedRun: runs[0] })
    expect(workflowPage.summarizeWorkflowRuns(runs, new Set(['run-new', 'run-old']))).toEqual({ count: 2, unviewedCount: 0 })
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
        debug={false}
        busy={false}
        modelLoading={false}
        onChangeValue={vi.fn()}
        onChangeModel={vi.fn()}
        onRefreshModels={vi.fn()}
        onChangeAllowShellFile={vi.fn()}
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

  it('offers employees and lightweight AI processing to developers without exposing Agent', () => {
    const markup = renderToStaticMarkup(<workflowPage.WorkflowPage copy={getAppCopy('zh')} locale="zh" developerMode />)

    expect(markup).toContain('workflow-page-browser')
    expect(markup).toContain('workflow-browser-content')
    expect(markup).toContain('workflow-employee-select')
    expect(markup).toContain('智能处理')
    expect(markup).toContain('专业员工')
    expect(markup).toContain('短视频内容运营')
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

  it('keeps editor history keyboard-only and uses a green save action', () => {
    const draftMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowEditorActions copy={getAppCopy('zh')} draft busy={false} runDisabled={false} runLabel="运行" onCancel={vi.fn()} onSave={vi.fn()} onRun={vi.fn()} />,
    )
    const editMarkup = renderToStaticMarkup(
      <workflowPage.WorkflowEditorActions copy={getAppCopy('zh')} draft={false} busy={false} runDisabled={false} runLabel="运行" onCancel={vi.fn()} onSave={vi.fn()} onRun={vi.fn()} />,
    )

    expect(draftMarkup).not.toContain('撤销')
    expect(draftMarkup).not.toContain('重做')
    expect(draftMarkup).toContain('保存')
    expect(draftMarkup).toContain('workflow-save-button')
    expect(editMarkup).toContain('取消编辑')
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
