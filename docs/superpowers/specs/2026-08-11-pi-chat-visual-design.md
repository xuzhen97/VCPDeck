# Pi 聊天中栏视觉与交互优化设计

## 背景

当前 Pi 中栏的 `Process Details`、MCP 工具调用块和运行状态在亮色/暗色主题下可读性不稳定：部分区域使用硬编码深色块，和整体浅色背景割裂；灰色文字对比不足；加载状态只有静态文案；底部聊天输入区按钮、附件入口、输入框和发送按钮高度不齐，视觉上显得杂乱。

## 目标

- 优化 Pi 中栏整体视觉：用户消息、助手消息、过程详情、工具调用块、加载状态、输入区统一到同一套语义色。
- 亮色和暗色主题都清晰可读，不再依赖固定 `zinc` 黑色块。
- 增加轻量动画反馈：历史加载、运行中、过程详情展开内容有明确但不打扰的动效。
- 底部聊天框的附件按钮、文本框、发送按钮保持高度和底线对齐。

## 非目标

- 不改 Pi 会话数据结构、消息协议、服务端 API 或运行逻辑。
- 不新增 UI 依赖或动画库。
- 不重做三栏布局、侧边栏、右侧状态面板。
- 不做像素级全站设计系统重构。

## 方案选择

采用“语义卡片 + 柔和动效”方案：只在 Pi 聊天中栏相关组件内替换硬编码颜色和局部布局，复用现有 Tailwind token（`background`、`card`、`border`、`primary`、`secondary`、`muted-foreground`、`ring`）。这是最小可维护方案，能同时解决亮/暗色不协调、工具块难读、加载反馈弱、输入区不对齐的问题。

## 组件设计

### `PiChatWindow`

- 聊天滚动区域保持现有结构，只调整 spacing、消息容器宽度和运行状态展示。
- 历史加载状态从纯文本改为居中的轻量加载胶囊：三点 pulse 动画 + “正在加载历史消息…”文案。
- 运行中状态从单行“运行中…”改为底部小型流式状态：三点 pulse + “Pi 正在处理…”文案。
- 空状态保持简洁，只微调颜色和背景，不新增引导流程。

### `ProcessDetails`

- 外层改为语义卡片：`border-border/70`、`bg-card/65`、`backdrop-blur`，暗色自动适配。
- 标题行包含：展开箭头、`Process Details`、消息/工具调用计数、工具名摘要、展开/收起操作。
- 展开内容加轻量进入动画（约 160-180ms 的 opacity + translateY），并受 `prefers-reduced-motion` 控制。
- 不改变默认折叠行为，避免长过程占满窗口。

### `PiMessageView`

- 用户消息从硬编码 `bg-blue-950/40` 改为 primary 渐变气泡，亮色和暗色下都保持足够对比。
- 助手最终消息增加轻量卡片背景和边框，使 Markdown 内容从背景中分离出来。
- `tool_result` 使用语义边框和 muted 背景，不再使用固定深色 zinc。
- Markdown 正文继续走现有渲染逻辑，不允许 raw HTML 的安全边界不变。

### `ToolCallBlock`

- 移除硬编码 `bg-zinc-900` / `border-zinc-*`。
- 顶部栏使用小型 `mcp`/工具名标签、输入摘要、展开状态；正文使用语义代码块背景。
- 参数和结果区分层级，但不新增复杂状态图标。
- 超长 JSON 继续允许横向/换行滚动，避免撑破聊天列。

### `PiChatInput`

- 输入区改为单个对齐容器：附件按钮、textarea、发送按钮都使用相同视觉高度和底部对齐。
- 附件列表使用小 chip，和输入容器保持同一套 border/card 语义色。
- 运行中控制按钮（Steer、Follow-up、Compact、中止）保持现有功能，只微调间距和 active 状态可读性。
- Textarea focus 使用 `ring`，发送按钮使用 primary；禁用态保持清晰但低强调。

## 动画设计

- 新增局部 CSS 类，放在 `packages/frontend/src/styles.css` 的 component layer：
  - `pi-chat-fade-in`：用于展开内容和新状态块进入。
  - `pi-chat-loading-dot`：三点 pulse。
- `prefers-reduced-motion: reduce` 时关闭动画。
- 不使用 JS 定时器，不增加运行时状态。

## 数据流与行为

消息分组、工具结果收集、图片懒加载和输入提交逻辑保持不变。视觉优化只改变 DOM class 和少量展示结构，不改变以下行为：

- `buildTurnGroups()` 的分组规则。
- `toolResultsOf()` 的工具结果映射。
- `PiChatInput` 的 Enter 发送、Shift+Enter 换行、运行中 abort 快捷键。
- 附件选择和移除回调。

## 错误处理

- `state.error` 仍在聊天区域顶部显示，但颜色改为语义 destructive 风格。
- 工具调用展开失败不存在独立错误路径；已有消息内容照常渲染。
- 图片加载仍由现有 `ImageBlock` 和 `onImageLoad` 处理。

## 测试计划

- 更新现有 Pi 聊天窗口测试，确认：
  - 历史加载状态仍可通过 `data-testid="pi-history-loading"` 定位。
  - 运行中状态仍可通过 `data-testid="streaming-indicator"` 定位。
  - Process Details 展开后仍显示工具调用内容。
- 更新/保留 `PiChatInput` 相关行为测试；避免测试具体 Tailwind class，重点测按钮可用性、输入提交和运行中模式。
- 跑 `lsp_diagnostics` 检查改动文件。
- 跑 Pi 相关 Vitest 文件：`pi-chat-window.test.tsx`、`pi-chat-input` 覆盖所在测试（如存在）、必要时跑 frontend 单测子集。

## 验收标准

- 亮色主题下 Process Details、MCP 工具调用、工具结果不再出现突兀黑条，文字清晰可读。
- 暗色主题下同一区域有足够对比，不出现灰字贴黑底难读。
- 加载历史和运行中状态有轻量动画反馈。
- 底部聊天框附件按钮、textarea、发送按钮高度/底线对齐。
- 不新增依赖，不改服务端，不改消息协议。
