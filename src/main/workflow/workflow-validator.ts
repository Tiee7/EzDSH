import { formatWorkflowValidationIssues, normalizeWorkflow, validateWorkflow, workflowNodeDependencyIds, type WorkflowDefinition, type WorkflowValidationResult } from '../../shared/workflow.js'

/** Normalize and validate untrusted input before it enters the workflow store. */
export function validateWorkflowInput(raw: unknown): { workflow?: WorkflowDefinition; result: WorkflowValidationResult } {
  const workflow = normalizeWorkflow(raw)
  if (workflow === undefined) {
    return { result: { valid: false, issues: [{ path: '', message: 'Workflow 文档格式无效。' }] } }
  }
  return { workflow, result: validateWorkflow(workflow) }
}

export function assertValidWorkflow(workflow: WorkflowDefinition, action = '校验工作流'): void {
  const result = validateWorkflow(workflow)
  if (!result.valid) throw new Error(formatWorkflowValidationIssues(workflow, result.issues, action))
}

export function topologicalOrder(workflow: WorkflowDefinition): string[] {
  assertValidWorkflow(workflow)
  const incoming = new Map(workflow.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const node of workflow.nodes) {
    for (const source of workflowNodeDependencyIds(workflow, node)) {
      incoming.set(node.id, (incoming.get(node.id) ?? 0) + 1)
      outgoing.set(source, [...(outgoing.get(source) ?? []), node.id])
    }
  }
  const queue = workflow.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
  const result: string[] = []
  while (queue.length > 0) {
    const id = queue.shift() as string
    result.push(id)
    for (const target of outgoing.get(id) ?? []) {
      const next = (incoming.get(target) ?? 0) - 1
      incoming.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  if (result.length !== workflow.nodes.length) throw new Error('Workflow contains a cycle')
  return result
}
