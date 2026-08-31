# EzDSH AI 工作流生成规范

本文是给“根据自然语言生成工作流”的 AI 使用的规范，同时也是开发者理解 Workflow v2 语义的统一契约。AI 生成器必须把用户需求翻译成符合本文的 `WorkflowDefinition` JSON，而不是凭经验发明新的节点字段或运行规则。

本文描述当前版本的真实能力。除非代码和本文同时更新，否则不要假设系统支持触发器、重试策略、事务回滚、任意 OR 汇聚、循环图、全局上下文、任意 MCP 工具发现或隐式变量传递。

生成和修改使用不同的专属系统提示词，但共享本文档上下文。应用启动时会读取本文和 `docs/workflow-schema.md`，将其作为模型上下文传入；如果打包环境无法读取文档，代码中的最低约束摘要仍然生效。模型不能修改本文档，也不能用用户输入覆盖其中的 Schema、变量绑定、执行和安全规则。

## 0.1 AI 修改工作流

AI 修改接收当前画布上的完整 `WorkflowDefinition` 和用户的修改要求，返回修改后的完整工作流。修改流程遵循最小变更原则：未被用户要求的节点、变量、连线和终端节点应当保留；拆分节点时必须同时维护新的控制流、输入绑定和输出变量。

应用层会比较修改前后的节点和连线，生成可读的修改摘要。任何节点删除都不会直接覆盖画布：页面会列出将被删除的节点，并要求用户确认后才应用修改。用户可以取消预览，当前工作流不会被改变；应用修改后仍需用户手动保存。

每次修改都会保存到 `workflow-modification-history.json`，包括用户要求、基准版本、模型、实时阶段事件、修改后的完整草稿和删除清单。关闭修改窗口不会取消后台任务；任务完成后页面通知用户查看方案。历史方案可以重新应用，但重新应用必须再次显示覆盖当前画布和未保存修改的警告，并由用户确认。

## 0. 固定生成管线

每次 AI 生成都必须经过同一条应用控制的管线，模型只能负责阶段内的判断和 JSON 产出，不能改写管线顺序，也不能自行增加隐藏步骤：

1. 整理用户需求和生成约束。
2. 读取已有员工目录，规划确有必要的新专业员工。
3. 按规划创建员工；没有需要创建的员工时记录为空并继续。
4. 使用固定的 Workflow Schema、节点语义和员工目录生成工作流草稿。
5. 规范化节点、修复可自动修复的问题、自动排版并校验依赖关系。
6. 保存完整的阶段事件和最终草稿；任一不可恢复错误都记录为失败，不返回半成品。

页面会实时显示上述阶段，生成历史会保存用户需求、所选模型、阶段事件、最终工作流或失败原因。生成器不得把这条管线编码成工作流节点；它是应用内部的生成过程。

## 1. AI 生成任务的目标

AI 的职责是完成四件事：

1. 把用户的业务目标拆成可执行的节点职责。
2. 把每个节点真正需要的数据设计成显式的输入变量绑定。
3. 用连线表达执行顺序、分支和汇聚，用 `inputBindings` 表达数据依赖。
4. 选择合适的员工、技能或节点类型，并输出可校验、可审阅、可运行的 JSON。

AI 不是在生成一段描述性的流程图。生成结果必须能够在运行时被逐节点执行，并且用户可以在编辑器中看懂每个节点的职责、输入和输出。

### 1.1 生成前的推理顺序

生成前按以下顺序思考，不要先画线再补数据：

1. **目标**：最终要交付什么结果？最终输出应该是什么形态？
2. **输入**：用户或系统会在启动工作流时提供哪些值？输入是一个值还是一个 JSON 对象？
3. **职责**：哪些步骤属于研究、判断、写作、转换、审批或外部系统调用？
4. **数据契约**：每个节点要读取哪些变量，会产生哪些具名输出？
5. **控制流**：哪些步骤必须先后执行？哪些步骤可以并行？哪些路径是互斥的？
6. **员工选择**：已有员工是否能负责该专业职责？若不能，是否允许创建员工？
7. **安全与可审阅性**：是否涉及代码、Shell、文件、外部 API 或审批？是否需要用户明确授权？
8. **校验**：检查 ID、连线、绑定、分支端口、节点配置和无环依赖。

## 2. 核心概念

