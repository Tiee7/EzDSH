# EzDSH 产品需求文档

## 1. 产品定义

EzDSH 是 DeepSeek Harness 的桌面客户端。它将本地 Harness Runtime 作为独立子进程运行，并提供一个稳定的桌面入口，让用户无需手动启动命令行、查找本地端口或管理运行目录。

EzDSH 不重新实现 Harness 的 Agent 能力，而是解决以下桌面产品问题：

- 安装后可以直接启动；
- 没有模型供应商时可以完成首次配置；
- Harness 启动失败时能看到原因并恢复；
- 用户数据在升级后继续保留；
- 应用更新不会破坏配置、Session 和 Plugin；
- 桌面窗口不能获得不必要的 Node.js 权限；
- DSH Runtime 与桌面版本之间有明确的兼容关系。

## 2. 产品目标

### 2.0 Runtime 交付原则

- EzDSH 默认使用固定版本的已发布 DSH npm 包；
- 当前锁定 `@deepseek-ai/dsh@0.1.0-rc.6`，并记录对应 lockfile；
- 发布安装包包含对应版本的 DSH Runtime；
- 用户不需要预先安装 DSH、Node.js 或 pnpm；
- 普通开发不读取本机全局 DSH；
- 本地 Runtime 源码只用于显式的开发联调模式；
- 应用更新可以替换 Runtime，但不得删除用户数据。

### 2.1 首个可交付版本

用户安装 EzDSH 后，可以完成以下闭环：

1. 启动 EzDSH；
2. EzDSH 创建自己的运行目录并启动 DSH Runtime；
3. 进入 Harness Web UI，由 DSH 自己负责模型供应商配置；
4. 关闭应用时自动停止 Runtime；
5. 下次启动时恢复配置和历史数据；
6. 检查新版本并在用户确认后完成应用内更新。

EzDSH 自己的供应商配置页面暂缓到后续版本。当前版本保留 Provider Service、凭据边界和 IPC 合约，但不在 Renderer 中展示该配置入口，优先保证 Runtime 启动和应用发布链路稳定。

### 2.2 非目标

首个版本不包含以下能力：

- 重写 Harness 的 Agent Runtime；
- 自建模型推理服务；
- 独立替换正在运行的 DSH Runtime；
- 云端同步用户 Session；
- 团队协作后台；
- 在 Renderer 中直接保存 API Key；
- 支持 Windows ARM64。

## 3. 核心用户流程

### 3.1 正常启动

```text
启动 EzDSH
  ↓
获取 userData 路径
  ↓
创建 launch-root、harness 和 logs 目录
  ↓
读取本地配置状态
  ↓
启动 DSH Runtime
  ↓
等待本地健康检查通过
  ↓
加载 Harness Web UI
```

### 3.2 没有模型供应商时

当本地没有任何可用模型供应商时，EzDSH 仍然启动 DSH Runtime 并进入 Harness Web UI，由 DSH 自己提示和处理供应商配置。EzDSH 当前不显示独立的模型供应商配置页面。

```text
启动 EzDSH
  ↓
启动 DSH Runtime
  ↓
加载 Harness Web UI
  ↓
由 DSH Web UI 配置模型供应商
```

页面要求：

- 页面标题明确说明正在配置模型供应商，但不暗示 Runtime 必须依赖配置才能启动；
- 展示内置供应商卡片；
- 每个供应商显示名称、API 地址说明和 Key 输入框；
- API Key 默认以密码形式显示，并支持临时查看；
- 提供连接测试、保存并继续、退出应用三个动作；
- 连接测试失败时保留输入内容，但不得将 Key 写入普通日志；
- 保存成功后只能通过主进程调用 Harness 的 Credentials / Settings 能力；
- Renderer 不直接访问 Node.js 文件系统或系统 Keychain；
- 如果用户暂时不配置，允许进入 Runtime 图形界面，但模型相关操作必须明确提示未完成配置；
- 如果本地存在配置但没有可用供应商，也必须重新显示该页面；用户仍然可以再次跳过。

首批供应商配置采用数据驱动方式，初始集合为：

- DeepSeek
- OpenAI
- Anthropic
- Google Gemini
- Moonshot / Kimi
- MiniMax
- 智谱 GLM
- Mistral AI
- OpenRouter
- Groq
- Together AI

供应商清单、默认 API 地址、凭据字段和模型目录不得散落在多个 UI 组件中，应集中定义为可测试的 Provider Definition。

### 3.3 Harness 启动失败

启动失败时不得只显示空白窗口。必须显示：

- 简短错误标题；
- 用户可理解的错误原因；
- 运行目录；
- 查看日志按钮；
- 重试按钮；
- 退出按钮。

### 3.4 应用更新

EzDSH 更新采用整包更新：新的 EzDSH 安装包内携带对应版本的 DSH Runtime。下载更新时不能覆盖用户数据目录。

```text
检查更新
  ↓
发现新版本
  ↓
用户确认下载
  ↓
后台下载并校验签名/哈希
  ↓
提示重启
  ↓
停止 DSH Runtime
  ↓
退出并安装新版本
  ↓
重新启动并执行数据兼容检查
```

