# 稳定可续传下载入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Web 与 Bearer 客户端提供受鉴权的稳定下载地址，每次访问实时签发阿里云临时 URL 并以 302 直连下载，同时保留 HTTP Range 的 best-effort 续传能力。

**Architecture:** 在现有 `StorageController` 增加不带 `@Public()` 的稳定 302 入口，复用 `StorageService.createDownloadToken()` 隐藏 alibaba/local 分支，并集中设置 `no-store` 与 `no-referrer`。SDK 只新增纯 `downloadUrl(key)` 构造器；浏览器五个下载入口统一导航到稳定同源地址，远程 Client 仍保留并使用现有 `createDownloadToken()` 返回的直接数据面 URL。

**Tech Stack:** TypeScript、NestJS 10、Express Response、React 18、Vite、Vitest、现有 `@vcpdeck/sdk`；不增加依赖、数据库表或迁移。

## Global Constraints

- 业务文档和注释使用简体中文；代码标识符、协议字段和枚举值使用英文。
- TypeScript 使用 ESM + strict；NodeNext 相对导入保留 `.js` 后缀。
- 所有生产代码遵循 TDD：先写失败测试并确认 RED，再写最小实现并确认 GREEN。
- 修改任何函数、类或方法前必须运行 GitNexus upstream impact；HIGH/CRITICAL 必须先向用户报告再编辑。
- alibaba 文件数据必须保持客户端与阿里云直连，Server 只能做鉴权、签发和 302，不得代理文件体。
- 稳定入口同时支持现有 Cookie 会话与 Bearer Token；不新增分享令牌或公开永久链接。
- 相同稳定 URL 每次访问都必须重新签发临时 URL，Location 不得缓存或记录完整值。
- `local` 保持现有签名下载链路；本期不增加 local 的 `206 Partial Content` / Range 实现。
- `createDownloadToken()` 必须保留，Server 调度给远程 Client 的 `file.import` 仍需要直接外部 URL。
- 不新增 CLI `download` 命令；CLI/脚本通过 SDK 相对路径或 curl 使用稳定入口。
- 每个任务提交前运行该任务的定向测试、LSP；最终提交前运行 `gitnexus_detect_changes()`。
- Git commit 使用简体中文。

---

## File Responsibility Map

### Create

- `packages/server/src/storage/storage.controller.test.ts`：直接验证稳定 302 控制器的 Location、防缓存、Referrer 策略和重复签发。
- `packages/sdk/src/storage.test.ts`：验证稳定相对 URL 的编码与纯函数行为。
- `packages/frontend/src/api/download-file.ts`：唯一的动态浏览器下载 adapter，集中创建 anchor、设置文件名与 `no-referrer`。
- `packages/frontend/src/api/download-file.test.ts`：验证动态下载 adapter 的可观察 DOM 行为。
- `packages/frontend/src/pages/file-detail.test.tsx`：覆盖备用 `FileDetail` 的稳定下载入口，防止未来重新挂载时回归。

### Modify

- `packages/server/src/storage/storage.controller.ts`：新增受鉴权的 `GET /api/storage/download-redirect/:key` 302 入口。
- `packages/sdk/src/storage.ts`：新增纯 `downloadUrl(key)` 接口，保留 `createDownloadToken()`。
- `packages/frontend/src/components/download-link-card.tsx`：移除页面加载时的异步临时 URL 签发，直接展示稳定 URL。
- `packages/frontend/src/components/notification-bell.tsx`：使用稳定 URL 和浏览器下载 adapter。
- `packages/frontend/src/pages/files-panel.tsx`：右键导出与 `FileViewerDialog` 使用稳定 URL 和统一 adapter。
- `packages/frontend/src/pages/file-detail.tsx`：备用详情使用稳定 URL 和统一 adapter。
- `packages/frontend/src/pages/job-detail-page.test.tsx`：验证详情页稳定 URL，不再测试临时 URL 签发失败。
- `packages/frontend/src/pages/jobs-page.test.tsx`：验证任务抽屉稳定 URL。
- `packages/frontend/src/components/notification-bell.test.tsx`：验证铃铛点击稳定 URL。
- `packages/frontend/src/pages/files-panel.test.tsx`：覆盖右键导出与查看器下载两个入口。
- `scripts/test.cjs`：真实 Nest 应用下验证匿名 401、Cookie/Bearer 302、Range 请求、防缓存响应头与 local 下载回归。

---

