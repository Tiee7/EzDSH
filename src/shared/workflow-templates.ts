import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from './workflow.js'

export const SHORT_VIDEO_EMPLOYEE_IDS = {
  topicPlanner: 'content-topic-planner',
  researcher: 'researcher',
  copywriter: 'douyin-copywriter',
  reviewer: 'content-reviewer',
} as const

const instructions = {
  topicPlanner: '根据项目输入生成候选选题。只输出包含 topics 数组的 JSON，每个选题包含 id、title、audience、angle、hook、expectedValue、evidenceNeeded、riskTags 和 scores。',
  researcher: '为上游候选选题补充事实、来源、推断和未知项。只输出包含 researchPackages 数组的 JSON。',
  copywriter: '根据上游选题和调研素材生成可拍摄脚本。只输出包含 scripts 数组的 JSON，每个脚本包含 topicId、title、hook、segments、callToAction、sourceArtifactIds、estimatedDurationSeconds 和 tags。',
  reviewer: '审核上游脚本的钩子、逻辑、证据、品牌一致性和安全性。只输出包含 reviews 数组的 JSON，每项包含 topicId、decision、scores、issues 和 requiresHumanReview。',
} as const

function uniqueId(prefix: string): string {
  const entropy = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${entropy}`
}

export function createShortVideoContentWorkflow(name = '短视频内容运营'): WorkflowDefinition {
  const createdAt = new Date().toISOString()
  const nodes: WorkflowNode[] = [
    { id: 'content-input', type: 'input', label: '内容需求', config: { name: 'task' }, position: { x: 40, y: 180 } },
    {
      id: 'topic-planning',
      type: 'employee',
      label: '选题策划',
      config: { employeeId: SHORT_VIDEO_EMPLOYEE_IDS.topicPlanner, instruction: instructions.topicPlanner, outputMode: 'json' },
      position: { x: 300, y: 180 },
    },
    {
      id: 'content-research',
      type: 'employee',
      label: '资料调研',
      config: { employeeId: SHORT_VIDEO_EMPLOYEE_IDS.researcher, instruction: instructions.researcher, outputMode: 'json' },
      position: { x: 560, y: 180 },
    },
    {
      id: 'content-copywriting',
      type: 'employee',
      label: '脚本文案',
      config: { employeeId: SHORT_VIDEO_EMPLOYEE_IDS.copywriter, instruction: instructions.copywriter, outputMode: 'json' },
      position: { x: 820, y: 180 },
    },
    {
      id: 'content-review',
      type: 'employee',
      label: '内容审核',
      config: { employeeId: SHORT_VIDEO_EMPLOYEE_IDS.reviewer, instruction: instructions.reviewer, outputMode: 'json' },
      position: { x: 1080, y: 180 },
    },
    {
      id: 'content-approval',
      type: 'approval',
      label: '人工审批',
      config: { message: '内容审核已完成，请确认是否将成果加入待制作内容列表。' },
      position: { x: 1340, y: 180 },
    },
    { id: 'content-output', type: 'output', label: '待制作内容成果', config: {}, position: { x: 1600, y: 180 } },
  ]
  const edges: WorkflowEdge[] = nodes.slice(0, -1).map((node, index) => ({
    id: `content-edge-${index + 1}`,
    source: node.id,
    target: nodes[index + 1]?.id as string,
  }))
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: uniqueId('workflow-short-video-content'),
    name,
    description: '从内容需求出发，依次完成选题、调研、脚本文案与审核，最后由用户人工审批。不会自动发布。',
    revision: 1,
    nodes,
    edges,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
  }
}
