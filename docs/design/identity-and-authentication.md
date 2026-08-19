# VCPDeck 身份与认证设计

> 状态：Current｜维护责任：Auth/Identity 维护者｜最后核验：2026-08-15｜适用版本：当前 `main`
>
> 事实来源：`packages/shared/src/index.ts`、`packages/server/src/auth/`、`packages/server/src/identity/`、`packages/server/src/events/app.gateway.ts`、`packages/server/src/main.ts`、Prisma schema、Frontend auth context

本文描述当前已经实现的业务身份、浏览器会话、Bearer Credential、ActorContext 和身份管理边界。opaque token 与服务端 Session 的长期选择见 [`ADR-0011`](../adr/0011-server-side-opaque-authentication-and-actor-context.md)；“所有有效业务身份均为可信远程操作者”的授权边界见 [`ADR-0009`](../adr/0009-trusted-operator-security-domain.md)。字段级端点以 Shared、Controller、SDK 和 [`protocols.md`](../protocols.md) 为准。

## 1. 范围与非目标

当前认证提供：

- 用户名和 bcrypt 密码登录；
- HttpOnly opaque Browser Session Cookie；
- 每个 Identity 可创建多个 opaque Bearer Credential；
- 全局 REST AuthGuard 默认拒绝；
- `/app` Socket.IO 的 Cookie 或 handshake token 认证；
- 请求/Socket 上的服务端 ActorContext；
- admin 身份创建、列出、禁用和启用 Identity；
- Identity 禁用、Browser Session 撤销和个人 Bearer Token 撤销；
- Job 创建者及部分交互生命周期的 Actor 归属。

当前不提供：

- OAuth、OIDC、SSO、JWT 或 Refresh Token；
- 自助注册、邮箱验证、密码找回或 MFA；
- Role/Permission/Group/Policy、多租户或资源级授权；
- 每 Client、项目、Job、File、Terminal 或 Pi 的访问隔离；
- 通用机器到机器 service account 类型；
- 完整不可抵赖审计、合规 Session 管理或集中密钥管理；
- 登录速率限制、失败锁定、验证码或异常登录检测。

Identity 认证只回答“是谁”。当前所有有效业务 Identity 都属于同一可信操作者域，admin 只额外拥有身份管理能力。

## 2. 主体与信任边界

VCPDeck 有三类不同主体：

| 主体 | 含义 | 当前认证 |
| --- | --- | --- |
| Identity | Browser、SDK 或自动化调用背后的人类操作者 | 密码换 Session Cookie，或 Bearer Credential |
| Client | 接受远程调度的机器代理 | `/client` 共享 PSK |
| Launcher | 本机进程守护和更新执行器 | 127.0.0.1 随机控制 Token |

三类凭证不能互换。Client PSK 不能用于用户登录，业务 Bearer Token 不能连接 `/client`，Launcher Token 也不能调用业务 API。

```text
Browser -- username/password --> Server -- opaque Cookie --> REST / /app
SDK/Automation -- Bearer vcp_* --> REST / /app
Client -- VCPDECK_PSK --> /client
```

## 3. 数据模型与权威

### 3.1 Identity

Identity 是稳定的操作者身份：

- `id` 为 UUID；
- `username` 全局唯一并可由本人修改；
- `displayName` 用于界面和 Actor 快照，当前没有自助修改入口；
- `passwordHash` 使用 bcrypt，当前 cost 为 10；
- `isAdmin` 只用于 `/api/identities/**`；
- `disabledAt` 表示身份禁用；
- Identity 当前不提供删除接口，历史引用得以保留。

### 3.2 Credential

Credential 是长期 Bearer Token 的数据库记录：

- 创建时生成 `vcp_` 加 32 字节安全随机数的十六进制文本；
- 明文只在创建响应中返回一次；
- SQLite 只保存 SHA-256 摘要；
- 每个 Credential 有 label、可选 expiresAt、revokedAt 和 lastUsedAt 字段；
- 当前创建 API 不接受 expiresAt，因而新 Token 默认长期有效，直到主动撤销或 Identity 禁用；
- 当前认证路径不更新 lastUsedAt。

高熵随机 Token 使用 SHA-256 摘要；低熵用户密码必须使用 bcrypt，二者不能混用。

### 3.3 AuthSession

AuthSession 是 Browser 登录后的服务端 Session：

- 登录时生成 32 字节安全随机 token；
- Browser Cookie 保存明文，SQLite 只保存 SHA-256 摘要；
- 默认有效期由 `VCPDECK_SESSION_TTL_SECONDS` 控制，当前默认 604800 秒；
- Session 有 expiresAt 和 revokedAt；
- 当前没有滑动续期、refresh、设备信息、lastUsedAt 或定期过期清理。

