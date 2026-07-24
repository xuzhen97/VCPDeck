# VCPDeck 身份认证系统设计

> 状态：已确认 | 2025-07-15

## 目标

为 VCPDeck 实现统一的身份认证：浏览器用用户名+密码登录，CLI 用浏览器生成的 Access Token 调用。admin 可以管理其他身份，所有身份的功能权限完全相同。

## 非目标（本次不实现）

- RBAC / Role / Permission / Group / Policy 表
- JWT / Refresh Token / OAuth / OIDC / SSO
- 自助注册、邮箱验证、密码找回
- 多租户、组织隔离
- Web 端身份管理之外的远程管理手段
- 每次请求同步更新 Credential.lastUsedAt（后续异步/节流实现）

---

## 1. 数据模型

### 1.1 Identity

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

- 不物理删除，禁用身份保留历史关联
- 用户名可修改，不得与其他用户重复
- `isAdmin` 仅控制身份管理接口访问

### 1.2 Credential（CLI 长期 Token）

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

- Token 明文：32 字节 `crypto.randomBytes(32)` → hex，前缀 `vcp_`
- 数据库仅存 SHA-256 摘要（高熵随机数不需要 bcrypt）
- 创建时返回唯一一次明文

### 1.3 AuthSession（浏览器会话）

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

- Session Token：32 字节随机数 → hex
- Cookie 存明文，数据库存 SHA-256
- 默认 7 天过期，不自动续期

### 1.4 Job 审计字段

在现有 Job 模型上新增：

```prisma
model Job {
  // ...现有字段...
  createdByIdentityId String?
  createdByName       String?   // 创建时显示名快照
  createdVia          String?   // "web" | "cli"
}
```

### 1.5 数据库变更汇总

```
新增表：Identity, Credential, AuthSession
变更表：Job（新增 createdByIdentityId, createdByName, createdVia）
```

---

## 2. 认证流程

### 2.1 Bootstrap（首次启动）

```ts
// Server 启动时
async function bootstrapAdmin() {
  const adminCount = await prisma.identity.count({ where: { isAdmin: true } });
  if (adminCount > 0) return;

  const username = process.env.VCPDECK_ADMIN_USERNAME || "admin";
  const password = process.env.VCPDECK_ADMIN_PASSWORD;
  if (!password) {
    throw new Error("VCPDECK_ADMIN_PASSWORD is required for first boot");
  }

  await prisma.identity.create({
    data: {
      id: nanoid(),
      username,
      displayName: username,
      passwordHash: await bcrypt.hash(password, 10),
      isAdmin: true,
    },
  });
}
```

### 2.2 浏览器登录

```
POST /api/auth/login  { username, password }
  → 查 Identity by username
  → bcrypt.compare(password, identity.passwordHash)
  → 检查 identity.disabledAt !== null → 401 IDENTITY_DISABLED
  → 生成 Session Token → SHA-256 → 插入 AuthSession
  → Set-Cookie:
      vcpdeck_session=<token-hex>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800
  → 返回 { identity: { id, username, displayName, isAdmin } }
```

### 2.3 浏览器生成 CLI Token

```
POST /api/auth/tokens  { label: "办公PC" }
  → AuthGuard → request.actor
  → 生成 32 字节随机数 → hex → "vcp_" + hex
  → SHA-256 → 插入 Credential
  → 返回 { id, token: "vcp_xxxxx", label }
```

明文 Token 不在日志、数据库或任何后续响应中出现。

### 2.4 CLI 调用

```
请求头: Authorization: Bearer vcp_xxxxx
  → AuthGuard
    → 截取 "Bearer " 之后的内容
    → SHA-256 → 查 Credential（唯一索引）
    → 检查 revokedAt、expiresAt
    → 查关联 Identity，检查 disabledAt
    → request.actor = { identityId, displayName, isAdmin, credentialId, source: "cli", requestId }
```

### 2.5 修改自己的用户名/密码

```
PUT /api/auth/me  { username?, password?, currentPassword }
  → AuthGuard → request.actor
  → bcrypt.compare(currentPassword, identity.passwordHash) // 验证当前密码
  → 如果 username 变更：检查唯一性
  → 如果 password 变更：bcrypt.hash 替换
```

