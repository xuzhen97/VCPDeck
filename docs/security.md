# VCPDeck 安全模型与维护要求

> 状态：Current｜维护责任：安全负责人/模块维护者｜最后核验：2026-09-05｜适用版本：`0.6.26` / 当前 `main`

## 1. 安全结论

VCPDeck 是高权限远程管理系统。任意已认证业务身份目前都可以执行远程命令、操作文件、创建终端、控制 Pi、修改 Storage/FRP 并读取共享 Job 元数据。admin 只额外管理身份；系统没有细粒度 RBAC、多租户或按资源授权。

因此部署边界必须是“少量可信操作者 + 受控网络 + 专用运行账户”，不能按公网多租户 SaaS 的安全假设部署。

## 2. 资产与敏感数据

最高敏感级别：

- 用户密码、Session Cookie、Bearer Token；
- Client PSK、Launcher Token、FRPS Token；
- 阿里云 clientSecret/accessToken/refreshToken；
- Storage 签名 URL；
- Storage Share 的长期公开 URL（Token 是 bearer capability；数据库仅保存其 SHA-256 哈希）；
- 命令、脚本、环境变量、路径、终端正文、Pi prompt/响应和文件内容；
- Release 构件、上传分片 URL及下载路径；
- Client 一键安装 bootstrap 响应和目标机 `launcher.env`；
- SQLite 数据库和远程 Pi Session。

这些内容不得进入普通日志、遥测、截图、Agent 回复、Issue 或未经加密的备份。

## 3. 信任边界

```text
Browser / SDK / CLI ──身份认证──> Server
外部消费者 ──长期 opaque Token──> Server 公开 Storage Share
Client ──PSK──> Server /client
Server/Client ──本机随机 Token──> Launcher
Browser/Client ──短期签名──> Storage
Client frpc ──FRPS Token──> FRPS
Server ──OAuth Token──> 外部存储
```

Server 是控制面信任中心，但仍必须把 REST body、Socket payload、外部 API 响应、文件流和 Client 状态报告视为不可信输入。

## 4. 认证与授权

### 4.1 用户身份

- 密码使用 bcrypt；Session/Credential 为服务端 opaque token，数据库只保存 SHA-256 摘要；
- Cookie 为 HttpOnly、SameSite=Strict；生产必须 `Secure=true` 并使用 HTTPS；
- Token 明文只在创建时返回一次；当前新 Credential 无默认过期、lastUsedAt 不更新；
- 禁用 Identity 会撤销 Session并阻止认证，但未撤销 Credential 会在重新启用后恢复有效；
- 修改密码不撤销既有 Session/Token，`/app` 既有 Socket 也不会因后续禁用/撤销被主动断开；
- 最后 admin 当前可被禁用，Bootstrap 又会把 disabled admin 计为已存在，存在管理面锁死风险；
- admin-only 范围当前只有身份管理；认证详情见 [`design/identity-and-authentication.md`](./design/identity-and-authentication.md)。

### 4.2 CLI 环境与凭据

- 用户级 `~/.vcpdeck/cli/config.json` 只保存 Server、兼容密码环境的用户名和凭据环境变量名，不保存密码、Bearer Token、Cookie 或 PSK；非 Windows 权限收紧为 `0600`；
- 项目 `.vcpdeck.json` 只能选择用户级环境，不能覆盖 Server 或认证，防止不可信仓库诱导 CLI 把本机秘密发送到攻击者 Server；
- 项目选择器仍可指向本机已注册的生产环境，因此 CLI/Skill 的写入、执行、发布等副作用操作必须展示最终环境、Server 和来源；确认门不是 Server 授权边界；
- 项目或用户配置损坏、字段未知、版本不支持、环境不存在时 fail closed，不静默回退到其他环境；
- 推荐在 Frontend `/settings/tokens` 按用途创建 Bearer Token；Credential 与 Identity 关联，CLI 与 SDK 可共用，个人资料修改用户名不改变 Token 身份；泄漏时撤销具体 Token；
- 密码/Token 环境变量值只进入 CLI 进程内存；`env current/list/show` 只显示变量名，`env check` 只显示 `/api/auth/me` 返回的身份摘要。环境变量并非系统凭据保险箱，同账户进程仍可能读取；
- `--password` 只作为直连兼容参数，可能进入 Shell history/进程列表；新命名环境推荐 `--token-env`。完整规则见 [`design/cli.md`](./design/cli.md) 和 ADR-0017。

