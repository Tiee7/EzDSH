import { forwardRef, useCallback, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

export interface WorkflowSelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkflowSelectionNode {
  id: string
  selectable?: boolean
}

/** Return the fraction of a node's area covered by a selection rectangle. */
export function workflowSelectionCoverage(nodeRect: WorkflowSelectionRect, selectionRect: WorkflowSelectionRect): number {
  const nodeArea = Math.max(0, nodeRect.width) * Math.max(0, nodeRect.height)
  if (nodeArea === 0) return 0
  const overlapWidth = Math.max(0, Math.min(nodeRect.x + nodeRect.width, selectionRect.x + selectionRect.width) - Math.max(nodeRect.x, selectionRect.x))
  const overlapHeight = Math.max(0, Math.min(nodeRect.y + nodeRect.height, selectionRect.y + selectionRect.height) - Math.max(nodeRect.y, selectionRect.y))
  return (overlapWidth * overlapHeight) / nodeArea
}

export function workflowSelectionNodeIds(nodes: readonly WorkflowSelectionNode[], nodeRects: ReadonlyMap<string, WorkflowSelectionRect>, selectionRect: WorkflowSelectionRect, threshold = 0.5): string[] {
  return nodes.filter((node) => node.selectable !== false).filter((node) => {
    const nodeRect = nodeRects.get(node.id)
    return nodeRect !== undefined && workflowSelectionCoverage(nodeRect, selectionRect) >= threshold
  }).map((node) => node.id)
}

export function normalizeWorkflowSelectionRect(startX: number, startY: number, endX: number, endY: number): WorkflowSelectionRect {
  return { x: Math.min(startX, endX), y: Math.min(startY, endY), width: Math.abs(endX - startX), height: Math.abs(endY - startY) }
}

interface WorkflowSelectionGesture {
  pointerId: number
  startX: number
  startY: number
  endX: number
  endY: number
  active: boolean
}

type WorkflowSelectionSurfaceProps = Omit<HTMLAttributes<HTMLDivElement>, 'onPointerDownCapture' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'> & {
  nodes: readonly WorkflowSelectionNode[]
  onSelectionChange: (nodeIds: string[]) => void
  onPointerDownCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void
  threshold?: number
  children?: ReactNode
}

/**
 * React Flow supports only all-or-nothing or any-overlap selection. This surface
 * keeps React Flow's partial selection candidates, then applies the product's
 * 50% node-area threshold from the rendered node bounds.
 */
export const WorkflowSelectionSurface = forwardRef<HTMLDivElement, WorkflowSelectionSurfaceProps>(function WorkflowSelectionSurface({ nodes, onSelectionChange, threshold = 0.5, children, onPointerDownCapture, ...props }, ref) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<WorkflowSelectionGesture>()
  const lastSelectionKeyRef = useRef('')

  const commitSelection = useCallback((gesture: WorkflowSelectionGesture): void => {
    const surface = surfaceRef.current
    if (surface === null) return
    const selectionRect = normalizeWorkflowSelectionRect(gesture.startX, gesture.startY, gesture.endX, gesture.endY)
    if (selectionRect.width === 0 || selectionRect.height === 0) return
    const nodeRects = new Map<string, WorkflowSelectionRect>()
    for (const element of surface.querySelectorAll<HTMLElement>('.react-flow__node')) {
      const nodeId = element.dataset.id
      if (nodeId === undefined) continue
      const rect = element.getBoundingClientRect()
      nodeRects.set(nodeId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    const selectedNodeIds = workflowSelectionNodeIds(nodes, nodeRects, selectionRect, threshold)
    const selectionKey = selectedNodeIds.join('\u0000')
    if (selectionKey === lastSelectionKeyRef.current) return
    lastSelectionKeyRef.current = selectionKey
    onSelectionChange(selectedNodeIds)
  }, [nodes, onSelectionChange, threshold])

  const handlePointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    onPointerDownCapture?.(event)
    const target = event.target
    if (!(target instanceof Element) || event.button !== 0 || !event.isPrimary || target.closest('.react-flow__pane') === null || target.closest('.react-flow__node, .react-flow__edge, .react-flow__handle') !== null) {
      gestureRef.current = undefined
      return
    }
    gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, endX: event.clientX, endY: event.clientY, active: false }
    lastSelectionKeyRef.current = ''
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return
    gesture.endX = event.clientX
    gesture.endY = event.clientY
    if (!gesture.active && Math.hypot(gesture.endX - gesture.startX, gesture.endY - gesture.startY) > 1) gesture.active = true
    if (gesture.active) commitSelection(gesture)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return
    gesture.endX = event.clientX
    gesture.endY = event.clientY
    if (gesture.active) commitSelection(gesture)
    gestureRef.current = undefined
  }

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = undefined
  }

  return <div ref={(element) => { surfaceRef.current = element; if (typeof ref === 'function') ref(element); else if (ref !== null) (ref as { current: HTMLDivElement | null }).current = element }} {...props} onPointerDownCapture={handlePointerDownCapture} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerCancel}>{children}</div>
})

WorkflowSelectionSurface.displayName = 'WorkflowSelectionSurface'
