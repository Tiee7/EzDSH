# DSH Runtime 依赖关系

## 1. 结论

EzDSH 不依赖用户电脑上预先安装的 DSH，也不把用户本机的安装路径当作生产运行条件。

## 1.1 当前发布包锁定记录

当前发布链路锁定以下 DSH 包状态：

```text
Runtime package:        @deepseek-ai/dsh
Runtime version:        0.1.5-rc.2
Source commit:          fb2c4b9e698e30edb738bca4cf0618587db7d203
Published npm package:  0.1.5-rc.2
Checked at:              2026-09-12
```

`0.1.5-rc.2` 是当前实际交付的 Runtime 版本：源码来自 `vendor/deepseek-harness`，并由 source pin、暂存目录和最终安装包的健康检查共同设为硬门禁。该版本同时已发布到 npm，根项目的 `@deepseek-ai/dsh` 及其 companion 依赖也统一锁定为 `0.1.5-rc.2`；正式安装包仍以 source-built Runtime 为权威。已有安装包不会因为仓库升级而被追溯更新，需要重新构建并发布新安装包。

项目依赖最终以 `package.json` 和 lockfile 中的精确版本为准。普通开发会优先使用已构建的 `vendor/deepseek-harness/apps/cli/lib/bin.js`；正式打包会将 source-built Runtime 暂存为 `out/dsh-runtime`，生产入口为 `out/dsh-runtime/lib/bin.js`，electron-builder 会把它随 `out/**/*` 放入安装包。若源码 Runtime 缺失，开发模式才回退到已发布 npm 包；正式验证会拒绝选中错误版本。

根项目通过 npm 精确锁定 `node-bin-darwin-arm64@24.18.0` 和 `pnpm@11.7.0`。二者安装在被 Git 忽略的 `node_modules` 中；Node 平台包及其完整性哈希直接记录在根 `package-lock.json`，不经过隐藏的二次安装。打包时仅把 Node 可执行文件和许可证复制到同样被忽略的 `out/node-runtime`，最终进入安装包。正式运行时，EzDSH 从 `Contents/Resources/app/out/node-runtime/bin/node` 启动 DSH，不读取系统 PATH，也不要求用户安装 Node、npm 或 pnpm。

因此，三者关系如下：

```text
EzDSH 源码
├── Electron 图形界面代码
├── Renderer / Preload / Main Process
├── 已发布 DSH Runtime npm 包
└── 版本锁定和构建配置
          │
          ▼
EzDSH 安装包
├── 图形界面
├── Node Runtime 24.18.0
├── DSH Runtime
└── 运行所需依赖
          │
          ▼
用户电脑
├── EzDSH 安装目录：应用代码和 DSH Runtime
└── userData 目录：配置、凭据引用、Profile、Session、Plugin、日志
```

## 2. 项目如何包含 DSH Runtime

当前发布链路使用 DSH 源码子模块构建 `0.1.5-rc.2`。该入口包含：

- `vendor/deepseek-harness` Git 子模块；
- 子模块指向的完整 upstream commit；
- 上游 workspace 的 lockfile 和 pnpm 安装流程；
- 启动 Runtime 所需的入口路径和参数；
- 对固定版本 Runtime 的补丁文件（如果确实需要）；
- 针对 Runtime 启动、配置和升级的集成测试。

这意味着 EzDSH 的源码仓库与 DSH Runtime 源码仓库保持边界：EzDSH 负责宿主和集成，DSH Runtime 负责 Agent 能力与 Harness Web UI。

## 3. 本机已经安装的 DSH 有什么作用

### 3.1 普通开发模式

普通开发模式优先使用仓库中已构建的 vendored DSH Runtime，不使用本机全局安装的 DSH。源码 checkout 必须同时满足 `0.1.5-rc.2` 版本和 `fb2c4b9e698e30edb738bca4cf0618587db7d203` commit 两个硬门禁；缺少源码构建产物时才回退到根项目中锁定的已发布 npm 包。这样可以保证：

- 每位开发者使用同一个 Runtime 包版本；
- CI 使用同一个 Runtime 版本；
- 测试结果可复现；
- 打包结果不会因为本机环境不同而变化。

在这种模式下，不需要提供本机 DSH 的安装路径。`npm run dev` 默认使用独立的开发数据目录和 Workspace 指针，不会读取或修改已安装正式版的 Runtime 数据。只有显式设置 `EZDSH_USE_PRODUCTION_DATA=1` 才会让开发版使用正式数据；该选项只用于有备份的兼容性排查。

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
└── DSH Runtime（由子模块 commit 与 Runtime 版本共同锁定）

EzDSH 0.2.0
└── DSH Runtime（由子模块 commit 与 Runtime 版本共同锁定，可能包含兼容补丁）
```

每次升级 Runtime 都必须：

1. 更新 vendored 子模块 gitlink、Runtime 版本 pin；若 npm 包 pin 也升级，再更新 `package.json` 和 lockfile；
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
├── workflow
├── state
├── logs
└── backups
```

API Key 不应直接保存在 EzDSH 安装目录或普通状态 JSON 中。EzDSH 只保存供应商 ID、路由 ID、配置状态和版本信息，凭据交给 Harness Credentials 能力或操作系统安全存储。

## 6. 当前开发所需信息

开始项目开发时，不需要先提供本机安装路径。默认只需要执行 `npm ci`。需要确认的是：

1. 目标 DSH Runtime 包名；
2. 首个要锁定的 Runtime 版本；
3. 是否需要本地源码联调；
4. 如果需要联调，再提供源码目录和 commit。

