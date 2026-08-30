import type { EmployeeSnapshot } from '../../shared/employees.js'
import { interpolateWorkflowVariables, isWorkflowValue, type WorkflowModelSelection, type WorkflowNode, type WorkflowNodeOutputVariable, type WorkflowOutputMode, type WorkflowValue } from '../../shared/workflow.js'

/** Minimal DSH contract used only for employee and legacy Skill internal sessions. */
export interface WorkflowSessionClient {
  createSession(params: { cwd: string }): Promise<{ sessionId: string }>
  selectSessionModel?(sessionId: string, selection: { provider: string; model: string }): Promise<unknown>
  sendPrompt(sessionId: string, text: string): Promise<{ text: string }>
  cancelSession?(sessionId: string): Promise<void>
  archiveSession?(sessionId: string): Promise<unknown>
}

export interface DshWorkflowAdapterOptions {
  cwd: string
  createClient: () => WorkflowSessionClient
}

interface InstructionNode {
  id: string
  label: string
  type: string
  outputVariables?: WorkflowNodeOutputVariable[]
}

/**
 * DSH is intentionally a narrow adapter: it owns only isolated employee and
 * Skill sessions. Lightweight AI, MCP, shell, and file nodes bypass it.
 */
export class DshWorkflowAdapter {
  constructor(private readonly options: DshWorkflowAdapterOptions) {}

  async createInternalSession(model?: WorkflowModelSelection): Promise<string> {
    const client = this.options.createClient()
    const sessionId = (await client.createSession({ cwd: this.options.cwd })).sessionId
    if (model !== undefined) {
      await client.selectSessionModel?.(sessionId, { provider: model.providerId, model: model.modelId })
    }
    return sessionId
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.options.createClient().cancelSession?.(sessionId)
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.options.createClient().archiveSession?.(sessionId)
  }

  async executeEmployeeInSession(
    sessionId: string,
    node: Extract<WorkflowNode, { type: 'employee' }>,
    employee: EmployeeSnapshot,
    input: WorkflowValue,
    previous: WorkflowValue,
  ): Promise<WorkflowValue> {
    const profile = [
      `你是“${employee.name}”，岗位是“${employee.role}”。`,
      `业务边界：${employee.businessBoundary}`,
      `专业原则：${employee.systemPrompt}`,
      `执行规范：\n${employee.operatingGuidelines.map((item) => `- ${item}`).join('\n') || '- 无额外规范'}`,
      `质量标准：\n${employee.qualityStandards.map((item) => `- ${item}`).join('\n') || '- 无额外标准'}`,
      `允许使用的技能：${employee.skillIds.join('、') || '无指定技能'}`,
    ].join('\n\n')
    return this.executeInstructionInSession(sessionId, node, node.config.instruction, input, previous, profile, node.config.outputMode)
  }

  async executeSkillInSession(
    sessionId: string,
    node: Extract<WorkflowNode, { type: 'skill' }>,
    input: WorkflowValue,
    previous: WorkflowValue,
  ): Promise<WorkflowValue> {
    return this.executeInstructionInSession(
      sessionId,
      node,
      `请使用已安装的 Skill：${node.config.skillId}\n${node.config.instruction}`,
      input,
      previous,
      undefined,
      'text',
    )
  }

  private async executeInstructionInSession(
    sessionId: string,
    node: InstructionNode,
    instruction: string,
    input: WorkflowValue,
    previous: WorkflowValue,
    systemPrompt: string | undefined,
    outputMode: WorkflowOutputMode,
  ): Promise<WorkflowValue> {
    const client = this.options.createClient()
    const result = await client.sendPrompt(sessionId, buildNodePrompt(node, instruction, input, previous, systemPrompt, outputMode))
    if (outputMode === 'text') return result.text.trim()
    try {
      return parseWorkflowJson(result.text)
    } catch {
      const repair = await client.sendPrompt(sessionId, [
        '上一次输出不是有效的 JSON。请修复格式并只输出一个有效 JSON 文档，不要解释，不要使用 Markdown 代码围栏。',
        '需要修复的输出：',
        result.text,
      ].join('\n\n'))
      try {
        return parseWorkflowJson(repair.text)
      } catch {
        throw new Error(`节点“${node.label}”未返回有效 JSON`)
      }
    }
  }
}

export function buildNodePrompt(
  node: InstructionNode,
  instruction: string,
  input: WorkflowValue,
  previous: WorkflowValue,
  systemPrompt: string | undefined,
  outputMode: WorkflowOutputMode,
): string {
  const variables = previous !== null && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  const renderedInstruction = interpolateWorkflowVariables(instruction, variables)
  const renderedSystemPrompt = systemPrompt === undefined ? undefined : interpolateWorkflowVariables(systemPrompt, variables)
  const outputVariables = node.outputVariables?.filter((variable) => variable.name !== 'result') ?? []
  return [
    '你正在执行 EZDSH 工作流的一个节点。请只完成节点指令，不要修改工作流结构。',
    `节点类型：${node.type}`,
    `节点名称：${node.label}`,
    `本次工作流输入：${JSON.stringify(input)}`,
    `节点输入变量：${JSON.stringify(previous)}`,
    renderedSystemPrompt === undefined || renderedSystemPrompt.trim() === '' ? '' : `工作原则：\n${renderedSystemPrompt}`,
    outputVariables.length === 0 ? '' : `结构化输出字段：${outputVariables.map((variable) => `${variable.name}${variable.description === undefined ? '' : `（${variable.description}）`}`).join('、')}。`,
    `节点指令：${renderedInstruction}`,
    outputMode === 'json' ? '输出要求：只输出一个 JSON 文档，不要解释，不要使用 Markdown 代码围栏。' : '',
  ].filter(Boolean).join('\n\n')
}

export function parseWorkflowJson(text: string): WorkflowValue {
  const value = extractJsonDocument(text)
  if (!isWorkflowValue(value)) throw new Error('JSON 包含不支持的值')
  return value
}

export function extractJsonDocument(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    const objectStart = trimmed.indexOf('{')
    const objectEnd = trimmed.lastIndexOf('}')
    const arrayStart = trimmed.indexOf('[')
    const arrayEnd = trimmed.lastIndexOf(']')
    const useArray = arrayStart >= 0 && arrayEnd > arrayStart && (objectStart < 0 || arrayStart < objectStart)
    const start = useArray ? arrayStart : objectStart
    const end = useArray ? arrayEnd : objectEnd
    if (start < 0 || end <= start) throw new Error('AI 返回的 Workflow 不是有效 JSON')
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown
  }
}
