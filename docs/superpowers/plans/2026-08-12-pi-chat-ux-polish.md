# Pi 聊天 UX 打磨实施计划

> **For agentic workers:** 本计划对应 2026-08-12 一轮三项 Pi 聊天 UX 打磨（工具结果折叠 / 会话卡片点击 / 输入区对齐），已随代码一起提交。设计依据见 `docs/superpowers/specs/2026-08-12-pi-chat-ux-polish-design.md`。

**Goal:** 在不改变 Pi 协议、服务端逻辑与既有交互回调的前提下，改善 Pi Tab 的三处使用体验：工具结果默认折叠、会话卡片整卡可点击、输入区控件高度对齐。

**Architecture:** 仅修改前端展示组件与对应单测。复用现有折叠交互模式（`ToolCallBlock` / `ThinkingBlock`）与 Tailwind 语义 token，不新增依赖与状态机。

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, Tailwind CSS v4 semantic tokens。

## Global Constraints

- 不改 Pi 会话数据结构、消息协议、Server API 或运行逻辑。
- 不新增 UI 依赖或动画库。
- 不重做三栏布局、右侧状态面板。
- 保持 `onSelectSession`、`toolResultsOf()`、Enter/Shift+Enter/Esc、Steer/Follow-up/Compact/中止、附件回调行为不变。
- 文档与代码使用简体中文描述，标识符与类名保持英文。

---

## File Structure

- `packages/frontend/src/pi/pi-message-view.tsx` — 新增 `ToolResultBlock`，`tool_result` 消息默认折叠。
- `packages/frontend/src/pi/pi-message-view.test.tsx` — 折叠/展开行为测试。
- `packages/frontend/src/pi/pi-session-sidebar.tsx` — `SessionRow` 改为整卡按钮 + 绝对定位菜单。
- `packages/frontend/src/pi/pi-session-sidebar.test.tsx` — 卡片点击与菜单隔离测试。
- `packages/frontend/src/pi/pi-chat-input.tsx` — 统一输入区控件高度与边框。
- `packages/frontend/src/pi/pi-chat-input.test.tsx` — 统一高度与 rows 测试。
- `docs/remote-pi-tab.md` — 使用说明同步工具结果折叠行为。

### Task 1: 工具结果默认折叠

**Files:** `pi-message-view.tsx` / `pi-message-view.test.tsx`

- [x] **Step 1** 在 `pi-message-view.tsx` 新增 `ToolResultBlock({ text })`：默认折叠；标题行 = “工具结果”标签 + 行数 + 首行摘要（≤100 字符）+ 展开/收起；展开区 `pi-chat-fade-in` + `max-h-96 overflow-auto`。
- [x] **Step 2** `PiMessageView` 的 `tool_result` 分支改为 `<ToolResultBlock text={text} />`，保留 `data-testid="tool-result"`。
- [x] **Step 3** 更新测试：默认折叠无 `pre`、显示 `N 行`、点击“展开”后出现完整 `pre` 且 `aria-expanded=true`。
- [x] **Step 4** 验证：`pnpm --filter @vcpdeck/frontend test -- pi-message-view.test.tsx` 通过；`pnpm --filter @vcpdeck/frontend build` 通过。

### Task 2: 会话卡片整卡可点击

**Files:** `pi-session-sidebar.tsx` / `pi-session-sidebar.test.tsx`

- [x] **Step 1** `SessionRow` 改为 `<div className="group relative">` + 整卡 `<button>`（`min-h-11`、`cursor-pointer`、focus ring、`aria-label="打开会话：{title}"`），标题行与元信息行都在按钮内。
- [x] **Step 2** 右侧“⋯”菜单改为 `absolute right-1.5 top-1` 兄弟节点，点击不冒泡到卡片；标题行 `pr-7` 防遮挡。
- [x] **Step 3** 新增测试：点击卡片内“1 msgs”触发 `onSelectSession("s1")`；点击“操作”菜单不触发选择且菜单展开。
- [x] **Step 4** 验证：`pnpm --filter @vcpdeck/frontend test -- pi-session-sidebar.test.tsx` 通过；`pnpm --filter @vcpdeck/frontend build` 通过。

### Task 3: 输入区控件高度对齐

**Files:** `pi-chat-input.tsx` / `pi-chat-input.test.tsx`

- [x] **Step 1** 输入行改 `items-stretch` + `p-1.5` + `focus-within:ring-2 focus-within:ring-ring/20`；“添加”/文本框/发送统一 `h-12`。
- [x] **Step 2** 文本框 `rows={2}` → `rows={1}`，去独立边框（`border-0`），外层容器统一边框；聚焦 `focus:bg-background/80`。
- [x] **Step 3** 根容器统一 `p-3`，新增 `data-testid="pi-chat-composer"`。
- [x] **Step 4** 更新测试：三控件统一 `h-12`、文本框 `rows=1`、容器 `p-3`。
- [x] **Step 5** 验证：`pnpm --filter @vcpdeck/frontend test -- pi-chat-input.test.tsx` 通过；`pnpm --filter @vcpdeck/frontend build` 通过。

### Task 4: 文档与收尾

**Files:** `docs/remote-pi-tab.md`、plan / spec 文档

- [x] **Step 1** 更新 `docs/remote-pi-tab.md` 使用步骤第 6 条：补充“工具结果默认折叠，标题行展示行数与首行摘要，点击展开完整输出”。
- [x] **Step 2** 新增本计划与对应设计文档（`2026-08-12-pi-chat-ux-polish*`）。
- [x] **Step 3** `git diff --check` 通过；`gitnexus detect-changes` 复核变更仅限预期文件。

## Self-Review Notes

- 三项改动均为纯展示层：不触碰协议、服务端、状态机与既有回调签名。
- 折叠交互复用既有 `ToolCallBlock` / `ThinkingBlock` 模式，无新增状态机。
- 测试覆盖三处关键回归：工具结果折叠/展开、卡片点击与菜单隔离、输入区统一高度。
- 提交遵循仓库惯例：`style(frontend): ...` 代码提交 + `docs: ...` 文档提交。
