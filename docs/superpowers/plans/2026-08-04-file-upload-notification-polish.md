# 文件上传成功提示与任务通知美化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为文件页上传成功提示增加当前会话内的 X 关闭能力，并在不改变任务业务逻辑的前提下美化右上角任务通知面板。

**Architecture:** 保留 `FilesPanel` 和 `NotificationBell` 现有状态、轮询、下载和错误处理逻辑，只调整各自的展示 JSX 与 Tailwind class。文件成功提示通过已有 `uploadState` 清空实现关闭；通知面板从已有 `active` 与 `finished` 状态派生“进行中”和“最近结果”分组，不新增全局状态、API 或持久化。

**Tech Stack:** React 18、TypeScript strict、Tailwind CSS v4、lucide-react、Vitest、Testing Library、pnpm workspace。

## Global Constraints

- 关闭成功提示只影响当前 `FilesPanel` 挂载会话，不写入本地存储，也不影响导入结果。
- 保持现有任务轮询、下载、失败信息与清除逻辑不变。
- 不增加依赖，不修改 API、数据库或共享协议。
- 使用 `lucide-react` 图标，不使用 emoji 或新增图标依赖。
- 图标按钮可操作区域至少为 44×44px，并提供清晰的无障碍名称和焦点反馈。
- 交互过渡只使用 opacity/transform，约 150–200ms；尊重 `prefers-reduced-motion`。
- 使用现有主题语义色，不在组件中引入新的原始色值。
- 先写失败测试并确认因缺少目标行为失败，再写最小实现。
- Git commit 使用简体中文。

## 影响与风险

GitNexus 影响分析结果：

- `FilesPanel` 上游风险为 **HIGH**：直接被 `Workspace` 和 `files-panel.test.tsx` 使用，并参与 App/Workspace 执行流。此次只修改组件内部展示和局部状态清空，不修改导入接口；完成后必须跑文件页测试和前端构建。
- `NotificationBell` 上游风险为 **LOW**：直接被 `ConsoleShell` 和对应测试使用。此次保留轮询与状态处理，只修改展示结构和图标。

---

### Task 1: 文件页成功提示可关闭

**Files:**

- Modify: `packages/frontend/src/pages/files-panel.test.tsx`
- Modify: `packages/frontend/src/pages/files-panel.tsx:1-55,约400-455`

**Interfaces:**

- Consumes: `FilesPanel` 已有的 `uploadState` 和 `setUploadState`。
- Produces: 成功上传时出现 `aria-label="关闭上传提示"` 的按钮；点击后只移除成功提示。

- [ ] **Step 1: 写失败测试**

在 `describe("FilesPanel")` 中新增测试，复用现有 `renderFiles()`，验证成功上传提示可以关闭：

```tsx
it("closes the completed upload notice for the current page", async () => {
 const files = renderFiles();
 await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
 await userEvent.upload(
  screen.getByLabelText("选择上传文件"),
  new File(["hello"], "report.txt", { type: "text/plain" }),
 );

 expect(await screen.findByText("上传完成：report.txt")).toBeVisible();
 await userEvent.click(
  screen.getByRole("button", { name: "关闭上传提示" }),
 );

 expect(screen.queryByText("上传完成：report.txt")).not.toBeInTheDocument();
 expect(files.completeUpload).toHaveBeenCalledWith(
  "upload-job",
  { uploadedBytes: 5 },
  expect.any(AbortSignal),
 );
});
```

测试同时确认关闭只是移除 UI，不会撤销已经完成的导入调用。

- [ ] **Step 2: 运行测试确认按预期失败**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/files-panel.test.tsx
```

Expected: FAIL，找不到名称为 `关闭上传提示` 的按钮；现有上传逻辑相关测试仍应通过。

- [ ] **Step 3: 写最小实现**

在 `files-panel.tsx` 的图标导入中加入 `CheckCircle2`；成功提示 JSX 保持现有文字和状态逻辑，只增加布局、成功图标与关闭按钮：

```tsx
const isUploadDone = uploadState.phase === "done";

<div
 role={uploadState.phase === "error" ? "alert" : "status"}
 className={`mb-3 rounded border px-3 py-2 text-sm ${
  uploadState.phase === "error"
   ? "border-red-500/40 bg-red-500/10 text-red-400"
   : isUploadDone
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : "border-border bg-secondary/30 text-muted-foreground"
 }`}
