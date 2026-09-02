import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowGenerationPage, WorkflowGenerationProgressView, mergeWorkflowGenerationRecord } from '../../src/renderer/workflow/WorkflowGenerationPage.js'
import { getAppCopy } from '../../src/shared/locale.js'
import { createDefaultWorkflow, type WorkflowGenerationRecord } from '../../src/shared/workflow.js'

describe('WorkflowGenerationPage', () => {
  it('renders model selection, fixed stages, live messages, and generation history', () => {
    const workflow = createDefaultWorkflow('短视频选题')
    const record: WorkflowGenerationRecord = {
      id: 'generation-1',
      prompt: '生成一个短视频选题的工作流。',
      name: '短视频选题',
      status: 'running',
      phase: 'generating-workflow',
      model: { providerId: 'provider-a', modelId: 'model-a' },
      events: [
        { phase: 'preparing', status: 'running', message: '正在整理需求。', time: '2026-08-31T10:00:00.000Z' },
        { phase: 'generating-workflow', status: 'running', message: '正在生成工作流结构。', time: '2026-08-31T10:00:02.000Z' },
      ],
      createdEmployees: [],
      startedAt: '2026-08-31T10:00:00.000Z',
      workflow,
    }
    const markup = renderToStaticMarkup(<WorkflowGenerationPage copy={getAppCopy('zh')} locale="zh" onBack={vi.fn()} onOpenWorkflow={vi.fn()} />)
    expect(markup).toContain('AI 生成工作流')
    expect(markup).toContain('开始生成')

    const withHistory = renderToStaticMarkup(<WorkflowGenerationProgressView copy={getAppCopy('zh')} locale="zh" record={record} onOpenWorkflow={vi.fn()} />)
    expect(withHistory).toContain('用户原始要求')
    expect(withHistory).toContain(record.prompt)
    expect(withHistory).not.toContain('固定生成流程')
    expect(withHistory).toContain('规划专业员工')
    expect(withHistory).toContain('生成工作流结构')
  })

  it('replaces live records without duplicating history entries', () => {
    const base = createRecord('running', 'preparing')
    const updated = { ...base, phase: 'completed' as const, status: 'completed' as const, completedAt: '2026-08-31T10:01:00.000Z' }
    expect(mergeWorkflowGenerationRecord([base], updated)).toEqual([updated])
  })

  it('shows a stop action for running generation and preserves the cancelled state in history', () => {
    const stop = vi.fn()
    const running = createRecord('running', 'generating-workflow')
    const runningMarkup = renderToStaticMarkup(<WorkflowGenerationProgressView copy={getAppCopy('zh')} locale="zh" record={running} onOpenWorkflow={vi.fn()} onStopGeneration={stop} />)
    expect(runningMarkup).toContain('停止生成')

    const cancelled = { ...running, status: 'cancelled' as const, phase: 'cancelled' as const, error: '用户终止了工作流生成。', events: [{ phase: 'cancelled' as const, status: 'cancelled' as const, message: '用户终止了工作流生成。', time: '2026-08-31T10:00:03.000Z' }] }
    const cancelledMarkup = renderToStaticMarkup(<WorkflowGenerationProgressView copy={getAppCopy('zh')} locale="zh" record={cancelled} onOpenWorkflow={vi.fn()} onStopGeneration={stop} />)
    expect(cancelledMarkup).toContain('已由用户终止')
    expect(cancelledMarkup).toContain('用户终止了工作流生成。')
    expect(cancelledMarkup).not.toContain('停止生成')
  })

  it('shows a resume action for interrupted generation records', () => {
    const failed = createRecord('failed', 'failed')
    const markup = renderToStaticMarkup(<WorkflowGenerationProgressView copy={getAppCopy('zh')} locale="zh" record={failed} onOpenWorkflow={vi.fn()} onResumeGeneration={vi.fn()} />)
    expect(markup).toContain('从断点继续')
    expect(markup).toContain('不要重复已完成的步骤')
  })
})

function createRecord(status: WorkflowGenerationRecord['status'], phase: WorkflowGenerationRecord['phase']): WorkflowGenerationRecord {
  return {
    id: 'generation-1',
    prompt: 'test',
    name: 'test',
    status,
    phase,
    events: [],
    createdEmployees: [],
    startedAt: '2026-08-31T10:00:00.000Z',
  }
}
