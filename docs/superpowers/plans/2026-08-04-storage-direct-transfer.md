# 存储直连传输实施计划（绕过 Server 带宽）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阿里云后端下，上传（浏览器→远程）、导出（远程→浏览器）、导入（远程拉取）数据流直连阿里云 OSS，Server 只做编排；local 后端行为不变。

**Architecture:** Server 复用现有 `AlibabaOpenApiClient`（createFileUpload / getUploadUrl / completeUpload / getDownloadUrl），在 `AlibabaStorageProvider` 上暴露直传会话方法；`JobService` 注入 `StorageService`（JobModule 增加 StorageModule import，无循环：StorageModule 只依赖 PrismaModule），按后端 kind 分支返回 `UploadTarget`；Client / 前端按 `kind: "direct"` 分片直传，`kind: "proxy"` 走现有签名 URL 中转。export 因 size 未知，由 Client stat 后调 `POST /api/files/export-sessions` 动态协商直传会话（对 spec 的修正：spec 写"Server 创建 job 时创建会话"，实际需 client 协商）。

**Tech Stack:** NestJS（Server）、Node.js + socket.io-client（Client）、React + Vite（Frontend）、原生 XHR / fetch、无新依赖。

## Global Constraints

- 无新依赖：浏览器分片上传用原生 `XMLHttpRequest`，Client 用 `fetch`。
- 分片固定 10MB/片（上限 10000 片 = 100GB）、并发 3、单片失败重试 2 次（403 调续期接口取新 URL 重试）。
- `FileImportPayload.sha256` 移除；`File` 表 `sha256` 存 `""`（不动 Prisma schema）。
- 下载链接临时（约 15 分钟），点击/查看时实时生成，不缓存。
- 业务注释、提交信息用简体中文；标识符、协议字段、枚举值用英文。
- TypeScript：ESM + strict，NodeNext 相对导入保留 `.js` 后缀。
- 每个任务独立提交；local 后端行为保持现状（proxy）。

---

### Task 1: shared 协议（UploadTarget 判别联合 + FileRef.direct）

**Files:**

- Modify: `packages/shared/src/index.ts`（FileRef、FileUploadSession、FileImportPayload、FileExportPayload 区）

**Interfaces:**

- Produces:
  - `type UploadTarget = { kind: "proxy"; url: string; expiresAt: number } | { kind: "direct"; fileId: string; uploadId: string; parts: Array<{ partNumber: number; url: string }> }`
  - `FileUploadSession { jobId: string; fileId: string; status: JobStatus; upload: UploadTarget }`
  - `FileRef` 增加 `direct?: boolean`
  - `FileImportPayload` 移除 `sha256`（保留 `size`、`overwrite`）
  - `FileExportPayload` 的 `uploadRef` 不变（FileRef 已有 direct 字段）
  - 新增 `FileExportSessionCreate { jobId: string; size: number }`
  - 新增 `FileExportSession { fileId: string; uploadId: string; parts: Array<{ partNumber: number; url: string }> }`

- [ ] **Step 1: 修改协议类型**

```ts
// FileRef 增加
export interface FileRef {
  id: string;
  key: string;
  url: string;
  method: "GET" | "PUT";
  expiresAt: number;
  headers?: Record<string, string>;
  direct?: boolean; // true = 外部直连 URL（阿里云），Client 不做同源限制
}

// UploadTarget
export type UploadTarget =
  | { kind: "proxy"; url: string; expiresAt: number }
  | {
      kind: "direct";
      fileId: string;
      uploadId: string;
      parts: Array<{ partNumber: number; url: string }>;
    };

// FileUploadSession.upload 类型改为 UploadTarget

// FileImportPayload 删除 sha256 行
export interface FileImportPayload {
  targetPath: string;
  rootDir: string;
  downloadRef: FileRef;
  size: number;
  overwrite?: boolean;
}

// 新增
export interface FileExportSessionCreate {
  jobId: string;
  size: number;
}
export interface FileExportSession {
  fileId: string;
  uploadId: string;
  parts: Array<{ partNumber: number; url: string }>;
}
```

- [ ] **Step 2: 编译检查**