### 4.3 Client

- `/client` 使用单个共享 PSK；
- 当前没有每 Client 独立证书、PSK 标识、轮换重叠窗口或 mTLS；
- PSK 泄露意味着攻击者可能伪装 Client，因此必须使用高熵随机值、限制配置权限并定期轮换；
- Server/Client 实际读取 `VCPDECK_PSK`；示例中的 `VCPDECK_CLIENT_PSK` 当前无效；
- Client 一键安装开关默认关闭。启用后，任何能访问 Server 安装入口的机器都可从 bootstrap 取得共享 PSK；命令和公开脚本本身不含 PSK，bootstrap 禁止缓存和普通日志记录；
- 禁用安装入口只拒绝后续安装请求，不轮换 PSK、不断开已有 Client，也无法撤销已经取得的 PSK。

### 4.4 授权缺口

当前任意有效业务身份可访问所有 Client/Job/Storage/FRP/Pi/Terminal。Frontend 隐藏按钮和“确认操作”不是授权边界。若增加非完全可信用户，必须先设计资源级授权和审计，不能只增加 UI 角色。

### 4.5 root 等价 Client（Linux A2，ADR-0023）

Linux A2 新安装的 `vcpdeck` 专用账户持有 `NOPASSWD: ALL`，是 **root 等价** Client：Job、Terminal、Pi 可显式 `sudo -n` 执行任意 root 命令，不受沙箱限制，继承目标机 OS 账户的全部权限。

- **审计边界**：Server 只记录控制面、Job 输出与 Session 生命周期；**不**声称完整的主机级 root-shell 审计，也不防目标机本地篡改。需要强审计/隔离的目标机不应作为 root 等价 Client。
- **上报与展示**：Client 注册上报 `capabilityDetails.privileged`（`sudo-all`/`unavailable`）；Frontend 与 CLI 显式展示 root 等价风险，`jobs run`/`pi run` 执行前提示“Server 仅记录控制面/Job/Session 审计”。旧 Client 未上报时按“未报告”展示，不推断为任何能力。
- **环境隔离（E1）**：专用账户 HOME 独立，安装器不复制旧用户 `.pi`/`.ssh`/`.gitconfig`/shell 配置或个人凭据。

## 5. 输入与执行安全

- Shared 的 Pi/Terminal parse 函数是跨信任边界的强制入口；
- Job type、payload、timeout、capability 必须在 Server 和 Client 两侧校验；
- `exec` 和 Pi 最终继承 Client 运行账户权限，不是沙箱；command 当前使用系统 Shell，script 当前允许外部提交任意 `executable + args`；
- ADR-0010 已决定把 script 迁移到 Client 持有的 runtime ID，但该 registry 尚未实现，不能当作当前保护；
- 工作目录应来自受控 file roots/canonical path；exec 当前只校验 cwd 为非空字符串，仍可由可信调用方提交任意路径；
- Shell、PTY、frpc 和子进程启动参数应尽量使用参数数组；command 模式是显式保留的任意 Shell 入口；
- FRP 当前把 authToken/dashboardPassword 明文存入 SQLite 并通过 REST 返回，authToken 还进入 Job payload 和 Client TOML；同一 Client 单 frpc 与 Server 多实例模型不一致，详见 [`design/frp.md`](./design/frp.md)；
- 文件路径长期必须防止 traversal、symlink/junction 越界和平台路径差异；当前普通文件 Job 的 `rootDir` 未绑定 `file.roots`，`resolveSafePath()` 还会吞掉 symlink 越界异常并缺少不存在目标父链校验，Files root 目前不是完整授权边界；
- 未知事件、字段、状态和错误码应拒绝，不做宽松猜测。