| 概念 | 定义 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| Workflow / 工作流 | 一份可重复运行的有向无环图定义 | 描述节点、连线、变量和运行顺序 | 不保存某一次运行的实际结果 |
| Node / 节点 | 一个有输入、执行逻辑和输出的步骤 | 完成单一、可说明的职责 | 不应同时承担多个互不相关的业务阶段 |
| Edge / 连线 | 两个节点之间的控制流依赖 | 表达先后、分支或汇聚关系 | 不负责选择具体字段或传递数据别名 |
| Input binding / 输入绑定 | 节点输入变量到上游输出的映射 | 表达数据依赖、字段选择和本地变量名 | 不改变上游节点的输出 |
| Output variable / 输出变量 | 节点声明的结构化输出字段 | 让下游可以稳定引用字段 | 不是额外的执行节点 |
| `result` | 每个节点的隐式完整输出 | 允许下游引用完整结果 | 不需要在 `outputVariables` 里重复声明 |
| Run / 运行 | 某份工作流的一次执行实例 | 保存每个节点的输入、输出、状态、错误和耗时 | 不改变工作流定义 |
| Employee / 专业员工 | 可复用的岗位配置和业务边界 | 负责稳定、专业、可复用的业务职责 | 不等同于一个工作流，也不自动拥有所有工具权限 |
| AI task / 智能处理 | 工作流内一次轻量、局部的模型处理 | 完成不值得沉淀为员工的单次推理 | 不应被伪装成长期岗位 |
| Skill / 技能 | 可被节点或员工引用的原子能力 | 提供具体工具或方法能力 | 不代替节点的业务目标 |
| MCP | 对一个明确 MCP 工具的结构化调用 | 调用外部工具并传递结构化参数 | 不负责自动发现或猜测工具名 |
| Context / 上下文 | 当前节点显式绑定进来的变量集合 | 为节点提示词提供可控输入 | 当前版本不是所有历史结果的自动全局变量 |

### 2.1 三个必须分开的层次

工作流中有三个不同层次，生成时不能混用：

- **数据来源**：由 `inputBindings` 决定。例如 `research = research-node.summary`。
- **执行依赖**：由 `edges` 和绑定共同决定。例如 C 绑定了 A 的输出，即使画布上没有 A→C 的线，C 也依赖 A。
- **提示词使用**：由节点 `instruction` 中的 `{{变量名}}` 决定。只有声明过的本地变量才能使用。

因此，边表示“谁完成后谁才可能执行”，绑定表示“执行时要把什么数据交给它”，提示词表示“节点实际使用其中哪些数据”。

## 3. WorkflowDefinition 总体结构

AI 生成的工作流 JSON 至少包含以下字段：

```json
{
  "schemaVersion": 2,
  "id": "content-workflow",
  "name": "内容生产工作流",
  "description": "先调研，再生成提纲和成稿。",
  "revision": 1,
  "enabled": true,
  "nodes": [],
  "edges": []
}
```

### 3.1 顶层字段

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | 当前生成目标固定为数字 `2`。 |
| `id` | 稳定、唯一、便于阅读的工作流 ID；推荐使用小写字母、数字、`-`、`_`。 |
| `name` | 面向用户的工作流名称，不能为空。 |
| `description` | 说明目标、主要输入和结果；不要把详细执行指令全部塞在这里。 |
| `revision` | 新生成时可使用 `1`。 |
| `enabled` | 通常为 `true`。 |
| `nodes` | 节点数组，至少有一个 `input` 和一个 `output`。 |
| `edges` | 多节点工作流必须有连线；连线不能形成循环。 |

`createdAt`、`updatedAt`、`lastRunId` 等运行或持久化元数据由应用管理。AI 不要编造运行 ID，也不要把运行结果写入工作流定义。

### 3.2 节点公共字段

每个节点都应包含：

```json
{
  "id": "research",
  "type": "ai-task",
  "label": "调研",
  "description": "收集并整理与主题相关的事实和来源。",
  "config": {},
  "position": { "x": 360, "y": 180 },
  "inputBindings": [],
  "outputVariables": []
}
```

- `id`：节点唯一标识。不要使用空格；同一工作流内不能重复。
- `type`：只能使用当前支持的节点类型，见第 7 节。
- `label`：用户在画布上看到的主文字，应短而明确，例如“调研”“生成提纲”“人工审核”。
- `description`：可选，写节点目的或注意事项，不参与运行时数据传递。
- `config`：该类型专属配置，不能用另一种节点的配置字段代替。
- `position`：编辑器位置，必须有数字 `x`、`y`。坐标只影响画布，不影响执行。
- `inputBindings`：推荐始终输出数组。没有输入时使用 `[]`。
- `outputVariables`：推荐始终输出数组。输出本身仍然会通过隐式 `result` 暴露。

## 4. 数据模型：输入、输出与变量绑定

### 4.1 工作流输入

