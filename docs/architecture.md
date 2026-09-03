# EzDSH 技术架构

## 1. 总体结构

EzDSH 默认使用固定版本的已发布 `@deepseek-ai/dsh` npm 包和其生产依赖闭包。运行时从 EzDSH 自身安装目录的 `node_modules` 启动，不从用户系统 PATH 或不确定的本机安装目录寻找 DSH。只有需要修改 DSH 本身时，才通过 `vendor/deepseek-harness` 源码 workspace 联调；该路径必须由显式开发环境变量提供，并且不得进入生产配置。

```text
┌─────────────────────────────────────────────┐
│                  EzDSH Desktop               │
│                                             │
│  ┌──────────────┐     IPC      ┌──────────┐ │
│  │ Main Process │◄────────────►│ Renderer │ │
│  │              │               │          │ │
│  │ Runtime      │               │ Setup   │ │
│  │ Config       │               │ Harness │ │
│  │ Update       │               │ Status  │ │
│  │ Security     │               │          │ │
│  └──────┬───────┘               └──────────┘ │
│         │ child process                     │
│         ▼                                    │
│  ┌────────────────────┐                      │
│  │ DeepSeek Harness   │                      │
│  │ local Web Runtime  │                      │
│  └─────────┬──────────┘                      │
│            │                                  │
│            ▼                                  │
│      127.0.0.1:<port>                        │
└─────────────────────────────────────────────┘
```

## 2. 进程职责

### 2.1 Main Process

Main Process 是唯一可以接触 Node.js、文件系统、子进程和更新安装能力的进程，负责：

- 创建 BrowserWindow；
- 创建和校验用户数据目录；
- 启动、监控和停止 DSH Runtime；
- 分配和记录本地端口；
- 读取供应商状态；
- 通过 Harness API 保存 Credentials 和 Provider Route；
- 打开日志文件位置；
- 检查、下载和安装 EzDSH 更新；
- 在应用更新前创建用户数据恢复快照，并在 Runtime 启动失败后进入 Recovery Mode；
- 管理 checksum、rotation、dry-run/atomic restore 和独立 rescue channel；
- 处理应用退出和单实例唤醒。

### 2.2 Preload

Preload 只使用 `contextBridge` 暴露明确的 IPC 合约，不暴露 `ipcRenderer`、Node.js、文件路径访问和任意命令执行能力。

建议 API：

```ts
interface EzDSHBridge {
  runtime: {
    getStatus(): Promise<RuntimeSnapshot>
    restart(): Promise<void>
    openLog(): Promise<void>
  }
  providers: {
    listDefinitions(): Promise<ProviderDefinition[]>
    getStatus(): Promise<ProviderStatus[]>
    testConnection(input: TestProviderInput): Promise<TestConnectionResult>
    save(input: SaveProviderInput): Promise<SaveProviderResult>
  }
  updates: {
    check(): Promise<UpdateState>
    download(): Promise<void>
    install(): Promise<void>
    onStateChange(listener: (state: UpdateState) => void): () => void
  }
  recovery: {
    listSnapshots(): Promise<RecoverySnapshot[]>
    createSnapshot(): Promise<RecoverySnapshot>
    deleteSnapshot(selector: string): Promise<void>
    verify(selector: string): Promise<RecoveryVerifyResult>
    doctor(repair?: boolean): Promise<RecoveryDoctorResult>
    restore(selector: string, dryRun: boolean): Promise<RecoveryDryRun | RecoveryRestoreResult>
  }
  locale: {
    get(): Promise<'zh' | 'en'>
    onChange(listener: (locale: 'zh' | 'en') => void): () => void
  }
}
```

### 2.3 Renderer

Renderer 负责展示状态和收集用户操作：

- Runtime 启动进度和错误恢复；
- 更新提示和下载进度；
- Harness Web UI 容器。

当前版本暂时不显示 EzDSH 自己的供应商配置页面。供应商、模型和 API Key 配置由 Harness Web UI 负责，EzDSH 只负责启动 Runtime、等待健康检查并加载本地页面。Provider IPC 和 Main Process 服务仍然保留，供后续版本重新启用桌面端配置流程。

Renderer 不负责：

