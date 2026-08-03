# 导出进度与存储收尾状态实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让导出任务在 Client→Server 上传达到 100% 后明确显示“正在保存到云盘”，直到 Job 真正完成才显示下载入口，并修复 Server 重启后上传 pending 元数据丢失的兜底路径。

**Architecture:** 保持现有上传进度口径，只统计远程 Client→Server 传输段。前端根据 `JobInfo.status` 和 `progress.loaded/total` 区分“上传中”和“存储收尾中”；Server 接收上传时优先使用内存 pending，丢失时按临时 key 从 File 表恢复元数据，最后才使用现有最小兜底。浏览器下载流程不变，也不纳入任务百分比。

**Tech Stack:** React + Vitest + Testing Library；NestJS + Prisma + Vitest；TypeScript strict；NodeNext ESM；pnpm workspace。

## Global Constraints

- 进度只表示“远程 Client → Server”传输段，不统计阿里云盘分片上传和浏览器下载。
- Job 只有进入 `done` 后才显示下载按钮。
- 不新增依赖、不引入 WebSocket、不改现有下载签名协议。
- 不修改或提交与本任务无关的既有工作区改动。
- 代码注释和公共 JSDoc 使用简体中文；标识符和协议字段使用英文。
- 修改已存在的函数前必须先完成 GitNexus impact；`handleExport` 影响为 HIGH，验证后仅做本计划范围内的最小修改；`receiveUpload` 影响为 LOW。

---

### Task 1: 铃铛区分上传完成与云盘收尾

**Files:**

- Modify: `packages/frontend/src/components/notification-bell.tsx:ProgressBar`
- Test: `packages/frontend/src/components/notification-bell.test.tsx`

**Interfaces:**

- Consumes: `JobInfo.progress` (`{ loaded: number; total: number } | null`) and the existing active Job status.
- Produces: unchanged `NotificationBell` props and unchanged `JobInfo` API usage.

- [ ] **Step 1: 写失败测试，锁定 `100% + running` 的用户文案**

在 `NotificationBell` 测试中增加一个进行中的 `file.export` fixture：

```tsx
it("上传字节达到 100% 但 Job 未完成时显示云盘收尾状态", async () => {
 const MB = 1024 * 1024;
 const list = vi.fn().mockResolvedValue({
  data: [
   job({
    jobId: "export-finalizing",
    type: "file.export",
    payload: { path: "D:\\big.zip" },
    progress: { loaded: 158 * MB, total: 158 * MB },
   }),
  ],
  total: 1,
  page: 1,
  pageSize: 5,
  totalPages: 1,
 });
 renderBell({ jobs: { list, get: vi.fn() } });

 await vi.advanceTimersByTimeAsync(0);
 await act(async () => {});
 fireEvent.click(screen.getByRole("button", { name: "任务通知" }));

 expect(screen.getByText("上传完成 · 正在保存到云盘…")).toBeInTheDocument();
 expect(screen.queryByText(/100%/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行单测确认当前实现失败**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/components/notification-bell.test.tsx
```

Expected: FAIL，因为当前 `ProgressBar` 对 `loaded === total` 仍显示 `已传 … · 100%`，没有云盘收尾文案。

- [ ] **Step 3: 实现最小 UI 状态分支**

在 `ProgressBar` 中保留当前上传中的百分比渲染；当 `progress.total > 0 && progress.loaded >= progress.total` 时，改为渲染收尾状态，不显示百分比：

```tsx
function ProgressBar({ progress }: { progress: JobProgress | null }) {
 if (!progress || progress.total <= 0) {
  return <div className="h-1.5 w-full rounded-full bg-muted" />;
 }
 if (progress.loaded >= progress.total) {
  return (
   <div>
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
     <div className="h-full w-full animate-pulse rounded-full bg-primary/70" />
    </div>
    <p className="mt-1 text-xs text-muted-foreground">
     上传完成 · 正在保存到云盘…
    </p>
   </div>
  );
 }
 const pct = Math.min(
  100,
  Math.round((progress.loaded / progress.total) * 100),
 );
 const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
 return (
  <div>
   <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
    <div
     className="h-full rounded-full bg-primary"
     style={{ width: `${pct}%` }}
    />
   </div>
   <p className="mt-1 text-xs text-muted-foreground">
    已传 {mb(progress.loaded)} / {mb(progress.total)} MB · {pct}%
   </p>
  </div>
 );
}
```

不修改 `POLL_MS`、`finished` 识别、下载按钮或 Job API。

