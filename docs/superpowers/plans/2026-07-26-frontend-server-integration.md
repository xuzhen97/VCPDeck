# Frontend 与 Server 对接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建基于 Noesis 视觉语言的 VCPDeck 完整操作控制台，并通过最小 `@vcpdeck/sdk` 对接当前 Server 的认证、Client、Job、文件、FRP、Storage 与阿里云盘能力。

**Architecture:** `@vcpdeck/sdk` 是唯一框架无关 REST 客户端，依赖 `@vcpdeck/shared`，集中处理 Cookie/Bearer、API 错误和 Job 轮询。Frontend 只通过 SDK 和薄 React hooks 获取数据，使用操作优先的 ConsoleShell、机器标签页和三栏文件资源管理器展示真实 Server 数据。

**Tech Stack:** TypeScript 7、React 18、React Router 7、Vite 5、Vitest、Testing Library、Tailwind CSS 4、Radix UI、Lucide React、pnpm workspace。

## Global Constraints

- 不修改 Server 路由、数据库模型或业务行为。
- 不实现 CLI、Skill、WebSocket、stdout/stderr 持久化、`agent.run` 或本地上传后 import。
- Frontend 不调用 `GET /api/storage/config`，不展示原始 Job JSON，不记录 Token、Cookie、签名 URL、密码或 clientSecret。
- Job 等待固定使用 `1s → 2s → 5s → 后续 5s`，仅 `done/error/cancelled` 是终态，`disconnected` 继续等待。
- 只有 exec 对外宣称可可靠取消；FRP 删除只描述为已删除 Server 记录，不能宣称 Client 已清理。
- 文件根必须来自 `file.roots`；不得猜测 Windows 盘符或持久化 rootDir。
- UI 只展示真实接口可得数据；不展示 CPU、内存、磁盘、离线 Client、实时输出或虚构搜索。
- 公共导出类型、类、函数使用简体中文 JSDoc；代码标识符和协议字段使用英文。
- NodeNext 包内相对导入保留 `.js`；Frontend 使用 Bundler module resolution。
- 每项业务功能先写失败测试，再写最小实现。

---

## 文件结构锁定

```text
packages/sdk/
├── package.json
├── tsconfig.json
└── src/
    ├── client.ts              # fetch、认证、错误与 URL 拼接
    ├── auth.ts                # auth、identity、token API
    ├── clients.ts             # Client API
    ├── jobs.ts                # Job API 与 wait
    ├── files.ts               # file.* Job 薄封装
    ├── storage.ts             # 签名 URL 与 backend 切换
    ├── aliyundrive.ts         # 阿里云盘 OAuth
    ├── frp.ts                 # FRP CRUD
    ├── index.ts               # 公共导出与 VcpDeckClient
    ├── client.test.ts
    ├── jobs.test.ts
    └── domains.test.ts

packages/frontend/src/
├── app/
│   ├── console-shell.tsx      # 导航、主题、响应式 Shell
│   ├── routes.tsx             # 认证路由和业务路由
│   └── theme.ts               # 主题/侧栏本地偏好
├── api/
│   ├── context.tsx            # SDK 实例与 401 退出
│   └── hooks/
│       ├── use-resource.ts
│       ├── use-job-action.ts
│       └── use-file-browser.ts
├── components/
│   ├── ui/                    # Button/Card/Input/Label/Dialog/Tabs/Table/Select/Dropdown/Toast
│   ├── async-state.tsx
│   ├── confirm-target-dialog.tsx
│   ├── page-heading.tsx
│   └── status-chip.tsx
├── pages/
│   ├── login-page.tsx
│   ├── dashboard-page.tsx
│   ├── machines-page.tsx
│   ├── machine-workspace.tsx
│   ├── execute-panel.tsx
│   ├── files-panel.tsx
│   ├── jobs-page.tsx
│   ├── job-detail-page.tsx
│   ├── frp-page.tsx
│   ├── storage-page.tsx
│   └── settings-page.tsx
├── auth-context.tsx
├── styles.css
├── App.tsx
├── main.tsx
└── test-setup.ts
```

现有 `LoginPage.tsx`、`DashboardPage.tsx`、`TokensPage.tsx`、`IdentitiesPage.tsx` 和 `AuthContext.tsx` 在对应任务迁移后删除，避免新旧页面并存。

---

### Task 1: 建立 `@vcpdeck/sdk` 核心请求层

**Files:**

- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/src/client.ts`
- Create: `packages/sdk/src/client.test.ts`
- Create: `packages/sdk/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `AuthMode`, `VcpDeckClientOptions`, `VcpDeckApiError`, `VcpDeckClient.request<T>()`。
- Consumes: 标准 `fetch`、`@vcpdeck/shared`。

- [ ] **Step 1: 创建 SDK 包配置和失败测试**

`packages/sdk/package.json`：

```json
{
  "name": "@vcpdeck/sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@vcpdeck/shared": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^3.2.0"
  }
}
```

