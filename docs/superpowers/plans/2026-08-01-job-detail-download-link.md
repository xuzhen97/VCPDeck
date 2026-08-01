# Job 详情页展示导出下载链接 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Job 详情页对已完成的 `file.export` 任务展示永久有效的下载链接（可复制、可点击下载）。

**Architecture:** 复用现有签名下载链路：`POST /api/storage/download-token` 的 `ttlSeconds` 传入 `0` 时，两个 StorageProvider 的 `signDownloadUrl` 签出 `expires=0`（永久标记），`verifyDownloadSignature` 对 `expiresAt=0` 跳过时间检查。前端 job 详情页对 `file.export` + done 的 job 用 `result.key` 自动签发并展示 `location.origin + token.url`。

**Tech Stack:** NestJS（server）、TypeScript、Vitest、React（frontend）、@vcpdeck/shared

## Global Constraints

- 代码标识符/协议字段用英文；注释与 JSDoc 用简体中文
- TypeScript：ESM + strict，NodeNext 相对导入保留 `.js` 后缀
- 不改动上传签名（`signUploadUrl`）时效逻辑
- 文件面板即时"导出下载"的 `ttlSeconds` 保持默认（1 小时），不传 `0`
- 详情页不展示 payload 原文（保持现有安全承诺），payload 仅用于解析文件名
- 错误对象保持稳定 `code`、合适 `statusCode`、安全 message
- git commit 使用简体中文

---

### Task 1: 本地存储 provider 下载签名支持永久链接

**Files:**

- Modify: `packages/server/src/storage/providers/local-storage.provider.ts`（`signDownloadUrl`、`verifyDownloadSignature`）
- Test: `packages/server/src/storage/providers/local-storage.provider.test.ts`（新建）

**Interfaces:**

- Consumes: 无（独立任务）
- Produces:
  - `signDownloadUrl(key: string, expiresInSeconds: number): string` —— `expiresInSeconds <= 0` 时 query 中 `expires=0`
  - `verifyDownloadSignature(key: string, expiresAt: number, sig: string): boolean` —— `expiresAt === 0` 时跳过时间校验

- [ ] **Step 1: 写失败测试**

创建 `packages/server/src/storage/providers/local-storage.provider.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { LocalStorageProvider } from "./local-storage.provider.js";

describe("LocalStorageProvider download signature", () => {
 let provider: LocalStorageProvider;
 beforeEach(() => {
  provider = new LocalStorageProvider({ baseDir: "./data/storage-test" });
 });

 it("ttlSeconds <= 0 签出 expires=0（永久），verify 通过", () => {
  const qs = provider.signDownloadUrl("abc/def.txt", 0);
  expect(qs).toContain("expires=0");
  const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
  const sig = new URLSearchParams(qs).get("sig") || "";
  expect(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(
   true,
  );
 });

 it("正常 ttl 签出的签名过期后 verify 拒绝", () => {
  vi.useFakeTimers();
  try {
   const qs = provider.signDownloadUrl("abc/def.txt", 1); // 1 秒有效期
   const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
   const sig = new URLSearchParams(qs).get("sig") || "";
   expect(
    provider.verifyDownloadSignature("abc/def.txt", expires, sig),
   ).toBe(true);
   vi.setSystemTime(expires + 1000); // 越过过期时刻
   expect(
    provider.verifyDownloadSignature("abc/def.txt", expires, sig),
   ).toBe(false);
  } finally {
   vi.useRealTimers();
  }
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/server test -- src/storage/providers/local-storage.provider.test.ts`
Expected: 第一个用例 FAIL —— 当前 `signDownloadUrl(…, 0)` 签出 `expires=当前毫秒`，`verifyDownloadSignature` 立即判定过期（`Date.now() > 0` 恒真 → false）；第二个用例 PASS（过期拒绝逻辑已存在）。

- [ ] **Step 3: 实现**

修改 `local-storage.provider.ts`：

