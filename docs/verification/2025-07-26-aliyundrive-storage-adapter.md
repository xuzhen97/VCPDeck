# 阿里云盘 Storage 适配器 — 人工验收指南

> 基于 `docs/storage-api.md`、`docs/storage-design-model.md` 及参考代码 `remote-agent-gateway`

## 前置条件

1. 阿里云盘开放平台已注册应用（<https://www.aliyundrive.com/）>
   - 回调地址设为 `oob`（out-of-band）
   - 记录 `clientId`（和 `clientSecret` 如有）
2. VCPDeck Server 代码已更新并重启

---

## 1. 启动 Server

> 💡 使用 `pnpm dev`（tsx）而非 `pnpm start`（node dist），因为后者不会热重载

```bash
cd packages/server && pnpm dev
```

预期输出：

```
[Nest] ...     LOG [RouterExplorer] Mapped {/api/aliyundrive/status, GET} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/aliyundrive/config, PUT} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/aliyundrive/oauth/start, POST} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/aliyundrive/oauth/complete, POST} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/aliyundrive/oauth/revoke, POST} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/storage/upload-token, POST} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/storage/download-token, POST} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/storage/upload/:key(*), PUT} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/storage/download/:key(*), GET} route
[Nest] ...     LOG [RouterExplorer] Mapped {/api/storage/:key(*), DELETE} route
[Nest] ...     LOG Storage provider: local
[Nest] ...     LOG Nest application successfully started
```

**关键检查：** 末行 `Storage provider: local` 表示 `PrismaService` 注入成功，数据库连接正常。

> ❌ 如果看到 `TypeError: Cannot read properties of undefined (reading 'storageBackendConfig')`，说明 PrismaService 未注入。检查 `StorageService` 构造函数是否有 `@Inject(PrismaService)`。

---

## 2. 管理员登录

后续所有配置端点需要 cookie 认证。

```bash
# 登录（使用预设密码 test123 或环境变量 VCPDECK_ADMIN_PASSWORD）
curl -c cookies.txt -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"test123"}'
```

预期：`{"identity":{"id":"...","username":"admin","isAdmin":true}}`

> 💡 后续所有 curl 命令加 `-b cookies.txt` 携带认证。

---

## 3. 验收阿里云盘 OAuth 授权流程

### 3a. 检查状态（未配置）

```bash
curl -b cookies.txt http://localhost:3001/api/aliyundrive/status
```

预期：

```json
{
  "configured": false,
  "authorized": false,
  "hasAuth": false,
  "isExpired": false
}
```

### 3b. 保存 App 配置

```bash
curl -b cookies.txt -X PUT http://localhost:3001/api/aliyundrive/config \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "<你的阿里云盘 App clientId>",
    "openapiBase": "https://openapi.alipan.com"
  }'
```

预期：返回配置对象（不含 `clientSecret`），`clientId` 已填充。

> ❌ 缺少 `clientId` 时返回 400 `"clientId is required"`

### 3c. 检查状态（已配置、未授权）

```bash
curl -b cookies.txt http://localhost:3001/api/aliyundrive/status
```

预期：`configured: true`, `authorized: false`, `authorizationState: "unauthorized"`

### 3d. 启动 OAuth 授权

```bash
curl -b cookies.txt -X POST http://localhost:3001/api/aliyundrive/oauth/start
```

预期返回：

```json
{
  "state": "<32位hex>",
  "authorizationUrl": "https://openapi.alipan.com/oauth/authorize?client_id=...&scope=...&state=...",
  "expiresAt": <10分钟后时间戳>
}
```

### 3e. 浏览器授权 & 获取 code

1. 复制 `authorizationUrl` 在浏览器中打开
2. 登录阿里云盘账号，点击"授权"
3. 授权完成后页面显示一个 `code`，或跳转到带 `code=` 参数的 URL
4. 复制 code 值

### 3f. 用 code 换取 token

```bash
curl -b cookies.txt -X POST http://localhost:3001/api/aliyundrive/oauth/complete \
  -H "Content-Type: application/json" \
  -d '{"state":"<state值>","code":"<复制的code>"}'
```

预期：

```json
{
  "authorized": true,
  "expiresAt": <过期时间戳>
}
```

> ❌ 如果 session 过期（10 分钟）返回 400 `"OAuth 会话已过期，请重新发起授权"`

### 3g. 检查授权状态（已授权）

```bash
curl -b cookies.txt http://localhost:3001/api/aliyundrive/status
```

预期：`authorized: true`, `hasAuth: true`, 可能出现 `driveId`。

---

## 4. 验收存储后端切换

### 4a. 查看当前存储配置