- 读取 API Key 文件；
- 启动子进程；
- 拼接运行目录；
- 调用任意外部 URL；
- 决定凭据存储方式。

首次启动时，Renderer 让 Main 启动 DSH Runtime，并在健康检查通过后将本地 URL 放入受限 iframe。Runtime 页面中的模型设置和供应商配置由 Harness Web UI 提供，EzDSH 负责应用级的启动、退出、日志和更新边界。

工作流发布、客户环境和观测也遵循同样的边界：Renderer 只能看到发布摘要、环境摘要和脱敏后的健康/观测记录；不可变的 release snapshot、工作流定义副本、运行载荷、凭据明文和原始响应始终保留在 Main Process 的本机存储中。

### 2.4 语言同步

EzDSH 与 DSH Runtime 共用 `harness/settings.yaml`。主进程读取其中的 `locale.preference`（`zh` 或 `en`），并通过 Preload IPC 同步给 Renderer；设置文件发生变化时，主进程使用轻量文件轮询通知 Renderer 更新外层页面和应用菜单。Runtime 内部的 Web UI 继续读取同一配置文件，因此内外界面保持同一种语言。配置缺失或值不受支持时，EzDSH 使用英文作为安全默认值，不阻止 Runtime 启动。

## 3. Runtime Manager

Runtime Manager 负责 DSH Runtime 的整个生命周期。

### 3.1 状态模型

```ts
type RuntimePhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed'

interface RuntimeSnapshot {
  phase: RuntimePhase
  mode: 'normal' | 'safe'
  pid?: number
  port?: number
  url?: string
  launchDirectory: string
  logPath: string
  startedAt?: string
  message?: string
}
```

### 3.2 启动顺序

1. 计算 `userData`；
2. 创建 `launch-root`、`harness`、`workflow` 和 `logs`；
3. 获取可用随机回环端口；
4. 使用内置 DSH Runtime 入口启动子进程；
5. 为子进程设置独立的 Harness 数据目录；
6. 将 stdout/stderr 写入日志；
7. 如果 Runtime 报告端口已占用，清理当前子进程并将端口加 1，重新启动；
8. 最多尝试 21 个连续端口，普通启动错误不换端口；
9. 轮询健康检查；
10. 通过事件通知 Renderer；
11. 健康检查成功后加载 `http://127.0.0.1:<port>`；
12. 进程退出时更新状态并触发错误恢复。

### 3.3 停止规则

- 正常退出先发送温和终止信号；
- 在有限超时时间内等待子进程退出；
- 超时后记录原因，再使用强制终止；
- 每次停止后清理本次运行的临时端口状态；
- 不删除 `harness/`、`profiles/`、`sessions/` 或 `plugins/`。

## 4. 模型供应商配置模块

本模块的 Main Process 服务、Provider Definition 和 IPC 合约暂时保留，但当前版本不从 Renderer 展示或触发 EzDSH 配置页面。后续版本可以在不改变凭据文件和 IPC 边界的前提下重新启用桌面端配置。

### 4.1 Provider Definition

```ts
interface ProviderDefinition {
  id: string
  displayName: string
  category: 'vendor' | 'aggregator' | 'inference'
  credentialKey: string
  defaultBaseUrl?: string
  supportsConnectionTest: boolean
  modelCatalogSource: 'builtin' | 'remote' | 'custom'
}
```

### 4.2 空配置判定

```ts
interface ProviderStatus {
  providerId: string
  hasCredential: boolean
  routeConfigured: boolean
  reachable?: boolean
  usable: boolean
}

function needsProviderSetup(statuses: ProviderStatus[]): boolean {
  return statuses.length === 0 || !statuses.some((status) => status.usable)
}
```

页面展示条件必须由 Main Process 或可信的 Harness Settings API 计算，不能只根据 Renderer 的本地状态判断。

### 4.3 保存流程

```text
Renderer 输入 API Key
  ↓ IPC
Main Process 校验 Provider Definition
  ↓
调用 Harness Credentials API 保存密钥
  ↓
调用 Harness Settings API 创建 Provider Route
  ↓
执行连接测试
  ↓
返回脱敏后的 ProviderStatus
```

任何错误返回都只能包含错误类别、用户可读消息和 request id，不返回 API Key。