Run: `pnpm --filter @vcpdeck/shared build`
Expected: 无类型错误；若 SDK/client/server 引用了被删的 `sha256` 字段会报错——**暂时不管**（后续任务逐步适配），只在 shared 内确认编译通过（shared 无内部引用）。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "协议增加直连上传目标与外部 URL 标记"
```

---

### Task 2: Server 阿里云 Provider 直传方法

**Files:**

- Modify: `packages/server/src/storage/providers/alibaba-storage.provider.ts`
- Test: `packages/server/src/storage/providers/alibaba-storage.provider.test.ts`（新建）

**Interfaces:**

- Consumes: `AlibabaOpenApiClient` 现有方法：`createFileUpload({driveId, parentFileId, name, size, partInfoList})`、`getUploadUrl({driveId, fileId, uploadId, partNumbers})`、`completeUpload({driveId, fileId, uploadId})`、`getDownloadUrl({driveId, fileId})`
- Produces（AlibabaStorageProvider 新方法）:
  - `createDirectUpload(size: number, name: string): Promise<{ fileId: string; uploadId: string; parts: Array<{ partNumber: number; url: string }> }>`
  - `refreshPartUrls(fileId: string, uploadId: string, partNumbers: number[]): Promise<Array<{ partNumber: number; url: string }>>`
  - `completeDirectUpload(fileId: string, uploadId: string): Promise<void>`
  - `getExternalDownloadUrl(fileId: string): Promise<{ url: string; expiresAt: number }>`

常量：`export const ALIBABA_PART_SIZE = 10 * 1024 * 1024;`

- [ ] **Step 1: 写失败测试**（stub 全局 fetch 模拟 openapi 响应）

```ts
// alibaba-storage.provider.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlibabaStorageProvider, ALIBABA_PART_SIZE } from "./alibaba-storage.provider.js";

const baseConfig = {
  clientId: "app-id",
  accessToken: "token",
  expiresAt: Date.now() + 3_600_000,
  transferFolder: "VCPDeckTransfers",
};

function openapiOk(body: unknown) {
  return vi.fn().mockResolvedValue(Response.json(body));
}

function driveChildren(driveId: string) {
  return { items: [] }; // ensureTransferFolder 会逐段创建，首段无匹配 → createFolder
}