```bash
curl -b cookies.txt http://localhost:3001/api/storage/config
```

预期：`{"kind":"local","config":{...},"updatedAt":"..."}`

### 4b. 切换到阿里云盘

```bash
curl -b cookies.txt -X PUT http://localhost:3001/api/storage/config \
  -H "Content-Type: application/json" \
  -d '{"kind":"alibaba"}'
```

预期：返回 `{"kind":"alibaba","config":{...},"updatedAt":"..."}`

Server 日志应显示：`Storage provider: alibaba`

---

## 5. 验收文件上传（小文件）

### 5a. 获取上传令牌

```bash
curl -b cookies.txt -X POST http://localhost:3001/api/storage/upload-token \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "test-001",
    "clientId": "test",
    "filename": "hello-aliyun.txt",
    "size": 28
  }'
```

预期返回：

```json
{
  "url": "/api/storage/upload/<key>?expires=<ts>&sig=<hex>",
  "expiresAt": <过期时间戳>
}
```

### 5b. 上传文件内容

```bash
curl -b cookies.txt -X PUT "http://localhost:3001/api/storage/upload/<key>?expires=<ts>&sig=<hex>" \
  -H "Content-Type: text/plain" \
  -d "Hello from VCPDeck Aliyun!"
```

预期：

```json
{
  "key": "<阿里云盘 fileId>",
  "size": 28
}
```

> ✅ **key 格式验证：** key 不再是 `uuid/filename` 路径格式，而是阿里云盘的纯数字/字母 fileId（服务端代理上传到阿里云盘后返回）。

### 5c. 签名过期拒绝（安全性）

```bash
# 获取 1 秒 TTL 的上传令牌，等待 2 秒后上传
curl -b cookies.txt -X POST http://localhost:3001/api/storage/upload-token \
  -H "Content-Type: application/json" \
  -d '{"jobId":"test-exp","clientId":"test","filename":"x.txt","size":5,"ttlSeconds":1}'

# 等待 2 秒...
sleep 2

# 用过期 URL 上传
curl -b cookies.txt -X PUT "http://localhost:3001/api/storage/upload/<expired-url>"
```

预期：HTTP **403**，签名过期被拒。

### 5d. 篡改签名拒绝（安全性）

```bash
# 修改 sig 参数中的任意字符
curl -b cookies.txt -X PUT "http://localhost:3001/api/storage/upload/<key>?expires=<ts>&sig=deadbeef"
```

预期：HTTP **403**。

---

## 6. 验收文件下载

### 6a. 获取下载令牌

用步骤 5b 返回的 `key`（阿里云盘 fileId）：

```bash
curl -b cookies.txt -X POST http://localhost:3001/api/storage/download-token \
  -H "Content-Type: application/json" \
  -d '{"key":"<5b返回的key>"}'
```

预期：

```json
{
  "url": "/api/storage/download/<key>?expires=<ts>&sig=<hex>",
  "expiresAt": <过期时间戳>
}
```

### 6b. 下载 & 内容校验

```bash
curl -b cookies.txt "http://localhost:3001/api/storage/download/<key>?expires=<ts>&sig=<hex>"
```

预期：返回原始文件内容 `"Hello from VCPDeck Aliyun!"`。

> ❌ 如果返回 404 或乱码，说明阿里云盘下载链路异常。

### 6c. 下载签名过期/篡改

同 5c/5d 逻辑，修改下载 URL 的签名 → HTTP **403**。

---

## 7. 验收文件删除

### 7a. 删除文件

```bash
curl -b cookies.txt -X DELETE "http://localhost:3001/api/storage/<key>"
```

预期：`{"ok":true}`

### 7b. 删除后不可下载

再次获取下载令牌 → 下载 → 预期 HTTP **400+**（阿里云盘返回 404）。

---

## 8. 验收切回 local 后端

```bash
curl -b cookies.txt -X PUT http://localhost:3001/api/storage/config \
  -H "Content-Type: application/json" \
  -d '{"kind":"local"}'
```

预期：Server 日志显示 `Storage provider: local`，后续上传/下载走本地磁盘。

---

## 9. 一键测试脚本

```bash
node scripts/test-aliyundrive.cjs
```

脚本交互式引导你完成：

1. 管理员登录（自动）
2. 输入阿里云盘 `clientId`
3. OAuth PKCE 授权（浏览器打开 → 粘贴 code）
4. 小文件上传 → 下载 → 内容校验
5. 过期签名 / 篡改签名拒绝测试
6. 删除 + 二次确认不可下载
7. 可选：10MB 大文件分片上传（带上传/下载速度统计）
8. 可选：切回 local 后端

---

