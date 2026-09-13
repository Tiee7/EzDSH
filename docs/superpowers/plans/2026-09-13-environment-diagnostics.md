# Environment Diagnostics First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先消除可复现的错误归因与恢复页误导，让用户不再因来源拒绝访问去反复切代理，也不因一般启动失败去盲目删除插件。

**Architecture:** 沿用现有安装诊断分类和 AppCopy 接口，优先使用明确 pnpm 错误码，收窄内置依赖缺失的判断。恢复页只调整说明和候选入口名称，保留当前动作语义；复杂恢复编排、统一推荐动作和网络覆盖按设计文档分别交付。

**Tech Stack:** TypeScript、React、Vitest；无新增依赖。

## Global Constraints

- 总体目标与独立子项目见 [用户流程设计](../../environment-recovery-design.md)。本文只覆盖其第 0 步，不代表完整环境问题处理已经实现。
- 计划基于 2026-09-13 工作区、HEAD `0cf4845`；执行前检查目标文件是否被其他工作修改。
- 将诊断、假设和解决方案视为待验证假设；具体错误码优先，证据不足保留 unknown。
- 不自动还原备份、卸载插件、修改系统 PATH、安装全局依赖或上传诊断。
- 保留恢复指定备份的时间倒序选择和明确确认；不改安全/隔离模式行为。
- 不触碰现有 Workflow、package.json、恢复页 CSS 和其他暂存改动。
- 保留中英文；使用现有 AppCopy 键，不扩展公共 IPC。
- 仅在测试通过后提交本任务文件；有其他暂存内容时使用指定路径提交，不能提交整个索引。

---

## 文件职责

| 文件 | 本次责任 |
| --- | --- |
| `src/main/store/install-diagnostics.ts` | 修正具体状态码优先级，去掉由任意 ENOENT 推断内置包管理器缺失的规则 |
| `test/store/install-diagnostics.test.ts` | 验证明确诊断和最强反例 |
| `src/shared/locale.ts` | 用中性故障说明替代无依据的归因；说明完整恢复范围 |
| `test/renderer/recovery-panel.test.tsx` | 更新故意改变的可见文案断言，保留交互覆盖 |
| `test/renderer/recovery-copy.test.ts` | 保护候选与确认冲突的区分、恢复范围及模式边界 |

以上路径均相对仓库根 `/Users/snake/Documents/ChatGPT/ezdsh`。下列任务已在隔离工作区实施并审查；代码块保留原计划，最终边界补充与验证见文末执行记录。

### Task 1: 安装诊断优先采用具体错误证据

**Files:**
- Modify: `src/main/store/install-diagnostics.ts` 中 `classifyCode` 函数。
- Test: `test/store/install-diagnostics.test.ts`。

**Interfaces:**
- Consumes: 现有 `diagnoseInstallFailure(error: unknown): InstallDiagnostic`。
- Produces: 同一接口、同一 `InstallDiagnosticCode` 联合类型；401/403 输出 `auth`，一般 ENOENT 输出 `unknown`。

- [x] **Step 1: 追加回归用例。** 以下代码直接追加到现有测试文件，不删除已有 3 项测试。

```ts
describe('environment diagnosis evidence', () => {
  it.each([
    ['[ERR_PNPM_FETCH_401] GET https://registry.example/pkg - 401', 'auth'],
    ['[ERR_PNPM_FETCH_403] GET https://registry.example/pkg - 403', 'auth'],
    ['[ERR_PNPM_FETCH_401]', 'auth'],
    ['[ERR_PNPM_FETCH_403]', 'auth'],
    ['[ERR_PNPM_FETCH_404] GET https://registry.example/pkg - 404', 'package-not-found'],
    ['[ERR_PNPM_FETCH_401] package not found in registry; network error', 'auth'],
    ['[ERR_PNPM_TARBALL_INTEGRITY] checksum mismatch after network retry', 'lockfile-policy'],
    ['EACCES: permission denied while retrying network install', 'permission'],
    ['spawn git ENOENT', 'unknown'],
    ['ENOENT: no such file or directory, open /tmp/profile/package.json', 'unknown'],
    ['Bundled pnpm is missing at /app/node_modules/pnpm/bin/pnpm.cjs', 'runtime-prerequisite'],
    ['ENOTFOUND registry.example', 'network'],
    ['ETIMEDOUT while fetching package', 'network'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(diagnoseInstallFailure(new Error(message)).code).toBe(expected)
  })

  it('does not prescribe rebuilding EzDSH for a missing external command', () => {
    const result = diagnoseInstallFailure(new Error('spawn git ENOENT'))
    expect(result.suggestedAction).not.toMatch(/update or rebuild EzDSH/i)
    expect(result.detail).toContain('spawn git ENOENT')
  })
})
```

