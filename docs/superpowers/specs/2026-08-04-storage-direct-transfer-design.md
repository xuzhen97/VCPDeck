# 存储直连传输设计（上传 / 下载绕过 Server）

## 状态

- 日期：2026-08-04
- 状态：已确认，待编写实施计划
- 范围：阿里云后端下，浏览器 / Client 与阿里云 OSS 直连传输（上传与下载），Server 只做编排；local 后端保持 Server 中转

## 背景

当前所有文件传输都经过 Server 字节流中转：

| 方向 | 数据流 |
|------|--------|
| 上传（浏览器→远程） | 浏览器 PUT → Server（流式接收）→ Server 转发到阿里云分片上传 |
| 导入（远程拉取） | Client GET → Server → 阿里云拉流转发 |
| 导出（远程→浏览器） | Client PUT → Server → 阿里云；浏览器 GET → Server → 阿里云拉流转发 |

Server 收一份再发一份，部署在云上时公网带宽被双向吃满。阿里云盘 OpenAPI 本身支持直连：`createFileUpload`（创建分片上传任务，返回每片预签名 OSS URL）、`getUploadUrl`（续期分片 URL）、`completeUpload`（合并分片）、`getDownloadUrl`（外部下载 URL）。数据可以绕开 Server：浏览器 / Client 直接 PUT 分片到 OSS、直接 GET 下载 URL，Server 只创建会话、签发直传凭证、完成回调、记录进度。

`local` 后端文件在 Server 磁盘上，无法直连，保持现有 Server 中转。

## 目标与非目标

### 目标

- `alibaba` 后端下，浏览器→远程上传、远程→浏览器导出、远程拉取导入的数据流全部直连阿里云，不经过 Server。
- Server 只做编排：创建/完成上传会话、续期分片 URL、记录任务进度。
- 前端 / Client 按后端类型分支（`proxy` / `direct`），local 后端行为不变。
- 完整性校验改为只校验文件大小（放弃 SHA-256，用户已确认）。
- 下载链接从永久签名链接改为阿里云临时下载 URL（约 15 分钟，每次点击实时生成，用户已确认）。

### 非目标

- 不改阿里云 OpenAPI Client 方法本身（复用 `createFileUpload` / `getUploadUrl` / `completeUpload` / `getDownloadUrl`）。
- 不做清理任务：未完成上传的阿里云文件残留仍由未来的定期清理任务处理。
- 不做导入 URL 过期自动重签发（403 直接失败，用户重试）。
- 不支持分片大小 / 并发数配置（固定 10MB / 3 并发）。

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 直连范围 | 上传 + 下载全直连 | 彻底解决 Server 带宽占用 |
| 完整性校验 | 只验 size，放弃 SHA-256 | 直传后 Server 无法计算哈希；OSS 分片传输自身有完整性保证；用户确认 |
| 下载链接时效 | 临时链接（约 15 分钟） | 阿里云 getDownloadUrl 限制（PDS 文档默认 900s，个人版实际约 15 分钟，Alist issue #5547 观察）；点击时实时生成 |
| 分片参数 | 10MB / 片，并发 3，单片失败重试 2 次 | 上限 10000 片 = 100GB；403 时调 Server 续期该片 URL 重试 |

## 架构

```
浏览器 ──(PUT 分片到 OSS 预签名 URL)──→ 阿里云 OSS ──(completeUpload)──→ 阿里云盘
  │                                          ▲
  │  createUploadSession / complete          │  编排（几 KB 流量）
  └────────────── Server ────────────────────┘

Client ──(GET 阿里云 getDownloadUrl 直连)──→ 阿里云 CDN/OSS
  │
  │  JOB_PROGRESS / JOB_DONE（socket，小流量）
  └────────────── Server（仅编排）
```

`local` 后端：保持现有签名 URL 中转，链路不变。

## 上传直连（浏览器 → 远程）

1. `POST /api/files/upload-sessions`：Server 创建 `File(pending)` + `file.import` Job(`waiting_input`)，调阿里云 `createFileUpload`（声明 size、分片数 `ceil(size / 10MB)`），返回：

   ```json
   { "jobId": "...", "fileId": "...", "status": "waiting_input",
     "upload": { "kind": "direct", "fileId": "aliyun-file-id",
                 "uploadId": "...", "parts": [{ "partNumber": 1, "url": "https://oss.../..." }] } }
   ```

   local 后端返回 `upload: { "kind": "proxy", "url": "/api/storage/upload/...", "expiresAt": ... }`（现状）。