当前首版通过主进程直接调用同一份本地配置契约完成保存：密钥写入 `harness/.credentials.yaml`，设置写入 `harness/settings.yaml`，两个文件均使用 `0600` 权限；Renderer 收到的结果只包含脱敏状态。后续接入更细粒度的 Harness Settings/Credentials RPC 时，文件位置和 IPC 合约保持不变。

## 5. 更新模块

EzDSH 使用整包更新。更新包中包含桌面代码、Preload、Renderer、DSH Runtime 和对应的 patch。

```ts
interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'preparing'
    | 'installing'
    | 'up-to-date'
    | 'failed'
  currentVersion: string
  availableVersion?: string
  percent?: number
  message?: string
}
```

更新约束：

- 下载和安装只在已打包版本中启用；
- macOS 使用签名的 DMG/ZIP 组合；
- Windows 使用签名的 NSIS 安装包；
- 每次发布生成对应平台的更新元数据和哈希；
- 安装前停止 DSH Runtime；
- 安装后保留用户 `userData`；
- 启动时检查数据 schema 和 Runtime 兼容性；
- 更新失败不能破坏当前版本；
- beta 与 stable 使用不同更新通道。

当前已经实现更新状态、检查、手动下载、下载进度和重启安装的 Main/Preload/Renderer 链路。安装动作在 `quitAndInstall` 前先创建 `pre-update` 快照并写入持久化升级事务；动态更新 resolver 可以声明目标分发包的 `dshRuntimeVersion`，该版本会随事务保存。新版本启动后如果 Runtime 未通过健康检查，EzDSH 停在 Recovery Mode，不自动覆盖现场。正式包使用 `generic` 更新源；开发模式默认不访问更新服务，但设置 `EZDSH_UPDATE_FEED_URL` 后可以临时检查远程测试源。发布前仍需完成 Vercel 更新源部署、签名、公证、更新文件上传和稳定版/beta 通道配置。

## 6. Recovery 与灾难恢复

恢复能力由 EzDSH Main Process 原生实现，不依赖 DSH Runtime 插件。快照包含 `harness/` 与 `state/`，覆盖 Sessions、Settings、Skills、Plugins、Profiles、Presets 和已安装清单；每个快照同时写入 SHA-256、manifest 和插件版本清单。快照按类型轮换：普通手动快照保留最近 7 份，升级前快照保留最近 2 份，插件变更前快照保留最近 7 份，恢复前快照保留最近 1 份。

Credential 明文默认不进入 Archive。受限文件（当前包括 `harness/.credentials.yaml`、`.env`、QQ Bridge 配置以及 Workflow 的加密凭证库 `state/.workflow-credentials.json`/`.key`）只复制到 `backups/vault/<snapshot>/`，文件权限为 `0600`；恢复到新机器时 dry-run 会明确列出需要重新输入的 Credential。Archive 的 checksum 不通过时，恢复会拒绝执行。设置中的“校验备份”只比较 Archive 与记录的 SHA-256，不会恢复或修改数据；删除备份会同时删除 Archive、checksum、manifest 和对应的本机 vault，并拒绝删除当前恢复事务正在依赖的快照。

真实恢复先校验并解包到 staging，再以目录 rename 方式替换 `harness/` 和 `state/`；失败会回滚到恢复前目录。Session Log doctor 默认只读扫描 `harness/sessions`，只允许显式修复最后一条未完成 JSONL 记录，中间已提交损坏不会自动改写。应用完成升级后会清除升级事务；升级启动失败则保留事务并展示“恢复上一份环境”。

每次成功创建快照还会把零依赖的 `rescue.mjs` 和平台 launcher 写入 `backups/`。它可以在 EzDSH 或 DSH Runtime 无法启动时通过 `list`、`verify`、`doctor`、`restore --yes` 或 loopback Web UI 工作。应用二进制本身仍由 electron-updater 管理；当前 rollback 保障的是用户数据与 Runtime 配置，不伪装成应用安装包的二进制回滚。

### 6.1 Plugin Safe Mode 与受管插件恢复