### Task 1: Server 稳定 302 下载入口

**Files:**

- Create: `packages/server/src/storage/storage.controller.test.ts`
- Modify: `packages/server/src/storage/storage.controller.ts:1-116`

**Interfaces:**

- Consumes: `StorageService.createDownloadToken(key: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: number }>`。
- Produces: 受现有全局 `AuthGuard` 保护的 `GET /api/storage/download-redirect/:key`；成功响应为 302、空 body、fresh Location、`Referrer-Policy: no-referrer`、`Cache-Control: private, no-store`。
- Preserves: `POST /api/storage/download-token` 与 `GET /api/storage/download/:key` 的现有行为。

- [ ] **Step 1: 在编辑前运行影响分析**

```text
gitnexus_impact({ repo: "VCPDeck", target: "StorageController", direction: "upstream", depth: 3, includeTests: true })
```

预期：LOW；直接依赖为 `StorageModule`。若实际为 HIGH/CRITICAL，先停止并报告。

- [ ] **Step 2: 创建失败的 Controller 测试**

在 `packages/server/src/storage/storage.controller.test.ts` 写入：

```ts
import { describe, expect, it, vi } from "vitest";
import { StorageController } from "./storage.controller.js";

function makeController() {
 const storageService = {
  createDownloadToken: vi.fn(),
 };
 return {
  controller: new StorageController(storageService as never),
  storageService,
 };
}

function makeResponse() {
 return {
  status: vi.fn(),
  setHeader: vi.fn(),
  end: vi.fn(),
 };
}

describe("StorageController download redirect", () => {
 it("每次请求都签发 fresh URL 并返回不可缓存的 302", async () => {
  const { controller, storageService } = makeController();
  storageService.createDownloadToken
   .mockResolvedValueOnce({ url: "https://download.example/one", expiresAt: 1 })
   .mockResolvedValueOnce({ url: "https://download.example/two", expiresAt: 2 });
  const first = makeResponse();
  const second = makeResponse();

  await controller.redirectDownload("aliyun-file", first as never);
  await controller.redirectDownload("aliyun-file", second as never);

  expect(storageService.createDownloadToken).toHaveBeenCalledTimes(2);
  expect(storageService.createDownloadToken).toHaveBeenNthCalledWith(
   1,
   "aliyun-file",
  );
  expect(first.status).toHaveBeenCalledWith(302);
  expect(first.setHeader).toHaveBeenCalledWith(
   "Location",
   "https://download.example/one",
  );
  expect(second.setHeader).toHaveBeenCalledWith(
   "Location",
   "https://download.example/two",
  );
  expect(first.setHeader).toHaveBeenCalledWith(
   "Referrer-Policy",
   "no-referrer",
  );
  expect(first.setHeader).toHaveBeenCalledWith(
   "Cache-Control",
   "private, no-store",
  );
  expect(first.end).toHaveBeenCalledOnce();
 });

 it("local 签名地址同样通过稳定入口跳转", async () => {
  const { controller, storageService } = makeController();
  storageService.createDownloadToken.mockResolvedValue({
   url: "/api/storage/download/local-key?expires=123&sig=abc",
   expiresAt: 123,
  });
  const response = makeResponse();

  await controller.redirectDownload("local-key", response as never);

  expect(response.setHeader).toHaveBeenCalledWith(
   "Location",
   "/api/storage/download/local-key?expires=123&sig=abc",
  );
 });
});
```

测试名称验证行为而非 Nest 框架实现；鉴权在 Task 6 的真实应用集成测试覆盖。

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/storage/storage.controller.test.ts
```

Expected: FAIL，`StorageController` 不存在 `redirectDownload`。

- [ ] **Step 4: 实现最小稳定跳转方法**

在 `packages/server/src/storage/storage.controller.ts` 的 `createDownloadToken()` 后新增；不要添加 `@Public()`：

```ts
/** 受鉴权的稳定下载入口；每次请求实时签发后端 URL */
@Get("download-redirect/:key(*)")
async redirectDownload(
 @Param("key") key: string,
 @Res() res: Response,
): Promise<void> {
 const ref = await this.storageService.createDownloadToken(key);
 res.status(302);
 res.setHeader("Location", ref.url);
 res.setHeader("Referrer-Policy", "no-referrer");
 res.setHeader("Cache-Control", "private, no-store");
 res.end();
}
```

不要读取 `Range`、不要打开 stream、不要打印 `ref.url`。GET 重定向的 Range 语义由客户端保留并在 Task 6 真实验证。

- [ ] **Step 5: 运行 Server 定向测试与 LSP**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/storage/storage.controller.test.ts src/storage/storage.service.test.ts
```

