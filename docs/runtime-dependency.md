# DSH Runtime 依赖关系

## 1. 结论

EzDSH 不依赖用户电脑上预先安装的 DSH，也不把用户本机的安装路径当作生产运行条件。

## 1.1 首次锁定记录

首次开发锁定以下上游状态：

```text
Upstream repository: https://github.com/deepseek-ai/deepseek-harness
Upstream branch:    master
Runtime package:    @deepseek-ai/dsh
Runtime version:    0.1.0-rc.5
Source commit:      47f943859bef60e4160492346772ded9b24f765a
Release commit:     abe560f81edebe5f6a5b62706ff502daa0dccd40
Checked at:         2026-08-15
```

解释：`0.1.0-rc.5` 是当前可见的 DSH 发布版本；`47f9438…` 是当前 `master` 的最新合并提交，用于锁定仓库状态；`abe560f…` 是该版本的发布提交，用于追溯版本来源。项目依赖最终以 `package.json` 和 lockfile 中的精确版本为准，不能只依赖 `master` 分支。

EzDSH 项目自身通过上游源码子模块和固定 commit 完成 DSH Runtime 构建。打包时，构建后的 Runtime 代码和运行所需资源会进入 EzDSH 安装包；用户安装 EzDSH 后即可启动，不需要再手动安装 Node.js、执行命令或配置 DSH 路径。

当前 staging 流程使用上游 workspace 的 `pnpm deploy --legacy --filter @deepseek-ai/dsh --prod` 生成生产依赖闭包，再把 `apps/web/dist` 纳入同一目录。生产入口为 `out/dsh-runtime/lib/bin.js`，因此打包后不依赖开发目录中的 `apps/cli` 路径。

因此，三者关系如下：

```text
EzDSH 源码
├── Electron 图形界面代码
├── Renderer / Preload / Main Process
├── DSH Runtime 固定版本源码子模块
└── 版本锁定和构建配置
          │
          ▼
EzDSH 安装包
├── 图形界面
├── DSH Runtime
└── 运行所需依赖
          │
          ▼
用户电脑
├── EzDSH 安装目录：应用代码和 DSH Runtime
└── userData 目录：配置、凭据引用、Profile、Session、Plugin、日志
```

## 2. 项目如何包含 DSH Runtime

由于首个锁定版本尚未作为同版本 NPM 包发布，EzDSH 使用 Git 子模块保存上游源码快照。项目不复制修改上游源码，但会记录一份可复现的源码入口。项目包含的是：

- `vendor/deepseek-harness` Git 子模块；
- 子模块指向的完整 upstream commit；
- 上游 workspace 的 lockfile 和 pnpm 安装流程；
- 启动 Runtime 所需的入口路径和参数；
- 对固定版本 Runtime 的补丁文件（如果确实需要）；
- 针对 Runtime 启动、配置和升级的集成测试。

这意味着 EzDSH 的源码仓库与 DSH Runtime 源码仓库保持边界：EzDSH 负责宿主和集成，DSH Runtime 负责 Agent 能力与 Harness Web UI。

## 3. 本机已经安装的 DSH 有什么作用

### 3.1 普通开发模式

普通开发模式使用 `vendor/deepseek-harness` 子模块和其 workspace 依赖，不使用本机全局安装的 DSH。这样可以保证：

- 每位开发者使用同一个 Runtime commit；
- CI 使用同一个 Runtime 版本；
- 测试结果可复现；
- 打包结果不会因为本机环境不同而变化。

在这种模式下，不需要提供本机 DSH 的安装路径。开始开发前只需要确认目标 Runtime 的包名、版本和上游 commit 即可。

### 3.2 本地源码联调模式

如果需要修改 DSH Runtime 本身，或者验证尚未发布的 Runtime 版本，可以临时使用本地源码目录进行联调。此时本机路径才有用，建议通过明确的开发环境变量注入：

```text
EZDSH_DSH_SOURCE=/absolute/path/to/dsh-runtime
```

该变量只能在开发模式使用，不能被打包进生产配置，也不能让用户安装时依赖这个路径。

本地源码联调必须额外记录：

- 源码仓库的 commit；
- Node.js 版本；
- 包管理器和 lockfile 状态；
- 运行所需的原生模块；
- 与该版本对应的 EzDSH patch 和测试结果。

### 3.3 用户安装模式

用户安装模式只使用安装包内的 DSH Runtime。EzDSH 启动时应从自身资源目录定位 Runtime，不执行以下行为：

- 从 PATH 中寻找全局 `dsh`；
- 猜测用户主目录下的 DSH 位置；
- 自动使用另一份版本不明的 Runtime；
- 因为本机没有 Node.js 而无法启动。

如果内置 Runtime 缺失或校验失败，EzDSH 应显示安装包损坏或运行时不可用，并提供日志和重新安装入口。

## 4. 版本关系

EzDSH 版本和 DSH Runtime 版本分开记录，但发布时建立明确映射：

```text
EzDSH 0.1.0
└── DSH Runtime（由 lockfile 锁定）

EzDSH 0.2.0
└── DSH Runtime（由 lockfile 锁定，可能包含兼容补丁）
```

每次升级 Runtime 都必须：

1. 更新 `package.json` 和 lockfile；
2. 检查 Settings、Credentials、Provider 和启动入口的兼容性；
3. 重新生成或确认补丁；
4. 执行空供应商配置流程测试；
5. 执行真实 Runtime 启动、重启和退出测试；
6. 执行用户数据迁移和应用更新测试；
7. 在发布元数据中写入 EzDSH 与 Runtime 的版本映射。

## 5. 用户数据与 Runtime 代码的边界

应用升级可以替换安装目录中的代码和 Runtime，但不能删除用户数据：

```text
安装目录
├── EzDSH 主程序
├── Preload / Renderer
└── DSH Runtime

userData
├── harness/profiles
├── harness/sessions
├── harness/plugins
├── state
├── logs
└── backups
```

API Key 不应直接保存在 EzDSH 安装目录或普通状态 JSON 中。EzDSH 只保存供应商 ID、路由 ID、配置状态和版本信息，凭据交给 Harness Credentials 能力或操作系统安全存储。

## 6. 当前开发所需信息

开始项目骨架开发时，不需要先提供本机安装路径。需要确认的是：

1. 目标 DSH Runtime 包名；
2. 首个要锁定的 Runtime 版本；
3. 是否需要本地源码联调；
4. 如果需要联调，再提供源码目录和 commit。

默认开发路径采用“上游 Git 子模块 + pnpm workspace + 打包内置 Runtime”。EzDSH 根项目通过 `pnpm install` 安装自身依赖，并在 `postinstall` 阶段执行 `pnpm --dir vendor/deepseek-harness install --frozen-lockfile`。首个实现使用 `@deepseek-ai/dsh@0.1.0-rc.5` 对应的上游 commit，不请求不存在的同版本 NPM 包。

本机使用 `n` 切换 Node 版本是可以的；当前上游构建要求 Node `^22.19.0 || >=24.0.0`，开发环境还应使用 pnpm `11.7.0`。EzDSH 的 `pnpm install`、`pnpm run dsh:build` 和 `pnpm run stage:dsh-runtime` 都应在满足该版本要求的 Node 下执行。

根项目还声明了 Node/pnpm engines，并在 `postinstall` 前运行版本检查。若当前终端仍然指向旧 Node，脚本会直接提示使用 `n` 切换，而不会继续执行上游安装。
