# EzDSH 图标设计规范

本文约束 EzDSH 中图标的来源、命名和使用方式。新增或修改界面时，应优先复用现有组件，不要在业务页面重新绘制同义图标。

## 1. AI 动作图标

所有涉及 AI 生成、AI 修改、AI 分析、AI 员工生成或 AI 方案应用的按钮，统一使用 Font Awesome Free Solid 的 `wand-magic-sparkles`：

- 图标名称：`wand-magic-sparkles`
- JavaScript 导出：`faWandMagicSparkles`
- 样式：Free Solid（`fas`）
- Renderer 组件：`WandMagicSparklesIcon`
- 组件路径：`src/renderer/icons/WandMagicSparklesIcon.tsx`

按钮文字仍然必须保留，图标只承担识别作用；图标按钮必须同时提供 `aria-label` 和 `title`。AI 入口、生成、修改、重应用等动作均使用同一图标，不再手写相似的魔法棒 SVG。

官方图标页面：[Font Awesome Icons](https://fontawesome.com/icons/wand-magic-sparkles)。

## 2. 非 AI 图标

- 移动端现有通用图标使用 Font Awesome Free Solid，并从 `@fortawesome/free-solid-svg-icons` 按需引入。
- 工作流节点图标、商店类型图标等产品专属图形可以继续使用项目内联 SVG；它们不是第三方图标集，新增图标应先确认没有可复用的统一组件。
- `×`、`✎`、`⌄`、`＋` 等属于界面文字字符，不应冒充 AI 图标。
- React Flow 的画布控件图标由 `@xyflow/react` 自己提供，除非替换控件，否则不与业务图标混用。

## 3. 评审检查项

- AI 相关按钮是否使用 `WandMagicSparklesIcon`，而不是重复的内联 SVG？
- 是否保留了可读的按钮文字和无障碍名称？
- 是否避免为了装饰在非 AI 按钮上使用魔法棒？
- 是否按本规范的组件路径和图标名称记录了新的特殊情况？