- [x] **Step 2: 运行新增测试，确认当前误分类会失败。**

```bash
./node_modules/.bin/vitest run test/store/install-diagnostics.test.ts
```

预期：401/403、混合提示优先级、一般 ENOENT 的用例在当前代码失败；失败应与对应预期类别不一致有关。

- [x] **Step 3: 用下列完整函数替换 `classifyCode`。** 其余函数与公共类型保持原状。

```ts
function classifyCode(message: string): InstallDiagnosticCode {
  const fetchStatus = /\bERR_PNPM_FETCH_(401|403|404)\b/i.exec(message)?.[1]
  if (fetchStatus === '401' || fetchStatus === '403') return 'auth'
  if (fetchStatus === '404') return 'package-not-found'

  if (/Catalog entry rejected|Unsupported DSH plugin source|Invalid DSH plugin (?:package name|profile)/i.test(message)) return 'catalog-entry-invalid'
  if (/ERR_PNPM_INVALID_DEPENDENCY_NAME|invalid (?:alias|dependency)\b/i.test(message)) return 'invalid-dependency-name'
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(message)) return 'build-script-blocked'
  if (/lockfile|supply-chain|integrity|checksum|ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_LOCKFILE/i.test(message)) return 'lockfile-policy'
  if (/EACCES|EPERM|permission denied|access is denied/i.test(message)) return 'permission'
  if (/Bundled pnpm is missing/i.test(message)) return 'runtime-prerequisite'
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication|private repository|permission to .* denied/i.test(message)) return 'auth'
  if (/\b404\b|No matching version found|not found in (?:the )?registry/i.test(message)) return 'package-not-found'
  if (/ERR_PNPM_FETCH|ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|timed? out|network/i.test(message)) return 'network'
  if (/prepare|preinstall|postinstall|build script|lifecycle script|exit code [1-9]\d*/i.test(message)) return 'build-failed'
  if (/was not added to profile|Cannot determine the package name added/i.test(message)) return 'postcondition'
  return 'unknown'
}
```

本任务保留其余历史字符串兼容规则，因此不是完备的环境诊断器。`unknown` 是有意保守处理：Git 缺失、普通文件缺失、磁盘和证书问题应由后续带步骤、路径和结构化错误码的检查器确定，不在这里凭字符串自动安装或修复。

- [x] **Step 4: 验证分类与安装集成。**

```bash
./node_modules/.bin/vitest run test/store/install-diagnostics.test.ts test/store/install-reporter.test.ts test/store/store-service-install.test.ts
npm run typecheck
git diff --check
```

预期：针对本变更的测试通过，类型不变。若类型检查因既有并行工作失败，记录具体文件和证据，不能标记整个工作区通过。

- [x] **Step 5: 只提交本任务文件。**

```bash
git add src/main/store/install-diagnostics.ts test/store/install-diagnostics.test.ts
git commit --only src/main/store/install-diagnostics.ts test/store/install-diagnostics.test.ts -m "fix: prioritize specific installation failure evidence"
```

### Task 2: 恢复文案说明事实和影响

**Files:**
- Modify: `src/shared/locale.ts`。
- Modify: `test/renderer/recovery-panel.test.tsx`。
- Create: `test/renderer/recovery-copy.test.ts`。

**Interfaces:**
- Consumes: 现有 `getAppCopy('zh' | 'en')`。
- Produces: 原有文案键和值类型；`RecoveryPanel` 与 `RuntimeStartupFailureNotice` 自动读取新文字，不新增动作。

- [x] **Step 1: 新建以下完整文案回归测试。**

