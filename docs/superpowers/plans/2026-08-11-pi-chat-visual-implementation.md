# Pi Chat Visual Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Pi chat middle column readability, loading animation, light/dark color harmony, and bottom input alignment without changing Pi behavior or protocols.

**Architecture:** Keep the existing `PiChatWindow` → `PiMessageView` → `PiChatInput` component shape. Add two tiny CSS animation helpers in `styles.css`, then replace hard-coded Pi chat colors/layout classes with semantic Tailwind token classes. Do not introduce new state machines, dependencies, or data contracts.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, Tailwind CSS v4 semantic tokens from `packages/frontend/src/styles.css`.

## Global Constraints

- Do not change Pi session data structures, message protocol, server API, or runtime logic.
- Do not add UI dependencies or animation libraries.
- Do not redesign the whole three-column workspace, sidebar, or right status panel.
- Use existing Tailwind semantic tokens: `background`, `card`, `border`, `primary`, `secondary`, `muted-foreground`, `ring`, `destructive`.
- Bottom chat input controls must align: attachment button, textarea, and send button share visual height and bottom baseline.
- Respect `prefers-reduced-motion: reduce` for new animation classes.
- GitNexus impact for `PiChatWindow`, `PiMessageView`, and `PiChatInput` returned UNKNOWN because the index does not include these symbols; use LSP references plus tests to bound the change.

---

## File Structure

- Modify `packages/frontend/src/styles.css`
  - Responsibility: global component-layer animation helpers only.
  - Add `pi-chat-fade-in`, `pi-chat-loading-dot`, and reduced-motion override.

- Modify `packages/frontend/src/pi/pi-chat-window.tsx`
  - Responsibility: middle-column timeline, history loading, live thinking, process details, streaming status.
  - Keep `buildTurnGroups()` and `toolResultsOf()` behavior unchanged.

- Modify `packages/frontend/src/pi/pi-message-view.tsx`
  - Responsibility: visual rendering of individual user/assistant/tool messages.
  - Keep Markdown safety and image lazy loading unchanged.

- Modify `packages/frontend/src/pi/pi-chat-input.tsx`
  - Responsibility: bottom input controls, running actions, attachment chips, send textarea.
  - Keep send/steer/follow-up/abort/compact callbacks unchanged.

- Modify tests:
  - `packages/frontend/src/pi/pi-chat-window.test.tsx`
  - `packages/frontend/src/pi/pi-message-view.test.tsx`
  - `packages/frontend/src/pi/pi-chat-input.test.tsx`

---

### Task 1: Add Pi chat animation helpers

**Files:**

- Modify: `packages/frontend/src/styles.css`
- Test: no dedicated CSS unit test; verified through component rendering and LSP/build checks.

**Interfaces:**

- Produces CSS classes used by later tasks:
  - `pi-chat-fade-in`: CSS animation class for expanded panels and status blocks.
  - `pi-chat-loading-dot`: CSS animation class for one loading dot.

- [ ] **Step 1: Add animation classes**

Add this block inside existing `@layer components { ... }`, near the existing `storage-*` animation helpers:

```css
 .pi-chat-fade-in { animation: pi-chat-fade-in 180ms ease-out; }
 .pi-chat-loading-dot {
  display: inline-block;
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 999px;
  background: var(--primary);
  animation: pi-chat-loading-dot 1.1s infinite ease-in-out;
 }
 .pi-chat-loading-dot:nth-child(2) { animation-delay: 120ms; }
 .pi-chat-loading-dot:nth-child(3) { animation-delay: 240ms; }
 @keyframes pi-chat-fade-in {
  from { opacity: 0.72; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
 }
 @keyframes pi-chat-loading-dot {
  0%, 80%, 100% { opacity: 0.32; transform: scale(0.72); }
  40% { opacity: 1; transform: scale(1); }
 }
```

Extend the existing reduced-motion block to include:

```css
  .pi-chat-fade-in,
  .pi-chat-loading-dot { animation: none; }
```

- [ ] **Step 2: Run style/type diagnostics**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec tsc --noEmit
```

Expected: PASS. If unrelated pre-existing errors appear, record them and run `lsp_diagnostics` on `packages/frontend/src/styles.css` plus changed TSX files after later tasks.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/styles.css
git commit -m "style(frontend): add Pi chat animation helpers"
```

---

### Task 2: Restyle Pi chat window loading, process details, and streaming status

**Files:**

- Modify: `packages/frontend/src/pi/pi-chat-window.tsx`
- Modify: `packages/frontend/src/pi/pi-chat-window.test.tsx`

**Interfaces:**

