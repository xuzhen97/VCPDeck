# 存储页面体验优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不泄露 Storage 原始配置的前提下，重做存储页面的信息层级、后端切换反馈和 Tab 配置流，使当前激活后端始终来自服务端并符合现有热切换/OAuth 后端逻辑。

**Architecture:** Server 将 `GET /api/storage/config` 收窄为安全摘要；SDK 为该摘要提供类型化读取方法；Frontend 用两个并行资源分别读取激活后端和阿里云盘安全状态，顶部状态卡负责快捷切换，下方三个 Tab 负责后端配置、阿里云盘设置和授权安全。切换到阿里云盘需要确认，切回本地直接执行，但所有结果都在服务端请求成功后重新读取。

**Tech Stack:** NestJS、Prisma、TypeScript/ESM、React 18、Vite、Tailwind CSS v4、Radix Dialog、Vitest、Testing Library。

## Global Constraints

- 业务文档和界面文案使用简体中文；代码标识符、协议字段、数据库字段和枚举值使用英文。
- TypeScript 使用 ES modules、strict 模式；NodeNext 相对导入保留 `.js` 后缀。
- 不新增 UI 依赖、全局 Toast、全局状态管理、配置抽象或存储迁移功能。
- `GET /api/storage/config` 只能返回 `{ kind: "local" | "alibaba"; updatedAt: string | null }`，不能返回 `config` JSON、`clientSecret`、`accessToken` 或 `refreshToken`。
- 当前激活后端的事实来源是服务端 `StorageBackendConfig.kind`；前端不得用 localStorage 恢复或伪造激活状态。
- 切换调用现有 `PUT /api/storage/config`，成功后调用现有状态读取接口；不增加文件迁移行为。
- 阿里云盘状态继续使用现有 `GET /api/aliyundrive/status` 安全摘要；Client Secret 输入框不回填原始值。
- 切换到 `alibaba` 不因未授权而被前端擅自阻止；切换成功后明确提示新的文件操作可能失败。
- 错误对象保持稳定、安全的 message；不展示 stack、密钥、token 或完整后端配置。
- 每个非平凡交互至少留下一个可运行的 Vitest/Testing Library 检查。
- 当前工作区已有的 FRP、Client、脚本和 `AGENTS.md` 未提交修改不属于本计划，实施时不得覆盖或重置。

---

## 文件地图

### 修改

- `packages/server/src/storage/storage.service.ts`：把后端配置读取改为安全摘要，并保持 provider 热切换逻辑不变。
- `packages/sdk/src/storage.ts`：增加 `StorageBackendKind`、`StorageBackendStatus` 和安全摘要读取方法；收窄 `setBackend` 返回类型。
- `packages/sdk/src/domains.test.ts`：覆盖 Storage 安全摘要读取和切换请求。
- `packages/frontend/src/pages/storage-page.tsx`：实现顶部激活卡、共享切换流程、三个 Tab、状态反馈和现有 OAuth 表单迁移。
- `packages/frontend/src/pages/storage-page.test.tsx`：覆盖激活状态、确认/直接切换、失败回滚、Tab、配置和 OAuth 行为。
- `packages/frontend/src/styles.css`：增加仅作用于存储页面的 Tab/状态更新动画，并支持 `prefers-reduced-motion`。
- `docs/storage-api.md`：补充安全配置摘要读取和切换接口的公开响应约束。

### 新增

- `packages/server/src/storage/storage.service.test.ts`：验证 Storage 配置读取不泄露原始 `config`，并处理默认/未知后端值。

---

### Task 1: 收窄 Server Storage 配置读取结果

**Files:**

- Create: `packages/server/src/storage/storage.service.test.ts`
- Modify: `packages/server/src/storage/storage.service.ts:129-151`（`getBackendConfig`）
- Modify: `docs/storage-api.md:配置`（配置端点与响应说明）

**Interfaces:**

- Consumes: `PrismaService.storageBackendConfig.findFirst()` 返回的 `{ kind?: string; config: string; updatedAt?: Date }`。
- Produces: `StorageService.getBackendConfig(): Promise<{ kind: "local" | "alibaba"; updatedAt: string | null }>`；`StorageController.getConfig()` 和 `updateConfig()` 继续复用该方法。

- [ ] **Step 1: 写安全摘要的失败测试**

创建 `packages/server/src/storage/storage.service.test.ts`，使用最小 Prisma mock，不启动 Nest 应用：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageService } from "./storage.service.js";

function mockPrisma() {
 return {
  storageBackendConfig: {
   findFirst: vi.fn(),
   upsert: vi.fn(),
  },
 };
}