### 3.4 ActorContext

认证成功后 Server 创建：

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

ActorContext 是单次 HTTP 请求或 Socket 连接的身份事实。业务模块不能相信 body/query/Socket payload 中自报的 identityId、actor、createdBy 或 operator。

`source="cli"` 当前实际表示 Bearer Credential 入口，不证明调用方一定是仓库 CLI。仓库 CLI 当前业务能力主要是 Release upload：password 环境登录取得 Cookie 时审计来源仍是 web，Bearer 环境才记为 cli；不能把 Shared 的 source 名称理解为完整 CLI 能力或可靠的二进制身份。CLI 环境配置见 [`cli.md`](./cli.md)。

## 4. Browser 登录与 Cookie

```text
POST /api/auth/login {username,password}
  → 查询 Identity
  → 检查 disabledAt
  → bcrypt.compare
  → 创建 AuthSession
  → Set-Cookie vcpdeck_session=<opaque>
  → 返回 Identity 摘要
```

Cookie 当前属性：

- `HttpOnly`；
- `SameSite=Strict`；
- `Path=/`；
- `Max-Age=VCPDECK_SESSION_TTL_SECONDS`；
- `Secure` 默认启用，仅当 `VCPDECK_COOKIE_SECURE=false` 时关闭。

生产环境必须使用 HTTPS/WSS 并保持 Secure。开发环境使用 HTTP 时必须显式关闭 Secure，否则浏览器不会按预期发送 Cookie。

登录 Controller 当前抛出附加 `statusCode/code` 的普通 `Error`，但 Server 没有全局异常过滤器把它映射为 HttpException；无效凭证或 disabled Identity 可能表现为 500，而不是预期的 401 `AUTH_INVALID/IDENTITY_DISABLED`。`updateMe` 和部分 Credential 错误存在同类偏移。全局 Guard 对过期、撤销、无效 Credential、禁用 Identity 等失败统一返回 401 `AUTH_REQUIRED`，因此不能依赖所有 `AuthErrorCode` 都已端到端细分。

## 5. REST AuthGuard

除 `@Public()` 端点外，REST 默认需要认证。解析优先级：

1. `vcpdeck_session` Cookie；
2. `Authorization: Bearer <token>`；
3. 都无效则返回 401 `AUTH_REQUIRED`。

有效性检查每次都会重新读取 Identity，因此 disabled Identity 不能继续建立新的认证请求。Cookie 存在但无效时仍会继续尝试 Bearer；调用方不应同时发送两种身份不同的凭证。

当前公开端点不只 login/health，还包括：

- `POST /api/auth/login`；
- `GET /api/health`；
- `GET /api/status`；
- `GET /api/releases/:version/file`；
- 带有效签名的 Local Storage upload/download 端点。

公开端点仍须依靠签名、完整性、网络 ACL、反向代理限制和日志脱敏，不等于可安全无限制暴露公网。

## 6. `/app` Socket.IO 认证

`/app` 当前用于 Browser Terminal：

- 优先从 handshake Cookie 校验 AuthSession；
- 其次从 `handshake.auth.token` 校验 Credential；
- 认证后把 ActorContext 绑定到 Socket；
- Terminal handler 只读取绑定 Actor，不信任事件 payload 中的身份字段。

`/app` 的认证代码当前与 REST AuthGuard 分别实现，存在长期漂移风险。Identity 禁用、Session/Token 撤销发生后，已经建立的 Socket 不会被主动查找和断开；撤销只会阻止下一次握手或 HTTP 请求。需要立即止损时应同时断开相关连接或重启 Server，并核对 Terminal 会话。

## 7. Credential 生命周期

所有有效 Identity 可以管理自己的 Token：

```text
POST   /api/auth/tokens
GET    /api/auth/tokens
DELETE /api/auth/tokens/:id
```

- 创建只返回一次明文；
- list 不返回 tokenHash 或明文；
- revoke 只能操作 Actor 自己的 Credential；
- 已撤销 Credential 保留记录；
- `POST /api/auth/logout` 只撤销当前 Browser Session；若请求通过 Bearer 认证，actor.sessionId 为 null，logout 不会撤销该 Credential；Bearer 应使用 DELETE token 端点撤销。

当前 Token 创建、label 和列表接口没有严格 Shared 运行时 parser，Credential 也没有创建时过期策略和使用时间更新。

## 8. Identity 管理与 Bootstrap

身份管理端点：

```text
GET  /api/identities
POST /api/identities
POST /api/identities/:id/disable
POST /api/identities/:id/enable
```

每个 handler 在 Server 检查 `actor.isAdmin`。新建 Identity 固定为非 admin；当前没有提升/撤销 admin 的 API。

首次启动时：

