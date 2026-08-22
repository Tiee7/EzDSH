# EzDSH 发布手册

本文是 EzDSH 的发布操作入口。它把版本更新、资源检查、Runtime 构建、安装包生成、签名公证和自动更新分发串成一条可执行流程。

产品需求见 [product-requirements.md](./product-requirements.md)，系统设计见 [architecture.md](./architecture.md)，Runtime 依赖细节见 [runtime-dependency.md](./runtime-dependency.md)，更新源协议见 [update-distribution.md](./update-distribution.md)。

## 1. 发布约定

- 版本号统一使用三段数字格式：`主版本.次版本.修订版本`，例如 `0.8.1505`。
- 不再使用四段版本号；应用展示、Electron 打包元数据和 `electron-updater` 使用同一个版本号。
- 发布包是整包更新，包含 EzDSH、Preload、Renderer 和对应的 DSH Runtime。
- 每个平台的安装包、更新元数据和哈希必须来自同一次构建。
- 安装包不应包含用户数据、API Key、开发目录、依赖目录或本机 Runtime。

## 2. 发布前准备

在项目根目录执行：

```bash
nvm use
node -v
npm ci
```

当前项目要求 Node.js `24.18.0`（上游构建兼容 `^22.19.0 || >=24.0.0`）。`npm ci` 会执行项目的 `postinstall`，其中包括依赖检查和 DSH 上游依赖安装。

确认以下内容已经准备好：

- 当前分支包含要发布的代码和 `vendor/deepseek-harness` 子模块提交；
- 当前平台与发布目标匹配：macOS arm64 或 Windows x64；
- 签名、公证所需的证书和 CI Secret 已通过环境变量注入；
- 自动更新源和安装包上传位置可用；
- 工作区没有不应进入发布的临时文件。

## 3. 修改版本号

使用统一脚本，不要手工修改多个文件：

```bash
npm run version:set -- 0.8.1505
```

脚本位于 [scripts/set-version.mjs](../scripts/set-version.mjs)，会同步：

- `package.json` 的项目版本（唯一版本源）；
- `package-lock.json` 的根项目版本元数据。

Electron 打包和应用展示版本都会直接读取 `package.json` 的项目版本，
不再在源码中维护第二份 `APP_VERSION`。

脚本只接受三段数字版本。以下输入会被拒绝：

```text
0.8.15.1       # 四段版本
0.8            # 缺少修订版本
v0.8.1505      # 带 v 前缀
```

修改后检查：

```bash
git diff -- package.json package-lock.json src/shared/app-identity.ts
```

## 4. 图片素材与品牌资源

项目自有图片统一放在根目录的 `assets/`：

- `assets/logo.png`：Electron 应用图标、Dock 图标和打包资源；
- `assets/logo-source.png`：原始/备用 logo 素材。

打包配置和主进程都引用 `assets/logo.png`。替换图标后，不需要再改代码，但需要重启开发应用或重新打包才能看到效果。macOS 图标建议使用带透明背景、四周有安全留白的 PNG。

`vendor/deepseek-harness` 中的上游 SVG 和图片属于第三方 Runtime/Web UI 资源，不要为了整理根项目素材而移动它们。

## 5. 发布前验证

先完成不生成安装包的验证：

```bash
npm run check:runtime
npm test
npm run typecheck
npm run build
```

重点确认：

- 应用展示版本从 `package.json` 正确读取；
- Runtime 依赖没有重复的 `@deepseek-ai/dsh-tools` 模块；
- DSH Runtime 能启动、健康检查能通过；
- Session、Workspace、Plugin 和用户数据目录没有被构建流程写入或删除；
- 开发模式仍可正常运行：

```bash
npm run dev
```

## 6. 完整准备与打包

### 6.1 macOS 测试包

生成未签名测试包：

```bash
npm run package:mac
```

该命令会依次执行 DSH 安装与构建、EzDSH 构建、Node/DSH Runtime 暂存、Runtime 健康检查和 Electron 打包，并验证最终 `.app` 内的 Runtime。

### 6.2 macOS 正式包

对外发布使用：

```bash
npm run package:mac:release
```

该命令会强制代码签名。正式发布还需要完成 Apple 公证。常用环境变量包括：

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

也可以使用 Apple ID 对应的公证环境变量。证书、私钥、密码和 API Key 只能通过环境变量或 CI Secret 注入，不得提交 Git。

### 6.3 Windows 正式包

Windows x64 runner 上执行：

```bash
npm run package:win:release
```

