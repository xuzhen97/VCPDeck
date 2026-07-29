# Job 执行内容展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任务详情右侧抽屉中安全展示已持久化的命令或脚本，并让脚本正文默认折叠、可交互展开。

**Architecture:** 继续使用 `JobInfo.payload` 作为唯一数据源，只在 `JobDetails` 中读取 `exec` Job 的白名单字段。命令直接使用现有等宽输出样式展示；脚本使用浏览器原生 `<details>/<summary>` 管理折叠状态，不增加后端、SDK、依赖或额外 React 状态。

**Tech Stack:** React、TypeScript、Tailwind CSS、原生 `<details>`、Vitest、Testing Library

## Global Constraints

- 不修改 Job 数据库结构、Server 接口、SDK 或远程执行协议。
- 不展示原始 payload JSON，只展示经过类型检查的 `mode`、`command`、`executable`、`args`、`script`、`cwd`、`timeout`。
- 脚本正文默认折叠，可通过键盘或鼠标展开和收起。
- 现有 `Drawer` 继续使用 `h-full overflow-y-auto`；命令和脚本代码区使用独立最大高度与内部滚动。
- 不增加代码高亮或其他依赖。

---

### Task 1: 在任务详情中展示执行内容

**Files:**

- Modify: `packages/frontend/src/pages/jobs-page.tsx:261-355`
- Test: `packages/frontend/src/pages/jobs-page.test.tsx`

**Interfaces:**

- Consumes: `JobInfo.payload: Record<string, unknown>`，其中执行 Job 使用 `mode: "command" | "script"`。
- Produces: `ExecutionContent({ job }: { job: JobInfo })`，仅为 `type === "exec"` 且 payload 合法的 Job 返回执行内容 JSX，否则返回 `null`。

- [x] **Step 1: 写入失败测试**

在 `packages/frontend/src/pages/jobs-page.test.tsx` 的分页响应中加入一个脚本 Job：

```tsx
job({
  jobId: "script-done",
  clientId: "machine-a-id",
  clientName: "构建服务器",
  status: "done",
  payload: {
    mode: "script",
    executable: "node",
    args: ["--input-type=module"],
    cwd: "D:/workspace",
    timeout: 30_000,
    script: "const token = 'safe-script-text';\nconsole.log('hello');",
    password: "never-render-this-password",
  },
}),
```

增加两个行为断言：

```tsx
await userEvent.click(within(table).getByText("命令：node --version"));
const commandDrawer = screen.getByRole("dialog", { name: "任务详情" });
expect(within(commandDrawer).getByText("执行命令")).toBeVisible();
expect(within(commandDrawer).getByText("node --version")).toBeVisible();
await userEvent.click(within(commandDrawer).getByRole("button", { name: "关闭" }));

await userEvent.click(within(table).getByText("脚本：node"));
const scriptDrawer = screen.getByRole("dialog", { name: "任务详情" });
expect(within(scriptDrawer).getByText("node")).toBeVisible();
expect(within(scriptDrawer).getByText("--input-type=module")).toBeVisible();
expect(within(scriptDrawer).getByText("D:/workspace")).toBeVisible();
expect(within(scriptDrawer).getByText("30 秒")).toBeVisible();
expect(within(scriptDrawer).getByText("2 行")).toBeVisible();
expect(within(scriptDrawer).queryByText(/safe-script-text/)).not.toBeVisible();
expect(scriptDrawer).not.toHaveTextContent("never-render-this-password");
await userEvent.click(within(scriptDrawer).getByText("查看脚本"));
expect(within(scriptDrawer).getByText(/safe-script-text/)).toBeVisible();
```

若 jsdom 对闭合 `<details>` 中内容的可见性判断不稳定，则改为断言 `details` 初始不存在 `open` 属性，点击后具有 `open` 属性；仍须断言敏感字段不在 DOM 中。

- [x] **Step 2: 运行测试并确认正确失败**