describe("StorageService.getBackendConfig", () => {
 let prisma: ReturnType<typeof mockPrisma>;
 let service: StorageService;

 beforeEach(() => {
  prisma = mockPrisma();
  service = new StorageService(prisma as never);
 });

 it("returns kind and updatedAt without exposing config secrets", async () => {
  const updatedAt = new Date("2026-07-31T12:00:00.000Z");
  prisma.storageBackendConfig.findFirst.mockResolvedValue({
   kind: "alibaba",
   config: JSON.stringify({
    clientSecret: "secret-value",
    accessToken: "access-token",
    refreshToken: "refresh-token",
   }),
   updatedAt,
  });

  const result = await service.getBackendConfig();

  expect(result).toEqual({
   kind: "alibaba",
   updatedAt: updatedAt.toISOString(),
  });
  expect(result).not.toHaveProperty("config");
  expect(JSON.stringify(result)).not.toContain("secret-value");
  expect(JSON.stringify(result)).not.toContain("access-token");
  expect(JSON.stringify(result)).not.toContain("refresh-token");
 });

 it("defaults to local when no database row exists", async () => {
  prisma.storageBackendConfig.findFirst.mockResolvedValue(null);

  expect(await service.getBackendConfig()).toEqual({
   kind: "local",
   updatedAt: null,
  });
 });

 it("normalizes an unknown persisted kind to the effective local fallback", async () => {
  prisma.storageBackendConfig.findFirst.mockResolvedValue({
   kind: "unsupported",
   config: "{}",
   updatedAt: null,
  });

  expect(await service.getBackendConfig()).toEqual({
   kind: "local",
   updatedAt: null,
  });
 });
});
```

- [ ] **Step 2: 运行测试确认当前实现失败**

运行：

```bash
pnpm --filter @vcpdeck/server test -- src/storage/storage.service.test.ts
```

预期：FAIL；当前 `getBackendConfig()` 返回 `config`，且无记录时返回对象不符合安全摘要断言。

- [ ] **Step 3: 实现最小安全摘要映射**

将 `getBackendConfig` 改为只读取并映射安全字段，不再解析或返回 `config`：

```ts
/** 获取当前激活后端的安全摘要，不返回 provider 原始配置。 */
async getBackendConfig(): Promise<{
 kind: "local" | "alibaba";
 updatedAt: string | null;
}> {
 const row = await this.prisma.storageBackendConfig.findFirst();
 return {
  kind: row?.kind === "alibaba" ? "alibaba" : "local",
  updatedAt: row?.updatedAt?.toISOString() || null,
 };
}
```

不要修改 `loadProvider`、`updateBackendConfig` 的数据库写入或热加载顺序；`PUT /api/storage/config` 的返回值自然复用新的安全摘要。

- [ ] **Step 4: 更新 Storage API 文档**

在 `docs/storage-api.md` 的配置部分增加以下明确内容，并删除“前端可读取完整 `config`”的暗示：

```md
### GET /api/storage/config

返回当前实际激活后端的安全摘要，不返回 `config` JSON。

```json
{
  "kind": "local",
  "updatedAt": "2026-07-31T12:00:00.000Z"
}
```

`kind` 只有 `local` 和 `alibaba`；没有数据库记录时为 `local`。响应不包含 `clientSecret`、`accessToken`、`refreshToken`。

### PUT /api/storage/config

Request body：`{ "kind": "local" | "alibaba" }`。

服务端更新 `StorageBackendConfig.kind` 并热加载 provider，响应与 `GET /api/storage/config` 相同。切换不会迁移已有文件；切换到 `alibaba` 时服务端不会替前端验证 OAuth 授权状态。

