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
  }
}
```

字段约定：

- `format` 固定为 `ezdsh.workflow`，用于防止把其他 JSON 文件误导入。
- `formatVersion` 是交换格式版本；当前值为 `1`。
- `exportedAt` 是 ISO 8601 导出时间。
- `workflow` 是 Schema V2 工作流定义，包含名称、说明、节点、连线、版本和启用状态。
- `workflow.nodes[].id` 在工作流内唯一；`type` 必须是受支持的节点类型；`config` 必须符合节点类型配置。
- `workflow.edges[]` 只能引用已有节点。条件节点的分支连线使用 `sourcePort: "true"` 或 `"false"`。
- 节点 `position` 只保存编辑器布局，不参与运行语义。

导入时会校验包络版本、工作流 Schema、节点配置、节点引用、连线和循环依赖。导入成功后会创建一个新的工作流记录，不会覆盖同 ID 的现有工作流，也不会导入运行记录或凭据。
