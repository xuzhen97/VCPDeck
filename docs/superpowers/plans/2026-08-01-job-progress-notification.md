# 导出进度与全局任务铃铛 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 大文件导出时展示传输段进度（百分比 + 已传/总字节），右上角全局铃铛统一提示任务进行中/完成/失败，完成后可一键下载。

**Architecture:** Client 在导出上传流上节流上报 `JOB_PROGRESS`（WebSocket）→ Server 写 job 表 `progress` 字段（JSON）→ `toJobInfo` 透出 → 前端铃铛每 3 秒轮询任务列表，快照对比识别"新完成"，进行中渲染进度条，完成项带下载按钮（复用永久下载链接）。

**Tech Stack:** NestJS（server）、Prisma（SQLite，`prisma db push`）、socket.io（client）、Vitest、React（frontend）

## Global Constraints

- 代码标识符/协议字段用英文；注释与 JSDoc 用简体中文
- TypeScript：ESM + strict，NodeNext 相对导入保留 `.js` 后缀
- 只报"远程机器 → Server"传输段进度；阿里云盘分片上传段不报
- 浏览器下载阶段不报进度（`<a download>` 无法感知），仅提示"已开始下载"
- 铃铛通知为会话内存态，刷新即清；不持久化
- 进度节流：每 500ms 或每 1MB（取先到者）
- 非 `file.export` 任务不上报进度（铃铛仅展示状态）
- 错误对象保持稳定 `code`、合适 `statusCode`、安全 message
- git commit 使用简体中文

---

### Task 1: shared 进度类型与事件

**Files:**

- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Consumes: 无
- Produces:
  - `export interface JobProgress { loaded: number; total: number }`
  - `JobInfo.progress: JobProgress | null`
  - `Events.JOB_PROGRESS = "job:progress"`

- [ ] **Step 1: 实现**

在 `packages/shared/src/index.ts` 修改两处：

```ts
export const Events = {
 REGISTER: "register",
 HEARTBEAT: "heartbeat",
 JOB_DISPATCH: "job:dispatch",
 JOB_STDOUT: "job:stdout",
 JOB_STDERR: "job:stderr",
 JOB_DONE: "job:done",
 JOB_PROGRESS: "job:progress",
 JOB_CANCEL: "job:cancel",
 JOB_CANCELLED: "job:cancelled",
 JOB_CANCEL_FAILED: "job:cancel-failed",
 JOB_UPDATE: "job:update",
 STATUS_REPORT: "status:report",
} as const;
```

在 `JobInfo` 接口（`packages/shared/src/index.ts` 约 201 行）中加字段：

```ts
export interface JobInfo {
 jobId: string;
 clientId: string;
 clientName: string | null;
 type: string;
 status: JobStatus;
 payload: Record<string, unknown>;
 result: Record<string, unknown> | null;
 /** 传输段进度（file.export 上传时上报，无则 null） */
 progress: JobProgress | null;
 errorCode: string | null;
 errorMessage: string | null;
 // ...其余字段不变
}
```

在 `JobInfo` 接口定义前加：

```ts
/** Job 传输段进度：已传输字节 / 总字节 */
export interface JobProgress {
 loaded: number;
 total: number;
}
```

- [ ] **Step 2: 验证编译**

Run: `pnpm --filter @vcpdeck/shared build`
Expected: 编译通过（shared 包无独立测试，类型即验证）

- [ ] **Step 3: 提交**

```bash
git add packages/shared/src/index.ts
git commit -m "feat: 定义 Job 进度类型与 JOB_PROGRESS 事件" -- packages/shared/src/index.ts
```

---

### Task 2: server 进度存储与透出

**Files:**

- Modify: `packages/server/prisma/schema.prisma`（Job 模型加 `progress` 字段）
- Modify: `packages/server/src/job/job.service.ts`（`toJobInfo` + `updateProgress`）
- Modify: `packages/server/src/events/client.gateway.ts`（处理 `JOB_PROGRESS`）
- Test: `packages/server/src/job/job.service.test.ts`

**Interfaces:**