运行：

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/jobs-page.test.tsx
```

预期：测试因找不到“执行命令”、“查看脚本”或执行元数据而失败；不是类型错误或测试数据错误。

- [x] **Step 3: 实现最小执行内容组件**

在 `JobDetails` 的元数据网格之后、stdout/stderr 之前渲染：

```tsx
<ExecutionContent job={job} />
```

增加白名单读取与展示：

```tsx
function ExecutionContent({ job }: { job: JobInfo }) {
  if (job.type !== "exec") return null;
  const payload = job.payload;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const timeout = typeof payload.timeout === "number" ? payload.timeout : null;

  if (payload.mode === "command" && typeof payload.command === "string") {
    return (
      <section className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">执行命令</p>
        {(cwd || timeout !== null) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {cwd && <Field label="工作目录" value={cwd} />}
            {timeout !== null && (
              <Field label="超时时间" value={formatTimeout(timeout)} />
            )}
          </div>
        )}
        <CodeBlock value={payload.command} />
      </section>
    );
  }

  if (payload.mode !== "script" || typeof payload.script !== "string") {
    return null;
  }

  const executable =
    typeof payload.executable === "string" ? payload.executable : "未知解释器";
  const args = Array.isArray(payload.args)
    ? payload.args.filter((value): value is string => typeof value === "string")
    : [];
  const lineCount = payload.script.split(/\r?\n/).length;

  return (
    <section className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground">执行脚本</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="解释器" value={executable} />
        <Field label="参数" value={args.length ? args.join(" ") : "—"} />
        {cwd && <Field label="工作目录" value={cwd} />}
        {timeout !== null && (
          <Field label="超时时间" value={formatTimeout(timeout)} />
        )}
        <Field label="脚本行数" value={`${lineCount} 行`} />
      </div>
      <details className="rounded-lg border border-border/70 bg-secondary/20">
        <summary className="cursor-pointer px-4 py-3 font-medium">查看脚本</summary>
        <div className="border-t border-border/70 p-3">
          <CodeBlock value={payload.script} />
        </div>
      </details>
    </section>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
      {value}
    </pre>
  );
}

function formatTimeout(milliseconds: number): string {
  return milliseconds >= 1000
    ? `${milliseconds / 1000} 秒`
    : `${milliseconds} 毫秒`;
}
```

`CodeBlock` 只接收已通过类型检查的命令或脚本文本，不接收整个 payload。

- [x] **Step 4: 运行测试并确认转绿**

运行：

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/jobs-page.test.tsx
```

预期：任务页测试全部通过。

- [x] **Step 5: 运行回归、构建和诊断**

运行：

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/jobs-page.test.tsx src/pages/machine-workspace.test.tsx src/pages/execute-panel.test.tsx
pnpm --filter @vcpdeck/frontend build
git diff --check
```

然后对以下文件运行 LSP 与 pi-lens：

```text
packages/frontend/src/pages/jobs-page.tsx
packages/frontend/src/pages/jobs-page.test.tsx
```

预期：测试、构建和空白检查通过，LSP 与 pi-lens 无阻塞问题。

- [x] **Step 6: 使用 Playwright 验证真实任务**

在 `/jobs` 或 `/machines/:clientId/jobs` 打开命令 Job，确认完整命令可见；打开脚本 Job，确认正文默认折叠，点击“查看脚本”后可见，长内容在代码区内滚动，抽屉本身可滚动。

如果当前环境没有历史脚本 Job，使用页面提交一个无副作用脚本，例如：

```js
console.log("job script detail verification");
```

不得执行破坏性命令。

- [x] **Step 7: 运行 GitNexus 变更分析并提交**

运行 `gitnexus_detect_changes({ scope: "unstaged" })`，确认风险和影响流程符合预期。然后只提交目标文件：

```bash
git add -- packages/frontend/src/pages/jobs-page.tsx packages/frontend/src/pages/jobs-page.test.tsx docs/superpowers/plans/2026-07-29-job-execution-content.md
git commit -m "展示任务执行命令与脚本"
```
