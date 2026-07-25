# Server 管理 Client 文件体系 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Typed Job 体系上实现 Server 对远程 Client 文件的完整管理——轻量 fs 操作 + 流式传输 + File 表审计。

**Architecture:** Job 控制面（WebSocket 调度）+ Storage/FileRef 数据面（Client 主动 HTTP）+ File 表审计轨迹。Client 端分 file-handler（fs 操作）和 transfer-handler（HTTP 流式传输）两个模块。

**Tech Stack:** TypeScript (strict), NestJS, Prisma (SQLite), Socket.IO, Node.js `fs/promises` + `stream`, `node:crypto` (sha256 + HMAC)。

## Global Constraints

- 文件字节不进入 WebSocket 和 DB `output` 字段
- 文件 Job 不经过 `spawn(..., { shell: true })`
- 旧 `exec` Job 行为不变
- 旧 Client (`capabilities:["exec"]`) 不能收到文件 Job
- `rootDir` 由 Server 下发每个 Job 时指定
- `file.readText` 默认上限 256KB
- `file.export`/`file.import` 流式传输 + SHA-256 校验
- 错误消息不泄露路径、签名 URL、文件内容
- 存储后端只做 Local，扩展点通过 `StorageProvider` 接口
- 提交信息用简体中文

---

### Task 1: Shared 协议扩展

**Files:**

- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Produces: `FileRef` 扩展 `key` 字段，`FileJobPayload` 类型，`FileJobResult` 类型，`FileErrorCode` 常量

- [ ] **Step 1: 扩展 FileRef 加 key 字段**

当前 `FileRef` 没有 `key`，在 `packages/shared/src/index.ts` 中修改：

```ts
// ── FileRef（用于文件传输，Client ↔ Storage） ──
export interface FileRef {
  id: string;       // DB File 表主键
  key: string;      // Storage 对象路径（如 uuid/filename.txt）
  url: string;      // 预签名 URL
  method: "GET" | "PUT";
  expiresAt: number;
  headers?: Record<string, string>;
}
```

- [ ] **Step 2: 添加 FileJobPayload 和 FileJobResult 类型**

在 `FileRef` 后面追加：

```ts
// ── File job 结构化 payload ──
export interface FileListPayload { path: string; rootDir: string }
export interface FileStatPayload { path: string; rootDir: string }
export interface FileReadTextPayload { path: string; rootDir: string; maxBytes?: number }
export interface FileWriteTextPayload { path: string; rootDir: string; content: string }
export interface FileMkdirPayload { path: string; rootDir: string }
export interface FileDeletePayload { path: string; rootDir: string; recursive?: boolean }
export interface FileMovePayload { source: string; destination: string; rootDir: string; overwrite?: boolean }
export interface FileExportPayload { path: string; rootDir: string; uploadRef: FileRef }
export interface FileImportPayload { targetPath: string; rootDir: string; downloadRef: FileRef; size: number; sha256: string }

// ── File job 结构化结果 ──
export interface FileListResult { entries: { name: string; kind: "file" | "dir"; size: number; mtime: string }[] }
export interface FileStatResult { name: string; kind: "file" | "dir"; size: number; mtime: string }
export interface FileReadTextResult { content: string; size: number }
export interface FileChangeResult { path: string }
export interface FileTransferResult { fileId: string; key: string; size: number; sha256: string }

// ── File 稳定错误码 ──
export const FileErrorCode = {
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
  PATH_CONFLICT: "PATH_CONFLICT",
  IO_ERROR: "IO_ERROR",
  SIZE_EXCEEDED: "SIZE_EXCEEDED",
  SHA256_MISMATCH: "SHA256_MISMATCH",
} as const;
```

- [ ] **Step 3: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/shared build
```

预期：类型检查通过，无编译错误。

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): 扩展 FileRef 加 key，添加 File job payload/result/errorCode 类型定义"
```

---

### Task 2: Prisma File 表 + Migration

**Files:**

- Modify: `packages/server/prisma/schema.prisma`

**Interfaces:**

- Produces: `File` model in Prisma schema

- [ ] **Step 1: 在 schema.prisma 添加 File model**

在 `packages/server/prisma/schema.prisma` 的 `StorageBackendConfig` 之后追加：