- Consumes: `Events.JOB_PROGRESS`、`JobProgress`（Task 1）
- Produces:
  - `jobService.updateProgress(jobId: string, loaded: number, total: number): Promise<void>`
  - `JobInfo.progress`（`toJobInfo` 解析 `j.progress` JSON 字符串，无效/缺失 → null）

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/job/job.service.test.ts` 追加（先看该文件现有的 mock 模式，`prisma` mock 需含 `job.update`）：

```ts
it("updateProgress 写入序列化进度", async () => {
 const update = vi.fn().mockResolvedValue({});
 // 按现有 mockPrisma 模式把 update 挂到 prisma.job
 (prisma.job as any).update = update;

 await service.updateProgress("job-1", 65536, 158601385);

 expect(update).toHaveBeenCalledWith({
  where: { id: "job-1" },
  data: { progress: JSON.stringify({ loaded: 65536, total: 158601385 }) },
 });
});
```

（若现有测试文件无 `service` 实例，参照 `storage.service.test.ts` 的 `describe` + `beforeEach` 结构创建。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/server test -- src/job/job.service.test.ts`
Expected: 新用例 FAIL（`updateProgress` 不存在）

- [ ] **Step 3: 实现**

`packages/server/prisma/schema.prisma` Job 模型加字段（`result` 之后）：

```prisma
  result       String?
  progress     String?
  errorCode    String?
```

`packages/server/src/job/job.service.ts`：

```ts
/** 更新 job 传输段进度（file.export 上传时由 client 上报） */
async updateProgress(
 jobId: string,
 loaded: number,
 total: number,
): Promise<void> {
 await this.prisma.job.update({
  where: { id: jobId },
  data: { progress: JSON.stringify({ loaded, total }) },
 });
}
```

`toJobInfo` 的 `j` 参数类型加 `progress: string | null;`，返回值加：

```ts
 progress: parseProgress(j.progress),
```

并在文件底部加辅助函数（放在 `safeJsonParse` 旁）：

```ts
/** 解析 progress JSON，无效返回 null */
function parseProgress(raw: string | null): JobProgress | null {
 if (!raw) return null;
 try {
  const parsed = JSON.parse(raw) as Partial<JobProgress>;
  if (
   typeof parsed.loaded === "number" &&
   typeof parsed.total === "number"
  ) {
   return { loaded: parsed.loaded, total: parsed.total };
  }
 } catch {
  // 无效 JSON 按无进度处理
 }
 return null;
}
```

`import type { JobProgress } from "@vcpdeck/shared";` 加入现有 shared import。

`packages/server/src/events/client.gateway.ts`，在 `handleJobDone` 之前加：

```ts
@SubscribeMessage(Events.JOB_PROGRESS)
async handleJobProgress(@MessageBody() data: JobProgressMessage) {
 await this.jobService.updateProgress(data.jobId, data.loaded, data.total);
}
```

（`JobProgressMessage` 为内联类型 `{ jobId: string; loaded: number; total: number }`，定义在文件内；`JobProgress` 从 `@vcpdeck/shared` import 用于类型校验。）

- [ ] **Step 4: 运行测试确认通过 + 全量**

Run: `pnpm --filter @vcpdeck/server test`
Expected: 全部 PASS（含新用例）

- [ ] **Step 5: 提交**

```bash
git add packages/server/prisma/schema.prisma packages/server/src/job/job.service.ts packages/server/src/events/client.gateway.ts packages/server/src/job/job.service.test.ts
git commit -m "feat: server 存储并透出 job 传输进度" -- packages/server/prisma/schema.prisma packages/server/src/job/job.service.ts packages/server/src/events/client.gateway.ts packages/server/src/job/job.service.test.ts
```

**注意**：`prisma db push` 在 dev 启动时执行，schema 改动需重启 server dev 进程生效（提醒用户或重启）。

---

### Task 3: client 传输段进度上报

**Files:**

- Modify: `packages/client/src/transfer-handler.ts`（`handleExport`）
- Test: `packages/client/src/transfer-handler.test.ts`

**Interfaces:**

- Consumes: `Events.JOB_PROGRESS`（Task 1）
- Produces: WebSocket 事件 `JOB_PROGRESS { jobId, loaded, total }`（传输中节流上报）

- [ ] **Step 1: 写失败测试**

在 `packages/client/src/transfer-handler.test.ts` 追加（现有文件已有 `handleTransfer` 测试与 `mockSocket`/`exportJob` 辅助）：