---

## 3. API 设计

### 3.1 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/login` | 登录 |
| `GET` | `/api/health` | 健康检查 |

### 3.2 需认证（所有身份）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/me` | 当前身份 |
| `PUT` | `/api/auth/me` | 修改用户名/密码 |
| `POST` | `/api/auth/tokens` | 生成 CLI Token |
| `GET` | `/api/auth/tokens` | 我的 Token 列表 |
| `DELETE` | `/api/auth/tokens/:id` | 撤销某个 Token |

### 3.3 admin 专属

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/identities` | 身份列表 |
| `POST` | `/api/identities` | 创建身份 |
| `POST` | `/api/identities/:id/disable` | 禁用身份 |
| `POST` | `/api/identities/:id/enable` | 启用身份 |

### 3.4 现有业务接口（不变，加上 AuthGuard）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/clients` | 客户端列表 |
| `POST` | `/api/jobs` | 创建 Job |
| `GET` | `/api/jobs` | Job 列表 |
| `GET` | `/api/jobs/:jobId` | Job 详情 |
| `POST` | `/api/jobs/:jobId/cancel` | 取消 Job |

---

## 4. AuthGuard

### 4.1 全局守卫逻辑

```ts
@Injectable()
class AuthGuard implements CanActivate {
  // 检查 @Public() 装饰器 → 跳过
  // 1. Cookie: vcpdeck_session → SHA-256 → 查 AuthSession → 验证 → source="web"
  // 2. Header: Authorization: Bearer xxx → SHA-256 → 查 Credential → 验证 → source="cli"
  // 3. 都没有 → 401 { code: "AUTH_REQUIRED" }
}
```

### 4.2 ActorContext

```ts
interface ActorContext {
  identityId: string;
  displayName: string;
  isAdmin: boolean;
  credentialId: string | null;
  sessionId: string | null;
  source: "web" | "cli";
  requestId: string;  // nanoid
}
```

挂到 `request.actor`。业务 controller 从 `request.actor` 取，不相信 body 中的身份字段。

### 4.3 错误码

```text
AUTH_REQUIRED   — 未提供凭证
AUTH_INVALID    — 凭证无效
AUTH_EXPIRED    — Session 过期
AUTH_REVOKED    — Token/Session 已被撤销
IDENTITY_DISABLED — 身份已禁用
FORBIDDEN       — 非 admin 访问身份管理接口
```

所有认证失败返回统一格式，不区分"用户不存在"和"密码错误"。

---

## 5. Socket.IO 拆分

### 5.1 当前状态

```ts
@WebSocketGateway({ cors: { origin: "*" } })
export class EventsGateway {
  handleConnection(client: Socket) {
    // PSK 验证 → 所有连接共用同一 namespace
  }
}
```

### 5.2 目标结构

拆为两个 Gateway 文件：

**ClientGateway**（`/client` namespace，远程机器）：

```ts
@WebSocketGateway({ namespace: "/client", cors: { origin: "*" } })
export class ClientGateway {
  // 原有 PSK 逻辑不变
  // handleRegister, handleHeartbeat, handleStatusReport, ...
}
```

**AppGateway**（`/app` namespace，用户）：

```ts
@WebSocketGateway({
  namespace: "/app",
  cors: { origin: FRONTEND_ORIGIN, credentials: true }
})
export class AppGateway {
  handleConnection(client: Socket) {
    // 浏览器：从 Cookie 取 session → 验证
    // CLI：从 handshake.auth.token 取 Bearer Token → 验证
    // → socket.data.actor = actorContext
  }

  @SubscribeMessage(Events.AGENT_INPUT)
  handleAgentInput(@ConnectedSocket() client: Socket, @MessageBody() data) {
    // 从 client.data.actor 取身份，不信任 payload
  }
}
```

### 5.3 用户侧需要认证的 Socket 操作

- 订阅 Job 实时日志（`job:stdout` / `job:stderr`）
- Agent 交互（发送 input、steer、cancel、finish）
- 后续新增的交互式操作