```

保留原有内部数据库配置示例，但补充“该 `config` JSON 不通过管理端点返回浏览器”。

- [ ] **Step 5: 运行 Server 测试和构建**

运行：

```bash
pnpm --filter @vcpdeck/server test -- src/storage/storage.service.test.ts
pnpm --filter @vcpdeck/server build
```

预期：新增测试 PASS，Server TypeScript 构建 PASS。

- [ ] **Step 6: 检查本任务差异**

运行：

```bash
git diff --check -- packages/server/src/storage/storage.service.ts packages/server/src/storage/storage.service.test.ts docs/storage-api.md
```

预期：无空白错误；确认 diff 未修改 `StorageService.loadProvider()`、上传/下载签名和 provider 注册表。

---

### Task 2: 增加 SDK 安全状态接口

**Files:**

- Modify: `packages/sdk/src/storage.ts`
- Modify: `packages/sdk/src/domains.test.ts`（Storage 相关测试）

**Interfaces:**

- Consumes: Server 的 `GET/PUT /api/storage/config` 安全摘要。
- Produces: `StorageBackendKind = "local" | "alibaba"`、`StorageBackendStatus`、`client.storage.getBackendConfig(signal?)` 和收窄后的 `client.storage.setBackend(...)`。

- [ ] **Step 1: 扩展 SDK 测试以读取安全摘要并检查 PUT 返回类型**

在 `packages/sdk/src/domains.test.ts` 增加/替换 Storage 测试，使用响应队列验证两个 HTTP 方法：

```ts
it("reads a safe storage backend summary and switches the backend", async () => {
 const responses = [
  Response.json({ kind: "local", updatedAt: null }),
  Response.json({ kind: "alibaba", updatedAt: "2026-07-31T12:00:00.000Z" }),
 ];
 const fetcher = vi.fn(async () => responses.shift()!);
 const client = new VcpDeckClient({
  baseUrl: "",
  auth: { type: "cookie" },
  fetch: fetcher,
 });

 expect(await client.storage.getBackendConfig()).toEqual({
  kind: "local",
  updatedAt: null,
 });
 expect(await client.storage.setBackend({ kind: "alibaba" })).toEqual({
  kind: "alibaba",
  updatedAt: "2026-07-31T12:00:00.000Z",
 });

 expect(fetcher).toHaveBeenNthCalledWith(
  1,
  "/api/storage/config",
  expect.objectContaining({ method: "GET" }),
 );
 expect(fetcher).toHaveBeenNthCalledWith(
  2,
  "/api/storage/config",
  expect.objectContaining({
   method: "PUT",
   body: JSON.stringify({ kind: "alibaba" }),
  }),
 );
 expect("getConfig" in client.storage).toBe(false);
});
```

- [ ] **Step 2: 运行 SDK 测试确认失败**

运行：

```bash
pnpm --filter @vcpdeck/sdk test -- src/domains.test.ts
```

预期：FAIL，当前 `client.storage.getBackendConfig` 不存在，且 `setBackend` 没有安全摘要类型定义。

- [ ] **Step 3: 实现最小 SDK 类型和方法**

在 `packages/sdk/src/storage.ts` 的上传/下载类型之前增加：

```ts
/** Storage 可用后端。 */
export type StorageBackendKind = "local" | "alibaba";

/** 当前激活 Storage 后端的安全摘要。 */
export interface StorageBackendStatus {
 kind: StorageBackendKind;
 updatedAt: string | null;
}
```

在 `createStorageApi` 返回对象中增加读取方法，并将 `setBackend` 改为：

```ts
getBackendConfig: (signal?: AbortSignal) =>
 client.request<StorageBackendStatus>(
  "GET",
  "/api/storage/config",
  undefined,
  signal,
 ),
setBackend: (input: { kind: StorageBackendKind }, signal?: AbortSignal) =>
 client.request<StorageBackendStatus>(
  "PUT",
  "/api/storage/config",
  input,
  signal,
 ),
```

不增加 `getConfig`，不暴露原始配置读取方法；`packages/sdk/src/index.ts` 已经通过 `export * from "./storage.js"` 自动导出新类型。

- [ ] **Step 4: 运行 SDK 测试和构建**

运行：

```bash
pnpm --filter @vcpdeck/sdk test -- src/domains.test.ts
pnpm --filter @vcpdeck/sdk build
```

预期：测试 PASS，SDK 类型声明和构建 PASS。

- [ ] **Step 5: 检查 SDK 差异**

运行：

```bash
git diff --check -- packages/sdk/src/storage.ts packages/sdk/src/domains.test.ts
```

预期：无空白错误；确认 SDK 中不存在返回原始 Storage `config` 的方法。

---

### Task 3: 先覆盖前端状态、切换和失败流程

**Files:**

- Modify: `packages/frontend/src/pages/storage-page.test.tsx`
- Modify: `packages/frontend/src/pages/storage-page.tsx`

**Interfaces:**

- Consumes: `StorageBackendStatus`、`AliyunDriveStatus`、`client.storage.getBackendConfig()`、`client.storage.setBackend()`。
- Produces: 页面内部共享的 `switchBackend(kind: StorageBackendKind)` 流程；顶部快捷切换和 Tab 内切换入口都调用它。

- [ ] **Step 1: 更新前端测试 mock 并写切换失败测试**

将测试 fixture 中的 `storage` mock 改为包含 `getBackendConfig` 和 `setBackend`，并保留现有 OAuth mock。新增一个可控制后端状态的 helper，核心结构如下：

```ts
const backendStatus = vi
 .fn()
 .mockResolvedValue({ kind: "local", updatedAt: null });