```ts
import { describe, expect, it } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'

describe('recovery copy evidence and scope', () => {
  it('does not diagnose a conflicting plugin from generic startup failure', () => {
    const copy = getAppCopy('zh')
    expect(copy.recoveryRemoveConflictingPlugins).toBe('查看已安装插件')
    expect(copy.recoveryRuntimeFailureDetail).toContain('尚未确定失败原因')
    expect(copy.recoveryRuntimeFailureDetail).not.toContain('卸载')
    expect(copy.recoveryDetail).not.toContain('上次升级后')
  })

  it('explains full backup scope before the user selects one', () => {
    const copy = getAppCopy('zh')
    expect(copy.recoverySelectSnapshotHint).toContain('会话、设置、插件和工作流数据')
    expect(copy.recoverySelectSnapshotHint).toContain('不回退应用版本')
    expect(copy.recoverySelectSnapshotHint).toContain('保留当前状态的备份')
  })

  it('keeps English equally explicit', () => {
    const copy = getAppCopy('en')
    expect(copy.recoveryRemoveConflictingPlugins).toBe('View installed plugins')
    expect(copy.recoveryRuntimeFailureDetail).toContain('cause has not been determined')
    expect(copy.recoverySelectSnapshotHint).toContain('sessions, settings, plugins, and workflow data')
    expect(copy.recoverySelectSnapshotHint).toContain('does not downgrade the app')
  })
})
```

- [x] **Step 2: 确认新测试在原文案失败。**

```bash
./node_modules/.bin/vitest run test/renderer/recovery-copy.test.ts
```

预期：3 项失败，原因均为旧文案未满足事实/范围提示。

- [x] **Step 3: 替换中文和英文对象中的以下现有值。** 不添加重复键，不改 AppCopy 接口。

中文：

```ts
runtimeStartFailed: 'EzDSH 暂时未能启动，请查看下方处理选项。',
recoveryTitle: 'EzDSH 暂时无法正常启动',
recoveryDetail: '正常启动尚未完成。请查看本次错误和可用的处理方式；恢复备份前请确认日期与影响范围。',
recoveryRestorePrevious: '恢复此故障关联的备份',
recoverySelectSnapshotHint: '备份按创建时间从新到旧排列。恢复会替换备份所包含的会话、设置、插件和工作流数据，不回退应用版本；操作前会先保留当前状态的备份。请选择日期，再确认恢复。',
recoveryRestoring: '正在恢复所选备份…',
recoveryRuntimeFailureDetail: '正常启动失败，尚未确定失败原因。可尝试安全模式，临时跳过第三方插件、Skills、自定义模式和项目指令；恢复历史备份需另行选择。',
recoveryRemoveConflictingPlugins: '查看已安装插件',
recoveryPluginChoiceHint: '以下是可管理的已安装插件，不代表它们导致了本次故障。仅在明确需要处理某个插件时停用或卸载。',
```

英文：

```ts
runtimeStartFailed: 'EzDSH could not start. Review the options below.',
recoveryTitle: 'EzDSH could not start normally',
recoveryDetail: 'Normal startup has not completed. Review the current error and available options. Check the date and affected data before restoring a backup.',
recoveryRestorePrevious: 'Restore the backup for this recovery',
recoverySelectSnapshotHint: 'Backups are listed from newest to oldest. Restoring replaces the sessions, settings, plugins, and workflow data included in the backup; it does not downgrade the app. A backup of the current state is created first. Select a date, then confirm.',
recoveryRestoring: 'Restoring the selected backup…',
recoveryRuntimeFailureDetail: 'Normal startup failed; the cause has not been determined. You can try Safe Mode to temporarily skip third-party plugins, Skills, custom modes, and project instructions. Restoring an older backup is a separate choice.',
recoveryRemoveConflictingPlugins: 'View installed plugins',
recoveryPluginChoiceHint: 'These are installed plugins that can be managed, not confirmed causes of this failure. Disable or uninstall a plugin only when there is a specific reason to do so.',
```

这些文案不把“原数据仍在”扩大为“所有操作绝不改动数据”，也不声称安全模式是只读模式。恢复前保留备份失败时，后端应停止后续替换；完整预览与服务编排仍属于设计的第 1B 步。

- [x] **Step 4: 更新已有交互测试中的旧文字。** 在 `test/renderer/recovery-panel.test.tsx` 全部替换以下三对字面量，其他断言与点击过程保留。

```text
删除冲突的插件
→ 查看已安装插件

恢复上一份环境
→ 恢复此故障关联的备份

以下插件来自当前 profile；它们不一定是本次故障原因。
→ 以下是可管理的已安装插件，不代表它们导致了本次故障。
```

将测试名 `opens the plugin list from the explicit delete-conflicting-plugins action` 改为 `opens installed plugin candidates without asserting a conflict`。将缺失按钮的测试错误文本 `delete-conflicting-plugins action should render` 改为 `installed-plugin action should render`。

- [x] **Step 5: 验证文案、页面交互与构建。**