```ts
describe("handleTransfer file.export 进度上报", () => {
 beforeEach(() => {
  vi.stubGlobal(
   "fetch",
   vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ key: "aliyun-fileid-123", size: 5 }),
   }),
  );
  vi.useFakeTimers();
 });

 afterEach(() => {
  vi.useRealTimers();
 });

 it("超过 1MB 即上报进度", async () => {
  // 覆盖 node:fs mock：createReadStream 返回 2MB 数据
  vi.mocked(fs.createReadStream).mockReturnValueOnce(
   Readable.from([Buffer.alloc(2 * 1024 * 1024, 1)]),
  );
  mockFsPromises.stat.mockResolvedValue({ size: 2 * 1024 * 1024 });
  const socket = mockSocket();
  await handleTransfer(exportJob(), socket);

  const progressEvents = vi
   .mocked(socket.emit)
   .mock.calls.filter(([event]) => event === Events.JOB_PROGRESS);
  expect(progressEvents.length).toBeGreaterThan(0);
  const [, data] = progressEvents[0] as [string, Record<string, number>];
  expect(data).toMatchObject({
   jobId: "job-1",
   loaded: 2 * 1024 * 1024,
   total: 2 * 1024 * 1024,
  });
 });
});
```

**注意**：现有 `vi.mock("node:fs")` 的 `createReadStream` mock 需改为 `vi.fn(() => Readable.from([Buffer.from("hello")]))`，测试中才可 `mockReturnValueOnce` 覆盖。`handleTransfer` 完成后（`await` 返回）流数据已全部消费，进度事件已发出——若 `data` 事件同步触发则无需推进 fake timers；若实现按 500ms 节流导致 2MB 单 chunk 也延迟，则测试中在 `await handleTransfer` 前先 `vi.advanceTimersByTime(600)` 并 flush microtasks（`await Promise.resolve()`）。以实际实现行为调整断言时机。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/client test`
Expected: 新用例 FAIL（尚无进度上报）

- [ ] **Step 3: 实现**

修改 `packages/client/src/transfer-handler.ts` 的 `handleExport`：

```ts
 const fileStat = await stat(safe);
 const hash = createHash("sha256");
 const total = fileStat.size;

 const fileStream = createReadStream(safe);
 const countingStream = new PassThrough();
 // 传输段进度：节流上报（每 500ms 或每 1MB，取先到者）
 let loaded = 0;
 let lastEmitAt = 0;
 let lastEmitBytes = 0;
 countingStream.on("data", (chunk: Buffer) => {
  hash.update(chunk);
  loaded += chunk.length;
  const now = Date.now();
  if (
   now - lastEmitAt >= 500 ||
   loaded - lastEmitBytes >= 1024 * 1024
  ) {
   lastEmitAt = now;
   lastEmitBytes = loaded;
   socket.emit(Events.JOB_PROGRESS, { jobId, loaded, total });
  }
 });
 fileStream.pipe(countingStream);
```

（其余逻辑不变：`Readable.toWeb`、PUT、解析响应 key、`emitDone`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/client test`
Expected: 全部 PASS（含新用例）

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/transfer-handler.ts packages/client/src/transfer-handler.test.ts
git commit -m "feat: client 导出上传流节流上报传输进度" -- packages/client/src/transfer-handler.ts packages/client/src/transfer-handler.test.ts
```

---

### Task 4: 前端全局铃铛 + 文件面板就地提示

**Files:**

- Create: `packages/frontend/src/components/notification-bell.tsx`
- Create: `packages/frontend/src/components/notification-bell.test.tsx`
- Modify: `packages/frontend/src/app/console-shell.tsx`（header 挂载铃铛）
- Modify: `packages/frontend/src/pages/files-panel.tsx`（导出成功提示）

**Interfaces:**

- Consumes:
  - `sdk.jobs.list({ pageSize }, signal)` → `PaginatedResult<JobInfo>`（含 `progress`）
  - `sdk.jobs.get(jobId, signal)` → `JobInfo`
  - `sdk.storage.createDownloadToken({ key, ttlSeconds: 0 }, signal)`（Task 1/2 已备）
  - `DownloadLinkCard` 的下载模式（`download-link-card.tsx` 中 `createDownloadToken + anchor` 逻辑）
- Produces: `NotificationBell` 组件（无 props，内部轮询）

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/components/notification-bell.test.tsx`，参照 `jobs-page.test.tsx` 的 `SdkProvider + AuthProvider + MemoryRouter` 渲染模式（`useSdk` 的 mock client 需含 `jobs.list`、`jobs.get`、`storage.createDownloadToken`、`auth.me`）：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { IdentityInfo, JobInfo } from "@vcpdeck/shared";
import { SdkProvider } from "@/api/context";
import { AuthProvider } from "@/auth-context";
import { NotificationBell } from "./notification-bell";

