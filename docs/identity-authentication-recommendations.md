# VCPDeck 多身份认证与审计归属建议

> 状态：建议稿，认证方向已确认
>
> 适用范围：VCPDeck Server、Frontend、CLI、应用侧 Socket.IO 与审计链路
>
> 不包含：Client 与 Server 之间的 PSK 协议改造

## 1. 目标

VCPDeck 当前阶段需要解决的是身份认证，而不是复杂授权：

- 浏览器和 CLI 使用系统前必须表明使用者身份。
- 支持多个使用者。
- 所有有效身份拥有相同使用权限。
- Server 必须可靠知道操作由谁发起。
- Job、文件操作、Pi Agent 输入和后续全链路日志必须能关联使用者。
- 可以禁用身份或撤销某台设备的凭证。
- Client 仍通过 PSK 连接 Server，人只通过 Server 使用系统。

本阶段明确不解决：

- 不同身份的功能权限差异
- 组织、租户和用户组
- 第三方登录
- 自助注册和密码找回

推荐方案：

> **Identity 表示“是谁”，AccessToken 和 BrowserSession 表示“如何证明身份”，ActorContext 表示“本次请求由谁发起”。**

CLI 使用个人 Access Token；浏览器首次粘贴个人 Access Token，验证成功后换取 HttpOnly Session Cookie。

---

## 2. 核心原则

### 2.1 认证与授权分开

认证回答：

> 当前调用者是谁？

授权回答：

> 当前调用者能做什么？

本阶段只实现认证。授权规则保持最小：

```text
身份有效且未禁用 -> 可以使用系统
身份无效、凭证撤销或过期 -> 拒绝访问
```

不要为了未来可能出现的权限差异提前增加 Role、Permission、Group 或 Policy 表。

### 2.2 身份只能来自已验证凭证

请求正文、Query、WebSocket payload 中的以下字段都不能作为身份事实：

```text
identityId
userId
createdBy
actor
operator
```

调用方可以伪造这些字段。正确流程是：

```text
Bearer Token / Session Cookie
  -> Server Authentication Module
  -> ActorContext
  -> Job/File/Agent 模块
  -> 审计记录
```

业务模块只能使用 Server 认证后生成的 ActorContext。

### 2.3 Client 身份与使用者身份隔离

VCPDeck 有两类不同主体：

| 主体 | 含义 | 认证方式 |
| --- | --- | --- |
| Identity | 通过浏览器或 CLI 使用系统的人 | Access Token / Browser Session |
| Client | 接受 Server 调度的远程机器 | PSK |

Client 不代表某个使用者，Client PSK 也不能用于浏览器或 CLI 登录。

---

## 3. 推荐的领域模型

```text
Identity：是谁
  ├── Credential：CLI 或浏览器首次登录所用的个人凭证
  └── AuthSession：浏览器登录后的短期会话
```

同一个 Identity 可以拥有多个 Credential 和 Browser Session：

```text
Identity：张三
  ├── Credential：办公电脑 CLI
  ├── Credential：个人笔记本 CLI
  └── AuthSession：Chrome 浏览器
```

撤销一台设备的 Credential 不影响同一身份的其他设备。

### 3.1 Identity

建议 Prisma 模型：

```prisma
model Identity {
  id          String        @id
  displayName String
  disabledAt  DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  credentials Credential[]
  sessions    AuthSession[]
}
```

字段语义：

- `id`：稳定身份标识，不使用显示名作为主键。
- `displayName`：界面和审计日志中的可读名称。
- `disabledAt`：禁用整个身份；保留历史关联。
- Identity 不应物理删除，否则历史 Job 和审计记录可能失去归属。

首版不需要用户名、邮箱、密码、角色和权限字段。

### 3.2 Credential

```prisma
model Credential {
  id         String    @id
  identityId String
  identity   Identity  @relation(fields: [identityId], references: [id])
  label      String
  tokenHash  String    @unique
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  expiresAt  DateTime?
  revokedAt  DateTime?
}
```

