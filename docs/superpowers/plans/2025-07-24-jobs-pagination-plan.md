# Jobs 分页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `GET /api/jobs` 改为分页接口，对齐 FRP mappings 的分页模式。

**Architecture:** 纯对齐 — Service 加 `Promise.all([findMany, count])`、Controller 加 `@Query` 手动解析、SDK 加 `URLSearchParams`、前端取 `.data`。

**Tech Stack:** TypeScript, NestJS, Prisma, React

## Global Constraints

- 响应类型统一用 `PaginatedResult<T>`（字段 `data`，非 `items`）
- Controller 不引入 ValidationPipe，手动 parseInt
- pageSize 默认 20，上限 100
- 参考实现：FRP mappings 分页

---

### Task 1: Server — JobService.list() 改分页

**Files:**

- Modify: `packages/server/src/job/job.service.ts`

**Interfaces:**

- Produces: `list(options: { clientId?, status?, page?, pageSize? }) → Promise<PaginatedResult<JobInfo>>`

- [ ] **Step 1: 改造 list 方法**

将现有的：

```ts
async list(): Promise<JobInfo[]> {
  const jobs = await this.prisma.job.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return jobs.map(toJobInfo);
}
```

替换为：

```ts
async list(options: {
  clientId?: string;
  status?: JobStatus;
  page?: number;
  pageSize?: number;
} = {}): Promise<PaginatedResult<JobInfo>> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const where: Record<string, unknown> = {};
  if (options.clientId) where.clientId = options.clientId;
  if (options.status) where.status = options.status;

  const [jobs, total] = await Promise.all([
    this.prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    this.prisma.job.count({ where }),
  ]);

  return {
    data: jobs.map(toJobInfo),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
```

顶部 import 加 `PaginatedResult`：

```ts
import type { ..., PaginatedResult } from "@vcpdeck/shared";
```

- [ ] **Step 2: 检查 LSP diagnostics**

```bash
pnpm --filter @vcpdeck/server build
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/job/job.service.ts
git commit -m "feat(job): list() 改为分页，对齐 FRP 模式"
```

---

### Task 2: Server — EventsController.listJobs() 加查询参数

**Files:**

- Modify: `packages/server/src/events/events.controller.ts`

**Interfaces:**

- Consumes: `JobService.list(options)`
- Produces: `GET /api/jobs?clientId=&status=&page=&pageSize=` → `PaginatedResult<JobInfo>`

- [ ] **Step 1: 改造 listJobs**

将现有的：

```ts
@Get("jobs")
async listJobs() {
  return this.jobService.list();
}
```

替换为：

```ts
@Get("jobs")
async listJobs(
  @Query("clientId") clientId?: string,
  @Query("status") status?: string,
  @Query("page") page?: string,
  @Query("pageSize") pageSize?: string,
) {
  return this.jobService.list({
    clientId,
    status: status as JobStatus | undefined,
    page: page ? Math.max(1, parseInt(page, 10)) : undefined,
    pageSize: pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined,
  });
}
```

顶部 import 加 `Query`（已有）和 `JobStatus`（已有）。

- [ ] **Step 2: 检查 LSP diagnostics**

```bash
pnpm --filter @vcpdeck/server build
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/events/events.controller.ts
git commit -m "feat(events): listJobs 支持分页查询参数"
```

---

### Task 3: SDK — jobs.list() 加 options

**Files:**

- Modify: `packages/sdk/src/jobs.ts`

- [ ] **Step 1: 改造 list 方法**

将现有的：

```ts
list: (signal?: AbortSignal) =>
  client.request<JobInfo[]>("GET", "/api/jobs", undefined, signal),
```

替换为：

```ts
list: (
  options?: { clientId?: string; status?: string; page?: number; pageSize?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams();
  if (options?.clientId) params.set("clientId", options.clientId);
  if (options?.status) params.set("status", options.status);
  if (options?.page) params.set("page", String(options.page));
  if (options?.pageSize) params.set("pageSize", String(options.pageSize));
  const qs = params.toString();
  return client.request<PaginatedResult<JobInfo>>(
    "GET",
    `/api/jobs${qs ? `?${qs}` : ""}`,
    undefined,
    signal,
  );
},
```

顶部 import 加 `PaginatedResult`：

```ts
import type { JobCreate, JobCreateResult, JobInfo, PaginatedResult } from "@vcpdeck/shared";
```

- [ ] **Step 2: 检查构建**

```bash
pnpm --filter @vcpdeck/sdk build
```

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/jobs.ts
git commit -m "feat(sdk): jobs.list() 支持分页参数"
```

---

### Task 4: Frontend — JobsPage 适配分页

**Files:**

- Modify: `packages/frontend/src/pages/jobs-page.tsx`

- [ ] **Step 1: 改造数据加载和渲染**

`load` 回调加 clientId 参数：

```tsx
const load = useCallback(
  (signal: AbortSignal) => sdk.jobs.list({ clientId, pageSize: 100 }, signal),
  [sdk, clientId],
);
```

`jobs` 的 useMemo 去掉 clientId 前端过滤（后端已过滤），去掉 `query` 过滤改为本地搜索：

```tsx
const jobs = useMemo(
  () =>
    (resource.data?.data ?? []).filter(
      (job) =>
        !query ||
        `${job.clientId} ${job.type} ${job.status} ${describePayload(job)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ),
  [resource.data, query],
);
```

`title` 和空状态文案更新：

```tsx
title={clientId ? "机器任务记录" : "任务记录"}
```

`{resource.data?.data?.length === 0}` 替代 `{jobs.length === 0}`。

- [ ] **Step 2: 检查 LSP**

```bash
pnpm --filter @vcpdeck/frontend build
```

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/pages/jobs-page.tsx
git commit -m "feat(frontend): JobsPage 适配分页接口"
```

---

### Task 5: Frontend — DashboardPage 适配分页

**Files:**

- Modify: `packages/frontend/src/pages/dashboard-page.tsx`

- [ ] **Step 1: 改造数据加载**

`load` 回调中 `sdk.jobs.list(signal)` 改为：

```tsx
sdk.jobs.list({ pageSize: 5 }, signal),
```

DashboardData 类型中 `jobs: JobInfo[]` 改为 `jobs: PaginatedResult<JobInfo>`，取 `.data`：

```tsx
interface DashboardData {
  clients: ClientInfo[];
  jobs: PaginatedResult<JobInfo>;
  mappings: PaginatedResult<FrpMappingInfo>;
  storage: { authorized: boolean; configured: boolean };
}
```

下游用到 `jobs` 的地方改为 `jobs.data`（如 `jobs.data.length`）。

- [ ] **Step 2: 检查 LSP**

```bash
pnpm --filter @vcpdeck/frontend build
```

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/pages/dashboard-page.tsx
git commit -m "feat(frontend): DashboardPage 适配分页接口"
```
