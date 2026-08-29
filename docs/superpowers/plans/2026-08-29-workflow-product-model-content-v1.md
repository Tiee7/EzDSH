# Workflow Product Model and Content Operations V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the competing Employee/Agent workflow concepts with reusable professional employees and lightweight AI tasks, then deliver a manually runnable short-video content-operations workflow template.

**Architecture:** Migrate persisted employee profiles and workflow documents at normalization boundaries, keeping the Electron Renderer declarative and the Main process responsible for execution. Workflow schema V2 adds `ai-task` and `employee` nodes; the DSH adapter executes both through its stable Session API, while employee identity, boundaries, skills, and quality rules are resolved from `EmployeeService`. A built-in content workflow composes topic planning, research, copywriting, review, approval, and output without scheduling or external publishing.

**Tech Stack:** TypeScript 5.9, React 18, Electron IPC/contextBridge, React Flow, DSH Session API, Vitest.

## Global Constraints

- Continue using the repository's current development setup; do not add self-development or self-update infrastructure.
- Do not add scheduling, Headless Worker, remote Worker, workflow publishing, or external short-video publishing in this plan.
- Preserve existing persisted employees and workflows through explicit normalization migration.
- Do not expose the word `Agent` as a normal canvas node label.
- An AI task must work without an employee; an employee node must reference a reusable employee profile.
- Employee profiles must not contain an executable internal workflow after migration.
- Node inputs and outputs remain JSON-safe `WorkflowValue` values.
- Employee memories, candidate-experience persistence, and automatic employee upgrades are outside this plan.
- Do not add arbitrary JavaScript, `eval`, or renderer-side Node capabilities.
- Use TDD for every behavior change and commit only files belonging to the completed task.

---

## File Structure

### Shared contracts

- `src/shared/employees.ts`: Employee profile V2, versioned identity, business boundary, guidelines, quality standards, and skill IDs.
- `src/shared/workflow.ts`: Workflow schema V2 and `ai-task`/`employee` node contracts plus V1 migration.
- `src/shared/workflow-templates.ts`: Built-in short-video workflow factory and required employee IDs.
- `src/shared/locale.ts`: Chinese and English product copy for the new concepts and template.

### Main process

- `src/main/employees/employee-service.ts`: Employee persistence migration, built-in profiles, single-task test execution, and profile lookup.
- `src/main/workflow/dsh-workflow-adapter.ts`: AI-task and employee prompt construction plus JSON-output parsing/repair.
- `src/main/workflow/workflow-run-service.ts`: Node dispatch and employee resolution.
- `src/main/workflow/workflow-store.ts`: Workflow schema-version writes.
- `src/main/workflow/employee-workflow.ts`: Backward-compatible Input → Employee → Output workflow conversion.
- `src/main/index.ts`: Inject `EmployeeService` into workflow execution and remove developer-only employee import gating.

### Renderer

- `src/renderer/employees/EmployeesPage.tsx`: Profile editor with no internal workflow-step editor.
- `src/renderer/employees/employees.css`: Profile-section styles.
- `src/renderer/workflow/WorkflowPage.tsx`: AI task, professional employee, and content-template UX.
- `src/renderer/workflow/workflow.css`: Node-mode, employee selector, and template action styles.

### Tests

- `test/employees/employee-service.test.ts`: Employee V1 migration, V2 persistence, versioning, and one-call execution.
- `test/workflow/workflow.test.ts`: Workflow V1 Agent migration and V2 node validation.
- `test/workflow/workflow-store.test.ts`: V2 persistence after loading legacy documents.
- `test/workflow/workflow-run-service.test.ts`: AI task, employee resolution, disabled employee, and JSON repair.
- `test/workflow/workflow-templates.test.ts`: Content workflow structure and validation.
- `test/renderer/employees-page.test.tsx`: Profile editor semantics.
- `test/renderer/workflow-page.test.tsx`: New node labels, employee selector, and template creation.

---

### Task 1: Define Employee Profile V2 and migrate persisted execution

**Files:**
- Modify: `src/shared/employees.ts`
- Modify: `src/main/employees/employee-service.ts`
- Test: `test/employees/employee-service.test.ts`

**Interfaces:**
- Produces: `EMPLOYEE_SCHEMA_VERSION`, `EmployeeDefinition.version`, `businessBoundary`, `operatingGuidelines`, `qualityStandards`, and `skillIds`.
- Produces: `EmployeeService.get(id: string): EmployeeSnapshot | undefined` and one-call direct employee execution.
- Preserves: `EmployeeCreateInput`, `EmployeeUpdateInput`, `EmployeeRunResult`, project/session APIs, and session locking.

- [ ] **Step 1: Write failing migration and profile-version tests**

Add tests proving that old `workflow` steps become non-executable guidelines and that an update increments the profile version:

