# VCPDeck 身份认证设计

> 最终确定方案，2025-07-15
>
> 参考讨论：`docs/identity-authentication-recommendations.md`

## 1. 核心原则

- **认证**回答"是谁"，不包含权限区分
- admin 和非 admin 的功能权限完全相同，admin 只多一个"管理其他身份"
- 整个系统只有一处权限判断：`/api/identities/**` 需要 `isAdmin`

## 2. 数据模型

### Identity

```prisma
model Identity {
  id           String         @id
  username     String         @unique
  displayName  String
  passwordHash String         // bcrypt
  isAdmin      Boolean        @default(false)
  disabledAt   DateTime?
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  credentials  Credential[]
  sessions     AuthSession[]
}
```

- `disabledAt`：禁用整个身份，不影响历史数据
- Identity 不物理删除
- 用户名可修改，但不能与其他用户重复

### Credential（CLI 长期 Token）

```prisma
model Credential {
  id         String    @id
  identityId String
  identity   Identity  @relation(fields: [identityId], references: [id])
  label      String              // "办公PC CLI"
  tokenHash  String    @unique   // SHA-256
  lastUsedAt DateTime?
  expiresAt  DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())
}
```

- Token 为 32 字节安全随机数，前缀 `vcp_`
- 数据库只存 SHA-256 摘要（高熵随机数不需要 bcrypt）
- 创建时只显示一次明文

### AuthSession（浏览器会话）

```prisma
model AuthSession {
  id          String    @id
  identityId  String
  identity    Identity  @relation(fields: [identityId], references: [id])
  sessionHash String    @unique   // SHA-256
  expiresAt   DateTime
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
}
```

- Session Token 为 32 字节安全随机数
- Cookie 存明文，数据库存 SHA-256

## 3. 认证流程

### 浏览器登录

```
POST /api/auth/login  { username, password }
  → bcrypt.compare
  → 检查 disabledAt
  → 创建 AuthSession
  → Set-Cookie: vcpdeck_session=xxx; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800
  → 返回 { identity: { id, username, displayName, isAdmin } }
```

### 浏览器登出

```
POST /api/auth/logout
  → 撤销当前 Session
  → 清除 Cookie
```

### 浏览器生成 CLI Token

```
POST /api/auth/tokens  { label: "办公PC" }
  → 生成随机 Token
  → SHA-256 存入 Credential
  → 返回 { id, token: "vcp_xxxxx", label }  // 明文只显示这一次
```

### CLI 使用 Token

```
Authorization: Bearer vcp_xxxxx
  → SHA-256 → 查 Credential → 查 Identity → ActorContext
```

### Bootstrap（首次启动）

```bash
VCPDECK_ADMIN_USERNAME=admin
VCPDECK_ADMIN_PASSWORD=<必填，无默认值>
```

Server 启动时检查数据库是否有 `isAdmin=true` 的身份，没有则用环境变量创建。

生产环境缺少 `VCPDECK_ADMIN_PASSWORD` 时拒绝启动。

## 4. API 设计

### 公开接口（无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/login` | 登录 |
| `GET` | `/api/health` | 健康检查 |

### 需认证（所有身份）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/me` | 当前身份信息 |
| `PUT` | `/api/auth/me` | 修改自己的用户名/密码 |
| `POST` | `/api/auth/tokens` | 生成 CLI Token |
| `GET` | `/api/auth/tokens` | 查看自己的 Token 列表 |
| `DELETE` | `/api/auth/tokens/:id` | 撤销自己的 Token |

### 需 admin 身份

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/identities` | 所有身份列表 |
| `POST` | `/api/identities` | 创建身份 |
| `POST` | `/api/identities/:id/disable` | 禁用身份 |
| `POST` | `/api/identities/:id/enable` | 启用身份 |

### 业务接口（所有身份可用，无权限区分）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/clients` | 客户端列表 |
| `GET` | `/api/jobs` | Job 列表 |
| `POST` | `/api/jobs` | 创建 Job |
| `GET` | `/api/jobs/:jobId` | Job 详情 |
| `POST` | `/api/jobs/:jobId/cancel` | 取消 Job |

## 5. AuthGuard 行为

全局守卫，默认拒绝。处理顺序：

```
1. Cookie 中有 vcpdeck_session → 查 AuthSession → 验证 → ActorContext(source=web)
2. Header 中有 Authorization: Bearer xxx → 查 Credential → 验证 → ActorContext(source=cli)
3. 都没有 → 401 { code: "AUTH_REQUIRED", message: "Authentication required" }
```

失败统一响应（不泄露用户是否存在、Token 是否有效）：

```json
{ "code": "AUTH_REQUIRED | AUTH_EXPIRED | AUTH_REVOKED | IDENTITY_DISABLED", "message": "..." }
```

## 6. ActorContext

```ts
interface ActorContext {
  identityId: string;
  displayName: string;
  isAdmin: boolean;
  credentialId: string | null;
  sessionId: string | null;
  source: "web" | "cli";
  requestId: string;
}
```

业务模块只能使用 `request.actor`，不能相信请求 body 中的身份字段。

## 7. 审计

Job 模型增加字段：

- `createdByIdentityId` — 创建者
- `createdByName` — 创建时显示名快照
- `createdVia` — `"web"` 或 `"cli"`

写操作（创建 Job、取消 Job、后续的文件操作、Agent 交互等）均记录 Actor。

## 8. Socket.IO

拆分为两个 namespace：

| namespace | 主体 | 认证 |
|-----------|------|------|
| `/client` | 远程机器 | PSK（不变） |
| `/app` | 用户（浏览器/CLI） | Session Cookie / Bearer Token |

- `/app` namespace：浏览器 Cookie 自动发送，CLI 在 handshake `auth.token` 中传 Token
- 验证后写入 `socket.data.actor`，后续事件不信任 payload 中的身份字段

## 9. 配置

```bash
VCPDECK_FRONTEND_ORIGIN=http://localhost:5173
VCPDECK_SESSION_TTL_SECONDS=604800       # 7天
VCPDECK_COOKIE_SECURE=false              # 开发环境 false，生产 true
VCPDECK_ADMIN_USERNAME=admin
VCPDECK_ADMIN_PASSWORD=xxx               # 必填
VCPDECK_CLIENT_PSK=xxx                   # 远程客户端 PSK
```

## 10. 明确不做

- JWT / Refresh Token
- OAuth / OIDC / SSO / 第三方登录
- 自助注册、邮箱验证、密码找回
- RBAC / Role / Permission / Group / Policy 表
- 多租户
- Web 身份管理后台之外的远程管理（首版 admin 操作也在浏览器完成）

以后出现真实需求时再增加授权层。