EzDSH Store 对 DSH profile 插件执行的 install、update 和 uninstall 是同一个事务：先停止正在运行的 Runtime，再创建 `pre-plugin-change` 快照，然后修改 profile 与 `state/installed.json`，最后启动正常 Runtime 并等待健康检查。健康检查成功才清除事务；命令在修改前失败时清除未使用的事务；命令成功但正常 Runtime 失败时保留事务并自动进入 Safe Mode。

Safe Mode 在 `state/safe-mode/harness` 使用新的 DSH_HOME。它只复制 `harness/.credentials.yaml`（权限 `0600`），不复制 `profiles/`、`cordis.patch.yml`、`sessions/` 或第三方依赖。因此它不会改写原 `harness/`，并能在所有第三方插件都被排除时提供恢复入口。Recovery Panel 可以手动进入或退出 Safe Mode，并且在受管插件事务失败时显示插件名和“回滚此插件变更”；回滚会恢复该事务对应的快照后再尝试正常启动。

插件目录可声明 `minDshVersion` 和 `maxDshVersion`。已知不兼容的版本范围在安装前阻止；未声明范围会以警告继续。注册表和 manifest 保存 package source、版本约束、当前 DSH Runtime 评估以及目标更新 Runtime（若 resolver 声明），因此恢复记录可以解释风险。即使有这些证据，EzDSH 仍不承诺回滚应用二进制；它只回滚用户数据和可管理的 DSH 环境。

## 7. IPC 错误模型

所有 IPC 方法使用统一错误格式：

```ts
interface EzDSHError {
  code:
    | 'INVALID_INPUT'
    | 'PROVIDER_NOT_FOUND'
    | 'CREDENTIALS_ERROR'
    | 'CONNECTION_FAILED'
    | 'RUNTIME_START_FAILED'
    | 'RUNTIME_TIMEOUT'
    | 'UPDATE_FAILED'
  message: string
  requestId: string
  retryable: boolean
}
```

Renderer 只根据 `code` 和 `retryable` 决定界面行为，不能解析底层异常堆栈。

## 8. 建议目录结构

```text
src/
├── main/
│   ├── index.ts
│   ├── runtime/
│   │   ├── runtime-manager.ts
│   │   ├── health-check.ts
│   │   └── runtime-types.ts
│   ├── providers/
│   │   ├── provider-definitions.ts
│   │   └── provider-service.ts
│   ├── update/
│   │   ├── update-manager.ts
│   │   └── update-types.ts
│   ├── recovery/
│   │   └── recovery-manager.ts
│   ├── state/
│   │   ├── user-data.ts
│   │   └── migrations.ts
│   ├── locale/
│   │   └── locale-service.ts
│   └── security/
│       └── window-security.ts
├── preload/
│   └── index.ts
├── renderer/
│   ├── app/
│   ├── onboarding/
│   ├── runtime-status/
│   ├── update-center/
│   ├── recovery/
│   └── settings/RecoverySection.tsx
└── shared/
    ├── contracts.ts
    ├── errors.ts
    ├── providers.ts
    └── state.ts
```

## 9. Workflow 编排与专业员工架构

Workflow 是 EZDSH 的核心桌面能力，定义文件与 React Flow 解耦。Renderer 只提交 JSON-safe 的 `WorkflowDefinition`，Main Process 在持久化和执行前再次 normalize/validate；凭据、Node.js、文件系统和子进程能力不会下沉到 Renderer。

产品模型保持单向关系：工作流拥有流程，专业员工只是可被工作流引用的执行角色，员工档案不拥有可执行的内部工作流。员工档案区分个人名字 `displayName` 与正式岗位 `role`，前者用于个性化和区分同岗位员工，后者用于职责匹配；智能处理节点用于当前流程中的轻量临时推理，不要求先创建员工。

```text
React Flow Canvas
      │ typed contextBridge IPC
      ▼
Main: WorkflowStore + WorkflowRunService + local WorkflowRunWorker
      │                    │                    │
      │                    │                    ├─ queue/lease/effect checkpoints
      │                    │                    ├─ state/workflows.json
      │                    │                    └─ state/workflow-runs.json
      │                    │
      │                    └─ CredentialStore + ConnectorStore/Service
      │                         (secrets never enter Renderer or Workflow JSON)
      ▼
DSH Runtime Session API (AI task / Employee / Skill / MCP)
```