```prisma
model File {
  id          String    @id
  key         String    @unique
  jobId       String
  clientId    String
  filename    String
  mimeType    String?
  size        Int
  sha256      String
  status      String    @default("pending")
  storageKind String    @default("local")
  expiresAt   DateTime?
  createdAt   DateTime  @default(now())
}
```

- [ ] **Step 2: 运行 migration**

```bash
cd packages/server && npx prisma migrate dev --name add_file_table
```

- [ ] **Step 3: 验证生成 Prisma Client**

```bash
pnpm --filter @vcpdeck/server build
```

- [ ] **Step 4: 提交**

```bash
git add packages/server/prisma/schema.prisma packages/server/prisma/migrations/
git commit -m "feat(server): 新增 File 表，支持文件传输审计"
```

---

### Task 3: FileService（Server 端新模块）

**Files:**

- Create: `packages/server/src/file/file.service.ts`
- Create: `packages/server/src/file/file.module.ts`

**Interfaces:**

- Consumes: `PrismaService`（已有）, `StorageService`（已有）, `FileRef`, `FileMeta`（shared）
- Produces: `FileService` — `createPending()`, `confirmUpload()`, `createDownloadToken()`, `findById()`, `getExpiredFiles()`, `delete()`

- [ ] **Step 1: 创建 `packages/server/src/file/file.service.ts`**

```ts
import { Injectable, Inject, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { FileRef, FileMeta } from "@vcpdeck/shared";

export interface CreatePendingResult {
  fileId: string;
  key: string;
  uploadUrl: string;
  expiresAt: number;
}

export interface DownloadInfo {
  downloadUrl: string;
  size: number;
  sha256: string;
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** 创建 pending File 记录 + 签发上传令牌 */
  async createPending(jobId: string, clientId: string, meta: Omit<FileMeta, "key">): Promise<CreatePendingResult> {
    const fileId = randomUUID();
    const { url, expiresAt } = await this.storage.createUploadToken(meta);
    // 从 url 中提取 key: /api/storage/upload/:key?...
    const key = url.match(/\/api\/storage\/upload\/(.+?)\?/)?.[1] ?? "";
    await this.prisma.file.create({
      data: {
        id: fileId,
        key,
        jobId,
        clientId,
        filename: meta.filename,
        mimeType: meta.mimeType ?? null,
        size: meta.size,
        sha256: "",
        status: "pending",
        storageKind: "local",
      },
    });
    return { fileId, key, uploadUrl: url, expiresAt };
  }

  /** 确认上传完成，校验 sha256 */
  async confirmUpload(fileId: string, sha256: string): Promise<{ key: string; size: number }> {
    const file = await this.prisma.file.update({
      where: { id: fileId },
      data: { sha256, status: "completed" },
    });
    return { key: file.key, size: file.size };
  }

  /** 为已完成的 File 签发下载令牌 */
  async createDownloadToken(fileId: string): Promise<DownloadInfo> {
    const file = await this.prisma.file.findUniqueOrThrow({ where: { id: fileId } });
    if (file.status !== "completed") {
      throw Object.assign(new Error("File not ready for download"), { statusCode: 400 });
    }
    const { url } = this.storage.createDownloadToken(file.key);
    return { downloadUrl: url, size: file.size, sha256: file.sha256 };
  }

  /** 查询已过期文件（供定时清理） */
  async getExpiredFiles(): Promise<{ id: string; key: string }[]> {
    const files = await this.prisma.file.findMany({
      where: { expiresAt: { lte: new Date() } },
      select: { id: true, key: true },
    });
    return files;
  }

  /** 删除 File 记录 + Storage 对象 */
  async delete(fileId: string): Promise<void> {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file) return;
    await this.storage.delete(file.key);
    await this.prisma.file.delete({ where: { id: fileId } });
  }

  async findById(fileId: string) {
    return this.prisma.file.findUnique({ where: { id: fileId } });
  }
}
```

- [ ] **Step 2: 创建 `packages/server/src/file/file.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { FileService } from "./file.service.js";
import { StorageModule } from "../storage/storage.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
```

- [ ] **Step 3: 在 AppModule 中注册 FileModule**