`packages/sdk/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

`packages/sdk/src/client.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { VcpDeckApiError, VcpDeckClient } from "./client.js";

describe("VcpDeckClient", () => {
  it("uses browser cookie credentials", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const client = new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" }, fetch: fetcher });
    await client.request("GET", "/api/health");
    expect(fetcher).toHaveBeenCalledWith("/api/health", expect.objectContaining({ credentials: "include" }));
  });

  it("uses bearer authorization without logging the token", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const client = new VcpDeckClient({ baseUrl: "http://localhost:3001/", auth: { type: "bearer", token: "vcp_secret" }, fetch: fetcher });
    await client.request("GET", "/api/health");
    expect(fetcher).toHaveBeenCalledWith("http://localhost:3001/api/health", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer vcp_secret" }) }));
  });

  it("normalizes non-json failures", async () => {
    const client = new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" }, fetch: async () => new Response("bad gateway", { status: 502 }) });
    await expect(client.request("GET", "/api/jobs")).rejects.toMatchObject<VcpDeckApiError>({ status: 502 });
  });
});
```

- [ ] **Step 2: 安装依赖并确认测试失败**

Run: `pnpm install && pnpm --filter @vcpdeck/sdk test`

Expected: FAIL，提示 `./client.js` 或 `VcpDeckClient` 不存在。

- [ ] **Step 3: 实现唯一具体 HTTP Client**

`packages/sdk/src/client.ts`：

```ts
export type AuthMode =
  | { type: "cookie" }
  | { type: "bearer"; token: string };

export interface VcpDeckClientOptions {
  baseUrl: string;
  auth: AuthMode;
  fetch?: typeof globalThis.fetch;
}

/** VCPDeck REST API 归一化错误。 */
export class VcpDeckApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "VcpDeckApiError";
  }
}

