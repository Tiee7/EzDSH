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

  it('does not treat editing controls as canvas delete targets', () => {
    expect(workflowPage.isWorkflowFormElement({ tagName: 'TEXTAREA', isContentEditable: false } as HTMLElement)).toBe(true)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'INPUT', isContentEditable: false } as HTMLElement)).toBe(true)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'DIV', isContentEditable: false } as HTMLElement)).toBe(false)
    expect(workflowPage.isWorkflowFormElement({ tagName: 'DIV', isContentEditable: true } as HTMLElement)).toBe(true)
  })

  it('uses a left input and right output for every ordinary canvas node', () => {
    expect(workflowPage.workflowNodeHandleLayout('ai-task')).toEqual({ input: 'left', output: 'right' })
    expect(workflowPage.workflowNodeHandleLayout('input')).toEqual({ output: 'right' })
    expect(workflowPage.workflowNodeHandleLayout('output')).toEqual({ input: 'left' })
    expect(workflowPage.workflowNodeHandleLayout('condition')).toEqual({ input: 'left', output: 'right' })
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
        onChangeValue={vi.fn()}
        onChangeModel={vi.fn()}
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
})
