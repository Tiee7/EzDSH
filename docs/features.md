# EzDSH 功能特性文档

> 本文基于当前代码、产品文档和运行时配置整理，描述 EzDSH 当前版本（`1.8.1555`）的功能边界。EzDSH 是面向 macOS 与 Windows 的 DeepSeek Harness 桌面发行版；DeepSeek Harness 负责模型调用、Agent Runtime、工具执行和工作区 Web UI，EzDSH 负责桌面宿主、生命周期、配置、安全、扩展和发布体验。

## 1. 产品定位

EzDSH 将 DeepSeek Harness 封装为开箱即用的本地 AI 工作入口，核心价值是：

- 无需用户预先安装 Node.js、pnpm 或 Harness CLI；
- 自动启动、监控和关闭内置 DSH Runtime；
- 将工作流、专业员工、技能和 MCP 扩展组织成可管理的 AI 工作团队；
- 让 API Key、Session、Profile、Plugin、工作流和日志留在本机；
- 在更新、插件故障或 Runtime 启动失败时提供快照、恢复和安全模式；
- 通过飞书和手机浏览器提供受控的远程操作入口。

## 2. 用户界面与导航

### 2.1 顶层页面

默认导航包含以下页面：

| 页面 | 功能 |
| --- | --- |
| Harness | 加载本机 DSH Runtime 的 Harness Web UI，使用真实工作区和 Session |
| Workflow | 创建、编辑、导入、导出、生成、运行和观测工作流 |
| Store | 浏览并安装 Skill、DSH Plugin、MCP；查看已安装项目；运行 DSH 命令 |
| Presets | 浏览工作流/能力预设内容 |
| Docs | 在应用内阅读项目文档 |
| Employees | 管理可复用的专业员工档案，并测试员工任务 |
| Settings | 管理 Runtime、供应商、工作区、更新、恢复、远程控制等设置 |

`Workflow` 与 `Employees` 默认属于开发者模式页面；设置中可通过连续点击 About 入口启用开发者模式。导航支持排序、显示/隐藏（核心页不可隐藏）、键盘快捷键，以及添加受控的自定义 HTTP/HTTPS 页面。

### 2.2 多语言与外观

- 支持简体中文和 English；
- 语言偏好与 Harness 共用 `harness/settings.yaml`，外层界面、应用菜单和 Runtime UI 保持同步；
- 支持跟随系统深色/浅色外观；
- 应用内置通知音效开关及通知类型设置；
- 支持 macOS 与 Windows 桌面窗口体验。

## 3. DSH Runtime 桌面托管

### 3.1 启动与生命周期

EzDSH 内置并固定使用 DSH Runtime（当前依赖版本 `@deepseek-ai/dsh@0.1.5-rc.2`，正式包使用构建后的 vendored Runtime），不依赖用户 PATH 中的全局 DSH。

启动流程：

1. 计算 Electron `userData` 目录；
2. 创建 `launch-root`、`harness`、`workflow`、`logs` 等目录；
3. 分配本机回环端口；
4. 启动内置 Runtime 子进程；
5. 收集 stdout/stderr 到日志；
6. 健康检查通过后加载 Harness UI；
7. 应用退出时优雅停止 Runtime，超时后再强制终止。

支持的运行能力：

- Runtime 状态展示：空闲、启动中、就绪、停止中、已停止、失败；
- PID、端口、启动时间、运行目录和日志路径查看；
- 端口占用时按连续端口重试，最多 21 次；
- 启动超时、异常退出和崩溃检测；
- Runtime 单独重启；
- 进程所有权记录，减少孤儿进程；
- Runtime 实例列表，可停止异常残留进程；
- 正常模式和不加载第三方插件的 Safe Mode；
- 独立的 Runtime 视图控制和 Session 打开能力。

Runtime 只监听 `127.0.0.1`，不会直接暴露到局域网。

### 3.2 启动失败处理

启动失败不会停留在白屏，而会显示错误原因、运行目录、日志入口、重试和退出操作。若检测到插件导致 Runtime 失败，可进入恢复界面、回滚待处理插件或禁用指定插件。