工作流启动时的输入是一个 JSON 安全值，可以是字符串、数字、布尔值、数组或对象。对于有多个业务输入的工作流，优先使用一个 `input` 节点接收对象：

```json
{
  "topic": "AI 工作流设计",
  "audience": "产品经理"
}
```

后续节点通过 `sourcePath` 选择字段，而不是把 `topic`、`audience` 隐式变成全局变量。

### 4.2 输入节点

`input` 节点是外部运行输入的入口：

```json
{
  "id": "start",
  "type": "input",
  "label": "开始输入",
  "config": { "name": "request" },
  "position": { "x": 80, "y": 220 },
  "inputBindings": [],
  "outputVariables": []
}
```

- 当运行输入是对象时，输入节点通常保留完整对象作为结果。
- `config.name` 可以作为单值输入的名称或编辑器提示，但不要依赖它把对象字段自动注入后续节点。
- 后续节点要使用 `topic`，就绑定 `sourceNodeId: "start"`、`sourcePath: "topic"`。

如果工作流需要多个启动参数，应在 `config.fields` 中显式声明它们。编辑器会根据这些字段生成运行前输入表单；输入节点的 `result` 仍是完整对象，下游再通过 `sourcePath` 选择字段。

```json
{
  "id": "start",
  "type": "input",
  "label": "开始输入",
  "config": {
    "fields": [
      { "name": "topic", "label": "主题", "type": "string", "required": true },
      { "name": "audience", "label": "受众", "type": "string", "required": false, "defaultValue": "" }
    ]
  },
  "position": { "x": 80, "y": 220 },
  "inputBindings": [],
  "outputVariables": []
}
```

`fields[].name` 必须是 ASCII 变量名；`label` 是用户看到的名称；`type` 只能是 `string`、`number`、`boolean` 或 `json`；`required: false` 只表示该启动参数可以为空，不改变后续节点的多输入等待规则。只有单值启动输入才使用 `config.name`。

### 4.3 绑定的标准格式

```json
{
  "id": "writer-topic",
  "name": "topic",
  "sourceNodeId": "start",
  "sourcePath": "topic",
  "required": true
}
```

字段语义：

| 字段 | 语义 |
| --- | --- |
| `id` | 绑定记录自身的唯一 ID。 |
| `name` | 当前节点内部使用的变量名，必须符合 `^[A-Za-z_][A-Za-z0-9_]*$`。 |
| `sourceNodeId` | 上游节点 ID，必须存在。 |
| `sourcePath` | 可选的点号路径，例如 `summary`、`research.sources` 或数组索引路径。省略表示完整 `result`。 |
| `required` | `true` 表示来源值不可缺失；`false` 表示缺失时允许使用默认值或得到 `null`。 |
| `defaultValue` | 可选的 JSON 安全默认值，只适合真正可选的数据。 |

同一个节点内 `name` 不能重复。节点指令只能引用自身绑定的名字，例如 `{{topic}}`、`{{research.summary}}`；未声明的 `{{unknown}}` 不应出现。

### 4.4 输出变量

当节点输出 JSON 对象并且下游需要稳定使用其中字段时，声明输出变量：

```json
"outputVariables": [
  { "name": "summary", "description": "调研摘要" },
  { "name": "sources", "description": "来源列表" }
]
```

约定：

- `result` 永远代表节点的完整输出，不要在 `outputVariables` 中再次声明 `result`。
- 输出变量名应稳定、短、可读，并与实际 JSON key 一致。
- `outputMode: "json"` 的节点必须指令模型只输出 JSON 对象或数组，不要输出 Markdown 代码围栏、解释文字或混合格式。
- 声明输出变量不会自动生成字段；节点指令必须明确要求模型返回这些字段。

### 4.5 用户示例的标准建模

用户希望表达：

```text
开始输入：topic、audience
A：调研 -> research.summary、research.sources
B：提纲 -> outline
C：写作
```

应该生成如下变量绑定关系：

```text
C.topic    <- 开始.topic
C.research <- A.summary
C.outline <- B.outline
C.audience <- 开始.audience
```

C 的指令可以是：

```text
请围绕 {{topic}}，面向 {{audience}}，结合调研摘要 {{research}} 和提纲 {{outline}} 写作。
```

这里的 `research` 是 C 的本地别名，不要求它与 A 的节点 ID 相同；这正是绑定层与图结构分离的价值。

## 5. 连线、依赖与复杂图

### 5.1 一个来源可以连接多个下游

工作流支持 fan-out：一个节点可以有多个下游节点。相同的结果不会被消费掉，多个下游都可以通过自己的绑定引用它。

例如：