```ts
it('migrates legacy employee workflow steps into profile guidelines', async () => {
  const { service, root } = await createService()
  await writeFile(join(root, 'employees.json'), JSON.stringify([{
    id: 'legacy-writer',
    name: '旧版文案员',
    role: '文案',
    description: '旧数据',
    systemPrompt: '保持真实。',
    capabilities: ['copywriting'],
    workflow: [
      { id: 'draft', name: '写初稿', instruction: '先写初稿。', enabled: true },
      { id: 'check', name: '检查', instruction: '检查事实。', enabled: true },
    ],
    enabled: true,
    builtIn: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]))

  await service.initialize()
  expect(service.get('legacy-writer')).toMatchObject({
    schemaVersion: 2,
    version: 1,
    businessBoundary: '旧数据',
    operatingGuidelines: ['写初稿：先写初稿。', '检查：检查事实。'],
    qualityStandards: [],
    skillIds: [],
  })
  expect(service.get('legacy-writer')).not.toHaveProperty('workflow')
})

it('increments the employee version when the profile changes', async () => {
  const { service } = await createService()
  await service.initialize()
  const before = service.get(DEFAULT_RESEARCH_EMPLOYEE.id)!
  const after = await service.update(before.id, { businessBoundary: '只处理可验证的研究任务。' })
  expect(after.version).toBe(before.version + 1)
})
```

- [ ] **Step 2: Run the employee tests and verify the new expectations fail**

Run:

```bash
npx vitest run test/employees/employee-service.test.ts
```

Expected: FAIL because the V1 employee shape still exposes `workflow`, has no schema/version fields, and `EmployeeService.get` does not exist.

- [ ] **Step 3: Replace the public employee contract with Profile V2**

In `src/shared/employees.ts`, retain the capability enum for compatibility but replace executable workflow ownership with profile fields:

```ts
export const EMPLOYEE_SCHEMA_VERSION = 2 as const

export interface EmployeeDefinition {
  schemaVersion: typeof EMPLOYEE_SCHEMA_VERSION
  version: number
  id: string
  name: string
  role: string
  description: string
  businessBoundary: string
  systemPrompt: string
  operatingGuidelines: string[]
  qualityStandards: string[]
  capabilities: EmployeeCapability[]
  skillIds: string[]
  enabled: boolean
  builtIn: boolean
  createdAt: string
  updatedAt: string
}

export type EmployeeSnapshot = EmployeeDefinition

export type EmployeeCreateInput = Omit<
  EmployeeDefinition,
  'schemaVersion' | 'version' | 'id' | 'createdAt' | 'updatedAt' | 'builtIn'
> & {
  id?: string
  builtIn?: boolean
}

export type EmployeeUpdateInput = Partial<Omit<
  EmployeeDefinition,
  'schemaVersion' | 'version' | 'id' | 'createdAt' | 'updatedAt' | 'builtIn'
>>
```

Keep `EmployeeWorkflowStep` exported only as a legacy persisted-input type, with a deprecation comment; do not include it in `EmployeeDefinition`.

- [ ] **Step 4: Implement employee normalization migration and lookup**

In `employee-service.ts`, normalize both V1 and V2 documents:

```ts
function normalizeDefinition(value: unknown): EmployeeDefinition {
  if (!isRecord(value)) throw new Error('Employee must be an object')
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  const role = stringValue(value.role)
  const systemPrompt = stringValue(value.systemPrompt)
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid employee id "${id}"`)
  if (name === '') throw new Error('Employee name is required')
  if (role === '') throw new Error('Employee role is required')
  if (systemPrompt === '') throw new Error('Employee system prompt is required')

  const legacySteps = normalizeLegacyWorkflow(value.workflow)
  const createdAt = stringValue(value.createdAt) || DEFAULT_TIMESTAMP
  return {
    schemaVersion: EMPLOYEE_SCHEMA_VERSION,
    version: positiveInteger(value.version) ?? 1,
    id,
    name,
    role,
    description: stringValue(value.description),
    businessBoundary: stringValue(value.businessBoundary) || stringValue(value.description),
    systemPrompt,
    operatingGuidelines: normalizeStringList(
      value.operatingGuidelines,
      legacySteps.map((step) => `${step.name}：${step.instruction}`),
    ),
    qualityStandards: normalizeStringList(value.qualityStandards),
    capabilities: normalizeCapabilities(value.capabilities),
    skillIds: normalizeIdList(value.skillIds),
    enabled: value.enabled !== false,
    builtIn: value.builtIn === true,
    createdAt,
    updatedAt: stringValue(value.updatedAt) || createdAt,
  }
}

get(id: string): EmployeeSnapshot | undefined {
  const employee = this.employees.get(id)
  return employee === undefined ? undefined : cloneEmployee(employee)
}
```

Set `schemaVersion: EMPLOYEE_SCHEMA_VERSION` and `version: 1` on create. On update, ignore incoming schema/version values and set `version: current.version + 1`. Update `cloneEmployee` to clone all four arrays.

Convert the existing poster, researcher, and copywriter defaults to V2 fields in this same step. Their legacy step instructions become `operatingGuidelines`; their final review requirements become `qualityStandards`.

Replace the legacy loop in `run` with one DSH call so the service compiles and persisted V2 profiles remain executable:

```ts
const response = await client.sendPrompt(session.sessionId, buildEmployeePrompt(employee, task, projectId, session.sessionId))
const output = response.text.trim()
const results: EmployeeRunStepResult[] = [{
  stepId: 'execute-task',
  name: '执行专业任务',
  status: 'completed',
  output,
}]
return {
  runId,
  employeeId: id,
  status: 'completed',
  output,
  steps: results,
  startedAt,
  completedAt: new Date().toISOString(),
}
```

Keep the existing cancellation checks and session-lock `finally` block around this single call. Update all employee-service fixtures and assertions to the V2 profile shape in this task.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run test/employees/employee-service.test.ts
```