## 6. 数据最小化

- Job payload 可能包含敏感 command、script、executable、args、cwd、文件路径和 `file.writeText` 正文；最终 stdout/stderr 及 `file.readText` 正文当前进入 Job result 和数据库备份，列表、详情、日志与保留策略必须按敏感数据处理；
- Server 不持久化终端正文、快照、输入和 reconnect token；
- Server 不持久化 Pi prompt、正文、thinking 和真实 cwd；
- TerminalAudit 仅记录生命周期；
- 错误 message 不得包含 stack、文件内容、Token、签名 URL或原始外部 API 响应；
- Release 和更新日志只记录版本、状态和安全失败摘要。

## 7. 文件与 Storage

- 签名 URL 必须绑定动作、key 和过期时间；
- Local 代理上传校验实际大小和 SHA-256；Alibaba 直传只校验声明字节数和 Provider 完成状态；Client import 当前只校验下载字节数，不计算或比较 SHA-256；
- 外部直传凭据应最小权限、短时有效；
- Local Provider 使用随机 signSecret，并在缺失时持久化到 Storage 配置；该字段必须按密钥保护，轮换会使旧 URL 失效；
- Storage Provider 配置可能含 OAuth Token，API 只能返回安全摘要；
- Provider 切换不自动迁移/删除旧数据，应避免产生失控副本；
- Storage Share 默认长期有效，撤销后公开读取返回 410；有效分享锁定 File，必须先撤销再删除；Token 只在创建响应返回一次，泄露后只能撤销；
- 公开分享管理响应不含 Token、sharePath、Storage key 或 Provider URL；公开错误不透传 File ID、Provider 错误或签名 URL；
- 公开分享对图片和普通文件统一返回不可缓存 302；Alibaba 等外部 Provider 的正文不经过 Server，Local 正文仍由 Server Storage 数据端点提供；
- 图片 MIME、`Content-Disposition`、缓存和内联行为由 Provider 响应决定，外部 Provider 响应不由 VCPDeck 注入 SVG CSP 或 `nosniff`；调用方不得假设分享一定内联展示，浏览器也不得执行不可信上传内容；
- running 文件 Job 的 cancel/timeout 当前不会可靠中止 fs、HTTP 或分片操作，断线终局也没有持久补报；结果不明时不得自动重试写、移、删或 import；
- 文件 Job payload 和 Gateway progress/done/cancelled 仍缺严格双端 parser 与当前 Socket/Job Client 再绑定校验。

## 8. 终端与 Pi

### Terminal

- 只有 operator 可以输入；viewer 只读；takeover 有 30 秒重连保护和冲突处理；
- Browser 只提交 shellId/尺寸，不能提交 executable、args、cwd 或 env；
- 单次输入、尺寸、输出块、snapshot 和 backlog 有目标上限，但当前没有持续输入速率限制，`TERMINAL_RATE_LIMITED` 仅为预留错误；snapshot raw 回退和 sync backlog 也尚非严格 UTF-8 字节上限；
- reconnect token 明文位于 Browser sessionStorage，Server 只保存内存 hash；Server 重启后原控制 lease 不能凭旧 token 单独恢复；
- 浏览器或 Client/Server 连接断开不自动等价于关闭 PTY，必须防止遗留高权限会话；从未 attach、重复 attach/detach TTL 重入和本地 expired 上报还有已知缺口；
- 终端正文不进入 Server DB 和普通日志；
- PTY/进程树清理是尽力而为，daemonized/脱离进程组的进程和已发生副作用不会被 Terminal 关闭撤销；
- 完整当前边界见 [`design/remote-terminal.md`](./design/remote-terminal.md)。