- Consumes CSS classes from Task 1: `pi-chat-fade-in`, `pi-chat-loading-dot`.
- Keeps exported component signature unchanged:

```ts
export function PiChatWindow(props: {
 state: PiSessionState;
 info: { id: string; name: string; firstMessage: string | null } | null;
 onLoadMore: () => void;
 onImageLoad?: (block: PiImagePlaceholder) => void;
 imageUrls?: Record<string, string>;
}): JSX.Element
```

- [ ] **Step 1: Add failing tests for visible behavior**

In `packages/frontend/src/pi/pi-chat-window.test.tsx`, add two tests:

```tsx
it("加载历史期间显示动画加载点", () => {
 render(
  <PiChatWindow
   state={state({ messages: [], status: "loading" })}
   info={null}
   onLoadMore={() => {}}
  />,
 );

 const loading = screen.getByTestId("pi-history-loading");
 expect(loading.textContent).toContain("正在加载历史消息");
 expect(loading.querySelectorAll(".pi-chat-loading-dot")).toHaveLength(3);
});

it("运行中状态显示动画处理提示", () => {
 render(<PiChatWindow state={state()} info={null} onLoadMore={() => {}} />);

 const indicator = screen.getByTestId("streaming-indicator");
 expect(indicator.textContent).toContain("Pi 正在处理");
 expect(indicator.querySelectorAll(".pi-chat-loading-dot")).toHaveLength(3);
});
```

Keep the existing loading test; update it only if duplicate coverage becomes noisy.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-chat-window.test.tsx
```

Expected: FAIL because `.pi-chat-loading-dot` elements are not rendered and streaming text is still `运行中…`.

- [ ] **Step 3: Add a tiny loading dots helper in `pi-chat-window.tsx`**

Near `toolResultsOf`, add:

```tsx
function LoadingDots() {
 return (
  <span className="inline-flex items-center gap-1.5" aria-hidden="true">
   <span className="pi-chat-loading-dot" />
   <span className="pi-chat-loading-dot" />
   <span className="pi-chat-loading-dot" />
  </span>
 );
}
```

- [ ] **Step 4: Restyle `ProcessDetails` minimally**

Replace the outer `ProcessDetails` markup classes with semantic card classes. Preserve `expanded` behavior and button text. The expanded content must use `pi-chat-fade-in`.

Use this class shape:

```tsx
<div className="my-2 overflow-hidden rounded-2xl border border-border/70 bg-card/65 text-xs shadow-sm backdrop-blur pi-chat-fade-in">
```

Header button class:

```tsx
className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-secondary/45"
```

Title count/tool summary classes:

```tsx
<span className="font-semibold text-foreground">Process Details</span>
<span className="text-muted-foreground">...</span>
<span className="ml-auto min-w-0 truncate text-muted-foreground">...</span>
<span className="shrink-0 text-primary">...</span>
```

Expanded container class:

```tsx
className="pi-chat-fade-in space-y-1.5 border-t border-border/60 bg-background/35 px-2.5 py-2"
```

- [ ] **Step 5: Restyle `LiveThinkingBlock` consistently**

Keep behavior unchanged. Use semantic card classes and `pi-chat-fade-in` on the expanded `pre`:

```tsx
<div className="my-2 overflow-hidden rounded-2xl border border-border/70 bg-card/65 text-xs shadow-sm backdrop-blur" data-testid="live-thinking-block">
```

Expanded `pre` class:

```tsx
className="pi-chat-fade-in max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-background/35 px-3 py-2 text-muted-foreground"
```

- [ ] **Step 6: Restyle loading, empty, error, and streaming status in `PiChatWindow`**

History loading should render:

```tsx
<div className="flex py-16 justify-center" data-testid="pi-history-loading">
 <div className="pi-chat-fade-in inline-flex items-center gap-3 rounded-full border border-border/70 bg-card/70 px-4 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur">
  <LoadingDots />
  <span>正在加载历史消息…</span>
 </div>
</div>
```

Error should use destructive semantic style:

```tsx
<div className="rounded-xl border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs text-destructive">
```

Streaming indicator should render:

```tsx
<div className="pi-chat-fade-in inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/70 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur" data-testid="streaming-indicator">
 <LoadingDots />
 <span>Pi 正在处理…</span>
</div>
```

- [ ] **Step 7: Run tests and verify green**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-chat-window.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/pi/pi-chat-window.tsx packages/frontend/src/pi/pi-chat-window.test.tsx
git commit -m "style(frontend): improve Pi chat process states"
```

---

### Task 3: Restyle individual Pi messages and tool calls