```bash
./node_modules/.bin/vitest run test/renderer/recovery-copy.test.ts test/renderer/recovery-panel.test.tsx test/renderer/runtime-startup-failure.test.tsx test/renderer/safe-mode-ui.test.tsx test/store/install-diagnostics.test.ts
npm run typecheck
npm run build
git diff --check
```

预期：原有恢复入口、插件候选展开、备份选择、模式退出仍可操作；中英文文案通过。视觉核查限定为隔离开发数据环境：小窗口和中英文下能完整阅读长范围提示，无裁切；不重启用户当前发行应用。

- [x] **Step 6: 只提交本任务文件。**

```bash
git add src/shared/locale.ts test/renderer/recovery-panel.test.tsx test/renderer/recovery-copy.test.ts
git commit --only src/shared/locale.ts test/renderer/recovery-panel.test.tsx test/renderer/recovery-copy.test.ts -m "fix: explain recovery choices without assuming the failure cause"
```

## 完成边界与后续交付

本片完成后，已修正的只是已知归因与文案，按钮数量和恢复后服务编排仍未改变。报告时必须保留这个边界，不能宣称“一键修复完成”。

下一批先完成设计文档第 1A/1B/1C 的独立方案与故障测试，再上线统一推荐动作。尤其不要将现有 `recovery.restore()` 与 `runtime.start()` 简单封装成“自动修复”：它还没有完成被停止服务的整体重建、Web 就绪验证和历史任务防重放。

既有测试基线中的外部服务旧文案断言失败保留为单独事项，不能为本片通过而删掉该断言或把整个测试集标为通过。

## 实施前的计划片段验证记录（2026-09-13）

规划阶段在独立临时镜像中提取本文代码与文案；以下是当时的历史结果，不代表后续实现的最终验证。

- 原代码加计划新增测试：20 项中 13 失败、7 通过，失败覆盖当前误分类与旧文案。
- 提取期间恢复按钮名称发生同步差异；按本文最终字面量同步后，直接受影响的诊断、文案和恢复页 3 文件共 31 项全部通过。其余 4 文件共 40 项此前已通过，且未因该同步再次修改。
- 这是对实施片段的可执行性检查，不等于产品改动落地。实际实现的测试、typecheck、build 和隔离数据下的视觉检查另列于下。

## 实际执行记录（2026-09-13）

- 隔离分支 `codex/environment-diagnostics` 从 `0feec48` 创建。Task 1 提交 `67a331d`，Task 2 提交 `9970a59`；两项均完成先失败、后通过的测试验证与独立审查。
- 最后核查补充路径关键词反例，提交 `fb9260f`：EACCES/EPERM 优先于宽泛 lockfile 匹配；普通 ENOENT 即使路径包含 lockfile/pnpm 也保持 unknown；明确的内置 pnpm 缺失与完整性错误仍按其证据分类。新增 6 项测试，追加阶段先有 3 项失败、修复后相关 55 项通过；增量审查无阻塞问题。该调整补充了上方原计划中的函数优先级。
- 将三个提交的 5 个目标文件同步回主工作区后，以下组合测试独立运行，7 文件、77/77 通过。主工作区 typecheck、build、diffcheck 通过；构建有 Workflow 模块静态/动态导入并存的非失败提示。
- 真实组件以模拟本地 API 在浏览器预览。恢复页中英文、插件候选展开、倒序备份选择与确认前的完整影响提示可用；未选择备份时确认禁用，选择后启用。RecoveryPanel 在 420px 单组件压力检查中提示无裁切；启动失败页按应用实际最小窗口 960×640 检查，处理按钮及展开详情可见。没有点击真实还原、重启当前发行应用或修改用户恢复数据。
- 整体审查与最终增量审查均无 Critical/Important 问题。非阻塞测试建议保留：英文文案本身正确，但 locale 单元测试未对“恢复前备份”和“无升级归因”做完整对称断言。
- 主工作区原有暂存内容在同步与验证前后保持一致；本次只提交指定产品、测试和说明文件。尚未推送或发布。

```bash
./node_modules/.bin/vitest run test/store/install-diagnostics.test.ts test/store/install-reporter.test.ts test/store/store-service-install.test.ts test/renderer/recovery-copy.test.ts test/renderer/recovery-panel.test.tsx test/renderer/runtime-startup-failure.test.tsx test/renderer/safe-mode-ui.test.tsx
npm run typecheck
npm run build
git diff --check
```

本批分类仍包含历史字符串兼容规则，同一日志混合多个独立错误时依赖优先级，不是完整的结构化根因分析。恢复服务重建、Web 就绪验证、故障外壳与统一推荐动作仍未实现。
