# Workflow JSON 交换格式

工作流导出文件使用 UTF-8 JSON，顶层必须是以下版本化包络：

```json
{
  "format": "ezdsh.workflow",
  "formatVersion": 1,
  "exportedAt": "2026-08-31T00:00:00.000Z",
  "workflow": {
    "schemaVersion": 2,
    "id": "workflow-example",
    "name": "示例工作流",
    "description": "工作流用途说明",
    "revision": 1,
    "nodes": [],
    "edges": [],
    "enabled": true,
    "createdAt": "2026-08-31T00:00:00.000Z",
    "updatedAt": "2026-08-31T00:00:00.000Z"
  },
  "employees": [
    {
      "id": "finance-analyst",
      "name": "财务分析师",
      "role": "财务研究专员",
      "description": "分析财务数据。",
      "businessBoundary": "只做客观分析。",
      "systemPrompt": "你是一名财务研究专员。",
      "operatingGuidelines": ["核对数据来源。"],
      "qualityStandards": ["结论可复核。"],
      "capabilities": ["research"],
      "skillIds": [],
      "enabled": true
    }
  ]
}
```

字段约定：

- `format` 固定为 `ezdsh.workflow`，用于防止把其他 JSON 文件误导入。
- `formatVersion` 是交换格式版本；当前值为 `1`。
- `exportedAt` 是 ISO 8601 导出时间。
- `workflow` 是 Schema V2 工作流定义，包含名称、说明、节点、连线、版本和启用状态。
- `employees` 可选，仅包含 `workflow.nodes` 实际引用的员工档案；员工 ID、名称、岗位、提示词、规范、能力和技能是创建/复用员工所需字段。
- `workflow.nodes[].id` 在工作流内唯一；`type` 必须是受支持的节点类型；`config` 必须符合节点类型配置。
- `workflow.edges[]` 只能引用已有节点。条件节点的分支连线使用 `sourcePort: "true"` 或 `"false"`。
- 节点 `position` 只保存编辑器布局，不参与运行语义。

工作流列表中的“导入”主按钮选择 JSON 文件，旁边的剪贴板图标从剪贴板读取 JSON。导入时会校验包络版本、工作流 Schema、节点配置、节点引用、连线和循环依赖；剪贴板内容不是 JSON 时提示“剪贴板内的数据格式不正确”。

如果导入的员工节点引用了本地不存在的员工，会先询问是否创建；发现同名员工时，会先询问是否调用现有员工。导入成功后会创建一个新的工作流记录，不会覆盖同 ID 的现有工作流，也不会导入运行记录或凭据。
