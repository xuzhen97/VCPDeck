# 稳定可续传下载入口设计

## 1. 背景

VCPDeck 在 `alibaba` Storage 后端下通过阿里云盘 OpenAPI `getDownloadUrl` 获取临时外部下载 URL。当前前端会先调用 `POST /api/storage/download-token`，再把返回的阿里云 URL 交给浏览器。

该方式存在三个大文件下载问题：

1. 临时 URL 默认约 15 分钟有效，页面提前生成并缓存后可能在用户点击前已经过期；
2. 链接过期或网络中断后，浏览器没有稳定的 VCPDeck 地址可重新请求新 URL；
3. 阿里云 OSS 会因页面 Referer 触发 bucket referer policy，导致 `AccessDenied`。

阿里云官方文档明确支持通过 `Range` 请求断点续传及并发分段下载；临时 URL 过期后可再次调用 GetDownloadUrl 获取新链接。若传输在 URL 有效期内已经开始且不中断，即使传输过程中超过有效期也不受影响。

## 2. 目标

为 `alibaba` 后端提供受鉴权的稳定下载入口：

- 每次访问都实时生成新的阿里云临时下载 URL；
- 以 HTTP 302 跳转让客户端直接连接阿里云，Server 不承载文件流量；
- 支持 Web Cookie 会话和 CLI/脚本 Bearer Token；
- 允许客户端携带 `Range` 重复访问稳定入口，实现 best-effort 原生断点续传；
- 统一消除临时 URL 过期缓存与 OSS Referer policy 问题；
- `local` 后端保留现有下载路径和行为。

## 3. 非目标

本期不实现：

- 浏览器内下载管理器；
- 下载偏移持久化；
- 前端主动 Range 分片、并发下载与本地合并；
- 阿里云文件流经过 Server 的代理下载；
- 新的 CLI `download` 命令；
- 可公开分享或可撤销的分享令牌；
- `local` 后端原生 `206 Partial Content` / Range 能力；
- 保证所有浏览器在网络中断后一定自动恢复下载。

## 4. 方案选择

### 4.1 选定方案：稳定、受鉴权的 302 入口

客户端始终访问同一个 VCPDeck URL。Server 验证 Cookie 或 Bearer 身份，实时签发后端下载 URL，设置防缓存与 Referrer 策略后返回 302。文件内容由客户端直接从阿里云下载。

```text
Web / curl
  GET /api/storage/download-redirect/:key
  Cookie 或 Bearer + 可选 Range
          │
          ▼
VCPDeck Server（仅鉴权、签发、302）
  ├─ alibaba → GetDownloadUrl → 临时外部 URL
  └─ local    → 现有签名下载 URL
          │
          ▼
客户端跟随 302，直接下载文件
```

### 4.2 未选方案

- **307/308 跳转**：下载请求为 GET，302 已满足语义，且阿里云官方 DownloadFile 也采用 302；无额外收益。
- **JSON 返回临时 URL**：仍把过期 URL 暴露并缓存到页面，不能形成稳定重试入口。
- **Server 代理流**：兼容性高，但重新占用 Server 大文件带宽，违反直连目标。
- **前端管理下载**：可提供强保证续传，但依赖 File System Access API，主要限于 Chromium，范围与复杂度显著增大。

## 5. 接口设计

### 5.1 稳定下载端点

```http
GET /api/storage/download-redirect/:key
```

Web 调用：

```http
Cookie: vcpdeck_session=<session>
```

CLI/脚本调用：

```http
Authorization: Bearer <token>
Range: bytes=524288000-
```

端点约束：

1. 不使用 `@Public()`，复用全局 `AuthGuard`；
2. `key` 沿用现有 Storage key；`alibaba` 下为阿里云 `fileId`；
3. 每次请求调用现有 `StorageService.createDownloadToken(key)`，不缓存返回值；
4. 成功返回空 body 的 `302 Found`；
5. 响应头：
   - `Location: <fresh download URL>`
   - `Referrer-Policy: no-referrer`
   - `Cache-Control: private, no-store`
6. 不读取请求体、不打开文件流、不在 Server 中转数据；
7. 当前授权语义保持不变：任一已认证身份可按已知 key 下载；不新增按 Job owner 的细粒度授权。

### 5.2 后端分支

#### alibaba

`StorageService.createDownloadToken(key)` 调用 `AlibabaStorageProvider.getExternalDownloadUrl(key)`，每次通过 OpenAPI `getDownloadUrl` 获取新的临时外部 URL。

#### local

`StorageService.createDownloadToken(key)` 返回现有 `/api/storage/download/:key?expires=...&sig=...` 签名 URL。稳定入口 302 到该 URL，随后继续由现有 public 签名下载端点传输。Local 本期不新增 Range 支持。

