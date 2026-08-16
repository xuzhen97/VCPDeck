# VCPDeck 远程终端设计

> 状态：Current｜维护责任：Terminal/Client 维护者｜最后核验：2026-08-15｜适用版本：当前 `main`
>
> 事实来源：`packages/shared/src/terminal.ts`、`packages/client/src/terminal/`、`packages/server/src/terminal/`、`packages/server/src/events/app.gateway.ts`、`packages/server/src/events/client.gateway.ts`、`packages/sdk/src/terminal.ts`、`packages/frontend/src/terminal/`、`packages/frontend/src/pages/terminal-panel.tsx`、Prisma schema

本文描述当前已经实现的浏览器远程交互式终端：Frontend 经 Server 认证和协调，在目标机器 Client 上创建、观察和控制真实 PTY。运行态与正文归属的长期决策见 [`ADR-0007`](../adr/0007-client-owned-interactive-runtime.md)，字段级协议以 Shared parser 和 [`protocols.md`](../protocols.md) 为准。

## 1. 范围与非目标

当前 Terminal 提供：

- Windows ConPTY 或 POSIX PTY 上的真实交互式 Shell；
- Client 探测的安全 shell ID；
- 同一 Client 最多 5 个非终态会话；
- Browser 多标签、operator/viewer、30 秒控制权重连保护和 takeover；
- Client headless terminal snapshot、顺序化输出和 Browser resync；
- 最后一个 Browser 离开或 Server 连接断开后，Client 内存中 30 分钟保留；
- TerminalSession 元数据和最小生命周期审计。

Terminal Session 不是普通 Job，不占 Job 调度槽，也不使用普通 Job 状态机。

当前不提供：

- 命令 allowlist、审批、容器或文件系统沙箱；
- 多个 Browser 同时写入同一 PTY；
- Server 端终端录屏、正文搜索或永久回放；
- Client 进程/机器重启后恢复原 PTY；
- tmux/screen 集成、分享链接或匿名访问；
- 浏览器提交 executable、args、cwd 或 env；
- 多 Server 之间共享 attachment/operator lease；
- 可靠终止已经主动脱离 PTY 进程组的 daemon。

终端继承 Client OS 运行账户的全部实际权限，不是沙箱。

## 2. 组件与职责

```mermaid
flowchart LR
    Browser[Frontend xterm] <-->|REST + Socket.IO /app| Server[Server Terminal]
    Server --> DB[(SQLite\nTerminalSession / Audit)]
    Server <-->|Socket.IO /client| Bridge[Client Terminal Bridge]
    Bridge --> Manager[TerminalManager]
    Manager --> PTY[node-pty / ConPTY / PTY]
    Manager --> Snapshot[@xterm/headless snapshot]
    PTY --> Shell[目标机器 Shell]
```

| 组件 | 当前职责 |
| --- | --- |
| Frontend Terminal Panel | 会话列表/创建/关闭、xterm 渲染、多标签、控制权和恢复状态 |
| Frontend terminal socket/hook | `/app` ack、sessionStorage token、snapshot + delta、gap/resync、重连 attach |
| `AppGateway` | Cookie/Bearer 认证、Browser 消息严格解析、安全 ack、按 socket 清理 attachment |
| `TerminalController` / SDK | Shell、Session、关闭和 Audit 的机器范围 REST API |
| `TerminalService` | 持久元数据、attachment/operator lease、snapshot 同步、输出转发、takeover、Client 对账 |
| `TerminalRequestBroker` | requestId、目标 Client/socket 绑定、超时和响应关联 |
| `ClientGateway` | Terminal response/output/exit/state 严格解析并绑定当前 Client socket |
| Client protocol bridge | Server 请求分派、Client 输出/退出上报、REGISTER 后状态报告 |
| `TerminalManager` | PTY registry、Shell、输入、resize、输出、snapshot、保留计时和清理 |
| `TerminalAuditService` | allowlist 生命周期事件和分页；不接受任意正文 metadata |

## 3. 数据权威与最小持久化

| 数据或资源 | 权威位置 | 持久性 |
| --- | --- | --- |
| 真实 PTY、PID、Shell、cwd 和当前尺寸 | Client `TerminalManager` | Client 进程内；进程退出后丢失 |
| 当前画面、scrollback、snapshot 和输出序号 | Client 内存 | 不进入 SQLite |
| TerminalSession 身份、创建者和终态元数据 | Server / SQLite | 持久化 |
| Browser attachment、operator/viewer 和保护期 | Server `TerminalService` 内存 | Server 重启后丢失 |
| reconnect token 明文 | Browser `sessionStorage` | 当前 Browser tab/session 范围 |
| reconnect token hash | Server 内存 | 不入库；Server 重启后丢失 |
| TerminalAuditEvent | Server / SQLite | 生命周期最小审计 |
| 输入、输出和 snapshot 正文 | Client/Browser 临时内存 | 默认不进入 Server DB 或普通日志 |

