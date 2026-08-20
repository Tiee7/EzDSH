# EzDSH External API

EzDSH exposes a small loopback-only HTTP facade for local tools such as
`ezdsh-workbench`. It reuses the running DSH Runtime's native workspace and
session API; it does not modify DSH Runtime data files.

The default address is `http://127.0.0.1:53260`. Override the port before
starting EzDSH with `EZDSH_EXTERNAL_API_PORT`.

## Endpoints

### Health

```http
GET /api/external/v1/health
```

Returns `{ "ok": true, "runtimeReady": true|false }`.

### Projects

```http
GET /api/external/v1/projects
POST /api/external/v1/projects
```

The list returns native DSH workspaces. `id` is the opaque DSH `workspaceId`.
The create body is `{ "path": "/absolute/existing/directory", "title": "可选标题" }`.
Creating a project never creates a filesystem directory.

### Create a session

```http
POST /api/external/v1/sessions
```

Use `{ "projectId": "workspace-id" }` to create a session inside a DSH
project, or `{ "cwd": "/absolute/directory" }` for an ungrouped session.
`projectId` and `cwd` are mutually exclusive.

### Queue a prompt

```http
POST /api/external/v1/sessions/:sessionId/prompts
```

Body: `{ "text": "要发送给 DSH 的指令" }`. The endpoint returns after DSH
accepts the prompt; it does not wait for the model turn to finish.

### Dispatch

```http
POST /api/external/v1/dispatch
```

Body:

```json
{
  "projectId": "workspace-id",
  "sessionMode": "new",
  "prompt": "完成这个任务"
}
```

For an existing session, use `"sessionMode": "existing"` and add
`"sessionId": "session-id"`. Existing sessions must belong to the selected
project. A `new` dispatch creates a session in the project and then queues the
prompt.

The API binds only to `127.0.0.1`; it is not a LAN or Internet API. Any local
process can reach a loopback service, so do not treat this boundary as a
multi-user authentication mechanism.

### Run（异步生成）

Workbench 等外部界面需要“边生成边展示”时使用 Run 接口。Run 是通用的
DSH 执行协议，EzDSH 不识别 Workbench 的任务、思路或 JSON 文件。

```http
POST /api/external/v1/runs
GET  /api/external/v1/runs/:runId
GET  /api/external/v1/runs/:runId/events
POST /api/external/v1/runs/:runId/cancel
```

创建请求示例：

```json
{
  "projectId": "workspace-id",
  "sessionMode": "new",
  "prompt": "只输出合法 JSON",
  "archiveSession": true,
  "output": { "format": "json" },
  "client": { "name": "workbench", "requestId": "proposal-id" }
}
```

创建返回 HTTP `202`，包含 `runId`、`sessionId` 和初始状态。事件接口使用
SSE，事件类型为 `queued`、`started`、`delta`、`completed`、`failed`、
`cancelled`；断线重连时发送 `Last-Event-ID`，服务会重放之后的事件。Run
状态保存在 EzDSH 的通用状态区，不会写入 Workbench 文件。
`archiveSession: true` 只对新建会话生效：Run 会话在生成期间保留日志但从会话列表隐藏，
直到用户通过 `ezdsh://session/<sessionId>` 查看；EzDSH 会先取消归档，再把会话交给 Harness 页面。

### Session 导航协议

`ezdsh://session/<sessionId>` 只表达“打开这个会话”，不携带 Prompt、文件
路径或写入命令。EzDSH 收到后会先取消该会话的归档状态，再聚焦主窗口、切换到
Harness，并把不透明的 session ID 转交给运行时页面；Workbench 只有在用户明确
点击“查看 DSH 会话”时才使用该协议。
