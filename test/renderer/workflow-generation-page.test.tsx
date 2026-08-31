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
    expect(markup).toContain('固定生成流程')
    expect(markup).toContain('开始生成')

    const withHistory = renderToStaticMarkup(<WorkflowGenerationProgressView copy={getAppCopy('zh')} locale="zh" record={record} onOpenWorkflow={vi.fn()} />)
    expect(withHistory).toContain('规划专业员工')
    expect(withHistory).toContain('生成工作流结构')
  })

  it('replaces live records without duplicating history entries', () => {
    const base = createRecord('running', 'preparing')
    const updated = { ...base, phase: 'completed' as const, status: 'completed' as const, completedAt: '2026-08-31T10:01:00.000Z' }
    expect(mergeWorkflowGenerationRecord([base], updated)).toEqual([updated])
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