```ts
 signDownloadUrl(key: string, expiresInSeconds: number): string {
  // ttlSeconds <= 0 表示永久链接（expires=0），由清理任务兜底回收
  const expiresAt =
   expiresInSeconds <= 0 ? 0 : Date.now() + expiresInSeconds * 1000;
  const sig = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
  return `expires=${expiresAt}&sig=${sig}`;
 }

 verifyDownloadSignature(
  key: string,
  expiresAt: number,
  sig: string,
 ): boolean {
  if (expiresAt > 0 && Date.now() > expiresAt) return false;
  const expected = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
  return expected === sig;
 }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/server test -- src/storage/providers/local-storage.provider.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/storage/providers/local-storage.provider.ts packages/server/src/storage/providers/local-storage.provider.test.ts
git commit -m "feat: 本地存储下载签名支持永久链接（expires=0）"
```

---

### Task 2: 阿里云盘 provider 下载签名支持永久链接

**Files:**

- Modify: `packages/server/src/storage/providers/alibaba-storage.provider.ts`（`signDownloadUrl`、`verifyDownloadSignature`）
- Test: `packages/server/src/storage/providers/alibaba-storage.provider.test.ts`（新建）

**Interfaces:**

- Consumes: Task 1 的语义约定（`expires=0` = 永久）
- Produces: 同 Task 1 的签名（对称实现）

- [ ] **Step 1: 写失败测试**

创建 `packages/server/src/storage/providers/alibaba-storage.provider.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { AlibabaStorageProvider } from "./alibaba-storage.provider.js";

describe("AlibabaStorageProvider download signature", () => {
 let provider: AlibabaStorageProvider;
 beforeEach(() => {
  // 无需真实阿里云配置：签名/校验是纯本地 HMAC 逻辑
  provider = new AlibabaStorageProvider({});
 });

 it("ttlSeconds <= 0 签出 expires=0（永久），verify 通过", () => {
  const qs = provider.signDownloadUrl("aliyun-file-id-123", 0);
  expect(qs).toContain("expires=0");
  const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
  const sig = new URLSearchParams(qs).get("sig") || "";
  expect(provider.verifyDownloadSignature("aliyun-file-id-123", expires, sig)).toBe(
   true,
  );
 });

 it("签发的永久签名不因时间推移失效", async () => {
  const qs = provider.signDownloadUrl("aliyun-file-id-123", 0);
  const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
  const sig = new URLSearchParams(qs).get("sig") || "";
  // 模拟 1 小时前签发的永久链接
  const fakeOldSig = provider.verifyDownloadSignature(
   "aliyun-file-id-123",
   expires,
   sig,
  );
  expect(fakeOldSig).toBe(true);
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/server test -- src/storage/providers/alibaba-storage.provider.test.ts`
Expected: 第一个用例 FAIL（当前 `signDownloadUrl(…, 0)` 签出 `expires=当前毫秒`，verify 立即过期）

- [ ] **Step 3: 实现**

修改 `alibaba-storage.provider.ts`（与 Task 1 对称）：

```ts
 signDownloadUrl(key: string, expiresInSeconds: number): string {
  // ttlSeconds <= 0 表示永久链接（expires=0），由清理任务兜底回收
  const expiresAt =
   expiresInSeconds <= 0 ? 0 : Date.now() + expiresInSeconds * 1000;
  const sig = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
  return `expires=${expiresAt}&sig=${sig}`;
 }

 verifyDownloadSignature(
  key: string,
  expiresAt: number,
  sig: string,
 ): boolean {
  if (expiresAt > 0 && Date.now() > expiresAt) return false;
  const expected = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
  return expected === sig;
 }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/server test -- src/storage/providers/alibaba-storage.provider.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/storage/providers/alibaba-storage.provider.ts packages/server/src/storage/providers/alibaba-storage.provider.test.ts
git commit -m "feat: 阿里云盘下载签名支持永久链接（expires=0）"
```

---

### Task 3: 前端 Job 详情页展示下载链接

**Files:**

- Modify: `packages/frontend/src/pages/job-detail-page.tsx`
- Test: `packages/frontend/src/pages/job-detail-page.test.tsx`（新建）

**Interfaces:**

- Consumes:
  - `sdk.storage.createDownloadToken({ key: string; ttlSeconds?: number }, signal?)` → `{ url: string; expiresAt: number }`（url 为 `/api/storage/download/...` 相对路径，来自 `packages/sdk/src/storage.ts`）
  - `JobInfo.result.key`（`file.export` job 完成后由 client 上报，修复后为真实存储 key）
  - `JobInfo.payload.path`（`file.export` 的远程文件路径，用于解析文件名）