Expected: PASS；StorageService 现有 alibaba/local token 分支仍通过。

Then:

```text
lsp_diagnostics({ paths: ["packages/server/src/storage/storage.controller.ts", "packages/server/src/storage/storage.controller.test.ts"], serverScope: "primary", severity: "all" })
```

Expected: 0 diagnostics。

- [ ] **Step 6: 提交 Task 1**

```bash
git add "packages/server/src/storage/storage.controller.ts" "packages/server/src/storage/storage.controller.test.ts"
git commit -m "增加受鉴权的稳定下载跳转入口"
```

---

### Task 2: SDK 稳定下载 URL 构造器

**Files:**

- Create: `packages/sdk/src/storage.test.ts`
- Modify: `packages/sdk/src/storage.ts:28-78`

**Interfaces:**

- Produces: `storage.downloadUrl(key: string): string`。
- Return invariant: `/api/storage/download-redirect/${encodeURIComponent(key)}`。
- Preserves: `storage.createDownloadToken()`，供兼容调用与 Server 内部数据面使用。

- [ ] **Step 1: 运行接口影响分析**

```text
gitnexus_impact({ repo: "VCPDeck", target: "createStorageApi", direction: "upstream", depth: 3, includeTests: true })
```

记录直接调用面；若 HIGH/CRITICAL，先报告再继续。

- [ ] **Step 2: 创建失败的 SDK 测试**

创建 `packages/sdk/src/storage.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createStorageApi } from "./storage.js";

describe("storage.downloadUrl", () => {
 it("构造编码后的稳定相对下载地址且不发请求", () => {
  const request = vi.fn();
  const storage = createStorageApi({ request } as never);

  expect(storage.downloadUrl("folder/a b.zip")).toBe(
   "/api/storage/download-redirect/folder%2Fa%20b.zip",
  );
  expect(request).not.toHaveBeenCalled();
 });
});
```

- [ ] **Step 3: 运行测试确认 RED**

```bash
pnpm --filter @vcpdeck/sdk exec vitest run src/storage.test.ts
```

Expected: FAIL，`downloadUrl` 未定义。

- [ ] **Step 4: 增加纯 URL 构造方法**

在 `createStorageApi()` 返回对象中、`createDownloadToken` 之前加入：

```ts
/** 构造受鉴权的稳定下载地址；不提前签发临时 URL。 */
downloadUrl: (key: string) =>
 `/api/storage/download-redirect/${encodeURIComponent(key)}`,
```

不要改 `VcpDeckClient.baseUrl` 可见性，不要让该方法调用 `request()`。

- [ ] **Step 5: 验证 SDK**

```bash
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/sdk build
```

Expected: 全部 PASS，TypeScript build exit 0。

- [ ] **Step 6: 提交 Task 2**

```bash
git add "packages/sdk/src/storage.ts" "packages/sdk/src/storage.test.ts"
git commit -m "SDK 增加稳定下载地址构造器"
```

---

### Task 3: 任务详情与任务抽屉迁移到稳定地址

**Files:**

- Modify: `packages/frontend/src/components/download-link-card.tsx:1-72`
- Modify: `packages/frontend/src/pages/job-detail-page.test.tsx:39-181`
- Modify: `packages/frontend/src/pages/jobs-page.test.tsx:290-385`

**Interfaces:**

- Consumes: `sdk.storage.downloadUrl(key): string`。
- Produces: `DownloadLinkCard` 同步展示稳定同源 URL；不在页面加载时签发阿里云 URL。
- Copy: `下载文件（地址稳定；每次访问都会刷新临时云盘链接）`。

- [ ] **Step 1: 运行共享组件影响分析并报告风险**

```text
gitnexus_impact({ repo: "VCPDeck", target: "DownloadLinkCard", direction: "upstream", depth: 3, includeTests: true })
```

该共享组件历史风险为 CRITICAL（任务详情与抽屉共同使用）；开始编辑前向用户报告受影响页面与测试面。

- [ ] **Step 2: 把详情页测试改成稳定 URL 的失败测试**

调整 `renderDetail()`：mock 的 Storage 模块只提供：