Expected: PASS, including migration, versioning, persistence, direct execution, locking, cancellation, and built-in employee tests.

- [ ] **Step 6: Commit the profile contract and migration**

```bash
git add src/shared/employees.ts src/main/employees/employee-service.ts test/employees/employee-service.test.ts
git commit -m "refactor: define versioned employee profiles"
```

---

### Task 2: Seed the complete content team and strengthen professional prompts

**Files:**
- Modify: `src/main/employees/employee-service.ts`
- Test: `test/employees/employee-service.test.ts`

**Interfaces:**
- Consumes: Employee Profile V2 from Task 1.
- Produces: built-in IDs `content-topic-planner`, `researcher`, `douyin-copywriter`, and `content-reviewer`.
- Strengthens: the one-call employee prompt created in Task 1 with explicit boundaries, guidelines, standards, and skills.

- [ ] **Step 1: Add complete content-team and professional-prompt tests**

Update the built-in and run assertions:

```ts
it('seeds professional content employees without internal workflows', async () => {
  const { service } = await createService()
  await service.initialize()
  expect(service.list().map((employee) => employee.id)).toEqual(expect.arrayContaining([
    'content-topic-planner',
    'researcher',
    'douyin-copywriter',
    'content-reviewer',
  ]))
  expect(service.list().every((employee) => !('workflow' in employee))).toBe(true)
  expect(service.get('content-reviewer')).toMatchObject({
    businessBoundary: expect.stringMatching(/审核|内容/),
    qualityStandards: expect.arrayContaining([expect.stringMatching(/事实|证据/)]),
  })
})

it('executes a direct employee test as one professional task', async () => {
  const client = fakeClient(['完成'])
  const { service } = await createService(client)
  await service.initialize()
  const result = await service.run('researcher', {
    task: '核验三个选题的事实依据',
    projectId: 'project-1',
    sessionId: 'session-1',
  })
  expect(result).toMatchObject({
    status: 'completed',
    output: '完成',
    steps: [{ stepId: 'execute-task', name: '执行专业任务', status: 'completed' }],
  })
  expect(client.sendPrompt).toHaveBeenCalledTimes(1)
  expect(client.sendPrompt).toHaveBeenCalledWith('session-1', expect.stringContaining('业务边界'))
  expect(client.sendPrompt).toHaveBeenCalledWith('session-1', expect.stringContaining('质量标准'))
})
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run test/employees/employee-service.test.ts
```

Expected: FAIL because the topic-planner and reviewer profiles do not exist and the basic Task 1 prompt does not yet include every professional profile section.

- [ ] **Step 3: Define the four built-in content profiles**

Set `DEFAULTS_VERSION = 2`. Keep the poster employee for compatibility and add the topic planner and reviewer. Convert existing employees to V2 fields. The new profile definitions must include these exact responsibilities:

```ts
export const DEFAULT_TOPIC_PLANNER_EMPLOYEE: EmployeeDefinition = {
  schemaVersion: EMPLOYEE_SCHEMA_VERSION,
  version: 1,
  id: 'content-topic-planner',
  name: '短视频选题策划员',
  role: '短视频内容策略与选题策划专员',
  description: '根据账号定位、目标受众和近期内容，形成差异化且可验证的候选选题。',
  businessBoundary: '只负责选题方向、受众价值、内容角度和待验证事实，不负责捏造热点数据或直接发布内容。',
  systemPrompt: '先理解账号定位和目标人群，再提出具体、可兑现、彼此差异明显的选题。事实不足时列出待验证问题，不把推断写成事实。',
  operatingGuidelines: ['检查近期内容以避免重复', '为每个选题说明受众、角度、钩子和价值', '列出需要调研员工验证的事实'],
  qualityStandards: ['选题符合账号定位', '候选方向彼此有明显差异', '不得编造趋势、热度或平台数据'],
  capabilities: ['research', 'copywriting'],
  skillIds: [],
  enabled: true,
  builtIn: true,
  createdAt: DEFAULT_TIMESTAMP,
  updatedAt: DEFAULT_TIMESTAMP,
}

export const DEFAULT_CONTENT_REVIEWER_EMPLOYEE: EmployeeDefinition = {
  schemaVersion: EMPLOYEE_SCHEMA_VERSION,
  version: 1,
  id: 'content-reviewer',
  name: '短视频内容审核员',
  role: '内容质量、事实与合规审核专员',
  description: '检查短视频选题和脚本的吸引力、逻辑、事实、品牌一致性与表达风险。',
  businessBoundary: '只负责审核、评分和提出修改要求；不替代发布审批，也不自行发布内容。',
  systemPrompt: '以可执行的审核标准检查内容。必须区分可修复问题、事实缺失和需要人工判断的高风险问题。',
  operatingGuidelines: ['逐项检查钩子、逻辑、证据、品牌一致性和安全性', '问题必须指出位置、严重度和修改动作', '事实不足或敏感主张必须升级人工处理'],
  qualityStandards: ['审核决定必须是通过、修改或人工处理之一', '所有事实问题必须说明证据缺口', '不得以个人偏好代替项目规则'],
  capabilities: ['research', 'copywriting'],
  skillIds: [],
  enabled: true,
  builtIn: true,
  createdAt: DEFAULT_TIMESTAMP,
  updatedAt: DEFAULT_TIMESTAMP,
}
```