```text
开始输入 ──┬─> 调研
          ├─> 标题生成
          └─> 风险检查
```

如果三个节点都需要 `topic`，分别建立三个绑定；不要把一个绑定对象复制到其他节点而不修改它的本地 `name` 或绑定 ID。

### 5.2 多个来源可以汇聚到一个下游

工作流支持 fan-in：一个节点可以同时绑定多个上游：

```text
开始输入 ──┬─> 写作
调研 ──────┤
提纲 ──────┘
```

运行时规则是：

1. 下游节点会等待所有由连线或输入绑定形成的依赖节点进入终态。
2. 终态包括 `completed`、`skipped`、`failed`、`cancelled`。
3. 依赖失败不会被当作正常输入值；通常会使本次运行失败或停止继续执行。
4. 依赖全部完成后，节点收到一个按本地变量名组织的对象，例如：

   ```json
   {
     "topic": "AI 工作流设计",
     "research": "……",
     "outline": "……",
     "audience": "产品经理"
   }
   ```

### 5.3 当前没有“任意一个完成即可”的 OR 汇聚

不要把以下需求误建模成普通多输入：

> A 或 B 谁先完成就用谁的结果，另一个不用等。

当前 `inputBindings` 没有 `any`、`race`、`first` 或 OR 模式。多依赖默认是 AND 语义，全部依赖要先进入终态。

如果业务真的是“择一路径”，应该使用：

- `condition` 节点明确判断，并用 `true` / `false` 两条分支；或
- 把多个候选结果先定义为可选绑定，并在后续节点中明确处理 `null`，但这仍然不会改变节点的等待规则；或
- 将“竞争、超时、回退”封装成一个明确的专用节点能力，先扩展数据模型和运行时，再让 AI 生成该类型。

在当前版本，AI 不得通过偷偷省略连线或绑定来伪造 OR 语义。

### 5.4 连线的职责

```json
{ "id": "edge-a-b", "source": "a", "target": "b" }
```

连线表达：

- 普通执行顺序；
- 分支路径；
- 汇聚等待关系；
- 让画布关系对用户可见。

连线不表达：

- 上游哪个 JSON 字段传给下游；
- 下游变量叫什么；
- 是否把整个结果还是某个字段传递过去。

这些内容必须放在 `inputBindings` 中。

### 5.5 变量绑定也会形成执行依赖

即使没有画布连线，只要 B 绑定了 A 的输出，B 也依赖 A。生成时仍建议为主要执行顺序画出可读的连线；绑定依赖是数据层的补充，不应被用来隐藏复杂流程。

## 6. 分支、switch、并行与循环

### 6.1 condition 是二路互斥分支

`condition` 节点把输入值按一个操作符判断成布尔结果。支持：

- `truthy`
- `equals`
- `not-equals`
- `contains`
- `greater-than`
- `less-than`

下游连线必须明确标记：

```json
{ "id": "condition-yes", "source": "check", "target": "publish", "sourcePort": "true" }
{ "id": "condition-no", "source": "check", "target": "revise", "sourcePort": "false" }
```

一个 condition 最多表达 true / false 两条路径。用户说“switch 有三种或更多情况”时，使用多个 condition 串联成决策树，不要发明 `switch` 节点：

```text
条件一：是否紧急？
  true  -> 紧急处理
  false -> 条件二：是否需要审核？
              true  -> 人工审核
              false -> 普通处理
```

### 6.2 条件后的共同下游

如果 true 和 false 两条路径最终汇入同一个下游节点，可以让两条分支都连到该节点。该节点会等待一个分支 `completed`、另一个分支 `skipped`，然后沿有效路径继续。

但不要把两个互斥分支的输出都标成 `required: true` 的绑定，因为未选中的分支没有正常输出。对互斥分支结果应：

- 只绑定选中路径必然存在的值；或
- 使用 `required: false` 和合理 `defaultValue`；或
- 在分支内部把输出规范化为共同的结构，再汇入共同下游。

### 6.3 graph fan-out 与 parallel 节点不同

这两个概念不要混淆：

| 方式 | 适合场景 | 结果形态 |
| --- | --- | --- |
| 一个节点连到多个节点 | 多个有独立职责、需要在画布上审阅的步骤 | 多个节点各自产生结果 |
| `parallel` 节点 | 同一个步骤内对多条相似指令做轻量并发处理 | 一个数组，按指令顺序保存结果 |

如果每条分支需要独立员工、独立变量、独立审核或单独查看运行记录，使用多个节点。只有当任务是“对同一输入并行执行若干相似指令，并把结果作为一个数组返回”时才使用 `parallel`。