Server 中的 TerminalSession `status` 不是活跃 PTY 的完整实时镜像。当前 attach/detach 没有持续写入 `active/detached`、`lastAttachedAt`、`detachedAt` 和 `expiresAt`；真实 PTY 是否存在应以 Client 状态报告和实际 attach/snapshot 请求为准。

## 4. Capability、Shell 与 PTY

Client 仅在 `node-pty` 延迟探测成功且发现可用 Shell 时声明 `terminal.pty`。原生模块不可用会禁用 Terminal capability，但不应阻止 exec、Files、FRP 或 Pi。

Shell 探测顺序：

- Windows：`pwsh → powershell → cmd`；
- POSIX：`$SHELL → bash → zsh → sh`。

解析后的可执行路径只保存在 Client 内存 registry。公开 DTO 只包含 `id/label/kind/isDefault`；Browser 创建会话只能提交 `shellId/cols/rows`。当前 label 实际通常等于 shell ID，Server 创建记录时也将 `shellLabel` 初始化为请求的 shell ID。

PTY 初始 cwd 由 Client 启动时的安全回退路径决定，当前 Browser 不能指定 cwd。环境继承 Client 进程环境，并设置 `TERM=xterm-256color`、`COLORTERM=truecolor`。

当前锁定安装结果包括：

- `node-pty@1.1.0`；
- `@xterm/headless@6.0.0`；
- `@xterm/addon-serialize@0.14.0`；
- Browser `@xterm/xterm@6.0.0` 和 `@xterm/addon-fit@0.11.0`。

Windows 创建 PTY 时优先使用 `useConptyDll: true`，避免默认 ConPTY kill 路径在父进程持有 console 时调用辅助枚举进程并产生异常；构件缺少对应 DLL 时回退 node-pty 默认 ConPTY。POSIX 使用系统 PTY。

## 5. Session 生命周期

Shared 定义：

```text
starting → detached / active → exited | interrupted | expired | closed | error
```

终态为 `exited/interrupted/expired/closed/error`。当前实际链路：

1. Server 串行检查每 Client 非终态会话不超过 5；
2. Server 创建 `starting` 记录和 `created` audit；
3. Server 经 Broker 请求 Client 创建 PTY；
4. Client 再次检查上限和 shell ID，创建 PTY、snapshotter 和内存 Session；
5. Server 收到成功响应后把 DB 状态写为 `detached`；
6. Browser 通过 `/app` attach，Client 返回 snapshot，随后进入 live 输出；
7. Shell 自行退出时 Client 上报 `terminal:exit`，Server 写 `exited`；
8. 用户关闭时 Server 等待 Client close 响应后写 `closed`；
9. Client 状态报告缺少 DB 非终态会话时，Server 当前写 `interrupted`。

### 5.1 创建和初始保留缺口

Client 创建 Session 时当前把 `liveAttached` 初始化为 `true`，而 Server 的创建响应语义是 `detached`。正常 Frontend 会立即 attach；但若 API 创建成功后 Browser 没有 attach，Client 不会自动启动 30 分钟 detached timer，PTY 可能持续存在。

若 Broker request 因超时、断线或抛错而失败，`createSession()` 当前只对正常的 `ok:false` 响应写 `error`；异常抛出可能留下 `starting` DB 记录和 Server runtime。运维应把长期 `starting` 视为结果不明，而不是仍在正常创建。

### 5.2 Detached TTL

最后一个 Server attachment 离开时，Server 尽力发送 `session.detach`；Client 将会话置为 detached 并启动 30 分钟内存 timer。Server Socket 断开时 Client 也会对所有会话启动该 timer。

当前没有 Server 端持久 TTL 扫描器。Client 本地 timer 到期会关闭 PTY，但 `wireManagerToSocket()` 只上报 `exited`，不会上报本地 `expired`；因此 Server DB 可能继续保留非终态状态，直到后续状态对账把缺失会话标成 `interrupted`。Prisma 的 `detachedAt/expiresAt` 当前也没有被 TerminalService 完整维护。

Server runtime 的 `detachNotified` 在首次最后离开后置为 true，但重新 attach 时当前没有复位。会话再次最后离开时可能不再发送 `session.detach`，Client 已取消的 TTL 也不会重新启动。