const identity: IdentityInfo = {
 id: "i1",
 username: "admin",
 displayName: "管理员",
 isAdmin: true,
 disabledAt: null,
 createdAt: "2026-07-26T00:00:00.000Z",
};

function job(overrides: Partial<JobInfo>): JobInfo {
 return {
  jobId: "j1",
  clientId: "c1",
  clientName: "wujie14",
  type: "exec",
  status: "running" as JobInfo["status"],
  payload: {},
  result: null,
  progress: null,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  startedAt: "2026-08-01T00:00:00.000Z",
  finishedAt: null,
  createdByIdentityId: null,
  createdByName: "admin",
  createdVia: "web",
  ...overrides,
 };
}

function renderBell(client: Partial<VcpDeckClient>) {
 return render(
  <SdkProvider
   client={
    {
     auth: { me: vi.fn().mockResolvedValue(identity) },
     ...client,
    } as unknown as VcpDeckClient
   }
  >
   <AuthProvider>
    <NotificationBell />
   </AuthProvider>
  </SdkProvider>,
 );
}

describe("NotificationBell", () => {
 beforeEach(() => {
  vi.useFakeTimers();
 });
 afterEach(() => {
  vi.useRealTimers();
 });

 it("进行中 file.export 显示进度条与字节数", async () => {
  const list = vi.fn().mockResolvedValue({
   data: [
    job({
     jobId: "export-1",
     type: "file.export",
     payload: { path: "D:\\big.zip" },
     progress: { loaded: 66 * 1024 * 1024, total: 158 * 1024 * 1024 },
    }),
   ],
   total: 1,
   page: 1,
   pageSize: 5,
   totalPages: 1,
  });
  renderBell({ jobs: { list, get: vi.fn() } });

  // 触发首次轮询
  await vi.advanceTimersByTimeAsync(0);
  expect(list).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /任务通知/ }));
  expect(screen.getByText("big.zip")).toBeInTheDocument();
  expect(screen.getByText(/66.*MB/)).toBeInTheDocument();
  expect(screen.getByText(/42%/)).toBeInTheDocument();
 });

 it("新完成的 file.export 出现下载按钮，点击触发下载", async () => {
  const doneJob = job({
   jobId: "export-2",
   type: "file.export",
   status: "done" as JobInfo["status"],
   payload: { path: "D:\\done.zip" },
   result: { fileId: "f1", key: "aliyun-fileid-9", size: 1, sha256: "x" },
   finishedAt: "2026-08-01T00:01:00.000Z",
  });
  const list = vi
   .fn()
   .mockResolvedValueOnce({
    data: [job({ jobId: "export-2", type: "file.export", payload: { path: "D:\\done.zip" } })],
    total: 1, page: 1, pageSize: 5, totalPages: 1,
   })
   .mockResolvedValueOnce({
    data: [doneJob],
    total: 1, page: 1, pageSize: 5, totalPages: 1,
   });
  const get = vi.fn().mockResolvedValue(doneJob);
  const createDownloadToken = vi.fn().mockResolvedValue({
   url: "/api/storage/download/aliyun-fileid-9?expires=0&sig=abc",
   expiresAt: 0,
  });
  renderBell({ jobs: { list, get }, storage: { createDownloadToken } });

  await vi.advanceTimersByTimeAsync(0); // 首次轮询：running
  await vi.advanceTimersByTimeAsync(3000); // 第二次轮询：done
  // 铃铛轮询发现消失的 running job → jobs.get 确认终态
  await vi.advanceTimersByTimeAsync(0);
  await userEvent.click(screen.getByRole("button", { name: /任务通知/ }));
  expect(screen.getByText("done.zip")).toBeInTheDocument();

  await userEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "下载" }));
  expect(createDownloadToken).toHaveBeenCalledWith({
   key: "aliyun-fileid-9",
   ttlSeconds: 0,
  });
 });

 it("失败任务显示错误并可清除", async () => {
  // 第一次返回 running，第二次返回 error 状态 job
  const errorJob = job({
   jobId: "export-3",
   type: "file.export",
   status: "error" as JobInfo["status"],
   payload: { path: "D:\\fail.zip" },
   errorCode: "IO_ERROR",
   errorMessage: "upload failed",
   finishedAt: "2026-08-01T00:01:00.000Z",
  });
  const list = vi
   .fn()
   .mockResolvedValueOnce({ data: [job({ jobId: "export-3", type: "file.export", payload: { path: "D:\\fail.zip" } })], total: 1, page: 1, pageSize: 5, totalPages: 1 })
   .mockResolvedValueOnce({ data: [errorJob], total: 1, page: 1, pageSize: 5, totalPages: 1 });
  renderBell({ jobs: { list, get: vi.fn() } });

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  await vi.advanceTimersByTimeAsync(0);
  await userEvent.click(screen.getByRole("button", { name: /任务通知/ }));
  expect(screen.getByText(/fail.zip/)).toBeInTheDocument();
  expect(screen.getByText(/upload failed/)).toBeInTheDocument();
 });
});
```

（以实际组件实现的轮询时序调整 `advanceTimersByTimeAsync` 次数；断言目标：进度条字节/百分比、完成下载按钮、失败错误信息可见。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- --run notification-bell`
Expected: 全部 FAIL（组件不存在）

