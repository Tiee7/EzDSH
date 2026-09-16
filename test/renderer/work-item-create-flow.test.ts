import { describe, expect, it } from 'vitest'
import {
  buildWorkItemCreateSubmission,
  finalizeWorkItemCreateExecution,
} from '../../src/renderer/work-items/work-item-create-flow.js'
import type { WorkTaskSnapshot } from '../../src/shared/work-items.js'

const createdSnapshot: WorkTaskSnapshot = {
  task: {
    id: 'task-created',
    revision: 3,
    title: '季度复盘',
    scope: { resourceRefs: [] },
    requirements: [{ version: 1, goal: '总结本季度', acceptance: '包含三项改进', createdAt: '2026-09-16' }],
    currentRequirementVersion: 1,
    status: 'open',
    acceptedArtifactIds: [],
    createdAt: '2026-09-16',
    updatedAt: '2026-09-16',
  },
  attempts: [],
  runs: [],
  artifacts: [],
  actions: [],
}

describe('direct work item creation flow', () => {
  it('builds a trimmed create-only request without inventing execution identity', () => {
    const submission = buildWorkItemCreateSubmission({
      title: '  季度复盘  ',
      goal: '  总结本季度  ',
      acceptance: '  包含三项改进  ',
      projectId: '  project-1  ',
      cwd: '  /workspace/project-1  ',
      executor: { kind: 'none' },
      executionInput: undefined,
      createRequestId: 'create-1',
      executeRequestId: 'execute-1',
    })

    expect(submission).toEqual({
      create: {
        requestId: 'create-1',
        title: '季度复盘',
        goal: '总结本季度',
        acceptance: '包含三项改进',
        scope: { projectId: 'project-1', cwd: '/workspace/project-1', resourceRefs: [] },
      },
    })
    expect(JSON.stringify(submission)).not.toContain('__created_task__')
  })

  it('keeps employee execution as a draft until the created snapshot can finalize it', () => {
    const submission = buildWorkItemCreateSubmission({
      title: '季度复盘',
      goal: '总结本季度',
      acceptance: '包含三项改进',
      executor: { kind: 'employee', employeeId: 'analyst' },
      executionInput: '先核对数据，再给出结论',
      createRequestId: 'create-employee',
      executeRequestId: 'execute-employee',
    })

    expect(submission.execute).toEqual({
      requestId: 'execute-employee',
      executor: { kind: 'employee', employeeId: 'analyst' },
      mode: 'initial',
      input: '先核对数据，再给出结论',
    })
    expect(submission.execute).not.toHaveProperty('taskId')
    expect(submission.execute).not.toHaveProperty('expectedRevision')
    expect(finalizeWorkItemCreateExecution(submission.execute!, createdSnapshot)).toEqual({
      requestId: 'execute-employee',
      taskId: 'task-created',
      expectedRevision: 3,
      executor: { kind: 'employee', employeeId: 'analyst' },
      mode: 'initial',
      input: '先核对数据，再给出结论',
    })
  })

  it('preserves a workflow revision and JSON input in the execution draft', () => {
    const submission = buildWorkItemCreateSubmission({
      title: '生成报告',
      goal: '形成正式报告',
      acceptance: '结构完整',
      executor: { kind: 'workflow', workflowId: 'report-flow', workflowRevision: 7 },
      executionInput: { topic: 'Q3', includeSources: true },
      createRequestId: 'create-workflow',
      executeRequestId: 'execute-workflow',
    })

    expect(submission.execute).toEqual({
      requestId: 'execute-workflow',
      executor: { kind: 'workflow', workflowId: 'report-flow', workflowRevision: 7 },
      mode: 'initial',
      input: { topic: 'Q3', includeSources: true },
    })
  })

  it.each(['title', 'goal', 'acceptance'] as const)('rejects a blank required %s', (field) => {
    expect(() => buildWorkItemCreateSubmission({
      title: field === 'title' ? '   ' : '标题',
      goal: field === 'goal' ? '   ' : '目标',
      acceptance: field === 'acceptance' ? '   ' : '验收标准',
      executor: { kind: 'none' },
      executionInput: undefined,
      createRequestId: 'create-required',
      executeRequestId: 'execute-required',
    })).toThrow(`${field} is required`)
  })
})