## 6. Browser attach 与控制权

- 第一个有效 attachment 成为 operator；其他 attachment 为 viewer；
- operator 才能 input 和 resize，Server 每次请求都校验 socket、attachment 和 mode；
- 同一身份打开多个页面也按 attachment 区分；
- operator socket 离开后，Server 保存 token hash、identity 和 30 秒保护期；
- Browser 在 `sessionStorage` 按 `clientId + sessionId` 保存明文 reconnect token；
- 保护期内匹配 token/identity 的 attach 可恢复 operator；
- 保护期结束且没有 operator 时，viewer 可竞争 takeover；
- Server 广播当前 mode、operatorName、保护截止时间和 canTakeover。

Server 重启会丢失 attachment、operator lease 和 token hash。SQLite 与 Browser 中的旧 token不能单独恢复原 lease；重启后首个新 attachment 会按新的内存 runtime 重新取得控制权。Owner/operator 是单信任域中的写协调，不是多租户保密边界。

## 7. Snapshot、输出顺序与背压

当前目标限制：

| 项目 | 值 |
| --- | --- |
| 单次 input | 64 KiB UTF-8 |
| output chunk | 64 KiB UTF-8 |
| snapshot | 8 MiB |
| attach sync backlog | 2 MiB |
| scrollback | 2,000 行 |
| 慢消费者阈值 | ack 落后 512 个 chunk |
| cols | 20–500 |
| rows | 5–300 |

Client 把 PTY 输出写入 headless xterm，并按约 16 ms 聚合后切分为有 seq 的 output chunk。attach 时 Server 请求 snapshot，在 attachment syncing 期间暂存后续增量；Browser 先 reset/write snapshot，再按 seq 应用 delta。Browser 发现 gap 时请求 resync；Server 对慢消费者暂停增量并发出 `terminal:resync-required`，不阻塞其他 attachment 或远端 PTY。

### 7.1 当前序列偏移

TerminalManager 的网络 output seq 按“聚合并切分后的 chunk”递增；Snapshotter 的 `snapshotSeq` 按“原始 PTY `onData` 写入次数”递增。一个原始块被合并或拆分时，两套序列可能不一致。因此当前不能保证 snapshotSeq 与后续网络 output 严格位于同一序列空间，恢复时可能产生错误去重、gap 或基线推进。

### 7.2 Server 上游 gap

`TerminalService.handleClientOutput()` 发现 `chunk.seq > lastSeq + 1` 时当前直接丢弃该 chunk，没有主动向 attachment 发送 resync-required。后续 chunk 可能继续被当作 gap 丢弃，Browser 因收不到这些块而无法自行发现缺口。

### 7.3 UTF-8 有界回退

Snapshotter 使用 UTF-8 字节数判断是否超限，但 raw buffer 和超限回退使用 JS `slice()` 字符数截断。包含中文或 emoji 时，回退结果仍可能超过 8 MiB 并被 Shared parser 拒绝；该上限当前不是严格的 UTF-8 字节保证。Server syncing backlog 也使用 `chunk.data.length` 而不是 UTF-8 字节累计，因此 2 MiB 同样是近似字符边界。

### 7.4 输入速率

单次输入大小有严格 parser 和 Client 双重检查，但当前没有每 operator 的持续字节速率限制。`TERMINAL_RATE_LIMITED` 已在 Shared 错误 allowlist 中定义，尚无实际触发实现。

## 8. 通信协议

### 8.1 REST

机器范围端点：

```text
GET    /api/clients/:clientId/terminals/shells
GET    /api/clients/:clientId/terminals?page=&pageSize=
POST   /api/clients/:clientId/terminals
GET    /api/clients/:clientId/terminals/:sessionId
DELETE /api/clients/:clientId/terminals/:sessionId
GET    /api/clients/:clientId/terminals/:sessionId/audit?page=&pageSize=
```

创建 body 由 Shared parser 严格限制为 `shellId/cols/rows`。列表和审计使用 `PaginatedResult<T>`，pageSize 最大 100。DELETE 对已终态会话返回原终态；对活跃会话需要 Client 在线确认，不能在结果不明时谎称已关闭。

### 8.2 Browser `/app`

Browser 请求：

- `terminal:attach/detach/input/resize/takeover/ack-output/resync`。

Server 推送：

- `terminal:snapshot/output/control/session-state/resync-required/error`。

`/app` 使用 Cookie 或 handshake Bearer 认证；所有请求先经 Shared parser，再返回 `{ok:true,data}` 或 `{ok:false,error}` ack。

