# Workflow Schema v2

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
      "config": {
        "instruction": "请分析 {{company}}，输出 {{summary}}。",
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
- `edges` use unique IDs and connect existing node IDs through `source` and `target`. They control execution order, branching and loops; they must not be empty for multi-node workflows, and must not form cycles.
- `inputBindings` is the only way a node receives data. Each binding has a local `name`, a `sourceNodeId`, an optional dot-separated `sourcePath`, and `required`. The node can use it in instructions as `{{name}}` or `{{name.field}}`; values not bound to the node are not interpolated.
- `sourcePath` omitted means the source node's complete `result`. For a JSON result, declare selectable fields in `outputVariables`; `result` is always implicit. A binding creates an execution dependency even if the nodes do not have a direct edge.
- The supported node types are `input`, `ai-task`, `employee`, `skill`, `mcp`, `parallel`, `loop`, `condition`, `approval`, `transform`, `output`, `shell` and `file`.
- An `employee` node must use an existing, enabled employee ID and include a non-empty instruction. When no suitable employee exists, create one before graph generation; if creation is unavailable, use `ai-task`.
- A `condition` node uses exactly one of `truthy`, `equals`, `not-equals`, `contains`, `greater-than` or `less-than`. Its outgoing branch edges use `sourcePort: "true"` or `sourcePort: "false"`.

Generated workflows are automatically laid out from this dependency graph before the editor opens. The editor also exposes **自动排版** to optimize any imported or manually edited document.