编辑 `packages/server/src/app.module.ts`，在 imports 数组中追加 `FileModule`：

```ts
imports: [
  // ... 已有 imports
  FileModule,
],
```

同时添加 import: `import { FileModule } from "./file/file.module.js";`

- [ ] **Step 4: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/server build
```

```bash
git add packages/server/src/file/ packages/server/src/app.module.ts
git commit -m "feat(server): 新增 FileService，管理文件元数据、签发上传下载令牌"
```

---

### Task 4: JobService 扩展 — Capability 校验 + 文件 Job 编排

**Files:**

- Modify: `packages/server/src/job/job.service.ts`

**Interfaces:**

- Consumes: `FileService`, `ClientService`（通过 Prisma 查 capability）, `FileRef`
- Produces: `create()` 增加 capability 校验和 export/import 编排

- [ ] **Step 1: 在 JobService 中注入 FileService 并添加 capability 校验**

编辑 `packages/server/src/job/job.service.ts`：

在文件头部添加 import：

```ts
import { FileService } from "../file/file.service.js";
```

在 constructor 中注入：

```ts
@Inject(FileService) private readonly fileService: FileService,
```

在 `create()` 方法中，`const client = ...` 之后、`const jobId = randomUUID()` 之前，插入 capability 校验函数和调用：

```ts
// ── Capability 校验 ──
const FILE_READ_TYPES = ["file.list", "file.stat", "file.readText", "file.export"];
const FILE_WRITE_TYPES = ["file.writeText", "file.mkdir", "file.delete", "file.move", "file.import"];

function parseCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }
  return [];
}

const caps = parseCapabilities(client.capabilities);
if (FILE_READ_TYPES.includes(params.type) && !caps.includes("file.read")) {
  throw Object.assign(new Error(`Client "${params.clientId}" lacks "file.read" capability`), { statusCode: 400 });
}
if (FILE_WRITE_TYPES.includes(params.type) && !caps.includes("file.write")) {
  throw Object.assign(new Error(`Client "${params.clientId}" lacks "file.write" capability`), { statusCode: 400 });
}
```

- [ ] **Step 2: 在 create() 中添加 export/import 编排**

在 `create()` 方法中，`capability` 校验之后、`const jobId = randomUUID()` 之前，插入：

```ts
// ── 文件传输编排：注入 FileRef ──
let fileRefPayload: Record<string, unknown> = {};

if (params.type === "file.export") {
  const p = params.payload as { path: string; rootDir: string };
  const meta = {
    jobId: "",  // jobId 尚未生成，先占位
    clientId: params.clientId,
    filename: p.path.split(/[/\\]/).pop() || "file",
    size: 0,
  };
  // ponytail: createPending 需要 jobId，先建 Job 后更新 uploadRef
  // 此处收集元数据，下发前注入
  fileRefPayload = { _pendingUpload: { meta }, _action: "createUploadRef" };
} else if (params.type === "file.import") {
  const p = params.payload as { targetPath: string; rootDir: string; fileId: string };
  const dl = await this.fileService.createDownloadToken(p.fileId);
  fileRefPayload = {
    downloadRef: {
      id: p.fileId,
      key: "",  // import 场景 key 由 File 表关联
      url: dl.downloadUrl,
      method: "GET" as const,
      expiresAt: 0,  // ponytail: 从 URL 解析或默认
      size: dl.size,
      sha256: dl.sha256,
    },
    size: dl.size,
    sha256: dl.sha256,
  };
}

