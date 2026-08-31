import { describe, expect, it } from 'vitest'
import { WORKFLOW_CANVAS_INTERACTION_PROPS } from '../../src/renderer/workflow/WorkflowPage.js'
import { normalizeWorkflowSelectionRect, workflowSelectionCoverage, workflowSelectionNodeIds } from '../../src/renderer/workflow/workflow-selection.js'

describe('workflow selection coverage', () => {
  it('uses React Flow partial candidates before applying the 50% threshold', () => {
    expect(WORKFLOW_CANVAS_INTERACTION_PROPS.selectionMode).toBe('partial')
  })

  it('selects a node when at least half of its area is covered', () => {
    const nodeRect = { x: 100, y: 100, width: 200, height: 100 }
    const nodeRects = new Map([['node', nodeRect]])

    expect(workflowSelectionCoverage(nodeRect, normalizeWorkflowSelectionRect(100, 100, 200, 200))).toBe(0.5)
    expect(workflowSelectionNodeIds([{ id: 'node' }], nodeRects, normalizeWorkflowSelectionRect(100, 100, 200, 200))).toEqual(['node'])
    expect(workflowSelectionNodeIds([{ id: 'node' }], nodeRects, normalizeWorkflowSelectionRect(100, 100, 199, 200))).toEqual([])
  })

  it('normalizes reverse drag rectangles and skips non-selectable nodes', () => {
    const nodeRects = new Map<string, { x: number; y: number; width: number; height: number }>([
      ['selected', { x: 100, y: 100, width: 100, height: 100 }],
      ['locked', { x: 100, y: 100, width: 100, height: 100 }],
    ])

    expect(normalizeWorkflowSelectionRect(200, 200, 50, 50)).toEqual({ x: 50, y: 50, width: 150, height: 150 })
    expect(workflowSelectionNodeIds([{ id: 'selected' }, { id: 'locked', selectable: false }], nodeRects, normalizeWorkflowSelectionRect(200, 200, 50, 50))).toEqual(['selected'])
  })
})