2. 浏览器：`File.slice` 分片 → XHR PUT 到各片 OSS URL（并发 3）→ 片内 `onProgress` 汇总全局进度 → 每片完成节流上报（`POST /api/files/upload-sessions/:jobId/progress`，Server 写 `job.progress`，铃铛轮询可见）。
3. 完成：`POST /api/files/upload-sessions/:jobId/complete`（带 `uploadedBytes`）→ Server 校验 `uploadedBytes === File.size` → 阿里云 `completeUpload` 合并分片 → `File` 置 `completed`（`key` = 阿里云 fileId，`storageKind` = "alibaba"）→ 激活 import Job（`downloadRef.url` = 阿里云 `getDownloadUrl` 外部 URL，`direct: true`）。
4. 失败 / 取消：`File` 保持 `pending`，阿里云未完成文件残留（清理任务后续处理）。

分片 URL 过期（PUT 403）：调 `POST /api/files/upload-sessions/:jobId/part-urls`（续期指定分片）重新取该片 URL 重试，最多重试 2 次。

## 导入直连（远程拉取）

- `downloadRef.url` 为阿里云 `getDownloadUrl` 返回的外部绝对 URL，`downloadRef.direct = true`。
- Client：直连 GET 流式写盘，进度照旧 `JOB_PROGRESS`；**只校验 size**（不再校验 SHA-256）。
- 同源限制：`transfer-handler.ts` 的 `absUrl` 对 `direct: true` 的 URL 跳过 Server 同源校验（URL 由 Server 从阿里云 API 获取，仍受签名 payload 保护；local 后端 `direct` 缺省，校验不变）。
- URL 过期（403）：import 失败 IO_ERROR，用户重试上传。
  `ponytail:` 若排队经常超过 15 分钟，可加"403 时回退调 Server 重新生成下载 URL"。

## 导出直连（远程 → 浏览器）

1. 前端导出 → Server 创建 `file.export` Job + 阿里云上传会话 → `payload.uploadRef = { fileId, uploadId, parts, direct: true }`。
2. Client：`fs.createReadStream(path, { start, end })` 分片读取 → fetch PUT 到 OSS URL（并发 3，重试 2 次）→ 进度照旧 `JOB_PROGRESS`。
3. 传完调 `POST /api/files/export-complete`（带 `jobId` + `uploadedBytes`）→ Server 校验字节数 → 阿里云 `completeUpload` → `File` 置 `completed`（`key` = fileId，`storageKind` = "alibaba"）→ 返回新 `key`。
4. Client emit `JOB_DONE`（result：`{ fileId, key, size }`，不再有 `sha256`）。
5. 浏览器下载：`createDownloadToken`（alibaba 分支）→ Server 实时调 `getDownloadUrl` 返回外部绝对 URL（不再签发 Server 签名永久 URL）；前端 `new URL(url, window.location.origin)` 统一拼接，直连下载。

## 链接语义变化

- 下载链接从"永久"变为"临时"（阿里云限制，约 15 分钟；点击 / 查看时实时生成，不缓存）。
- `DownloadLinkCard` 文案改为"下载链接临时有效，请及时下载"；铃铛下载按钮逻辑不变（点击时生成）。

## 协议 / SDK 变化（@vcpdeck/shared）

- `FileUploadSession.upload` 改为判别联合：

  ```ts
  type UploadTarget =
    | { kind: "proxy"; url: string; expiresAt: number }       // local：Server 签名 URL
    | { kind: "direct"; fileId: string; uploadId: string;     // alibaba：OSS 分片直传
        parts: Array<{ partNumber: number; url: string }> };
  ```

- `FileRef` 增加 `direct?: boolean`（true = 外部绝对 URL，Client 跳过同源限制）。
- `FileImportPayload` 移除 `sha256`；`File` 表 `sha256` 字段存 `""`（不动 Prisma schema）。
- SDK `files.createUploadSession` / `completeUpload` / `files.export` 返回结构随之更新；新增 `files.completeExportUpload(jobId, uploadedBytes)`、`files.refreshUploadPartUrls(jobId, partNumbers)`。`files.completeUpload(jobId, { uploadedBytes }, signal)` 显式携带浏览器实传字节数（Server 校验）。

