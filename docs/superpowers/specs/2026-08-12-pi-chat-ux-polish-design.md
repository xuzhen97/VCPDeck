# Pi 聊天 UX 打磨设计

## 背景

2026-08-11 视觉优化完成后，实际使用中发现三处影响体验的问题：

1. **工具结果不可折叠**：`Process Details` 内每条 `tool_result` 都完整渲染大段命令输出或代码，长结果挤占对话空间，不利于快速扫读过程详情。
2. **会话卡片点击命中区域过窄**：左侧会话项只有标题文字是可点击按钮，状态圆点、标题两侧空白、时间与消息数区域看起来属于卡片但点击无效，导致经常要点好几次。
3. **输入区控件高度不齐**：文本框 `rows={2}` 高度明显高于两侧 44px 的“添加”/“发送”按钮，且三者各自带边框，视觉上错落、不对齐。

## 目标

- 工具结果默认折叠为标题行（行数 + 首行摘要），展开后显示完整输出，与 Tool Call、thinking 折叠交互保持一致。
- 会话卡片整张可点击选择，保留右侧“⋯”菜单独立，避免误触。
- 输入区“添加”、文本框、“发送”统一高度、统一边框与圆角，焦点态整组高亮。

## 非目标

- 不改 Pi 会话数据结构、消息协议、服务端 API 或运行逻辑。
- 不新增 UI 依赖或动画库。
- 不重做三栏布局、右侧状态面板。
- 不改变 Enter 发送 / Shift+Enter 换行 / Esc 中止等快捷键行为。

## 方案选择

### 工具结果折叠（`pi-message-view.tsx`）

新增 `ToolResultBlock` 组件，模式与现有 `ToolCallBlock`、`ThinkingBlock` 一致：外层语义卡片 + 可点击标题栏 + `aria-expanded`。标题栏展示“工具结果”标签、总行数、第一条非空行摘要（≤100 字符）、展开/收起操作。展开区复用 `pi-chat-fade-in` 动画，`pre` 限制最大高度 24rem 并内部滚动，避免超长输出撑破面板。

### 会话卡片整卡可点击（`pi-session-sidebar.tsx`）

`SessionRow` 的卡片改为单个 `<button>` 包裹全部内容（标题行 + 元信息行），点击任意区域触发 `onSelect`；设置 `min-h-11`（≥44px）与 `cursor-pointer`、focus ring。右侧“⋯”菜单改为绝对定位覆盖在按钮之上，独立触发打开/关闭，不向卡片按钮冒泡，避免误选会话。标题行在有菜单时预留右侧间距（`pr-7`）防止文字被菜单遮挡。

### 输入区对齐（`pi-chat-input.tsx`）

输入容器改为 `items-stretch` + 统一 `h-12`：文本框从 `rows={2}` 改为 `rows={1}` 并与两侧控件同高，去除 textarea 独立边框，由外层容器统一边框；聚焦时外层 `focus-within:ring` 整组高亮。“添加”按钮去掉内层边框与背景，只保留悬停反馈；发送按钮 `rounded-xl` 与容器圆角统一。

## 组件设计

### `ToolResultBlock`

```tsx
<div data-testid="tool-result" className="overflow-hidden rounded-xl border border-border/70 bg-card/60 text-xs text-muted-foreground shadow-sm">
  <button aria-expanded={expanded} onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2 text-left ...">
    <span>工具结果</span>
    <span>{lines} 行</span>
    <span className="truncate font-mono">{首行摘要}</span>
    <span>{expanded ? "收起" : "展开"}</span>
  </button>
  {expanded && (
    <div className="pi-chat-fade-in border-t border-border/60 bg-background/35 p-2.5">
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all ...">{text}</pre>
    </div>
  )}
</div>
```

- 行数 = `text.split(/\r?\n/).length`。
- 首行摘要 = 第一条非空行，trim 后取前 100 字符，超出加 `…`；无文本时显示“无文本输出”。
- 默认折叠（`expanded = false`），与 thinking / Tool Call 折叠行为一致。

### `SessionRow`

```tsx
<div className="group relative">
  <button type="button" onClick={onSelect} aria-label={`打开会话：${title}`}
    className="block min-h-11 w-full cursor-pointer rounded-md px-2 py-1.5 text-left ...">
    <div className="flex items-center gap-2 {isMutable && 'pr-7'}">
      <span className="size-1.5 rounded-full" />  {/* 运行状态点 */}
      <span className="min-w-0 flex-1 truncate ...">{title}</span>
    </div>
    <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px] ...">
      <span>{relativeTime(...)}</span>
      <span>N msgs</span>
    </div>
  </button>
  {isMutable && (
    <div className="absolute right-1.5 top-1" ref={menuRef}>
      <button aria-label="操作" ...>⋯</button>
      {menuOpen && <div role="menu">…重命名/删除…</div>}
    </div>
  )}
</div>
```

- 菜单按钮与卡片按钮是兄弟节点，点击菜单不会触发卡片 `onSelect`。
- `aria-expanded` 保留在菜单按钮上；会话卡片带显式 `aria-label`，便于测试与辅助技术定位。

### `PiChatInput`

- 根容器：`space-y-2 border-t border-border/70 bg-background/55 p-3 backdrop-blur`，统一 12px 内边距。
- 输入行：`flex items-stretch gap-1.5 rounded-2xl border border-border/80 bg-card/80 p-1.5 ... focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20`。
- “添加”：`h-12 shrink-0 rounded-xl px-3`，无独立边框，悬停 `hover:bg-secondary/70`。
- 文本框：`rows={1}`，`h-12 min-h-12 flex-1 resize-none rounded-xl border-0 bg-background/55 px-3 py-3 ... focus:bg-background/80`。
- 发送：`h-12 shrink-0 rounded-xl px-5 shadow-sm`。

## 数据流与行为

- `toolResultsOf()` 的工具结果映射不变；`PiMessageView` 对 `tool_result` 的消息仍输出同一份文本，只是包装成可折叠容器。
- 会话选择回调 `onSelectSession(sessionId)` 签名与调用时机不变；删除当前会话传 `null` 的行为不变。
- `PiChatInput` 的 Enter 发送、Shift+Enter 换行、运行中 Esc 中止、Steer/Follow-up/Compact/中止按钮与附件回调全部不变。

## 错误处理

- 工具结果无文本时显示“无文本输出”占位，不渲染空 `pre`。
- 会话卡片标题为空时回退 `(无标题)`，与现状一致。
- 输入区禁用态（Observer / 未选会话）不变，仅保留 `disabled:opacity-50`。

## 测试计划

- `pi-message-view.test.tsx`：工具结果默认折叠（无 `pre`）、显示行数、点击标题后显示完整结果、`aria-expanded` 切换。
- `pi-session-sidebar.test.tsx`：点击卡片内元信息区域（如 `1 msgs`）触发 `onSelectSession`；点击“⋯”菜单不触发会话选择且菜单正常展开。
- `pi-chat-input.test.tsx`：“添加”/文本框/发送统一 `h-12`，文本框 `rows=1`，外层容器 `p-3`。
- 回归：跑对应测试文件 + 全量前端构建。

## 验收标准

- 工具结果默认只显示一行标题（工具结果 / 行数 / 摘要），展开后完整输出可滚动查看，折叠态不再挤占对话空间。
- 点击会话卡片任意空白、状态点、标题、时间或消息数都能选中会话；点“⋯”只开菜单不切会话。
- “添加”、文本框、发送按钮高度、边框、圆角完全对齐，聚焦时整组高亮。
- 不新增依赖，不改服务端，不改消息协议；所有既有快捷键与回调行为不变。