const setBackend = vi.fn().mockResolvedValue({
 kind: "alibaba",
 updatedAt: "2026-07-31T12:00:00.000Z",
});

storage: {
 getBackendConfig: backendStatus,
 setBackend,
},
```

增加以下测试：

```ts
it("shows the server-selected backend on first render", async () => {
 const { backendStatus } = renderPage();

 expect(await screen.findByText("本地存储")).toBeVisible();
 expect(backendStatus).toHaveBeenCalled();
 expect(screen.getByText("当前激活的存储")).toBeVisible();
});

it("requires confirmation before switching to Alibaba Drive", async () => {
 const { setBackend } = renderPage();
 await screen.findByText("本地存储");

 await userEvent.click(screen.getByRole("button", { name: "切换到阿里云盘" }));
 expect(screen.getByRole("heading", { name: "启用阿里云盘？" })).toBeVisible();
 expect(setBackend).not.toHaveBeenCalled();

 await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
 expect(setBackend).toHaveBeenCalledWith({ kind: "alibaba" });
});

it("switches back to local storage without a confirmation dialog", async () => {
 const { backendStatus, setBackend } = renderPage({
  backend: { kind: "alibaba", updatedAt: null },
 });
 await screen.findByText("阿里云盘");

 await userEvent.click(screen.getByRole("button", { name: "切换到本地存储" }));
 expect(screen.queryByRole("heading", { name: "启用阿里云盘？" })).not.toBeInTheDocument();
 expect(setBackend).toHaveBeenCalledWith({ kind: "local" });
 await waitFor(() => expect(backendStatus).toHaveBeenCalledTimes(2));
});

it("keeps the confirmed backend and shows an error when switching fails", async () => {
 const { setBackend } = renderPage({
  setBackend: vi.fn().mockRejectedValue(new Error("切换失败")),
 });
 await screen.findByText("本地存储");
 await userEvent.click(screen.getByRole("button", { name: "切换到阿里云盘" }));
 await userEvent.click(screen.getByRole("button", { name: "确认切换" }));

 expect(await screen.findByRole("alert")).toHaveTextContent("切换失败");
 expect(screen.getByText("本地存储")).toBeVisible();
});
```

`renderPage` 的可选参数使用以下类型，不要引入测试工厂类：

```ts
type RenderOptions = {
 backend?: { kind: "local" | "alibaba"; updatedAt: string | null };
 setBackend?: ReturnType<typeof vi.fn>;
};
```

- [ ] **Step 2: 运行前端测试确认新测试失败**

运行：

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/storage-page.test.tsx
```

预期：FAIL，当前页面没有 `getBackendConfig` 读取、顶部切换按钮名称、确认对话框和失败处理。

- [ ] **Step 3: 实现双资源读取和共享切换流程**

在 `StoragePage` 中引入 `StorageBackendKind`、`StorageBackendStatus`，为两个资源分别建立稳定的 `useCallback`：

```ts
const backendLoad = useCallback(
 (signal: AbortSignal) => sdk.storage.getBackendConfig(signal),
 [sdk],
);
const backendResource = useResource(backendLoad);

const aliyunLoad = useCallback(
 (signal: AbortSignal) => sdk.aliyundrive.status(signal),
 [sdk],
);
const aliyunResource = useResource(aliyunLoad);
```

页面状态至少包含：

```ts
const [pendingBackend, setPendingBackend] = useState<StorageBackendKind>();
const [backendBusy, setBackendBusy] = useState(false);
const [backendError, setBackendError] = useState("");
const [notice, setNotice] = useState("");
```

实现一个共享的 `switchBackend`，所有入口只调用它。PUT 成功后先重新读取两个服务端状态，确认读取成功后再显示成功提示；同时触发两个 `useResource` 的 reload，让页面资源状态与刚读取的服务端状态保持同步：

```ts
async function switchBackend(kind: StorageBackendKind) {
 setBackendBusy(true);
 setBackendError("");
 setNotice("");
 try {
  await sdk.storage.setBackend({ kind });
  await Promise.all([
   sdk.storage.getBackendConfig(),
   sdk.aliyundrive.status(),
  ]);
  backendResource.reload();
  aliyunResource.reload();
  setNotice("存储后端已切换");
 } catch (error) {
  setBackendError(error instanceof Error ? error.message : "切换存储后端失败");
 } finally {
  setPendingBackend(undefined);
  setBackendBusy(false);
 }
}
```

