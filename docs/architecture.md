# EzDSH 技术架构

## 1. 总体结构

EzDSH 使用 `vendor/deepseek-harness` Git 子模块和固定 pnpm workspace 构建 DSH Runtime。首个锁定版本为 `@deepseek-ai/dsh@0.1.0-rc.5`，源码提交锁定为 `47f943859bef60e4160492346772ded9b24f765a`。运行时从 EzDSH 自身资源目录启动，不从用户系统 PATH 或不确定的本机安装目录寻找 DSH。开发阶段如需联调其他 Runtime 源码，必须通过显式开发环境变量覆盖，并且该路径不得进入生产配置。

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

### 2.4 语言同步

EzDSH 与 DSH Runtime 共用 `harness/settings.yaml`。主进程读取其中的 `locale.preference`（`zh` 或 `en`），并通过 Preload IPC 同步给 Renderer；设置文件发生变化时，主进程使用轻量文件轮询通知 Renderer 更新外层页面和应用菜单。Runtime 内部的 Web UI 继续读取同一配置文件，因此内外界面保持同一种语言。配置缺失或值不受支持时，EzDSH 使用中文作为安全默认值，不阻止 Runtime 启动。

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
2. 创建 `launch-root`、`harness` 和 `logs`；
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

当前已经实现更新状态、检查、手动下载、下载进度和重启安装的 Main/Preload/Renderer 链路。正式包使用 `generic` 更新源；开发模式默认不访问更新服务，但设置 `EZDSH_UPDATE_FEED_URL` 后可以临时检查远程测试源。打包模式关闭自动下载和退出时自动安装，由 EzDSH 在安装前停止 Runtime。发布前仍需完成 Vercel 更新源部署、签名、公证、更新文件上传和稳定版/beta 通道配置。

## 6. IPC 错误模型

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

## 7. 建议目录结构

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
│   └── update-center/
└── shared/
    ├── contracts.ts
    ├── errors.ts
    ├── providers.ts
    └── state.ts
```