```ts
const downloadUrl = vi
 .fn()
 .mockReturnValue("/api/storage/download-redirect/aliyun-fileid-123");
```

将首个测试核心断言改为：

```ts
expect(link).toHaveAttribute(
 "href",
 `${window.location.origin}/api/storage/download-redirect/aliyun-fileid-123`,
);
expect(link).toHaveAttribute("download", "app.log");
expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
expect(downloadUrl).toHaveBeenCalledWith("aliyun-fileid-123");
expect(screen.queryByText(/正在生成下载链接/)).not.toBeInTheDocument();
```

删除“外部绝对 URL 原样渲染”和“签发失败”测试；它们属于被移除的页面加载签发行为。保留 file.import 文件名与无 key 不渲染测试，并改为断言 `downloadUrl`。

- [ ] **Step 3: 把任务抽屉测试改成稳定 URL 的失败测试**

在两个完成任务用例中，把 Storage mock 改为：

```ts
storage: {
 downloadUrl: vi.fn((key: string) =>
  `/api/storage/download-redirect/${encodeURIComponent(key)}`,
 ),
},
```

file.export 断言：

```ts
expect(link).toHaveAttribute(
 "href",
 `${window.location.origin}/api/storage/download-redirect/aliyun-fileid-123`,
);
```

file.import 同样断言 `aliyun-fileid-456`。删除 `createDownloadToken` 调用断言。

- [ ] **Step 4: 运行两个测试文件确认 RED**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/job-detail-page.test.tsx src/pages/jobs-page.test.tsx
```

Expected: FAIL；当前组件仍调用 `createDownloadToken()` 并进入“正在生成”状态。

- [ ] **Step 5: 把 DownloadLinkCard 简化为同步稳定 URL**

移除 `useEffect`、`useState`、`failed` 和异步签发逻辑。保留 key/filename 计算，并使用：

```ts
const path = key ? sdk.storage.downloadUrl(String(key)) : null;
const url = path ? `${window.location.origin}${path}` : null;
```

有 key 时渲染：

```tsx
<p className="text-xs font-medium text-muted-foreground">
 下载文件（地址稳定；每次访问都会刷新临时云盘链接）
</p>
<a
 href={url}
 download={filename}
 referrerPolicy="no-referrer"
 className="text-sm font-medium text-primary underline underline-offset-4"
>
 下载文件
</a>
<code className="block break-all rounded bg-muted p-2 text-xs">{url}</code>
```

无 key 的调用方本来就不渲染该组件；保留一个无链接兜底即可，不发网络请求。

- [ ] **Step 6: 验证任务详情与抽屉**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/job-detail-page.test.tsx src/pages/jobs-page.test.tsx
```

Expected: PASS。

Then run LSP on the three edited files; expected 0 diagnostics。`no-nested-links` 若仍误报，确认组件只有一个 `<a>` 后使用 `lens_diagnostic_mark` 记录 false-positive，不加无意义 suppress 注释。

- [ ] **Step 7: 提交 Task 3**

```bash
git add "packages/frontend/src/components/download-link-card.tsx" "packages/frontend/src/pages/job-detail-page.test.tsx" "packages/frontend/src/pages/jobs-page.test.tsx"
git commit -m "任务详情改用稳定下载地址"
```

---

### Task 4: 统一动态浏览器下载 Adapter 并迁移铃铛

**Files:**

- Create: `packages/frontend/src/api/download-file.ts`
- Create: `packages/frontend/src/api/download-file.test.ts`
- Modify: `packages/frontend/src/components/notification-bell.tsx:224-269`
- Modify: `packages/frontend/src/components/notification-bell.test.tsx:220-356`

**Interfaces:**

- Produces: `startBrowserDownload(url: string, filename: string): void`。
- Invariant: 动态 anchor 必须设置 href、download、`referrerPolicy="no-referrer"`，插入 DOM 后 click 并移除。
- NotificationBell consumes: `sdk.storage.downloadUrl(storageKey)` + `startBrowserDownload()`。

- [ ] **Step 1: 运行影响分析**

```text
gitnexus_impact({ repo: "VCPDeck", target: "NotificationBell", direction: "upstream", depth: 3, includeTests: true })
gitnexus_impact({ repo: "VCPDeck", target: "DownloadButton", direction: "upstream", depth: 3, includeTests: true })
```

预期 LOW；记录 App 与 ConsoleShell 调用面。

- [ ] **Step 2: 创建浏览器下载 adapter 的失败测试**