describe("AlibabaStorageProvider 直传会话", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("createDirectUpload 按 size 分片并返回各片 URL", async () => {
    const provider = new AlibabaStorageProvider(baseConfig as never);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ default_drive_id: "drive-1" })) // getDriveInfo
      .mockResolvedValueOnce(Response.json({ items: [] })) // 列出 VCPDeckTransfers → 空
      .mockResolvedValueOnce(Response.json({ file_id: "folder-1" })) // createFolder
      .mockResolvedValueOnce(
        Response.json({
          file_id: "file-1",
          upload_id: "upload-1",
          part_info_list: [
            { part_number: 1, upload_url: "https://oss.example/p1" },
            { part_number: 2, upload_url: "https://oss.example/p2" },
          ],
        }),
      ); // createFileUpload
    vi.stubGlobal("fetch", fetcher);

    const result = await provider.createDirectUpload(ALIBABA_PART_SIZE + 1, "big.bin");

    expect(result).toMatchObject({
      fileId: "file-1",
      uploadId: "upload-1",
      parts: [
        { partNumber: 1, url: "https://oss.example/p1" },
        { partNumber: 2, url: "https://oss.example/p2" },
      ],
    });
  });

  it("refreshPartUrls 返回续期后的分片 URL", async () => {
    const provider = new AlibabaStorageProvider(baseConfig as never);
    vi.stubGlobal(
      "fetch",
      openapiOk({
        part_info_list: [{ part_number: 2, upload_url: "https://oss.example/p2-new" }],
      }),
    );
    const parts = await provider.refreshPartUrls("file-1", "upload-1", [2]);
    expect(parts).toEqual([{ partNumber: 2, url: "https://oss.example/p2-new" }]);
  });

  it("completeDirectUpload 调 complete 接口", async () => {
    const provider = new AlibabaStorageProvider(baseConfig as never);
    const fetcher = openapiOk({});
    vi.stubGlobal("fetch", fetcher);
    await provider.completeDirectUpload("file-1", "upload-1");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ file_id: "file-1", upload_id: "upload-1" });
  });

  it("getExternalDownloadUrl 返回外部 URL", async () => {
    const provider = new AlibabaStorageProvider(baseConfig as never);
    vi.stubGlobal(
      "fetch",
      openapiOk({ url: "https://download.example/x", expire_time: 1760000000000 }),
    );
    const result = await provider.getExternalDownloadUrl("file-1");
    expect(result).toEqual({
      url: "https://download.example/x",
      expiresAt: 1760000000000,
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/server exec vitest run src/storage/providers/alibaba-storage.provider.test.ts`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

在 `AlibabaStorageProvider` 中新增（复用现有 `ensureReady` / `ensureTransferFolder` / `makeClient` 私有方法，先 `sed -n` 读 provider 现有实现确认私有方法名后再写）：

```ts
export const ALIBABA_PART_SIZE = 10 * 1024 * 1024;

// 在类内新增：
/** 创建直传上传会话（分片预签名 URL 列表） */
async createDirectUpload(
  size: number,
  name: string,
): Promise<{ fileId: string; uploadId: string; parts: Array<{ partNumber: number; url: string }> }> {
  const rt = await this.ensureReady();
  const client = this.makeClient(rt);
  const parentFileId = await this.ensureTransferFolder(rt, client);
  const partCount = Math.max(1, Math.ceil(size / ALIBABA_PART_SIZE));
  const created = await client.createFileUpload({
    driveId: rt.driveId,
    parentFileId,
    name,
    size,
    partInfoList: Array.from({ length: partCount }, (_, i) => ({ part_number: i + 1 })),
  });
  const fileId = String(created.file_id ?? created.fileId ?? "");
  const uploadId = String(created.upload_id ?? created.uploadId ?? "");
  if (!fileId || !uploadId) throw new Error("阿里云盘创建上传任务未返回 file_id/upload_id");
  const list = (created.part_info_list ?? []) as Array<Record<string, unknown>>;
  const parts = list
    .map((p) => ({
      partNumber: Number(p.part_number),
      url: String(p.upload_url ?? ""),
    }))
    .filter((p) => p.partNumber > 0 && p.url);
  return { fileId, uploadId, parts };
}

/** 续期指定分片的上传 URL */
async refreshPartUrls(
  fileId: string,
  uploadId: string,
  partNumbers: number[],
): Promise<Array<{ partNumber: number; url: string }>> {
  const rt = await this.ensureReady();
  const client = this.makeClient(rt);
  const result = await client.getUploadUrl({
    driveId: rt.driveId,
    fileId,
    uploadId,
    partNumbers,
  });
  const list = (result.part_info_list ?? []) as Array<Record<string, unknown>>;
  return list
    .map((p) => ({
      partNumber: Number(p.part_number),
      url: String(p.upload_url ?? ""),
    }))
    .filter((p) => p.partNumber > 0 && p.url);
}

/** 完成直传（合并分片） */
async completeDirectUpload(fileId: string, uploadId: string): Promise<void> {
  const rt = await this.ensureReady();
  const client = this.makeClient(rt);
  await client.completeUpload({ driveId: rt.driveId, fileId, uploadId });
}

/** 获取外部下载 URL（临时，约 15 分钟） */
async getExternalDownloadUrl(fileId: string): Promise<{ url: string; expiresAt: number }> {
  const rt = await this.ensureReady();
  const client = this.makeClient(rt);
  const result = await client.getDownloadUrl({ driveId: rt.driveId, fileId });
  const url = String(result.url ?? "");
  if (!url) throw new Error("阿里云盘未返回下载 URL");
  return {
    url,
    expiresAt: Number(result.expire_time ?? result.expiresAt ?? 0),
  };
}
```

注：`ensureReady` / `makeClient` / `ensureTransferFolder` 的现有私有方法名和 `createFileUpload` 返回字段名以 `alibaba-storage.provider.ts` 与 `alibaba-openapi.client.ts` 实际代码为准（本任务前先读这两个文件确认）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/server exec vitest run src/storage/providers/alibaba-storage.provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/storage/providers/
git commit -m "阿里云 Provider 增加直传会话与外部下载 URL 方法"
```

---

### Task 3: Server 编排（JobService + StorageService + EventsController 端点）

**Files:**

- Modify: `packages/server/src/job/job.module.ts`（imports 增加 StorageModule）
- Modify: `packages/server/src/job/job.service.ts`（createUploadSession / completeUploadSession 直传分支；create 的 file.export 分支 payload 标记 direct）
- Modify: `packages/server/src/storage/storage.service.ts`（export-session、export-complete、part-urls、progress、downloadToken alibaba 分支）
- Modify: `packages/server/src/storage/storage.controller.ts`（createDownloadToken alibaba 分支返回外部 URL）
- Modify: `packages/server/src/events/events.controller.ts`（新增 4 个端点）
- Modify: `packages/server/src/storage/storage.service.test.ts`、`packages/server/src/events/events.controller.test.ts`、`packages/server/src/job/job.service.test.ts`

**Interfaces:**

- Consumes: Task 2 的 provider 方法；现有 `fileService.createPending` / `createDownloadToken`（返回 `{fileId, key, uploadUrl, expiresAt}` / `{downloadUrl, size, sha256}`）
- Produces:
  - `StorageService.createExportSession(jobId: string, size: number): Promise<FileExportSession>`（查 job payload 取 filename，provider.createDirectUpload，更新 File.size）
  - `StorageService.completeExportUpload(jobId: string, uploadedBytes: number): Promise<{ key: string }>`
  - `StorageService.refreshDirectPartUrls(fileId: string, uploadId: string, partNumbers: number[]): Promise<Array<{ partNumber: number; url: string }>>`
  - `StorageService.updateUploadProgress(jobId: string, loaded: number): Promise<void>`
  - `POST /api/files/export-sessions { jobId, size }`、`POST /api/files/export-sessions/:jobId/complete { uploadedBytes }`、`POST /api/files/upload-sessions/:jobId/part-urls { partNumbers }`、`POST /api/files/upload-sessions/:jobId/progress { loaded }`

- [ ] **Step 1: 先读现有代码确认签名**

Run: `sed -n '100,180p' packages/server/src/job/job.service.ts && sed -n '1,60p' packages/server/src/file/file.service.ts && grep -n "createDownloadToken\|receiveUpload\|getBackendConfig" packages/server/src/storage/storage.service.ts packages/server/src/storage/storage.controller.ts`
确认：`fileService.createPending` / `createDownloadToken` 签名、`StorageService.getBackendConfig()`、`storage.controller.ts` 的 `createDownloadToken` 端点、`EventsController` 现有 upload-sessions 端点。

- [ ] **Step 2: 写失败测试**（events.controller.test.ts 增加 direct 分支用例；storage.service.test.ts 增加 export-session / complete / downloadToken 用例）

```ts
// events.controller.test.ts 追加（沿用现有 mock 风格，先读现有测试确认 mock 结构）
it("createUploadSession 在 alibaba 后端返回 direct 直传目标", async () => {
  // mock StorageService.createDirectUpload → { fileId: "aliyun-file", uploadId: "up", parts: [{partNumber: 1, url: "https://oss.example/p1"}] }
  // mock JobService.createUploadSession → { jobId, fileId, status: "waiting_input", upload: { kind: "proxy", ... } }
  // 断言响应 upload.kind === "direct" 且含 parts
});

it("completeUploadSession 直传模式校验字节数并激活 job", async () => {
  // mock StorageService.completeDirectUploadSession 返回 { downloadRef: { url: "https://download.example/x", direct: true } }
  // 断言 JobService.completeUploadSession 收到 upload 信息
});

it("export-sessions 端点创建直传会话", async () => {
  // POST /api/files/export-sessions { jobId: "j1", size: 100 }
  // 断言 StorageService.createExportSession 被调用
});

it("export-sessions/:jobId/complete 完成直传", async () => {
  // POST /api/files/export-sessions/j1/complete { uploadedBytes: 100 }
  // 断言 StorageService.completeExportUpload("j1", 100)
});
```

```ts
// storage.service.test.ts 追加
it("createExportSession 调 provider.createDirectUpload 并更新 File.size", async () => {
  // mock prisma.job.findUnique → { payload: { path: "D:\\a.zip" } }
  // mock prisma.file.findFirst → { id: "f1" }
  // mock provider.createDirectUpload → { fileId, uploadId, parts }
  // 断言返回 parts 且 prisma.file.update 被调用（size 更新）
});

it("completeExportUpload 校验字节数并置 File completed", async () => {
  // mock prisma.job.findUnique / prisma.file.findFirst（size=100）
  // mock provider.completeDirectUpload
  // completeExportUpload("j1", 100) → 断言 file.update({ status: "completed", key: fileId, storageKind: "alibaba", sha256: "" })
});

it("createDownloadToken 在 alibaba 后端返回外部 URL", async () => {
  // mock getBackendConfig → kind "alibaba"；mock provider.getExternalDownloadUrl → { url: "https://download.example/x", expiresAt }
  // 断言 createDownloadToken({ key }) 返回 { url: "https://download.example/x" }（不签名）
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @vcpdeck/server exec vitest run src/events/events.controller.test.ts src/storage/storage.service.test.ts`
Expected: FAIL（新端点/方法不存在）

- [ ] **Step 4: 实现**

`job.module.ts` imports 增加 `StorageModule`。

`job.service.ts`：

- 构造函数注入 `@Inject(StorageService) private readonly storage: StorageService`
- `createUploadSession`：`createPending` 后查 `this.storage.getBackendConfig()`；`kind === "alibaba"` 时调 `this.storage.createDirectUpload(input.size, input.filename)`，返回 `upload: { kind: "direct", fileId, uploadId, parts }`；local 保持 proxy。
- `completeUploadSession(jobId, upload?: { fileId: string; uploadId: string; uploadedBytes: number })`：
  - alibaba（upload 参数存在）：读 File 校验 `upload.uploadedBytes === file.size`（不符抛 400 `SIZE_MISMATCH`）→ `this.storage.completeDirectUploadSession(payload.fileId, upload.uploadId, upload.uploadedBytes)`（StorageService 内：provider.completeDirectUpload + File 置 completed + key=fileId + storageKind="alibaba" + sha256=""）→ 生成 downloadRef：`await this.storage.createDownloadToken(file.key)`（alibaba 分支返回外部 URL，`direct: true`）→ finalPayload 同现有（不写 sha256）。
  - local：现有逻辑（校验 file.status === "completed" + 签名 URL）。
- `create`（file.export 分支）：alibaba 时 `finalPayload.uploadRef = { id: fileId, key, url: "", method: "PUT", expiresAt: 0, direct: true }`（url 空，client 走协商）；local 保持签名 URL。
- `create`（file.import 分支）：alibaba 时 downloadRef 用 `{ id, key, url: "", method: "GET", expiresAt: 0, direct: true }`（url 由 client 传完分片后在 complete 时生成？**注意**：file.import 的 downloadRef 是"从 storage 拉取到远程"的下载 URL——直传模式下 server 在 completeUploadSession 时已生成外部 URL。但 `create()` 的 file.import 分支用于 SDK `files.import(fileId)` 路径（已存在的 File）——alibaba 下用 `getExternalDownloadUrl` 生成外部 URL，`direct: true`。local 保持签名 URL。`size` 照旧，`sha256` 不再写入。）

`storage.service.ts` 新增（public）：

- `createDirectUpload(size, name)` → `this.getProvider()` 是 `AlibabaStorageProvider` 时调其方法；否则抛错（仅 alibaba 调用）
- `createExportSession(jobId, size)`：读 job payload 取 `path` → filename；`prisma.file.findFirst({where:{jobId}})` → 调 provider.createDirectUpload(size, filename) → `prisma.file.update({ size })` → 返回 `{ fileId, uploadId, parts }`
- `completeExportUpload(jobId, uploadedBytes)`：查 job + file（size 校验）→ provider.completeDirectUpload → file.update completed/key/storageKind/sha256:"" → 返回 `{ key }`
- `completeDirectUploadSession(fileId, uploadId, uploadedBytes)`：校验 size（内部查 File）→ provider.completeDirectUpload → file.update → 返回 void
- `refreshDirectPartUrls(fileId, uploadId, partNumbers)`
- `updateUploadProgress(jobId, loaded)`：复用现有私有 `updateJobProgress`（或直接调）
- `createDownloadToken`：`getBackendConfig().kind === "alibaba"` 时调 provider.getExternalDownloadUrl(key)，返回 `{ url: externalUrl, expiresAt }`（跳过签名）；local 保持签名。

`storage.controller.ts` 的 `createDownloadToken`：返回结构不变（`{ url, expiresAt }`），StorageService 内部已分支。

`events.controller.ts` 新增：

```ts
@Post("files/export-sessions")
async createExportSession(@Body() body: { jobId?: string; size?: number }) { ... }

@Post("files/export-sessions/:jobId/complete")
async completeExportSession(@Param("jobId") jobId: string, @Body() body: { uploadedBytes?: number }) { ... }

@Post("files/upload-sessions/:jobId/part-urls")
async refreshPartUrls(@Param("jobId") jobId: string, @Body() body: { partNumbers?: number[] }) { ... }

@Post("files/upload-sessions/:jobId/progress")
async updateProgress(@Param("jobId") jobId: string, @Body() body: { loaded?: number }) { ... }
```

（EventsController 已注入 JobService；补注入 StorageService——events.module imports 增加 StorageModule。）

- [ ] **Step 5: 运行测试确认通过（含现有用例适配）**

Run: `pnpm --filter @vcpdeck/server test`
Expected: PASS。现有用例需适配：`createUploadSession` 返回的 `upload` 断言改为 `kind: "proxy"`（mock getBackendConfig 默认 local）。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/
git commit -m "Server 支持直连上传会话与导出完成编排"
```

---

### Task 4: SDK 适配（files.ts）

**Files:**

- Modify: `packages/sdk/src/files.ts`
- Test: `packages/sdk/src/files.test.ts`（如存在则适配断言；无则仅编译）

**Interfaces:**

- Consumes: Task 1 类型
- Produces:
  - `files.createUploadSession(input, signal)` 返回类型含 `UploadTarget`（自动）
  - `files.completeUpload(jobId, body: { uploadedBytes: number }, signal)`（新签名，local 也传 size）
  - `files.completeExportUpload(jobId, uploadedBytes, signal)` → `{ key: string }`
  - `files.createExportSession(jobId, size, signal)` → `FileExportSession`
  - `files.refreshUploadPartUrls(jobId, partNumbers, signal)`
  - `files.updateUploadProgress(jobId, loaded, signal)` → POST `/api/files/upload-sessions/:jobId/progress`（直传分片完成时上报，铃铛进度可见）

- [ ] **Step 1: 读现有实现**

Run: `sed -n '1,80p' packages/sdk/src/files.ts`
确认现有 `createUploadSession` / `completeUpload` / `export` 写法（URLSearchParams 风格）。

- [ ] **Step 2: 实现 + 测试**

```ts
// files.ts 追加/修改（按现有风格）
completeUpload: (jobId, body, signal?) => client.request("POST", `/api/files/upload-sessions/${jobId}/complete`, body, signal),
createExportSession: (jobId, size, signal?) => client.request("POST", "/api/files/export-sessions", { jobId, size }, signal),
completeExportUpload: (jobId, uploadedBytes, signal?) => client.request("POST", `/api/files/export-sessions/${jobId}/complete`, { uploadedBytes }, signal),
refreshUploadPartUrls: (jobId, partNumbers, signal?) => client.request("POST", `/api/files/upload-sessions/${jobId}/part-urls`, { partNumbers }, signal),
updateUploadProgress: (jobId, loaded, signal?) => client.request("POST", `/api/files/upload-sessions/${jobId}/progress`, { loaded }, signal),
```

测试（files.test.ts）：mock `client.request`，断言 URL / body；`createUploadSession` 响应含 `kind: "direct"` 时透传。

- [ ] **Step 3: 编译 + 测试**

Run: `pnpm --filter @vcpdeck/sdk test && pnpm --filter @vcpdeck/sdk build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/
git commit -m "SDK 增加直传会话与导出完成接口"
```

---

### Task 5: Client 直连改造（transfer-handler.ts）

**Files:**

- Modify: `packages/client/src/transfer-handler.ts`
- Modify: `packages/client/src/transfer-handler.test.ts`

**Interfaces:**

- Consumes: Task 1（`FileRef.direct`、无 sha256）、Task 3 端点、Task 4 SDK 对应 REST
- Produces: `uploadParts(size, parts, { readPart, signal, refreshUrl })` 内部共用函数

- [ ] **Step 1: 写失败测试**

```ts
// transfer-handler.test.ts 追加（import 块）
it("downloadRef.direct 时直连外部 URL 且只校验 size", async () => {
  // importJob 改造：payload.downloadRef = { id: "f1", key: "aliyun-file", url: "https://download.example/x", method: "GET", expiresAt: 0, direct: true }
  // payload.sha256 删除
  // mock fetch → ok: true, body: 5 字节流
  // mockFsPromises.stat → null
  // 断言 doneCalls result { path, key: "aliyun-file", size: 5 }；fetch 第一个参数 === "https://download.example/x"
});

it("import 收到 size 不符时报 IO_ERROR", async () => {
  // 同上去 payload.size = 999，流 5 字节 → 断言 error.code === "IO_ERROR"
});

it("handleExport direct 模式分片直传并调 export-complete", async () => {
  // exportJob 改造：payload.uploadRef = { id: "f1", key: "k", url: "", method: "PUT", expiresAt: 0, direct: true }
  // mock fetch：
  //   1) POST /api/files/export-sessions → { fileId, uploadId, parts: [{partNumber:1, url:"https://oss.example/p1"}] }
  //   2) PUT https://oss.example/p1 → ok
  //   3) POST /api/files/export-sessions/job-1/complete → { key: "aliyun-file" }
  // mockFsPromises.stat → { size: 5 }
  // 断言 doneCalls result { fileId: "aliyun-file", key: "aliyun-file", size: 5 }；fetch 第 2 次调用 URL 是外部 OSS URL
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @vcpdeck/client exec vitest run src/transfer-handler.test.ts`
Expected: FAIL（新行为未实现；现有"摘要不匹配"测试需删除/改造为 size 用例）

- [ ] **Step 3: 实现**

```ts
// 常量与共用函数（transfer-handler.ts 顶部）
const PART_SIZE = 10 * 1024 * 1024;
const PART_CONCURRENCY = 3;
const PART_RETRIES = 2;

/** 分片上传：按 parts 并发 PUT；403 时调 refresh 取新 URL 重试 */
async function uploadParts(
  parts: Array<{ partNumber: number; url: string }>,
  size: number,
  opts: {
    readPart(partNumber: number, start: number, end: number): Promise<BodyInit>;
    onProgress?(loaded: number): void;
    signal?: AbortSignal;
    refreshUrl(partNumber: number): Promise<string>;
  },
): Promise<void> {
  const partSize = Math.ceil(size / parts.length);
  let done = 0;
  let loaded = 0;
  const lock = () => { /* 用简单互斥保证 loaded 累加安全（Node 单线程足够） */ };
  const queue = [...parts];
  async function worker() {
    while (queue.length > 0) {
      const part = queue.shift()!;
      if (opts.signal?.aborted) return;
      const start = (part.partNumber - 1) * partSize;
      const end = Math.min(size, start + partSize);
      let url = part.url;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
          method: "PUT",
          body: await opts.readPart(part.partNumber, start, end),
          signal: opts.signal,
        });
        if (res.ok) break;
        if (res.status === 403 && attempt < PART_RETRIES) {
          url = await opts.refreshUrl(part.partNumber);
          continue;
        }
        if (attempt < PART_RETRIES) continue;
        throw new Error(`分片 ${part.partNumber} 上传失败: HTTP ${res.status}`);
      }
      loaded += end - start;
      done += 1;
      opts.onProgress?.(loaded);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, () => worker()),
  );
}

/** Server 直传会话协商 + 完成（export 用） */
async function negotiateExportSession(jobId: string, size: number): Promise<FileExportSession> {
  const res = await fetch(absUrl("/api/files/export-sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId, size }),
  });
  if (!res.ok) throw new Error(`Export session failed: HTTP ${res.status}`);
  return (await res.json()) as FileExportSession;
}

async function completeExportUpload(jobId: string, uploadedBytes: number): Promise<string> {
  const res = await fetch(absUrl(`/api/files/export-sessions/${jobId}/complete`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadedBytes }),
  });
  if (!res.ok) throw new Error(`Export complete failed: HTTP ${res.status}`);
  const body = (await res.json()) as { key?: string };
  return body.key ?? "";
}
```

- `handleExport` 改造：`if (uploadRef.direct)` 分支：
  1. `const session = await negotiateExportSession(jobId, fileStat.size);`
  2. 调 `uploadParts`（见下）；`refreshUrl` 实现：

```ts
async function refreshExportPartUrl(jobId: string, partNumber: number): Promise<string> {
  const res = await fetch(absUrl(`/api/files/export-sessions/${jobId}/part-urls`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ partNumbers: [partNumber] }),
  });
  if (!res.ok) throw new Error(`刷新分片 URL 失败: HTTP ${res.status}`);
  const body = (await res.json()) as { parts?: Array<{ partNumber: number; url: string }> };
  const part = body.parts?.find((p) => p.partNumber === partNumber);
  if (!part?.url) throw new Error("刷新分片 URL 未返回新地址");
  return part.url;
}
```

  1. `const key = await completeExportUpload(jobId, fileStat.size);`
  2. `emitDone(socket, jobId, "file.export", { fileId: key, key, size: fileStat.size });`
  进度：把现有 `emitProgress` 节流逻辑提取为小函数（现有 Transform 只用于 proxy 分支）；direct 分支的 `readPart` 为 `async (n, s, e) => Readable.toWeb(createReadStream(safe, { start: s, end: e - 1 }))`。
  文件顶部 import 补充：`import type { FileExportSession } from "@vcpdeck/shared";`

- `handleImport` 改造：
  - 签名去掉 `expectedSha256`；fetch 用 `downloadRef.direct ? downloadRef.url : absUrl(downloadRef.url)`
  - 删除 hash/`SHA256_MISMATCH` 分支；size 校验保留（`loaded !== expectedSize` → `IO_ERROR`）
  - result 不变（`{ path, key: downloadRef.key, size: loaded }`）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/client test`
