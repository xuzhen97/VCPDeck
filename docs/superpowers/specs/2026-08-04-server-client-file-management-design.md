# Server 管理 Client 文件体系 — 设计文档

> 状态：已确认，待实现
>
> 参考：[README.md](../../README.md)、[job-file-management-recommendations.md](../../job-file-management-recommendations.md)

## 1. 设计目标

在现有 Typed Job 体系上，实现 Server 对远程 Client 文件的完整管理能力：

- 轻量文件操作（list/stat/readText/writeText/mkdir/delete/move）
- 大文件流式传输（export/import，通过 Storage + FileRef）
- 全链路审计（File 表、结构化结果、稳定错误码）
- 路径安全（rootDir 约束、逃逸防护）
- 存储后端只做 Local，扩展点留好

## 2. 架构总览

```
                    Server
               ┌──────────────────────────────┐
  Frontend/Pi ─│  JobService   (控制面)         │── WebSocket ── Client
               │  FileService  (元数据 + 签发)   │
               │  StorageSvc   (数据面, 字节)    │── HTTP ─────── Client (主动)
               │  Prisma(DB)                   │
               └──────────────────────────────┘
```

核心原则：

- **Job = 控制面**：调度、审计、状态、结构化结果
- **Storage/FileRef = 数据面**：文件字节流，Client 主动 HTTP
- **File 表 = 审计轨迹**：每次传输可追溯
- **WebSocket 只传指令和元数据，不传文件内容**

## 3. Shared 协议

### 3.1 JobType（已更新）

```ts
export enum JobType {
  EXEC = "exec",
  // 轻量 fs 操作
  FILE_LIST = "file.list",
  FILE_STAT = "file.stat",
  FILE_READ_TEXT = "file.readText",
  FILE_WRITE_TEXT = "file.writeText",
  FILE_MKDIR = "file.mkdir",
  FILE_DELETE = "file.delete",
  FILE_MOVE = "file.move",
  // 流式传输（改名：export=从 Client 拉出, import=往 Client 推入）
  FILE_EXPORT = "file.export",
  FILE_IMPORT = "file.import",
  // Agent（后续）
  AGENT_RUN = "agent.run",
}
```

### 3.2 各操作 payload（Server → Client）

每个 file Job 的 `payload` 必须包含 `rootDir: string`：

| type | payload |
|---|---|
| `file.list` | `{ path: string, rootDir: string }` |
| `file.stat` | `{ path: string, rootDir: string }` |
| `file.readText` | `{ path: string, rootDir: string, maxBytes?: number }` — 默认 262144 |
| `file.writeText` | `{ path: string, rootDir: string, content: string }` |
| `file.mkdir` | `{ path: string, rootDir: string }` |
| `file.delete` | `{ path: string, rootDir: string, recursive?: boolean }` |
| `file.move` | `{ source: string, destination: string, rootDir: string, overwrite?: boolean }` |
| `file.export` | `{ path: string, rootDir: string, uploadRef: FileRef & { key: string } }` — Client PUT 到 Storage |
| `file.import` | `{ targetPath: string, rootDir: string, downloadRef: FileRef & { key: string }, size: number, sha256: string }` |

> `FileRef` 需扩展 `key` 字段（Storage 对象路径），见 3.6 节。

### 3.3 结构化结果（Client → Server）

```ts
type FileListResult = { entries: { name: string; kind: "file"|"dir"; size: number; mtime: string }[] };
type FileStatResult = { name: string; kind: "file"|"dir"; size: number; mtime: string };
type FileReadTextResult = { content: string; size: number };
type FileWriteTextResult = { path: string };
type FileTransferResult = { fileId: string; key: string; size: number; sha256: string };
type FileChangeResult = { path: string };
```

### 3.4 稳定错误码

```ts
const FileErrorCode = {
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
  PATH_CONFLICT: "PATH_CONFLICT",
  IO_ERROR: "IO_ERROR",
  SIZE_EXCEEDED: "SIZE_EXCEEDED",
  SHA256_MISMATCH: "SHA256_MISMATCH",
} as const;
```

### 3.6 FileRef 扩展