创建 `packages/frontend/src/api/download-file.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserDownload } from "./download-file";

afterEach(() => vi.restoreAllMocks());

describe("startBrowserDownload", () => {
 it("用文件名与 no-referrer 触发浏览器下载后移除临时链接", () => {
  const click = vi
   .spyOn(HTMLAnchorElement.prototype, "click")
   .mockImplementation(() => {});

  startBrowserDownload(
   "/api/storage/download-redirect/aliyun-file",
   "large.zip",
  );

  const anchor = click.mock.instances[0] as HTMLAnchorElement;
  expect(anchor.href).toBe(
   `${window.location.origin}/api/storage/download-redirect/aliyun-file`,
  );
  expect(anchor.download).toBe("large.zip");
  expect(anchor.referrerPolicy).toBe("no-referrer");
  expect(anchor.isConnected).toBe(false);
 });
});
```

- [ ] **Step 3: 修改铃铛测试形成第二个 RED**

铃铛完成任务用例的 Storage mock 改为：

```ts
const downloadUrl = vi
 .fn()
 .mockReturnValue("/api/storage/download-redirect/aliyun-fileid-9");
```

点击“下载”后断言：

```ts
expect(downloadUrl).toHaveBeenCalledWith("aliyun-fileid-9");
expect(anchorClick.mock.instances[0]).toHaveProperty(
 "href",
 `${window.location.origin}/api/storage/download-redirect/aliyun-fileid-9`,
);
```

移除 `createDownloadToken` 和“生成中”相关断言。

- [ ] **Step 4: 运行测试确认 RED**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/api/download-file.test.ts src/components/notification-bell.test.tsx
```

Expected: FAIL；adapter 文件不存在，铃铛仍异步签发 token。

- [ ] **Step 5: 实现最小浏览器下载 adapter**

创建 `packages/frontend/src/api/download-file.ts`：

```ts
/** 通过临时 anchor 触发浏览器下载。 */
export function startBrowserDownload(url: string, filename: string): void {
 const anchor = document.createElement("a");
 anchor.href = url;
 anchor.download = filename;
 anchor.referrerPolicy = "no-referrer";
 document.body.append(anchor);
 anchor.click();
 anchor.remove();
}
```

- [ ] **Step 6: 简化 NotificationBell.DownloadButton**

导入 `startBrowserDownload`。将 `doDownload` 改为同步逻辑：

```ts
const doDownload = useCallback(() => {
 startBrowserDownload(sdk.storage.downloadUrl(storageKey), filename);
 setNotice("已开始下载，请查看浏览器下载栏");
 window.setTimeout(() => setNotice(""), 3000);
}, [sdk, storageKey, filename]);
```

删除 `busy` 状态、异步 token 请求、try/catch/finally 和“生成中”文案；Button 只保留 `onClick={doDownload}`。

- [ ] **Step 7: 验证 adapter 与铃铛**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/api/download-file.test.ts src/components/notification-bell.test.tsx
```

Expected: PASS，测试输出无 `console.log`。

- [ ] **Step 8: 提交 Task 4**

```bash
git add "packages/frontend/src/api/download-file.ts" "packages/frontend/src/api/download-file.test.ts" "packages/frontend/src/components/notification-bell.tsx" "packages/frontend/src/components/notification-bell.test.tsx"
git commit -m "铃铛下载改用稳定地址"
```

---

### Task 5: 文件面板与备用文件详情迁移

**Files:**

- Modify: `packages/frontend/src/pages/files-panel.tsx:660-700,1038-1065`
- Modify: `packages/frontend/src/pages/files-panel.test.tsx:1-570`
- Modify: `packages/frontend/src/pages/file-detail.tsx:105-138`
- Create: `packages/frontend/src/pages/file-detail.test.tsx`

**Interfaces:**

- Consumes: `sdk.storage.downloadUrl(key)`、`startBrowserDownload(url, filename)`。
- Produces: 右键导出、FileViewerDialog、FileDetail 三个动态下载路径统一使用稳定地址。

- [ ] **Step 1: 运行所有目标符号的影响分析**

```text
gitnexus_impact({ repo: "VCPDeck", target: "FilesPanel", direction: "upstream", depth: 3, includeTests: true })
gitnexus_impact({ repo: "VCPDeck", target: "FileViewerDialog", direction: "upstream", depth: 3, includeTests: true })
gitnexus_impact({ repo: "VCPDeck", target: "FileDetail", direction: "upstream", depth: 3, includeTests: true })
```