- Produces: 无（前端最终形态）

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/pages/job-detail-page.test.tsx`。先看现有测试的 mock 模式：`packages/frontend/src/pages/storage-page.test.tsx` 中 `sdk` 的构造方式（`vi.mock("@/api/context")` + `useSdk`），以及路由 mock（`useParams` 返回 `{ jobId: "job-1" }`）。测试骨架：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { JobDetailPage } from "./job-detail-page";
import { useSdk } from "@/api/context";

const mockJobsGet = vi.fn();
const mockCreateDownloadToken = vi.fn();

vi.mock("@/api/context", () => ({
 useSdk: () => ({
  jobs: { get: mockJobsGet },
  storage: { createDownloadToken: mockCreateDownloadToken },
 }),
}));

function renderDetail() {
 return render(
  <MemoryRouter initialEntries={["/jobs/job-1"]}>
   <Routes>
    <Route path="/jobs/:jobId" element={<JobDetailPage />} />
   </Routes>
  </MemoryRouter>,
 );
}

const exportJob = {
 jobId: "job-1",
 clientId: "c1",
 clientName: "machine-1",
 type: "file.export",
 status: "done",
 payload: { rootDir: "/srv", path: "/srv/logs/app.log" },
 result: { fileId: "f1", key: "aliyun-fileid-123", size: 1024, sha256: "x" },
 errorCode: null,
 errorMessage: null,
 createdAt: "2026-08-01T00:00:00.000Z",
 startedAt: "2026-08-01T00:00:00.000Z",
 finishedAt: "2026-08-01T00:00:00.000Z",
 createdByIdentityId: null,
 createdByName: "admin",
 createdVia: "ui",
};

beforeEach(() => {
 mockJobsGet.mockReset();
 mockCreateDownloadToken.mockReset();
});

describe("JobDetailPage 下载链接", () => {
 it("file.export 完成的 job 展示可点击的下载链接", async () => {
  mockJobsGet.mockResolvedValue(exportJob);
  mockCreateDownloadToken.mockResolvedValue({
   url: "/api/storage/download/aliyun-fileid-123?expires=0&sig=abc",
   expiresAt: 0,
  });
  renderDetail();

  const link = await screen.findByRole("link", { name: "下载文件" });
  expect(link).toHaveAttribute(
   "href",
   `${window.location.origin}/api/storage/download/aliyun-fileid-123?expires=0&sig=abc`,
  );
  expect(link).toHaveAttribute("download", "app.log");
  expect(
   screen.getByText(
    `${window.location.origin}/api/storage/download/aliyun-fileid-123?expires=0&sig=abc`,
   ),
  ).toBeInTheDocument();
  expect(mockCreateDownloadToken).toHaveBeenCalledWith({
   key: "aliyun-fileid-123",
   ttlSeconds: 0,
  });
 });

 it("签发失败时显示下载链接不可用", async () => {
  mockJobsGet.mockResolvedValue(exportJob);
  mockCreateDownloadToken.mockRejectedValue(new Error("invalid key"));
  renderDetail();
  expect(await screen.findByText("下载链接不可用")).toBeInTheDocument();
 });

 it("exec 类型的 job 不显示下载链接", async () => {
  mockJobsGet.mockResolvedValue({
   ...exportJob,
   type: "exec",
   result: { exitCode: 0 },
   payload: { command: "ls" },
  });
  renderDetail();
  expect(await screen.findByText("标准输出")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "下载文件" })).not.toBeInTheDocument();
 });
});
```

若测试遇到 `useResource` 的 loading/error 状态覆盖不到 `findByRole`，先确认 `use-resource.ts` 的轮询/刷新行为，必要时在断言前加 `await screen.findByText("file.export")`（详情页标题）等待首帧渲染完成。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- --run job-detail-page`
Expected: 3 个用例 FAIL（下载链接区块尚未实现）

- [ ] **Step 3: 实现**

在 `job-detail-page.tsx` 中新增 `DownloadLinkCard` 组件与渲染逻辑：

```tsx
import { useCallback, useState, useEffect } from "react";
import { useSdk } from "@/api/context";
import type { JobInfo } from "@vcpdeck/shared";