这两个显式 GET 只用于等待服务端确认；页面展示仍由 `useResource` 的刷新结果驱动，不把 PUT 返回值直接写成激活状态。若确认 GET 失败，按切换失败处理并保留已渲染的旧状态，下一次资源刷新仍可通过重试完成同步。

在确认逻辑中仅对目标 `alibaba` 打开对话框：

```ts
function requestBackendSwitch(kind: StorageBackendKind) {
 if (kind === "alibaba" && backendResource.data?.kind !== "alibaba") {
  setPendingBackend(kind);
  return;
 }
 void switchBackend(kind);
}
```

这里的状态更新必须来自 `backendResource.reload()` 触发的服务端读取；`setBackend` 返回值只表示 PUT 已接受，不可直接写入页面的激活状态。`useResource.reload()` 是现有同步触发器，所以 Toast 在 PUT 成功后显示，顶部激活文案仍等待 GET 刷新后改变，不做乐观写入。

- [ ] **Step 4: 实现加载和错误边界**

使用以下边界：

```tsx
if (backendResource.loading || !backendResource.data) {
 if (backendResource.error) {
  return <ErrorState message="无法加载存储后端状态" onRetry={backendResource.reload} />;
 }
 return <LoadingState label="正在加载存储状态…" />;
}
```

Storage 后端摘要是页面激活状态的硬依赖。阿里云盘状态加载失败时不要把已经确认的 `kind` 改成未知值；继续渲染顶部和后端 Tab，并在阿里云盘状态区域显示“状态暂时不可用”和 `aliyunResource.reload` 重试入口。OAuth 操作在没有安全 `openapiBase` 时禁用并提示先重试状态读取。

所有动作（配置、开始授权、完成授权、撤销授权）都保留现有接口调用，但用 `try/catch/finally` 设置错误和对应 busy 状态；错误 message 使用 `error instanceof Error ? error.message : "操作失败"`，不显示原始 response body。

- [ ] **Step 5: 运行切换测试并检查状态行为**

运行：

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/storage-page.test.tsx
```

预期：本任务新增的 server-selected、确认切换、直接切换和失败测试 PASS；尚未迁移的旧选择器测试可能仍失败，留到 Task 4 一并修正。

---

### Task 4: 实现顶部激活卡和三个 Tab

**Files:**

- Modify: `packages/frontend/src/pages/storage-page.tsx`
- Modify: `packages/frontend/src/pages/storage-page.test.tsx`
- Modify: `packages/frontend/src/styles.css`

**Interfaces:**

- Consumes: Task 3 的 `backendResource`、`aliyunResource`、`requestBackendSwitch`/`switchBackend`、busy/error/notice 状态。
- Produces: 可访问的 `tablist`、`tab`、`tabpanel`；顶部快捷切换和 Tab 内切换都共享 Task 3 的处理函数。

- [ ] **Step 1: 写 Tab、状态文案和配置安全测试**

在 `storage-page.test.tsx` 增加以下测试；所有测试只通过可访问角色和 label 操作，不依赖 CSS 类：

```ts
it("switches between the three configuration tabs", async () => {
 renderPage();
 await screen.findByText("本地存储");

 expect(screen.getByRole("tabpanel")).toHaveTextContent("选择存储后端");
 await userEvent.click(screen.getByRole("tab", { name: "阿里云盘设置" }));
 expect(screen.getByRole("tabpanel")).toHaveTextContent("Client ID");
 await userEvent.click(screen.getByRole("tab", { name: "授权与安全" }));
 expect(screen.getByRole("tabpanel")).toHaveTextContent("开始授权");
});

it("warns when Alibaba Drive is active but not authorized", async () => {
 renderPage({
  backend: { kind: "alibaba", updatedAt: null },
  aliyun: {
   configured: true,
   authorized: false,
   isExpired: false,
   clientId: "app-id",
   openapiBase: "https://openapi.alipan.com",
   transferFolder: "VCPDeck",
  },
 });

 expect(await screen.findByText("阿里云盘 · 尚未授权")).toBeVisible();
 expect(screen.getByText(/新的文件操作可能失败/)).toBeVisible();
});