## 4. 模型供应商与代理

### 4.1 Provider 管理

设置页支持供应商状态、凭据、模型和 Provider Profile 管理。供应商定义采用数据驱动方式，覆盖内置供应商、聚合服务和推理服务类别，首批包括：

- DeepSeek、OpenAI、Anthropic、Google Gemini；
- Moonshot / Kimi、Kimi Code、MiniMax、智谱 GLM、Mistral AI；
- OpenRouter、Groq、Together AI、火山引擎（Volcengine）。

可用操作包括：

- 查看供应商定义和当前可用状态；
- 测试连接并显示可读错误；
- 保存或删除供应商配置；
- 列出供应商模型；
- 管理工作流可用模型和模型选择。

API Key 通过主进程处理，不进入 Renderer Local Storage、URL、普通日志或错误截图；凭据文件使用受限权限保存。

### 4.2 网络代理

代理设置支持：

- 创建、编辑和删除代理 Profile；
- 激活指定代理或关闭代理；
- 代理连接测试；
- 代理配置状态查看。

## 5. 工作区与数据管理

### 5.1 工作区

- 显示当前 Workflow 工作区路径；
- 通过系统目录选择器选择新位置；
- 在“切换工作区”和“迁移工作区”之间选择；
- 执行工作区操作时显示状态和错误；
- 开发模式默认使用隔离的数据命名空间，避免与正式版争用配置和 Runtime。

### 5.2 数据目录

```text
<userData>/
├── launch-root/       # Runtime 启动目录
├── harness/           # Harness 配置、Profile、Session、Plugin
├── workflow/          # Workflow 节点 File/Shell/Code 的工作目录
├── logs/              # Runtime 与外部服务日志
├── state/             # EzDSH 状态、工作流、更新和远程配置
└── backups/           # 手动、更新前和恢复前快照
```

升级只替换应用代码和内置 Runtime，不删除用户配置、Session、Profile、Plugin、工作流和日志。

## 6. Store 扩展商店

Store 提供统一的扩展发现、审计和安装体验，当前包含：

- **Skills**：可复用的原子能力；
- **DSH Plugins**：Runtime/Workspace 插件；
- **MCP**：结构化外部工具扩展；
- **已安装**：查看已安装记录、版本、启用状态和更新；
- **运行 DSH 命令**：在受控面板中执行 DSH CLI 命令。

商店能力包括：

- 按分类、关键词和分页浏览；
- 查看详情、Markdown 说明、版本和安装状态；
- 安装、更新、卸载和启用/禁用；
- 安装前安全审计，展示审计等级、发现项和外部 URL；
- 对高风险项目提供确认或“仍然安装”流程；
- 安装失败时提供诊断编码、技术详情和日志路径；
- 支持 `ezdsh:` Deep Link 直接定位安装目标；
- 安装后校验目标 Profile 是否正确接入；
- 插件兼容性修复和安装注册表记录。

商店不会自动下载或执行外部服务定义；外部命令必须由用户明确配置。当前仓库还包含可通过插件分发的渠道适配器，例如飞书、QQ（依赖外部 OneBot 11 服务）和企业微信（依赖自建应用及公网回调），具体可用性取决于插件安装和外部服务配置。

## 7. 工作流自动化

Workflow 是 EzDSH 的核心编排能力。工作流使用版本化 JSON Schema v2 和 React Flow DAG 编辑器，定义“事情如何完成”；一次运行记录定义“这次执行发生了什么”。

### 7.1 编辑与生成

- 新建、复制、编辑、删除和启用/停用工作流；
- React Flow 画布拖拽、连线、节点检查器和自动排版；
- 导入/导出版本化 JSON；
- 保存 revision、描述、生成提示词和运行元数据；
- AI 根据自然语言生成工作流草稿；
- AI 修改现有工作流，提供删除清单和变更预览；
- 保存生成/修改阶段事件、模型和 checkpoint；
- 网络、格式错误或重启后支持“从断点继续”；
- 生成结果必须经过 normalize、Schema 校验和人工确认后才能保存或运行。