### 8.3 Server–Client `/client`

- `terminal:request`：Server → Client；
- `terminal:response/output/exit/state`：Client → Server。

Client request 动作包括 shells.list、session.create/attach/detach/input/resize/snapshot/close。两端均使用 Shared 严格 parser；Broker 把 response 与目标 socket/client/requestId 绑定，避免另一台 Client 解析 pending request。

## 9. 状态对账与故障

Client 进程启动时生成 `generationId`，REGISTER 后上报当前内存 Session。Server 当前按集合对账：

- DB 与 Client 都存在：接受，初始化 runtime/lastSeq；
- DB 非终态但 Client 未上报：写 `interrupted/TERMINAL_CLIENT_RESTARTED`；
- Client 上报未知或 DB 已终态 Session：在 ack 中要求 Client close。

虽然协议携带 generationId，Server 当前没有保存或比较它；“同 generation 是 Socket 重连、generation 变化才是 Client 重启”尚未真正成为对账分支。任何一次空/不完整的权威报告都可能让未上报 DB 会话进入 interrupted。

Client Socket 断开时，Server 的 `handleClientDisconnect()` 当前不更新 TerminalSession，也不主动向 Browser 广播机器断线；Browser 可能直到请求超时、socket 重连或 snapshot 失败才感知。Client 侧会继续保存 PTY 并启动 30 分钟 timer。

Server 重启后：

- DB 元数据保留；
- Browser attachment 和 lease 丢失；
- Client 重连并上报 Session 后，Server 重建最小 runtime；
- Browser 重新 attach 取得 snapshot；
- 不能依赖 Server 内存补回断线期间的 output。

Client 重启后真实 PTY 消失，旧会话应收敛为 interrupted，不能由 Server 创建替代 PTY伪装恢复。

## 10. 进程清理

终局 settle 会释放 snapshot、timer 和 listener，先调用 PTY kill，再异步尽力清理进程树：

- Windows：`taskkill /PID <pid> /T /F`，参数数组且 `shell:false`；
- POSIX：对进程组发送 SIGTERM，短暂等待后尝试 SIGKILL。

`killTree()` 失败当前不会改变已经决定的 Session 终态。已经 daemonize、通过服务管理器启动或脱离 PTY 进程组的进程不在保证范围内。关闭 Terminal 不能被描述为撤销该 Shell 已产生的所有系统副作用。

## 11. 安全与隐私

- 所有有效业务身份当前都可访问所有 Client 的 Terminal，admin 只额外管理身份；
- Browser 不取得 Client PSK、Shell executable、cwd 或 env；
- Terminal input/output/snapshot 不写 SQLite、Audit 或普通日志；
- reconnect token 明文只在 Browser，Server 只保存内存 hash；
- xterm 把输出作为终端控制序列处理，不使用 `dangerouslySetInnerHTML`；
- 当前不启用远端 OSC 52 自动写浏览器剪贴板；
- input、output、snapshot、尺寸和 backlog 有单次/内存边界，但持续输入速率限制尚未实现；
- Server 端 operator/viewer 校验是写协调，无法限制同一可信操作者通过 exec、Files 或 Pi 达成相同 OS 副作用；
- UI 必须持续提示 Terminal 继承 Client OS 权限、不是沙箱。

## 12. 运维与恢复

日常检查：

- Client 是否声明 `terminal.pty` 及安全 capability detail；
- 长期 `starting`、非终态但无法 attach 的 Session；
- Client/Server 日志中的 native PTY、Broker timeout 和 snapshot 错误码；
- TerminalAudit 是否异常增长；
- Client 运行账户下是否存在不再归属于活动 Session 的 Shell/子进程。

故障判断：

- 不要只凭 SQLite `active/detached/expiresAt` 判断 PTY；当前这些字段不是完整实时镜像；
- Browser 无输出时先检查 `/app`、Client 在线和 capability，再重新 attach 获取 snapshot；
- 持续 resync 可能来自网络丢块、snapshot/output seq 偏移、Server 上游 gap 或慢消费者；
- 长期 `starting` 可能是创建 request timeout，需同时核对 Client 是否已实际创建孤儿 PTY；
- Client 本地过期后 Server 仍显示非终态时，后续状态报告可能收敛为 interrupted；
- Server 重启后旧 reconnect token 不保证恢复 operator，应重新 attach；
- Client 重启后不尝试从 DB 重建 PTY。

Terminal 正文不在 Server 备份中。SQLite 备份只包含 Session 元数据和 Audit；如果未来要求正文回放或合规录屏，必须创建新 ADR，定义加密、授权、保留和删除。