1. Server 查询 `isAdmin=true` 的 Identity 数量；
2. 数量为零时读取 `VCPDECK_ADMIN_USERNAME`（默认 admin）和必填 `VCPDECK_ADMIN_PASSWORD`；
3. 使用 bcrypt 创建首个 admin；
4. 已存在任意 admin 记录时不再读取 bootstrap 密码。

当前 Bootstrap 只计算 isAdmin，不排除 disabled admin。管理员也可以禁用自己或最后一个 admin；此时 Session 会被撤销，而重启不会自动创建新 admin，可能造成管理面锁死。禁用前必须确认至少有另一个可用 admin；当前代码无法通过 API 创建第二个 admin，运维应特别保护首个 admin 数据。

## 9. 禁用、启用、密码修改与撤销语义

### Identity 禁用

当前 disable：

- 写入 disabledAt；
- 批量撤销该 Identity 未撤销的 AuthSession；
- 不把 Credential.revokedAt 批量写入；
- Guard 因 Identity disabled 拒绝 Cookie 和 Bearer。

### Identity 启用

当前 enable 只清除 disabledAt：

- 已撤销 Session 不会恢复；
- 未显式撤销且未过期的 Credential 会重新有效；
- 若禁用用于泄漏响应，必须另外逐个撤销 Credential，不能只 disable 后再 enable。

### 修改用户名或密码

`PUT /api/auth/me` 要求 currentPassword。当前修改密码不会撤销其他 Browser Session 或 Bearer Credential；怀疑密码/设备泄漏时还需禁用身份、撤销 Token 并处理既有 Socket。

## 10. 授权与审计

当前授权模型：

- 任意有效业务 Identity 都可访问所有 Client、Job、Files、Storage、FRP、Terminal、Pi 和 Release 业务面；
- admin 只额外调用 Identity 管理接口；
- Frontend 隐藏按钮、页面路由和确认弹窗都不是授权边界；
- Job/Client/File/Terminal/Pi/FRP 当前不按 Identity 隔离。

Actor 审计当前是局部实现：

- 通用 Job 可保存 createdByIdentityId、createdByName 和 createdVia；
- TerminalAudit 保存部分生命周期 Actor；
- Release 保存上传者名称和来源；
- Pi 保存 Owner 及部分控制身份；
- FRP service 直接创建的内部 Job 当前没有写 createdBy 字段；
- 不是所有修改、取消、输入、文件副作用和配置变更都有统一持久审计。

不能把当前 ActorContext 描述为已经形成完整合规审计链。

## 11. 安全与隐私

- 密码、Cookie、Bearer token、tokenHash 和登录 body 不得进入普通日志；
- Token 不通过 URL、命令参数、Issue 或聊天传递；CLI 命名环境只保存 passwordEnv/tokenEnv 引用；直连兼容参数 `--password` 仍可能暴露到 Shell history/进程列表，不推荐使用；
- 反向代理不得记录 Authorization、Cookie、Set-Cookie 或登录请求正文；
- `VCPDECK_FRONTEND_ORIGIN` 应配置为精确可信 Origin；
- 当前没有独立 Origin/CSRF Guard、CSRF Token 或登录 rate limit，不能只凭 SameSite=Strict 声称完整防护；
- Login/CreateIdentity/UpdateMe/CreateToken 主要依赖 TypeScript DTO，缺少严格运行时 parser、未知字段拒绝和统一服务端长度/强度限制；
- SQLite 含 passwordHash、Session/Credential 摘要、Job 敏感正文和外部凭据，备份应加密并限制读取；
- 摘要泄漏仍需按凭证事件处理，尤其密码哈希可被离线猜测。

## 12. 配置与部署

| 变量 | 当前行为 |
| --- | --- |
| `VCPDECK_ADMIN_USERNAME` | 首次 bootstrap 用户名，默认 admin |
| `VCPDECK_ADMIN_PASSWORD` | 仅数据库不存在任何 admin 时必填 |
| `VCPDECK_SESSION_TTL_SECONDS` | Browser Session/Cookie 固定 TTL，默认 604800 |
| `VCPDECK_COOKIE_SECURE` | 未设时 true；仅显式 `false` 关闭 |
| `VCPDECK_FRONTEND_ORIGIN` | REST CORS 和 `/app` Origin，默认 localhost:5173 |
| `VCPDECK_PSK` | `/client` PSK；与用户认证分离 |

首次部署后不要长期把管理员密码留在普通 `.env`、Shell history 或发布构件中。当前 Server 只有发现“无 admin”才使用 bootstrap 密码；修改环境变量不会轮换已有管理员密码。

## 13. 运维与事件响应

日常检查：

