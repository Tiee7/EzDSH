# Workflow Schema v2

面向 AI 生成器的完整概念、决策规则和示例见 [AI 工作流生成规范](./ai-workflow-generation.md)。本文保留为 JSON schema 的快速参考；两者描述的运行语义必须保持一致。

AI workflow generation, persistence and the `workflow` field inside an import/export document use this JSON definition. The UI exchange envelope is documented in `docs/workflow-json.md`; a workflow is valid only when it satisfies the required fields and node rules below.

```json
{
  "schemaVersion": 2,
  "id": "workflow-company-analysis",
  "name": "企业分析",
  "description": "识别企业属性后生成对应分析报告。",
  "revision": 1,
  "enabled": true,
  "createdAt": "2026-08-31T00:00:00.000Z",
  "updatedAt": "2026-08-31T00:00:00.000Z",
  "nodes": [
    {
      "id": "company-input",
      "type": "input",
      "label": "企业或产品名称",
      "config": { "name": "company" },
      "position": { "x": 80, "y": 180 }
    },
    {
      "id": "research",
      "type": "ai-task",
      "label": "企业识别与分析",
      "description": "先提取企业关键信息，再生成结构化分析。",
      "config": {
        "instruction": "请分析 {{company}}，只输出包含 summary 字段的 JSON 对象。",
        "mode": "single",
        "skillIds": [],
        "outputMode": "json"
      },
      "inputBindings": [
        { "id": "research-company", "name": "company", "sourceNodeId": "company-input", "required": true }
      ],
      "outputVariables": [
        { "name": "summary", "description": "企业分析摘要" }
      ],
      "position": { "x": 344, "y": 180 }
    },
    {
      "id": "report-output",
      "type": "output",
      "label": "分析报告",
      "config": {},
      "inputBindings": [
        { "id": "output-summary", "name": "result", "sourceNodeId": "research", "sourcePath": "summary", "required": true }
      ],
      "position": { "x": 608, "y": 180 }
    }
  ],
  "edges": [
    { "id": "edge-company-research", "source": "company-input", "target": "research" },
    { "id": "edge-research-output", "source": "research", "target": "report-output" }
  ]
}
```

## Graph rules

- `nodes` use unique IDs containing letters, numbers, `.`, `_` or `-`; every node has `id`, `type`, `label`, `config` and numeric `position`.
- `nodes[].description` is optional editor context shown in the node inspector; it does not participate in execution.
- An `input` node may use `config.name` for one legacy/single-value input, or `config.fields` for multiple explicit launch parameters. Each field has `name`, optional `label`, `type` (`string`, `number`, `boolean` or `json`), `required` and `defaultValue`; downstream nodes select a field with `sourcePath`.
- `edges` use unique IDs and connect existing node IDs through `source` and `target`. They control execution order, branching and loops; they must not be empty for multi-node workflows, and must not form cycles.
- `inputBindings` is the only way a node receives data. Each binding has a local `name`, a `sourceNodeId`, an optional dot-separated `sourcePath`, and `required`. The node can use it in instructions as `{{name}}` or `{{name.field}}`; values not bound to the node are not interpolated.
- `sourcePath` omitted means the source node's complete `result`. For a JSON result, declare selectable fields in `outputVariables`; `result` is always implicit. A binding creates an execution dependency even if the nodes do not have a direct edge.
- The fixed `output` node also consumes `inputBindings`. With `config.contentMode: "variable"` (the default), one binding forwards its value and multiple bindings return an object keyed by their local names. With `config.contentMode: "text"`, `config.text` is a template; `{{name}}` and `{{name.field}}` are replaced from the output node's bound inputs, so several upstream values can be composed into one final string.
- A node may bind multiple upstream nodes and one node may feed multiple downstream nodes. All edge and binding dependencies use AND semantics: the node waits until every dependency reaches a terminal state. There is no implicit any-one/OR/race merge; use `condition` for mutually exclusive paths.
- A `parallel` node runs several similar instructions inside one node and returns an array. It is not the same as graph fan-out, where one node has multiple visible downstream nodes. A `condition` has true/false exits; use nested conditions for more than two cases.
- The supported node types are `input`, `ai-task`, `employee`, `skill`, `mcp`, `parallel`, `loop`, `condition`, `approval`, `transform`, `output`, `shell`, `file`, `http` and `code`.
- An `http` node performs an `http` or `https` request with structured method, headers, query, body and response mode fields. It returns `{ status, ok, headers, body }` and fails on non-2xx responses.
- A `code` node runs Node.js or Python3 in a separate subprocess. Node.js code receives `input` and `previous` and returns a value; Python3 code receives the same variables and assigns `result`. Code execution is disabled unless the run dialog explicitly authorizes it, and every process has a timeout.
- An `employee` node must use an existing, enabled employee ID and include a non-empty instruction. When no suitable employee exists, create one before graph generation; if creation is unavailable, use `ai-task`.
- A `condition` node uses exactly one of `truthy`, `equals`, `not-equals`, `contains`, `greater-than` or `less-than`. Its outgoing branch edges use `sourcePort: "true"` or `sourcePort: "false"`.

Generated workflows are automatically laid out from this dependency graph before the editor opens. The editor also exposes **自动排版** to optimize any imported or manually edited document.
