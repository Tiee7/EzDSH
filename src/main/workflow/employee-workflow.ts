import { randomUUID } from 'node:crypto'
import { employeeDisplayName, type EmployeeDefinition } from '../../shared/employees.js'
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowNode, type WorkflowEdge } from '../../shared/workflow.js'

/** Create a quick workflow that invokes one reusable professional employee. */
export function workflowFromEmployee(employee: EmployeeDefinition): WorkflowDefinition {
  const timestamp = new Date().toISOString()
  const inputId = `input-${randomUUID()}`
  const employeeNodeId = `employee-${employee.id}-${randomUUID().slice(0, 6)}`
  const outputId = `output-${randomUUID()}`
  const nodes: WorkflowNode[] = [
    { id: inputId, type: 'input', label: '任务输入', config: { name: 'task' }, position: { x: 40, y: 180 } },
    {
      id: employeeNodeId,
      type: 'employee',
      // Keep the compact legacy role label in the node body; the personal
      // displayName is rendered separately in the canvas corner.
      label: employee.name,
      config: {
        employeeId: employee.id,
        instruction: '在岗位业务边界内完成输入任务。',
        outputMode: 'text',
      },
      position: { x: 360, y: 180 },
    },
    { id: outputId, type: 'output', label: '任务输出', config: {}, position: { x: 680, y: 180 } },
  ]
  const edges: WorkflowEdge[] = [
    { id: `edge-${randomUUID()}`, source: inputId, target: employeeNodeId },
    { id: `edge-${randomUUID()}`, source: employeeNodeId, target: outputId },
  ]
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: `workflow-${employee.id}-${randomUUID().slice(0, 8)}`,
    name: `${employeeDisplayName(employee)} Workflow`,
    description: employee.description,
    revision: 1,
    nodes,
    edges,
    enabled: employee.enabled,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}