```ts
export interface FileRef {
  id: string;       // fileId（DB File 表主键）
  key: string;      // Storage 对象路径
  url: string;      // 预签名 URL
  method: "GET" | "PUT";
  expiresAt: number;
  headers?: Record<string, string>;
}
```

### 3.5 Capability 字符串

```ts
// Client 注册时声明
capabilities: ["exec", "file.read", "file.write", "agent.pi"]
```

- `file.read`：允许 `list` / `stat` / `readText` / `export`
- `file.write`：允许 `writeText` / `mkdir` / `delete` / `move` / `import`

## 4. 数据库（Prisma）

### 4.1 新增 File 表

```prisma
model File {
  id          String    @id
  key         String    @unique     // Storage 中的对象 key
  jobId       String                  // 关联 Job
  clientId    String                  // 关联 Client
  filename    String
  mimeType    String?
  size        Int
  sha256      String
  status      String    @default("pending")  // pending | completed
  storageKind String    @default("local")
  expiresAt   DateTime?                // 过期后定时清理
  createdAt   DateTime  @default(now())
}
```

### 4.2 现有 Job 表

无需改动，已有 `type`/`payload`/`result`/`errorCode`/`errorMessage` 列。

## 5. Server 侧

### 5.1 FileService（新增）

```
FileService
├── createPending(jobId, clientId, meta) → File + uploadToken
│    创建 pending 状态的 File 记录，调用 StorageService.createUploadToken()
├── confirmUpload(fileId, sha256) → File
│    校验 sha256，标记 completed
├── createDownloadToken(fileId) → FileRef + downloadInfo
│    仅对 completed 的 File 签发预签名 GET URL
├── findById(fileId) → File | null
├── getExpiredFiles() → File[]
└── delete(fileId)
```

关键点：

- File 记录在签发上传令牌时就创建，状态 `pending`
- `confirmUpload` 校验 sha256 后→`completed`
- 只有 `completed` 的 File 才能签发下载 URL

### 5.2 JobService 扩展 — 文件 Job 编排

**`file.export`（从 Client 拉文件）：**

```text
1. POST /api/jobs { type:"file.export", clientId, payload:{path,rootDir} }
2. JobService.create():
   a. 校验 capability "file.read"
   b. FileService.createPending() → { fileId, uploadUrl }
   c. dispatch.payload.uploadRef = { url: uploadUrl, expiresAt, fileId }
   d. DB: Job { type:"file.export", payload:{path,rootDir,uploadRef} }
3. ClientGateway.sendDispatch() → WebSocket
4. Client PUT 文件 → Storage
5. Client emit job:done { type:"file.export", result:{fileId,key,size,sha256} }
6. Server handleJobDone():
   a. FileService.confirmUpload(fileId, sha256)
   b. Job → done, 记录 result
```

**`file.import`（往 Client 推文件）：**

```text
1. 调用者先 POST /api/storage/upload-token → PUT 上传源文件到 Server Storage → fileId
2. POST /api/jobs { type:"file.import", clientId, payload:{targetPath,rootDir,fileId} }
3. JobService.create():
   a. 校验 capability "file.write"
   b. FileService.createDownloadToken(fileId) → { downloadUrl, size, sha256 }
   c. dispatch.payload.downloadRef = { url: downloadUrl, expiresAt, size, sha256 }
4. ClientGateway.sendDispatch() → WebSocket
5. Client GET → 临时文件 → rename
6. Client emit job:done { type:"file.import", result:{path,size,sha256} }
```

**轻量 fs 操作（list/stat/readText/writeText/mkdir/delete/move）：**

```text
1. POST /api/jobs { type:"file.*", clientId, payload:{path,rootDir,...} }
2. JobService.create():
   a. 校验 capability
   b. 直接 dispatch payload（不需要 Storage 介入）
3. Client 执行 → emit job:done { result }
```

### 5.3 Capability 校验

```ts
const FILE_READ_TYPES = ["file.list", "file.stat", "file.readText", "file.export"];
const FILE_WRITE_TYPES = ["file.writeText", "file.mkdir", "file.delete", "file.move", "file.import"];

function checkCapability(requiredCap: string, client: { capabilities: string[] }) {
  const caps = typeof client.capabilities === "string"
    ? JSON.parse(client.capabilities)
    : client.capabilities;
  return (caps as string[]).includes(requiredCap);
}
```