测试包可以使用：

```bash
npm run package:win
```

Windows 安装包必须使用稳定的代码签名证书。不要在 macOS 上假设可以得到可发布的 Windows 原生包。

NSIS 安装器使用安装向导，用户可以在安装过程中选择程序安装目录。该目录只决定应用程序文件的位置，不改变用户数据目录；用户数据仍保存在 Windows 用户目录下的 `AppData/Roaming/EzDSH`。

### 6.4 仅生成目录包

需要检查未压缩安装目录时：

```bash
npm run package:dir
```

## 7. 按改动范围增量打包

首次完整准备完成后，可以根据改动范围减少重复工作：

只修改 `src/`、版本号或图片素材时：

```bash
npm run build
npx --no-install electron-builder --mac dmg zip --publish never
npm run verify:package:mac
```

修改 DSH Runtime 源码时：

```bash
npm run dsh:source:install
npm run dsh:source:build
EZDSH_DSH_SOURCE="$PWD/vendor/deepseek-harness/apps/cli" npm run dev
npm run build
npx --no-install electron-builder --mac dmg zip --publish never
npm run verify:package:mac
```

源码联调不会自动改变正式安装包。要发布 Runtime 源码修改，必须先生成新的 DSH npm 发布版本，再更新 ezdsh 的 DSH 依赖和 lockfile。

## 8. 产物检查

主要产物位于 `dist/`，该目录不提交 Git。发布前检查：

- macOS `.dmg`、`.zip` 和 `latest-mac.yml` 来自同一次构建；
- Windows 安装包和 `latest.yml` 来自同一次构建；
- 版本号与本次发布版本一致；
- 安装包包含 `out/node-runtime` 和已发布的 `node_modules/@deepseek-ai/dsh` Runtime；
- 最终 `.app` 或 Windows 解包目录通过 Runtime 校验：

```bash
npm run verify:package:mac
# Windows 环境：
npm run verify:package:win
```

不要提交以下可重新生成内容：

```text
node_modules/
vendor/deepseek-harness/node_modules/
.pnpm-store/
out/
dist/
```

## 9. 自动更新分发

EzDSH 使用 `electron-updater` 的 `generic` 更新源，稳定版配置地址为：

```text
https://update.ezdsh.com/updates/
```

开发者模式使用以下预览源：

```text
https://update.ezdsh.com/updates/preview/
```

设置中连续点击 5 次“关于”进入开发者模式，退出开发者模式后恢复稳定源。预览源必须由发布流水线单独发布，不要手工复制稳定目录。

发布时需要上传：

- macOS 对应的安装包和 `latest-mac.yml`；
- Windows 对应的安装包和 `latest.yml`；
- 元数据中引用的文件、大小和哈希必须准确；
- 安装包必须与元数据来自同一次签名构建。

开发环境默认不访问更新源。需要测试远程更新时：

```bash
EZDSH_UPDATE_FEED_URL=https://your-project.vercel.app/updates/ npm run dev
```

测试源必须提供当前平台对应的元数据。只测试版本检查时可以使用更高版本的元数据；测试下载和安装时必须提供真实、签名且哈希匹配的安装包。

## 10. 发布检查清单

- [ ] 使用 `npm run version:set -- x.y.z` 修改版本，且版本只有三段；
- [ ] `npm test`、`npm run typecheck`、`npm run build` 全部通过；
- [ ] Runtime 健康检查和最终安装包校验通过；
- [ ] macOS/Windows 在对应原生平台构建；
- [ ] macOS 已完成签名和公证；
- [ ] Windows 已完成代码签名；
- [ ] 安装包中不包含用户数据、密钥和开发依赖；
- [ ] 安装后能启动 DSH Runtime 并创建/恢复 Session；
- [ ] 更新前会停止 Runtime，更新后用户数据仍然存在；
- [ ] 更新元数据、安装包和哈希来自同一次构建；
- [ ] 已在测试源验证检查、下载、安装和重启链路；
- [ ] 发布说明包含 EzDSH 版本、DSH Runtime 版本、平台和已知问题。

## 11. 发布后回归

发布后至少验证一次：

1. 全新安装能启动应用；
2. 应用能启动内置 DSH Runtime；
3. Provider、Session、Workspace 和 Plugin 基本流程可用；
4. 手动检查更新能得到正确版本；
5. 下载并安装更新后，应用能重启；
6. 用户数据、凭据和工作区仍然存在；
7. 应用退出后没有遗留 DSH Runtime 进程。