Schema V2 的节点类型包括 `input`、`ai-task`、`structured-extract`、`employee`、`skill`、`mcp`、`parallel`、`loop`、`sleep`、`condition`、`switch`、`approval`、`wait-input`、`sub-workflow`、`object-builder`、`list-operator`、`merge`、`transform`、`text-merge`、`output`、`shell`、`file`、`http` 和 `code`。加载 Schema V1 时，旧 `agent` 节点会在 normalize 边界迁移成 `ai-task`，默认标签从 Agent 改成“智能处理”，自定义标签保留；旧 `approval` 节点继续读取，新建流程使用 `wait-input` 的 approval 预设。

`ai-task`、`employee`、Skill 和 MCP 节点通过现有 `DshSessionClient` 创建独立 Session。员工节点先通过 `EmployeeService.get(employeeId)` 解析启用的档案，再把个人名字、正式岗位、业务边界、工作原则、执行规范、质量标准和技能 ID 注入节点执行；不存在或停用的员工会让节点明确失败。Parallel 以受控并发 fan-out 执行多条指令，Loop 对上游数组逐项执行，Approval 在 Main 进程等待用户决定。

节点输入输出使用 `WorkflowValue`，即 JSON-safe 的标量、数组和对象。智能处理和员工节点可以输出文本或 JSON；JSON 第一次解析失败时，适配器在同一个 Session 中请求一次格式修复，第二次失败才终止节点。这样桌面端不依赖 Runtime 内部未稳定的 Workflow RPC，同时仍可使用 DSH 已安装的 Skill/MCP 工具。

每个运行记录保存工作流 revision、输入、节点状态、节点输出、错误、事件以及可选的队列、租约、幂等键和外部副作用状态。节点完成或失败后立即原子写入 `state/workflow-runs.json`；应用运行期间由一个本地 `WorkflowRunWorker` 从持久队列原子抢占记录并续租，重启时会回收旧租约：没有外部副作用的运行重新排队，已准备/派发/确认但未完成落盘的副作用则标记为未知并暂停，绝不自动重放。相同工作流 revision 只有在调用方显式提供相同幂等键时才去重。

重试是有上限的显式策略：确定性节点可以按指数退避重试；托管 HTTP 连接器只有在声明 `idempotent` 模式、远端支持 `Idempotency-Key` 时才允许写请求重试。原始 HTTP、MCP、Shell、File、Code 和子工作流不会被通用重试或猜测性回滚；不确定副作用必须人工核对，补偿只能执行工作流定义中明确声明的反向 Workflow。取消先持久化请求，再向 DSH Session、HTTP 和子进程传递 `AbortSignal`；租约丢失时停止写入旧 Worker 的终态。

AI 生成任务另存 `workflow-generation-history.json`，关键阶段保存 checkpoint 和生成用 Runtime Session；网络、格式错误、用户终止或重启后可从生成历史继续，已完成的员工处理不会重复，Session 在草稿校验成功后才归档。该 Worker 是应用进程内的本地执行器，不是 24 小时后台服务或分布式队列。

Shell/File 是高风险节点：运行按钮必须明确勾选授权，Shell 使用 `shell:false` 且拒绝控制字符，File 只接受 Workflow 工作目录内的相对路径，所有路径由 Main 重新解析和 containment-check。托管连接器只允许 HTTPS、固定路径前缀、公共 DNS 目标和凭证 scope 与工作流权限/本次运行 grant 的交集；凭证元数据可经 IPC 查看，但密钥只在 Main 进程临时注入请求头，响应和错误会脱敏。原始 URL HTTP 仅为兼容旧嵌入，生产组合默认关闭。AI 生成只返回待审阅草稿，先做 JSON 提取、Schema normalize 和安全校验，用户保存后才进入定义存储。

员工档案使用 Schema V2，包含档案版本、业务边界、执行规范、质量标准和技能 ID。旧 Employee 的线性步骤在加载时迁移成非执行性的执行规范。Main 侧快速转换只生成 `input → employee → output`，不会复制出隐藏的员工内部流程。

工作流业务模板不再由页面内置按钮生成；模板通过版本化 JSON 导入，或由后续插件按稳定交换格式提供。这样模板不会侵入核心工作流编辑器和项目创建逻辑。
