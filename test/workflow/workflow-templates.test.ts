import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow.js'
import { createShortVideoContentWorkflow, SHORT_VIDEO_EMPLOYEE_IDS } from '../../src/shared/workflow-templates.js'

describe('short-video content workflow template', () => {
  it('creates a valid reviewable content pipeline', () => {
    const workflow = createShortVideoContentWorkflow()

    expect(validateWorkflow(workflow)).toEqual({ valid: true, issues: [] })
    expect(workflow.nodes.map((node) => node.type)).toEqual([
      'input',
      'employee',
      'employee',
      'employee',
      'employee',
      'approval',
      'output',
    ])
    expect(workflow.nodes.filter((node) => node.type === 'employee').map((node) => node.config.employeeId)).toEqual([
      SHORT_VIDEO_EMPLOYEE_IDS.topicPlanner,
      SHORT_VIDEO_EMPLOYEE_IDS.researcher,
      SHORT_VIDEO_EMPLOYEE_IDS.copywriter,
      SHORT_VIDEO_EMPLOYEE_IDS.reviewer,
    ])
    expect(workflow.nodes.filter((node) => node.type === 'employee').every((node) => node.config.outputMode === 'json')).toBe(true)
    expect(workflow.nodes.find((node) => node.type === 'approval')).toMatchObject({
      config: { message: '内容审核已完成，请确认是否将成果加入待制作内容列表。' },
    })
  })
})