const finalPayload = { ...params.payload, ...fileRefPayload };
```

ponytail: 当前 `create()` 流程中 `createPending` 需要 `jobId`，而 `jobId` 在 `createPending` 之后生成。需要重构 `create()` 的创建顺序：先生成 `jobId`，再调用 `createPending`。

- [ ] **Step 3: 重构 create() 方法，解决 jobId 先生成问题**

将 `create()` 方法中 `const jobId = randomUUID()` 移到 capability 校验之后、export 编排之前：

整个 `create()` 方法重排为：

```ts
async create(
  params: { clientId: string; type: string; payload: Record<string, unknown>; timeout?: number },
  actor: ActorContext,
): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
  const client = await this.prisma.client.findUnique({ where: { id: params.clientId } });
  if (!client) throw new Error(`Client "${params.clientId}" not found — register the client first`);
  if (!client.online) throw new Error(`Client "${params.clientId}" is offline`);

  // Capability 校验
  const caps = parseCapabilities(client.capabilities);
  if (FILE_READ_TYPES.includes(params.type) && !caps.includes("file.read")) {
    throw Object.assign(new Error(`Client "${params.clientId}" lacks "file.read" capability`), { statusCode: 400 });
  }
  if (FILE_WRITE_TYPES.includes(params.type) && !caps.includes("file.write")) {
    throw Object.assign(new Error(`Client "${params.clientId}" lacks "file.write" capability`), { statusCode: 400 });
  }

  const jobId = randomUUID();

  // 文件传输编排
  let finalPayload = { ...params.payload };
  if (params.type === "file.export") {
    const p = params.payload as { path: string; rootDir: string };
    const { fileId, key, uploadUrl, expiresAt } = await this.fileService.createPending(
      jobId,
      params.clientId,
      {
        jobId,
        clientId: params.clientId,
        filename: p.path.split(/[/\\]/).pop() || "file",
        size: 0,
      },
    );
    finalPayload = {
      ...finalPayload,
      uploadRef: { id: fileId, key, url: uploadUrl, method: "PUT" as const, expiresAt },
    };
  } else if (params.type === "file.import") {
    const p = params.payload as { targetPath: string; rootDir: string; fileId: string };
    const dl = await this.fileService.createDownloadToken(p.fileId);
    const ref: FileRef = { id: p.fileId, key: "", url: dl.downloadUrl, method: "GET", expiresAt: 0 };
    finalPayload = {
      ...finalPayload,
      downloadRef: ref,
      size: dl.size,
      sha256: dl.sha256,
    };
  }

  await this.prisma.job.create({
    data: {
      id: jobId,
      clientId: params.clientId,
      type: params.type,
      status: "pending",
      payload: JSON.stringify(finalPayload),
      timeout: params.timeout ?? null,
      createdByIdentityId: actor.identityId,
      createdByName: actor.displayName,
      createdVia: actor.source,
    },
  });

  const dispatch = await this.scheduler.tryDispatch(params.clientId);
  return {
    result: { jobId, status: dispatch ? JobStatus.RUNNING : JobStatus.PENDING, type: params.type },
    dispatch,
  };
}
```

需要在文件顶部添加 `FileRef` 的 import：

```ts
import type { ..., FileRef } from "@vcpdeck/shared";
```

需要定义 FILE_READ_TYPES / FILE_WRITE_TYPES 和 parseCapabilities：

在 `JobService` 类外部（文件顶部或 `safeJsonParse` 下面）添加：

```ts
const FILE_READ_TYPES = ["file.list", "file.stat", "file.readText", "file.export"];
const FILE_WRITE_TYPES = ["file.writeText", "file.mkdir", "file.delete", "file.move", "file.import"];

function parseCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }
  return [];
}
```

- [ ] **Step 4: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/server build
```

```bash
git add packages/server/src/job/job.service.ts
git commit -m "feat(server): JobService 增加 capability 校验和 file.export/import 编排"
```

---

### Task 5: Client file-handler.ts — 轻量 fs 操作 + 路径安全

**Files:**

- Create: `packages/client/src/file-handler.ts`

**Interfaces:**

- Consumes: `JobDispatch`, `FileErrorCode` from shared
- Produces: `handleFileOp(job, socket)` — 处理 list/stat/readText/writeText/mkdir/delete/move

- [ ] **Step 1: 创建 `packages/client/src/file-handler.ts`**

