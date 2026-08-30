# EzDSH 产品需求文档

## 1. 产品定义

EzDSH 是 DeepSeek Harness 的桌面发行版，也是一套以工作流为核心的自动化平台。用户可以把固定重复流程和多岗位复杂协作编排成可运行、可检查、可恢复的工作流。

围绕这个定位，EzDSH 负责把 DeepSeek Harness 的能力整理成普通用户可以直接使用的工作体验，重点解决以下问题：

- 安装后可以直接启动；
- 没有模型供应商时可以完成首次配置；
- Harness 启动失败时能看到原因并恢复；
- 用户数据在升级后继续保留；
- 应用更新不会破坏配置、Session 和 Plugin；
- 升级失败时可以恢复上一份用户环境；
- 桌面窗口不能获得不必要的 Node.js 权限；
- DSH Runtime 与桌面版本之间有明确的兼容关系。

## 2. 产品目标

### 2.0 Runtime 交付原则

- EzDSH 默认使用固定版本的已发布 DSH npm 包；
- 当前锁定 `@deepseek-ai/dsh@0.1.1-rc.2`，并记录对应 lockfile；
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
升级前创建 Session/Settings/Plugin/Presets/Runtime 版本快照
  ↓
停止 DSH Runtime
  ↓
退出并安装新版本
  ↓
重新启动并执行数据兼容检查；失败时进入 Recovery Mode
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
| UPD-007 | 失败恢复 | 更新失败时保留用户数据快照，进入 Recovery Mode，并提供恢复上一份环境、重试 Runtime 和打开备份目录 |
| UPD-008 | 升级前清单 | 安装前显示 Sessions、Settings、Plugin、Presets 和当前 Runtime 版本已纳入快照流程 |

### 4.5 备份与恢复

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| REC-001 | 手动快照 | 设置页可以创建包含 `harness/` 与 `state/` 的带 manifest、SHA-256 和插件清单的快照 |
| REC-002 | Credential 脱敏 | `.credentials.yaml`、`.env` 等明文 Credential 不进入 Archive，只进入本机受限 vault |
| REC-003 | 安全恢复 | 恢复前必须通过 checksum 和 archive path 校验；dry-run 不改写现有用户数据 |
| REC-004 | 原子恢复 | 恢复使用 staging 和目录替换，失败时回滚，并先保留 `pre-restore` 快照 |
| REC-005 | 升级事务 | 升级前写入 pending transaction；新 Runtime 健康后清除，启动失败则展示 Recovery Mode |
| REC-006 | Session Log doctor | 默认只读诊断 Session Log；只有用户明确操作时才修复最后一条未完成 JSONL 尾记录 |
| REC-007 | 独立救援 | 备份目录包含不依赖 Electron/DSH 的 rescue CLI 与 loopback Web UI，可执行 list、verify、doctor、restore |
| REC-008 | 快照管理 | 设置页独立的“备份与恢复”导航可以校验、恢复或删除快照；删除会连同 sidecar 和本机 vault 一起清理，并保护活动恢复事务 |

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
└── backups/           # 手动、升级前和恢复前快照
    ├── ezdsh-pre-update-*.tar.gz
    ├── *.sha256
    ├── *.manifest.json
    ├── vault/          # 受限 Credential 明文，不进入 Archive
    └── rescue.mjs      # 不依赖 DSH 的独立救援通道
```

API Key 必须由 Harness Credentials 能力或操作系统安全存储处理。`app-state.json` 只能保存供应商 ID、路由 ID、配置状态和版本信息。

## 6. 版本与兼容策略

应用版本和 Runtime 版本分别记录：

```text
EzDSHVersion: 0.8.1505
dshRuntimeVersion: 0.1.1-rc.2
dataSchemaVersion: 1
```

启动时执行以下检查：

1. 读取当前应用版本和内置 Runtime 版本；
2. 检查用户数据 schema 版本；
3. 必要时先备份再迁移；
4. 检查当前 patch 与 Runtime 版本是否匹配；
5. 读取升级事务；
6. 失败时阻止进入主界面并提供恢复选项。

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
- [ ] 可以创建快照、验证 checksum，并在 dry-run 后恢复到上一份用户环境
- [ ] Credential 明文不在 Archive 中，换机恢复会提示重新输入
- [ ] Runtime 启动失败会进入 Recovery Mode，独立 rescue 通道可以列出并校验快照

## 9. Workflow 编排、智能处理与专业员工

EZDSH 提供独立的 Workflow 页面，用 React Flow 编辑可持久化的 DAG。核心概念定义为：

```text
工作流 = 事情如何完成
专业员工 = 哪个岗位对专业环节负责
智能处理 = 当前流程中的轻量临时推理
技能 = 员工或节点可以调用的原子能力
任务 = 一次业务请求
运行 = 任务执行产生的技术记录
```

用户可以创建、复制、删除、拖拽和连线，并在节点检查器中配置 Input、智能处理、专业员工、Skill、MCP、Parallel、Loop、Condition、Approval、Transform、Output、Shell 和 File 节点。轻量需求可直接使用智能处理，不要求所有模型调用都包装成员工。

### 9.1 运行闭环

```text
编辑 JSON-safe Workflow
  ↓ Main 校验并保存 revision
输入任务并明确授权高风险节点
  ↓
创建运行记录 → 逐节点执行 → 每步 checkpoint
  ↓                         ↘
完成/输出                 失败/暂停 → 恢复
```

运行记录保存在 `<userData>/state/workflow-runs.json`，工作流定义保存在 `<userData>/state/workflows.json`，因此被现有 Recovery 快照的 `state/` 覆盖。应用重启不会静默丢失运行：未完成记录会显示为“已暂停”，用户可以从最后一个未完成节点重试。

### 9.2 安全与 AI 生成

- Renderer 不能读取工作区路径、Credential 或执行权限；所有操作经过 typed Preload IPC。
- Workflow 文档不允许任意 JavaScript、`eval`、凭据字段或无效节点/连线；循环图会在保存和运行前被拒绝。
- Shell/File 需要每次运行显式授权；File 只能访问当前工作区内的相对路径，Shell 不使用 shell 解释器。
- AI 只生成草稿 JSON，经过 normalize、Schema 校验和人工审阅后才能保存或运行。
- 智能处理、专业员工、Skill、MCP 节点复用 DSH Runtime 的 Session API，不在 EZDSH 中重复实现模型调用和工具权限系统。
- 智能处理和专业员工节点可以输出文本或 JSON；无效 JSON 会在同一 Session 中修复一次。

### 9.3 专业员工与兼容迁移

专业员工是一份可复用的岗位档案，包含业务边界、工作原则、执行规范、质量标准、能力、技能 ID 和档案版本。员工不拥有内部工作流；同一员工可以被多个工作流引用。旧 Employee 的启用步骤会迁移为非执行性的执行规范，旧 Workflow 的 `agent` 节点会迁移为 `ai-task`。

### 9.4 短视频内容运营 V1

系统内置“短视频内容运营”模板：内容需求依次经过选题策划、资料调研、脚本文案、内容审核和人工审批，最终形成待制作内容成果。四个专业员工环节使用 JSON 交接。

当前 V1 只支持手动运行和人工审批，不包含定时执行、持久后台 Worker、外部平台自动发布、员工长期记忆或 EZDSH 自我升级。后续无人值守能力必须建立在工作流发布、不可变版本、任务队列、权限预算、告警、重试补偿和幂等机制之上。