`FilesPanel`/`FileViewerDialog` 历史风险为 HIGH；编辑前向用户报告影响 Workspace、MachineWorkspace 与相关测试。`FileDetail` 当前无 caller，但仍迁移以避免重新挂载时回归。

- [ ] **Step 2: 更新 FilesPanel 测试 helper 和两个失败用例**

`renderFiles()` 的 storage mock 改为：

```ts
const storage = {
 downloadUrl: vi.fn((key: string) =>
  `/api/storage/download-redirect/${encodeURIComponent(key)}`,
 ),
};
```

保留 `(files as Record<string, unknown>).storage = storage` 供断言。

为右键菜单新增用例：

```ts
it("右键导出使用稳定下载地址", async () => {
 const anchorClick = vi
  .spyOn(HTMLAnchorElement.prototype, "click")
  .mockImplementation(() => {});
 const files = renderFiles({
  export: vi.fn().mockResolvedValue({ key: "aliyun-file" }),
 });
 await userEvent.click(await screen.findByRole("button", { name: "D:\\" }));
 fireEvent.contextMenu(
  await screen.findByRole("button", { name: /^README\.md/ }),
 );

 await userEvent.click(screen.getByRole("menuitem", { name: "导出下载" }));
 await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
 expect((files as Record<string, any>).storage.downloadUrl).toHaveBeenCalledWith(
  "aliyun-file",
 );
});
```

把现有“文件查看器导出外部链接时不发送 Referer”改名为“文件查看器导出使用稳定下载地址”，移除 `createDownloadToken` mock，断言 `storage.downloadUrl("aliyun-file")` 和 anchor href 为稳定 URL。

- [ ] **Step 3: 创建 FileDetail 的失败测试**

创建 `packages/frontend/src/pages/file-detail.test.tsx`，使用真实 `SdkProvider` 渲染 `FileDetail`：

```tsx
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SdkProvider } from "@/api/context";
import { FileDetail } from "./file-detail";

it("FileDetail 导出使用稳定下载地址", async () => {
 const click = vi
  .spyOn(HTMLAnchorElement.prototype, "click")
  .mockImplementation(() => {});
 const downloadUrl = vi
  .fn()
  .mockReturnValue("/api/storage/download-redirect/aliyun-file");
 const client = {
  files: {
   readText: vi.fn().mockResolvedValue({ content: "hello", size: 5 }),
   export: vi.fn().mockResolvedValue({ key: "aliyun-file" }),
   writeText: vi.fn(),
  },
  storage: { downloadUrl },
 } as unknown as VcpDeckClient;

 render(
  <SdkProvider client={client}>
   <FileDetail
    clientId="c1"
    rootDir="D:\\"
    path="."
    entry={{
     name: "a.txt",
     kind: "file",
     size: 5,
     mtime: "2026-08-05T00:00:00.000Z",
    }}
    onDelete={vi.fn()}
    onMove={vi.fn()}
    onChanged={vi.fn()}
   />
  </SdkProvider>,
 );

 await userEvent.click(await screen.findByRole("button", { name: "导出下载" }));
 await waitFor(() => expect(click).toHaveBeenCalledOnce());
 expect(downloadUrl).toHaveBeenCalledWith("aliyun-file");
});
```