字段语义：

- `label`：区分设备，例如“办公电脑 CLI”。
- `tokenHash`：个人 Access Token 的 SHA-256 摘要。
- `expiresAt`：可选过期时间；内部长期设备 Token 可暂不设置。
- `revokedAt`：只撤销一个凭证。
- `lastUsedAt`：用于排查遗失或长期未使用的凭证。

不应在每个请求中同步更新 `lastUsedAt`，避免产生无价值的数据库写入。可以按小时节流或异步更新。

### 3.3 AuthSession

```prisma
model AuthSession {
  id           String     @id
  identityId   String
  identity     Identity   @relation(fields: [identityId], references: [id])
  credentialId String?
  sessionHash  String     @unique
  createdAt    DateTime   @default(now())
  lastUsedAt   DateTime?
  expiresAt    DateTime
  revokedAt    DateTime?
}
```

浏览器 Cookie 保存原始 Session Token；数据库只保存其摘要。

`credentialId` 用于回答“这个浏览器会话由哪个个人 Token 换取”，便于撤销和审计。撤销 Credential 时是否同时撤销由它创建的 Browser Session，首版建议执行级联撤销。

---

## 4. Token 设计

### 4.1 Access Token

使用 Node.js 标准库生成至少 32 字节密码学安全随机数：

```ts
randomBytes(32)
```

推荐可识别格式：

```text
vcp_<随机内容>
```

前缀只用于识别凭证类型，不参与授权。

Access Token：

- 创建时只显示一次。
- 不写入普通日志。
- 不存入数据库明文。
- 不通过 URL 或命令参数传递。
- Server 收到后计算 SHA-256，再使用唯一索引查询 Credential。

高熵随机 Token 可以使用 SHA-256 摘要存储。它不同于低熵用户密码，不需要 bcrypt、scrypt 或 Argon2。

### 4.2 Browser Session Token

Browser Session Token 同样使用至少 32 字节安全随机数，数据库只保存 SHA-256 摘要。

建议默认有效期先设为 7 天。当前目标是内部系统的简单认证，不需要 Refresh Token。会话过期后重新粘贴个人 Access Token 登录即可。

具体期限应由配置提供，但首版只保留一个 Server 配置值，不建立复杂的每身份会话策略。

---

## 5. CLI 认证流程

CLI 使用标准 Bearer Token：

```http
Authorization: Bearer vcp_xxxxx
```

流程：

```text
用户在 Server 本机获得个人 Access Token
  -> CLI 保存 Token
  -> CLI 请求 REST 或连接应用侧 Socket.IO
  -> Server 验证 Credential
  -> Server 生成 ActorContext
  -> 业务模块执行并写入审计
```

### 5.1 CLI Token 存储

推荐优先级：

1. 操作系统凭证存储；在真正需要时实现。
2. `~/.vcpdeck/config.json`，限制为当前用户可读。
3. 环境变量 `VCPDECK_TOKEN`，适合临时运行和 CI。

首版可使用配置文件和环境变量，不必引入新的密钥库依赖。

不推荐：

```bash
vcpdeck --token vcp_xxxxx jobs create
```

命令参数可能进入 Shell history、进程列表和审计日志。

### 5.2 CLI 来源标记

CLI 可以发送：

```http
X-VCPDeck-Client: cli
```

该 Header 只用于标记入口来源，不能决定身份。身份必须来自 Bearer Token。

Server 可以把来源规范化为：

```text
web
cli
system
```

---

## 6. 浏览器认证流程

浏览器采用“个人 Access Token 换 HttpOnly Session Cookie”：

```text
打开登录页
  -> 用户粘贴个人 Access Token
  -> POST /api/auth/session
  -> Server 验证 Credential 和 Identity
  -> Server 创建 AuthSession
  -> 返回 HttpOnly Session Cookie
  -> 前端清空输入框中的 Token
  -> 后续 REST 和 Socket.IO 使用 Cookie
```