### 5.3 SDK

在 `packages/sdk/src/storage.ts` 的 Storage 模块接口新增纯 URL 构造方法：

```ts
downloadUrl(key: string): string
```

返回：

```ts
`/api/storage/download-redirect/${encodeURIComponent(key)}`
```

该方法不发网络请求，不提前生成临时 URL，也不接受 TTL。

现有 `createDownloadToken()` 保留，因为 Server 内部远程 Client 的 `file.import` 调度仍需要直接外部 URL；不能把该内部数据面引用改成需要 Web/Bearer 鉴权的稳定入口。

## 6. 前端迁移

以下浏览器下载入口统一使用 `sdk.storage.downloadUrl(key)`，不再调用 `createDownloadToken()`：

1. `DownloadLinkCard`（任务详情与任务抽屉）；
2. `NotificationBell.DownloadButton`；
3. `FilesPanel` 右键“导出下载”；
4. `FileViewerDialog`；
5. 备用 `FileDetail`。

动态 anchor 示例：

```ts
const anchor = document.createElement("a");
anchor.href = sdk.storage.downloadUrl(key);
anchor.download = filename;
anchor.referrerPolicy = "no-referrer";
anchor.click();
```

任务详情展示稳定同源 URL，不再展示巨大、会过期的阿里云 URL。调用点保留 `no-referrer` 作为纵深防御，但解决 OSS policy 的主要接口保证由 302 响应头统一提供。

## 7. Range 与续传语义

客户端可对稳定入口发送：

```http
Range: bytes=524288000-
```

Server 不解析、不消费 Range，只实时签发并返回 302。标准 HTTP 客户端在 GET 重定向时会将 Range 请求语义带到目标 URL，阿里云可返回 `206 Partial Content` 与 `Content-Range`。

### 必须保证

- 相同稳定 URL 可重复访问；
- 每次访问都重新签发 URL；
- 带 Range 的访问仍返回新的 302；
- 302 不能被客户端或中间缓存复用；
- Server 不传输文件体。

### Best-effort 边界

VCPDeck 不控制浏览器下载器是否在连接中断后自动重新访问原始稳定入口。因此：

- `curl -L -C -`、支持重试原 URL 的下载器可明确续传；
- Chrome/Edge 可使用原生下载能力，但不承诺所有版本和所有中断类型都自动续传；
- 若浏览器没有重试原入口，用户重新点击后的断点复用由浏览器下载器自身决定。

## 8. 错误处理

- 匿名请求或无效 Cookie/Bearer：返回 `401 AUTH_REQUIRED`，不得签发临时 URL；
- 阿里云授权过期、OpenAPI 失败或 key 无效：返回现有安全错误响应，不设置 Location，不泄露 token、secret 或 stack；
- 签发成功：返回 302 和空 body；
- local key 不存在的行为沿用现有签名下载链路，可能在后续 public 下载端点才返回错误；
- 临时 URL 不写数据库、不进入日志、不缓存。

## 9. 测试策略

### Server Controller

- alibaba 返回 302、fresh Location、`Referrer-Policy: no-referrer`、`Cache-Control: private, no-store`；
- 连续请求两次会签发两次，并返回不同 Location；
- 携带 Range 时仍只签发并 302，不调用文件流下载；
- 匿名请求返回 401；
- Cookie 会话与 Bearer Token 均可访问；
- local 返回 302 到现有签名下载 URL。

### SDK

- `downloadUrl(key)` 使用 `encodeURIComponent`；
- 只返回相对 URL，不触发 `client.request`。

### Frontend

- 五个下载入口都使用稳定 URL；
- 不再调用 `createDownloadToken()`；
- 任务详情显示稳定 URL；
- anchor 保留 filename 与 `no-referrer`。

### 手动验证

首次下载：

```bash
curl -L \
  -H "Authorization: Bearer $TOKEN" \
  -o big.bin \
  "$BASE/api/storage/download-redirect/$KEY"
```

中断后续传：

```bash
curl -L -C - \
  -H "Authorization: Bearer $TOKEN" \
  -o big.bin \
  "$BASE/api/storage/download-redirect/$KEY"
```

确认续传响应链最终包含 `206 Partial Content`，下载内容大小与源文件一致，Server 进程不出现与文件大小同量级的网络流量。

## 10. 安全与运维

- 稳定入口受现有 Cookie/Bearer 鉴权保护；
- Location 是短期阿里云凭证，响应必须 `no-store`；
- 日志不得打印完整 Location；
- 保留 `Referrer-Policy: no-referrer`，避免 OSS 防盗链拒绝；
- 不创建永久公开下载 URL；
- 本期不增加数据库表或迁移，不增加依赖。
