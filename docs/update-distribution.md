# EzDSH 发布与自动更新

> 完整发布操作请先阅读 [发布手册](./release-manual.md)。本文只保留更新源和分发协议，避免与操作手册重复。

## 1. 更新源

EzDSH 使用 `electron-updater` 的 `generic` 更新源。当前暂定地址为：

```text
http://update.ezdsh.com/updates/
```

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

## 3. 开发阶段模拟远程检查

开发环境默认不访问更新源。临时指定远程源后，Main 进程会启用同一套更新检查逻辑：

```bash
EZDSH_UPDATE_FEED_URL=https://your-project.vercel.app/updates/ npm run dev
```

测试源至少需要提供当前平台对应的 `latest-mac.yml` 或 `latest.yml`。只模拟版本检查时，元数据中的版本可以高于当前版本；要继续测试下载和安装，必须同时提供真实、签名且与元数据哈希一致的安装包。

## 4. 发布约束

- 每次发布使用 `npm run version:set -- x.y.z` 同步应用、打包和更新所需的版本号；
- macOS 发布包必须签名并经过公证，否则安装更新时会被系统安全策略拦截；
- Windows 安装包必须使用稳定的代码签名证书；
- 更新元数据和安装包必须来自同一次构建；
- 发布前先用测试 URL 验证检查、下载、停止 DSH Runtime、安装和重启完整链路。