默认开发路径会在 `vendor/deepseek-harness` 存在并已构建时使用 `0.1.5-rc.2` 源码 Runtime；如果需要显式指定源码目录，仍可使用 `EZDSH_DSH_SOURCE`。`dsh:source:install`、`dsh:source:build` 和 `stage:dsh:source-runtime` 是正式打包所需的源码 Runtime 流程。

本项目使用 NVM 切换 Node 版本，仓库根目录的 `.nvmrc` 固定为 Node `24.18.0`；当前上游构建要求 Node `^22.19.0 || >=24.0.0`。进入项目后应先执行 `nvm use`，并确认当前终端的 `node -v` 实际为 `v24.18.0`。

根项目还声明了 Node/npm engines，并在 `postinstall` 前运行版本检查。若当前终端仍然指向旧 Node，脚本会直接提示使用 NVM 切换，而不会继续执行上游安装。

## 7. 可发布打包流程

发布操作的统一入口已整理到 [EzDSH 发布手册](./release-manual.md)。本节保留 Runtime 依赖与打包边界的技术说明；实际发布时请按发布手册的顺序执行，并以其中的版本、签名、公证和产物检查清单为准。

```bash
nvm use
node -v
npm ci
CI=true ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run package:mac
```

`prepare:package` 会校验 npm DSH 依赖、安装并构建 vendored `0.1.5-rc.2`、构建 EzDSH、暂存目标平台 Node Runtime，并执行真实健康检查。健康检查会用暂存的 Node 启动 `out/dsh-runtime/lib/bin.js`，并在无供应商配置的临时用户目录中请求 Web 页面；未通过时不会继续生成安装包。electron-builder 会把 source-built Runtime 随应用一起交付。

当前发布目标支持 macOS arm64 和 Windows x64。构建脚本会根据原生主机平台选择对应的内置 Node Runtime，并拒绝在其他平台上错误地混入原生依赖。Windows 打包必须在 Windows x64 runner 上执行；macOS arm64 打包必须在 macOS arm64 runner 上执行。Windows 原生打包流程已准备，但需要在对应 Windows 环境中完成首次构建验证后再作为正式发布链路使用。

本地 `package:mac` 可以生成未签名测试包。对外发布必须使用：

```bash
npm run package:mac:release
```

该命令要求 electron-builder 找到有效的 Developer ID，并强制在缺少签名时失败。签名使用 `CSC_LINK`、`CSC_KEY_PASSWORD` 等 CI Secret；公证推荐使用 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，也可使用 Apple ID 对应的三项环境变量。所有证书、私钥、密码和 API Key 都只能注入环境，不能提交 Git。

以下目录都是可重新生成的本地环境或产物，并由 `.gitignore` 排除：

- `node_modules/`
- `.pnpm-store/`
- `vendor/deepseek-harness/node_modules/`
- `out/`
- `dist/`

提交到 Git 的只有 npm 锁文件、构建脚本、上游子模块 commit 和应用源码，不提交 Node 二进制、依赖目录或打包产物。

## 8. 增量打包（避免重复下载）

首次准备完成后，如果只是想重新出包，pnpm 通常会复用已有 store，但 `prepare:package` 仍会执行 vendored DSH 的锁文件安装检查和源码构建，再暂存 Runtime 并执行健康检查。Electron 下载仍可能产生网络开销。

实际上这些东西都是缓存的：

- `node_modules` 只要 lockfile 没变，就不要重新 `npm ci`；
- Electron 二进制首次下载后缓存在 `~/Library/Caches/electron`，后续打包不再重复下载；
- 唯一无法避免的网络请求是 Apple 公证；
- 内置 Node Runtime（`out/node-runtime`）只要目标平台和版本没变，也不需要重新生成。

因此按改动范围选择最小命令即可：

### 8.1 只改了 `src/`（最常见）

```bash
npm run build
npx --no-install electron-builder --mac dmg zip --publish never -c.mac.notarize=true -c.mac.forceCodeSigning=true
```

`npm run build` 会重新编译 `out/main`、`out/preload`、`out/renderer`；electron-builder 读取当前 `package.json` 版本号直接打包。版本号改动本身不需要额外构建。

### 8.2 联调 `vendor/deepseek-harness` 里的代码

```bash
npm run dsh:source:install
npm run dsh:source:build
EZDSH_DSH_SOURCE="$PWD/vendor/deepseek-harness/apps/cli" npm run dev
```

源码联调使用的就是当前正式打包来源；要让源码修改进入发布包，必须更新子模块 gitlink，并重新执行 source build、Runtime staging 和健康检查。无需把尚未发布的 alpha 版本伪装成 npm 依赖。

`stage:dsh:source-runtime` 也会读取 `vendor/deepseek-harness/apps/cli/package.json` 并执行同一 pin 校验。因此，旧 vendor checkout（例如仍声明 `0.1.0-rc.8`）会在暂存前被拒绝，不能作为发布 Runtime 的回退来源。

Runtime 的浏览器认证边界可单独复核：`npm run verify:runtime:web-auth` 使用真实 Electron `WebContentsView` 打开一次性认证 URL；`npm run diagnose:runtime:iframe-auth` 保留旧的跨站 iframe 复现路径，预期会以 authentication-required 失败，用于防止将问题误判为 Runtime 无法启动。

### 8.3 验证产物

无论哪种情况，打包完成后建议跑一次本地校验：

```bash
npm run verify:package:mac
```

这条命令只检查最终 `.app` 内的资源完整性，不产生网络请求。
