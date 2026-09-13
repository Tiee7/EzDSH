# 外部服务启动失败：目录与命令分别诊断

日期：2026-09-13。基线：`e6b1dc8`。这是 [环境问题处理设计](environment-recovery-design.md) 第 1C 步的首批实现，围绕一个完整用户动作：看懂失败原因，修改对应字段，明确保存并重试。

## 已确认的问题

1. `ExternalServiceManager` 把所有 spawn ENOENT 解释为程序不存在。当前机器上的无副作用复现表明，有效 Node 配不存在的 cwd、不存在的启动程序、存在脚本配不存在的 shebang 解释器，都会产生 ENOENT；有效 Node 配中文/空格目录正常退出。因此错误码本身不能确定缺哪个对象。
2. 外部服务设置直接显示英文技术错误、命令与 PATH，没有按原因提供处理入口。
3. 表单清空工作目录后省略 cwd 字段，Main 合并更新时保留旧值，因此用户无法通过清空字段移除错误目录。
4. 原有测试基线 2 文件共 9 项中 8 通过、1 失败。失败来自旧测试精确要求 `error: 'not found'`，当前实现已添加上下文；本批在保留原意和证据的前提下更新断言。

## 交付范围

- 启动前检查工作目录存在、确实是目录且可访问；不创建用户指定的服务目录。当前用户的 `~` / `~/` 转为明确路径，不执行 Shell 表达式。相对路径依据本次启动的进程目录解析。
- Main 通过 snapshot 上的 `startupIssue` 给出当前检查证据，Renderer 不解析错误文案猜测原因。技术错误保留，默认折叠。
- 目录缺失、路径是文件、目录不可访问，引导修改工作目录；明确命令缺失或执行权限问题，引导修改启动命令。现存脚本缺解释器等证据不足场景保持无法启动的保守解释，不建议重装已有命令。
- “修改工作目录/启动命令”定位到既有编辑表单；选择文件夹只改草稿。修复入口提供“保存并重试”，更新成功后才启动；普通保存保持仅保存。
- 取消选择、保存失败、切换编辑对象不得触发启动或让迟到的选择结果覆盖另一份草稿。操作期间避免冲突操作。
- 清空目录显式传空串以移除历史配置。更新进程字段、再次启动或停止后清除旧的启动诊断。
- 同步 spawn throw 与异步 child error 使用该次启动的实际上下文。目录检查后被移除时需再次按证据判断，不能把目录变化诊断成程序缺失。

## 实现分工

| 部分 | 文件 | 验证重点 |
| --- | --- | --- |
| Main 与共享诊断 | `external-service-manager.ts`、`shared/external-services.ts`、Main 测试 | 目录/命令区分、权限、中文空格路径、当前用户目录、竞态、真实子进程反例 |
| Renderer 与目录选择 | `ExternalServicesSection.tsx`、display helper、locale、contracts、preload、Main 选择器、Renderer 测试 | 选择只改草稿、保存后重试顺序、失败不启动、清空 cwd、中英文、技术详情 |
| 验证与交付 | 本文、既有外部服务文档与总体规划 | 记录真实测试、组件检查和发行验收边界；仅本地聚焦提交 |

## 保持的边界

不修改用户的 Shell、PATH 配置文件、系统权限或全局依赖，不自动安装命令；不自动下载服务定义。运行仍为可执行文件和独立参数，不使用 Shell 执行整段输入。保存并重试由用户主动点击，目录选择本身不运行命令。

`running` 仍表示子进程已创建，不是该服务的业务健康检查。打包 PATH 的既有解析继续使用，macOS/Windows 正式发行包和 Windows 命令脚本行为需要各自实测。本批不承诺所有混合日志均可确定根因，不改完整恢复编排。

## 执行记录

开发、测试与浏览器验证在独立工作区进行；主工作区的 Workflow、package.json、恢复页 CSS 和暂存内容保留。

- Main 第一轮新增反例：26 项中 17 失败、9 通过，修复后全部通过；真实损坏符号链接的补充反例先失败再修正。最终 Main 29/29 通过，包括真实临时子进程与本机目录权限检查。
- UI 首轮交互回归按缺少新行为失败；实现后两文件 23/23 通过。最终补上 failed 但没有 startupIssue 时的通用首屏摘要，新增回归先失败，修复后两文件 24/24 通过。
- 隔离工作区先执行 8 文件组合验证，75/75 通过；随后追加上述一项 UI 回归。Node 与 Renderer 类型检查、构建通过；构建保留既有 Workflow 静态/动态导入并存提示，不影响完成。
- 独立代码审查覆盖最终 Main → IPC → Renderer 流程，包括最后的未知失败摘要修复，未发现 Critical/Important/Minor 阻塞项。
- 在真实组件、实际设置页侧栏布局与 960×640 窗口中检查了中英文摘要、展开详情、编辑焦点和操作可见性。模拟 API 的英文操作记录严格为：选择文件夹只改草稿 → 保存 → 启动；不操作用户服务。最终文案与未知失败提示已重新加载检查。
- 独立无副作用 Main 实测：当前 Node 在中文/空格目录中以代码 0 退出；同一程序配不存在目录时在启动前记录 `cwd-missing`。临时配置和日志位于系统临时目录。

上述浏览器检查使用模拟选择结果，没有完成真实 Electron 原生选择器、macOS 正式安装包或 Windows 实机验收。仍需保留这些发行验证边界。

隔离分支提交 `570fcd3` 后，将 14 个指定文件同步回主工作区。主工作区独立组合验证 **8 文件、76/76 通过**；`npm run typecheck`、`npm run typecheck:renderer`、`npm run build` 和 `git diff --check` 通过。原有暂存内容在同步和验证前后哈希保持一致。临时浏览器页面和预览服务已关闭。本批只保存为本地提交，尚未推送或发布。

```bash
./node_modules/.bin/vitest run test/external-services/external-service-manager.test.ts test/renderer/external-services-display.test.ts test/renderer/external-services-section.test.tsx test/renderer/recovery-copy.test.ts test/renderer/recovery-panel.test.tsx test/renderer/runtime-startup-failure.test.tsx test/renderer/safe-mode-ui.test.tsx test/main/window-lifecycle.test.ts
npm run typecheck
npm run typecheck:renderer
npm run build
git diff --check
```