it("does not send an empty client secret and clears it after a non-empty save", async () => {
 const { configure } = renderPage();
 await userEvent.click(await screen.findByRole("tab", { name: "阿里云盘设置" }));
 await userEvent.clear(screen.getByLabelText("Client ID"));
 await userEvent.type(screen.getByLabelText("Client ID"), "new-app-id");
 await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
 expect(configure).toHaveBeenCalledWith({
  clientId: "new-app-id",
  transferFolder: "VCPDeck",
 });
 expect(screen.getByLabelText("Client Secret")).toHaveValue("");
});
```

把 `renderPage` 的 mock 返回对象扩展为可选 `aliyun` 状态，并返回 `configure` 供测试断言。保留现有三条 OAuth 测试，但在调用“开始授权”前先切换到“授权与安全” Tab。

- [ ] **Step 2: 运行 Tab 测试确认失败**

运行：

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/storage-page.test.tsx
```

预期：FAIL，当前页面没有三个语义化 Tab、激活后端文案和安全配置入参行为。

- [ ] **Step 3: 实现顶部激活卡**

在页面标题下渲染单个主状态卡，使用 `backendResource.data.kind` 作为唯一激活来源。顶部两个快捷按钮使用唯一可访问名称：

```tsx
<Button
 variant={backend.kind === "local" ? "default" : "outline"}
 disabled={backendBusy || backend.kind === "local"}
 aria-label="切换到本地存储"
 aria-busy={backendBusy}
 onClick={() => requestBackendSwitch("local")}
>
 本地存储
</Button>
<Button
 variant={backend.kind === "alibaba" ? "default" : "outline"}
 disabled={backendBusy || backend.kind === "alibaba"}
 aria-label="切换到阿里云盘"
 aria-busy={backendBusy}
 onClick={() => requestBackendSwitch("alibaba")}
>
 阿里云盘
</Button>
```

状态文案按以下顺序生成：

```ts
function activeBackendLabel(
 kind: StorageBackendKind,
 status: AliyunDriveStatus | undefined,
): string {
 if (kind === "local") return "本地存储 · 正常运行";
 if (!status) return "阿里云盘 · 状态不可用";
 if (status.isExpired) return "阿里云盘 · 授权已过期";
 if (!status.authorized) return "阿里云盘 · 尚未授权";
 return "阿里云盘 · 已授权";
}
```

激活卡包含：`当前激活的存储`、名称、说明、快捷切换控件和“切换只影响新任务，不会自动迁移已有文件”。阿里云盘未授权/过期时使用 warning 文案和状态 chip；不能把 `kind: alibaba` 展示为本地。

- [ ] **Step 4: 实现三个可访问 Tab**

使用页面内部 `useState<"backend" | "aliyun-config" | "security">("backend")`，不引入 Router 或第三方 Tabs 组件。Tab 按钮使用 roving focus 的最小实现：当前 Tab `tabIndex=0`，其他 Tab `tabIndex=-1`；在 Tab 上处理 `ArrowLeft`/`ArrowRight` 循环切换并将焦点移到新 Tab，同时保留普通 Tab 键顺序。结构必须满足：

```tsx
const tabs = ["backend", "aliyun-config", "security"] as const;
const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

function handleTabKeyDown(index: number, event: React.KeyboardEvent) {
 const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
 if (!direction) return;
 event.preventDefault();
 const next = (index + direction + tabs.length) % tabs.length;
 setTab(tabs[next]);
 tabRefs.current[next]?.focus();
}

<div role="tablist" aria-label="存储设置">
 <button
  ref={(element) => { tabRefs.current[0] = element; }}
  role="tab"
  tabIndex={tab === "backend" ? 0 : -1}
  id="storage-tab-backend"
  aria-controls="storage-panel-backend"
  aria-selected={tab === "backend"}
  onKeyDown={(event) => handleTabKeyDown(0, event)}
  onClick={() => setTab("backend")}
 >
  后端配置
 </button>
 <button
  role="tab"
  id="storage-tab-aliyun-config"
  aria-controls="storage-panel-aliyun-config"
  aria-selected={tab === "aliyun-config"}
  onClick={() => setTab("aliyun-config")}
 >
  阿里云盘设置
 </button>
 <button
  role="tab"
  id="storage-tab-security"
  aria-controls="storage-panel-security"
  aria-selected={tab === "security"}
  onClick={() => setTab("security")}
 >
  授权与安全
 </button>
</div>
```

当前面板使用 `role="tabpanel"`、对应 `aria-labelledby` 和唯一 id。Tab 面板内容如下：

- `backend`：本地存储卡、阿里云盘卡、当前使用标识、阿里云盘授权摘要、两个卡片切换入口；卡片按钮调用同一个 `requestBackendSwitch`。
- `aliyun-config`：Client ID、Client Secret（可选，留空保留现有值）、传输目录和保存按钮。首次安全状态加载后，用 `clientId` 和 `transferFolder` 填充公开字段；使用一次性的 `configInitialized` ref，避免状态刷新覆盖用户尚未提交的编辑。提交时只在 secret 非空时把 `clientSecret` 放入 request body：