### 6.4 loop 是节点内的有限迭代

`loop` 对一个数组逐项处理；标量会按单项处理。必须设置合理的 `maxIterations`，默认上限是 20，允许范围是 1 到 100。不要用边连接形成图循环，也不要生成没有上限的循环。

## 7. 节点类型选择矩阵

| 类型 | 什么时候用 | 关键配置 | 典型输出 |
| --- | --- | --- | --- |
| `input` | 接收工作流启动输入 | `name?`、`fields?`、`defaultValue?` | 外部输入值或对象 |
| `ai-task` | 一次轻量、局部的模型处理 | `instruction`、`mode`、`skillIds`、`outputMode` | 文本或 JSON |
| `employee` | 需要稳定岗位、专业边界和可复用标准 | `employeeId`、`instruction`、`outputMode` | 该员工的文本或 JSON 结果 |
| `skill` | 对一个明确技能发起处理 | `skillId`、`instruction` | 文本结果 |
| `mcp` | 用户明确指定了 MCP 工具 | `tool`、`arguments?` | 工具返回值 |
| `parallel` | 同一输入上并行执行多条轻量指令 | `instructions[]` | 文本结果数组 |
| `loop` | 对数组中的每一项执行相同处理 | `instruction`、`maxIterations?` | 处理结果数组 |
| `condition` | 根据一个值选择 true/false 路径 | `operator`、`value?` | 布尔值 |
| `approval` | 需要人在继续前确认 | `message` | 审批结果/继续信号 |
| `transform` | 做确定性的格式转换 | `template`、`text?` | 转换后的值 |
| `output` | 明确标记最终结果 | `label?` | 绑定的结果或上游值 |
| `http` | 调用明确的 HTTP/HTTPS API | `method`、`url`、`headers`、`body?` 等 | `{status,ok,headers,body}` |
| `code` | 用户明确需要小范围代码转换或计算 | `language`、`code`、`timeoutMs?` | 代码返回值 |
| `shell` | 用户明确授权执行工作区命令 | `command`、`args`、`cwd?`、`timeoutMs?` | 命令输出 |
| `file` | 用户明确授权读写工作区相对路径 | `operation`、`path`、`content?` | 文件内容或写入结果 |

### 7.1 ai-task 与 employee 的选择

使用 `ai-task`：

- 只服务于当前工作流；
- 任务简单、上下文短、没有独立岗位边界；
- 用户没有要求沉淀成可复用员工；
- 员工目录没有合适的岗位，且当前生成请求不允许创建员工。

使用 `employee`：

- 需要稳定的专业角色；
- 同一种职责会在多个工作流复用；
- 需要业务边界、质量标准、工作规范和技能集合；
- 用户明确说“让研究员/审核员/文案员负责”或现有员工目录已有匹配岗位。

`employee` 节点必须引用目录中真实存在且启用的 `employeeId`。禁止猜 ID、编造 ID 或把员工名称当成 ID。若允许创建员工，应先创建并拿到真实 ID，再生成引用该 ID 的工作流。

### 7.2 HTTP、code、shell、file 的选择

- 能用 `transform` 完成的确定性处理，不要使用 `code`。
- 只有用户明确要求外部 API 时才用 `http`，URL 必须是 `http` 或 `https`。
- 只有用户明确要求脚本计算、数据处理或自动化时才用 `code`。
- 只有用户明确授权工作区命令时才用 `shell`。
- 只有用户明确要求读写文件时才用 `file`。
- 这些能力可能在运行对话框中要求用户显式授权；AI 不能把授权默认为已经存在。

## 8. 员工模型与员工生成规范

### 8.1 员工是什么

员工是一份可复用的岗位定义，不是一个节点的别名，也不是某次运行的会话。工作流决定“事情如何串联”，员工决定“某类专业任务由谁以什么标准完成”。

员工执行时会使用自己的岗位信息、业务边界、系统提示、工作规范、质量标准和技能 ID，再接收工作流节点传来的具体任务。

### 8.2 EmployeeDefinition 字段

```json
{
  "schemaVersion": 2,
  "version": 1,
  "id": "content-researcher",
  "name": "内容研究员",
  "role": "负责内容选题和事实调研",
  "description": "将问题拆成研究任务并整理可引用证据。",
  "businessBoundary": "负责资料检索、证据整理和不确定性说明，不负责直接发布内容。",
  "systemPrompt": "你是一名严谨的内容研究员……",
  "operatingGuidelines": ["先界定问题", "区分事实和推断"],
  "qualityStandards": ["关键结论有来源", "无法确认时明确说明"],
  "capabilities": ["research"],
  "skillIds": [],
  "enabled": true
}
```

