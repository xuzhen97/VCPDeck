# ADR-0009：当前采用可信操作者单信任域

- 状态：Accepted
- 日期：2026-08-15（补录当前阶段决策）
- 决策者：项目维护者
- 关联：[`docs/design/identity-and-authentication.md`](../design/identity-and-authentication.md)、[`docs/security.md`](../security.md)、[`docs/deployment.md`](../deployment.md)、[`ADR-0011`](./0011-server-side-opaque-authentication-and-actor-context.md)

## 背景

VCPDeck 可以在远程机器上执行命令、读写文件、创建 PTY、运行 Pi、修改 FRP 和 Storage，并触发更新。这些能力继承 Client 运行账户权限，属于高权限远程管理。当前产品面向个人或少量彼此信任的操作者，代码只区分有效业务身份和额外拥有身份管理权限的 admin，没有多租户、Client 归属或资源级 RBAC。

如果把当前认证机制误解为适合不可信多用户或公网 SaaS，普通身份会获得超出部署者预期的远程操作能力。Frontend 隐藏按钮和二次确认也不能替代 Server 授权。因此需要明确当前阶段的信任假设，而不是把尚未实现的细粒度授权写成已有能力。

## 决策

1. 当前 VCPDeck 部署采用“少量可信操作者”的单信任域。
2. 任意有效业务 Identity 都被视为远程操作员，可以访问所有 Client、Job、文件、Terminal、Pi、Storage 和 FRP 能力。
3. `isAdmin` 只额外授予身份管理能力，不表示只有 admin 才能进行远程操作。
4. 当前不提供多租户、按 Client/项目归属、资源级 RBAC、审批流或双人复核。
5. Frontend 隐藏入口、按钮禁用和确认弹窗不是授权边界；认证和现有 admin 检查必须在 Server 执行。
6. 系统应部署在受控网络中，使用 HTTPS/WSS、明确 CORS、网络 ACL、专用运行账户和受保护的秘密配置。
7. `/client` 当前使用共享 PSK，它认证受信 Client 连接域，不等于每台 Client 的独立身份，也不提供用户授权。
8. 远程命令、Terminal 和 Pi 不是沙箱，其权限上限由 Client 运行账户和目标主机安全配置决定。
9. 在引入不完全可信用户或扩大公网暴露前，必须先创建新 ADR 设计资源归属、授权、审计和迁移，并替代本决策。

## 候选方案

### 当前即实现细粒度 RBAC

长期更适合团队场景，但需要定义 Client、Job、文件、Session、Storage 和 FRP 的归属及继承规则，显著扩大当前个人控制面范围，因此暂不采用。

### 只允许 admin 执行远程操作

模型简单，但会使普通 Identity 几乎失去业务价值，也与当前代码和个人可信协作场景不符，因此不采用。

### 依靠 Frontend 隐藏高权限操作

实现成本低，但 API、SDK 和 CLI 可以绕过 UI，不能构成安全边界，因此不采用。

### 每台 Client 立即使用独立证书或 mTLS

可以缩小共享 PSK 泄露范围，但涉及颁发、轮换、撤销和兼容部署。当前仍使用高熵共享 PSK，并将每机身份作为后续安全演进事项。

## 后果

### 正面

- 当前个人部署的身份和授权模型简单；
- 所有入口经过 Server 认证，避免把 UI 当作权限系统；
- 文档和 AI 编码不会错误假设普通 Identity 权限较低；
- 可以在产品进入团队/多租户阶段前集中设计一致的资源授权模型。

### 负面

- 任意业务账号泄露都可能导致所有远程资源被操作；
- 无法安全接纳部分可信、只读或只允许访问部分 Client 的用户；
- 共享 Client PSK 泄露可能允许攻击者伪装 Client；
- 当前审计不足以满足严格合规和多租户追责要求。

### 安全与运维影响

- 身份、Session、Bearer Token、PSK、Launcher Token、FRPS 和 Storage 凭据必须按高敏感秘密保护；
- 禁用 Identity 时必须撤销其 Session，Token 应按用途独立签发并及时撤销；
- PSK 当前不支持双密钥平滑轮换，泄露轮换需要维护窗口；
- 不应把当前系统未经额外防护直接部署为公网多用户服务；
- Client 应使用满足任务需要的最低权限专用账户运行。

## 验证与退出条件

通过未认证拒绝、禁用身份、admin-only 身份管理、普通有效身份业务访问、Token 撤销、错误 PSK、日志无秘密和公网部署配置检查验证当前边界。

出现团队用户、只读用户、外部协作者、多租户、按 Client/项目授权、审批或合规审计需求时，必须创建新 ADR supersede 本决策，并在开放用户前完成 Server 端强制授权和数据迁移。