## 10. 撤销授权

```bash
curl -b cookies.txt -X POST http://localhost:3001/api/aliyundrive/oauth/revoke
```

预期：`{"revoked":true}`。再次检查状态 → `authorized: false`。

---

## 验收清单

| # | 功能 | 操作 | 预期结果 |
|---|------|------|----------|
| 1 | Server 启动 | `pnpm dev` | 阿里云盘路由全部映射，`Storage provider: local` |
| 2 | 未配置状态 | `GET /api/aliyundrive/status` | `configured: false` |
| 3 | 保存配置 | `PUT /api/aliyundrive/config` | 配置已保存，无 clientSecret 泄漏 |
| 4 | 缺少 clientId | `PUT /api/aliyundrive/config { }` | 400 |
| 5 | 启动 OAuth | `POST /api/aliyundrive/oauth/start` | 返回 authorizationUrl + state |
| 6 | 浏览器授权 | 打开 URL → 授权 → 复制 code | 页面返回 code |
| 7 | token 交换 | `POST /api/aliyundrive/oauth/complete` | `authorized: true` |
| 8 | session 过期 | 等 10 分钟后用旧 state | 400 `"OAuth 会话已过期"` |
| 9 | 状态已授权 | `GET /api/aliyundrive/status` | `authorized: true`, 有 driveId |
| 10 | 查看当前后端 | `GET /api/storage/config` | `kind: "local"` |
| 11 | 切换到 alibaba | `PUT /api/storage/config { kind: "alibaba" }` | 日志显示 `Storage provider: alibaba` |
| 12 | 获取上传令牌 | `POST /api/storage/upload-token` | 返回预签名 PUT URL |
| 13 | 上传小文件 | PUT 上传令牌 URL | `key: <阿里云盘 fileId>, size: N` |
| 14 | 上传签名过期 | PUT 过期 URL | 403 |
| 15 | 上传签名篡改 | PUT 错误 sig 的 URL | 403 |
| 16 | 大文件上传（可选） | PUT 10MB 数据 | 正常返回 + 速度统计 |
| 17 | 获取下载令牌 | `POST /api/storage/download-token` | 返回预签名 GET URL |
| 18 | 下载 & 内容一致 | GET 下载 URL | 返回原文 |
| 19 | 下载签名篡改 | GET 错误 sig 的 URL | 403 |
| 20 | 下载签名过期 | GET 过期 URL | 403 |
| 21 | 删除文件 | `DELETE /api/storage/<key>` | `ok: true` |
| 22 | 删除后不可下载 | GET 下载已删文件 | 400+ |
| 23 | 切回 local | `PUT /api/storage/config { kind: "local" }` | 日志 `Storage provider: local` |
| 24 | 撤销授权 | `POST /api/aliyundrive/oauth/revoke` | `revoked: true` |
| 25 | 一键测试脚本 | `node scripts/test-aliyundrive.cjs` | 全部 PASS |

---

## 实现总结

| 模块 | 文件 | 说明 |
|------|------|------|
| 类型定义 | `providers/alibaba-types.ts` | AlibabaStorageConfig 接口、常量 |
| OpenAPI 客户端 | `providers/alibaba-openapi.client.ts` | 阿里云盘 11 个 API 方法封装 |
| StorageProvider | `providers/alibaba-storage.provider.ts` | 实现 upload/download/delete/sign/verify 8 个方法 |
| OAuth 端点 | `aliyundrive.controller.ts` | config/oauth/status 共 6 个 REST 端点 |
| Provider 注册 | `providers/providers.registry.ts` | `alibaba: AlibabaStorageProvider` |
| 存储配置端点 | `storage.controller.ts` | `GET/PUT /api/storage/config` |
| 后端热切换 | `storage.service.ts` | `getBackendConfig` / `updateBackendConfig` |
| 测试脚本 | `scripts/test-aliyundrive.cjs` | 交互式全链路集成测试 |

## 已知限制

- 令牌刷新仅在内存中进行，Server 重启后从 DB 读取旧 token（refresh_token 通常长有效期内不受影响）
- 大文件上传走服务端代理（客户端 → Server → 阿里云盘），有带宽瓶颈；后续可优化为 Client 直传阿里云盘分片 URL
- 上传进度不可见（Stream → 临时文件 → 阿里云盘 API），后续可加进度回调
- 阿里云盘 API 有频率限制，并发大量上传可能被限流

## 边界

- OAuth PKCE 用 `plain` 模式（非 `S256`），适用于本地/内网环境
- 暂不支持 Client 端直传阿里云盘（带宽不经过 Server 代理）
- 暂不支持 S3 / OSS / minio 后端