字段定义：

| 字段 | 定义 |
| --- | --- |
| `id` | 稳定引用 ID，只允许小写字母、数字、`.`、`_`、`-`，不能有空格。 |
| `name` | 用户看到的员工名称。 |
| `role` | 员工承担的岗位职责，不要写成某一次具体任务。 |
| `description` | 简短介绍。 |
| `businessBoundary` | 明确负责什么、不负责什么、何时停止或升级。 |
| `systemPrompt` | 长期稳定的身份、原则和工作方式；不要写一次性用户需求。 |
| `operatingGuidelines` | 可执行的步骤或行为规范。 |
| `qualityStandards` | 判断结果是否合格的标准。 |
| `capabilities` | 当前允许的能力枚举：`research`、`copywriting`、`image-generation`、`file-read`、`file-write`、`workflow`。 |
| `skillIds` | 该员工可使用的已存在技能 ID；不要猜测不存在的技能。 |
| `enabled` | 是否允许被运行时使用。 |

### 8.3 businessBoundary、systemPrompt、guidelines、qualityStandards 的区别

- `businessBoundary` 回答“工作范围和禁区是什么”。例如“不负责发布，不虚构来源”。
- `systemPrompt` 回答“这个岗位长期以什么身份和原则工作”。
- `operatingGuidelines` 回答“执行任务时按哪些步骤做”。
- `qualityStandards` 回答“什么结果才算合格”。

不要把四者都写成同一句空泛的“认真完成任务”。

### 8.4 员工生成规则

当用户要求生成员工时，AI 必须输出一个可编辑的员工定义，不要把工作流 JSON 混在员工对象里。员工生成应：

1. 先确定岗位名称和职责边界。
2. 把一次性需求留给工作流节点的 `instruction`，不要硬编码进员工长期提示。
3. 只选择实际支持的 `capabilities` 和已存在的 `skillIds`。
4. 写出至少一条具体工作规范和质量标准。
5. 明确不负责的事项、无法确认时的处理方式和必要的人工升级。
6. 不放 API Key、密码、Token、任意代码或破坏性命令。

同一个员工可以在不同节点或不同工作流中复用，但一个运行中的相同员工会话需要遵守运行时的会话锁定和隔离规则。不要把会话 ID 写进工作流定义。

## 9. 节点提示词与结构化输出

### 9.1 指令只使用显式变量

每个模型节点的 `instruction` 应像一个函数，只读取自己的输入变量：

```text
请根据 {{topic}} 和 {{research}}，按照 {{outline}} 写成面向 {{audience}} 的成稿。
```

不要写：

```text
请读取工作流中所有历史节点、全局上下文和上一个节点的全部内容。
```

当前生成契约没有自动全局上下文。需要什么，就建立什么绑定；不需要的上游数据不要传入。

### 9.2 JSON 输出节点

如果下游需要字段级引用，使用 `outputMode: "json"` 并声明字段：

```json
{
  "config": {
    "instruction": "分析 {{topic}}，只输出 JSON 对象，包含 summary 和 sources 两个字段。summary 是字符串，sources 是来源数组。",
    "mode": "single",
    "skillIds": [],
    "outputMode": "json"
  },
  "outputVariables": [
    { "name": "summary", "description": "摘要" },
    { "name": "sources", "description": "来源" }
  ]
}
```

不要让下游通过字符串解析一段混有解释的自然语言来猜字段。能结构化就结构化。

### 9.3 固定结束节点的输入与输出

`output` 是每个工作流固定存在的结束节点，也需要通过 `inputBindings` 声明它要接收的变量。默认的 `config.contentMode` 是 `"variable"`：绑定一个变量时直接转发它，绑定多个变量时返回以本地变量名为键的对象。需要把多个值重组为一段字符串时，将 `contentMode` 设为 `"text"`，并在 `config.text` 中使用已绑定的 `{{变量}}` 或 `{{变量.字段}}`，例如 `标题：{{title}}\n正文：{{body}}`。不要清空结束节点的输入绑定来切换文本模式。

### 9.3 敏感数据

变量绑定会把数据提供给当前节点。AI 生成时应遵守最小数据原则：

- 只绑定节点真正需要的字段；
- 不要把完整用户对象传给只需要一个字段的节点；
- 不要把密钥、密码、Token 写入 prompt、HTTP headers、代码或工作流 JSON；
- 不要把一个员工的内部提示词当作另一个节点的业务输入。

## 10. 安全边界与当前限制

### 10.1 受限制的执行能力