- [ ] **Step 3: 实现铃铛组件**

创建 `packages/frontend/src/components/notification-bell.tsx`：

```tsx
import type { JobInfo, JobProgress } from "@vcpdeck/shared";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";

const POLL_MS = 3000;
const ACTIVE_STATUSES = new Set(["pending", "running"]);

interface FinishedItem {
 jobId: string;
 type: string;
 status: "done" | "error" | "cancelled";
 filename: string;
 key?: string;
 message?: string;
}

/** 全局任务铃铛：进行中进度 / 新完成可下载 / 失败可清除（会话内存态） */
export function NotificationBell() {
 const sdk = useSdk();
 const [open, setOpen] = useState(false);
 const [active, setActive] = useState<JobInfo[]>([]);
 const [finished, setFinished] = useState<FinishedItem[]>([]);
 const seenRunning = useRef(new Set<string>());

 const poll = useCallback(async () => {
  try {
   const page = await sdk.jobs.list({ pageSize: 5 });
   const nowRunning = new Set(
    page.data
     .filter((j) => ACTIVE_STATUSES.has(j.status))
     .map((j) => j.jobId),
   );
   // 上次 running 现在消失的 job → 查终态，识别新完成/失败
   const newlyFinished: string[] = [];
   for (const prevId of seenRunning.current) {
    if (!nowRunning.has(prevId)) newlyFinished.push(prevId);
   }
   seenRunning.current = nowRunning;
   setActive(page.data.filter((j) => ACTIVE_STATUSES.has(j.status)));

   for (const jobId of newlyFinished) {
    const job = await sdk.jobs.get(jobId);
    if (ACTIVE_STATUSES.has(job.status)) continue; // 竞态：又变 running
    setFinished((prev) => [
     ...prev.filter((f) => f.jobId !== jobId),
     {
      jobId,
      type: job.type,
      status: job.status as FinishedItem["status"],
      filename: filenameOf(job),
      key: job.result?.key ? String(job.result.key) : undefined,
      message: job.errorMessage ?? job.errorCode ?? undefined,
     },
    ]);
   }
  } catch {
   // 轮询失败静默，下轮重试
  }
 }, [sdk]);

 useEffect(() => {
  void poll();
  const timer = setInterval(() => {
   if (!document.hidden) void poll();
  }, POLL_MS);
  return () => clearInterval(timer);
 }, [poll]);

 const activeCount = active.length;

 return (
  <div className="relative">
   <Button
    type="button"
    size="icon"
    variant="ghost"
    aria-label={open ? "收起任务通知" : "任务通知"}
    onClick={() => setOpen((v) => !v)}
    className="relative"
   >
    <Bell className="size-4" />
    {activeCount > 0 && (
     <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
      {activeCount}
     </span>
    )}
   </Button>
   {open && (
    <div
     role="dialog"
     aria-label="任务通知"
     className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-border bg-background p-3 shadow-2xl"
    >
     <p className="mb-2 text-xs font-semibold text-muted-foreground">
      任务通知
     </p>
     {active.length === 0 && finished.length === 0 && (
      <p className="py-4 text-center text-sm text-muted-foreground">
       暂无任务
      </p>
     )}
     {active.map((job) => (
      <div key={job.jobId} className="mb-3">
       <p className="mb-1 truncate text-sm font-medium">
        {jobTypeLabel(job.type)}：{filenameOf(job)}
       </p>
       <ProgressBar progress={job.progress} />
      </div>
     ))}
     {finished.map((item) => (
      <div
       key={item.jobId}
       className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-border/70 bg-secondary/20 p-2 text-sm"
      >
       <div className="min-w-0">
        <p className="truncate font-medium">
         {item.status === "done"
          ? `完成：${item.filename}`
          : item.status === "error"
           ? `失败：${item.filename}`
           : `已取消：${item.filename}`}
        </p>
        {item.status === "error" && item.message && (
         <p className="mt-0.5 truncate text-xs text-red-400">
          {item.message}
         </p>
        )}
        {item.status === "done" && item.type === "file.export" && item.key && (
         <DownloadButton key={item.key} jobId={item.jobId} />
        )}
       </div>
       <Button
        size="sm"
        variant="ghost"
        aria-label={`清除通知 ${item.jobId}`}
        onClick={() =>
         setFinished((prev) =>
          prev.filter((f) => f.jobId !== item.jobId),
         )
        }
       >
        清除
       </Button>
      </div>
     ))}
    </div>
   )}
  </div>
 );
}

function ProgressBar({ progress }: { progress: JobProgress | null }) {
 if (!progress || progress.total <= 0) {
  return <div className="h-1.5 w-full rounded-full bg-muted" />;
 }
 const pct = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
 const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
 return (
  <div>
   <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
   </div>
   <p className="mt-1 text-xs text-muted-foreground">
    已传 {mb(progress.loaded)} / {mb(progress.total)} MB · {pct}%
   </p>
  </div>
 );
}

/** 完成项内的下载按钮：签永久下载链接并触发浏览器下载 */
function DownloadButton({ jobId, key }: { jobId: string; key: string }) {
 const sdk = useSdk();
 const [busy, setBusy] = useState(false);
 const [notice, setNotice] = useState("");
 const doDownload = useCallback(async () => {
  setBusy(true);
  setNotice("");
  try {
   const token = await sdk.storage.createDownloadToken({
    key,
    ttlSeconds: 0,
   });
   const anchor = document.createElement("a");
   anchor.href = `${window.location.origin}${token.url}`;
   anchor.download = "";
   document.body.append(anchor);
   anchor.click();
   anchor.remove();
   setNotice("已开始下载，请查看浏览器下载栏");
   window.setTimeout(() => setNotice(""), 3000);
  } catch {
   setNotice("下载链接生成失败");
  } finally {
   setBusy(false);
  }
 }, [sdk, key]);

 return (
  <div>
   <Button size="sm" variant="outline" disabled={busy} onClick={doDownload}>
    {busy ? "生成中…" : "下载"}
   </Button>
   {notice && <p className="mt-1 text-xs text-muted-foreground">{notice}</p>}
  </div>
 );
}

function filenameOf(job: JobInfo): string {
 const path = job.payload?.path;
 return typeof path === "string" ? path.split(/[/\\]/).pop() || path : job.type;
}

function jobTypeLabel(type: string): string {
 return (
  {
   exec: "执行命令",
   "file.roots": "发现文件根",
   "file.list": "读取目录",
   "file.stat": "读取文件信息",
   "file.readText": "读取文本",
   "file.writeText": "保存文本",
   "file.mkdir": "创建文件夹",
   "file.delete": "删除文件",
   "file.move": "移动文件",
   "file.export": "导出文件",
   "file.import": "导入文件",
   "frp.create": "创建 FRP",
   "frp.delete": "删除 FRP",
   "frp.list": "读取 FRP",
  }[type] ?? type
 );
}
```

