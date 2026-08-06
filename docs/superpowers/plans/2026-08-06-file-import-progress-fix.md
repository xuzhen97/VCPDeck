# 阿里云盘文件导入与双阶段进度修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复阿里云盘顺序分片约束导致的导入失败，并让浏览器上传、云盘保存、远程导入三个阶段提供准确反馈。

**Architecture:** 保留现有浏览器直传、Server 完成会话和 Client 流式下载链路。仅把浏览器分片从并发改为按 `partNumber` 顺序 PUT；Server 派发导入前重置 Job 进度；Frontend 使用现有 Job 轮询展示第二阶段进度。

**Tech Stack:** TypeScript、React、Vitest、NestJS、Prisma、XMLHttpRequest、Socket.IO

## Global Constraints

- 不增加依赖，不让文件数据经过 Server 代理。
- 不实现断点续传或上传并发配置。
- 保留现有 403 URL 刷新、有限重试、Client 临时文件和原子重命名逻辑。
- 错误信息不得泄露 token、完整签名 URL、文件内容或 stack。
- 使用现有 `JobProgress { loaded, total }`，不新增进度协议。
- 保留当前工作区已有未提交改动；每次提交只暂存本任务对应文件/代码块。

---

## 文件结构

- `packages/frontend/src/api/upload-file.ts`：顺序执行阿里云分片 PUT，继续汇总片内进度。
- `packages/frontend/src/api/upload-file.test.ts`：锁定分片启动顺序、边界和重试行为。
- `packages/server/src/job/job.service.ts`：云盘完成后、派发前重置第二阶段进度。
- `packages/server/src/job/job.service.test.ts`：验证 pending payload 与 `0 / total` 同时写入。
- `packages/frontend/src/pages/files-panel.tsx`：文件页上传、云盘保存、远程导入三阶段状态。
- `packages/frontend/src/pages/files-panel.test.tsx`：验证阶段切换和第二阶段从 0 开始。
- `packages/frontend/src/components/notification-bell.tsx`：通知铃铛使用阿里云与远程导入文案。
- `packages/frontend/src/components/notification-bell.test.tsx`：验证 `waiting_input`、`pending`、`running` 阶段。
- `packages/client/src/transfer-handler.test.ts`：只回归现有 Client 下载进度与大小校验，不改生产实现。

---

### Task 1: 按顺序上传阿里云分片

**Files:**

- Modify: `packages/frontend/src/api/upload-file.ts:14-107`
- Test: `packages/frontend/src/api/upload-file.test.ts:75-215`

**Interfaces:**

- Consumes: `uploadDirect(parts, size, file, { partSize, signal, onProgress, refreshPartUrl })`
- Produces: 相同函数签名；保证第 N 片成功后才创建第 N+1 片 XHR。

- [ ] **Step 1: 写失败测试，锁定分片顺序**

在 `describe("uploadDirect")` 中加入：

```ts
it("按 partNumber 顺序上传，前一片完成前不启动下一片", async () => {
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  const file = new File([new ArrayBuffer(13)], "big.bin");
  const promise = uploadDirect(
    [
      { partNumber: 3, url: "https://oss.example/p3" },
      { partNumber: 1, url: "https://oss.example/p1" },
      { partNumber: 2, url: "https://oss.example/p2" },
    ],
    13,
    file,
    { partSize: 5, refreshPartUrl: vi.fn() },
  );

  expect(FakeXhr.instances).toHaveLength(1);
  expect(FakeXhr.instances[0]!.open).toHaveBeenCalledWith("PUT", "https://oss.example/p1");
  FakeXhr.instances[0]!.onload?.();
  await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2));
  expect(FakeXhr.instances[1]!.open).toHaveBeenCalledWith("PUT", "https://oss.example/p2");
  FakeXhr.instances[1]!.onload?.();
  await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(3));
  expect(FakeXhr.instances[2]!.open).toHaveBeenCalledWith("PUT", "https://oss.example/p3");
  FakeXhr.instances[2]!.onload?.();

  await expect(promise).resolves.toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts
```

Expected: FAIL；当前实现立即创建 3 个 XHR。

- [ ] **Step 3: 实现最小顺序上传**

在 `uploadDirect()` 中按编号排序队列：

```ts
const queue = [...parts].sort((a, b) => a.partNumber - b.partNumber);
```

保留现有 `worker()` 重试循环，但将并发 worker 集合替换为单个 worker：

```ts
worker()
  .then(() => {
    options.signal?.removeEventListener("abort", onAbort);
    resolve();
  })
  .catch((err) => {
    options.signal?.removeEventListener("abort", onAbort);
    reject(err);
  });
```

删除 `DIRECT_CONCURRENCY`；不得改变 `partSize`、403 刷新和进度汇总逻辑。

- [ ] **Step 4: 更新已有并发测试以验证顺序下的进度不回退**

把同时访问两个 XHR 的断言改为：完成第 1 片后等待第 2 片创建，再触发第 2 片进度。保留最终 `onProgress(..., total)` 和 `10 / 10` 断言。

