# EzDSH

<p align="center">
  <img src="logo.png" alt="EzDSH" width="128" />
</p>

<p align="center">
  <strong>DeepSeek Harness 的桌面工作空间。</strong><br/>
  在一个应用中运行 Agent、管理配置、维护本地运行时。
</p>

<p align="center">
  <a href="#下载">下载</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#功能">功能</a> •
  <a href="README.md">English</a>
</p>

---

## 下载

EzDSH 支持 macOS 和 Windows。请从 [Releases](../../releases) 页面下载最新版本。

| 平台 | 安装包 |
|------|--------|
| macOS (Apple Silicon) | `.dmg` / `.zip` |
| Windows | `.exe` 安装程序 |

应用会自动检查更新，并在有新版本时提醒你。

## 快速开始

1. **安装 EzDSH**：使用适合你平台的安装包完成安装。
2. **启动应用**：首次运行会引导你完成初始化设置。
3. **连接 DeepSeek Harness 运行时**：如果你已有 Harness 仓库，可将其路径告诉 EzDSH；否则应用会协助你使用内置运行时。
4. **开始工作**：创建或打开一个配置档案，设置模型服务商，然后运行你的第一个 Agent 会话。

> **注意**：API 密钥、会话记录和配置档案均存储在用户数据目录中，不会写入应用安装目录。

## 功能

- **本地优先的运行时** — DeepSeek Harness 在你的设备上运行，代码、会话和密钥由你掌控。
- **配置档案与服务商管理** — 无需手动编辑配置文件，即可在不同模型服务商和项目配置之间切换。
- **Agent 工作空间** — 在一个窗口中启动、监控和停止 Agent 会话。
- **自动更新** — 内置更新提醒，始终使用最新版本。
- **可恢复的安装** — 重新安装或迁移应用不会丢失数据。

## 系统要求

- macOS 11+（Apple Silicon）或 Windows 10/11
- 本地 DeepSeek Harness 运行时（首次启动时提供内置安装引导）

## 文档

详细的产品与开发文档请参阅 [`docs`](./docs) 目录。

## 许可

EzDSH 基于 [MIT License](./LICENSE) 发布。

---

<p align="center">
  <sub>为 DeepSeek Harness 社区精心打造。</sub>
</p>