- [ ] **Step 4: 运行铃铛测试确认通过**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/components/notification-bell.test.tsx
```

Expected: 新增收尾状态测试和原有铃铛测试全部 PASS。

- [ ] **Step 5: 检查前端改动范围**

Run:

```bash
git diff --check -- packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx
```

Expected: 无输出、退出码为 0。

---

### Task 2: Server 重启后恢复上传 pending 元数据

**Files:**

- Modify: `packages/server/src/storage/storage.service.ts:StorageService.receiveUpload`
- Test: `packages/server/src/storage/storage.service.test.ts`

**Interfaces:**

- Consumes: Prisma `file.findUnique({ where: { key } })` and existing `StorageProvider.uploadToKey()`.
- Produces: unchanged `StorageService.receiveUpload()` return type and existing real-key persistence behavior.

- [ ] **Step 1: 扩展 Prisma mock 并写失败测试**

在 storage service 测试的 Prisma mock 中增加 `file.findUnique`，然后增加数据库恢复测试：

```ts
it("pending 缓存丢失时按临时 key 从 File 表恢复上传元数据", async () => {
 const provider = {
  verifyUploadSignature: vi.fn().mockReturnValue(true),
  uploadToKey: vi.fn().mockResolvedValue({
   key: "aliyun-file-id",
   jobId: "job-1",
   clientId: "client-1",
   filename: "nginx-1.18.0.zip",
   mimeType: "application/zip",
   size: 158601385,
   storageKind: "alibaba",
   createdAt: new Date(),
  }),
 } as never;
 vi.spyOn(service, "getProvider").mockReturnValue(provider);
 prisma.file.findUnique.mockResolvedValue({
  jobId: "job-1",
  clientId: "client-1",
  filename: "nginx-1.18.0.zip",
  mimeType: "application/zip",
  size: 158601385,
 });

 const stream = {} as never;
 await service.receiveUpload(
  "temporary-key/nginx-1.18.0.zip",
  stream,
  0,
  "sig",
 );

 expect(prisma.file.findUnique).toHaveBeenCalledWith({
  where: { key: "temporary-key/nginx-1.18.0.zip" },
 });
 expect(provider.uploadToKey).toHaveBeenCalledWith(
  stream,
  expect.objectContaining({
   jobId: "job-1",
   clientId: "client-1",
   filename: "nginx-1.18.0.zip",
   mimeType: "application/zip",
   size: 158601385,
  }),
  "temporary-key/nginx-1.18.0.zip",
 );
});
```

保留一个 File 表也不存在的测试，确认最终兜底仍然能够上传，不让本次改动破坏签名有效但历史记录缺失的场景。

- [ ] **Step 2: 运行 Server 单测确认新测试失败**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/storage/storage.service.test.ts
```

Expected: FAIL，因为当前 `receiveUpload()` 不查询 `file.findUnique`，直接使用 `size: 0` 和从 key 推断的最小元数据。

- [ ] **Step 3: 实现数据库恢复和最终兜底**

在 `receiveUpload()` 的 `!pending` 分支中按以下顺序处理：

```ts
const file = await this.prisma.file.findUnique({ where: { key } });
if (file) {
 return uploadAndPersist({
  jobId: file.jobId,
  clientId: file.clientId,
  filename: file.filename,
  mimeType: file.mimeType ?? undefined,
  size: file.size,
 });
}

this.logger.warn(`receiveUpload fallback (pending 丢失): key=${key.slice(0, 40)}`);
return uploadAndPersist({
 jobId: "",
 clientId: "",
 filename: key.split("/").pop() || key,
 size: 0,
});
```

不要删除现有 `uploadAndPersist()` 的真实 key 更新逻辑；数据库恢复路径和内存 pending 路径都必须继续执行 `File.updateMany({ where: { key }, data: { key: entry.key, status: "completed" } })`。

- [ ] **Step 4: 运行 Server 存储测试确认通过**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/storage/storage.service.test.ts
```

Expected: 数据库恢复、最终兜底和既有存储测试全部 PASS。

- [ ] **Step 5: 检查 Server 改动范围**

Run:

```bash
git diff --check -- packages/server/src/storage/storage.service.ts packages/server/src/storage/storage.service.test.ts
```

Expected: 无输出、退出码为 0。

---

### Task 3: 全量验证并检查任务范围

**Files:**

- Verify only: `packages/frontend/src/components/notification-bell.tsx`
- Verify only: `packages/frontend/src/components/notification-bell.test.tsx`
- Verify only: `packages/server/src/storage/storage.service.ts`
- Verify only: `packages/server/src/storage/storage.service.test.ts`

- [ ] **Step 1: 运行 Frontend 全量测试和构建**

Run:

```bash
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

Expected: Frontend 全部测试通过，TypeScript 和 Vite 构建成功；允许已有第三方依赖的 `use client` bundle warning。

- [ ] **Step 2: 运行 Server 全量测试和构建**

Run:

```bash
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/server build
```

Expected: Server 全部测试通过，TypeScript 构建成功。

- [ ] **Step 3: 运行 LSP 和差异检查**

Run:

```bash
pnpm exec tsc --noEmit -p packages/frontend/tsconfig.json
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
git diff --check
```

Expected: 无 TypeScript 错误、无 diff whitespace 错误。

- [ ] **Step 4: 检查 GitNexus 变更范围**

Run：

```text
gitnexus_detect_changes({ repo: "VCPDeck", scope: "unstaged" })
```

Expected: 变更解释只包含本任务新增的收尾状态和 `receiveUpload` fallback 相关符号；如果输出包含当前工作区已有的无关改动，按路径区分并不得清理、覆盖或提交它们。

- [ ] **Step 5: 进行真实验收**

在已有 Server、Frontend、Client 环境中导出一个足够大的文件，观察铃铛：

1. 上传期间显示字节进度和百分比；
2. 上传达到总大小后显示“上传完成 · 正在保存到云盘…”而不是把 100% 当作任务结束；
3. 阿里云盘上传和 Job 持久化完成后才出现完成项和下载按钮；
4. 下载文件内容和文件名正确；
5. 若 Server 在拿到上传令牌后重启，重新上传时不再因为 File 记录存在而走最小 `size: 0` fallback。

不执行破坏性命令，不杀全局 Node 进程，不修改无关工作区文件。

---

## Self-review

- Spec coverage：Task 1 覆盖前端收尾状态和“Job done 才显示下载”；Task 2 覆盖 Server 重启后 File 表元数据恢复及最终兜底；Task 3 覆盖回归测试、构建、诊断和真实验收。
- Placeholder scan：无 TBD、TODO 或未定义的函数名；每个实现步骤给出具体文件、命令或代码。
- Type consistency：Task 1 使用既有 `JobProgress`；Task 2 使用既有 `FileMeta` 字段和 Prisma `File` 字段；Task 3 验证两个包的 TypeScript 构建。
- Scope check：两个改动点都服务同一个导出状态问题，保持为一个计划；不新增云盘分片进度或浏览器下载进度。