// 在 JobDetail 组件内，渲染"下载文件"区块（置于基本信息 Card 之后）：
function DownloadLinkCard({ job }: { job: JobInfo }) {
 const sdk = useSdk();
 const [url, setUrl] = useState<string | null>(null);
 const [failed, setFailed] = useState(false);
 const key = job.result?.key;
 const filename = String(job.payload?.path ?? "")
  .split(/[/\\]/)
  .pop() || "download";

 useEffect(() => {
  if (!key) {
   setFailed(true);
   return;
  }
  let cancelled = false;
  sdk.storage
   .createDownloadToken({ key: String(key), ttlSeconds: 0 })
   .then((token) => {
    if (!cancelled) setUrl(`${window.location.origin}${token.url}`);
   })
   .catch(() => {
    if (!cancelled) setFailed(true);
   });
  return () => {
   cancelled = true;
  };
 }, [sdk, key]);

 return (
  <Card>
   <CardContent className="space-y-3 pt-6">
    <p className="text-xs font-medium text-muted-foreground">
     下载文件（永久链接，清理任务回收存储空间后失效）
    </p>
    {failed ? (
     <p role="alert" className="text-sm text-red-400">
      下载链接不可用
     </p>
    ) : url ? (
     <>
      <a
       href={url}
       download={filename}
       className="text-sm font-medium text-primary underline underline-offset-4"
      >
       下载文件
      </a>
      <code className="block break-all rounded bg-muted p-2 text-xs">
       {url}
      </code>
     </>
    ) : (
     <p className="text-sm text-muted-foreground">正在生成下载链接…</p>
    )}
   </CardContent>
  </Card>
 );
}
```

在 `JobDetail` 中按条件渲染：

```tsx
{job.type === "file.export" &&
 job.status === "done" &&
 job.result?.key && <DownloadLinkCard job={job} />}
```

注意：`JobInfo.payload` 类型为 `Record<string, unknown>`，取 `payload.path` 时用 `String(job.payload?.path ?? "")`；`Card`/`CardContent` 已从 `@/components/ui/card` 导入。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/frontend test -- --run job-detail-page`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/pages/job-detail-page.tsx packages/frontend/src/pages/job-detail-page.test.tsx
git commit -m "feat: Job 详情页展示 file.export 永久下载链接"
```

---

### Task 4: 端到端验证与收尾

**Files:**

- 无代码改动；验证 + 文档

**Interfaces:**

- Consumes: Task 1-3 全部改动

- [ ] **Step 1: 全量测试与构建**

Run:

```bash
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/frontend test
pnpm build
```

Expected: 全部 PASS；构建产物正常输出

- [ ] **Step 2: 手动端到端验证**

按 spec「验证」一节：

1. 启动 server + client + frontend，执行一次 `file.export`
2. 打开对应 job 详情页 → 看到完整 URL（`location.origin` 前缀）
3. 点击"下载文件"→ 浏览器下载成功且文件名正确
4. 复制 URL 用 `curl -O "<url>"` 下载成功
5. 重启 server 后再次用同一 URL 下载，仍然有效（`expires=0` 不依赖内存态）
6. 回归：文件面板"导出下载"仍正常（1 小时令牌）

Expected: 以上全部通过

- [ ] **Step 3: 更新 spec 状态与提交（如有文档改动）**

如实现过程中与 spec 有出入（接口签名、字段命名），回改 `docs/superpowers/specs/2026-08-01-job-detail-download-link-design.md` 并提交：

```bash
git add docs/superpowers/specs/2026-08-01-job-detail-download-link-design.md
git commit -m "docs: 同步实现细节到设计文档"
```

---

## Self-Review 结果

- **Spec 覆盖**：spec 的「后端下载签名支持永久」（Task 1/2）、「前端 Job 详情页展示链接」（Task 3）、「验证」（Task 4）均有对应任务；「不做的事」边界（文件面板默认 1 小时、清理任务不动）在 Global Constraints 中显式声明。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型一致性**：`createDownloadToken({ key, ttlSeconds })` 签名与 `packages/sdk/src/storage.ts` 现有类型一致；`signDownloadUrl(key, expiresInSeconds)` / `verifyDownloadSignature(key, expiresAt, sig)` 与两个 provider 现有签名一致；`JobInfo.result.key` / `payload.path` 与 `@vcpdeck/shared` 现有类型一致。