/** VCPDeck 唯一框架无关 REST 客户端。 */
export class VcpDeckClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: VcpDeckClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        signal,
        credentials: this.options.auth.type === "cookie" ? "include" : undefined,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.options.auth.type === "bearer" ? { Authorization: `Bearer ${this.options.auth.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new VcpDeckApiError("Network request failed", 0);
    }

    const text = await response.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!response.ok) {
      const code = typeof parsed?.code === "string" ? parsed.code : undefined;
      const message = typeof parsed?.message === "string" ? parsed.message : response.statusText || `HTTP ${response.status}`;
      throw new VcpDeckApiError(message, response.status, code, parsed);
    }
    return parsed as T;
  }
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}
```

`packages/sdk/src/index.ts`：

```ts
export * from "./client.js";
```

- [ ] **Step 4: 运行 SDK 测试与构建**

Run: `pnpm --filter @vcpdeck/sdk test && pnpm --filter @vcpdeck/sdk build`

Expected: 3 tests PASS；TypeScript build PASS。

- [ ] **Step 5: 提交核心 SDK**

```bash
git add packages/sdk pnpm-lock.yaml
git commit -m "feat(sdk): 添加 VCPDeck REST 客户端"
```

---

### Task 2: 实现 Job API、统一等待与文件 Job 封装

**Files:**

- Create: `packages/sdk/src/jobs.ts`
- Create: `packages/sdk/src/jobs.test.ts`
- Create: `packages/sdk/src/files.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**

- Consumes: `VcpDeckClient.request<T>()`、`JobCreate`、`JobInfo`、`JobStatus`。
- Produces: `createJobsApi(client)`, `createFilesApi(client)`, `WaitJobOptions`。

- [ ] **Step 1: 写 Job 等待和文件 roots 的失败测试**

`packages/sdk/src/jobs.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { JobStatus } from "@vcpdeck/shared";
import { createFilesApi } from "./files.js";
import { createJobsApi } from "./jobs.js";

it("waits through disconnected and returns done", async () => {
  vi.useFakeTimers();
  const request = vi.fn()
    .mockResolvedValueOnce({ jobId: "j1", status: JobStatus.DISCONNECTED })
    .mockResolvedValueOnce({ jobId: "j1", status: JobStatus.DONE, result: { exitCode: 0 } });
  const promise = createJobsApi({ request } as any).wait("j1");
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(2000);
  await expect(promise).resolves.toMatchObject({ status: JobStatus.DONE });
  vi.useRealTimers();
});

it("stops local waiting when aborted", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const promise = createJobsApi({ request: vi.fn() } as any).wait("j1", { signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  vi.useRealTimers();
});

it("wraps file.roots as a read job", async () => {
  const jobs = {
    create: vi.fn().mockResolvedValue({ jobId: "j1" }),
    wait: vi.fn().mockResolvedValue({ status: JobStatus.DONE, result: { roots: ["C:\\"] } }),
  };
  await expect(createFilesApi(jobs as any).roots("c1")).resolves.toEqual(["C:\\"]);
  expect(jobs.create).toHaveBeenCalledWith({ clientId: "c1", type: "file.roots", payload: {} });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/sdk test -- jobs.test.ts`

Expected: FAIL，提示 `jobs.js`、`files.js` 不存在。

- [ ] **Step 3: 实现 Job API 和退避等待**

`packages/sdk/src/jobs.ts`：

```ts
import { JobStatus, type JobCreate, type JobCreateResult, type JobInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

export interface WaitJobOptions {
  signal?: AbortSignal;
  delays?: readonly number[];
}

const terminal = new Set<JobStatus>([JobStatus.DONE, JobStatus.ERROR, JobStatus.CANCELLED]);

/** 创建 Job REST API。 */
export function createJobsApi(client: Pick<VcpDeckClient, "request">) {
  return {
    list: (signal?: AbortSignal) => client.request<JobInfo[]>("GET", "/api/jobs", undefined, signal),
    get: (jobId: string, signal?: AbortSignal) => client.request<JobInfo>("GET", `/api/jobs/${encodeURIComponent(jobId)}`, undefined, signal),
    create: (input: JobCreate, signal?: AbortSignal) => client.request<JobCreateResult>("POST", "/api/jobs", input, signal),
    cancel: (jobId: string, signal?: AbortSignal) => client.request<{ jobId: string; status: string }>("POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, signal),
    async wait(jobId: string, options: WaitJobOptions = {}): Promise<JobInfo> {
      const delays = options.delays ?? [1000, 2000, 5000];
      for (let attempt = 0; ; attempt++) {
        await sleep(delays[Math.min(attempt, delays.length - 1)], options.signal);
        const job = await client.request<JobInfo>("GET", `/api/jobs/${encodeURIComponent(jobId)}`, undefined, options.signal);
        if (terminal.has(job.status)) return job;
      }
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
```

- [ ] **Step 4: 实现文件 Job 薄封装**

`packages/sdk/src/files.ts`：

```ts
import { JobStatus, type FileListResult, type FileReadTextResult, type FileRootsResult, type JobCreate } from "@vcpdeck/shared";
import type { createJobsApi } from "./jobs.js";

type JobsApi = ReturnType<typeof createJobsApi>;

/** 创建远程文件 Job API。 */
export function createFilesApi(jobs: Pick<JobsApi, "create" | "wait">) {
  async function run<T>(input: JobCreate, signal?: AbortSignal): Promise<T> {
    const created = await jobs.create(input, signal);
    const job = await jobs.wait(created.jobId, { signal });
    if (job.status !== JobStatus.DONE) throw job;
    return job.result as T;
  }

  return {
    roots: async (clientId: string, signal?: AbortSignal) => (await run<FileRootsResult>({ clientId, type: "file.roots", payload: {} }, signal)).roots,
    list: (clientId: string, rootDir: string, path: string, signal?: AbortSignal) => run<FileListResult>({ clientId, type: "file.list", payload: { rootDir, path } }, signal),
    readText: (clientId: string, rootDir: string, path: string, maxBytes = 262144, signal?: AbortSignal) => run<FileReadTextResult>({ clientId, type: "file.readText", payload: { rootDir, path, maxBytes } }, signal),
    writeText: (clientId: string, payload: { rootDir: string; path: string; content: string }, signal?: AbortSignal) => run<{ path: string }>({ clientId, type: "file.writeText", payload }, signal),
    mkdir: (clientId: string, payload: { rootDir: string; path: string }, signal?: AbortSignal) => run<{ path: string }>({ clientId, type: "file.mkdir", payload }, signal),
    delete: (clientId: string, payload: { rootDir: string; path: string; recursive?: boolean }, signal?: AbortSignal) => run<{ path: string }>({ clientId, type: "file.delete", payload }, signal),
    move: (clientId: string, payload: { rootDir: string; source: string; destination: string; overwrite?: boolean }, signal?: AbortSignal) => run<{ path: string }>({ clientId, type: "file.move", payload }, signal),
    export: (clientId: string, payload: { rootDir: string; path: string }, signal?: AbortSignal) => run<{ fileId: string; key: string; size: number; sha256: string }>({ clientId, type: "file.export", payload }, signal),
    import: (clientId: string, payload: { rootDir: string; targetPath: string; fileId: string }, signal?: AbortSignal) => run<{ path: string; size: number; sha256: string }>({ clientId, type: "file.import", payload }, signal),
  };
}
```

更新 `packages/sdk/src/index.ts`：

```ts
export * from "./client.js";
export * from "./jobs.js";
export * from "./files.js";
```

- [ ] **Step 5: 运行测试和构建**

Run: `pnpm --filter @vcpdeck/sdk test && pnpm --filter @vcpdeck/sdk build`

Expected: 所有 SDK tests PASS，build PASS。

- [ ] **Step 6: 提交 Job 与文件 SDK**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): 添加 Job 轮询和文件 API"
```

---

### Task 3: 完成 SDK 业务领域 API 与统一入口

**Files:**

- Create: `packages/sdk/src/auth.ts`
- Create: `packages/sdk/src/clients.ts`
- Create: `packages/sdk/src/storage.ts`
- Create: `packages/sdk/src/aliyundrive.ts`
- Create: `packages/sdk/src/frp.ts`
- Create: `packages/sdk/src/domains.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**

- Consumes: `VcpDeckClient.request<T>()`, `createJobsApi()`, `createFilesApi()`。
- Produces: `VcpDeckClient` 上的 `health/auth/identities/clients/jobs/files/storage/aliyundrive/frp` 属性。

- [ ] **Step 1: 写领域路由与敏感边界失败测试**

`packages/sdk/src/domains.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import { VcpDeckClient } from "./index.js";

it("calls clients and frp routes", async () => {
  const fetcher = vi.fn(async () => Response.json([]));
  const client = new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" }, fetch: fetcher });
  await client.clients.list();
  await client.frp.list("c1");
  expect(fetcher).toHaveBeenNthCalledWith(1, "/api/clients", expect.any(Object));
  expect(fetcher).toHaveBeenNthCalledWith(2, "/api/frp/mappings?clientId=c1", expect.any(Object));
});

it("switches storage backend without reading raw config", async () => {
  const fetcher = vi.fn(async () => Response.json({ kind: "alibaba" }));
  const client = new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" }, fetch: fetcher });
  await client.storage.setBackend({ kind: "alibaba" });
  expect(fetcher).toHaveBeenCalledWith("/api/storage/config", expect.objectContaining({ method: "PUT" }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/sdk test -- domains.test.ts`

Expected: FAIL，`clients`、`frp` 或 `storage` 不存在。

- [ ] **Step 3: 实现各领域薄函数**

每个文件只导出一个 `create*Api(client)`。例如 `packages/sdk/src/frp.ts`：

```ts
import type { FrpMappingCreateRequest, FrpMappingInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 创建 FRP REST API。 */
export function createFrpApi(client: Pick<VcpDeckClient, "request">) {
  return {
    list: (clientId?: string, signal?: AbortSignal) => client.request<FrpMappingInfo[]>("GET", `/api/frp/mappings${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`, undefined, signal),
    get: (id: string, signal?: AbortSignal) => client.request<FrpMappingInfo>("GET", `/api/frp/mappings/${encodeURIComponent(id)}`, undefined, signal),
    create: (input: FrpMappingCreateRequest, signal?: AbortSignal) => client.request<FrpMappingInfo>("POST", "/api/frp/mappings", input, signal),
    delete: (id: string, signal?: AbortSignal) => client.request<{ id: string; deleted: true }>("DELETE", `/api/frp/mappings/${encodeURIComponent(id)}`, undefined, signal),
  };
}
```

其余文件严格映射 `docs/integration-guide.md`：

```ts
createAuthApi(client)       // login/logout/me/updateMe/tokens
createIdentitiesApi(client) // list/create/disable/enable
createClientsApi(client)    // GET /api/clients
createStorageApi(client)    // upload-token/download-token/delete/setBackend；不提供 getConfig
createAliyunDriveApi(client) // status/configure/startOAuth/completeOAuth/revoke
```

- [ ] **Step 4: 将领域 API 挂到 `VcpDeckClient`**

在 `packages/sdk/src/client.ts` 构造函数中初始化只读属性：

```ts
readonly jobs = createJobsApi(this);
readonly files = createFilesApi(this.jobs);
readonly auth = createAuthApi(this);
readonly identities = createIdentitiesApi(this);
readonly clients = createClientsApi(this);
readonly storage = createStorageApi(this);
readonly aliyundrive = createAliyunDriveApi(this);
readonly frp = createFrpApi(this);
readonly health = { get: (signal?: AbortSignal) => this.request<{ ok: true }>("GET", "/api/health", undefined, signal) };
```

更新 `packages/sdk/src/index.ts` 导出公共 API 类型与类。

- [ ] **Step 5: 运行 SDK 全量验证**

Run: `pnpm --filter @vcpdeck/sdk test && pnpm --filter @vcpdeck/sdk build`

Expected: 所有测试 PASS；SDK 产出 `dist/index.js` 和声明文件。

- [ ] **Step 6: 提交完整 SDK**

```bash
git add packages/sdk
git commit -m "feat(sdk): 完成 VCPDeck 业务 API"
```

---

### Task 4: 建立 Frontend 视觉基础、测试环境与 ConsoleShell

**Files:**

- Modify: `packages/frontend/package.json`
- Modify: `packages/frontend/vite.config.ts`
- Modify: `packages/frontend/tsconfig.json`
- Modify: `packages/frontend/src/main.tsx`
- Create: `packages/frontend/src/styles.css`
- Create: `packages/frontend/src/lib/utils.ts`
- Create: `packages/frontend/src/components/ui/{button,card,input,label,dialog,tabs,table,select,dropdown-menu}.tsx`
- Create: `packages/frontend/src/components/{page-heading,status-chip,async-state,confirm-target-dialog}.tsx`
- Create: `packages/frontend/src/app/theme.ts`
- Create: `packages/frontend/src/app/console-shell.tsx`
- Create: `packages/frontend/src/test-setup.ts`
- Create: `packages/frontend/src/app/console-shell.test.tsx`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: React Router、Noesis 视觉参考。
- Produces: `ConsoleShell`, `Theme`, `ConfirmTargetDialog`, UI primitives。

- [ ] **Step 1: 添加最小依赖与测试脚本**

Frontend dependencies 增加 `@vcpdeck/sdk`, Tailwind、Lucide、所需 Radix 包、`clsx`、`tailwind-merge`、`class-variance-authority`；devDependencies 增加 Vitest、jsdom、Testing Library、`@tailwindcss/vite`。脚本：

```json
{
  "scripts": {
    "build": "tsc && vite build",
    "dev": "vite",
    "test": "vitest run"
  }
}
```

在 Vite 配置加入 Tailwind 插件、`@` alias 和 test environment `jsdom`/setupFiles。

- [ ] **Step 2: 写 Shell 导航和危险确认失败测试**

```tsx
it("renders operation-first navigation", () => {
  render(<MemoryRouter><ConsoleShell identity={admin} onLogout={vi.fn()}><p>content</p></ConsoleShell></MemoryRouter>);
  for (const label of ["概览", "机器", "任务", "FRP", "存储", "设置"]) expect(screen.getByRole("link", { name: label })).toBeVisible();
});

it("requires exact target before destructive confirmation", async () => {
  const onConfirm = vi.fn();
  render(<ConfirmTargetDialog open target="D:/work/data" title="删除目录" onConfirm={onConfirm} onOpenChange={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("输入目标以确认"), "D:/work/data");
  await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm install && pnpm --filter @vcpdeck/frontend test`

Expected: FAIL，Shell/UI 文件不存在。

- [ ] **Step 4: 实现样式和 UI primitives**

以 `D:/noesis/packages/web/src/styles.css` 的 token、背景、Shell、panel、nav-link 为参考，类名前缀改为 `vcpdeck-*`。复制视觉思想，不复制 Noesis 产品名称或业务文案。

实现 UI primitives，保证：

- Button 最小高度 44px；
- Dialog 使用 Radix Overlay/Content/Title/Description；
- Tabs、Select、Dropdown 保留键盘语义；
- `ConfirmTargetDialog` 只有输入与 `target` 完全一致时启用确认按钮。

- [ ] **Step 5: 实现主题和 ConsoleShell**

`Theme = "dark" | "light"`，默认 dark；localStorage 只保存 theme 与 sidebarCollapsed。Shell 路由项固定为规格中的六项，移动端显示横向导航，不添加搜索占位。

- [ ] **Step 6: 接入样式并运行测试/构建**

`main.tsx` 导入 `./styles.css`。Run:

```bash
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

Expected: Shell tests PASS；Frontend build PASS。

- [ ] **Step 7: 提交前端基础**

```bash
git add packages/frontend pnpm-lock.yaml
git commit -m "feat(frontend): 添加控制台视觉基础"
```

---

### Task 5: 迁移认证、登录与路由框架到 SDK

**Files:**

- Create: `packages/frontend/src/api/context.tsx`
- Create: `packages/frontend/src/auth-context.tsx`
- Create: `packages/frontend/src/pages/login-page.tsx`
- Create: `packages/frontend/src/app/routes.tsx`
- Modify: `packages/frontend/src/App.tsx`
- Delete: `packages/frontend/src/api.ts`
- Delete: `packages/frontend/src/AuthContext.tsx`
- Delete: `packages/frontend/src/LoginPage.tsx`
- Test: `packages/frontend/src/auth-context.test.tsx`

**Interfaces:**

- Consumes: `VcpDeckClient`, `ConsoleShell`。
- Produces: `useSdk()`, `useAuth()`, authenticated route boundary。

- [ ] **Step 1: 写 checking、登录和 401 失败测试**

测试三条行为：首次 `auth.me()` 成功进入 Shell；失败进入登录；登录成功导航 `/dashboard`。SDK 用 context 注入 fake client，不 mock 全局 fetch。

- [ ] **Step 2: 运行测试确认旧认证结构不满足**

Run: `pnpm --filter @vcpdeck/frontend test -- auth-context.test.tsx`

Expected: FAIL，`SdkProvider` 或新路由不存在。

- [ ] **Step 3: 实现 SDK Context 和 AuthContext**

`SdkProvider` 默认实例：

```ts
new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" } })
```

AuthContext 公开：

```ts
interface AuthState {
  identity: IdentityInfo | null;
  phase: "checking" | "authenticated" | "unauthenticated";
  login(input: LoginRequest): Promise<void>;
  logout(): Promise<void>;
  handleUnauthorized(): void;
}
```

- [ ] **Step 4: 实现登录页和路由**

登录页双栏、主题切换、提交状态和通用失败文案。Authenticated routes 用 `ConsoleShell` 包裹；未登录只允许 `/login`。

- [ ] **Step 5: 删除旧 API/认证文件并验证**

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

Expected: PASS；无旧 `api.ts` import。

- [ ] **Step 6: 提交认证迁移**

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 使用 SDK 重构认证与路由"
```

---

### Task 6: 对接概览、机器列表与机器工作区

**Files:**

- Create: `packages/frontend/src/api/hooks/use-resource.ts`
- Create: `packages/frontend/src/pages/dashboard-page.tsx`
- Create: `packages/frontend/src/pages/machines-page.tsx`
- Create: `packages/frontend/src/pages/machine-workspace.tsx`
- Test: `packages/frontend/src/pages/machines-page.test.tsx`
- Modify: `packages/frontend/src/app/routes.tsx`
- Delete: `packages/frontend/src/DashboardPage.tsx`

**Interfaces:**

- Consumes: `sdk.clients.list()`, `sdk.jobs.list()`, `sdk.frp.list()`, `sdk.aliyundrive.status()`。
- Produces: `/dashboard`, `/machines`, `/machines/:clientId/:tab` 页面骨架。

- [ ] **Step 1: 写机器页面四态测试**

测试 loading、empty、error、success，并断言 capability 标签和“执行/文件/FRP”链接。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- machines-page.test.tsx`

Expected: FAIL，新页面不存在。

- [ ] **Step 3: 实现 `useResource`**

Hook 接受 `(signal) => Promise<T>`，返回：

```ts
{ data, error, loading, refreshing, reload }
```

使用 AbortController；卸载中止；刷新保留旧 data。

- [ ] **Step 4: 实现概览和机器页面**

概览只计算在线机器、Job 状态、FRP 状态、阿里云盘授权状态和最近 Job。机器卡片只使用 `ClientInfo` 字段。

- [ ] **Step 5: 实现机器标签路由骨架**

机器工作区标题显示 hostname/clientId/OS/capabilities；tabs 使用 URL 导航：overview、execute、files、frp、jobs。Client 不在在线列表时显示“机器当前不在线”，不伪造历史详情。

- [ ] **Step 6: 验证并提交**

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 对接概览和机器工作区"
```

---

### Task 7: 对接执行、全局 Job 与可靠轮询

**Files:**

- Create: `packages/frontend/src/api/hooks/use-job-action.ts`
- Create: `packages/frontend/src/pages/execute-panel.tsx`
- Create: `packages/frontend/src/pages/jobs-page.tsx`
- Create: `packages/frontend/src/pages/job-detail-page.tsx`
- Test: `packages/frontend/src/pages/execute-panel.test.tsx`
- Test: `packages/frontend/src/pages/jobs-page.test.tsx`
- Modify: `packages/frontend/src/pages/machine-workspace.tsx`
- Modify: `packages/frontend/src/app/routes.tsx`

**Interfaces:**

- Consumes: `sdk.jobs.create/wait/list/get/cancel`。
- Produces: command/script 表单、诚实结果摘要、最近 100 条 Job 页面。

- [ ] **Step 1: 写执行摘要失败测试**

测试 command payload、script payload、done exitCode、errorCode，以及固定文案“当前 Server 未持久化过程输出”。

- [ ] **Step 2: 写 Job 页面约束失败测试**

测试“最近 100 条”“跨身份可见”说明；只有 exec running/pending 显示取消；payload 通过 type 渲染而非原始 JSON。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- execute-panel.test.tsx jobs-page.test.tsx`

Expected: FAIL。

- [ ] **Step 4: 实现 `useJobAction`**

状态：

```ts
{ phase: "idle" | "creating" | "waiting" | "complete" | "error", job, error, run, reset }
```

`run(input)` 先 create 再 wait；卸载中止本地等待，不 cancel 远端。

- [ ] **Step 5: 实现执行和 Job 页面**

- command/script 字段严格匹配 Server；
- 结果计算耗时；
- jobs 每 10 秒刷新，document hidden 时暂停；
- Client/type/status 在内存筛选；
- 详情脱敏显示；
- exec 取消后继续轮询到终态。

- [ ] **Step 6: 验证并提交**

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 对接执行和 Job 追踪"
```

---

### Task 8: 实现 `file.roots` 驱动的三栏文件资源管理器

**Files:**

- Create: `packages/frontend/src/api/hooks/use-file-browser.ts`
- Create: `packages/frontend/src/pages/files-panel.tsx`
- Create: `packages/frontend/src/pages/file-detail.tsx`
- Test: `packages/frontend/src/pages/files-panel.test.tsx`
- Modify: `packages/frontend/src/pages/machine-workspace.tsx`

**Interfaces:**

- Consumes: `sdk.files.roots/list/readText/writeText/mkdir/delete/move/export`、`sdk.storage.createDownloadToken()`。
- Produces: 桌面三栏、移动列表到详情、路径确认交互。

- [ ] **Step 1: 写 roots 到 list 的失败测试**

测试顺序：进入页面调用 `files.roots(clientId)`；点击 `D:\` 后调用 `files.list(clientId, "D:\\", ".")`；Linux `/` 同样可用；不出现猜测盘符。

- [ ] **Step 2: 写文件安全行为失败测试**

测试：256 KiB 超限提示 export；删除需要输入完整路径；本地上传/import 入口不存在；IO error 就地展示。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- files-panel.test.tsx`

Expected: FAIL。

- [ ] **Step 4: 实现文件浏览状态 Hook**

状态：

```ts
{
  roots, selectedRoot, path, entries, selectedEntry,
  loading, error,
  selectRoot(root), enter(name), up(), refresh(), select(entry)
}
```

路径显示使用平台返回分隔符，但 Job payload 保留 rootDir + 相对 path；不写 localStorage。

- [ ] **Step 5: 实现三栏和动作**

- 左栏 roots + mkdir/export；
- 中栏 breadcrumb + Table；
- 右栏 stat/readText/edit/move/delete/export；
- 中屏隐藏右栏，移动端导航 file-detail；
- export 完成后用 key 申请 URL并立即创建临时 `<a download>`，触发后移除；
- 删除/覆盖 move 使用 `ConfirmTargetDialog`；
- 文件页常驻可信操作者/symlink 风险提示。

- [ ] **Step 6: 验证并提交**

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 添加远程文件资源管理器"
```

---

### Task 9: 对接 FRP 全局页和机器标签

**Files:**

- Create: `packages/frontend/src/pages/frp-page.tsx`
- Create: `packages/frontend/src/pages/frp-panel.tsx`
- Test: `packages/frontend/src/pages/frp-page.test.tsx`
- Modify: `packages/frontend/src/pages/machine-workspace.tsx`
- Modify: `packages/frontend/src/app/routes.tsx`

**Interfaces:**

- Consumes: `sdk.frp.list/get/create/delete`。
- Produces: FRP 列表、创建轮询、目标名称删除确认。

- [ ] **Step 1: 写创建轮询和删除语义失败测试**

测试创建返回 inactive 后调用 `frp.get(id)` 直到 active/error；删除 Dialog 要求映射名称；成功文案必须精确包含“Client 清理状态尚未确认”。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- frp-page.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现共享 FRP Panel**

`FrpPanel({ clientId? })`：全局无过滤，机器页传 clientId。创建表单按 proxyType 显示 customDomain；状态轮询 1s/2s/5s，页面卸载中止。

- [ ] **Step 4: 实现删除限制文案和验证**

删除 REST 成功只从列表移除并显示固定限制文案，不轮询内部 Job，不宣称远端清理。

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

- [ ] **Step 5: 提交 FRP 页面**

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 对接 FRP 映射管理"
```

---

### Task 10: 对接 Storage/阿里云盘保守管理页

**Files:**

- Create: `packages/frontend/src/pages/storage-page.tsx`
- Test: `packages/frontend/src/pages/storage-page.test.tsx`
- Modify: `packages/frontend/src/app/routes.tsx`

**Interfaces:**

- Consumes: `sdk.aliyundrive.status/configure/startOAuth/completeOAuth/revoke`, `sdk.storage.setBackend`。
- Produces: 不读取 raw config 的安全设置流程。

- [ ] **Step 1: 写“禁止读取 raw config”和 OAuth 流程失败测试**

测试页面只调用 aliyundrive.status；不调用任何 `storage.getConfig`（SDK 本身也没有该方法）；start 显示/打开 authorizationUrl；complete 后清空 code 并刷新 status。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- storage-page.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现安全状态和配置表单**

展示 configured/authorized/isExpired/clientId/transferFolder/driveId/expiresAt；clientSecret 输入永不回填；提交后清空；页面持续显示“当前接口非 admin-only”。

- [ ] **Step 4: 实现 OAuth 和后端切换**

- start：通过用户点击触发 `window.open`；
- complete：提交 state/code，成功后清空；
- revoke：普通确认 Dialog；
- setBackend：只发送 `{ kind: "local" | "alibaba" }`；
- 不渲染 SDK 原始响应。

- [ ] **Step 5: 验证并提交**

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 对接存储与阿里云盘"
```

---

### Task 11: 迁移个人资料、Token 与身份管理

**Files:**

- Create: `packages/frontend/src/pages/settings-page.tsx`
- Create: `packages/frontend/src/pages/profile-panel.tsx`
- Create: `packages/frontend/src/pages/tokens-panel.tsx`
- Create: `packages/frontend/src/pages/identities-panel.tsx`
- Test: `packages/frontend/src/pages/settings-page.test.tsx`
- Modify: `packages/frontend/src/app/routes.tsx`
- Delete: `packages/frontend/src/TokensPage.tsx`
- Delete: `packages/frontend/src/IdentitiesPage.tsx`

**Interfaces:**

- Consumes: `sdk.auth.updateMe/tokens.*`, `sdk.identities.*`, AuthContext identity。
- Produces: `/settings/profile|tokens|identities`。

- [ ] **Step 1: 写 Token 一次性显示和 admin 门失败测试**

测试新 Token 仅在 Dialog 中显示，关闭后 DOM 中不存在；revoke 普通确认；非 admin 不显示身份 tab/route。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/frontend test -- settings-page.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现设置页面**

- Profile：currentPassword 必填，username/password 可选；失败使用通用安全文案；
- Tokens：label 创建、一次性 Dialog、revoke confirm；
- Identities：admin-only，create/disable/enable；禁用普通确认；
- 页面固定说明普通身份拥有全部远程业务权限。

- [ ] **Step 4: 删除旧页面并验证**

Run: `pnpm --filter @vcpdeck/frontend test && pnpm --filter @vcpdeck/frontend build`

Expected: PASS；无旧页面 import。

- [ ] **Step 5: 提交设置迁移**

```bash
git add packages/frontend/src
git commit -m "feat(frontend): 重构账号和身份设置"
```

---

### Task 12: 全链路验证、文档同步与浏览器验收

**Files:**

- Modify: `docs/integration-guide.md`
- Modify: `README.md`（仅在需要补启动/页面入口时）
- Test: 全部 SDK/Frontend 测试、项目 build、真实浏览器 QA

**Interfaces:**

- Consumes: Tasks 1–11 的全部交付。
- Produces: 可验证的最终控制台和最新对接文档。

- [ ] **Step 1: 更新对接指南的 Frontend 状态**

将能力矩阵中的 Frontend 列更新为真实完成状态；补充 `@vcpdeck/sdk` 使用示例；保留未实现/限制项，不删除安全警告。

- [ ] **Step 2: 运行主动诊断**

Run:

```bash
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/sdk build
pnpm --filter @vcpdeck/frontend build
pnpm build
```

Expected: 全部 exit 0。构建前先对 `packages/sdk/src` 和 `packages/frontend/src` 运行 LSP diagnostics，修复所有 blocking diagnostics。

- [ ] **Step 3: 运行现有 Server/Client 回归测试**

Run:

```bash
pnpm test
pnpm test:frp
```

Expected: 现有集成测试全部 PASS；Frontend/SDK 没有改变 Server/Client 行为。

- [ ] **Step 4: 真实浏览器验收**

启动：

```bash
pnpm --filter @vcpdeck/server dev
pnpm --filter @vcpdeck/client start
pnpm --filter @vcpdeck/frontend dev
```

用浏览器逐项验证：

1. Cookie 登录、401 回登录；
2. 概览显示真实 Client/Job/FRP/Storage 状态；
3. 机器 tabs 路由可刷新；
4. command/script 最终摘要无伪造输出；
5. `file.roots` 显示 Windows 盘符或 Linux `/`；
6. list/read/write/mkdir/export 可用；
7. 删除/覆盖必须输入完整目标；
8. FRP 创建到 active/error，删除显示限制文案；
9. OAuth 页面不读取 raw Storage config；
10. Token Dialog 关闭后明文消失；
11. 深浅主题和移动端导航可用；
12. 离开页面后网络面板不再轮询对应 Job。

- [ ] **Step 5: 检查代码与凭证泄露**

Run:

```bash
rg "storage\.getConfig|/api/storage/config.*GET|console\.(log|debug).*token|localStorage.*token" packages/frontend packages/sdk
```

Expected: 没有违反设计的匹配；合法的 `PUT /api/storage/config` 可保留。

- [ ] **Step 6: GitNexus 变更影响检查**

Run GitNexus `detect_changes({ scope: "compare", base_ref: "main" })`，确认影响仅在 SDK、Frontend、文档和 workspace 依赖；若发现 Server/Client 执行流变化则停止并复查。

- [ ] **Step 7: 最终提交**

```bash
git add docs/integration-guide.md README.md packages/sdk packages/frontend package.json pnpm-lock.yaml
git commit -m "feat(frontend): 完成控制台与 Server 对接"
```

如果 `README.md` 或根 `package.json` 未改动，不要为了匹配命令而触碰它们。

---

## 自审结论

### Spec coverage

- Noesis 视觉、Shell、主题与响应式：Task 4–5；
- 最小 SDK 与跨运行时边界：Task 1–3；
- 认证、路由和 401：Task 5；
- 概览与机器工作区：Task 6；
- command/script、Job 轮询与诚实摘要：Task 7；
- `file.roots` 和三栏文件浏览：Task 8；
- FRP：Task 9；
- Storage/阿里云盘：Task 10；
- Profile/Token/Identity：Task 11；
- 安全、测试和真实浏览器验收：各任务测试 + Task 12。

### Placeholder scan

计划无 TBD、TODO、“类似上一任务”或未定义的实现占位。每项功能都有文件、接口、失败测试、验证命令和提交边界。

### Type consistency

- SDK 唯一实例为 `VcpDeckClient`；
- Job API 统一由 `createJobsApi()` 提供；
- 文件 API 统一由 `createFilesApi()` 包装 Job；
- Frontend hooks 只消费 SDK；
- `JobInfo`、`ClientInfo`、`FrpMappingInfo` 和 `FileRootsResult` 均来自 `@vcpdeck/shared`；
- 终态和退避策略在 SDK 只有一份实现。
