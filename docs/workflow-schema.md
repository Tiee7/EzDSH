# Workflow Schema v2

AI workflow generation, import, export and persistence all use this JSON document. A document is valid only when it satisfies the required fields and node rules below.

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
        "instruction": "识别企业并完成客观商业分析。",
        "mode": "single",
        "skillIds": [],
        "outputMode": "text"
      },
      "position": { "x": 344, "y": 180 }
    },
    {
      "id": "report-output",
      "type": "output",
      "label": "分析报告",
      "config": {},
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
- `edges` use unique IDs and connect existing node IDs through `source` and `target`. They represent the full dependency graph, must not be empty for multi-node workflows, and must not form cycles.
- The supported node types are `input`, `ai-task`, `employee`, `skill`, `mcp`, `parallel`, `loop`, `condition`, `approval`, `transform`, `output`, `shell` and `file`.
- An `employee` node must use an existing, enabled employee ID and include a non-empty instruction. When no suitable employee exists, create one before graph generation; if creation is unavailable, use `ai-task`.
- A `condition` node uses exactly one of `truthy`, `equals`, `not-equals`, `contains`, `greater-than` or `less-than`. Its outgoing branch edges use `sourcePort: "true"` or `sourcePort: "false"`.

Generated workflows are automatically laid out from this dependency graph before the editor opens. The editor also exposes **自动排版** to optimize any imported or manually edited document.
