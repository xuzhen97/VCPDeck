# ADR-0020：CLI 复用 /app 数据面命名空间接入终端与 Pi 交互

- 状态：Accepted
- 日期：2026-08-22
- 决策者：项目维护者
- 关联：[`docs/design/cli.md`](../design/cli.md)、[`docs/design/remote-terminal.md`](../design/remote-terminal.md)、[`ADR-0007`](./0007-client-owned-interactive-runtime.md)、[`ADR-0011`](./0011-server-side-opaque-authentication-and-actor-context.md)、[`ADR-0017`](./0017-cli-multi-environment-configuration.md)

## 背景

CLI 已对齐 Server 的机器、Job、文件、Pi、FRP、Storage 与 Release 的 REST 能力面，但终端的交互式价值（TUI 应用、持久 shell 状态、实时输出）依赖 PTY 字节流数据面——目前只有浏览器路径：Frontend 经 Socket.IO `/app` 命名空间（cookie 会话认证）attach 到 Server 中继的远端 PTY。

操作者与 Agent 需要"在本地终端里获得与登录目标机一致的体感"：raw mode 按键直传、ANSI 转义序列透传、resize 同步。

实施前调查发现一个关键既有事实：**`/app` 网关的握手认证除 cookie 会话外，已原生支持 Bearer Token**（`handshake.auth.token` → credential 表校验，actor `source: "cli"`）——该路径正是为非浏览器客户端预留的。

## 决策

1. CLI 直接复用 `/app` 数据面命名空间：socket.io-client 以 `auth: { token: <Bearer> }` 握手，事件契约与浏览器完全一致（`terminal:attach/detach/input/resize/takeover/resync/ack-output/output/snapshot`），经同一 `TerminalService` 中继到 Client PTY。**不新增命名空间，Server 端零改动，Client 与 Shared 协议零改动。**
2. CLI 端新增 `terminal attach <client> <sessionId>`：本地 stdin raw mode 与 socket 双向桥接，终端 resize 同步远端，安全退出序列为 `Ctrl+Q`（显式 detach 通知 Server），断线时明确提示。
3. attach 仅支持 Bearer 环境：密码环境的登录态是进程内 Cookie，无法传递给 socket 握手；CLI 对密码环境明确报错并引导迁移 Bearer。
4. Pi 交互式 REPL 后续复用同一 `/app` 通道扩展（prompt/state 语义已存在），本期不实现；`pi run` 的请求-响应模式继续经 REST。
5. 安全边界不变：`/app` 的 Bearer 路径与 REST 使用同一 Credential 权限面；attach 受会话归属校验（actor identityId）；终端审计沿用既有机制；CLI 本地不落盘任何会话内容。
6. 兼容性：Bearer 握手认证为 `/app` 既有能力，Server 端零改动即支持新 CLI；旧版行为不受影响。传输固定 WebSocket（Node 客户端无浏览器 CORS 限制）。

## 候选方案

### 新增 /cli 专用命名空间（初稿方案，已否决）

实现调查发现 `/app` 已支持 Bearer 握手认证，新命名空间属于重复建设；且浏览器协议面与 CLI 协议面本就共享 `terminal:*` 事件契约，分离反而制造两套需要同步演进的协议面。否决，改为复用 `/app`。

### 扩展 /app 认证同时接受 Bearer（作为独立改动）

无需做——调查确认该能力已存在（app.gateway `authenticate` 的 handshake auth 分支），直接使用。

### 终端 I/O 走 REST 轮询

TUI 需要低延迟双向字节流，轮询延迟与吞吐都不可接受，拒绝采用。

### CLI 直连 Client 端口（绕过 Server）

打破控制面单一入口与信任模型（Client 不暴露公网、Server 是唯一权威），拒绝采用。

## 后果

### 正面

- Agent 与操作者在本地终端获得与 SSH 一致的 TUI 体感（vim/htop/交互式安装器可用）；
- Server/Client/Shared/Frontend 零改动，交付面最小；
- 浏览器与 CLI 共享同一套终端协议与审计语义；
- Pi 交互 REPL 获得现成的数据面通道。

### 负面

- CLI 引入 socket.io-client 依赖并需要处理 raw mode 的跨终端差异（Windows Terminal 良好，legacy conhost 有限）；
- 交互体验受操作者到 Server 的网络延迟影响（无本地回显）；
- 交互式会话内容经 Server 中继，审计与隐私预期需在文档中明示；
- attach 仅支持 Bearer 环境，密码环境用户需迁移。

### 兼容与运维影响

- `/app` 的 Bearer 握手路径纳入 CLI 使用观测；
- 终端审计与"会话归属"语义与浏览器路径完全一致，不产生第二套权限；
- 密码环境的用户需迁移到 Bearer 环境才能使用 attach（`env add --token-env` 流程）。

## 验证与退出条件

最低验证包括：`/app` Bearer 握手成功/失败路径、attach 归属校验、input/output/resize 双向桥接、退出序列与断线处理、与浏览器同时 attach 的 takeover 语义，以及 raw mode 下 TUI 应用（vim/htop）实测。

若需要 P2P 直连、独立 CLI 命名空间、多路复用会话共享、会话录制回放或跨 Server 漫游，必须以新 ADR 重新评估信任边界与数据权威，不得在 `/app` 内静默扩展。