不应把长期 Access Token 保存到：

```text
localStorage
sessionStorage
IndexedDB
普通可读 Cookie
```

### 6.1 Cookie 设置

生产环境建议：

```http
Set-Cookie: vcpdeck_session=<session-token>;
  HttpOnly;
  Secure;
  SameSite=Strict;
  Path=/;
  Max-Age=<configured-seconds>
```

要求：

- 生产环境必须使用 HTTPS/WSS，并启用 `Secure`。
- 本地 HTTP 开发环境可以通过显式开发配置关闭 `Secure`。
- Cookie 名称和有效期由 Server 固定配置，不接受前端指定。
- Logout 时撤销 Server Session，并清除 Cookie。

### 6.2 CSRF

`SameSite=Strict` 可以降低 CSRF 风险，但所有使用 Cookie 的写请求仍应验证 `Origin` 是否属于配置的 Frontend Origin。

首版不需要再引入 CSRF Token，前提是：

- 使用 `SameSite=Strict`
- 严格限制 CORS Origin
- 写请求校验 `Origin`
- 不支持跨站嵌入使用

如果以后需要跨站部署，再重新设计 CSRF 策略。

---

## 7. Server Authentication Module

建议 Authentication Module 对外只提供一个核心结果：

```ts
interface ActorContext {
  identityId: string;
  displayName: string;
  credentialId: string | null;
  sessionId: string | null;
  source: "web" | "cli" | "system";
  requestId: string;
}
```

字段说明：

- `identityId`：稳定身份关联。
- `displayName`：本次请求使用的显示名快照。
- `credentialId`：使用的 Access Token；浏览器会话可以追溯其来源。
- `sessionId`：浏览器 Session，可空。
- `source`：入口来源，不代表权限。
- `requestId`：当前 HTTP/Socket 操作的日志关联 ID。

业务模块不解析 Token 和 Cookie，只接收 ActorContext：

```text
JobService.create(..., actor)
JobService.cancel(..., actor)
AgentService.sendInput(..., actor)
FileService.delete(..., actor)
```

这使认证逻辑集中在一个 seam，避免每个模块自行实现身份解析。

---

## 8. REST 认证

建议使用 NestJS 全局 AuthGuard：

```text
Bearer Access Token
或 HttpOnly Session Cookie
  -> 验证凭证和 Identity 状态
  -> request.actor = ActorContext
```

采用默认拒绝：所有 `/api/**` 默认需要认证，只有明确标记的入口公开。

首批公开入口：

```text
GET  /api/health
POST /api/auth/session
```

建议认证接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/session` | Access Token 换 Browser Session |
| `DELETE` | `/api/auth/session` | 撤销当前 Browser Session 并清 Cookie |
| `GET` | `/api/auth/me` | 返回当前身份和入口信息 |

`DELETE /api/auth/session` 和 `GET /api/auth/me` 本身需要有效 Session 或 Bearer Token。

登录请求中的 Token 必须避免被 NestJS 请求日志、反向代理日志和错误详情记录。

### 8.1 认证失败响应

统一返回安全错误：

```json
{
  "statusCode": 401,
  "code": "AUTH_REQUIRED",
  "message": "Authentication required"
}
```

建议稳定错误码：

```text
AUTH_REQUIRED
AUTH_INVALID
AUTH_EXPIRED
AUTH_REVOKED
IDENTITY_DISABLED
```

不要告诉调用方 Token 是否曾经存在，也不要返回数据库或凭证内部信息。

---

## 9. Socket.IO 认证与 Gateway 隔离

建议分离两类 Socket.IO 连接：

```text
/client namespace
  -> 远程 Client
  -> PSK 认证

/app namespace
  -> Browser / CLI
  -> Access Token 或 Browser Session 认证