## 13. 兼容与变更

Terminal 当前没有独立数字协议版本，依赖 Shared parser、capability 和整套同版本部署。以下变化必须协调 Shared、Client、Server、SDK 和 Frontend，并进行双端发布：

- request/action/event/错误码或 strict-key 变化；
- snapshot/output seq 语义；
- generation/reconciliation 语义；
- Session 状态和终态；
- attachment/operator/token 规则；
- Shell registry、尺寸或大小限制；
- xterm/node-pty 版本升级和 snapshot 序列化行为。

旧 Client 缺 `terminal.pty` 时 Server 应明确拒绝 Terminal，而不是猜测兼容。升级 `node-pty` 或 xterm 前必须在 Windows/POSIX 真实 PTY 上验证创建、控制字符、全屏 TUI、resize、snapshot、关闭和进程清理。

## 14. 测试门禁

Terminal 变更至少覆盖：

1. Shared strict parser、未知字段、UTF-8 大小、尺寸和稳定错误；
2. Shell 探测、原生模块失败降级和 executable 不出边界；
3. PTY create/input/resize/exit/close/expiry/shutdown 竞态；
4. snapshot 与网络 output 使用同一 seq 语义，聚合/拆分场景不偏移；
5. Client → Server output gap 主动触发 resync，不形成永久丢块；
6. 中文/emoji snapshot 回退仍严格满足 UTF-8 字节上限；
7. operator/viewer、token、30 秒保护、takeover 并发和持续输入速率；
8. Browser snapshot + delta、慢消费者、多 Session 事件隔离和重连；
9. generation 比较、Socket 重连、Client 重启、Server 重启、孤儿 close；
10. create timeout、从未 attach、重复 attach/detach 的 TTL 重入、本地 expiry 上报和 SQLite 状态收敛；
11. Windows ConPTY/POSIX PTY 的 Shell、Ctrl+C、history、补全、中文、全屏 TUI、resize 和进程树清理；
12. DB、Audit 和日志不存在 input/output/snapshot/token/cwd/env。

自动化 fake PTY 不能代替真实平台验收。当前尚未形成可持续的完整 Windows/Linux 真实终端 CI/验收矩阵，不能仅凭旧实施清单宣称完整平台支持。

## 15. 当前实现偏移

1. snapshotSeq 与网络 output seq 来自不同计数点，聚合/拆分时可能偏移；
2. Server 收到上游 output gap 时静默丢弃，不主动要求 resync；
3. snapshot raw 回退按 JS 字符数截断，不保证 UTF-8 8 MiB 上限；
4. `TERMINAL_RATE_LIMITED` 仅定义，持续输入速率限制未实现；
5. generationId 上报但 Server 未保存/比较，不是实际对账分支；
6. attach/detach/state report 没有完整维护 SQLite `active/detached/lastAttachedAt/detachedAt/expiresAt`；
7. Client 断线不会立即向 Browser 广播 Terminal 连接状态；
8. Server 保存的 shellLabel 当前通常只是 shellId；
9. Client 创建 Session 时初始 `liveAttached=true`，从未 attach 的会话可能不启动 TTL；
10. Broker 异常/超时可能留下 `starting` DB 记录和 runtime；
11. Server `detachNotified` 在重新 attach 时不复位，后续最后离开可能不再通知 Client 启动 TTL；
12. Client 本地 expired 不会上报 Server，DB 可能保持非终态并在以后被标为 interrupted；
13. 进程树清理失败不改变终态，脱离 PTY 的进程不保证结束；
14. 完整 Windows/Linux 真实 PTY 支持矩阵尚未持续建立。

这些事项进入 [`roadmap.md`](../roadmap.md) 或 Issue；修复前不得把目标语义写成当前保证。涉及 seq、generation、状态或事件兼容的修复不能只改一端。

## 16. 相关文档

- [`ADR-0007`](../adr/0007-client-owned-interactive-runtime.md) — 交互运行态驻留 Client、Server 最小持久化；
- [`../architecture.md`](../architecture.md) — Terminal 在系统中的位置；
- [`../domain-model.md`](../domain-model.md) — TerminalSession、Audit 和状态；
- [`../protocols.md`](../protocols.md) — REST、`/app`、`/client` 协议；
- [`../compatibility.md`](../compatibility.md) — Server/Client/Frontend 版本策略；
- [`../security.md`](../security.md) — 可信操作者和终端正文边界；
- [`../operations.md`](../operations.md) — 故障处置；
- [`../testing.md`](../testing.md) — 测试和发布门禁。
