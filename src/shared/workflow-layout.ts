import type { WorkflowDefinition } from './workflow.js'

export const WORKFLOW_LAYOUT = {
  startX: 80,
  startY: 180,
  columnGap: 264,
  rowGap: 120,
} as const

/**
 * Lay out a workflow from its dependency graph, not from model-provided
 * coordinates. Nodes in the same dependency depth form a centred column.
 */
export function layoutWorkflowNodes(workflow: WorkflowDefinition): WorkflowDefinition {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id))
  const incoming = new Map(workflow.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) continue
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  }

  const orderById = new Map(workflow.nodes.map((node, index) => [node.id, index]))
  const queue = workflow.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
  const depth = new Map<string, number>()
  for (const nodeId of queue) depth.set(nodeId, 0)
  while (queue.length > 0) {
    const source = queue.shift() as string
    const sourceDepth = depth.get(source) ?? 0
    for (const target of outgoing.get(source) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, sourceDepth + 1))
      const remaining = (incoming.get(target) ?? 0) - 1
      incoming.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }

  // A malformed imported graph may contain a cycle. Put any unresolved nodes
  // after the resolved graph so the canvas remains usable while validation
  // reports the graph issue.
  let fallbackDepth = Math.max(-1, ...depth.values()) + 1
  for (const node of workflow.nodes) {
    if (!depth.has(node.id)) depth.set(node.id, fallbackDepth++)
  }

  const columns = new Map<number, string[]>()
  for (const node of workflow.nodes) {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node.id])
  }
  for (const ids of columns.values()) ids.sort((left, right) => (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0))

  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const column = depth.get(node.id) ?? 0
      const row = (columns.get(column) ?? []).indexOf(node.id)
      const count = columns.get(column)?.length ?? 1
      return {
        ...node,
        position: {
          x: WORKFLOW_LAYOUT.startX + column * WORKFLOW_LAYOUT.columnGap,
          y: WORKFLOW_LAYOUT.startY + (row - (count - 1) / 2) * WORKFLOW_LAYOUT.rowGap,
        },
      }
    }),
  }
}