```

这样可以避免：

- 浏览器接触 Client PSK
- Client 订阅面向用户的全部事件
- 在同一个连接中猜测主体类型
- 用户消息和 Client 状态上报混用同一认证上下文

### 9.1 Client Gateway

Client Gateway 继续验证 PSK，并把已注册的 `clientId` 绑定到 Socket。后续 heartbeat、status report 和 Job 结果仍需验证事件来自与 Job 匹配的 Client Socket。

本建议不要求立即改为每台 Client 独立 PSK，但共享 PSK 不能被视为可靠的“哪台机器”身份证明；机器身份仍需通过注册和 Socket 绑定校验。

### 9.2 Application Gateway

Browser 通过 Session Cookie 连接；CLI 在 handshake 中发送 Access Token：

```ts
io(serverUrl + "/app", {
  auth: { token: process.env.VCPDECK_TOKEN },
});
```

Server 验证后写入：

```ts
socket.data.actor = actorContext;
```

后续操作只能从 `socket.data.actor` 获取身份，不能相信消息 payload 中的身份字段。

应用侧 Socket.IO 需要认证的操作包括：

- 订阅 Job 实时日志
- Attach/Detach Pi Agent Job
- 发送 Agent 输入
- Cancel/Finish Job
- 执行以后新增的交互式文件操作

当前 Gateway 的 `cors: { origin: "*" }` 不适用于浏览器身份认证。应改为配置的精确 Frontend Origin，并允许凭证 Cookie。

---

## 10. 身份与 Job 审计

### 10.1 Job 创建者

Job 至少需要保存：

```text
createdByIdentityId
createdByName
createdVia
```

其中：

- `createdByIdentityId` 用于稳定关联 Identity。
- `createdByName` 保存创建时显示名快照。
- `createdVia` 标记 `web / cli / system`。

显示名快照可以保证 Identity 改名后，历史记录仍展示操作发生时的名称。

### 10.2 JobEvent Actor

不只是创建 Job 需要身份。以下操作也必须记录 Actor：

- 取消 Job
- 完成交互式 Job
- 向 Pi Agent 发送 prompt、steer 或 follow-up
- 批准未来的危险操作
- 删除、覆盖或移动文件
- 创建关联的修复 Job

建议 JobEvent 中保存：

```ts
interface ActorRef {
  identityId: string;
  displayName: string;
  source: "web" | "cli" | "system";
}
```

`credentialId` 和 `sessionId` 可以保存在受控审计元数据中，不必返回给普通前端。

示例：

```json
{
  "type": "user.message",
  "jobId": "job-123",
  "actor": {
    "identityId": "identity-123",
    "displayName": "张三",
    "source": "web"
  },
  "payload": {
    "content": "可以开始修改了"
  }
}
```

这样可以区分：

- 谁创建了任务
- 谁中途改变了方向
- 谁批准了操作
- 谁取消或确认完成

### 10.3 System Actor

调度、自动重试和 Workflow 可能由系统触发。建议保留：

```text
source = system
```

System Actor 必须包含触发原因和父 Job/Event 关联，不能伪装成某个真人身份。

---

## 11. 身份管理方式

由于所有有效身份权限相同，不能立刻开放“所有身份都能管理身份”的 Web 接口。否则任何使用者都能创建、禁用或撤销其他身份。

首版建议只允许在 Server 本机执行管理命令：

```bash
pnpm identity:create "张三"
pnpm identity:token <identityId> --label "办公电脑 CLI"
pnpm identity:revoke-token <credentialId>
pnpm identity:disable <identityId>
pnpm identity:enable <identityId>
pnpm identity:list
```

命令名称可在实现时按现有 CLI 结构调整，但语义应保持稳定。

Token 创建时只显示一次：

```text
Identity: 张三
Credential: 办公电脑 CLI
Token: vcp_xxxxx