- 是否只有一个可用 admin；
- disabled Identity、长期未用/无期限 Credential 和异常 Session 数量；
- 反向代理日志是否出现 Authorization/Cookie/login body；
- 是否存在本不应长期运行的 `/app` Socket 或 Terminal；
- SQLite 中过期/撤销 Session 和 Credential 的增长；
- Job、Terminal、Pi、Release 与 FRP 审计是否能关联实际 Actor。

凭证泄漏处理：

1. 隔离入口并保留日志/数据库证据；
2. 撤销具体 Credential；必要时 disable Identity 以阻止全部新请求；
3. 主动断开既有 `/app` Socket 或重启 Server；
4. 核对该 Identity 的 Job、TerminalAudit、Pi、Release、FRP 和反向代理记录；
5. 修改密码不会自动撤销 Session/Token，必须分别处理；
6. 确认后再 enable，且不要让泄漏 Credential 因 enable 重新生效。

## 14. 兼容与变更

以下变化属于跨 Server/Frontend/SDK/CLI 的安全和兼容变更：

- Cookie 名称、属性、TTL 或登录端点；
- token 格式、摘要算法或 Credential 生命周期；
- ActorContext 字段/source 语义；
- 公开端点集合和 AuthGuard 默认策略；
- `/app` handshake 认证；
- Identity admin/disabled 语义；
- 密码哈希算法或成本；
- 新增 MFA、OIDC、RBAC、多租户或资源所有权。

认证迁移必须支持明确的旧凭证失效/迁移策略、回滚和事件响应。不能只更新 Frontend，也不能让旧 Server 宽松接受新 token 类型。

## 15. 测试门禁

1. 密码登录成功/失败、用户名枚举安全和 bcrypt 参数；
2. Cookie HttpOnly/Secure/SameSite/TTL/logout/expired/revoked；
3. Cookie 优先、Bearer fallback、无效/过期/撤销 Credential；
4. disable/enable 后 Session 和 Credential 的准确语义；
5. 修改密码后既有 Session/Token 的当前行为；
6. admin-only、普通身份业务访问、最后 admin/self-disable 锁死防护；
7. REST 与 `/app` 认证一致性及撤销后既有 Socket；
8. strict parser、未知字段、用户名/密码/label 大小和登录限速；
9. token 明文只返回一次，DB/日志/错误/Frontend 不泄露秘密；
10. ActorContext 不可由 payload 伪造，审计关联正确；
11. 公开端点清单、CORS/Origin、HTTPS 和反向代理配置；
12. 过期 Session/Credential 清理和备份恢复。

## 16. 当前实现偏移

1. AuthErrorCode 定义比实际响应更细；login/updateMe/token revoke 的普通 Error 可能成为 500，Guard 失败则统一为 `AUTH_REQUIRED`；
2. 没有登录速率限制、失败锁定、CSRF Token 或独立 Cookie 写请求 Origin Guard；
3. Auth/Identity body 缺严格运行时 parser 和统一长度/密码强度限制；
4. 新 Credential 无创建时 expiresAt，lastUsedAt 不更新；
5. 无过期/撤销 AuthSession 和 Credential 定期清理；
6. Bearer 调用 logout 不会撤销 Credential；
7. Identity disable 只撤销 Session，enable 后未撤销 Credential 重新有效；
8. 修改密码不撤销其他 Session、Credential 或既有 Socket；
9. `/app` 与 REST 分别实现认证，既有 Socket 不响应后续禁用/撤销；
10. 最后/唯一 admin 可被禁用，Bootstrap 又会把 disabled admin 计为已存在，可能锁死管理面；
11. 当前没有创建第二个 admin 或恢复 admin 的业务 API；
12. Actor 审计不完整，FRP 内部 Job 等路径缺 createdBy；
13. 仓库 CLI 仍可通过命令参数接收用户名/密码，且完整通用 Bearer CLI 尚未实现。

这些缺口进入 [`roadmap.md`](../roadmap.md) 或 Issue；修复前不得把目标语义写成当前保证。

## 17. 相关文档

- [`ADR-0011`](../adr/0011-server-side-opaque-authentication-and-actor-context.md) — opaque Session/Credential 与 ActorContext；
- [`ADR-0009`](../adr/0009-trusted-operator-security-domain.md) — 可信操作者单信任域；
- [`../architecture.md`](../architecture.md) — 认证在控制面中的位置；
- [`../domain-model.md`](../domain-model.md) — Identity、Credential 和 AuthSession；
- [`../protocols.md`](../protocols.md) — REST 与 `/app` 认证协议；
- [`../security.md`](../security.md) — 信任模型和密钥要求；
- [`../deployment.md`](../deployment.md) — 首次管理员与 Cookie 配置；
- [`../operations.md`](../operations.md) — 锁死和凭证事件处置。