**注意**：

- `sdk.jobs.list` 与 `sdk.jobs.get` 均接受 AbortSignal，测试 mock 中忽略即可
- 测试里 `anchor.download = ""` 时下载文件名取 Content-Disposition（server 已返回真实文件名），无需传文件名
- 若 eslint 报 `jobId` 参数未使用（`DownloadButton` 的 `jobId`），删除该参数——`key` 足够

- [ ] **Step 4: 挂载到布局**

`packages/frontend/src/app/console-shell.tsx`，在 header 的"切换主题"按钮之前加：

```tsx
<NotificationBell />
```

并在 import 区加：

```tsx
import { NotificationBell } from "@/components/notification-bell";
```

- [ ] **Step 5: 文件面板导出成功提示**

`packages/frontend/src/pages/files-panel.tsx`，右键菜单"导出下载"的 onClick 中，anchor 触发下载后加提示（复用现有 `exportError` state 模式，新增 `exportNotice`）：

```tsx
const [exportNotice, setExportNotice] = useState("");
// ...在 anchor.click() 之后：
setExportNotice("正在开始下载，请查看浏览器下载栏");
window.setTimeout(() => setExportNotice(""), 2500);
```

在文件列表错误提示区（`exportError` 的 div 旁）渲染：

```tsx
{exportNotice && (
 <div
  role="status"
  className="mb-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400"
 >
  {exportNotice}
 </div>
)}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/frontend test -- --run notification-bell jobs-page files-panel`
Expected: 全部 PASS（含新铃铛用例与既有回归）

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx packages/frontend/src/app/console-shell.tsx packages/frontend/src/pages/files-panel.tsx
git commit -m "feat: 全局任务铃铛展示进度与完成下载" -- packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx packages/frontend/src/app/console-shell.tsx packages/frontend/src/pages/files-panel.tsx
```

---

### Task 5: 端到端验证与收尾

**Files:**

- 无代码改动（验证 + 文档同步）

**Interfaces:**

- Consumes: Task 1-4 全部改动

- [ ] **Step 1: 重启 server（应用 prisma db push + 新代码）**

Run: 重启 `packages/server` dev 进程
Expected: 启动日志无错误；`prisma db push` 应用 progress 字段

- [ ] **Step 2: 全量测试与构建**

Run:

```bash
pnpm --filter @vcpdeck/shared build
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/frontend test
pnpm build
```

Expected: 全部 PASS，构建产物正常

- [ ] **Step 3: 手动/浏览器端到端（真实环境）**

1. 在文件面板导出一个大文件（如 nginx-1.18.0.zip）
2. 右上角铃铛出现徽标；点开看到"导出文件：nginx-1.18.0.zip" + 进度条递增（百分比/字节变化）
3. 切到其他页面，铃铛仍在轮询展示进度
4. 完成后该条变为"完成：nginx-1.18.0.zip" + 下载按钮；点击下载 → 文件下载成功（文件名正确）
5. 清除按钮移除该项；失败场景（如导出不存在文件）显示"失败：<文件名>" + 错误信息
6. 文件面板导出完成时出现"正在开始下载"提示

Expected: 以上全部通过

- [ ] **Step 4: 更新 spec 状态与提交（如有出入）**

如实现与 spec 有出入，回改 `docs/superpowers/specs/2026-08-01-job-progress-notification-design.md` 并提交：

```bash
git add docs/superpowers/specs/2026-08-01-job-progress-notification-design.md
git commit -m "docs: 同步实现细节到设计文档"
```

---

## Self-Review 结果

- **Spec 覆盖**：进度类型/事件（Task 1）、server 存储透出（Task 2）、client 节流上报（Task 3）、铃铛 + 就地提示（Task 4）、验证（Task 5）均有对应任务；"不做的事"（阿里云盘分片段、浏览器下载进度、持久化）在 Global Constraints 显式声明。
- **占位符扫描**：无 TBD/TODO；代码步骤含完整代码。Task 1/2 的测试步骤按 TDD（红 → 绿）编排。
- **类型一致性**：`JobProgress { loaded, total }` 在 Task 1 定义，Task 2/3/4 引用一致；`Events.JOB_PROGRESS` 贯穿 client 上报 → server 订阅 → shared；`JobInfo.progress` 在 toJobInfo（Task 2）与铃铛渲染（Task 4）签名一致；`createDownloadToken({key, ttlSeconds: 0})` 与既有 `storage.ts` SDK 类型一致。