Expected: PASS（现有 proxy 用例保留；sha256 用例已替换）

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/
git commit -m "Client 支持直传会话与外部下载 URL"
```

---

### Task 6: 前端分片直传（upload-file.ts）

**Files:**

- Modify: `packages/frontend/src/api/upload-file.ts`
- Modify: `packages/frontend/src/api/upload-file.test.ts`

**Interfaces:**

- Consumes: Task 1 `UploadTarget`
- Produces:
  - `uploadDirect(upload: Extract<UploadTarget, {kind:"direct"}>, file: File, opts: { onProgress(loaded: number, total: number): void; signal?: AbortSignal }): Promise<void>`
  - 内部用 `sdk.files.refreshUploadPartUrls(jobId, [n])` 续期（jobId 由调用方传入或参数化——**参数化**：`uploadDirect(jobId, upload, file, opts)`）

- [ ] **Step 1: 写失败测试**

```ts
// upload-file.test.ts 追加
it("uploadDirect 按分片并发 PUT 并汇总进度", async () => {
  // 构造 2 片（parts 2 项，file 25MB？jsdom 里用 2 片小文件 + 手动 parts）
  // mock XMLHttpRequest（现有测试已有 mock 模式，先读文件确认）
  // 断言每个 part 各一个 XHR PUT、onProgress 汇总、全部完成后 resolve
});