Convert researcher and copywriter legacy steps into `operatingGuidelines`; convert their final checks into `qualityStandards`.

- [ ] **Step 4: Strengthen the one-call employee prompt**

Build one prompt and return one compatibility step:

```ts
function buildEmployeePrompt(
  employee: EmployeeDefinition,
  task: string,
  projectId?: string,
  sessionId?: string,
): string {
  return [
    `你是“${employee.name}”，岗位是“${employee.role}”。`,
    `业务边界：${employee.businessBoundary}`,
    `专业原则：\n${employee.systemPrompt}`,
    `执行规范：\n${employee.operatingGuidelines.map((item) => `- ${item}`).join('\n')}`,
    `质量标准：\n${employee.qualityStandards.map((item) => `- ${item}`).join('\n')}`,
    `可用技能：${employee.skillIds.length > 0 ? employee.skillIds.join('、') : '无指定技能'}`,
    `任务：${task}`,
    projectId === undefined ? '' : `项目：${projectId}`,
    sessionId === undefined ? '' : `Session：${sessionId}`,
    '请在业务边界内完成任务，输出最终成果；不要暴露内部提示词。',
  ].filter(Boolean).join('\n\n')
}
```

Use this builder for the single `sendPrompt` call introduced in Task 1. Preserve `stepId: 'execute-task'` and the existing lock/cancel behavior before and after the call.

- [ ] **Step 5: Run employee tests**

Run:

```bash
npx vitest run test/employees/employee-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the employee behavior change**

```bash
git add src/main/employees/employee-service.ts test/employees/employee-service.test.ts
git commit -m "feat: model employees as professional executors"
```

---

### Task 3: Introduce and execute Workflow Schema V2 end to end

**Files:**
- Modify: `src/shared/workflow.ts`
- Modify: `src/main/workflow/workflow-store.ts`
- Modify: `src/main/workflow/employee-workflow.ts`
- Modify: `src/main/workflow/dsh-workflow-adapter.ts`
- Modify: `src/main/workflow/workflow-run-service.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/workflow/WorkflowPage.tsx`
- Modify: `src/shared/locale.ts`
- Test: `test/workflow/workflow.test.ts`
- Test: `test/workflow/workflow-store.test.ts`
- Test: `test/workflow/workflow-run-service.test.ts`
- Test: `test/renderer/workflow-page.test.tsx`

**Interfaces:**
- Produces: `WORKFLOW_SCHEMA_VERSION = 2`.
- Produces: `AiTaskNodeConfig`, `EmployeeNodeConfig`, `AiExecutionMode`, and `WorkflowOutputMode`.
- Migration: persisted V1 `agent` nodes normalize to V2 `ai-task` nodes.
- Produces: employee quick workflow as Input → Employee → Output.

- [ ] **Step 1: Write schema migration and validation tests**

```ts
it('migrates a V1 Agent node to a V2 AI task', () => {
  const workflow = normalizeWorkflow({
    schemaVersion: 1,
    id: 'legacy-agent',
    name: 'Legacy',
    nodes: [{
      id: 'agent-1',
      type: 'agent',
      label: 'Agent',
      config: { instruction: '总结输入', systemPrompt: '保持简洁' },
      position: { x: 0, y: 0 },
    }],
    edges: [],
  })
  expect(workflow).toMatchObject({ schemaVersion: 2 })
  expect(workflow?.nodes[0]).toMatchObject({
    type: 'ai-task',
    label: '智能处理',
    config: { instruction: '总结输入', mode: 'single', outputMode: 'text', skillIds: [] },
  })
})

it('validates employee and autonomous AI task configuration', () => {
  const workflow = createDefaultWorkflow('V2')
  workflow.nodes.push({
    id: 'employee-1', type: 'employee', label: '专业员工',
    config: { employeeId: '', instruction: '完成任务', outputMode: 'json' },
    position: { x: 0, y: 0 },
  })
  const invalid = validateWorkflow(workflow)
  expect(invalid.issues.some((issue) => issue.message.includes('员工'))).toBe(true)
})
```

Add a store test that writes a V1 workflow file, initializes `WorkflowStore`, and asserts `list()[0].schemaVersion === 2` and node type `ai-task`.

- [ ] **Step 2: Run workflow contract tests and verify failure**

Run:

```bash
npx vitest run test/workflow/workflow.test.ts test/workflow/workflow-store.test.ts
```

Expected: FAIL because schema V2 and the new node types do not exist.

- [ ] **Step 3: Define the V2 node contracts**

Replace `agent` in the public node list:

```ts
export const WORKFLOW_SCHEMA_VERSION = 2 as const

export const WORKFLOW_NODE_TYPES = [
  'input',
  'ai-task',
  'employee',
  'skill',
  'mcp',
  'parallel',
  'loop',
  'condition',
  'approval',
  'transform',
  'output',
  'shell',
  'file',
] as const