- `shell` 的命令禁止控制字符、管道、重定向、反向 Shell 和破坏性命令；路径和参数必须是最小范围。
- `file` 只能使用工作区相对路径，不要使用绝对路径、父目录逃逸或系统敏感路径。
- `code` 运行在独立子进程中且有超时；不要使用 `eval`、动态下载脚本、反向连接或删除数据的逻辑。
- `http` 只允许 HTTP/HTTPS；不要在定义中写真实凭据。非 2xx 响应会被视为失败。
- MCP 必须有用户明确提供的工具名和结构化参数；不能凭空猜工具。
- 需要人工确认的发布、覆盖、删除、外发等动作应使用 `approval` 或保留为人工步骤。

### 10.2 当前不支持的隐含能力

生成器不得生成或暗示以下能力已经存在：

- 任意节点自动看到全部历史上下文；
- 多输入“谁先到谁先执行”的 OR 汇聚；
- 无条件的重试、回滚、补偿和幂等控制；
- 图结构循环或无限循环；
- 未声明的 `switch`、`merge`、`race`、`retry`、`global-context` 节点类型；
- 自动发现 MCP 工具；
- 自动授予 Shell、文件或代码执行权限；
- 把员工名称直接当作 employee ID；
- 用不存在的输出字段或不存在的员工、技能 ID。

如果用户明确需要上述能力，生成器应在当前能力内给出最接近的可审阅方案，并在 `description` 或生成警告中说明限制；不能伪造一个看似支持但运行时不认识的字段。

## 11. 标准生成示例

### 11.1 线性变量引用：调研、提纲、写作

下面是用户示例的完整核心结构。重点不是坐标，而是输入绑定和输出契约：

```json
{
  "schemaVersion": 2,
  "id": "topic-research-writing",
  "name": "调研到成稿",
  "description": "输入主题和受众，先调研，再生成提纲，最后写作。",
  "revision": 1,
  "enabled": true,
  "nodes": [
    {
      "id": "start",
      "type": "input",
      "label": "开始输入",
      "config": { "name": "request" },
      "position": { "x": 80, "y": 220 },
      "inputBindings": [],
      "outputVariables": []
    },
    {
      "id": "research",
      "type": "ai-task",
      "label": "调研",
      "description": "整理主题相关摘要和来源。",
      "config": {
        "instruction": "围绕 {{topic}}，面向 {{audience}} 做调研。只输出 JSON 对象，包含 summary 和 sources。",
        "mode": "single",
        "skillIds": [],
        "outputMode": "json"
      },
      "inputBindings": [
        { "id": "research-topic", "name": "topic", "sourceNodeId": "start", "sourcePath": "topic", "required": true },
        { "id": "research-audience", "name": "audience", "sourceNodeId": "start", "sourcePath": "audience", "required": true }
      ],
      "outputVariables": [
        { "name": "summary", "description": "调研摘要" },
        { "name": "sources", "description": "来源列表" }
      ],
      "position": { "x": 360, "y": 220 }
    },
    {
      "id": "outline",
      "type": "ai-task",
      "label": "提纲",
      "config": {
        "instruction": "根据 {{topic}}、{{audience}} 和 {{research}} 生成写作提纲。只输出 JSON 对象，包含 outline。",
        "mode": "single",
        "skillIds": [],
        "outputMode": "json"
      },
      "inputBindings": [
        { "id": "outline-topic", "name": "topic", "sourceNodeId": "start", "sourcePath": "topic", "required": true },
        { "id": "outline-audience", "name": "audience", "sourceNodeId": "start", "sourcePath": "audience", "required": true },
        { "id": "outline-research", "name": "research", "sourceNodeId": "research", "sourcePath": "summary", "required": true }
      ],
      "outputVariables": [
        { "name": "outline", "description": "文章提纲" }
      ],
      "position": { "x": 640, "y": 220 }
    },
    {
      "id": "writer",
      "type": "employee",
      "label": "写作",
      "config": {
        "employeeId": "douyin-copywriter",
        "instruction": "请根据主题 {{topic}}、受众 {{audience}}、调研 {{research}} 和提纲 {{outline}} 完成成稿。",
        "outputMode": "text"
      },
      "inputBindings": [
        { "id": "writer-topic", "name": "topic", "sourceNodeId": "start", "sourcePath": "topic", "required": true },
        { "id": "writer-audience", "name": "audience", "sourceNodeId": "start", "sourcePath": "audience", "required": true },
        { "id": "writer-research", "name": "research", "sourceNodeId": "research", "sourcePath": "summary", "required": true },
        { "id": "writer-outline", "name": "outline", "sourceNodeId": "outline", "sourcePath": "outline", "required": true }
      ],
      "outputVariables": [],
      "position": { "x": 920, "y": 220 }
    },
    {
      "id": "final-output",
      "type": "output",
      "label": "最终输出",
      "config": {},
      "inputBindings": [
        { "id": "output-result", "name": "result", "sourceNodeId": "writer", "required": true }
      ],
      "outputVariables": [],
      "position": { "x": 1200, "y": 220 }
    }
  ],
  "edges": [
    { "id": "edge-start-research", "source": "start", "target": "research" },
    { "id": "edge-research-outline", "source": "research", "target": "outline" },
    { "id": "edge-outline-writer", "source": "outline", "target": "writer" },
    { "id": "edge-writer-output", "source": "writer", "target": "final-output" }
  ]
}
```