### 7.2 支持的节点

| 节点 | 用途 |
| --- | --- |
| Input | 接收单值或多字段启动参数 |
| AI Task | 执行一次轻量模型处理，可输出 text 或 JSON |
| Structured Extract | 按 JSON Schema 做结构化抽取并有限重试 |
| Employee | 调用专业员工档案 |
| Skill | 调用指定技能 |
| MCP | 调用明确的 MCP 工具 |
| Parallel | 在一个节点内并行处理多个相似输入 |
| Loop | 对输入集合执行线性循环体 |
| Condition / Switch | 条件分支或精确值路由 |
| Approval / Wait Input | 等待人工批准、拒绝或输入 |
| Sub-workflow | 调用另一个已保存工作流 |
| Object Builder | 从常量和绑定变量构造嵌套 JSON |
| List Operator | 过滤、映射、取字段、排序、去重、切片、分组和聚合 |
| Merge | 合并多个输入值、对象、列表或键值集合 |
| Transform / Text Merge | 确定性文本、JSON、替换和模板拼接 |
| Output | 输出单值、多值对象或模板文本 |
| Shell | 执行受控命令，运行时需显式授权 |
| File | 在 Workflow 根目录内读写、列目录、读取元数据和提取文本 |
| HTTP | 调用托管 HTTPS Connector；生产环境禁用未托管的旧式原始 URL 调用 |
| Code | 在独立 Node.js/Python3 子进程执行，需显式授权并受超时限制 |

工作流节点只交换 JSON-safe 数据；二进制大对象应使用未来的 Artifact 引用能力，而不是直接塞入 JSON。

### 7.3 运行与可靠性

- 手动启动工作流并填写启动参数；
- 本地持久队列和单 Worker；
- 逐节点状态、输入、输出、错误、耗时和事件记录；
- 运行取消、暂停、恢复和人工审批；
- 有上限的确定性节点重试；
- 托管 HTTP 写请求支持显式幂等模式和稳定 Idempotency-Key；
- 支持显式幂等键去重；
- 支持定义明确的补偿 Workflow；
- 应用重启后回收旧租约；含不确定外部副作用的运行暂停并要求人工核对，不静默重放；
- 可删除、查看和筛选运行记录。

### 7.4 发布、环境与观测

- 创建本地客户环境；
- 将当前工作流固化为不可变 release snapshot；
- 发布到客户环境并启动已发布版本；
- 查看发布版本、状态和内容 SHA-256；
- 对已发布版本执行回滚；
- 查看脱敏观测事件；
- 查看环境健康状态和失败原因。

Renderer 只接收发布摘要、环境摘要和脱敏观测；运行载荷、凭证明文、原始响应和不可变快照保留在主进程本地存储。

## 8. 专业员工

专业员工是可复用、可治理、可版本化的岗位档案，不是隐藏的内部工作流，也不等同于模型进程。

档案支持：

- 个人名字 `displayName`、正式岗位 `role` 和旧版兼容字段 `name`；
- 职责描述、业务边界和系统提示词；
- 执行规范和质量标准；
- 能力标签：研究、文案、图像生成、文件读取、文件写入、工作流；
- 关联 Skill ID；
- 启用/停用和档案版本；
- AI 生成档案或手动创建/编辑；
- 从项目中选择 Session 执行“测试员工”；
- Session 锁、刷新、创建新 Session 和强制解锁；
- 旧版 Employee 数据自动迁移到档案 V2；
- 将员工导入为工作流起点。

员工本身不自动获得所有工具或外部平台权限；权限来自节点授权、技能和工作流环境配置。

## 9. 远程控制

### 9.1 飞书 Channel Bridge

EzDSH 通过飞书官方 SDK 的 WebSocket 长连接接收消息，不需要公网 Webhook、ngrok 或本地入站端口。

功能包括：

