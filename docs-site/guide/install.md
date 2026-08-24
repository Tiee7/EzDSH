---
title: 安装
---

# 安装

## 支持哪些平台

EzDSH 当前支持以下平台：

| 平台 | 安装包 |
|------|--------|
| macOS（Apple Silicon） | `.dmg` |
| Windows（x64） | `.exe` 安装程序 |

> 暂不支持 Windows ARM64。

## 需要先装别的环境吗

**不需要。** EzDSH 内置了固定版本的 DeepSeek Harness 运行时，你无需提前安装 Node.js、pnpm 或 DSH 命令行工具，安装后即可直接使用。

## 从哪里下载

1. 打开 GitHub Releases 页面；
2. 在发布版附件列表里下载对应平台的安装包：
   - macOS（Apple Silicon）：`.dmg`
   - Windows（x64）：`.exe`

::: warning 注意
不要下载 GitHub Actions 页面里的 **Artifacts**——它们会被统一打包成 ZIP，是给 CI 构建归档用的，不是普通用户的安装入口。
:::

## macOS 安装步骤

1. 打开下载的 `.dmg` 文件；
2. 把 `EzDSH.app` 拖入「应用程序」文件夹；
3. 从「应用程序」或启动台打开 EzDSH。

如果首次打开提示「无法验证开发者」：

- 右键点击 `EzDSH.app` → 选择「打开」，在弹窗中再次确认；
- 或前往「系统设置 → 隐私与安全性」，在「仍要打开」中允许。

## Windows 安装步骤

由于 Windows 版安装包暂时没有代码签名证书，运行时会提示「Windows 已保护你的电脑」，需要手动点击「仍要运行」才能继续。安装流程如下：

1. 运行下载的 `.exe` 安装程序；

   ![Windows 安装步骤 1](/en/1.png)

2. 在弹出的「Windows 已保护你的电脑」提示中，点击「更多信息」；

   ![Windows 安装步骤 2](/en/2.png)

3. 点击「仍要运行」，确认继续安装；

   ![Windows 安装步骤 3](/zh/3.png)

4. 按安装向导提示完成安装（可自定义安装目录）；

   ![Windows 安装步骤 4](/en/4.png)

5. 选择安装的目录，推荐放在 D 盘。

   ![Windows 安装步骤 5](/en/5.png)

## 安装后

打开 EzDSH，应用会自动启动内置的 AI 运行时并加载工作界面。接下来可以参考[首次使用](./first-run)完成供应商配置，或者直接查看[常见问题](../faq)。