```ts
const input: AliyunDriveConfigInput = {
 clientId: clientId.trim(),
 transferFolder: transferFolder.trim(),
};
if (clientSecret) input.clientSecret = clientSecret;
await sdk.aliyundrive.configure(input);
setClientSecret("");
```

保存成功后重新读取阿里云盘状态；保存失败时保留用户输入并显示错误。

- `security`：复用现有安全摘要字段；状态缺失时显示不可用重试；开始授权、完成授权、撤销授权继续调用现有接口。OAuth 地址继续使用现有 `safeAuthorizationUrl`，不安全时不得调用 `window.open`。

确认切换对话框继续使用现有 Radix `Dialog`，文案为“启用阿里云盘？”、“新创建的任务将使用阿里云盘。已有文件不会自动迁移，未完成上传任务将继续使用原后端。”；确认按钮调用 `switchBackend("alibaba")`，取消只清除 pending 状态。

- [ ] **Step 5: 增加局部动画和减少动态效果支持**

在 `packages/frontend/src/styles.css` 的 `@layer components` 中增加仅作用于存储页的类：

```css
.storage-tab-panel {
 animation: storage-tab-in 160ms ease-out;
}

.storage-status-card {
 animation: storage-status-in 180ms ease-out;
}

@keyframes storage-tab-in {
 from { opacity: 0; transform: translateY(4px); }
 to { opacity: 1; transform: translateY(0); }
}

@keyframes storage-status-in {
 from { opacity: 0.72; transform: translateY(-2px); }
 to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
 .storage-tab-panel,
 .storage-status-card {
  animation: none;
 }
}
```

把 `storage-tab-panel` 加在 `tabpanel`，把 `storage-status-card` 加在顶部状态卡。切换请求期间使用现有 Button disabled/opacity 样式和“正在切换…”文字，不新增大面积 spinner；成功反馈使用页面内 `role="status" aria-live="polite"` 的绿色提示，2.5 秒后清除。

- [ ] **Step 6: 运行完整前端页面测试**

运行：

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/storage-page.test.tsx
```

预期：StoragePage 全部测试 PASS，包括原有安全 OAuth URL、OAuth state/code 清空和安全状态加载测试，以及本任务新增的 Tab/切换/错误测试。

- [ ] **Step 7: 运行前端构建**

运行：

```bash
pnpm --filter @vcpdeck/frontend build
```

预期：TypeScript 和 Vite 构建 PASS；没有未使用 import、JSX aria 类型错误或 `.js` 导入错误。

---

### Task 5: 端到端验收、诊断和变更范围检查

**Files:**

- Verify: `packages/server/src/storage/storage.service.ts`
- Verify: `packages/server/src/storage/storage.service.test.ts`
- Verify: `packages/sdk/src/storage.ts`
- Verify: `packages/sdk/src/domains.test.ts`
- Verify: `packages/frontend/src/pages/storage-page.tsx`
- Verify: `packages/frontend/src/pages/storage-page.test.tsx`
- Verify: `packages/frontend/src/styles.css`
- Verify: `docs/storage-api.md`

**Interfaces:**

- Consumes: Tasks 1–4 的安全摘要、SDK、页面交互和测试结果。
- Produces: 可提交的存储页面优化变更，且不把当前工作区其他 FRP/Client 修改纳入本任务。

- [ ] **Step 1: 运行相关测试集合**

运行：

```bash
pnpm --filter @vcpdeck/server test -- src/storage/storage.service.test.ts
pnpm --filter @vcpdeck/sdk test -- src/domains.test.ts
pnpm --filter @vcpdeck/frontend test -- src/pages/storage-page.test.tsx
```

预期：三个命令均 PASS。

- [ ] **Step 2: 运行修改文件的 LSP 诊断**

运行：

```text
lsp_diagnostics(paths=[
  "packages/server/src/storage/storage.service.ts",
  "packages/server/src/storage/storage.service.test.ts",
  "packages/sdk/src/storage.ts",
  "packages/sdk/src/domains.test.ts",
  "packages/frontend/src/pages/storage-page.tsx",
  "packages/frontend/src/pages/storage-page.test.tsx",
  "packages/frontend/src/styles.css"
], serverScope="primary", severity="all")
```

预期：没有 TypeScript blocking error；CSS 文件不应产生可忽略的解析错误。

- [ ] **Step 3: 运行全量构建**

运行：

```bash
pnpm --filter @vcpdeck/server build
pnpm --filter @vcpdeck/sdk build
pnpm --filter @vcpdeck/frontend build
```

预期：三个包均构建成功。

- [ ] **Step 4: 检查安全字符串和 diff**

运行：

```bash
ffgrep --pattern "accessToken|refreshToken|clientSecret" --path packages/frontend/src/pages/storage-page.tsx
ffgrep --pattern "config" --path packages/server/src/storage/storage.service.ts
 git diff --check
