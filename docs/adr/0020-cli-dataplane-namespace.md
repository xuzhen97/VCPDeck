# ADR-0020：CLI 通过 /cli 数据面命名空间接入终端与 Pi 交互

- 状态：Accepted
- 日期：2026-08-22
- 决策者：项目维护者
- 关联：[`docs/design/cli.md`](../design/cli.md)、[`docs/design/remote-terminal.md`](../design/remote-terminal.md)、[`ADR-0007`](./0007-client-owned-interactive-runtime.md)、[`ADR-0011`](./0011-server-side-opaque-authentication-and-actor-context.md)、[`ADR-0017`](./0017-cli-multi-environment-configuration.md)

## 背景

CLI 已对齐 Server 的机器、Job、文件、Pi、FRP、Storage 与 Release 的 REST 能力面，但终端的交互式价值（TUI 应用、持久 shell 状态、实时输出）依赖 PTY 字节流数据面——目前只有浏览器路径：Frontend 经 Socket.IO `/app` 命名空间（cookie 会话认证）attach 到 Server 中继的远端 PTY。Pi 的流式输出同样经 cookie 认证的 SSE 提供。

操作者与 Agent 需要"在本地终端里获得与登录目标机一致的体感"：raw mode 按键直传、ANSI 转义序列透传、resize 同步。这要求 CLI 作为 Socket.IO 客户端接入终端数据面，而 `/app` 当前只接受 cookie 认证，CORS 也锚定 Frontend origin。

## 决策

1. 新增 Socket.IO 命名空间 `/cli`，专供 CLI 数据面接入。认证使用与 REST 相同的 Bearer Credential（握手 `auth.token`），复用既有 Token 校验与会话归属逻辑；不改动 `/app` 的 cookie 认证与 CORS 语义，浏览器协议面保持不变。
2. 终端事件契约复用 `/app` 的 `terminal:*` 协议（attach/detach/input/resize/takeover/resync/ack-output/output/snapshot），经同一 `TerminalService` 中继到 Client PTY；Client 与 Shared 协议零改动。
3. CLI 端新增 `terminal attach <client> <sessionId>`：socket.io-client 连接 `/cli`，本地 stdin raw mode 与 socket 双向桥接，终端 resize 同步远端，提供安全退出序列（默认 `Ctrl+Q`），断线时明确提示并支持重连。
4. Pi 交互式 REPL 后续在同一 `/cli` 命名空间扩展（复用既有 prompt/state 语义），本期不实现；`pi run` 的请求-响应模式继续经 REST。
5. 安全边界不变：`/cli` 与 REST 使用同一 Bearer 权限面；attach 受会话归属校验（actor identityId）；终端审计沿用既有机制；CLI 本地不落盘任何会话内容。
6. 兼容性：`/cli` 为增量命名空间，不影响 `/app`、`/client` 与 REST；Server 与 CLI 需同版本发布（旧 CLI 无此能力，新 CLI 连旧 Server 时 attach 明确报错引导升级）。

## 候选方案

### 扩展 /app 认证同时接受 Bearer

改动最小，但浏览器命名空间混杂两种认证路径，CORS/来源语义需要为 CLI 网开一面，长期演进互相牵制，拒绝采用。

### 终端 I/O 走 REST 轮询

TUI 需要低延迟双向字节流，轮询延迟与吞吐都不可接受，拒绝采用。

### CLI 直连 Client 端口（绕过 Server）

打破控制面单一入口与信任模型（Client 不暴露公网、Server 是唯一权威），拒绝采用。

### WebRTC/P2P 直连

延迟最优但引入 ICE/信令/防火墙复杂度，且同样绕过控制面中继审计；当前单信任域规模下收益不成立，留作未来演进。

## 后果

### 正面

- Agent 与操作者在本地终端获得与 SSH 一致的 TUI 体感（vim/htop/交互式安装器可用）；
- 浏览器协议面零改动，Frontend 无感知；
- TerminalService 中继逻辑复用，Client 零改动；
- Pi 交互 REPL 获得现成的数据面通道。

### 负面

- Server 新增一个对外命名空间，认证与审计面需要测试覆盖；
- CLI 引入 socket.io-client 依赖并需要处理 raw mode 的跨终端差异（Windows Terminal 良好，legacy conhost 有限）；
- 交互体验受操作者到 Server 的网络延迟影响（无本地回显）；
- 交互式会话内容经 Server 中继，审计与隐私预期需在文档中明示。

### 兼容与运维影响

- Server 与 CLI 必须同版本发布；旧 CLI 连新 Server 不受影响（无此功能），新 CLI 连旧 Server 时 attach 返回明确错误；
- `/cli` 连接纳入 Server 日志与连接数观测；
- 终端审计与"会话归属"语义与浏览器路径完全一致，不产生第二套权限。

## 验证与退出条件

最低验证包括：`/cli` Bearer 认证成功/失败路径、attach 归属校验、input/output/resize 双向桥接、断线重连与退出序列、与浏览器同时 attach 的 takeover 语义、旧 Server 拒绝新 CLI attach 的明确错误，以及 raw mode 下 TUI 应用（vim/htop）实测。

若需要 P2P 直连、多路复用会话共享、会话录制回放或跨 Server 漫游，必须以新 ADR 重新评估信任边界与数据权威，不得在本命名空间内静默扩展。