`job:update` 广播事件保持当前行为（所有连接可接收，不需要认证）。

---

## 6. 身份管理与安全

### 6.1 admin 创建身份

```
POST /api/identities  { username, password, displayName }
  → AuthGuard → request.actor.isAdmin === true
  → bcrypt.hash(password, 10) → 插入 Identity
```

### 6.2 密码存储

使用 bcrypt，cost factor 10。修改密码时需提供 `currentPassword`。

### 6.3 日志脱敏

以下字段不写入日志：

```
Authorization, Cookie, Set-Cookie, password, currentPassword
body.token, body.password
```

### 6.4 登录限流

对 `/api/auth/login` 做基础频率限制（同一 IP 连续失败后递增延迟），防止暴力破解。

### 6.5 Cookie 安全

- 生产环境：`HttpOnly; Secure; SameSite=Strict`
- 开发环境：`VCPDECK_COOKIE_SECURE=false` 关闭 Secure
- CORS：`origin` 严格使用 `VCPDECK_FRONTEND_ORIGIN`

---

## 7. 配置

```bash
VCPDECK_FRONTEND_ORIGIN=http://localhost:5173   # 必填
VCPDECK_ADMIN_USERNAME=admin                    # 可选，默认 admin
VCPDECK_ADMIN_PASSWORD=xxx                      # 首次启动必填
VCPDECK_SESSION_TTL_SECONDS=604800              # 可选，默认 7 天
VCPDECK_COOKIE_SECURE=false                     # 生产 true
VCPDECK_CLIENT_PSK=xxx                          # 现有，必填
```

---

## 8. 变更清单

| 位置 | 变更 |
|------|------|
| `packages/shared/src/` | 新增 `ActorContext`、认证相关类型、错误码常量 |
| `packages/server/prisma/schema.prisma` | 新增 Identity/Credential/AuthSession；Job 新增审计字段 |
| `packages/server/src/auth/` | 新建模块：AuthModule、AuthController、AuthService、AuthGuard、actor.decorator.ts |
| `packages/server/src/identity/` | 新建模块：IdentityModule、IdentityController、IdentityService |
| `packages/server/src/events/` | 拆分为 `client.gateway.ts`（/client）和 `app.gateway.ts`（/app），拆分 EventsModule |
| `packages/server/src/job/job.service.ts` | create/cancel 方法接收 ActorContext，写审计字段 |
| `packages/server/src/events/events.controller.ts` | 方法注入 `request.actor`，传给 JobService |
| `packages/server/src/app.module.ts` | 注册 AuthModule、IdentityModule、拆分后的 Gateway |
| `packages/server/src/main.ts` | bootstrapAdmin() + Cookie Parser + CORS 配置 |
| `packages/server/package.json` | 新增依赖：bcrypt（或 bcryptjs） |
| `packages/frontend/src/` | 新增登录页、身份管理页（admin）、Token 管理页、me 接口调用 |

---

## 9. 验收标准

### Bootstrap

- 首次启动无 admin 时自动创建，VCPDECK_ADMIN_PASSWORD 缺失时拒绝启动
- 已有 admin 时跳过 bootstrap

### 登录

- 用户名+密码正确 → 返回身份信息 + 设置 Cookie
- 用户名或密码错误 → 401 AUTH_INVALID（不区分具体原因）
- 身份已禁用 → 401 IDENTITY_DISABLED

### CLI Token

- 已登录用户可生成 Token，返回明文仅一次
- 生成的 Token 可调用所有业务接口
- 撤销 Token 后立即失效
- 数据库中不存在 Token 明文

### 身份管理

- admin 可创建、查看、禁用、启用身份
- 非 admin 访问 `/api/identities/**` → 403 FORBIDDEN
- 禁用的身份所有凭证立即失效

### 业务接口

- 无凭证访问 /api/** → 401
- 有效凭证可使用所有功能（admin 和非 admin 无差异）
- 日志不包含密码和 Token 明文

### Socket.IO

- `/client` namespace 仅接受 PSK
- `/app` namespace 仅接受 Session Cookie 或 Bearer Token
- 未认证连接不能订阅 Job 日志或发送 Agent 输入