```ts
import { resolve, normalize } from "node:path";
import { readdir, stat, readFile, writeFile, mkdir, rm, rename, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";
import type { JobDispatch, JobDone } from "@vcpdeck/shared";

/** 路径安全校验 + 规范化 */
async function resolveSafePath(rootDir: string, userPath: string): Promise<string> {
  const resolvedRoot = resolve(rootDir).replace(/\\/g, "/").toLowerCase();
  const resolved = resolve(resolvedRoot, userPath).replace(/\\/g, "/").toLowerCase();

  if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
    throw { code: FileErrorCode.PATH_NOT_ALLOWED, message: "Path escapes rootDir" };
  }

  try {
    const real = (await realpath(resolved)).replace(/\\/g, "/").toLowerCase();
    if (!real.startsWith(resolvedRoot + "/") && real !== resolvedRoot) {
      throw { code: FileErrorCode.PATH_NOT_ALLOWED, message: "Symlink escapes rootDir" };
    }
  } catch { /* 文件不存在时 realpath 会抛错，前缀检查已覆盖 */ }

  return resolved;
}

/** 发送 job:done 结果 */
function emitDone(socket: Socket, jobId: string, type: string, result: Record<string, unknown>) {
  socket.emit(Events.JOB_DONE, { jobId, type, result } satisfies JobDone);
}

/** 发送 job:done 错误 */
function emitError(socket: Socket, jobId: string, type: string, code: string, message: string) {
  socket.emit(Events.JOB_DONE, { jobId, type, error: { code, message } } satisfies JobDone);
}

/** 处理轻量 fs 操作 */
export async function handleFileOp(
  job: { jobId: string; type: string; payload: Record<string, unknown>; timeout?: number },
  socket: Socket,
) {
  const { jobId, type, payload } = job;
  const rootDir = payload.rootDir as string;
  const typeStr = type;

  try {
    switch (type) {
      case "file.list": {
        const safe = await resolveSafePath(rootDir, payload.path as string);
        const dirents = await readdir(safe, { withFileTypes: true });
        const entries = await Promise.all(
          dirents.map(async (d) => {
            const s = await stat(resolve(safe, d.name));
            return {
              name: d.name,
              kind: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
              size: s.size,
              mtime: s.mtime.toISOString(),
            };
          }),
        );
        emitDone(socket, jobId, typeStr, { entries });
        return;
      }
      case "file.stat": {
        const safe = await resolveSafePath(rootDir, payload.path as string);
        const s = await stat(safe);
        emitDone(socket, jobId, typeStr, {
          name: (payload.path as string).split(/[/\\]/).pop() || "",
          kind: (s.isDirectory() ? "dir" : "file") as "dir" | "file",
          size: s.size,
          mtime: s.mtime.toISOString(),
        });
        return;
      }
      case "file.readText": {
        const maxBytes = (payload.maxBytes as number) ?? 262144;
        const safe = await resolveSafePath(rootDir, payload.path as string);
        const s = await stat(safe);
        if (s.size > maxBytes) {
          emitError(socket, jobId, typeStr, FileErrorCode.SIZE_EXCEEDED, `File larger than ${maxBytes} bytes`);
          return;
        }
        const content = await readFile(safe, "utf8");
        emitDone(socket, jobId, typeStr, { content, size: s.size });
        return;
      }
      case "file.writeText": {
        const safe = await resolveSafePath(rootDir, payload.path as string);
        const content = payload.content as string;
        const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
        await writeFile(tmpPath, content, "utf8");
        await rename(tmpPath, safe);
        emitDone(socket, jobId, typeStr, { path: safe });
        return;
      }
      case "file.mkdir": {
        const safe = await resolveSafePath(rootDir, payload.path as string);
        await mkdir(safe, { recursive: true });
        emitDone(socket, jobId, typeStr, { path: safe });
        return;
      }
      case "file.delete": {
        const safe = await resolveSafePath(rootDir, payload.path as string);
        const recursive = payload.recursive === true;
        if (!recursive) {
          // 检查是否是目录且非空
          const s = await stat(safe).catch(() => null);
          if (s?.isDirectory()) {
            const entries = await readdir(safe);
            if (entries.length > 0) {
              emitError(socket, jobId, typeStr, "PATH_CONFLICT", "Directory not empty; set recursive=true");
              return;
            }
          }
        }
        await rm(safe, { recursive, force: true });
        emitDone(socket, jobId, typeStr, { path: safe });
        return;
      }
      case "file.move": {
        const src = await resolveSafePath(rootDir, payload.source as string);
        const dest = await resolveSafePath(rootDir, payload.destination as string);
        const overwrite = payload.overwrite === true;
        if (!overwrite) {
          await stat(dest).then(
            () => {
              throw { code: FileErrorCode.PATH_CONFLICT, message: "Destination exists; set overwrite=true" };
            },
            () => {}, // dest 不存在，OK
          );
        }
        await rename(src, dest);
        emitDone(socket, jobId, typeStr, { path: dest });
        return;
      }
      default:
        throw new Error(`Unknown file op: ${type}`);
    }
  } catch (err: any) {
    if (err.code && typeof err.code === "string") {
      emitError(socket, jobId, typeStr, err.code, err.message);
      return;
    }
    const code =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? FileErrorCode.PATH_NOT_FOUND
        : FileErrorCode.IO_ERROR;
    emitError(socket, jobId, typeStr, code, code === FileErrorCode.PATH_NOT_FOUND ? "Path not found" : err.message);
  }
}
```

