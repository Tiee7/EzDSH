# EzDSH 发布与自动更新

> 完整发布操作请先阅读 [发布手册](./release-manual.md)。本文只保留更新源和分发协议，避免与操作手册重复。

## 1. 更新源

EzDSH 使用 `electron-updater` 的 `generic` 更新源。稳定版地址为：

```text
https://update.ezdsh.com/updates/
```

设置中连续点击 5 次“关于”会进入开发者模式。开发者模式只在已打包应用中启用预览更新源：

```text
https://update.ezdsh.com/updates/preview/
```

开发者模式状态会保存在 EzDSH 的用户数据中，退出开发者模式后立即切回稳定更新源。普通用户不会访问 `preview/`。

打包时，`electron-builder` 会根据该配置生成平台对应的更新元数据：

- macOS：`latest-mac.yml`、ZIP/DMG 更新文件
- Windows：`latest.yml`、NSIS 更新文件

版本检查以这些元数据中的 `version` 为准，不额外维护一套容易不一致的版本号接口。官网如果需要展示版本号，可以读取同一份元数据，或者由发布流程生成一个独立的 `version.json`。

EzDSH 统一使用标准三段 SemVer。应用展示、Electron 打包元数据和 `electron-updater` 更新元数据都使用同一个版本号。版本修改由发布手册中的 `npm run version:set -- x.y.z` 脚本完成。

## 2. Vercel 是否适合

可行，推荐拆成两层：

1. Vercel 部署官网、下载页和更新元数据；
2. 安装包放在 Vercel Blob、对象存储或其他适合大文件分发的服务中，元数据中的文件 URL 指向对应安装包。

这样版本检查仍然由 Vercel 提供，安装包下载则交给更适合大文件和断点续传的存储。若安装包体积较小，也可以直接放在 Vercel 静态资源中，但需要留意平台的静态文件限制和下载流量成本。

## 3. Electron 自动更新的边界

`electron-updater` 负责读取 `latest-mac.yml` / `latest.yml`、比较版本、下载安装包并调用重启安装，但不会把构建产物同步到服务器，也不会替发布流程生成或校验文件。

当前 EzDSH 的策略是：启动时自动检查，发现更新后由用户确认下载和重启安装。代码中 `autoDownload` 是关闭的，避免应用在后台突然消耗带宽或占用磁盘；`autoInstallOnAppQuit` 是开启的。

## 4. 推荐的 preview 发布方式

不要把稳定版 `updates/` 手工复制到 `updates/preview/`。建议让 CI 根据发布渠道直接生成并发布到对应目录：

1. 稳定标签只发布到 `updates/`；预览标签只发布到 `updates/preview/`。
2. 每次构建同时生成当前平台的安装包、`latest-mac.yml` 或 `latest.yml` 以及 blockmap 文件。
3. 先上传带版本号的安装包，再上传更新元数据。元数据最后发布，避免客户端看到尚未可下载的文件。
4. 发布脚本把“渠道、版本、元数据、安装包”作为同一次构建的产物，并在缺少任一文件时失败。
5. 预览版本使用递增的 SemVer 预发布版本，例如 `1.8.1522-preview.1`，并保持 macOS 与 Windows 的版本策略一致。

这样 `preview/` 是否更新由 CI 的发布结果决定，不依赖人工同步。更进一步，可以让稳定发布和预览发布使用同一个 CI workflow，只由标签前缀或手动输入选择目标目录。

## 5. 开发阶段模拟远程检查

开发环境默认不访问更新源。临时指定远程源后，Main 进程会启用同一套更新检查逻辑：

```bash
EZDSH_UPDATE_FEED_URL=https://your-project.vercel.app/updates/ npm run dev
```

测试源至少需要提供当前平台对应的 `latest-mac.yml` 或 `latest.yml`。只模拟版本检查时，元数据中的版本可以高于当前版本；要继续测试下载和安装，必须同时提供真实、签名且与元数据哈希一致的安装包。

## 6. 发布约束

- 每次发布使用 `npm run version:set -- x.y.z` 同步应用、打包和更新所需的版本号；
- macOS 发布包必须签名并经过公证，否则安装更新时会被系统安全策略拦截；
- Windows 安装包必须使用稳定的代码签名证书；
- 更新元数据和安装包必须来自同一次构建；
- 发布前先用测试 URL 验证检查、下载、停止 DSH Runtime、安装和重启完整链路。
