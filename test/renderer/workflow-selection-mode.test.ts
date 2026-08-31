import { describe, expect, it } from 'vitest'
import { WORKFLOW_CANVAS_INTERACTION_PROPS } from '../../src/renderer/workflow/WorkflowPage.js'

describe('workflow canvas selection', () => {
  it('uses React Flow partial selection for stable overlap-based box selection', () => {
    expect(WORKFLOW_CANVAS_INTERACTION_PROPS.selectionMode).toBe('partial')
  })
})