### Pi

- Owner 校验和 project lock 在 Server 执行；Owner 约束写控制，不构成多租户保密边界；
- cwd 必须来自 Files roots 并由 Client realpath/canonicalize；projectKey 是进程级随机 secret 对 canonical cwd 的 HMAC，不泄露真实路径，Client 重启后变化；
- 每个 run 使用 runId 隔离迟到事件，Socket payload 通过 Shared 严格 parser；
- 图片附件受数量、单文件、总大小、MIME、SHA-256、魔数和 TTL 限制；
- Pi 工具、Extensions、Skills 和项目构建拥有运行账户权限；Project Trust 只控制项目资源加载，不是工具权限或容器沙箱；
- Extension UI 请求必须使用 allowlist 和超时；当前端到端只接受 `select/confirm/input/editor`，Client 生成的其他非阻塞 UI 会在 Server parser 被拒绝；正文、用户输入和本地路径不得进入 Job 或日志；
- 当前没有平台级 tools allowlist、bash 审批策略、集中 Pi 资源分发或无人值守任务安全边界。

## 9. Release 与供应链

当前更新包只做 SHA-256 完整性校验，没有发布者数字签名。公开下载端点意味着任何能获得版本号的人可下载构件；SHA-256 只能检测传输/内容不一致，不能证明构件来源。

Alibaba Release 上传的数据面直接连接 Provider：Server 只签发/刷新短期单文件分片 URL并持久化会话元数据，不接收正文。URL 响应必须 `no-store`，不得进入数据库、Release、日志、错误或测试快照；CLI 不持有 Provider OAuth 长期凭据。Provider 创建任务固定大小，CLI 对实际发送字节二次计算 SHA-256，Launcher 下载后再次复核；Server 不读取直传正文，不能声称独立计算了直传内容哈希。

生产要求：

- 上传控制面只允许可信身份和受控网络；
- 发布构建机、依赖锁文件和构件目录受保护；
- SHA-256 通过独立可信渠道记录；
- Launcher 控制接口只绑定 127.0.0.1，`control.json` 权限限制为运行账户；
- 未实现包签名前，不在不可信网络中把自动更新当作强供应链保证；
- 依赖新 Launcher 的版本先人工升级并验证。

建议在稳定发布前增加 Ed25519 构件签名和固定信任公钥。

## 10. 网络安全

- 公网部署必须使用 HTTPS/WSS；
- 反向代理限制 Local/旧 Server legacy raw 请求体、超时和上传大小；Alibaba Release 正常上传只有小型 JSON 控制请求，构件正文不经过 Server；
- `/api/releases/:version/file`、`/api/status` 和签名 Storage 端点虽公开，仍应由网络 ACL、速率限制和审计保护；
- Server 当前没有内建速率限制、登录锁定、CSRF Token 或独立 Cookie 写请求 Origin Guard；SameSite=Strict 与精确 CORS 只降低部分风险；
- CORS 只允许明确 Frontend Origin，不能使用宽泛 Origin；
- FRPS Dashboard 不暴露到公网，凭据必须轮换；
- Launcher 端口不得通过代理或防火墙暴露。

## 11. 密钥生命周期

| 密钥 | 存储 | 轮换要求 |
| --- | --- | --- |
| 管理员密码 | 人员秘密管理器；DB 为 bcrypt | 人员变更/怀疑泄露立即轮换 |
| Bearer Token | 客户端秘密存储；DB 为摘要 | 每用途一个 Token，定期撤销 |
| Client PSK | Server/所有 Client 秘密配置 | 高熵；泄露时协调停机轮换 |
| Launcher Token | `control.json` | Launcher 每次启动随机生成 |
| FRPS Token / Dashboard 密码 | Server DB、Job payload、Client TOML/FRPS 配置 | 当前明文；受控轮换并重建映射连接 |
| Storage/OAuth Token | Storage config | 最小权限；撤销后验证状态 |
| Local signSecret | `StorageBackendConfig.config` | 自动生成后持久化；疑似泄露时轮换，旧 URL 随即失效 |