>
 <div className="flex items-center justify-between gap-2">
  <div className="flex min-w-0 items-center gap-2">
   {isUploadDone && <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />}
   <span className="min-w-0 break-all">
    {uploadState.phase === "uploading" && `正在上传 ${uploadState.filename}`}
    {uploadState.phase === "importing" && `正在写入远程目录：${uploadState.filename}`}
    {isUploadDone && `上传完成：${uploadState.filename}`}
    {uploadState.phase === "error" && `上传失败：${uploadState.message ?? uploadState.filename}`}
   </span>
  </div>
  {isUploadDone && (
   <Button
    type="button"
    size="icon"
    variant="ghost"
    className="size-11 min-h-11 shrink-0"
    aria-label="关闭上传提示"
    title="关闭上传提示"
    onClick={() => setUploadState(null)}
   >
    <X aria-hidden="true" className="size-4" />
   </Button>
  )}
 </div>
 {uploadState.phase !== "error" && !isUploadDone && (
  <progress
   className="mt-2 h-1.5 w-full"
   max={uploadState.total || undefined}
   value={uploadState.loaded}
  />
 )}
</div>
```

实际实现时复用现有四种状态文字，避免为了视觉改动改变上传状态文案；只把原来的文本包进布局容器，并把 `message` 替换为现有四个条件表达式。

成功关闭按钮必须只调用 `setUploadState(null)`，不能调用 abort、refresh 或任何 SDK 方法。上传中和错误状态不得出现该按钮。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/files-panel.test.tsx
```

Expected: PASS，包含新增关闭测试和该文件全部既有测试。

- [ ] **Step 5: 提交文件页改动**

```bash
git add packages/frontend/src/pages/files-panel.tsx packages/frontend/src/pages/files-panel.test.tsx
git commit -m "feat: 支持关闭文件上传成功提示"
```

---

### Task 2: 任务通知面板分组与视觉层次

**Files:**

- Modify: `packages/frontend/src/components/notification-bell.test.tsx`
- Modify: `packages/frontend/src/components/notification-bell.tsx:1-254`

**Interfaces:**

- Consumes: `NotificationBell` 现有 `active`、`finished`、`poll`、`DownloadButton` 和 `ProgressBar`。
- Produces: 现有任务通知行为不变；面板按“进行中”和“最近结果”分组，终态清除按钮保留 `清除通知 {jobId}` 无障碍名称。

- [ ] **Step 1: 写失败测试**

在 `notification-bell.test.tsx` 中新增一个同时包含进行中和已完成任务的测试。列表第一次返回两个进行中任务，第二次只返回仍在运行的任务；`get` 返回另一个已完成任务：

```tsx
it("按进行中和最近结果分组展示任务", async () => {
 const running = job({
  jobId: "active-1",
  type: "file.import",
  payload: { targetPath: "uploads/a.txt" },
  progress: { loaded: 2, total: 5 },
 });
 const finished = job({
  jobId: "active-2",
  type: "file.export",
  status: "done" as JobInfo["status"],
  payload: { path: "D:\\done.zip" },
  result: { fileId: "f1", key: "download-key", size: 1, sha256: "x" },
  finishedAt: "2026-08-01T00:01:00.000Z",
 });
 const list = vi
  .fn()
  .mockResolvedValueOnce({
   data: [running, job({ jobId: "active-2" })],
   total: 2,
   page: 1,
   pageSize: 5,
   totalPages: 1,
  })
  .mockResolvedValueOnce({
   data: [running],
   total: 1,
   page: 1,
   pageSize: 5,
   totalPages: 1,
  });
 renderBell({
  jobs: { list, get: vi.fn().mockResolvedValue(finished) },
  storage: { downloadUrl: vi.fn().mockReturnValue("/download") },
 });

 await vi.advanceTimersByTimeAsync(0);
 await act(async () => {});
 await vi.advanceTimersByTimeAsync(500);
 await act(async () => {});
 fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

 expect(screen.getByRole("heading", { name: "进行中" })).toBeVisible();
 expect(screen.getByRole("heading", { name: "最近结果" })).toBeVisible();
 expect(
  screen.getByRole("button", { name: "清除通知 active-2" }),
 ).toBeVisible();
});
```

The test must use a `get` mock returning `finished`; this follows the existing finished-job detection flow and does not test implementation details of polling.

- [ ] **Step 2: 运行测试确认按预期失败**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/components/notification-bell.test.tsx
```

Expected: FAIL，当前面板没有 `进行中` / `最近结果` heading；现有轮询、下载和失败清除测试应继续通过。

- [ ] **Step 3: 写最小展示实现**

在 `notification-bell.tsx` 中从 `lucide-react` 增加 `CheckCircle2`、`CircleAlert`、`CircleX`、`LoaderCircle` 和 `X`，不改变 `poll`、`active`、`finished`、`DownloadButton` 或 `ProgressBar` 的逻辑。

将弹层改为以下结构：

```tsx
<div
 role="dialog"
 aria-label="任务通知"
 className="absolute right-0 top-11 z-50 w-[min(22.5rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-2xl backdrop-blur-xl"