**Files:**

- Modify: `packages/frontend/src/pi/pi-message-view.tsx`
- Modify: `packages/frontend/src/pi/pi-message-view.test.tsx`

**Interfaces:**

- Keeps exported `PiMessageView` props unchanged.
- Uses no new runtime dependencies.

- [ ] **Step 1: Add failing behavior test for assistant card and tool semantic rendering**

In `packages/frontend/src/pi/pi-message-view.test.tsx`, add:

```tsx
it("assistant 文本和工具结果使用语义卡片容器", () => {
 const assistant: PiMessage = {
  id: "a1",
  role: "assistant",
  content: [{ type: "text", text: "answer" }],
 };
 const result: PiMessage = {
  id: "r1",
  role: "tool_result",
  toolCallId: "t1",
  content: [{ type: "text", text: "result text" }],
 };

 const { rerender } = render(<PiMessageView message={assistant} />);
 expect(screen.getByTestId("assistant-message")).toHaveClass("bg-card/70");
 rerender(<PiMessageView message={result} />);
 expect(screen.getByTestId("tool-result")).toHaveClass("bg-card/60");
});
```

This intentionally checks one stable semantic class per container. It catches a regression back to unwrapped/raw assistant text or fixed dark tool result blocks.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-message-view.test.tsx
```

Expected: FAIL because current assistant message has no card class and tool result uses zinc classes.

- [ ] **Step 3: Restyle user message**

Replace user message wrapper class with:

```tsx
className="rounded-2xl bg-gradient-to-br from-primary to-primary/80 px-3.5 py-2.5 text-primary-foreground shadow-lg shadow-primary/20"
```

Keep `data-testid="user-message"` and content rendering unchanged.

- [ ] **Step 4: Restyle assistant message wrapper**

Replace assistant wrapper:

```tsx
<div data-testid="assistant-message">
```

with:

```tsx
<div
 className="rounded-2xl border border-border/70 bg-card/70 px-3.5 py-2.5 shadow-sm backdrop-blur"
 data-testid="assistant-message"
>
```

Do not wrap each block separately.

- [ ] **Step 5: Restyle `ToolCallBlock`**

Replace outer tool call class with:

```tsx
className="my-2 overflow-hidden rounded-xl border border-border/70 bg-card/70 text-xs shadow-sm"
```

Header button:

```tsx
className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-secondary/45"
```

Tool name:

```tsx
<span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">{block.toolName}</span>
```

Input summary:

```tsx
<span className="min-w-0 truncate text-muted-foreground">{summarizeInput(block.input)}</span>
```

Expanded container:

```tsx
className="pi-chat-fade-in border-t border-border/60 bg-background/40 px-3 py-2"
```

Input/result `pre` classes:

```tsx
className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/45 p-2 text-muted-foreground"
```

Result label:

```tsx
<div className="text-muted-foreground">结果</div>
```

- [ ] **Step 6: Restyle tool result message**

Replace tool_result wrapper with:

```tsx
<div
 className="rounded-xl border border-border/70 bg-card/60 px-2.5 py-2 text-xs text-muted-foreground shadow-sm"
 data-testid="tool-result"
>
```

`pre` class:

```tsx
className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/35 p-2"
```

- [ ] **Step 7: Run tests and verify green**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-message-view.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/pi/pi-message-view.tsx packages/frontend/src/pi/pi-message-view.test.tsx
git commit -m "style(frontend): improve Pi message readability"
```

---

### Task 4: Align and restyle the Pi chat input area

**Files:**

- Modify: `packages/frontend/src/pi/pi-chat-input.tsx`
- Modify: `packages/frontend/src/pi/pi-chat-input.test.tsx`

**Interfaces:**

- Keeps all callbacks and status behavior unchanged.
- `PiChatInput` still accepts the same props.

- [ ] **Step 1: Add failing alignment behavior test**

In `packages/frontend/src/pi/pi-chat-input.test.tsx`, add:

```tsx
it("输入区附件按钮、文本框和发送按钮使用统一高度类", () => {
 renderInput();

 expect(screen.getByText("🖼️ 添加")).toHaveClass("h-11");
 expect(screen.getByRole("textbox", { name: "Pi 输入" })).toHaveClass("min-h-11");
 expect(screen.getByRole("button", { name: "发送" })).toHaveClass("h-11");
});
```