PSK 当前不支持双密钥平滑轮换。轮换应安排维护窗口：停止 Client → 更新 Server PSK并重启 → 更新各 Client → 验证注册。

## 12. 安全测试门禁

- 未认证/非 admin/禁用身份、最后 admin、自禁用和管理面恢复；
- Storage Share Token 格式、哈希持久化、管理面脱敏、公开 404/410/503、撤销、File 删除锁、Provider 永久缺失与临时故障分类；
- Session/Credential 撤销、过期、重新启用、密码修改、既有 `/app` Socket、strict parser 和登录限速；
- PSK 错误连接；
- FRP secret 脱敏、默认凭据、同 Client 多实例拒绝/隔离、端口、frpc 退出、Client 重启和删除孤儿；
- 路径 traversal、认证 root、symlink/junction、不存在目标父链和跨 root；
- exec 双端 parser、runtime capability、script/output/cwd 大小与路径边界、进程树取消；
- Terminal parser、operator/viewer/token、snapshot/output 同序列、上游 gap、UTF-8 上限、持续输入速率、generation、TTL/过期上报、真实 PTY 和进程树；
- Pi parse fuzz、大小限制、未知字段；
- 文件 Job 双端 parser、Socket/Job 归属、文本大小、覆盖、临时文件清理、取消、断线和 import SHA-256；
- 签名 URL 过期、篡改、动作混用；
- Release SHA-256 篡改与 zip 路径穿越；
- 日志中无密钥、命令正文和签名 URL；
- 依赖漏洞、secret scanning 和构件来源检查。

## 13. 已知风险清单

1. 无细粒度授权，所有业务身份都是远程操作员；
2. 共享 Client PSK，无每机身份和双密钥轮换；
3. Release 无数字签名；
4. REST 错误格式尚未完全统一；
5. 无内建速率限制、登录锁定和完整安全审计；
6. 示例 PSK 变量名与实现不一致；
7. 开发启动使用 `db push --accept-data-loss`；
8. 日志尚未全面结构化和自动脱敏；
9. exec script 当前允许 arbitrary executable/args，缺少 runtime capability、大小上限、cwd root 校验和进程树取消；
10. 远程文件 rootDir/symlink 边界不完整，文本内容可无硬上限进入 Job/SQLite，import 无 SHA-256，文件 Job 取消和断线补报不可靠；
11. 通用 Job progress/done/cancelled 未在 Gateway handler 内再次验证当前 Socket 与 Job 的 Client 归属；
12. Terminal snapshot/output 序列、上游 gap、UTF-8 snapshot 上限、输入速率、generation、SQLite 实时状态和 TTL/过期上报仍有可靠性偏移；
13. 认证业务普通 Error 可能返回 500，且缺登录限速、严格 parser、Credential 过期/lastUsed、既有 Socket 失效和最后 admin 防锁死；
14. FRPS 凭据明文存库/返回/进入 Job 与 Client TOML，同一 Client 多实例不可靠，删除/重启/进程退出缺可靠收敛。

这些风险应进入 roadmap/Issue，并在暴露范围扩大前优先处理。远程文件详细事实见 [`design/remote-files.md`](./design/remote-files.md)，Terminal 见 [`design/remote-terminal.md`](./design/remote-terminal.md)。

## 14. 安全事件响应

隔离 → 保全证据 → 撤销 Session/Token → 轮换 PSK/FRP/Storage 凭据 → 核对 Job/TerminalAudit/Release/代理日志 → 从可信构件和备份恢复 → 验证所有 Client → 形成事后报告和修复 ADR。