## 4. 功能需求

### 4.1 桌面生命周期

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| APP-001 | 单实例运行 | 第二次启动不会创建第二个 Runtime，已有窗口被唤醒 |
| APP-002 | 自动启动 Runtime | 应用 ready 后自动启动 DSH Runtime |
| APP-003 | 随机回环端口 | Runtime 只监听 `127.0.0.1`，每次启动端口可动态分配 |
| APP-004 | 优雅退出 | 应用退出前停止 Runtime，不能留下孤儿进程 |
| APP-005 | 启动恢复 | 已有运行目录、配置和 Session 不因重启丢失 |

### 4.2 模型供应商配置

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| MOD-001 | 空配置引导 | 没有可用供应商时自动显示配置页面 |
| MOD-002 | 连接测试 | 测试结果显示成功、失败原因和重试入口 |
| MOD-003 | 安全存储 | API Key 不写入 Renderer 本地存储、URL 或普通日志 |
| MOD-004 | 配置恢复 | 重启后能读取供应商状态，不重复要求输入 Key |
| MOD-005 | 失效重引导 | 所有供应商失效时重新显示配置页面 |
| MOD-006 | 供应商数据驱动 | 新增供应商只需新增定义和测试，不复制整套页面逻辑 |

### 4.3 运行恢复

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| RUN-001 | 健康检查 | 只有健康检查通过后才加载 Harness URL |
| RUN-002 | 日志文件 | Runtime stdout/stderr 写入独立日志文件 |
| RUN-003 | 重试 | 失败后可以不重启 EzDSH，只重启 Runtime |
| RUN-004 | 日志入口 | 用户可以从菜单或错误页面打开日志位置 |
| RUN-005 | 启动超时 | 超时后显示可操作错误，不无限等待 |
| RUN-006 | 端口冲突恢复 | 端口被占用时按端口号递增并重新启动新的 Runtime，最多尝试 21 个连续端口 |

### 4.4 应用更新

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| UPD-001 | 手动检查 | 菜单中可以主动检查更新 |
| UPD-002 | 定期检查 | 应用启动后检查，并在固定间隔再次检查 |
| UPD-003 | 后台下载 | 用户确认后下载，不阻塞 Harness 页面 |
| UPD-004 | 下载进度 | 页面显示进度、速度和剩余状态 |
| UPD-005 | 重启安装 | 下载完成后由用户决定何时重启安装 |
| UPD-006 | 数据保护 | 更新过程不删除 `userData` 下的用户目录 |
| UPD-007 | 失败恢复 | 更新失败时保留当前可运行版本，并记录可诊断错误 |

## 5. 数据目录约定

所有目录都必须通过 Electron 的系统路径 API 计算，不得硬编码用户主目录。

```text
<userData>/
├── launch-root/       # Harness 默认启动工作目录
├── harness/           # Harness 配置、profiles、sessions、plugins
├── logs/
│   └── harness.log    # Runtime 日志
├── state/
│   ├── app-state.json # EzDSH 自身状态，不含 API Key
│   └── update-state.json
└── backups/           # 配置迁移前的本地备份
```

API Key 必须由 Harness Credentials 能力或操作系统安全存储处理。`app-state.json` 只能保存供应商 ID、路由 ID、配置状态和版本信息。

## 6. 版本与兼容策略

应用版本和 Runtime 版本分别记录：

```text
EzDSHVersion: 0.8.1505
dshRuntimeVersion: 0.1.0-rc.6
dataSchemaVersion: 1
```

启动时执行以下检查：

1. 读取当前应用版本和内置 Runtime 版本；
2. 检查用户数据 schema 版本；
3. 必要时先备份再迁移；
4. 检查当前 patch 与 Runtime 版本是否匹配；
5. 失败时阻止进入主界面并提供恢复选项。

## 7. 安全要求

- `contextIsolation: true`；
- `sandbox: true`；
- `nodeIntegration: false`；
- Renderer 只通过受限 IPC 调用主进程能力；
- 只允许加载本机预期的 Harness URL；
- 不允许任意外部页面获得应用级 IPC；
- API Key 不出现在日志、错误弹窗、URL、分析事件和截图数据中；
- 所有文件和 Shell 高风险操作由 Harness 的权限机制负责；
- 发布包必须使用平台签名，自动更新必须验证更新包来源。

## 8. MVP 验收清单

- [ ] 空白配置启动时显示模型供应商配置页面
- [ ] 至少一个供应商可以成功保存并完成连接测试
- [ ] 配置失败不会导致应用白屏或崩溃
- [ ] DSH Runtime 可以自动启动、健康检查和退出
- [ ] 用户数据目录在重启后仍然存在
- [ ] Runtime 失败时可以查看日志并重试
- [ ] Renderer 没有 Node.js 直接访问能力
- [ ] 打包版本可以检查更新并完成一次测试升级
- [ ] 新版本升级后供应商配置、Session 和 Plugin 未被删除