This catches the specific visual regression requested by the user: mismatched control heights.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-chat-input.test.tsx
```

Expected: FAIL because current controls do not share `h-11` / `min-h-11`.

- [ ] **Step 3: Restyle root and running controls**

Change root wrapper to:

```tsx
<div className="space-y-2 border-t border-border/70 bg-background/35 px-3 py-3 backdrop-blur">
```

Running controls wrapper:

```tsx
<div className="flex flex-wrap items-center gap-1.5 text-xs">
```

Mode text:

```tsx
<span className="ml-1 rounded-full bg-secondary/60 px-2 py-1 text-muted-foreground">
```

- [ ] **Step 4: Restyle attachment chips**

Attachment list wrapper:

```tsx
<div className="flex flex-wrap gap-1.5"
```

Chip class:

```tsx
className="flex items-center gap-1 rounded-full border border-border/70 bg-card/65 px-2 py-1 text-[10px] text-muted-foreground shadow-sm"
```

Remove button class:

```tsx
className="rounded-full px-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
```

- [ ] **Step 5: Align input row controls**

Input row wrapper:

```tsx
<div className="flex items-end gap-2 rounded-2xl border border-border/70 bg-card/70 p-2 shadow-sm backdrop-blur focus-within:ring-2 focus-within:ring-ring/30">
```

Attachment label class:

```tsx
className="flex h-11 shrink-0 cursor-pointer items-center rounded-xl border border-border/70 bg-background/60 px-3 text-xs text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
```

Textarea class:

```tsx
className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-background/75 px-3 py-2 text-sm leading-6 transition placeholder:text-muted-foreground/80 focus:border-ring focus:outline-none disabled:opacity-50"
```

Send button should explicitly align to `h-11`:

```tsx
<Button type="button" className="h-11 shrink-0 px-5" disabled={!canSend} onClick={submit}>
```

- [ ] **Step 6: Run tests and verify green**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-chat-input.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/pi/pi-chat-input.tsx packages/frontend/src/pi/pi-chat-input.test.tsx
git commit -m "style(frontend): align Pi chat input controls"
```

---

### Task 5: Final verification and scoped regression check

**Files:**

- Verify only; no code changes expected.

**Interfaces:**

- Confirms the full Pi chat visual change is behavior-safe.

- [ ] **Step 1: Run LSP diagnostics for touched files**

Run through Pi/lens tool or command equivalent:

```text
lsp_diagnostics paths=[
  "packages/frontend/src/styles.css",
  "packages/frontend/src/pi/pi-chat-window.tsx",
  "packages/frontend/src/pi/pi-chat-window.test.tsx",
  "packages/frontend/src/pi/pi-message-view.tsx",
  "packages/frontend/src/pi/pi-message-view.test.tsx",
  "packages/frontend/src/pi/pi-chat-input.tsx",
  "packages/frontend/src/pi/pi-chat-input.test.tsx"
] severity=error serverScope=primary
```

Expected: 0 diagnostics.

- [ ] **Step 2: Run focused Pi tests**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run \
  src/pi/pi-chat-window.test.tsx \
  src/pi/pi-message-view.test.tsx \
  src/pi/pi-chat-input.test.tsx
```

Expected: all listed test files pass.

- [ ] **Step 3: Run full frontend test if time allows**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run
```

Expected: all frontend tests pass. Existing unrelated DOM nesting warnings in dialog tests may appear; do not fix them in this task.

- [ ] **Step 4: Check affected changes**

Run:

```text
gitnexus_detect_changes(repo="VCPDeck", scope="all")
```

Expected: changed files include only the intended Pi chat files, `styles.css`, tests, and already-existing unrelated workspace changes. Record if GitNexus still reports unrelated pre-existing changes.

- [ ] **Step 5: Final commit if verification required a small fix**

Only if Step 1-4 required a small follow-up fix:

```bash
git add packages/frontend/src/styles.css packages/frontend/src/pi/pi-chat-window.tsx packages/frontend/src/pi/pi-chat-window.test.tsx packages/frontend/src/pi/pi-message-view.tsx packages/frontend/src/pi/pi-message-view.test.tsx packages/frontend/src/pi/pi-chat-input.tsx packages/frontend/src/pi/pi-chat-input.test.tsx
git commit -m "test(frontend): verify Pi chat visual polish"
```

If no code changed in this task, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: all approved requirements map to tasks: semantic colors (Tasks 2-3), loading animation (Tasks 1-2), input alignment (Task 4), no protocol/server changes (Global Constraints), tests/diagnostics (Task 5).
- Placeholder scan: no unresolved placeholder entries. Every code-changing step names exact files, classes, commands, and expected results.
- Type consistency: exported component props remain unchanged across all tasks; new CSS class names are defined once in Task 1 and consumed later exactly as `pi-chat-fade-in` / `pi-chat-loading-dot`.