- [ ] **Step 5: 运行 API 测试确认 GREEN**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts
```

Expected: PASS；三个分片严格 1 → 2 → 3。

- [ ] **Step 6: 提交**

```bash
git add packages/frontend/src/api/upload-file.ts packages/frontend/src/api/upload-file.test.ts
git commit -m "fix: 按顺序上传阿里云分片"
```

---

### Task 2: 派发远程导入前重置进度

**Files:**

- Modify: `packages/server/src/job/job.service.ts:255-284`
- Test: `packages/server/src/job/job.service.test.ts:135-190`

**Interfaces:**

- Consumes: `download.size` 和现有 `Job.progress` JSON 字段。
- Produces: `pending` 的 `file.import` Job 同时写入 `progress: { loaded: 0, total: download.size }`。

- [ ] **Step 1: 扩展现有完成会话测试**

在“完成上传后补全 payload、转 pending 并返回 dispatch”中，将数据库断言改为：

```ts
expect(prisma.job.update).toHaveBeenCalledWith({
  where: { id: "job-1" },
  data: expect.objectContaining({
    status: "pending",
    payload: expect.stringContaining("downloadRef"),
    progress: JSON.stringify({ loaded: 0, total: 5 }),
  }),
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/job/job.service.test.ts
```

Expected: FAIL；当前更新没有 `progress`。

- [ ] **Step 3: 在同一次 Job 更新中重置进度**

```ts
await this.prisma.job.update({
  where: { id: jobId },
  data: {
    status: "pending",
    payload: JSON.stringify(finalPayload),
    progress: JSON.stringify({ loaded: 0, total: download.size }),
  },
});
```

不另发数据库请求，不修改 Client 进度事件。

- [ ] **Step 4: 运行 Server 测试确认 GREEN**

```bash
pnpm --filter @vcpdeck/server exec vitest run src/job/job.service.test.ts src/events/client.gateway.test.ts
```

Expected: PASS；Client 后续 `JOB_PROGRESS` 继续覆盖同一字段。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/job/job.service.ts packages/server/src/job/job.service.test.ts
git commit -m "fix: 重置远程导入阶段进度"
```

---

### Task 3: 文件页展示上传、保存与导入三阶段

**Files:**

- Modify: `packages/frontend/src/pages/files-panel.tsx:45-55,133-276,540-590`
- Test: `packages/frontend/src/pages/files-panel.test.tsx:350-500`

**Interfaces:**

- Consumes: `uploadDirect.onProgress`、`completeUpload()`、`jobs.wait().onUpdate`。
- Produces: `UploadState.phase` 新增 `"finalizing"`；远程阶段缺少进度时显示 `0 / file.size`，不沿用第一阶段 100%。

- [ ] **Step 1: 写失败测试，观察云盘保存状态**

让 `completeUpload` 返回一个手动控制的 Promise。触发 direct 上传后，在 resolve 前断言：

```ts
expect(await screen.findByText("正在保存到阿里云盘…")).toBeVisible();
```

- [ ] **Step 2: 写失败测试，观察第二阶段从 0 开始**

让 `jobs.wait` 捕获 `onUpdate`，先返回/推送：

```ts
onUpdate(job({ status: "running", progress: { loaded: 2, total: 5 } }));
```

断言文件页先出现“正在导入远程机器：report.txt”，进度元素先为 `0`，随后更新为 `2`；不得继续显示第一阶段 `5 / 5`。

- [ ] **Step 3: 运行测试确认 RED**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx
```

Expected: FAIL；当前没有 `finalizing`，且远程阶段缺省为 `file.size`。

- [ ] **Step 4: 扩展状态类型并设置阶段边界**

```ts
type UploadState = {
  phase: "uploading" | "finalizing" | "importing" | "done" | "error";
  filename: string;
  loaded: number;
  total: number;
  storage?: "alibaba";
  message?: string;
};
```

Direct `onProgress` 写入 `storage: "alibaba"`。`uploadDirect()` 完成且最终进度上报队列落盘后，调用 `completeUpload()` 前设置：

```ts
setUploadState({
  phase: "finalizing",
  filename: file.name,
  loaded: file.size,
  total: file.size,
  storage: "alibaba",
});
```

`completeUpload()` 返回后、`jobs.wait()` 前设置：

```ts
setUploadState({
  phase: "importing",
  filename: file.name,
  loaded: 0,
  total: file.size,
});
```

`onUpdate` 改为：

```ts
loaded: next.progress?.loaded ?? 0,
total: next.progress?.total ?? file.size,
```

- [ ] **Step 5: 更新文件页文案**

- direct `uploading`：`正在上传到阿里云盘：${filename}`；local/proxy 保留“正在上传”。
- `finalizing`：`正在保存到阿里云盘…`。
- `importing`：`正在导入远程机器：${filename}`。
- `done`：`导入完成：${filename}`。
- `error`：保留实际错误信息。

进度条继续只在非 `done/error` 阶段展示；`finalizing` 使用满进度值但文案不宣称整个导入完成。

- [ ] **Step 6: 运行文件页测试确认 GREEN**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/pages/files-panel.tsx packages/frontend/src/pages/files-panel.test.tsx
git commit -m "feat: 展示文件导入双阶段进度"
```

---

### Task 4: 通知铃铛展示准确阶段

**Files:**

- Modify: `packages/frontend/src/components/notification-bell.tsx:258-330`
- Test: `packages/frontend/src/components/notification-bell.test.tsx:90-220`

**Interfaces:**

- Consumes: Job 的 `status`、`type` 和 Server 重置后的 `progress`。
- Produces: `waiting_input`、`pending`、`running file.import` 三个明确阶段文案。

- [ ] **Step 1: 更新/增加失败测试**

验证：

```ts
// waiting_input, 2 / 5
expect(screen.getByText(/正在上传到阿里云盘/)).toBeInTheDocument();

// waiting_input, 5 / 5
expect(screen.getByText("上传完成 · 正在保存到阿里云盘…")).toBeInTheDocument();
expect(screen.queryByText(/100%/)).not.toBeInTheDocument();

// pending, 0 / 5
expect(screen.getByText(/等待远程机器接收/)).toBeInTheDocument();

// running file.import, 2 / 5
expect(screen.getByText(/正在导入远程机器/)).toBeInTheDocument();
expect(screen.getByText(/40%/)).toBeInTheDocument();
```

- [ ] **Step 2: 运行测试确认 RED**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/components/notification-bell.test.tsx
```

Expected: FAIL；当前文案仍为 Storage/远程目录，且 `waiting_input` 100% 仍显示百分比。

- [ ] **Step 3: 最小修改 `ProgressBar`**

阶段文案改为：

```ts
const stage =
  status === "waiting_input"
    ? "正在上传到阿里云盘"
    : status === "pending" && type === "file.import"
      ? "等待远程机器接收"
      : type === "file.import"
        ? "正在导入远程机器"
        : "";
```

在普通百分比前增加：

```ts
if (
  type === "file.import" &&
  status === "waiting_input" &&
  progress &&
  progress.total > 0 &&
  progress.loaded >= progress.total
) {
  return /* 满进度动画 + “上传完成 · 正在保存到阿里云盘…” */;
}
```

保留 `file.export` 现有“正在保存到云盘”分支。

- [ ] **Step 4: 运行通知测试确认 GREEN**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/components/notification-bell.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 提交**

由于该文件已有未提交格式/通知过滤变更，只暂存本任务语义代码块与对应测试，先检查：

```bash
git diff -- packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx
git add -p packages/frontend/src/components/notification-bell.tsx packages/frontend/src/components/notification-bell.test.tsx
git diff --cached --check
git commit -m "feat: 区分文件导入任务阶段"
```

---

### Task 5: 回归验证与真实阿里云验收

**Files:**

- Verify only: `packages/client/src/transfer-handler.test.ts`
- Verify: all modified files

**Interfaces:**

- Consumes: Task 1–4 的最终实现。
- Produces: 自动化验证、变更影响记录和真实三分片上传证据。

- [ ] **Step 1: 运行三端定向测试**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts src/pages/files-panel.test.tsx src/components/notification-bell.test.tsx
pnpm --filter @vcpdeck/server exec vitest run src/job/job.service.test.ts src/events/client.gateway.test.ts
pnpm --filter @vcpdeck/client exec vitest run src/transfer-handler.test.ts
```

Expected: 全部通过；Client 包含下载精确进度和大小不匹配清理测试。

- [ ] **Step 2: 运行三端构建**

```bash
pnpm --filter @vcpdeck/server build
pnpm --filter @vcpdeck/client build
pnpm --filter @vcpdeck/frontend build
```

Expected: exit 0；Vite 依赖包的 `"use client"` warning 可记录但不视为失败。

- [ ] **Step 3: 运行诊断和 diff 检查**

```bash
git diff --check
```

并运行 `lens_diagnostics(mode="all")`；阻断错误必须为 0。复杂度或 inline-style 既有 advisory 单独记录。

- [ ] **Step 4: 运行 GitNexus 变更检测**

运行：

```text
gitnexus_detect_changes({ scope: "all", repo: "VCPDeck" })
```

确认只影响浏览器上传、导入 Job 激活和通知展示预期流程；HIGH/CRITICAL 必须在总结中说明。

- [ ] **Step 5: 真实上传验收**

使用大于 `128 MiB` 的测试文件从文件页导入，确认：

1. 分片网络请求严格按 1 → 2 → 3 顺序；
2. 第一阶段进度持续更新；
3. 出现“正在保存到阿里云盘…”；
4. 第二阶段从 0% 开始并持续更新；
5. 最终文件大小与源文件一致；
6. Job 为 `done`，无 `PartNotSequential` 或 `Size mismatch`。

测试对象使用用户明确选择的文件；不要自动覆盖已有远程文件。

- [ ] **Step 6: 最终工作区检查**

```bash
git status --short --branch
git log -6 --oneline --decorate
```

报告仍未提交的既有格式化变更，不覆盖、不混入本任务提交。
