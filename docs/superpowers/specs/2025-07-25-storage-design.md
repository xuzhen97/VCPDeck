# Storage 存储系统设计

日期：2025-07-25

## 背景

VCPDeck 的 server ↔ client 文件传输需要一个服务端存储层。大文件不应走 WebSocket，而应通过 HTTP 中转：WebSocket 只传信令（Job dispatch / status），实际文件通过 HTTP 上传/下载，以预签名 URL 方式鉴权。

当前 `@vcpdeck/shared` 已定义 `FileRef`（预签名 URL + 过期时间）和各 `file.*` Job type，但客户端尚未实现，服务端也没有存储层。

## 目标

- 为 server ↔ client 文件传输提供统一存储层
- 存储后端可配置（本地磁盘、阿里云盘、S3…），运行时可通过管理面板切换
- 本期只实现 `local` 后端
- 文件生命周期与 Job 绑定：Job 完成或超时即清理关联文件

## 非目标

- 聊天附件、TODO 附件存储（后续接入同一个存储层即可）
- 文件版本管理、去重、CDN

---

## 模块结构

```
packages/shared/src/index.ts          ← 新增 StorageProviderKind 枚举
packages/server/src/
  storage/
    storage.module.ts                 ← NestJS 模块
    storage.service.ts                ← 读 DB 配置 → 委托 provider
    storage.controller.ts             ← HTTP 上传/下载端点
    providers/
      storage-provider.interface.ts   ← StorageProvider 接口
      local-storage.provider.ts       ← 本地磁盘实现
      providers.registry.ts           ← kind → Provider class 注册表
```

`storage/` 是一个独立 NestJS module，与其他模块无耦合。未来新增阿里云盘只需加 `alibaba-storage.provider.ts` + 注册一行。

---

## 架构

```text
                    WebSocket（信令）
Client  ◄──────────────────────────────────►  Server
  │                                              │
  │  HTTP PUT/GET（文件）                          │
  └────────────────────  Storage  ◄───────────────┘
                         (local / alibaba / …)
```

Server 是唯一与 Storage 交互的一方；Client 通过预签名 URL 直传 Storage。

---

## StorageProvider 接口

```typescript
interface StorageProvider {
  upload(stream: Readable, meta: FileMeta): Promise<FileEntry>;
  download(key: string): Promise<{ stream: Readable; meta: FileEntry }>;
  delete(key: string): Promise<void>;
  signDownloadUrl(key: string, expiresInSeconds: number): string;
  signUploadUrl(key: string, expiresInSeconds: number): string;
}

interface FileMeta {
  jobId: string;
  clientId: string;
  filename: string;
  mimeType?: string;
  size: number;
}

interface FileEntry extends FileMeta {
  key: string;
  storageKind: string;
  createdAt: Date;
}
```

- `key` 由 provider 内部生成（本地用 `uuid/filename`，云存储用 OSS object key）
- 预签名 URL：本地用 HMAC token 参数，云存储用各 SDK 原生预签名
- `upload` / `download` / `delete` 为服务端主动操作（清理、内部中转等）
- `signDownloadUrl` / `signUploadUrl` 用于签发一次性 URL 给 client

---

## HTTP 端点

```
POST   /api/storage/upload      — 签发上传令牌（返回 FileRef 含预签名 PUT URL）
GET    /api/storage/download/:key — 重定向到预签名 GET URL
DELETE /api/storage/:key        — 删除文件
```

### 上传流程

```
Client                   Server                      Storage
  │                        │                            │
  │── JobDone(need upload)─►│                            │
  │                        │── storage.signUploadUrl()──►│
  │◄─ FileRef (PUT URL) ───│                            │
  │                        │                            │
  │── HTTP PUT file ───────┼───────────────────────────►│
  │◄─ 200 ─────────────────┼────────────────────────────│
  │                        │                            │
  │── WS: "upload:done" ──►│ (Job status → done)        │
  │── storage.delete() ───►│ (清理，如有)                 │
```

### 下发流程

```
Server                   Storage                     Client
  │                        │                            │
  │── HTTP PUT file ──────►│ (先上传脚本/配置文件)       │
  │◄─ 200 ─────────────────│                            │
  │                        │                            │
  │── signDownloadUrl() ──►│                            │
  │◄─ FileRef ─────────────│                            │
  │                        │                            │
  │── WS: job:dispatch ────┼───────────────────────────►│
  │   (含 FileRef)         │                            │
  │                        │                            │
  │◄─ HTTP GET file ───────┼────────────────────────────│
  │── 200 ─────────────────┼───────────────────────────►│
  │                        │                            │
  │◄─ WS: "job:done" ──────┼────────────────────────────│
  │── storage.delete() ───►│                            │
```

---

## 数据库

### StorageBackendConfig

```prisma
model StorageBackendConfig {
  id        Int      @id @default(autoincrement())
  kind      String   @default("local")
  config    String   @default("{}")    // JSON
  updatedAt DateTime @updatedAt
}
```

单行配置表。

- `kind`：`"local"` | `"alibaba"` | …，决定用哪个 provider
- `config`：provider 级 JSON 参数。local 示例：`{ "baseDir": "./data/storage" }`

### 无需 File 表

文件生命周期与 Job 绑定，不上独立的 File 表。Job 已经有 `payload` / `result` 字段可以存储关联的文件 key。新增 File 表的好处（独立查询、审计）当前不必须，等聊天/TODO 附件场景接入时再建。

---

## 清理策略

| 触发条件 | 清理动作 |
|---------|---------|
| Job 状态变为 `done` / `error` / `cancelled` | `storage.delete()` 清理关联文件 |
| Job `disconnected` 超时 | `job.scheduler` 标记后清理 |
| Server 启动 | 扫描 storage 目录，清除无对应 Job 的孤儿文件 |

---

## 配置切换流程

1. Server 启动 → `StorageService.onModuleInit()` 读取 `StorageBackendConfig` 表
2. 取 `kind`，从 `providers.registry` 找到对应 Provider class
3. 用 `config` JSON 实例化 Provider
4. 运行时切换：管理面板改 DB `kind` → 调 `StorageService.reload()` → 内部替换 provider 引用

---

## 需要补充到 shared 的新类型

```typescript
export const StorageProviderKind = {
  LOCAL: "local",
  // ALIBABA: "alibaba",  // 后续
} as const;
export type StorageProviderKind = (typeof StorageProviderKind)[keyof typeof StorageProviderKind];
```

`FileRef` 已存在，无需改动。新增 `StorageBackendConfig` 对应的 REST 类型按需添加。

---

## 本期实现范围

| 模块 | 本期 |
|------|------|
| `StorageProvider` 接口 | ✅ |
| `LocalStorageProvider` | ✅ |
| `StorageService`（读 DB 配置、委托） | ✅ |
| `StorageController`（3 个端点） | ✅ |
| `StorageModule` + 注册到 AppModule | ✅ |
| DB: `StorageBackendConfig` + seed 默认 local | ✅ |
| `upload` / `download` / `delete` / `signUploadUrl` / `signDownloadUrl` | ✅ |
| 阿里云盘 / S3 provider | ❌ 后续 |
| 管理面板切换 UI | ❌ 后续 |
| File 独立表 | ❌ 后续（聊天/TODO 附件时添加） |

---

## 风险 & 后续

- **预签名 URL 安全性**：local provider 用 HMAC（server 持有密钥），URL 带签名 + 过期时间戳，server 在 storage controller 验证
- **并发上传**：local provider 用文件锁 / 原子写入避免并发写冲突
- **大文件**：本地存储无大小限制；超出磁盘空间时返回 507 Insufficient Storage
