# Pi 会话任务「标记完成」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在任务列表页与详情页为 Pi 会话（`agent.session`）任务提供「标记完成」操作，复用现有 `pi.complete` 接口。

**Architecture:** 新增一个自包含组件 `MarkDoneButton`（渲染条件 + 确认框 + 调用 SDK），在任务列表行、列表抽屉详情、独立详情页三处挂载；不修改后端。

**Tech Stack:** React 19 + TypeScript、vitest + @testing-library/react（jsdom）、radix-ui dialog、@vcpdeck/sdk。

## Global Constraints

- 文案与注释使用简体中文；标识符、协议字段使用英文
- 只处理 `agent.session` 任务；`agent.run` 遗留类型不处理
- 不改后端；不传 runId（后端自动取当前 runId）
- 错误展示沿用对话框内红字，不引入 toast
- 测试命令：`pnpm --filter @vcpdeck/frontend test`；构建命令：`pnpm --filter @vcpdeck/frontend build`
- 导入路径沿用现有 `@/` alias（如 `@/components/ui/button`）

---

### Task 1: MarkDoneButton 组件（TDD）

**Files:**

- Create: `packages/frontend/src/components/mark-done-button.tsx`
- Test: `packages/frontend/src/components/mark-done-button.test.tsx`

**Interfaces:**

- Consumes: `JobInfo`（`@vcpdeck/shared`）、`useSdk()`（`@/api/context`）、`Button`（`@/components/ui/button`）、`Dialog/DialogContent/DialogDescription/DialogTitle`（`@/components/ui/dialog`）、`sdk.pi.complete(clientId: string, sessionId: string, runId?: string, signal?: AbortSignal)`
- Produces: `MarkDoneButton({ job: JobInfo; onChanged: () => void; stopPropagation?: boolean; size?: "sm" | "default" })` —— 非 `agent.session` 或状态为 `done`/`cancelled` 时返回 `null`；否则渲染「标记完成」按钮 + 确认对话框

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/components/mark-done-button.test.tsx`：

```tsx
import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { JobInfo } from "@vcpdeck/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { MarkDoneButton } from "./mark-done-button";

function sessionJob(overrides: Partial<JobInfo> = {}): JobInfo {
 return {
  jobId: "session-1",
  clientId: "client-1",
  clientName: null,
  type: "agent.session",
  status: "idle" as JobInfo["status"],
  payload: {},
  result: null,
  progress: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  createdByIdentityId: "identity-1",
  createdByName: "管理员",
  createdVia: "web",
  ...overrides,
 };
}

function renderButton(job: JobInfo, onChanged = vi.fn()) {
 const complete = vi.fn().mockResolvedValue({});
 const client = { pi: { complete } } as unknown as VcpDeckClient;
 const view = render(
  <SdkProvider client={client}>
   <MarkDoneButton job={job} onChanged={onChanged} />
  </SdkProvider>,
 );
 return {
  complete,
  onChanged,
  rerender: (next: JobInfo) =>
   view.rerender(
    <SdkProvider client={client}>
     <MarkDoneButton job={next} onChanged={onChanged} />
    </SdkProvider>,
   ),
 };
}