Save this token now. It will not be shown again.
```

Identity 管理暂不进入 VCPDeck 普通应用权限面。以后确实需要远程身份管理时，再引入最小的管理员授权，而不是现在提前建立 RBAC。

### 11.1 初始身份引导

首次部署需要一个明确的 bootstrap 流程：

1. Server 完成数据库迁移。
2. 运维者在 Server 本机创建第一个 Identity。
3. 为该 Identity 签发个人 Access Token。
4. 使用该 Token 登录浏览器或配置 CLI。

Server 不应在启动日志中自动生成和打印默认 Token，也不能保留默认开发身份。

---

## 12. 撤销、禁用与过期

### 12.1 撤销单个 Credential

适用于设备丢失或 Token 泄漏：

```text
Credential.revokedAt = now
关联 Browser Session 同时 revoked
其他 Credential 继续可用
```

### 12.2 禁用整个 Identity

```text
Identity.disabledAt = now
该 Identity 的全部 Access Token 和 Browser Session 立即失效
历史 Job 和 JobEvent 保留身份关联
```

验证每个请求时都必须检查 Identity 状态，不能只在创建 Browser Session 时检查一次。

### 12.3 Session 过期

过期 Session 返回 `401 AUTH_EXPIRED`，浏览器清除本地 Cookie 并回到登录页。不要自动延长为无限会话。

首版可以使用固定有效期，不实现滑动过期。若后续用户体验确有需要，再增加受控续期。

---

## 13. 配置建议

首版只需要少量 Server 配置：

```text
VCPDECK_FRONTEND_ORIGIN
VCPDECK_SESSION_TTL_SECONDS
VCPDECK_COOKIE_SECURE
VCPDECK_CLIENT_PSK
```

要求：

- 生产环境缺少 Client PSK 或 Frontend Origin 时拒绝启动。
- 不再使用可预测的默认生产 PSK。
- `VCPDECK_COOKIE_SECURE=false` 只允许明确的本地开发环境。
- 配置值和 Secret 不写入日志。

不需要增加通用配置中心或动态认证策略系统。

---

## 14. 安全要求

### 14.1 必须满足

1. Access Token 和 Session Token 至少使用 32 字节安全随机数。
2. 数据库只保存 Token 摘要。
3. Token 创建时只显示一次。
4. 支持单 Credential 撤销和整个 Identity 禁用。
5. 生产环境使用 HTTPS/WSS。
6. Browser Cookie 使用 `HttpOnly + Secure + SameSite=Strict`。
7. CORS 只允许配置的 Frontend Origin，不使用 `*`。
8. Cookie 写请求校验 `Origin`。
9. 登录接口增加基础频率限制。
10. 日志不记录 Token、Cookie、Authorization 或完整认证请求正文。
11. 身份只从 ActorContext 获取，不从业务 payload 获取。
12. CLI Token 不通过命令参数或 URL 传递。
13. Client PSK 与用户 Token 使用不同认证入口和密钥空间。
14. 所有认证比较和查询失败统一返回安全错误。
15. 反向代理不得记录认证 Header 和登录请求正文。

### 14.2 日志脱敏

至少脱敏：

```text
Authorization
Cookie
Set-Cookie
auth.token
body.token
VCPDECK_TOKEN
VCPDECK_CLIENT_PSK
```

审计可以记录 Credential ID、Session ID 和 Identity ID，但普通业务日志不应展示凭证明文或摘要。

### 14.3 凭证泄漏响应

发现 Token 泄漏时：

1. 撤销对应 Credential。
2. 撤销由它创建的 Browser Session。
3. 查询该 Credential 最近使用时间和关联审计记录。
4. 为同一 Identity 签发新 Credential。
5. 不修改或删除历史 Job，以保留调查证据。

---

## 15. 分阶段落地建议

### 阶段一：Identity 与 CLI Bearer Token

实现：

- `Identity` 和 `Credential`
- Server 本地身份管理命令
- Access Token 生成、摘要、撤销和禁用
- 全局 REST AuthGuard
- `ActorContext`
- Job 创建、取消等写操作记录 Actor
- `/api/auth/me`

这个阶段即可让 CLI 具备明确身份。

### 阶段二：浏览器 Session

实现：

- `AuthSession`
- Token 换 Cookie 登录
- Logout
- Frontend 登录页和登录状态恢复
- Cookie、Origin、CORS 和基础登录限流

### 阶段三：应用侧 Socket.IO

实现：

- `/client` 与 `/app` namespace 隔离
- Browser Cookie handshake
- CLI Token handshake
- `socket.data.actor`
- Job 日志订阅和 Pi Agent 交互记录 Actor

### 阶段四：审计完善

实现：

- Job 创建者快照
- JobEvent Actor
- Credential/Session 使用元数据
- 身份禁用和撤销后的调查视图
- 全链路 `requestId/jobId/runId/identityId` 关联

---

## 16. 验收标准

### Identity 与 Credential

- 可以创建多个 Identity。
- 同一 Identity 可以签发多个 Credential。
- 数据库中不存在 Access Token 和 Session Token 明文。
- 创建 Token 后无法通过接口再次读取明文。
- 撤销一个 Credential 不影响同一身份的其他 Credential。
- 禁用 Identity 后其所有凭证立即失效。

### CLI

- 无 Bearer Token 的受保护请求返回 401。
- 有效 Token 可以使用全部当前功能。
- Server 能在 Job 和审计事件中识别 CLI 使用者。
- CLI 不在命令参数、普通输出和错误日志中暴露 Token。

### Browser

- 用户可以粘贴 Access Token 登录。
- 登录成功后前端不持久化 Access Token。
- 后续请求使用 HttpOnly Cookie。
- Session 过期、撤销或 Identity 禁用后必须重新登录。
- Logout 后原 Session Token 不再有效。
- 非允许 Origin 不能携带 Cookie 调用写接口。

### Socket.IO

- Client 只能通过 Client PSK 连接 `/client`。
- Browser/CLI 只能通过用户身份凭证连接 `/app`。
- Browser 不需要也无法获得 Client PSK。
- 未认证应用 Socket 不能订阅 Job 日志或发送 Agent 输入。
- Server 从 `socket.data.actor` 写审计，不信任消息中的身份字段。

### 审计

- 每个 Job 能查询创建者和来源。
- Cancel、Finish、Agent Input、文件删除等操作能查询实际 Actor。
- Identity 改名后，历史记录仍可显示操作发生时的名称。
- System 自动操作与真人操作可以区分。
- 普通日志和审计记录均不包含凭证明文。

---

## 17. 明确不做

首版不实现：

- 用户名和密码登录
- RBAC、Role、Permission、Group
- OAuth、OIDC、SSO 或第三方登录
- 自助注册、邮箱验证和密码找回
- JWT 和 Refresh Token
- 多租户和组织隔离
- Web 身份管理后台
- 每个接口的细粒度权限策略
- 每次请求同步更新 Credential 使用时间
- 通用 Secret Manager 抽象

出现以下真实需求时再增加授权层：

- 某些身份只能查看，不能执行
- 只有部分身份可以删除文件或运行 Agent
- 只有管理员可以管理身份
- 不同团队只能访问各自 Client 和 Job

---

## 18. 最终推荐结构

```text
Server 本机身份管理命令
  -> 创建 Identity
  -> 签发个人 Access Token

CLI
  -> Bearer Access Token
  -> REST / Application Socket.IO
  -> ActorContext

Browser
  -> Access Token 换 HttpOnly Session Cookie
  -> REST / Application Socket.IO
  -> ActorContext

ActorContext
  -> Job.createdBy
  -> JobEvent.actor
  -> 文件操作审计
  -> Pi Agent 人工输入审计

Client
  -> Client Socket.IO namespace
  -> PSK
  -> 不代表人类使用者
```

核心原则：

> **Identity 负责“是谁”，Credential 和 AuthSession 负责“如何证明”，ActorContext 负责“本次操作由谁发起”，Job 和 JobEvent 负责保存审计事实。**

该方案满足当前多身份、同权限、浏览器与 CLI 登录、Job 审计和全链路追溯需求，同时不引入密码、RBAC、OAuth 和 JWT 的额外复杂度。
