# Storage API

Server ↔ Client 文件传输存储层。文件采用预签名 URL 鉴权，WebSocket 只传信令，实际文件走 HTTP。

## 基础架构

```
Server（签发预签名 URL） → Client（HTTP PUT/GET 直传文件） → Storage Backend（local/阿里云盘/…）
```

当前默认后端：`local`（本地磁盘），配置见 `StorageBackendConfig` 数据库表。

## 端点总览

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/storage/upload-token` | 需登录 | 签发上传令牌，返回预签名 PUT URL |
| POST | `/api/storage/download-token` | 需登录 | 签发下载令牌，返回预签名 GET URL |
| PUT | `/api/storage/upload/:key(*)` | 预签名 URL | 接收文件上传 |
| GET | `/api/storage/download/:key(*)` | 预签名 URL | 流式下载文件 |
| DELETE | `/api/storage/:key(*)` | 需登录 | 删除文件 |

## 完整上传流程

```
Client（或 Server 内部）                      Server                           Storage
  │                                              │                                 │
  │── POST /api/storage/upload-token ──────────►│                                 │
  │     { jobId, clientId, filename, size }      │                                 │
  │◄─ { url, expiresAt } ────────────────────────│                                 │
  │                                              │                                 │
  │── PUT {url} ─────────────────────────────────┼─────────────────────────────►│
  │     (raw body)                               │                                 │
  │◄─ 200 { key, size } ─────────────────────────┼──────────────────────────────│
  │                                              │                                 │
  │── WS: "upload:done" ──────────────────────►│                                 │
```

## 下载流程

```
Server（内部）                                                             Client
  │                                                                          │
  │── POST /api/storage/download-token { key } ──► 返回预签名 GET URL        │
  │                                                                          │
  │── WS: job:dispatch（含 download FileRef） ─────────────────────────────►│
  │                                                                          │
  │◄─ HTTP GET {预签名 URL} ────────────────────────────────────────────────│
  │── 200 stream response ───────────────────────────────────────────────►│
```

## API 详细说明

### POST /api/storage/upload-token

签发上传令牌，返回预签名 PUT URL。

**Request Body:**

```json
{
  "jobId": "job-123",
  "clientId": "client-abc",
  "filename": "screenshot.png",
  "size": 1024000,
  "mimeType": "image/png",
  "ttlSeconds": 3600
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| jobId | string | ✅ | - | 关联的 Job ID |
| clientId | string | ✅ | - | 客户端 ID |
| filename | string | ✅ | - | 原始文件名 |
| size | number | ✅ | - | 文件大小（字节） |
| mimeType | string | ❌ | - | MIME 类型 |
| ttlSeconds | number | ❌ | 3600 | 预签名 URL 有效期（秒） |

**Response:**

```json
{
  "url": "/api/storage/upload/uuid/filename.ext?expires=...&sig=...",
  "expiresAt": 1784000000000
}
```

### POST /api/storage/download-token

签发下载令牌，返回预签名 GET URL。

**Request Body:**

```json
{
  "key": "uuid/filename.ext",
  "ttlSeconds": 3600
}
```

**Response:**

```json
{
  "url": "/api/storage/download/uuid/filename.ext?expires=...&sig=...",
  "expiresAt": 1784000000000
}
```

### PUT /api/storage/upload/:key(*)

接收文件上传。`key` 和 `sig`/`expires` 从预签名 URL 的 query string 传入。

**Headers:** `Content-Type` 应为实际文件类型（如 `text/plain`、`application/octet-stream`）。

**Response (200):**

```json
{ "key": "uuid/filename.ext", "size": 1024000 }
```

**Response (403):** 签名无效或已过期。

### GET /api/storage/download/:key(*)

流式下载文件。响应头包含：

- `Content-Type`: 文件的 MIME 类型
- `Content-Disposition`: `attachment; filename="..."`
- `Content-Length`: 文件字节数

### DELETE /api/storage/:key(*)

删除指定文件。

**Response (200):**

```json
{ "ok": true }
```

## 错误码

| HTTP Status | 场景 |
|-------------|------|
| 401 | 未认证（upload-token / download-token / delete 端点） |
| 403 | 签名无效或已过期（upload / download 端点） |
| 404 | 文件不存在（download 端点） |

## 配置

### GET /api/storage/config

返回当前激活后端的安全摘要，不返回 `config` JSON。

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

### POST /api/aliyundrive/verify

通过阿里云盘 `getDriveInfo` OpenAPI 验证当前授权是否仍可用。若 access token 临近过期且存在 refresh token，服务端会先刷新并持久化新的 token，再执行验证。

```json
{
  "valid": true,
  "checkedAt": "2026-07-31T12:00:00.000Z",
  "driveId": "drive-1"
}
```

失败时 `valid` 为 `false`，`reason` 可能为 `not_configured`、`not_authorized`、`expired`、`revoked`、`forbidden` 或 `unreachable`。网络错误不会清除已保存的授权。响应不包含任何 token、secret 或完整配置。

存储后端通过数据库 `StorageBackendConfig` 表配置（单行）。

```sql
SELECT kind, config FROM StorageBackendConfig;
-- kind: "local"（默认）
-- config: {"baseDir": "./data/storage"}
```

数据库中的 `config` JSON 供服务端 provider 使用，不通过管理端点返回浏览器。

## 扩展

新增存储后端只需：

1. 实现 `StorageProvider` 接口（见 `storage/providers/storage-provider.interface.ts`）
2. 在 `providers.registry.ts` 注册一行 `{ newKind: NewStorageClass }`

示例：阿里云盘 → 实现 `upload`/`download`/`delete`/预签名方法 + 注册 `alibaba: AlibabaStorageProvider`。