>
 <header className="flex items-center justify-between border-b border-border/70 px-4 py-3">
  <div className="flex items-center gap-2">
   <Bell aria-hidden="true" className="size-4 text-primary" />
   <h2 className="text-sm font-semibold">任务通知</h2>
  </div>
  {active.length > 0 && (
   <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
    {active.length} 个进行中
   </span>
  )}
 </header>
 <div className="max-h-[min(32rem,calc(100dvh-6rem))] overflow-y-auto p-3">
  {/* empty state or grouped sections */}
 </div>
</div>
```

在 body 内按已有数组条件渲染：

- 无任务：`暂无任务` 空状态。
- `active.length > 0`：渲染 `<h3>进行中</h3>`，每个 active item 保留原任务类型、文件名和 `ProgressBar`，外层使用 `rounded-xl border border-primary/20 bg-primary/5 p-3`；任务图标使用 `LoaderCircle`，并使用 `motion-safe:animate-spin`，避免在 reduced-motion 下强制旋转。
- `finished.length > 0`：渲染 `<h3>最近结果</h3>`，每个 finished item 保留现有成功/失败/取消文案、错误信息和下载按钮；根据状态选择 `CheckCircle2`、`CircleAlert` 或 `CircleX`，外层使用轻量状态边框/背景。
- 完成项清除按钮保留现有 `aria-label={`清除通知 ${item.jobId}`}` 和过滤逻辑，只把文字 `清除` 换成 `X` 图标，并设置 `size="icon"`、`className="size-9 min-h-9 shrink-0"`、`title="清除通知"`。

分组标题和卡片只负责展示，不加入“全部清除”、持久化、自动关闭或新的轮询状态。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/components/notification-bell.test.tsx
```

Expected: PASS，新增分组测试、已有进行中进度测试、下载测试和失败清除测试全部通过。

- [ ] **Step 5: 提交通知面板改动**

```bash
git add packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx
git commit -m "style: 美化右上角任务通知"
```

---

### Task 3: 全量验证与变更范围检查

**Files:**

- Read/verify: `packages/frontend/src/pages/files-panel.tsx`
- Read/verify: `packages/frontend/src/pages/files-panel.test.tsx`
- Read/verify: `packages/frontend/src/components/notification-bell.tsx`
- Read/verify: `packages/frontend/src/components/notification-bell.test.tsx`
- Read/verify: `packages/frontend/src/styles.css`

**Interfaces:**

- Consumes: Task 1 和 Task 2 已提交的组件与测试。
- Produces: 前端测试、类型检查、构建和诊断均通过；Git 变更只包含本次需求相关文件与已提交设计/计划文档。

- [ ] **Step 1: 运行两组定向测试**

Run:

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/files-panel.test.tsx src/components/notification-bell.test.tsx
```

Expected: PASS，输出中不出现测试失败、未处理异常或 React 警告。

- [ ] **Step 2: 运行前端完整测试**

Run:

```bash
pnpm --filter @vcpdeck/frontend test
```

Expected: PASS，确保 `ConsoleShell`、机器工作区和其他页面未受全局通知组件展示改动影响。

- [ ] **Step 3: 运行前端构建**

Run:

```bash
pnpm --filter @vcpdeck/frontend build
```

Expected: TypeScript 检查和 Vite 构建均成功。

- [ ] **Step 4: 运行编辑文件诊断**

Run `lens_diagnostics` with `mode: "all"` and paths:

```text
packages/frontend/src/pages/files-panel.tsx
packages/frontend/src/pages/files-panel.test.tsx
packages/frontend/src/components/notification-bell.tsx
packages/frontend/src/components/notification-bell.test.tsx
```

Expected: 没有新增 blocking error；若只有预存 warning，记录其文件、规则和是否与本次改动无关，不通过添加无意义代码规避。

- [ ] **Step 5: 检查 GitNexus 变更范围**

Run `gitnexus_detect_changes` with `scope: "all"`。

Expected：受影响符号集中在 `FilesPanel`、`NotificationBell` 及其测试；执行流只涉及文件页/Workspace 和全局 ConsoleShell 的预期 UI 调用链，不出现 server、SDK、数据库或协议文件。

- [ ] **Step 6: 检查最终工作区**

```bash
git status --short
git diff HEAD~2..HEAD --stat
```

Expected：两个功能提交均存在；没有临时 mockup、构建产物、未追踪日志或无关文件。若 Task 1/Task 2 的 commit 数量因已有提交调整，改用 `git diff <功能开始前提交>..HEAD --stat` 验证同样范围。

## 完成标准

- 文件页上传完成后显示成功图标和关闭 X；点击 X 后提示从当前页面消失，上传完成调用仍保留。
- 上传中、失败、覆盖冲突、目录刷新行为不变。
- 通知面板显示标题区、进行中/最近结果分组、状态图标、可滚动卡片和紧凑清除按钮。
- 下载按钮、错误信息、清除通知、进行中进度和轮询节奏均保持通过既有测试。
- 前端完整测试、构建和编辑文件诊断通过。
- GitNexus 变更检测确认没有超出约定文件范围。