## Server 改动清单

- `AlibabaStorageProvider`：新增 `createDirectUpload(size, name, folder) → { fileId, uploadId, parts }`、`refreshPartUrls(fileId, uploadId, partNumbers)`、`completeDirectUpload(fileId, uploadId)`、`getExternalDownloadUrl(fileId) → { url, expiresAt }`（复用 `AlibabaOpenApiClient` 现有方法，不改 OpenAPI Client）。
- `StorageService`：`createUploadSession`（alibaba 分支）、`completeUploadSession`（校验字节数 → completeUpload）、`createDownloadToken`（alibaba 分支返回外部 URL；`ttlSeconds` 仅 local 生效）、`completeExportUpload`、`updateUploadProgress`。
- `EventsController`：`POST /api/files/export-complete`、`POST /api/files/upload-sessions/:jobId/part-urls`（续期）、`POST /api/files/upload-sessions/:jobId/progress`；现有端点按 kind 分支。
- `File` 行：直传后 `key` = 阿里云 fileId、`storageKind` = "alibaba"（修正 `createPending` 硬编码 local 的问题）、`sha256` = ""。

## Client 改动清单（transfer-handler.ts）

- `handleImport`：`downloadRef.direct` 时直连外部 URL（跳过同源校验）、只验 size。
- `handleExport`：分片直传 + 完成后调 export-complete + `JOB_DONE` result 不再含 sha256。
- 分片直传小函数（`uploadParts`）供 import/export 共用：`createReadStream`/`File` 分片、并发 3、失败重试 2 次（403 调续期接口）。

## 前端改动清单

- `upload-file.ts`：新增 `uploadDirect(upload, file, { onProgress, signal })`——slice + XHR PUT 并发 3、进度汇总、403 续期重试；local 走原 `uploadFile`。
- `files-panel.tsx`：按 `session.upload.kind` 分支；`uploadState` 两阶段（uploading / importing）不变。
- `download-link-card.tsx` / `notification-bell.tsx`：`new URL(url, origin)` 兼容外部 URL；文案改"临时链接"。
- 进度上报：每片完成节流（500ms）调 progress 端点，铃铛 waiting_input 阶段进度可见。

## 错误处理

| 场景 | 行为 |
|------|------|
| 分片 PUT 失败（网络错误） | 重试该片，最多 2 次 |
| 分片 PUT 403（URL 过期） | 调续期接口取新 URL 重试，最多 2 次 |
| 上传字节数与声明 size 不符 | complete 返回 400，Job 保持 waiting_input，前端显示错误 |
| `completeUpload` / export-complete 失败 | Job IO_ERROR |
| 导入 URL 过期 403 | import 失败 IO_ERROR，用户重试 |
| 用户取消 | AbortController 中止剩余分片；阿里云未完成文件残留（清理任务后续） |

## 测试策略

- **Server**：会话创建（alibaba 分支，mock OpenAPI Client 返回 parts）、complete 校验字节数、export-complete、downloadToken 外部 URL、local 分支行为不变。
- **Client**：export 分片直传（mock fetch 每片、并发、重试）、import direct URL 放行 + 只验 size（替换现有 SHA-256 校验用例）、local 同源校验不变。
- **前端**：upload-file 分片进度汇总、files-panel direct 分支、DownloadLinkCard 外部 URL 渲染。
- 全量回归：`pnpm test`（shared / server / client / frontend）+ `pnpm build`。

## 风险与注意

- 阿里云个人版 `getDownloadUrl` 实际时效可能短于请求值（约 15 分钟）：链接每次实时生成，不缓存。
- 分片 URL 续期依赖上传会话未过期；超时会话需重新创建。
- 直传 URL 泄露风险：OSS 预签名 URL 只写（PUT），下载 URL 只读，均有时效；Server 只在签名会话内下发。
- import 校验从 SHA-256 降为 size：传输损坏检测能力降低（OSS/TLS 提供基础保障）。