- 配置飞书 App ID、App Secret 和可选 Encrypt Key；
- 使用 6 位验证码配对用户，验证码 5 分钟过期；
- 维护允许执行命令的 open_id 白名单；
- 指定已有 DSH Session，或首次使用时创建 Session；
- 从私聊或群聊接收任务；
- 异步执行长任务并发送确认、进度和最终结果；
- 与桌面 GUI 共享目标 Session 状态；
- 查看、选择、归档、恢复或删除远程 Session；
- 配置单次执行超时和进度更新间隔。

白名单用户可以执行该 DSH Session 具备的能力，因此必须只添加可信用户。

### 9.2 手机浏览器 Remote

桌面端启动受控 Mobile Remote 服务，手机不直接访问 DSH Runtime 端口。

功能包括：

- 生成局域网配对二维码和链接；
- 桌面端明确批准或拒绝设备；
- 查看已配对设备并断开设备；
- 手机端查看工作区、最近 Session、历史记录和创建 Session；
- 发送任务、实时接收事件流、断线后读取最新历史；
- 在手机端取消运行中的会话；
- 通过 Cloudflared 可选建立临时 HTTPS 公网地址；
- 配对链接 5 分钟过期，设备默认 30 天无操作过期。

公网访问只开放受控的手机会话 API，并带有 Origin 检查、CSP、`HttpOnly`/`SameSite=Strict` Cookie 等安全措施。

## 10. 外部 API 与 Deep Link

EzDSH 提供仅监听回环地址的本地 External API，默认地址为 `127.0.0.1:53260`（可通过 `EZDSH_EXTERNAL_API_PORT` 调整）。外部工具可调用：

- 健康检查；
- 项目、工作区和 Session 查询；
- 向 Session 投递 Prompt；
- 异步运行查询、SSE 事件流和取消运行；
- 使用 `ezdsh://session` Deep Link 打开指定 Session。

请求体有大小限制，API 不把 Runtime 端口直接暴露到局域网。桌面端同时支持 `ezdsh:` Deep Link 定位商店安装目标。

> **安全边界：** External API 当前仅绑定回环地址，未设置独立 Token/API Key；因此本机上能访问该端口的进程可驱动 DSH。不要将端口转发到局域网或公网。

## 11. 外部服务管理

Settings → External services 可管理用户自己的本地进程：

- 添加、编辑和删除服务；
- 配置可执行文件、参数、工作目录和环境变量；
- 设置是否随 EzDSH 自动启动；
- 手动 Start、Stop、Restart；
- 查看运行状态、退出状态和独立日志；
- 应用退出或安装更新前自动停止受管进程；
- 外部服务启动失败不会让 DSH Runtime 启动流程失败。

命令使用“可执行文件 + 参数数组”启动，默认不启用 Shell 解析。外部命令继承当前用户权限，只应添加用户信任的程序。

## 12. 更新、快照与恢复

### 11.1 应用内更新

- 启动后和固定间隔自动检查更新；
- 设置或菜单中手动检查；
- 显示版本、下载进度、速度和状态；
- 后台下载，下载完成后由用户决定何时安装；
- 整包更新，更新包携带对应 DSH Runtime；
- macOS 生成 DMG/ZIP，Windows 生成 NSIS 安装程序；
- 正式版本支持签名、公证和 generic 更新源；
- beta/preview 与 stable 使用不同更新通道；
- 安装前停止 Runtime 并写入升级事务；
- 新版本启动后执行数据 Schema 和 Runtime 兼容检查。

### 11.2 备份与恢复

Recovery 页面支持：

- 创建带 manifest、插件清单和 SHA-256 的用户快照；
- 快照列表、备注、校验和删除；
- dry-run 恢复预览；
- staging + 原子目录替换恢复；
- 恢复前生成 `pre-restore` 快照并支持失败回滚；
- Session Log doctor 只读诊断，可在明确操作后修复未完成 JSONL 尾记录；
- 升级前快照覆盖 Session、Settings、Plugin、Presets 和 Runtime 版本信息；
- Credential 明文不进入 Archive，只存放在本机受限 vault；
- 独立 rescue CLI 和 loopback Web UI 支持 list、verify、doctor、restore。

### 11.3 Safe Mode

Runtime 启动异常或插件变更造成故障时，可进入 Safe Mode：