describe("MarkDoneButton", () => {
 it("非 agent.session 任务不渲染", () => {
  renderButton(sessionJob({ type: "exec" }));
  expect(
   screen.queryByRole("button", { name: "标记完成" }),
  ).not.toBeInTheDocument();
 });

 it("done 或 cancelled 会话不渲染", () => {
  const { rerender } = renderButton(
   sessionJob({ status: "done" as JobInfo["status"] }),
  );
  expect(
   screen.queryByRole("button", { name: "标记完成" }),
  ).not.toBeInTheDocument();
  rerender(sessionJob({ status: "cancelled" as JobInfo["status"] }));
  expect(
   screen.queryByRole("button", { name: "标记完成" }),
  ).not.toBeInTheDocument();
 });

 it("确认后调用 pi.complete 并触发 onChanged", async () => {
  const { complete, onChanged } = renderButton(
   sessionJob({ status: "waiting_input" as JobInfo["status"] }),
  );
  await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
  await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
  expect(complete).toHaveBeenCalledWith(
   "client-1",
   "session-1",
   undefined,
   expect.any(AbortSignal),
  );
  expect(onChanged).toHaveBeenCalled();
 });

 it("失败时对话框保持打开并显示错误", async () => {
  const { complete } = renderButton(sessionJob());
  complete.mockRejectedValueOnce(new Error("PI_CONTROL_FORBIDDEN"));
  await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
  await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
   "PI_CONTROL_FORBIDDEN",
  );
  expect(screen.getByRole("button", { name: "确认完成" })).toBeEnabled();
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm --filter @vcpdeck/frontend test mark-done-button`
预期：FAIL，`Cannot find module './mark-done-button'`

- [ ] **Step 3: 写最小实现**

创建 `packages/frontend/src/components/mark-done-button.tsx`：

```tsx
import type { JobInfo } from "@vcpdeck/shared";
import { useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";
import {
 Dialog,
 DialogContent,
 DialogDescription,
 DialogTitle,
} from "@/components/ui/dialog";

/**
 * 将 Pi 会话任务标记为已完成。
 * running / waiting_input 等活跃回合会先被后端中止；error 会话会清理错误字段。
 */
export function MarkDoneButton({
 job,
 onChanged,
 stopPropagation = false,
 size = "default",
}: {
 job: JobInfo;
 onChanged: () => void;
 stopPropagation?: boolean;
 size?: "sm" | "default";
}) {
 const sdk = useSdk();
 const [open, setOpen] = useState(false);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string>();
 const controller = useRef<AbortController>();
 useEffect(() => () => controller.current?.abort(), []);

 if (
  job.type !== "agent.session" ||
  job.status === "done" ||
  job.status === "cancelled"
 ) {
  return null;
 }

 const complete = async () => {
  controller.current?.abort();
  const next = new AbortController();
  controller.current = next;
  setBusy(true);
  setError(undefined);
  try {
   await sdk.pi.complete(job.clientId, job.jobId, undefined, next.signal);
   setOpen(false);
   onChanged();
  } catch (reason) {
   if (!next.signal.aborted) {
    setError(
     reason instanceof Error ? reason.message : String(reason),
    );
   }
  } finally {
   if (!next.signal.aborted) setBusy(false);
  }
 };

 return (
  <>
   <Button
    size={size}
    variant="outline"
    onClick={(event) => {
     if (stopPropagation) event.stopPropagation();
     setOpen(true);
    }}
   >
    标记完成
   </Button>
   <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent>
     <DialogTitle>标记任务为已完成？</DialogTitle>
     <DialogDescription>
      若回合仍在运行，将先中止当前回合。
     </DialogDescription>
     {error && (
      <p role="alert" className="mt-4 text-sm text-red-400">
       {error}
      </p>
     )}
     <div className="mt-6 flex justify-end gap-3">
      <Button
       type="button"
       variant="ghost"
       disabled={busy}
       onClick={() => setOpen(false)}
      >
       取消
      </Button>
      <Button type="button" disabled={busy} onClick={complete}>
       {busy ? "处理中…" : "确认完成"}
      </Button>
     </div>
    </DialogContent>
   </Dialog>
  </>
 );
}
```

- [ ] **Step 4: 运行测试确认通过**

运行：`pnpm --filter @vcpdeck/frontend test mark-done-button`
预期：PASS，4 个用例全部通过

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/mark-done-button.tsx packages/frontend/src/components/mark-done-button.test.tsx
git commit -m "feat(frontend): Pi 会话任务标记完成按钮"
```

---

### Task 2: 列表页集成（行内 + 抽屉详情）

**Files:**

- Modify: `packages/frontend/src/pages/jobs-page.tsx`
- Test: `packages/frontend/src/pages/jobs-page.test.tsx`

**Interfaces:**

- Consumes: `MarkDoneButton`（Task 1 产物）、`sdk.jobs.get(jobId: string, signal?: AbortSignal)`（返回 `JobInfo`）
- Produces: 列表行操作列出现「标记完成」；抽屉 `JobDetails` 出现「标记完成」，完成后刷新列表并用 `jobs.get` 回填抽屉

- [ ] **Step 1: 写失败测试**

在 `packages/frontend/src/pages/jobs-page.test.tsx` 末尾追加两个用例：

```tsx
it("从列表行把 Pi 会话标记为完成并刷新列表", async () => {
 const list = vi.fn().mockResolvedValue({
  data: [
   job({
    jobId: "s1",
    type: "agent.session",
    status: "idle" as JobInfo["status"],
    payload: {},
   }),
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
 });
 const complete = vi.fn().mockResolvedValue({});
 const client = {
  auth: { me: async () => identity },
  jobs: { list },
  pi: { complete },
 } as unknown as VcpDeckClient;
 render(
  <MemoryRouter>
   <SdkProvider client={client}>
    <AuthProvider>
     <JobsPage />
    </AuthProvider>
   </SdkProvider>
  </MemoryRouter>,
 );

 const table = await screen.findByRole("table", { name: "任务记录" });
 await userEvent.click(
  within(table).getByRole("button", { name: "标记完成" }),
 );
 await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
 await waitFor(() =>
  expect(complete).toHaveBeenCalledWith(
   "c1",
   "s1",
   undefined,
   expect.any(AbortSignal),
  ),
 );
 await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it("从抽屉把 Pi 会话标记为完成并回填抽屉", async () => {
 const session = job({
  jobId: "s1",
  type: "agent.session",
  status: "waiting_input" as JobInfo["status"],
  payload: {},
 });
 const list = vi.fn().mockResolvedValue({
  data: [session],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
 });
 const get = vi.fn().mockResolvedValue({
  ...session,
  status: "done" as JobInfo["status"],
 });
 const complete = vi.fn().mockResolvedValue({});
 const client = {
  auth: { me: async () => identity },
  jobs: { list, get },
  pi: { complete },
 } as unknown as VcpDeckClient;
 render(
  <MemoryRouter>
   <SdkProvider client={client}>
    <AuthProvider>
     <JobsPage />
    </AuthProvider>
   </SdkProvider>
  </MemoryRouter>,
 );

 const table = await screen.findByRole("table", { name: "任务记录" });
 // 类型列与摘要列都显示「Pi 会话」，取第一个（类型列）点击行
 await userEvent.click(within(table).getAllByText("Pi 会话")[0]);
 const dialog = screen.getByRole("dialog", { name: "任务详情" });
 await userEvent.click(
  within(dialog).getByRole("button", { name: "标记完成" }),
 );
 await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
 await waitFor(() => expect(get).toHaveBeenCalledWith("s1"));
 await waitFor(() =>
  expect(within(dialog).getByText("已完成")).toBeVisible(),
 );
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm --filter @vcpdeck/frontend test jobs-page`
预期：FAIL，找不到「标记完成」按钮

- [ ] **Step 3: 实现行内按钮**

在 `packages/frontend/src/pages/jobs-page.tsx`：

1. 文件顶部追加导入：

```tsx
import { MarkDoneButton } from "@/components/mark-done-button";
```

1. `JobRow` 的操作列，在 `<JobCancelButton ... />` 后追加：

```tsx
<MarkDoneButton
 job={job}
 onChanged={onChanged}
 stopPropagation
 size="sm"
/>
```

- [ ] **Step 4: 实现抽屉按钮**

继续修改 `packages/frontend/src/pages/jobs-page.tsx`：

1. 抽屉渲染处（`Drawer` 内）改为传入 `onChanged`：

```tsx
{selectedJob && (
 <JobDetails
  job={selectedJob}
  onChanged={async () => {
   resource.reload();
   setSelectedJob(await sdk.jobs.get(selectedJob.jobId));
  }}
 />
)}
```

1. `JobDetails` 签名与头部：

```tsx
function JobDetails({
 job,
 onChanged,
}: {
 job: JobInfo;
 onChanged: () => void;
}) {
```

```tsx
  <div className="flex flex-wrap items-center gap-2">
   <span className="font-medium">{jobTypeLabel(job.type)}</span>
   <StatusChip
    label={statusLabel(job.status)}
    tone={statusTone(job.status)}
   />
   <MarkDoneButton job={job} onChanged={onChanged} size="sm" />
  </div>
```

- [ ] **Step 5: 运行测试确认通过**

运行：`pnpm --filter @vcpdeck/frontend test jobs-page`
预期：PASS，全部用例（含既有用例）通过

- [ ] **Step 6: 提交**

```bash
git add packages/frontend/src/pages/jobs-page.tsx packages/frontend/src/pages/jobs-page.test.tsx
git commit -m "feat(frontend): 任务列表行与抽屉支持标记 Pi 会话完成"
```

---

### Task 3: 详情页集成

**Files:**

- Modify: `packages/frontend/src/pages/job-detail-page.tsx`
- Test: `packages/frontend/src/pages/job-detail-page.test.tsx`

**Interfaces:**

- Consumes: `MarkDoneButton`、`PageHeading` 的 `actions` prop、`useResource` 的 `reload`
- Produces: 详情页头部出现「标记完成」，完成后 `resource.reload()` 重新拉取

- [ ] **Step 1: 写失败测试**

修改 `packages/frontend/src/pages/job-detail-page.test.tsx`：

1. 导入追加（第 5 行附近）：

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
```

1. `renderDetail` 追加返回值（`jobs.get` 抽出以便断言）：

```tsx
function renderDetail(
 job: JobInfo,
 downloadUrl: ReturnType<typeof vi.fn>,
 extra: Record<string, unknown> = {},
) {
 const client = {
  auth: { me: vi.fn().mockResolvedValue(identity) },
  jobs: { get: vi.fn().mockResolvedValue(job) },
  storage: { downloadUrl },
  ...extra,
 } as unknown as VcpDeckClient;
 return render(
  <MemoryRouter initialEntries={["/jobs/job-1"]}>
   <SdkProvider client={client}>
    <AuthProvider>
     <Routes>
      <Route path="/jobs/:jobId" element={<JobDetailPage />} />
     </Routes>
    </AuthProvider>
   </SdkProvider>
  </MemoryRouter>,
 );
}
```

1. 末尾追加用例：

```tsx
it("Pi 会话任务可从头部标记完成并重新加载", async () => {
 const session = {
  ...exportJob,
  type: "agent.session",
  status: JobStatus.WAITING_INPUT,
  result: null,
  payload: {},
 };
 // 可变 current：complete 成功后置 done，随后的 reload 必然读到新状态（无时序竞态）
 let current: JobInfo = session;
 const get = vi.fn().mockImplementation(() => Promise.resolve(current));
 const complete = vi.fn().mockImplementation(async () => {
  current = { ...session, status: JobStatus.DONE };
 });
 renderDetail(session, vi.fn(), { jobs: { get }, pi: { complete } });

 const button = await screen.findByRole("button", { name: "标记完成" });
 await userEvent.click(button);
 await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
 expect(complete).toHaveBeenCalledWith(
  "c1",
  "job-1",
  undefined,
  expect.any(AbortSignal),
 );
 await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
 expect(await screen.findByText("done")).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

运行：`pnpm --filter @vcpdeck/frontend test job-detail-page`
预期：FAIL，找不到「标记完成」按钮

- [ ] **Step 3: 实现**

修改 `packages/frontend/src/pages/job-detail-page.tsx`：

1. 追加导入：

```tsx
import { MarkDoneButton } from "@/components/mark-done-button";
```

1. `JobDetailPage` 的 `PageHeading` 传 `actions`：

```tsx
  <PageHeading
   title={job.type}
   description={job.jobId}
   actions={<MarkDoneButton job={job} onChanged={resource.reload} />}
  />
```

- [ ] **Step 4: 运行测试确认通过**

运行：`pnpm --filter @vcpdeck/frontend test job-detail-page`
预期：PASS，全部用例（含既有用例）通过

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/pages/job-detail-page.tsx packages/frontend/src/pages/job-detail-page.test.tsx
git commit -m "feat(frontend): 任务详情页支持标记 Pi 会话完成"
```

---

### Task 4: 全量验证

- [ ] **Step 1: 运行前端全部测试**

运行：`pnpm --filter @vcpdeck/frontend test`
预期：全部 PASS

- [ ] **Step 2: 运行构建**

运行：`pnpm --filter @vcpdeck/frontend build`
预期：`tsc` 无类型错误，vite build 成功

- [ ] **Step 3: 运行全仓测试（回归）**

运行：`pnpm test`
预期：全部 PASS（本改动不触碰后端，此处仅为回归确认）

- [ ] **Step 4: 确认工作区干净**

运行：`git status`
预期：无未提交改动