在 `JobService.create()` 开头执行，失败抛错不创建 Job。

### 5.4 ClientGateway

- `sendDispatch`: 已有 generic type+payload 分支，`file.*` 类型走通用路径
- `handleJobDone`: 已有 non-exec 的 result 处理分支
- 无需新增 WebSocket 事件

### 5.5 定时清理

Server 启动时注册定时任务（如每 10 分钟）：

```
FileService.getExpiredFiles() → 逐条 StorageService.delete(key) → 删除 File 记录
```

## 6. Client 侧

### 6.1 文件结构

```
packages/client/src/
├── file-handler.ts      # 轻量 fs 操作 + 路径安全
└── transfer-handler.ts  # HTTP 流式 export/import
```

### 6.2 file-handler.ts — 轻量 fs 操作

处理 `list` / `stat` / `readText` / `writeText` / `mkdir` / `delete` / `move`。

**`resolveSafePath(rootDir, userPath)` 路径安全：**

```ts
import { resolve, normalize } from "node:path";
import { realpath } from "node:fs/promises";

async function resolveSafePath(rootDir: string, userPath: string): Promise<string> {
  const resolvedRoot = resolve(rootDir);
  const resolved = resolve(resolvedRoot, userPath);

  // 1. 规范化后检查前缀
  if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
    throw { code: "PATH_NOT_ALLOWED", message: "Path escapes rootDir" };
  }

  // 2. realpath 防 symlink 逃逸（仅在文件已存在时有效）
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(resolvedRoot + "/") && real !== resolvedRoot) {
      throw { code: "PATH_NOT_ALLOWED", message: "Symlink escapes rootDir" };
    }
  } catch {
    // 文件不存在时 realpath 会抛错，忽略
    if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
      throw { code: "PATH_NOT_ALLOWED", message: "Path escapes rootDir" };
    }
  }

  return resolved;
}
```

Windows 兼容：`startsWith` 的大小写和反斜杠需统一转小写+正斜杠后再比较。

**各操作：**

| 操作 | 实现 |
|---|---|
| `file.list` | `fs.readdir(path, { withFileTypes })`, stat 每个条目 |
| `file.stat` | `fs.stat(path)` → name/kind/size/mtime |
| `file.readText` | 先 stat 检查 size ≤ maxBytes，超限→`SIZE_EXCEEDED`；通过后 `fs.readFile(path, 'utf8')` |
| `file.writeText` | 先写临时文件 `.vcpdeck-tmp-{random}`（目标目录内），`fs.rename` 原子替换 |
| `file.mkdir` | `fs.mkdir(path, { recursive: true })` |
| `file.delete` | `fs.rm(path, { recursive })`，`recursive` 必须显式为 true |
| `file.move` | 先 stat 检查 overwrite 策略，`fs.rename(source, dest)` |

### 6.3 transfer-handler.ts — HTTP 流式传输

**`file.export`（Client → Storage）：**

```ts
async function handleExport(job, socket) {
  const { path, rootDir, uploadRef } = job.payload;
  const safe = await resolveSafePath(rootDir, path);
  const hash = createHash("sha256");

  const fileStream = createReadStream(safe);
  fileStream.on("data", chunk => hash.update(chunk));

  try {
    await fetch(uploadRef.url, {
      method: "PUT",
      body: fileStream,
    });
    const sha256 = hash.digest("hex");
    socket.emit("job:done", {
      jobId: job.jobId,
      type: "file.export",
      result: { fileId: uploadRef.id, key: uploadRef.key, size: stats.size, sha256 },
    });
  } catch (err) {
    socket.emit("job:done", {
      jobId: job.jobId,
      type: "file.export",
      error: { code: "IO_ERROR", message: "Upload failed" },
    });
  }
}
```

**`file.import`（Storage → Client）：**

