# ADR-0011：使用服务端 opaque 认证会话与 ActorContext

- 状态：Accepted
- 日期：2026-08-15（补录当前已实施决策）
- 决策者：项目维护者
- 关联：[`docs/design/identity-and-authentication.md`](../design/identity-and-authentication.md)、[`docs/security.md`](../security.md)、[`ADR-0009`](./0009-trusted-operator-security-domain.md)

## 背景

VCPDeck 的 Browser、SDK 和自动化调用需要证明人类操作者身份。系统能够执行远程命令、文件、Terminal、Pi、Storage、FRP 和更新，因此认证凭证泄漏会直接扩大为远程主机风险。同时，业务模块需要稳定知道一次请求或 Socket 操作由谁发起，不能信任调用方在 payload 中自报身份。

当前项目是单 Server + SQLite 的个人/少量可信操作者控制面，不需要无状态跨服务 JWT 验证、第三方身份提供商或复杂 Refresh Token 链。Client 机器身份又通过独立 `/client` PSK 建立，不能与人类身份凭证混用。

ADR-0009 已决定“所有有效业务 Identity 属于同一可信操作者域，admin 只额外管理身份”，但它不决定 Identity 如何认证、凭证如何存储及业务层如何取得 Actor。因此需要补录认证机制本身的长期决策。

## 决策

1. Identity 是稳定的人类操作者身份，当前使用唯一 username 和 bcrypt passwordHash。
2. Browser 使用登录后由 Server 创建的 opaque AuthSession；明文 token 只保存在 HttpOnly Cookie，SQLite 只保存 SHA-256 摘要和生命周期。
3. SDK/自动化可使用每 Identity 多个 opaque Bearer Credential；明文 token 创建时只返回一次，SQLite 只保存 SHA-256 摘要。
4. opaque token 至少来自 32 字节密码学安全随机数；高熵 token 使用快速摘要，低熵密码必须使用专用密码哈希。
5. REST 由全局 AuthGuard 默认拒绝，只有显式 `@Public()` 端点公开。
6. `/app` Socket.IO 使用 AuthSession Cookie 或 handshake Bearer Credential；`/client` 继续使用独立 PSK，二者的主体和密钥空间不能混用。
7. 认证成功后 Server 生成 ActorContext，并绑定到 HTTP request 或 Socket；业务服务只接受该上下文，不信任 body/query/event payload 中的 identityId、actor、createdBy 或 operator。
8. ActorContext 的 source 只描述认证入口，不授予权限；授权仍遵循 ADR-0009。
9. 当前不采用 JWT、Refresh Token、OAuth/OIDC/SSO、MFA、通用 RBAC 或多租户。出现对应需求时通过新 ADR 设计迁移，而不是在现有 token 中隐式增加语义。
10. 密码、Session/Credential 明文、摘要、Cookie 和 Authorization 必须按秘密处理，不进入普通日志、URL、错误和公开审计。

## 候选方案

### JWT + Refresh Token

可减少每次数据库查询并适合分布式服务，但撤销、禁用即时生效、密钥轮换、claim 迁移和 refresh 生命周期复杂。当前单 Server + SQLite 可以直接验证服务端 Session，暂不采用。

### Browser 长期保存 Bearer Token

实现简单，但 localStorage/sessionStorage 中长期 token 会扩大 XSS 和前端代码读取风险，也不利于设备 Session 单独撤销，因此 Browser 使用 HttpOnly Cookie。

### HTTP Basic Auth 或每次提交用户名密码

不需要 Session 表，但会让低熵密码频繁穿过代理和应用层，也无法自然表示 Browser 设备会话，不采用。

### 统一使用 Client PSK

会混淆机器与人类主体，使 Browser 获得 Client 控制凭证，无法形成每人撤销和 Actor 审计，明确拒绝。

### OAuth/OIDC/SSO

适合团队身份治理，但引入 Provider、redirect、state/nonce、claim 映射、账户关联和运维依赖。当前无实际需求，保留为未来独立决策。

## 后果

### 正面

- Server 可即时检查 Identity disabled、Session/Credential revoked 和 expiresAt；
- 数据库不保存可直接使用的 opaque token 明文；
- Browser 长期凭证不可被普通前端脚本读取；
- 每个用途可以使用独立 Credential 并单独撤销；
- ActorContext 为 Job、Terminal、Pi、Release 和后续审计提供统一可信来源；
- Client 与人类身份通道清晰隔离。

### 负面

- 每次请求/握手需要读取 SQLite；
- Server 是认证状态中心，不能无状态水平扩展；
- REST AuthGuard 与 `/app` 当前有重复认证实现，可能漂移；
- opaque token 创建后无法从数据库恢复明文；
- Cookie 写请求仍需要 CORS/Origin/CSRF 和 HTTPS 配置；
- 该决策不自动提供细粒度授权或完整审计。

### 安全与运维影响

- SQLite 与备份含密码哈希、token 摘要及大量业务敏感数据，必须加密、限制访问并可恢复；
- 生产必须使用 HTTPS/WSS、Secure Cookie、精确 Frontend Origin 和反向代理脱敏；
- Credential 应按用途签发并支持过期、lastUsed 和清理；当前这些能力不完整，需进入 Roadmap；
- disable、password change、logout、token revoke 和已建立 Socket 的准确失效语义必须被文档和测试固定；
- 认证失败响应不得用于用户名、Credential 或 Session 枚举。

## 验证与退出条件

验证至少覆盖：

- 密码、Cookie、Bearer 的成功、失败、过期、撤销和禁用；
- Token 明文只显示一次且 DB/日志中不存在；
- HttpOnly/Secure/SameSite/TTL 和 logout；
- REST 默认拒绝和公开端点清单；
- `/app` 与 REST 身份一致；
- payload 不能伪造 Actor；
- admin-only 身份管理和普通身份业务访问；
- 备份恢复后的 Session/Credential 行为；
- 登录限速、Origin/CSRF 与秘密脱敏。

出现以下情况时必须新建 ADR supersede 或扩展本决策：

- 多 Server/无状态认证；
- 企业 OIDC/SSO、MFA 或密码无关认证；
- 多租户、资源级授权和服务账户；
- 需要硬件密钥、集中 KMS/HSM 或合规 Session 设备管理；
- token 格式、摘要算法或 Cookie 模型发生破坏性变化。