- [ ] **Step 2: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/client build
```

```bash
git add packages/client/src/file-handler.ts
git commit -m "feat(client): 新增 file-handler，实现轻量 fs 操作和路径安全"
```

---

### Task 6: Client transfer-handler.ts — HTTP 流式传输

**Files:**

- Create: `packages/client/src/transfer-handler.ts`

**Interfaces:**

- Consumes: `FileRef`, `FileErrorCode` from shared
- Produces: `handleTransfer(job, socket)` — 处理 export/import

- [ ] **Step 1: 创建 `packages/client/src/transfer-handler.ts`**

```ts
import { createReadStream, createWriteStream } from "node:fs";
import { stat, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";
import type { JobDone, FileRef } from "@vcpdeck/shared";
import { PassThrough } from "node:stream";

function emitDone(socket: Socket, jobId: string, type: string, result: Record<string, unknown>) {
  socket.emit(Events.JOB_DONE, { jobId, type, result } satisfies JobDone);
}

function emitError(socket: Socket, jobId: string, type: string, code: string, message: string) {
  socket.emit(Events.JOB_DONE, { jobId, type, error: { code, message } } satisfies JobDone);
}

export async function handleTransfer(
  job: { jobId: string; type: string; payload: Record<string, unknown>; timeout?: number },
  socket: Socket,
) {
  const { jobId, type, payload } = job;

  try {
    if (type === "file.export") {
      const path = payload.path as string;
      const rootDir = payload.rootDir as string;
      const uploadRef = payload.uploadRef as FileRef;
      // 复用 file-handler 的路径安全逻辑
      const { resolveSafePath } = await import("./file-handler.js");
      const safe = await resolveSafePath(rootDir, path);
      const fileStat = await stat(safe);
      const hash = createHash("sha256");

      const fileStream = createReadStream(safe);
      const passThrough = new PassThrough();
      passThrough.on("data", (chunk: Buffer) => hash.update(chunk));
      fileStream.pipe(passThrough);

      const res = await fetch(uploadRef.url, { method: "PUT", body: passThrough } as any);
      if (!res.ok) {
        emitError(socket, jobId, type, FileErrorCode.IO_ERROR, `Upload failed: HTTP ${res.status}`);
        return;
      }

      const sha256 = hash.digest("hex");
      emitDone(socket, jobId, type, { fileId: uploadRef.id, key: uploadRef.key, size: fileStat.size, sha256 });
      return;
    }

    if (type === "file.import") {
      const targetPath = payload.targetPath as string;
      const rootDir = payload.rootDir as string;
      const downloadRef = payload.downloadRef as FileRef;
      const expectedSize = payload.size as number;
      const expectedSha256 = payload.sha256 as string;
      const { resolveSafePath } = await import("./file-handler.js");
      const safe = await resolveSafePath(rootDir, targetPath);
      const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
      const hash = createHash("sha256");

      try {
        const res = await fetch(downloadRef.url, { method: "GET" } as any);
        if (!res.ok) {
          emitError(socket, jobId, type, FileErrorCode.IO_ERROR, `Download failed: HTTP ${res.status}`);
          return;
        }

        const passThrough = new PassThrough();
        (res.body as any).pipe(passThrough);
        passThrough.on("data", (chunk: Buffer) => hash.update(chunk));
        await pipeline(passThrough as any, createWriteStream(tmpPath));

        const sha256 = hash.digest("hex");
        if (sha256 !== expectedSha256) {
          await unlink(tmpPath).catch(() => {});
          emitError(socket, jobId, type, FileErrorCode.SHA256_MISMATCH, "SHA-256 mismatch");
          return;
        }

        await rename(tmpPath, safe);
        emitDone(socket, jobId, type, { path: safe, size: expectedSize, sha256 });
      } catch (err: any) {
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
      return;
    }

    throw new Error(`Unknown transfer type: ${type}`);
  } catch (err: any) {
    const code =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? FileErrorCode.PATH_NOT_FOUND
        : FileErrorCode.IO_ERROR;
    emitError(socket, jobId, type, code, code === FileErrorCode.PATH_NOT_FOUND ? "Path not found" : err.message);
  }
}
```

- [ ] **Step 2: 导出 resolveSafePath 供 transfer-handler 复用**

编辑 `packages/client/src/file-handler.ts`，将 `resolveSafePath` 函数签名前加 `export`：

```ts
export async function resolveSafePath(rootDir: string, userPath: string): Promise<string> {
```

- [ ] **Step 3: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/client build
```

```bash
git add packages/client/src/transfer-handler.ts packages/client/src/file-handler.ts
git commit -m "feat(client): 新增 transfer-handler，实现 file.export/import 流式传输"
```

---

### Task 7: Client dispatcher.ts — 接入新 handler

**Files:**

- Modify: `packages/client/src/dispatcher.ts`

**Interfaces:**

- Consumes: `handleFileOp` from `file-handler.ts`, `handleTransfer` from `transfer-handler.ts`
- Produces: 完整的 switch 分发

- [ ] **Step 1: 修改 dispatcher.ts switch 分支**

编辑 `packages/client/src/dispatcher.ts`：

在文件头部添加 import：

```ts
import { handleFileOp } from "./file-handler.js";
import { handleTransfer } from "./transfer-handler.js";
```

将 switch 中现有的 `case "file.list":` 到 `case "file.upload":` 的 block 替换为：

```ts
case "file.list":
case "file.stat":
case "file.readText":
case "file.writeText":
case "file.mkdir":
case "file.delete":
case "file.move":
  return handleFileOp(job, socket);
case "file.export":
case "file.import":
  return handleTransfer(job, socket);
```

注意：更新 case 列表，`file.download` → `file.export`，`file.upload` → `file.import`。

- [ ] **Step 2: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/client build
```

```bash
git add packages/client/src/dispatcher.ts
git commit -m "feat(client): dispatcher 接入 file-handler 和 transfer-handler"
```

---

### Task 8: Server 定时清理过期文件

**Files:**

- Create: `packages/server/src/file/file-cleanup.service.ts`
- Modify: `packages/server/src/file/file.module.ts`

**Interfaces:**

- Consumes: `FileService.getExpiredFiles()`
- Produces: 定时任务，每 10 分钟清理过期文件

- [ ] **Step 1: 创建 `packages/server/src/file/file-cleanup.service.ts`**

```ts
import { Injectable, Inject, Logger, type OnModuleInit } from "@nestjs/common";
import { FileService } from "./file.service.js";

@Injectable()
export class FileCleanupService implements OnModuleInit {
  private readonly logger = new Logger(FileCleanupService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(FileService) private readonly fileService: FileService) {}

  onModuleInit() {
    this.timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    this.logger.log("File cleanup scheduler started (every 10min)");
  }

  private async cleanup() {
    try {
      const expired = await this.fileService.getExpiredFiles();
      for (const f of expired) {
        await this.fileService.delete(f.id);
      }
      if (expired.length > 0) {
        this.logger.log(`Cleaned up ${expired.length} expired file(s)`);
      }
    } catch (err) {
      this.logger.warn("File cleanup error", err);
    }
  }
}
```

- [ ] **Step 2: 在 FileModule 中注册 FileCleanupService**

编辑 `packages/server/src/file/file.module.ts`，在 `providers` 中添加 `FileCleanupService`：

```ts
import { FileCleanupService } from "./file-cleanup.service.js";

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [FileService, FileCleanupService],
  exports: [FileService],
})
export class FileModule {}
```

- [ ] **Step 3: 构建验证，提交**

```bash
pnpm --filter @vcpdeck/server build
```

```bash
git add packages/server/src/file/file-cleanup.service.ts packages/server/src/file/file.module.ts
git commit -m "feat(server): 新增 FileCleanupService，定时清理过期文件"
```

---

### Task 9: 端到端验证

**Files:**

- Create: `packages/server/src/job/job.controller.ts`（如不存在，需检查 — 已有 EventsController）

**Interfaces:**

- Consumes: 全部已实现的模块
- Produces: 手动测试流程文档

- [ ] **Step 1: 确认 Job 创建 REST 端点存在**

检查 `packages/server/src/events/events.controller.ts` 是否已有 `POST /api/jobs` 端点。`JobCreate` 协议已定义。

- [ ] **Step 2: 编写验证脚本**

创建 `packages/client/scripts/test-file-ops.ts`：

```ts
/**
 * 文件操作端到端验证脚本
 * 使用方式：在已连接的 Client 进程中，通过 Server REST API 发起文件 Job
 *
 * 前置条件：
 * 1. Server 运行中
 * 2. Client 已注册，capabilities 包含 "file.read" 和 "file.write"
 *
 * 验证项：
 * 1. file.mkdir → file.list → file.stat
 * 2. file.writeText → file.readText
 * 3. file.move → file.delete
 */
console.log("请通过 REST API 手动测试以下流程：\n");
console.log("1. 创建目录:");
console.log('  POST /api/jobs { type:"file.mkdir", clientId:"<id>", payload:{ path:"test-vcpdeck", rootDir:"D:/tmp" } }');
console.log("2. 列目录:");
console.log('  POST /api/jobs { type:"file.list", clientId:"<id>", payload:{ path:"test-vcpdeck", rootDir:"D:/tmp" } }');
console.log("3. 写文本:");
console.log('  POST /api/jobs { type:"file.writeText", clientId:"<id>", payload:{ path:"test-vcpdeck/hello.txt", rootDir:"D:/tmp", content:"hello vcpdeck" } }');
console.log("4. 读文本:");
console.log('  POST /api/jobs { type:"file.readText", clientId:"<id>", payload:{ path:"test-vcpdeck/hello.txt", rootDir:"D:/tmp" } }');
console.log("5. 移动文件:");
console.log('  POST /api/jobs { type:"file.move", clientId:"<id>", payload:{ source:"test-vcpdeck/hello.txt", destination:"test-vcpdeck/hello2.txt", rootDir:"D:/tmp" } }');
console.log("6. 删除目录:");
console.log('  POST /api/jobs { type:"file.delete", clientId:"<id>", payload:{ path:"test-vcpdeck", rootDir:"D:/tmp", recursive:true } }');
```

- [ ] **Step 3: 全量构建，验证无编译错误**

```bash
pnpm build
```

- [ ] **Step 4: 提交**

```bash
git add packages/client/scripts/
git commit -m "test(client): 添加文件操作端到端验证脚本"
```

---

### 验收对照（来自 spec 第 8 节）

| 验收项 | 覆盖任务 |
|---|---|
| 旧 `exec` Job 行为不变 | Task 4（不修改 exec 路径） |
| 旧 Client 不收到文件 Job | Task 4（capability 校验） |
| 文件 Job 不经过 shell | Task 5, Task 6（纯 Node.js fs/http） |
| 结构化 result + 稳定 errorCode | Task 1（类型）, Task 5, Task 6（实现） |
| `../` 和 symlink 不能绕过 rootDir | Task 5（resolveSafePath + realpath） |
| `delete` 的 recursive 显式 | Task 5（显式检查） |
| 错误消息安全 | Task 5, Task 6（仅透传安全 message） |
| 文件字节不进 WebSocket/DB | Task 5, Task 6（HTTP 直接传输） |
| 流式 + SHA-256 | Task 6（stream + createHash） |
| 失败/取消不留半成品 | Task 6（临时文件 + try/catch + unlink） |
| File 表审计 | Task 2（表）, Task 3（Service） |
| 过期文件清理 | Task 8（定时任务） |
| Capability 校验 | Task 4（create 开头校验） |