- 不加载第三方插件；
- 在 Runtime 不可用时仍可打开恢复界面；
- 重试正常启动；
- 回滚或禁用引发问题的插件；
- 选择快照恢复；
- 打开备份目录和日志；
- 恢复成功后退出 Safe Mode。

## 13. 安全与隐私

- Electron 使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；
- Renderer 只能通过 typed Preload IPC 调用主进程；
- Renderer 不接触 Node.js、文件系统、任意命令执行和凭据文件；
- Runtime 默认只监听 `127.0.0.1`；
- API Key 不写入普通日志、URL、错误信息、工作流 JSON 或运行记录；
- 工作流 File 只能访问 Workflow 工作目录；
- Shell、File、Code 和外部副作用需要明确授权；
- HTTP 连接器限制 HTTPS 来源、路径前缀、Credential scope、工作流权限和单次运行授权；
- Plugin 安装有审计、兼容性检查和恢复快照；
- 更新包通过签名/来源校验，应用升级不覆盖用户数据；
- 飞书远程控制使用白名单；手机 Remote 使用配对批准、受限 API 和安全 Cookie。

### 13.1 远程能力使用注意事项

- 飞书白名单用户原则上可以执行目标 DSH Session 能执行的操作，应只允许可信用户；
- 飞书配对码只适合在本机受信日志和界面中短暂使用，启用远程控制前应检查配置与日志；
- 手机公网访问依赖临时隧道，关闭后应重新生成配对二维码，不应转发二维码或链接；
- External API 和 Mobile Remote 都不应通过路由器端口转发长期暴露；
- 外部服务、Shell、Code、File 和插件均以用户权限运行或影响本地数据，安装和执行前应确认来源；
- 渠道插件可能记录发送者、聊天内容或 Prompt，QQ 等适配器的连接信息/Token 需按敏感配置管理；
- 企业微信适配器需要额外审查监听地址、请求体限制和 XML 内容转义，不能把公网回调服务直接视为默认安全。

## 14. 当前明确不包含的能力

以下能力目前不应被描述为已实现：

- 定时触发、Webhook、邮件或 Git 事件触发工作流；
- 24 小时常驻后台 Worker 或分布式 Worker；
- 通用工作流事务回滚和自动推断补偿；
- 任意 OR/race 汇聚、图结构循环和全局隐式上下文；
- JSON Schema 映射和完整 Artifact 管理；
- 预算告警和通用外部副作用自动重试；
- 员工长期记忆、候选经验、评估和自动升级；
- 外部平台自动发布；
- Windows ARM64；
- 使用 EzDSH 自动修改或升级 EzDSH 自身。

## 15. 主要技术与发布入口

```bash
npm run dev                 # 本地开发
npm run typecheck           # TypeScript 检查
npm test                    # 测试
npm run package:mac         # macOS 打包
npm run package:mac:release # macOS 签名/公证发布包
npm run package:win         # Windows 打包
npm run package:win:release # Windows 签名发布包
```

核心实现位置：

- `src/main/index.ts`：Electron 主进程、IPC 注册和服务编排；
- `src/main/runtime/`：Runtime 生命周期、健康检查、Safe Mode；
- `src/main/workflow/`：工作流存储、生成、运行、连接器、发布和观测；
- `src/main/recovery/`：快照、校验、恢复和插件故障处理；
- `src/main/store/`：商店目录、审计、安装和兼容性；
- `src/main/channel-bridge/`、`src/main/mobile/`：远程控制；
- `src/renderer/`：导航、工作流、员工、商店、设置和恢复界面；
- `docs/`：产品需求、架构、工作流 Schema、发布和远程控制规范。

## 15. 功能状态说明

本文将“当前代码中已有入口或服务”视为已实现能力，将产品规划文档中明确列出的未来项视为未实现。由于 EzDSH 与 DeepSeek Harness Runtime 紧密协作，某些模型、工具和 Web UI 体验由 Runtime 提供，不属于 EzDSH 自行实现；版本升级时应同时核对 EzDSH 版本、Dsh Runtime 版本和数据 Schema 版本。