it("uploadDirect 分片 403 时调续期接口重试", async () => {
  // mock 第一片 PUT 返回 403 → 断言 refreshUploadPartUrls 被调 → 新 URL 重试成功
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts`
Expected: FAIL（uploadDirect 不存在）

- [ ] **Step 3: 实现**（按现有 uploadFile 的 XHR helper 风格）

```ts
const DIRECT_PART_SIZE = 10 * 1024 * 1024;
const DIRECT_CONCURRENCY = 3;
const DIRECT_RETRIES = 2;

export async function uploadDirect(
  jobId: string,
  upload: Extract<UploadTarget, { kind: "direct" }>,
  file: File,
  opts: { onProgress: (loaded: number, total: number) => void; signal?: AbortSignal },
  refreshParts: (partNumbers: number[]) => Promise<Array<{ partNumber: number; url: string }>>,
): Promise<void> {
  // 与 uploadParts 同构：并发 3，片内 XHR onProgress 增量计入 loaded，403 → refreshParts([n]) 换 URL 重试
  // 每片完成上报（节流 500ms 由调用方决定；此处只汇总）
}
```

（注意：`refreshParts` 作为参数注入，避免 upload-file 依赖 SDK——与现有 `uploadFile(url, file, opts)` 的纯函数风格一致。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/api/upload-file.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/api/upload-file.ts packages/frontend/src/api/upload-file.test.ts
git commit -m "前端分片直传上传实现"
```

---

### Task 7: files-panel 直传分支 + 进度上报

**Files:**

- Modify: `packages/frontend/src/pages/files-panel.tsx`
- Modify: `packages/frontend/src/pages/files-panel.test.tsx`

**Interfaces:**

- Consumes: Task 6 `uploadDirect`、Task 4 SDK

- [ ] **Step 1: 写失败测试**

```ts
// files-panel.test.tsx 追加（mock createUploadSession 返回 kind:"direct" 的会话）
it("direct 会话走分片直传并在完成后 complete", async () => {
  // createUploadSession → { jobId, fileId, status: "waiting_input", upload: { kind: "direct", fileId: "aliyun-file", uploadId: "up", parts: [{ partNumber: 1, url: "https://oss.example/p1" }] } }
  // mock uploadDirect 成功
  // 断言 uploadDirect 被调、completeUpload 被调（含 uploadedBytes）
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx`
Expected: FAIL（runImport 未分支）

- [ ] **Step 3: 实现**（runImport 中 `session.upload.kind` 分支）

```ts
if (session.upload.kind === "direct") {
  await uploadDirect(session.jobId, session.upload, file, {
    onProgress: (loaded, total) => setUploadState({ phase: "uploading", filename: file.name, loaded, total }),
    signal: controller.signal,
  }, (partNumbers) => sdk.files.refreshUploadPartUrls(session.jobId, partNumbers, controller.signal));
  // 每片完成后节流上报进度到 server（可复用 onProgress 内的节流器，500ms 内 POST progress）
  await sdk.files.completeUpload(session.jobId, { uploadedBytes: file.size }, controller.signal);
} else {
  await uploadFile(uploadUrl(session.upload.url), file, { signal: controller.signal, onProgress: ... });
  await sdk.files.completeUpload(session.jobId, { uploadedBytes: file.size }, controller.signal);
}
```

进度上报（direct 分支）：在 onProgress 里节流调用 `sdk.files.updateUploadProgress(session.jobId, loaded, signal)`（SDK 新增；Task 4 已含 `refreshUploadPartUrls`，补 `updateUploadProgress`——**在 Task 4 一并实现**，签名 `files.updateUploadProgress(jobId, loaded, signal)` → POST `/api/files/upload-sessions/:jobId/progress`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/pages/files-panel.test.tsx`
Expected: PASS（现有 proxy 用例适配 `completeUpload` 新签名）

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/pages/files-panel.tsx packages/frontend/src/pages/files-panel.test.tsx
git commit -m "文件面板支持直传分支与进度上报"
```

---

### Task 8: 下载链接外部 URL 兼容（DownloadLinkCard / 铃铛）

**Files:**

- Modify: `packages/frontend/src/components/download-link-card.tsx`
- Modify: `packages/frontend/src/components/download-link-card.test.tsx`（如存在）
- Modify: `packages/frontend/src/components/notification-bell.tsx`（DownloadButton）

**Interfaces:**

- Consumes: Task 3（createDownloadToken alibaba 返回外部 URL）

- [ ] **Step 1: 写失败测试**

```ts
// download-link-card.test.tsx 追加
it("token.url 为外部绝对 URL 时原样渲染", async () => {
  // createDownloadToken → { url: "https://download.example/x", expiresAt: 0 }
  // 断言 link.href === "https://download.example/x"（不再拼 origin）
});

it("文案为临时链接", async () => {
  // 断言包含"临时"字样
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/components/download-link-card.test.tsx`
Expected: FAIL（当前强制拼 origin + 永久文案）

- [ ] **Step 3: 实现**

```tsx
// download-link-card.tsx：url 赋值改为
setUrl(token.url.startsWith("http") ? token.url : `${window.location.origin}${token.url}`);
// 文案："下载文件（链接临时有效，请及时下载；清理任务回收存储空间后失效）"
// notification-bell.tsx DownloadButton：anchor.href 同理兼容绝对 URL
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vcpdeck/frontend exec vitest run src/components/download-link-card.test.tsx src/components/notification-bell.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/
git commit -m "下载链接兼容外部临时 URL"
```

---

### Task 9: 全量回归 + 构建

**Files:** 无新改动（仅验证）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全部通过（shared 无测试 / server / sdk / client / frontend）。若有失败，修复后重跑。

- [ ] **Step 2: 全量构建**

Run: `pnpm build`
Expected: 全部通过。

- [ ] **Step 3: LSP 诊断**

Run: `lsp_diagnostics`（对本次改动的所有文件，serverScope primary）
Expected: 0 错误。

- [ ] **Step 4: 变更范围检查**

Run: `gitnexus_detect_changes`（scope unstaged）后提交剩余改动（如有），确认无遗漏文件。

- [ ] **Step 5: 手动验证清单（可选，需运行环境）**

- 浏览器上传 20MB 文件（alibaba 后端）→ 铃铛显示上传进度 → 远程目录出现文件
- 远程文件导出 → 浏览器直连下载成功
- 远程文件删除后重新上传同名 → PATH_CONFLICT 弹窗 → 覆盖成功
- local 后端回归：上传/导出/导入均正常