```

预期：前端页面只出现字段名/输入标签，不出现读取或展示 token 的逻辑；Server `getBackendConfig` 不返回 `config`；无空白错误。不要用 grep 结果替代网络/API 测试，安全性最终以 Task 1 的断言和构建结果为准。

- [ ] **Step 5: 检查 GitNexus 影响和变更范围**

在准备提交前运行：

```text
gitnexus_detect_changes(repo="VCPDeck", scope="all")
```

确认受影响符号只包括 Storage service safe summary、Storage SDK、StoragePage、相关测试和文档；若结果包含当前工作区已有的 FRP/Client/脚本变更，记录它们为 pre-existing，不要纳入提交。StoragePage、`StorageService.getBackendConfig` 和 `createStorageApi` 的已知上游风险均为 LOW；若重新分析出现 HIGH/CRITICAL，先停止提交并复核调用方。

- [ ] **Step 6: 只提交本计划涉及的文件**

运行：

```bash
git add \
  packages/server/src/storage/storage.service.ts \
  packages/server/src/storage/storage.service.test.ts \
  packages/sdk/src/storage.ts \
  packages/sdk/src/domains.test.ts \
  packages/frontend/src/pages/storage-page.tsx \
  packages/frontend/src/pages/storage-page.test.tsx \
  packages/frontend/src/styles.css \
  docs/storage-api.md

git diff --cached --check
git diff --cached --stat
git commit -m "feat: 优化存储页面体验"
```

预期：暂存区只包含本计划文件；提交信息使用简体中文；不得使用 `git add -A`，不得重置或清理其他未提交文件。

- [ ] **Step 7: 提交后再次确认工作区边界**

运行：

```bash
git status --short
git show --stat --oneline --summary HEAD
```

预期：本次提交只包含存储页面及其安全摘要相关文件；已有的 `AGENTS.md`、FRP、Client、脚本和 `artifacts/` 修改仍保持原状。

---

## 实施完成判定

实现只有在以下条件全部满足时才可称为完成：

1. 页面首次展示的激活后端来自 `GET /api/storage/config`，默认无记录时为本地存储。
2. 顶部快捷切换和 Tab 内卡片切换调用同一逻辑；阿里云盘目标需要确认，本地目标不需要确认。
3. 切换失败时旧后端仍可见，切换成功后页面重新读取服务端状态。
4. 阿里云盘已切换但未授权/已过期时，页面明确提示真实状态，不阻止后端已经完成的切换。
5. 三个 Tab 具备语义化角色、键盘可操作的按钮和 `aria-selected`/`aria-controls` 关系。
6. Client Secret 为空时不会覆盖服务端已有 secret，保存后输入框清空；页面不回填 token。
7. 不安全 OAuth URL 不会打开新窗口；现有 OAuth 测试继续通过。
8. Server、SDK、Frontend 相关测试和构建均通过，LSP 无 blocking error。
9. GitNexus 变更检测完成，且提交不包含用户已有的其他工作区修改。

## 计划自检

- **Spec coverage:** 顶部激活区、Tab、切换确认/直接切换、服务端安全摘要、OAuth、安全错误、动画、减少动态效果、可访问性、响应式、测试和非目标分别覆盖在 Task 1–5；没有安排文件迁移、容量统计或新依赖。
- **Placeholder scan:** 计划中的每个代码变更步骤都给出了目标文件、接口、测试代码或精确实现片段，没有留下未决项。
- **Type consistency:** Server 摘要和 SDK 均使用 `kind: "local" | "alibaba"`、`updatedAt: string | null`；Frontend 使用 `StorageBackendKind`，`getBackendConfig` 和 `setBackend` 的调用参数/返回值一致。
- **Boundary check:** 现有 `useResource.reload()` 是同步触发刷新，因此实现不把 PUT 返回值直接写成激活状态；PUT 成功后只触发服务端重读，顶部最终显示以 GET 结果为准。阿里云盘状态失败时保留 Storage `kind`，避免把“授权状态不可用”误报成“后端未启用”。