- [ ] **Step 4: 运行文件下载测试确认 RED**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx src/pages/file-detail.test.tsx
```

Expected: FAIL；当前三个路径仍调用 `createDownloadToken()`。

- [ ] **Step 5: 迁移 FilesPanel 两个动态下载入口**

在 `files-panel.tsx` 导入：

```ts
import { startBrowserDownload } from "@/api/download-file";
```

右键导出中把 token + anchor 块替换为：

```ts
startBrowserDownload(sdk.storage.downloadUrl(exported.key), e.name);
```

`FileViewerDialog` 中替换为：

```ts
startBrowserDownload(sdk.storage.downloadUrl(exported.key), entry.name);
```

保留现有 export job、错误提示和 notice 行为。

- [ ] **Step 6: 迁移备用 FileDetail**

导入同一 adapter，把 token + anchor 块替换为：

```ts
startBrowserDownload(
 sdk.storage.downloadUrl(exported.key),
 entry.name,
);
```

保留 exporting/error 状态。

- [ ] **Step 7: 验证三个文件入口与全前端测试**

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx src/pages/file-detail.test.tsx
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

Expected: 定向测试 PASS；前端全量 PASS；build exit 0。

- [ ] **Step 8: 提交 Task 5**

```bash
git add "packages/frontend/src/pages/files-panel.tsx" "packages/frontend/src/pages/files-panel.test.tsx" "packages/frontend/src/pages/file-detail.tsx" "packages/frontend/src/pages/file-detail.test.tsx"
git commit -m "文件面板下载统一使用稳定地址"
```

---

### Task 6: Cookie/Bearer/Range 集成验证与完整回归

**Files:**

- Modify: `scripts/test.cjs:955-1032,1790-1900`

**Interfaces:**

- Verifies: 匿名 401、Cookie 302、Bearer 302、Range 请求仍获 fresh 302、local 最终下载内容不变。
- Must not require: 真实阿里云账号；真实 alibaba Range 在手动验证中执行。

- [ ] **Step 1: 运行集成 helper 影响分析**

```text
gitnexus_impact({ repo: "VCPDeck", target: "storageUploadAndVerify", direction: "upstream", depth: 3, includeTests: true })
```

Expected: 仅集成测试主流程；若风险异常，先报告。

- [ ] **Step 2: 增加完整稳定入口集成 helper**

在 `storageUploadAndVerify()` 后、`// ── Main ──` 前加入以下完整 helper：

```js
async function verifyStableDownloadRedirect(key) {
 const stablePath = `/api/storage/download-redirect/${encodeURIComponent(key)}`;

 const anonymous = await api("GET", stablePath, { noCookie: true });
 if (anonymous.status === 401) {
  pass("Storage stable download no auth", "401");
 } else {
  fail(
   "Storage stable download no auth",
   `expected 401, got ${anonymous.status}`,
  );
 }

 const cookieRedirect = await api("GET", stablePath, {
  headers: { Range: "bytes=1-" },
 });
 const location = cookieRedirect.headers.get("location") || "";
 const referrerPolicy = cookieRedirect.headers.get("referrer-policy");
 const cacheControl = cookieRedirect.headers.get("cache-control") || "";
 if (
  cookieRedirect.status === 302 &&
  location.startsWith("/api/storage/download/") &&
  referrerPolicy === "no-referrer" &&
  cacheControl.includes("no-store")
 ) {
  pass("Storage stable download cookie redirect", "302 + safe headers");
 } else {
  fail(
   "Storage stable download cookie redirect",
   JSON.stringify({
    status: cookieRedirect.status,
    location,
    referrerPolicy,
    cacheControl,
   }),
  );
 }

 const { status: tokenStatus, body: token } = await apiJson(
  "POST",
  "/api/auth/tokens",
  { json: { label: "storage-download-redirect" } },
 );
 if ((tokenStatus !== 200 && tokenStatus !== 201) || !token?.token) {
  fail("Storage stable download bearer setup", `status=${tokenStatus}`);
 } else {
  try {
   const bearerRedirect = await api("GET", stablePath, {
    bearer: token.token,
    noCookie: true,
    headers: { Range: "bytes=1-" },
   });
   if (
    bearerRedirect.status === 302 &&
    (bearerRedirect.headers.get("location") || "").startsWith(
     "/api/storage/download/",
    )
   ) {
    pass("Storage stable download bearer redirect", "302");
   } else {
    fail(
     "Storage stable download bearer redirect",
     `status=${bearerRedirect.status}`,
    );
   }
  } finally {
   await api("DELETE", `/api/auth/tokens/${token.id}`);
  }
 }

 if (location.startsWith("/api/storage/download/")) {
  const localDownload = await fetch(`${BASE}${location}`);
  const content = await localDownload.text();
  if (localDownload.status === 200 && content === TEST_FILE_CONTENT) {
   pass("Storage stable download local content", "content matches");
  } else {
   fail(
    "Storage stable download local content",
    `status=${localDownload.status} contentLen=${content.length}`,
   );
  }
 }
}
```

Task 1 已有 Controller RED 证据；此任务只补真实应用鉴权与 local 链路验证，不重复伪造一次 RED。

- [ ] **Step 3: 在删除 testKey 前调用 helper**

在 Storage 测试段，`storageUploadAndVerify()` 完成后、`// 50. Upload with expired signature` 前加入：

```js
if (testKey) {
 await verifyStableDownloadRedirect(testKey);
}
```

然后运行：

```bash
node scripts/test.cjs
```