注意：写作节点虽然画布上只接收提纲的顺序连线，但它通过绑定同时依赖开始输入和调研节点。这是合法且必要的多输入。

### 11.2 一对多分支与共同汇聚

“同一个主题同时做事实核验和受众分析，二者完成后再写作”应该建模为：

```text
开始输入 ──┬─> 事实核验 ──┐
          └─> 受众分析 ──┴─> 写作
```

写作节点建立两个必需绑定：

```json
[
  { "id": "writer-facts", "name": "facts", "sourceNodeId": "fact-check", "sourcePath": "summary", "required": true },
  { "id": "writer-audience", "name": "audience", "sourceNodeId": "audience-analysis", "sourcePath": "summary", "required": true }
]
```

写作会等待两个来源都进入终态；两个来源都成功时才会获得两个正常值。它不是“哪个先完成就写哪个”。

### 11.3 二路条件与共同下游

```text
输入 ─> 判断是否需要人工审核
          ├─ true  ─> 人工审核 ─┐
          └─ false ─> 自动整理 ─┴─> 输出
```

`输出`可以有两个入边，但不要同时强制绑定两个互斥分支的结果。更稳妥的做法是让“人工审核”和“自动整理”都输出相同结构，例如 `{ "content": "...", "reviewed": true/false }`，然后输出节点只绑定当前有效路径的 `result`，或使用可选绑定并明确默认值。

## 12. 生成后的校验清单

提交 JSON 前逐项检查：

### 结构

- [ ] 顶层 `schemaVersion` 是 `2`。
- [ ] 至少有一个 `input` 和一个 `output`。
- [ ] 所有节点 ID 唯一，所有连线 ID 唯一。
- [ ] 每个 `source`、`target`、`sourceNodeId` 都指向存在的节点。
- [ ] 多节点工作流有连线，且图无环。
- [ ] 每个节点都有 `id`、`type`、`label`、`config`、`position`、`inputBindings`、`outputVariables`。

### 数据

- [ ] 每个模型节点使用的 `{{变量}}` 都在本节点绑定中声明。
- [ ] 每个绑定的 `name` 唯一且符合变量名规则。
- [ ] 需要字段级引用时设置正确的 `sourcePath`。
- [ ] JSON 节点的 `outputVariables` 与指令中要求的字段一致。
- [ ] 不依赖隐式“上一个节点全部输出”或全局历史上下文。
- [ ] 多输入节点只等待它真正需要的上游，不要把无关节点连进来。

### 控制流

- [ ] 一个来源可以多路输出；多来源汇聚默认是 AND。
- [ ] 没有把普通多输入误写成 OR / race / first。
- [ ] `condition` 的 true/false 连线端口正确；多于两种情况使用嵌套 condition。
- [ ] `parallel` 只用于节点内并发，不代替需要单独审阅的图节点。
- [ ] `loop` 有 1 到 100 的有限上限。

### 员工与安全

- [ ] employee 节点引用目录中真实存在且启用的员工 ID。
- [ ] 没有合适员工时使用 `ai-task`，除非请求允许先创建员工。
- [ ] 没有猜测不存在的 skill ID 或 MCP 工具名。
- [ ] 没有密钥、密码、Token、敏感内部提示词。
- [ ] code、shell、file、http 都是用户明确需要的，并满足对应安全边界。
- [ ] 需要人工确认的动作经过 `approval` 或明确保留为人工步骤。

## 13. 给生成器的最终指令

当自然语言需求与本文冲突时，优先保证输出真实可运行、可解释、可校验；不要为了满足一句模糊描述而发明新的运行语义。只输出符合 schema 的 JSON。若需求无法在当前节点类型和 AND 依赖模型内准确表达，应生成最小可运行子流程，并在工作流描述或警告中指出缺失能力，而不是制造未实现的字段。