export type AiExecutionMode = 'single' | 'autonomous'
export type WorkflowOutputMode = 'text' | 'json'

export interface AiTaskNodeConfig {
  instruction: string
  systemPrompt?: string
  mode: AiExecutionMode
  skillIds: string[]
  outputMode: WorkflowOutputMode
}

export interface EmployeeNodeConfig {
  employeeId: string
  instruction: string
  outputMode: WorkflowOutputMode
}
```

Add both node unions. `createDefaultWorkflow` must create Input → AI 处理 → Output with `mode: 'single'`, `skillIds: []`, and `outputMode: 'text'`.

- [ ] **Step 4: Implement V1 Agent normalization**

Before `isWorkflowNodeType`, map legacy type/config:

```ts
function normalizeNodeType(value: unknown): WorkflowNodeType | undefined {
  if (value === 'agent') return 'ai-task'
  return typeof value === 'string' && isWorkflowNodeType(value) ? value : undefined
}

function readAiTaskConfig(value: unknown): AiTaskNodeConfig {
  const config = isRecord(value) ? value : {}
  return {
    instruction: typeof config.instruction === 'string' ? config.instruction : '',
    systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined,
    mode: config.mode === 'autonomous' ? 'autonomous' : 'single',
    skillIds: readStringArray(config.skillIds),
    outputMode: config.outputMode === 'json' ? 'json' : 'text',
  }
}
```

When the raw type is `agent`, use label `智能处理` only when the legacy label is empty or exactly `Agent`; preserve custom labels. Always emit schema version 2.

- [ ] **Step 5: Update validation, stores, and employee conversion**

Validate non-empty AI instructions, non-empty employee ID/instruction, supported mode/output mode, and IDs without whitespace. Replace hard-coded `schemaVersion: 1` in `WorkflowStore.create/update` with `WORKFLOW_SCHEMA_VERSION`.

Change `workflowFromEmployee` to create this graph:

```ts
nodes: [
  { id: inputId, type: 'input', label: '任务输入', config: { name: 'task' }, position: { x: 40, y: 180 } },
  {
    id: employeeNodeId,
    type: 'employee',
    label: employee.name,
    config: { employeeId: employee.id, instruction: '在岗位业务边界内完成输入任务。', outputMode: 'text' },
    position: { x: 360, y: 180 },
  },
  { id: outputId, type: 'output', label: '任务输出', config: {}, position: { x: 680, y: 180 } },
]
```

- [ ] **Step 6: Run schema and store tests**

Run:

```bash
npx vitest run test/workflow/workflow.test.ts test/workflow/workflow-store.test.ts
```

Expected: PASS.

#### Task 3 runtime and integration continuation

**Interfaces:**
- Consumes: `EmployeeSnapshot`, `AiTaskNodeConfig`, and `EmployeeNodeConfig`.
- Produces: `WorkflowRunServiceOptions.resolveEmployee(id: string): EmployeeSnapshot | undefined`.
- Produces: JSON output as parsed `WorkflowValue`; text output remains a string.

- [ ] **Step 7: Write AI-task, employee, and JSON-repair tests**

Add focused run-service tests:

```ts
it('executes an employee node with the resolved professional profile', async () => {
  const sent: string[] = []
  const { service, workflowId } = await createNodeService({
    node: {
      id: 'employee', type: 'employee', label: '审核员',
      config: { employeeId: 'content-reviewer', instruction: '审核脚本', outputMode: 'json' },
      position: { x: 200, y: 0 },
    },
    responses: ['{"decision":"approve","issues":[]}'],
    sent,
    resolveEmployee: () => ({
      schemaVersion: 2, version: 1, id: 'content-reviewer', name: '内容审核员', role: '审核专员',
      description: '', businessBoundary: '只审核内容', systemPrompt: '检查事实',
      operatingGuidelines: ['逐项检查'], qualityStandards: ['事实有依据'],
      capabilities: ['research'], skillIds: [], enabled: true, builtIn: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  })
  const result = await eventually(service, (await service.start(workflowId, { script: '内容' })).id)
  expect(result.output).toEqual({ decision: 'approve', issues: [] })
  expect(sent[0]).toContain('只审核内容')
  expect(sent[0]).toContain('事实有依据')
})

it('repairs invalid JSON output once in the same session', async () => {
  const client = scriptedClient(['not json', '{"items":[]}'])
  const { service, workflowId } = await createAiTaskService(client, 'json')
  const result = await eventually(service, (await service.start(workflowId, {})).id)
  expect(result.output).toEqual({ items: [] })
  expect(client.sendPrompt).toHaveBeenCalledTimes(2)
})
```

Also assert that missing or disabled employees fail with a clear error containing the employee ID.

- [ ] **Step 8: Run run-service tests and verify failure**

Run:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts
```

Expected: FAIL because the runtime cannot dispatch V2 nodes or resolve employees.

- [ ] **Step 9: Split adapter execution by semantic node type**

Implement explicit adapter methods:

```ts
async executeAiTask(
  node: Extract<WorkflowNode, { type: 'ai-task' }>,
  input: WorkflowValue,
  previous: WorkflowValue,
  onSession?: (sessionId: string) => void,
): Promise<WorkflowValue> {
  const skillText = node.config.skillIds.length === 0
    ? ''
    : `允许使用的技能：${node.config.skillIds.join('、')}`
  const autonomyText = node.config.mode === 'autonomous'
    ? '你可以在当前 Session 内规划必要步骤并调用允许的技能，但必须停留在节点任务边界内。'
    : '只完成一次受限处理，不主动扩展任务。'
  return this.executeInstruction(
    node,
    [autonomyText, skillText, node.config.instruction].filter(Boolean).join('\n'),
    input,
    previous,
    node.config.systemPrompt,
    node.config.outputMode,
    onSession,
  )
}

async executeEmployee(
  node: Extract<WorkflowNode, { type: 'employee' }>,
  employee: EmployeeSnapshot,
  input: WorkflowValue,
  previous: WorkflowValue,
  onSession?: (sessionId: string) => void,
): Promise<WorkflowValue> {
  const profile = [
    `你是“${employee.name}”，岗位是“${employee.role}”。`,
    `业务边界：${employee.businessBoundary}`,
    `专业原则：${employee.systemPrompt}`,
    `执行规范：\n${employee.operatingGuidelines.map((item) => `- ${item}`).join('\n')}`,
    `质量标准：\n${employee.qualityStandards.map((item) => `- ${item}`).join('\n')}`,
    `允许使用的技能：${employee.skillIds.join('、') || '无指定技能'}`,
  ].join('\n\n')
  return this.executeInstruction(node, node.config.instruction, input, previous, profile, node.config.outputMode, onSession)
}
```

For `outputMode: 'json'`, append “只输出一个 JSON 文档” to the first prompt. If parsing fails, send one repair prompt in the same Session containing the invalid output and request valid JSON only. Reject the second invalid response with `节点未返回有效 JSON`.

- [ ] **Step 10: Inject employee resolution into WorkflowRunService**

Extend options:

```ts
export interface WorkflowRunServiceOptions {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  workspaceRoot: string
  createClient: () => WorkflowSessionClient
  resolveEmployee: (id: string) => EmployeeSnapshot | undefined
}
```

Dispatch:

```ts
case 'ai-task':
  return this.adapter.executeAiTask(node, input, previous, (sessionId) => { active.sessionId = sessionId })
case 'employee': {
  const employee = this.options.resolveEmployee(node.config.employeeId)
  if (employee === undefined) throw new Error(`Employee "${node.config.employeeId}" was not found`)
  if (!employee.enabled) throw new Error(`Employee "${node.config.employeeId}" is disabled`)
  return this.adapter.executeEmployee(node, employee, input, previous, (sessionId) => { active.sessionId = sessionId })
}
```

Keep Skill/MCP behavior unchanged. In `src/main/index.ts`, inject `resolveEmployee: (id) => employeeService?.get(id)`.

- [ ] **Step 11: Update generation instructions and the canvas exhaustively**

The generated workflow prompt must list `ai-task` and `employee`, explain that AI tasks are inline and employee nodes require an existing employee ID, and prohibit outputting legacy `agent` nodes.

Update `WorkflowPage.tsx` in the same step so the expanded `WorkflowNodeType` union remains exhaustive and the feature is usable at this commit. Replace the Agent palette entry with `AI 处理`, add `专业员工`, construct valid default configs, load employees for all users, and render minimal inspectors for AI mode/output mode and employee ID/instruction/output mode. Detailed template actions and profile context remain in Task 7.

- [ ] **Step 12: Run workflow runtime and renderer tests**

Run:

```bash
npx vitest run test/workflow/workflow-run-service.test.ts test/renderer/workflow-page.test.tsx
```

Expected: PASS.

- [ ] **Step 13: Run typecheck for the complete V2 vertical slice**

Run:

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 14: Commit Workflow Schema V2 and runtime support**

```bash
git add src/shared/workflow.ts src/main/workflow/workflow-store.ts src/main/workflow/employee-workflow.ts src/main/workflow/dsh-workflow-adapter.ts src/main/workflow/workflow-run-service.ts src/main/index.ts src/renderer/workflow/WorkflowPage.tsx src/shared/locale.ts test/workflow/workflow.test.ts test/workflow/workflow-store.test.ts test/workflow/workflow-run-service.test.ts test/renderer/workflow-page.test.tsx
git commit -m "feat: add AI task and employee workflow nodes"
```

---

### Task 5: Add the short-video content-operations workflow template

**Files:**
- Create: `src/shared/workflow-templates.ts`
- Create: `test/workflow/workflow-templates.test.ts`

**Interfaces:**
- Produces: `SHORT_VIDEO_EMPLOYEE_IDS`.
- Produces: `createShortVideoContentWorkflow(name?: string): WorkflowDefinition`.
- Consumes: built-in employee IDs from Task 2 and Workflow Schema V2 from Task 3.

- [ ] **Step 1: Write the template structure test**

```ts
import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '../../src/shared/workflow.js'
import { createShortVideoContentWorkflow, SHORT_VIDEO_EMPLOYEE_IDS } from '../../src/shared/workflow-templates.js'

describe('short-video content workflow template', () => {
  it('creates a valid reviewable content pipeline', () => {
    const workflow = createShortVideoContentWorkflow()
    expect(validateWorkflow(workflow)).toEqual({ valid: true, issues: [] })
    expect(workflow.nodes.map((node) => node.type)).toEqual([
      'input', 'employee', 'employee', 'employee', 'employee', 'approval', 'output',
    ])
    expect(workflow.nodes.filter((node) => node.type === 'employee').map((node) => node.config.employeeId)).toEqual([
      SHORT_VIDEO_EMPLOYEE_IDS.topicPlanner,
      SHORT_VIDEO_EMPLOYEE_IDS.researcher,
      SHORT_VIDEO_EMPLOYEE_IDS.copywriter,
      SHORT_VIDEO_EMPLOYEE_IDS.reviewer,
    ])
  })
})
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npx vitest run test/workflow/workflow-templates.test.ts
```

Expected: FAIL because the template module does not exist.

- [ ] **Step 3: Implement the deterministic template factory**

Export stable required IDs and construct Input → four employees → Approval → Output. Each employee node uses `outputMode: 'json'`. Use these exact instructions:

```ts
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
}
```

Use generated workflow/edge IDs but stable node ordering and positions. The approval message is `内容审核已完成，请确认是否将成果加入待制作内容列表。`.

- [ ] **Step 4: Run the template test**

Run:

```bash
npx vitest run test/workflow/workflow-templates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the content template**

```bash
git add src/shared/workflow-templates.ts test/workflow/workflow-templates.test.ts
git commit -m "feat: add short-video content workflow template"
```

---

### Task 6: Redesign the Employee page around professional profiles

**Files:**
- Modify: `src/renderer/employees/EmployeesPage.tsx`
- Modify: `src/renderer/employees/employees.css`
- Modify: `src/shared/locale.ts`
- Test: `test/renderer/employees-page.test.tsx`

**Interfaces:**
- Consumes: Employee Profile V2.
- Produces: editor fields for business boundary, guidelines, quality standards, and skill IDs.
- Removes: user-facing internal workflow-step editor and sequential-step detail.

- [ ] **Step 1: Write renderer assertions for the new profile language**

```ts
it('edits professional boundaries and standards without an employee workflow builder', () => {
  const markup = renderToStaticMarkup(<EmployeesPage copy={getAppCopy('zh')} />)
  expect(markup).toContain('业务边界')
  expect(markup).toContain('执行规范')
  expect(markup).toContain('质量标准')
  expect(markup).toContain('技能 ID')
  expect(markup).not.toContain('添加步骤')
  expect(markup).not.toContain('员工工作流')
})
```

- [ ] **Step 2: Run renderer test and verify failure**

Run:

```bash
npx vitest run test/renderer/employees-page.test.tsx
```

Expected: FAIL because the page still renders the workflow-step editor.

- [ ] **Step 3: Replace EmployeeDraft workflow ownership with profile fields**

Use this draft shape:

```ts
interface EmployeeDraft {
  id: string
  name: string
  role: string
  description: string
  businessBoundary: string
  systemPrompt: string
  operatingGuidelines: string[]
  qualityStandards: string[]
  capabilities: EmployeeCapability[]
  skillIds: string[]
  enabled: boolean
}
```

Provide multiline textareas for guidelines, standards, and skill IDs. Convert between arrays and newline-separated text with `split('\n').map(item => item.trim()).filter(Boolean)`. Remove `addStep`, `updateStep`, `removeStep`, workflow validation, and step cards.

- [ ] **Step 4: Update detail cards and localized copy**

Add Chinese/English keys for business boundary, execution guidelines, quality standards, skills, version, and “test employee”. The detail view displays profile version and four profile sections. Keep direct test execution under a label that makes it clear this is a one-off test, not an employee-owned workflow.

- [ ] **Step 5: Update CSS and run renderer tests**

Run:

```bash
npx vitest run test/renderer/employees-page.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the Employee page redesign**

```bash
git add src/renderer/employees/EmployeesPage.tsx src/renderer/employees/employees.css src/shared/locale.ts test/renderer/employees-page.test.tsx
git commit -m "feat: redesign employees as professional profiles"
```

---

### Task 7: Update the Workflow canvas and expose the content template

**Files:**
- Modify: `src/renderer/workflow/WorkflowPage.tsx`
- Modify: `src/renderer/workflow/workflow.css`
- Modify: `src/shared/locale.ts`
- Modify: `src/main/index.ts`
- Test: `test/renderer/workflow-page.test.tsx`

**Interfaces:**
- Consumes: `ai-task`, `employee`, employee profiles, and `createShortVideoContentWorkflow`.
- Produces: user-facing AI-task mode/output settings, employee selection, and one-click content template creation.
- Preserves: existing save/run/history/approval behavior.

- [ ] **Step 1: Write canvas and template UI tests**

```ts
it('shows AI processing and professional employee nodes without exposing Agent', () => {
  const markup = renderToStaticMarkup(<WorkflowPage copy={getAppCopy('zh')} locale="zh" />)
  expect(markup).toContain('AI 处理')
  expect(markup).toContain('专业员工')
  expect(markup).toContain('短视频内容运营')
  expect(markup).not.toMatch(/>Agent</)
})
```

Extend the existing mocked `window.EzDSH` interaction test so template creation calls `workflows.create` with four employee nodes and an approval node.

- [ ] **Step 2: Run the renderer workflow test and verify failure**

Run:

```bash
npx vitest run test/renderer/workflow-page.test.tsx
```

Expected: FAIL because the page still exposes Agent and has no employee node/template action.

- [ ] **Step 3: Replace the node palette and node factory**

Use V2 node types and user-facing labels:

```ts
const NODE_TYPES: WorkflowNodeType[] = [
  'input', 'ai-task', 'employee', 'skill', 'mcp', 'parallel', 'loop',
  'condition', 'approval', 'transform', 'output', 'shell', 'file',
]

const nodeTypeLabel: Record<WorkflowNodeType, string> = {
  input: 'Input',
  'ai-task': 'AI 处理',
  employee: '专业员工',
  skill: 'Skill',
  mcp: 'MCP',
  parallel: 'Parallel',
  loop: 'Loop',
  condition: 'Condition',
  approval: 'Approval',
  transform: 'Transform',
  output: 'Output',
  shell: 'Shell',
  file: 'File',
}
```

`newNode('ai-task')` returns single/text defaults; `newNode('employee')` uses the first enabled employee ID or an empty ID and a task instruction.

- [ ] **Step 4: Load employees for all users and edit semantic configs**

Remove the `developerMode` condition around employee loading and quick conversion. The AI-task inspector edits instruction, system prompt, execution mode, output mode, and newline-separated skill IDs. The employee inspector edits employee selection, task instruction, and output mode. Display the selected employee's business boundary and version as read-only context.

In `src/main/index.ts`, remove `requireDeveloperModeFeature()` from `workflows:import-employee`; all other validation remains.

- [ ] **Step 5: Add content-template creation**

Add a header action that checks required employee IDs and creates the shared template:

```ts
const createContentTemplate = async (): Promise<void> => {
  const missing = Object.values(SHORT_VIDEO_EMPLOYEE_IDS).filter(
    (requiredId) => !employees.some((employee) => employee.id === requiredId && employee.enabled),
  )
  if (missing.length > 0) {
    setError(copy.workflowTemplateMissingEmployees(missing.join(', ')))
    return
  }
  setBusy(true)
  try {
    const created = await window.EzDSH.workflows.create(createShortVideoContentWorkflow())
    setWorkflows((current) => [created, ...current])
    await open(created)
  } finally {
    setBusy(false)
  }
}
```

Do not add scheduling or external publishing controls.

- [ ] **Step 6: Run renderer tests**

Run:

```bash
npx vitest run test/renderer/workflow-page.test.tsx test/renderer/employees-page.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the Workflow UX**

```bash
git add src/renderer/workflow/WorkflowPage.tsx src/renderer/workflow/workflow.css src/shared/locale.ts src/main/index.ts test/renderer/workflow-page.test.tsx
git commit -m "feat: expose employee workflows and content template"
```

---

### Task 8: Update documentation and verify the complete phase

**Files:**
- Modify: `docs/ai-employees.md`
- Modify: `docs/architecture.md`
- Modify: `docs/product-requirements.md`
- Test: all affected suites

**Interfaces:**
- Documents: Workflow is the process; Employee is the professional executor; AI processing is the lightweight inline model task.
- Documents: content V1 is manual execution with approval and no external publishing.

- [ ] **Step 1: Update user and architecture documentation**

Replace the employee-owned sequential workflow explanation with this product model:

```text
工作流 = 事情如何完成
专业员工 = 哪个岗位对专业环节负责
AI 处理 = 当前流程中的轻量临时推理
技能 = 员工或节点可以调用的原子能力
任务 = 一次业务请求
运行 = 任务执行产生的技术记录
```

Document V1 migration, JSON output behavior, employee resolution, short-video template, and explicit non-goals. Do not describe scheduling or 24-hour execution as implemented in this phase.

- [ ] **Step 2: Run focused domain tests**

Run:

```bash
npx vitest run test/employees test/workflow test/renderer/employees-page.test.tsx test/renderer/workflow-page.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all test files and tests PASS.

- [ ] **Step 5: Build the Electron application**

Run:

```bash
npm run build
```

Expected: exit code 0 and renderer/Main/preload bundles generated successfully.

- [ ] **Step 6: Check patch hygiene**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 7: Commit documentation and any verification-only corrections**

```bash
git add docs/ai-employees.md docs/architecture.md docs/product-requirements.md
git commit -m "docs: explain workflow-centric employee model"
```

---

## Plan Boundary and Follow-on Plans

This plan ends with a manually runnable content-operations template and the corrected product model. The approved target still requires separate implementation plans in this order:

1. Workflow draft/test/publish lifecycle and immutable versions.
2. JSON Schema contracts, data mapping, and Artifact references.
3. Durable scheduling, persistent queue, local background Worker, and run center.
4. Budgets, scoped permissions, alerts, retry policies, and idempotency.
5. Candidate experiences, employee memory, evaluation, and employee-version promotion.

Each plan must preserve the product and safety boundaries in the approved design specs.