若 Task 1 尚未实现，预期稳定端点检查 FAIL；按任务顺序执行时应直接 PASS。为了保留 TDD 证据，实施者应在 Task 1 前临时运行该新增检查或通过 `git show 403fe90` 确认基线没有路由；Task 1 的 controller RED 是主要自动化 RED 证据。

- [ ] **Step 4: 运行完整自动化验证**

```bash
pnpm test
pnpm build
```

并单独确认包级结果：

```bash
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
```

Expected: 全部 exit 0，无失败测试。`pnpm lint` 若仍因仓库缺少 eslint 命令失败，只记录为既有仓库配置 blocker，不通过安装新依赖绕过。

- [ ] **Step 5: 执行源码与诊断检查**

```bash
git diff --check
```

Then:

```text
lens_diagnostics({ mode: "all", severity: "all" })
lsp_diagnostics({ paths: ["packages/server/src/storage/", "packages/sdk/src/storage.ts", "packages/frontend/src/"], serverScope: "primary", severity: "all" })
```

Expected: 本次编辑文件 0 blocking errors；仅经验证的静态规则误报可使用 `lens_diagnostic_mark` 登记。

- [ ] **Step 6: 检查变更影响范围**

```text
gitnexus_detect_changes({ repo: "VCPDeck", scope: "compare", base_ref: "403fe90" })
```

预期影响仅限：Storage redirect、SDK storage URL、任务下载 UI、文件面板下载 UI、集成测试。若出现 Client `file.import` 数据面变化，停止并恢复：该链路必须继续使用 direct `downloadRef`。

- [ ] **Step 7: 独立代码审查**

使用 reviewer 检查：

- 稳定端点没有 `@Public()`；
- Location 每次 fresh，且 no-store/no-referrer；
- 没有日志打印完整阿里云 URL；
- 前端五个入口均不再调用 `createDownloadToken()`；
- Server 内部 `JobService` / `FileService` / Client transfer-handler 仍保留直接 URL 数据面；
- 没有 Server 文件流代理；
- Range 声明未被夸大成浏览器强保证续传。

修复所有 Critical/Important 后重新运行 Step 4-6。

- [ ] **Step 8: 提交 Task 6**

```bash
git add "scripts/test.cjs"
git commit -m "验证稳定下载入口鉴权与续传语义"
```

- [ ] **Step 9: 真实 alibaba 手动验收**

先创建 Bearer Token，获取现有 alibaba File key，然后执行：

```bash
curl -L \
  -H "Authorization: Bearer $TOKEN" \
  -o big.bin \
  "$BASE/api/storage/download-redirect/$KEY"
```

中断后：

```bash
curl -L -C - \
  -H "Authorization: Bearer $TOKEN" \
  -o big.bin \
  "$BASE/api/storage/download-redirect/$KEY"
```

验收证据：

- 初始稳定请求返回 302；
- 重试稳定入口获得新的 Location；
- 最终阿里云响应为 `206 Partial Content`；
- 文件最终大小与 File 记录一致；
- Server 网络流量不随文件大小增长；
- 浏览器从任务详情、抽屉、铃铛、右键导出和文件查看器点击均不再暴露巨型临时 URL，也不出现 Referer policy 403。

若真实 alibaba 环境暂不可用，自动化任务仍可提交，但必须在最终报告中把该项列为未验证残余风险，不能声称端到端续传已实测通过。

---

## Final Acceptance Checklist

- [ ] `GET /api/storage/download-redirect/:key` 受 Cookie/Bearer 鉴权保护。
- [ ] 每次 GET 都重新调用 `createDownloadToken(key)` 并返回 fresh 302 Location。
- [ ] 302 包含 `Referrer-Policy: no-referrer` 与 `Cache-Control: private, no-store`。
- [ ] Server 不读取 Range、不打开文件流、不代理 alibaba 文件数据。
- [ ] SDK `downloadUrl()` 是纯相对 URL 构造器且编码 key。
- [ ] 所有五个浏览器下载入口使用稳定 URL；动态 anchor 复用同一 adapter。
- [ ] `createDownloadToken()` 仍存在，远程 Client 的 file.import 数据面未改。
- [ ] local 现有签名下载完整回归通过；未声称 local 支持 Range。
- [ ] curl Bearer + `-C -` 的真实 alibaba 续传完成，或明确记录未验证。
- [ ] 全量测试、build、LSP、lens、GitNexus change scope 和独立 review 通过。