```ts
async function handleImport(job, socket) {
  const { targetPath, rootDir, downloadRef } = job.payload;
  const safe = await resolveSafePath(rootDir, targetPath);
  const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
  const hash = createHash("sha256");

  try {
    const res = await fetch(downloadRef.url);
    const writer = createWriteStream(tmpPath);
    // 流式下载 + 边写边算 hash
    // ...
    await pipeline(res.body, writer);
    const sha256 = hash.digest("hex");

    if (sha256 !== downloadRef.sha256) {
      await unlink(tmpPath);
      socket.emit("job:done", {
        jobId: job.jobId, type: "file.import",
        error: { code: "SHA256_MISMATCH", message: "SHA-256 mismatch" },
      });
      return;
    }

    await rename(tmpPath, safe);
    socket.emit("job:done", {
      jobId: job.jobId, type: "file.import",
      result: { path: safe, size: downloadRef.size, sha256 },
    });
  } catch (err) {
    try { await unlink(tmpPath); } catch {}
    socket.emit("job:done", {
      jobId: job.jobId, type: "file.import",
      error: { code: "IO_ERROR", message: "Download failed" },
    });
  }
}
```

**取消时的清理：**

- 使用 `AbortController` 取消正在进行的 HTTP 请求
- 关闭文件流
- 删除临时文件

### 6.4 dispatcher.ts 改动

现有 switch 已有 `file.*` 的 case（当前抛 not yet implemented），改为：

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

## 7. 错误处理矩阵

| 场景 | 表现 | 清理 |
|---|---|---|
| Client 不在线 | `create()` 抛错，不创建 Job | — |
| Capability 不足 | `create()` 抛错 | — |
| 路径逃逸 rootDir | Client 拒绝，`PATH_NOT_ALLOWED`，Job→error | — |
| 文件不存在 | `PATH_NOT_FOUND`，Job→error | — |
| readText 超限 | `SIZE_EXCEEDED`，Job→error | — |
| export HTTP 失败 | `IO_ERROR`，Job→error | 关闭流 |
| import SHA256 不匹配 | `SHA256_MISMATCH`，Job→error | 删除临时文件 |
| 中途取消 | AbortController + 删临时文件 | Job→cancelled |
| 预签名 URL 过期 | Storage 403，Client→`IO_ERROR` | — |
| Client 进程崩溃 | Server→disconnected，重连后核对 | — |

## 8. 验收标准

### Typed Job 兼容

- [ ] 旧 `exec` Job 行为不变
- [ ] 旧 Client（`["exec"]`）不会收到文件 Job
- [ ] 文件 Job 不经过 `spawn(..., { shell: true })`
- [ ] 文件 Job 有结构化 result 或稳定 errorCode

### 路径安全

- [ ] `../` 和 symlink 不能绕过 rootDir
- [ ] `delete` 的 `recursive` 必须显式为 true
- [ ] 错误消息不泄露路径、签名 URL、文件内容

### 文件传输

- [ ] 文件字节不进入 WebSocket 和 DB `output`
- [ ] 上传下载均为流式
- [ ] 完成前校验 size + SHA-256
- [ ] 失败/取消不留半成品文件

### File 表审计

- [ ] 每次传输在 File 表有记录
- [ ] 过期文件可定时清理

### Capability

- [ ] Server 创建 Job 时检查 Client capability
- [ ] 不匹配时拒绝创建

## 9. 明确不做

- S3/OSS adapter（扩展点留好）
- 断点续传
- 跨 Client 复制编排
- 同路径任务锁
- Base64 编码文件内容进 Job output

## 10. 与现有代码的关系

| 改动点 | 文件 | 性质 |
|---|---|---|
| 枚举重命名 | `packages/shared/src/index.ts` | ✅ 完成 |
| 新增 File 表 | `packages/server/prisma/schema.prisma` | 新增 |
| 新增 FileService | `packages/server/src/file/file.service.ts` | 新增 |
| 新增 FileModule | `packages/server/src/file/file.module.ts` | 新增 |
| JobService 扩展 | `packages/server/src/job/job.service.ts` | 修改（编排 + capability） |
| StorageService 扩展 | `packages/server/src/storage/storage.service.ts` | 修改（File 表配合） |
| 定时清理 | `packages/server/src/main.ts` 或独立模块 | 新增 |
| file-handler.ts | `packages/client/src/file-handler.ts` | 新增 |
| transfer-handler.ts | `packages/client/src/transfer-handler.ts` | 新增 |
| dispatcher.ts | `packages/client/src/dispatcher.ts` | 修改 |
