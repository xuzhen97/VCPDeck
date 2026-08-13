# 机器交互式终端 Tab 设计与实施清单

> 状态：设计已确认，待实现  
> 日期：2026-08-12  
> 需求入口：`/machines/:clientId/terminal`  
> 本文档是交互式终端功能的**设计与实施单一事实来源**。

## 0. 文档使用规则

1. 后续实现必须先阅读本文档，并以本文档定义的范围、状态机、协议、安全边界和验收标准为准。
2. 文末“实施任务清单”是完成状态的唯一记录；实施过程中每完成一个步骤并通过该步骤验证后，将对应 `- [ ]` 改为 `- [x]`。
3. 不允许因为代码已经写出就提前勾选；必须同时满足该步骤列出的测试、构建、文档或人工验收要求。
4. 如果实施中发现设计需要调整，应先修改本文档，记录调整原因和影响，再继续实现；不得让代码和本文档长期不一致。
5. 只有当本文档中所有实施任务、测试、平台验收和最终检查项均已勾选时，本功能才视为设计落地完成。
6. 每个任务开始前遵循项目 `AGENTS.md`：修改既有函数、类或方法前运行 GitNexus upstream impact；HIGH/CRITICAL 风险先停止并告知用户；提交前运行 `gitnexus_detect_changes()`。
7. 本文档不授权本次直接修改代码；当前阶段仅完成设计。

---

## 1. 背景与问题

VCPDeck 当前机器工作区已经有“执行”Tab。现有执行链路通过 Typed Job 下发一次性命令：

```text
Frontend ExecutePanel
  -> REST 创建 exec Job
  -> Server JobService / ClientGateway
  -> Client child_process.spawn()
  -> stdout / stderr / exitCode
```

该模型适合执行一条命令或脚本，但不具备真实终端所需的 PTY 语义，无法完整支持：

- 持续存在的 Shell 进程；
- 方向键、命令历史和 Tab 补全；
- `Ctrl+C` 等控制字符；
- `vim`、`top` 等全屏交互程序；
- 终端窗口尺寸同步；
- 页面刷新后重新附着到同一进程；
- 多浏览器同时查看且只有一个页面输入。

因此，本功能新增独立的 **Terminal Session（终端会话）** 领域，不把交互式终端伪装为一个长期运行的 Job，也不改变现有 Execute Tab。

现有 `docs/server-client-interaction-design.md` 中关于“未来交互终端可能使用 waiting_input Job”的内容属于早期预留设想；对本功能而言，以本文档为准：**终端会话不是 Job，不使用 JobStatus 状态机。**

---

## 2. 目标

在机器工作区增加“终端”Tab，让已登录且可信的操作者可以通过浏览器使用远程机器的真实交互式终端。

首版目标：

1. 正式支持 Windows 和 Linux；macOS 保持实现兼容性，但不作为首版强制验收平台。
2. 使用真实 PTY/ConPTY，而不是流式命令输入框。
3. 支持多个终端子标签，每台机器最多同时存在 5 个未结束会话。
4. Client 上报实际可用 Shell，前端允许选择并提供智能默认值。
5. 支持普通命令、中文输入输出、复制粘贴、方向键、Tab 补全、命令历史、`Ctrl+C`、窗口尺寸同步，以及 `vim`、`top` 等全屏程序。
6. 页面切换、刷新或关闭后，在保留期内重新连接到同一个 PTY 进程。
7. 同一会话允许多个浏览器页面观察，但同一时刻只有一个页面拥有输入和 resize 权限。
8. 操作者断开后保留 30 秒重连保护；保护期结束后，其他只读页面可主动接管。
9. 所有浏览器都离开后，PTY 最多继续保留 30 分钟；到期自动结束。
10. 用户可随时手动关闭终端。
11. 记录最小会话事件审计，但不记录按键、命令内容或终端输出。
12. Client 或远程机器重启后不伪造进程恢复；旧会话标记为“已中断”。

---

## 3. 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 终端类型 | 真实交互式 PTY，不是一次性命令框 |
| 正式平台 | Windows、Linux |
| macOS | 尽量兼容，首版不作为强制验收平台 |
| Shell | Client 探测实际可用项；前端可选择；有智能默认值 |
| 多会话 | 每台机器最多 5 个未结束终端 |
| 页面恢复 | 切换 Tab、刷新、关闭浏览器后，在保留期内恢复同一 PTY |
| Client/机器重启 | 不恢复原进程；会话标记为 interrupted |
| 单写多读 | 首个 attach 页面操作，其他页面只读 |
| 操作权保护 | 操作者断开后保护 30 秒 |
| 接管 | 保护期结束后只读页面可主动接管 |
| 空闲保留 | 最后一个浏览器离开后保留 30 分钟 |
| 手动关闭 | 随时可用；关闭 Shell 和可归属的进程树 |
| 审计 | 只记录会话生命周期与接管事件，不保存输入输出 |
| 文件传输 | 不属于终端首版；继续使用 Files Tab |
| 端口转发 | 不属于终端首版；继续使用映射功能 |
| 分享链接 | 不实现 |
| 多人同时输入 | 不实现 |
| 服务部署 | 首版按单 Server 进程设计；不支持多实例共享内存租约 |

---

## 4. 非目标与边界

首版明确不实现：

- 将 Terminal Session 纳入 Job 调度队列；
- 保存或搜索完整终端输入输出；
- 从 PTY 字节流可靠解析“用户执行了哪一条命令”；
- 命令 allowlist、命令审批或沙箱；
- 多个页面同时写入同一个 PTY；
- Terminal Session 分享链接或匿名访问；
- 文件上传、下载、拖入终端自动上传；
- SSH 协议或浏览器直连 Client；
- tmux/screen 集成；
- Client 或机器重启后恢复原进程；
- 永久保存完整终端滚屏历史；
- 终端录屏；
- OSC 52 自动写浏览器剪贴板；
- 自动识别和遮盖终端中的任意密码、Token 或私钥；
- 多 Server 实例之间的操作权租约同步；
- 保证终止已经通过 `nohup`、daemon、systemd 等方式脱离 PTY 进程组的后台服务。

安全边界：终端继承运行 VCPDeck Client 的 OS 用户权限，**不是沙箱**。界面必须持续显示可信操作者和高权限警告。

---

## 5. 总体架构

```text
Browser
  React TerminalPanel + xterm.js
  │
  │ REST：Shell、会话元数据、创建、关闭、审计
  │ Socket.IO /app：attach、输入、输出、resize、接管、状态
  ▼
VCPDeck Server
  TerminalController
  TerminalService
  AppGateway（浏览器终端事件，复用现有身份认证）
  ClientGateway（远程 Client 终端事件，复用现有 PSK）
  │
  │ Socket.IO /client：create/input/resize/close/state/output
  ▼
VCPDeck Client
  TerminalCapabilityProbe
  TerminalManager
  PTY adapter
  Output sequence + headless terminal snapshot
  │
  ▼
node-pty
  ├─ Windows ConPTY -> pwsh / powershell / cmd
  └─ Unix PTY       -> $SHELL / bash / zsh / sh
```

### 5.1 各层职责

| 层 | 职责 |
| --- | --- |
| Shared | 事件名、DTO、状态、稳定错误码、运行时协议解析与边界常量 |
| Client | Shell 探测、PTY 生命周期、输入输出、resize、快照、保留计时、进程树清理、重连状态上报 |
| Server | Web 身份校验、会话元数据、单写多读、操作权租约、Client 请求代理、状态对账、最小审计 |
| SDK | Shell、会话、关闭和审计 REST API |
| Frontend | 多终端标签、xterm 渲染、恢复、只读状态、接管、复制粘贴和错误提示 |

### 5.2 事实来源

- **活跃 PTY 是否真实存在**：Client `TerminalManager` 是权威来源。
- **会话元数据与历史终态**：Server 数据库是权威来源。
- **当前浏览器操作权**：单 Server 进程内的 `TerminalService` 租约状态是权威来源。
- **终端当前画面**：Client 维护的 headless terminal snapshot 加后续有序输出是权威来源。
- **审计**：Server `TerminalAuditEvent` 表是权威来源。

---

## 6. 技术选型

### 6.1 Client PTY

推荐使用 `node-pty`：

- Windows 使用 ConPTY；
- Linux/macOS 使用系统 PTY；
- 支持控制字符、全屏程序和 resize；
- 与 xterm.js 数据模型匹配。

不能以现有 `child_process.spawn({ shell: true })` 替代 PTY。

`node-pty` 是原生依赖。正式实现前必须完成依赖可安装性验证：

- 当前项目 Node.js 版本；
- Windows x64；
- Linux x64；
- pnpm workspace 安装、构建和打包；
- 开发环境无编译工具时是否有可用预编译产物；
- 若选定版本需要本地编译，必须在部署文档中明确构建依赖。

Client 主入口不得因终端原生模块加载失败而整体崩溃。终端能力应延迟探测；不可用时只禁用 Terminal Tab，exec/files/FRP/Pi 等既有能力继续工作。

### 6.2 终端画面恢复

仅保存原始输出环形缓冲无法在缓冲截断后可靠重建光标、颜色和 alternate screen。首版采用：

- `@xterm/headless` 在 Client 内存中镜像 PTY 输出；
- `@xterm/addon-serialize` 生成可写回浏览器 xterm 的 ANSI snapshot；
- 每个 PTY 输出块带单调递增 `seq`；
- attach 时返回 `{ snapshot, snapshotSeq }`；
- attach 同步期间 Server 暂存 `seq > snapshotSeq` 的增量；
- 前端先 reset/write snapshot，再写增量，然后进入 live 模式。

快照只在内存中，不写数据库或日志。默认保留最多 2,000 行 scrollback；具体值作为共享常量。单个 snapshot 编码后限制为 8 MiB，超限时减少 scrollback 并返回 `historyTruncated: true`。

实现前需用 `vim`、`top`、PowerShell 和 resize 验证 serialize/restore 行为。如所选 xterm 版本无法可靠序列化 alternate screen，则回退为“最近 8 MiB 原始输出 + 明确截断提示”，并在本文档“设计变更记录”中记录限制，不能静默降低恢复语义。

### 6.3 Frontend

推荐：

- `@xterm/xterm`；
- `@xterm/addon-fit`；
- `socket.io-client`。

不启用原始 HTML 渲染，不启用 OSC 52 自动写剪贴板，不在首版添加 Web Links Addon。粘贴仅由用户显式浏览器粘贴操作触发。

---

## 7. Capability 与 Shell 探测

### 7.1 Capability

新版 Client 注册时增加：

```ts
capabilities: [
  // existing capabilities...
  "terminal.pty",
]
```

并在 `capabilityDetails` 中增加安全摘要：

```ts
interface TerminalCapabilityStatus {
  available: boolean;
  backend?: "conpty" | "pty";
  code?: TerminalCapabilityErrorCode;
  message?: string;
}
```

不得上报 Shell 绝对路径、用户 home、PATH 或本地错误 stack。Shell 明细通过已认证的按机器 API 按需获取，并仍只返回安全 ID、label 和 kind。

### 7.2 Shell DTO

```ts
interface TerminalShellInfo {
  id: string;
  label: string;
  kind: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "sh" | "other";
  isDefault: boolean;
}
```

浏览器只提交 `shellId`。Client 根据自身探测结果从内存映射到 executable 和固定启动参数，禁止浏览器提交任意可执行文件路径或参数。

### 7.3 Windows 探测顺序

1. `pwsh.exe`；
2. `powershell.exe`；
3. `cmd.exe`。

第一个可用项为默认 Shell。推荐固定参数：

- PowerShell 7：`-NoLogo`；
- Windows PowerShell：`-NoLogo`；
- cmd：`/Q`。

探测使用 PATH/PATHEXT 的安全解析或 `where.exe` 的非 shell 调用，不能用 `shell: true` 拼接浏览器输入。

### 7.4 Linux 探测顺序

1. 当前 Client 用户的 `$SHELL`，前提是文件存在且可执行；
2. `bash`；
3. `zsh`；
4. `sh`。

按解析后的真实可执行文件去重。默认使用第一个可用项。Linux/macOS 终端环境至少设置：

```text
TERM=xterm-256color
COLORTERM=truecolor
```

已有 `LANG`/`LC_*` 原样继承，不强行覆盖用户 locale。

### 7.5 初始工作目录

首版不允许浏览器提交任意 cwd。PTY 默认从运行 Client 的 OS 用户 home 启动；home 不存在或不可访问时回退到 Client `process.cwd()`。后续如需“从文件面板在此处打开终端”，应另行设计安全路径引用，不在首版提前暴露绝对路径输入。

---

## 8. 数据模型

### 8.1 TerminalSession

建议新增 Prisma 模型：

```prisma
model TerminalSession {
  id                  String    @id
  clientId            String
  client              Client    @relation(fields: [clientId], references: [id])
  shellId             String
  shellLabel          String
  status              String
  cols                Int
  rows                Int
  createdByIdentityId String?
  createdByName       String?
  createdAt           DateTime  @default(now())
  lastAttachedAt      DateTime?
  detachedAt          DateTime?
  expiresAt           DateTime?
  endedAt             DateTime?
  endReason           String?
  errorCode           String?
  updatedAt           DateTime  @updatedAt

  audits              TerminalAuditEvent[]
}
```

`Client` 增加 `terminalSessions TerminalSession[]` 关系。

不保存：

- Shell executable 绝对路径；
- 当前 cwd；
- 环境变量；
- 终端输入；
- 终端输出；
- snapshot；
- reconnect token；
- 浏览器 socketId。

### 8.2 TerminalAuditEvent

```prisma
model TerminalAuditEvent {
  id          String          @id
  sessionId   String
  session     TerminalSession @relation(fields: [sessionId], references: [id])
  clientId    String
  event       String
  identityId  String?
  actorName   String?
  source      String?
  result      String
  reason      String?
  createdAt   DateTime        @default(now())
}
```

建议索引：

```prisma
@@index([clientId, createdAt])
@@index([sessionId, createdAt])
```

首版审计事件长期保留，不实现自动清理策略。审计列表必须分页，遵循项目 `PaginatedResult<T>` 规范。

### 8.3 状态

```ts
type TerminalSessionStatus =
  | "starting"
  | "active"
  | "detached"
  | "exited"
  | "interrupted"
  | "expired"
  | "closed"
  | "error";
```

| 状态 | 含义 | 是否计入 5 个会话上限 |
| --- | --- | --- |
| `starting` | DB 已创建，Client 正在创建 PTY | 是 |
| `active` | PTY 存活且至少有一个浏览器 attach | 是 |
| `detached` | PTY 存活，无浏览器 attach，处于 30 分钟保留期 | 是 |
| `exited` | Shell 自行退出 | 否 |
| `interrupted` | Client/机器重启或 PTY 丢失 | 否 |
| `expired` | 无人连接超过 30 分钟，自动结束 | 否 |
| `closed` | 用户手动关闭 | 否 |
| `error` | 创建或运行基础设施失败 | 否 |

终态：`exited | interrupted | expired | closed | error`。终态不可重新 attach，不因迟到事件恢复为活动状态。

### 8.4 运行时内存状态

Server 只在内存保存：

```ts
interface TerminalAttachment {
  attachmentId: string;
  socketId: string;
  identityId: string;
  actorName: string;
  reconnectTokenHash: string;
  mode: "operator" | "viewer";
  state: "syncing" | "live";
  attachedAt: number;
  lastAckSeq: number;
}

interface TerminalControlLease {
  attachmentId: string;
  identityId: string;
  protectedUntil: number | null;
}
```

明文 reconnect token 只返回浏览器一次，Server 仅保存 hash；token 不写数据库和日志。`sessionStorage` 按 `clientId + sessionId` 保存 token，使同一浏览器标签刷新后可恢复操作权，但新标签默认作为独立 attachment。

---

## 9. 生命周期状态机

```text
POST create
  -> starting
  -> Client PTY created
  -> detached（创建后尚未 attach）
  -> Browser attach
  -> active

active
  -> 部分浏览器 detach，仍有人观察 -> active
  -> 最后一个浏览器 detach          -> detached + 30 分钟计时
  -> Shell 自行退出                 -> exited
  -> 用户关闭                       -> closed
  -> Client 重启/PTY 丢失           -> interrupted
  -> PTY 基础设施异常               -> error

detached
  -> 30 分钟内 attach               -> active
  -> 30 分钟到期                    -> expired
  -> 用户关闭                       -> closed
  -> Shell 自行退出                 -> exited
  -> Client 重启/PTY 丢失           -> interrupted
```

### 9.1 创建

1. Server 验证 actor、Client 在线和 `terminal.pty` capability。
2. Server 在按 `clientId` 串行的临界区中统计非终态会话，达到 5 个返回稳定错误。
3. Server 创建 `starting` DB 记录和 `created` 审计。
4. Server 向 Client 发送创建请求，包含 Server 生成的 `sessionId`、合法 `shellId`、初始 cols/rows。
5. Client 再次检查会话上限、Shell ID 和尺寸，创建 PTY。
6. Client 成功后 Server 将会话更新为 `detached`；失败则更新为 `error`。
7. Frontend 创建成功后立即通过 `/app` attach。

Server 与 Client 双重执行 5 会话上限。Server 防止正常竞态，Client 防止协议错误、Server 状态滞后或重连孤儿。

### 9.2 页面刷新

1. 原 socket 断开；Server 为 operator 开始 30 秒保护。
2. 新页面从 `sessionStorage` 读取 reconnect token。
3. 新 socket attach 同一 session 并提交 token。
4. token、actor 和 session 匹配时，Server 将 lease 重新绑定到新 attachment/socket。
5. 若旧 socket 尚未完成 disconnect，合法 token 重连可主动替换旧 socket，避免刷新等待。
6. Client 生成 snapshot；前端恢复画面并继续实时输出。
7. PTY PID、Shell 状态和 cwd 不变。

### 9.3 最后一个浏览器离开

- Server 通知 Client 当前 session 不再需要 live output 转发。
- Client 将会话标记为 detached 并启动 30 分钟本地计时。
- Server 同步 `detachedAt/expiresAt`。
- 30 分钟内重新 attach 会取消本地计时。
- 最终过期由 Client 执行，避免 Server 断线后产生永久孤儿 PTY。

### 9.4 Server 与 Client 临时断线

虽然核心需求只要求浏览器刷新恢复，首版仍应避免 Server 短暂断线立即杀死终端：

- Client Socket 断开时不立即结束 PTY；
- Client 将 Server 的所有 live attachment 视为暂时 detached，并从断线时开始 30 分钟计时；
- PTY 输出继续进入 Client headless snapshot，但不通过网络发送；
- Client 重连并完成 REGISTER 后上报 `TERMINAL_STATE`；
- Server 对账后，浏览器可重新 attach；
- Server 断线超过 30 分钟时 Client 自动过期会话。

### 9.5 Client 或机器重启

Client 每次进程启动生成随机 `terminalGenerationId`。重连状态报告带该 generation：

- 同一 Client 进程的 Socket 重连：generation 不变，可恢复 PTY。
- Client 进程重启：generation 改变，旧 PTY 不存在。
- Server 收到新 generation 的权威状态后，将数据库中该 Client 所有未终态但未上报的会话标记为 `interrupted`，错误码 `TERMINAL_CLIENT_RESTARTED`。
- 前端保留已中断标签和审计信息，但不能假装恢复；用户可新建终端。

### 9.6 手动关闭与进程树

手动关闭需要二次确认，并明确提示会结束 Shell 及其子进程。

Client 清理顺序：

1. 停止接受输入和 resize；
2. 关闭 PTY；
3. 尝试终止 PTY 所属进程组/进程树；
4. 等待有限 grace；
5. 仍未退出时执行平台兜底；
6. 释放 headless xterm、定时器、buffer 和监听器；
7. 上报最终状态。

平台策略：

- Linux/macOS：优先结束 PTY 会话/进程组，必要时 SIGTERM 后 SIGKILL；
- Windows：优先关闭 ConPTY，必要时以参数数组非 shell 调用 `taskkill /PID <pid> /T /F`；
- 已主动脱离进程组的 daemon 不保证被清理，UI 文案不得声称可以结束机器上的所有关联服务。

所有关闭操作必须幂等。迟到 output/exit 不能覆盖已确定的 `closed` 或 `expired` 原因。

---

## 10. 单写多读与操作权

### 10.1 基本规则

- 第一个成功 attach 且当前没有 lease 的页面成为 `operator`。
- 后续页面成为 `viewer`。
- Viewer 可查看、选择和复制文本，但不能发送 input、paste 或 resize。
- Server 对每个写消息执行最终权限检查；不能只依赖前端禁用输入。
- Client 也校验 session 是否存在，但不负责 Web actor 权限。

### 10.2 30 秒重连保护

operator socket 断开后：

```text
now < protectedUntil
  -> 原 reconnect token 可恢复 operator
  -> Viewer 不能接管，返回 TERMINAL_CONTROL_PROTECTED

now >= protectedUntil
  -> Viewer 可点击“接管”
  -> 第一个原子成功的请求成为 operator
```

保护期内原 operator token 重连后，保护计时取消。

### 10.3 接管

1. Viewer 点击“接管”。
2. Server 在 session 级串行临界区中检查保护期和当前 lease。
3. 成功后旧 lease 作废，申请者成为 operator。
4. Server 向所有 attachments 广播 control state。
5. 新 operator 执行 fit 并发送权威 cols/rows。
6. Server 写 `takeover` 审计。

不自动把最早 Viewer 提升为 operator，避免后台页面无意获得键盘控制。

### 10.4 同一身份的多个页面

控制权按 attachment，而不是只按 identity。即使两个页面由同一账号打开，也只有一个页面可写。reconnect token 同时绑定 identity 和原 attachment；不同身份不能凭 token 接管。

---

## 11. 输出、快照、顺序与背压

### 11.1 输出序号

Client 为每个 session 维护从 1 开始的单调 `seq`：

```ts
interface TerminalOutputChunk {
  sessionId: string;
  seq: number;
  data: string;
}
```

每个 chunk UTF-8 编码后最大 64 KiB。大块必须切分；空块拒绝。Client 将多个极小 data 以短时间窗口批量发送，目标为约 16ms 或达到 64 KiB，降低 Socket.IO 事件数量。

### 11.2 attach 同步

Server 对新 attachment 使用 `syncing` 状态：

1. 建立 attachment，但暂不直接写 live output 到该浏览器。
2. 请求 Client snapshot。
3. Client 返回 `{ snapshot, snapshotSeq, cols, rows, historyTruncated }`。
4. 同步期间 Server 为该 attachment 暂存后续 `seq > snapshotSeq` 的有限增量。
5. Server 先发送 snapshot，再按 seq 发送暂存增量。
6. attachment 进入 `live`。
7. 前端对 seq 去重，发现 gap 时请求 resync。

单 attachment 同步暂存上限为 2 MiB。超过时不继续增长内存，发送 `TERMINAL_RESYNC_REQUIRED` 并重新获取较新的 snapshot。

### 11.3 慢消费者

Server 不为慢浏览器无限缓存，也不因一个 Viewer 暂停远端 PTY。Frontend 定期上报最后写入 xterm 的 seq。若 attachment 落后超过安全阈值或发生 gap：

- Server 标记该 attachment 需要 resync；
- 暂停向该 attachment 发送增量；
- 获取新 snapshot；
- 其他 attachments 不受影响。

### 11.4 无浏览器时

最后一个 attachment 离开后，Server 通知 Client 停止发送 live output。Client 仍将 PTY 输出写入 headless terminal，因此 30 分钟内重新 attach 可以恢复当前画面，而不会在 Server/网络上持续传输无人查看的输出。

### 11.5 输入与 resize

- xterm `onData` 原样产生输入字符串，包括控制字符；
- Server 只接受 operator 输入；
- 单个 input UTF-8 编码后最大 64 KiB；
- 每个 operator 设置合理的字节速率上限，超限返回稳定错误并断开该 attachment 的写权限；
- resize 只接受 operator，范围 `cols: 20..500`、`rows: 5..300`；
- ResizeObserver + FitAddon 的高频 resize 需按约 50ms 合并；
- Viewer 使用远端 cols/rows 渲染，不改变 PTY 尺寸；
- 操作权转移后，新 operator 立即提交自身 fit 结果。

---

## 12. 协议设计

所有跨信任边界的终端消息必须在 Shared 提供运行时 parser/type guard；非法消息不得进入业务服务。

### 12.1 Shared 常量

```ts
export const TerminalLimits = {
  maxSessionsPerClient: 5,
  reconnectGraceMs: 30_000,
  detachedTtlMs: 30 * 60_000,
  maxInputBytes: 64 * 1024,
  maxOutputChunkBytes: 64 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
  syncBacklogBytes: 2 * 1024 * 1024,
  scrollbackLines: 2_000,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 300,
} as const;
```

### 12.2 Browser -> Server `/app`

建议事件：

```text
terminal:attach
terminal:detach
terminal:input
terminal:resize
terminal:takeover
terminal:ack-output
terminal:resync
```

Server -> Browser：

```text
terminal:attached
terminal:snapshot
terminal:output
terminal:control
terminal:state
terminal:resync-required
terminal:error
```

关键 DTO：

```ts
interface TerminalBrowserAttach {
  sessionId: string;
  reconnectToken?: string;
}

interface TerminalBrowserAttached {
  sessionId: string;
  attachmentId: string;
  reconnectToken: string;
  mode: "operator" | "viewer";
  controlProtectedUntil: string | null;
}

interface TerminalBrowserInput {
  sessionId: string;
  attachmentId: string;
  data: string;
}

interface TerminalBrowserResize {
  sessionId: string;
  attachmentId: string;
  cols: number;
  rows: number;
}
```

每个请求通过 Socket.IO ack 返回判别联合：

```ts
type TerminalAck<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: TerminalErrorCode; message: string } };
```

### 12.3 Server <-> Client `/client`

控制请求使用 requestId 关联的判别联合：

```text
terminal:request   Server -> Client
terminal:response  Client -> Server
terminal:output    Client -> Server
terminal:exit      Client -> Server
terminal:state     Client -> Server（REGISTER 后和重连时）
```

动作至少包括：

```ts
type TerminalClientAction =
  | "shells.list"
  | "session.create"
  | "session.attach"
  | "session.detach"
  | "session.input"
  | "session.resize"
  | "session.snapshot"
  | "session.close";
```

高频 input/resize 仍沿用 typed request，但不要求每个 input 等待业务 ack；Server 在本地通过权限检查后发送，Client 只在协议或会话错误时返回/上报错误。create、snapshot、close、shells.list 必须等待 response。

所有 Client 上行消息必须通过 socket 已绑定的 `clientId` 校验，不能信任 payload 自带机器身份。Session 必须属于该 Client。

### 12.4 状态对账

```ts
interface TerminalStateReport {
  clientId: string;
  generationId: string;
  sessions: Array<{
    sessionId: string;
    shellId: string;
    status: "active" | "detached";
    cols: number;
    rows: number;
    lastSeq: number;
    detachedAt?: string;
    expiresAt?: string;
  }>;
}
```

Server ack：

```ts
interface TerminalStateAck {
  acceptedSessionIds: string[];
  closeSessionIds: string[];
}
```

对账规则：

- DB 存在且非终态、Client 也存在：接受并更新权威尺寸/状态；
- DB 非终态但 Client 未上报：标记 interrupted；
- Client 上报但 DB 不存在或 DB 已终态：加入 `closeSessionIds`，防止孤儿 PTY；
- payload clientId 与 socket 绑定身份不一致：拒绝整个报告；
- 同一 generation 的重复报告幂等。

---

## 13. REST API 与 SDK

机器范围 API：

```text
GET    /api/clients/:clientId/terminals/shells
GET    /api/clients/:clientId/terminals?page=&pageSize=
POST   /api/clients/:clientId/terminals
GET    /api/clients/:clientId/terminals/:sessionId
DELETE /api/clients/:clientId/terminals/:sessionId
GET    /api/clients/:clientId/terminals/:sessionId/audit?page=&pageSize=
```

### 13.1 Shell 列表

- Client 离线：`TERMINAL_CLIENT_OFFLINE`；
- 无 capability：`TERMINAL_UNSUPPORTED`；
- 返回安全 `TerminalShellInfo[]`；
- 可做短期内存缓存，但 Client 重连/generation 变化后失效。

### 13.2 会话列表

默认返回非终态会话和最近的已中断会话，按 `createdAt desc`。使用 `PaginatedResult<TerminalSessionInfo>`。前端终端标签只自动打开可 attach 的非终态会话；终态会话显示状态但不自动占用 xterm 实例。

### 13.3 创建请求

```ts
interface TerminalSessionCreateRequest {
  shellId: string;
  cols: number;
  rows: number;
}
```

不允许提交 executable、args、cwd 或 env。

### 13.4 关闭

DELETE 是幂等操作：

- 已 `closed`：返回当前状态；
- 其他终态：返回当前状态，不改写首次终态原因；
- Client 在线且会话存在：远端确认后写 `closed`；
- Client 离线：若 PTY 已因 generation 丢失则写 interrupted；若结果不确定，返回稳定临时错误，不谎称已关闭。

### 13.5 审计分页

遵循项目统一分页字段：`data`、`total`、`page`、`pageSize`、`totalPages`。默认 20，最大 100。审计响应不包含 socketId、token hash、输入输出或本地路径。

---

## 14. Server 模块设计

建议新增：

```text
packages/server/src/terminal/
  terminal.module.ts
  terminal.controller.ts
  terminal.service.ts
  terminal-request-broker.ts
  terminal-audit.service.ts
  terminal-errors.ts
```

### 14.1 TerminalController

负责 REST 元数据操作：Shell、列表、详情、创建、关闭和审计。使用现有 `@Actor()` 获取身份，沿用手动 DTO 校验，不引入全局 ValidationPipe。

### 14.2 TerminalService

负责：

- DB 会话状态；
- 每 Client 5 会话限制和创建串行化；
- attachment 集合；
- operator/viewer lease；
- 30 秒保护和接管；
- snapshot 同步 backlog；
- output seq 检查；
- Client state reconciliation；
- browser/client disconnect；
- 终态幂等；
- 向审计服务写安全事件。

首版只支持单 Server 进程。若未来水平扩展，需要把 attachment/lease/seq 协调迁移到共享实时状态设施；在此之前不能声称多实例安全。

### 14.3 TerminalRequestBroker

参考现有 Pi request broker 的深模块模式，但使用独立协议：

- requestId -> client socket 关联；
- 超时；
- Client 断线时失败 pending；
- 第二台 Client 不能伪造第一台 Client 的 response；
- payload 不进入普通日志；
- snapshot/create/close 分别使用合适超时；
- 不在 Server 保存终端正文。

### 14.4 浏览器 Gateway

现有 `AppGateway` 是 `/app` namespace 的唯一认证入口。首版不新增第二个同 namespace 的 connection handler，避免重复认证与连接生命周期竞态。

实现方式：

- `AppGateway` 注入 `TerminalService`；
- 增加 terminal `@SubscribeMessage` handlers；
- actor 继续来自现有 Cookie/Bearer 握手认证；
- disconnect 时通知 `TerminalService.detachBySocketId()`；
- handler 只做 parse、actor 提取、service 委托和安全 ack。

如实施时必须抽取 Gateway，应先把认证抽成可复用服务，并用测试证明同一 socket 只执行一次身份绑定；不得复制一份认证逻辑。

### 14.5 ClientGateway

扩展现有 `/client` gateway：

- bind terminal emitter；
- 接收 response/output/exit/state；
- 所有消息先 parse；
- 使用 socket 上绑定的 clientId；
- Client disconnect 通知 broker 和 TerminalService，但不立即把会话终结；
- REGISTER 完成后等待 state report 完成 terminal reconciliation。

---

## 15. Client 模块设计

建议新增：

```text
packages/client/src/terminal/
  capability.ts
  shell-discovery.ts
  terminal-manager.ts
  terminal-session.ts
  terminal-snapshot.ts
  process-tree.ts
  protocol-bridge.ts
```

### 15.1 TerminalManager

公开较小 surface：

```ts
interface TerminalManager {
  probe(): Promise<TerminalCapabilityStatus>;
  listShells(): Promise<TerminalShellInfo[]>;
  create(request): Promise<TerminalCreated>;
  attach(sessionId): Promise<TerminalSnapshot>;
  detach(sessionId): void;
  input(sessionId, data): void;
  resize(sessionId, cols, rows): void;
  close(sessionId, reason): Promise<void>;
  getStateReport(): TerminalStateReport;
  handleServerDisconnect(): void;
  shutdown(): Promise<void>;
}
```

具体实现可使用注入的 PTY adapter 便于单元测试，但不要为未使用的替代实现建立复杂 factory 层。

### 15.2 每会话资源

```ts
interface ActiveTerminalSession {
  sessionId: string;
  shellId: string;
  pty: IPty;
  headlessTerminal: Terminal;
  serializeAddon: SerializeAddon;
  seq: number;
  cols: number;
  rows: number;
  liveAttached: boolean;
  detachedAt: number | null;
  expiryTimer: NodeJS.Timeout | null;
  closed: boolean;
}
```

所有 output、resize、snapshot 在 session 内串行处理，确保 `snapshotSeq` 与 snapshot 内容一致。

### 15.3 桥接

Client 现有 socket 连接成功并 REGISTER ack 后：

1. 上报现有 Job status；
2. 上报 Pi state；
3. 上报 Terminal state。

三者必须分别解析、分别 ack，不能因某个可选能力失败阻止基础 Client 注册。

Terminal protocol bridge 不记录 input/output。Client 日志只允许 sessionId、action、状态和安全错误码。

### 15.4 退出

- Shell 自行退出时释放所有内存，发送 exit；
- Client 正常 shutdown 时尽力关闭所有 PTY；
- Client 崩溃时由 OS 处理其 PTY 子进程，但必须通过平台集成测试确认不会稳定遗留孤儿 Shell；
- 下次 Client 启动 generation 变化，Server 将旧会话标记 interrupted。

---

## 16. Frontend 页面设计

### 16.1 路由和入口

在 `packages/frontend/src/pages/machine-workspace.tsx` 的 tabs 增加：

```ts
["terminal", "终端"]
```

路由：

```text
/machines/:clientId/terminal
```

Terminal Tab 内容必须使用 `overflow-hidden`，由终端内部管理布局和滚动；不能套用工作区当前普通页面的 `overflow-y-auto`。

### 16.2 页面布局

```text
┌─────────────────────────────────────────────────────────┐
│ [PowerShell ●] [cmd 只读] [Bash 已中断] [＋新建] [记录] │
├─────────────────────────────────────────────────────────┤
│ PowerShell 7                    操作中      [关闭终端]   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│                       xterm.js                          │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ 终端继承远程 Client OS 用户权限，不是沙箱               │
└─────────────────────────────────────────────────────────┘
```

### 16.3 多标签

- 一个 Terminal Session 对应一个子标签；
- 标签默认使用 Shell label + 序号，例如 `PowerShell 1`、`Bash 2`；
- 首版不实现自定义重命名；
- 关闭子标签等同于关闭远端会话，必须确认；
- 切换子标签不 detach 会话，以保证多个打开标签仍可持续展示；
- 页面离开 Terminal Tab 时统一 detach 当前页面的所有 attachments，但远端 PTY 进入保留期，不立即关闭。

### 16.4 创建

“新建终端”菜单：

- 只展示 Client 实际上报 Shell；
- 默认 Shell 高亮；
- 达到 5 个会话时禁用并提示先关闭旧终端；
- Client 离线/不支持时显示稳定错误和升级/检查提示；
- 初始 cols/rows 来自可用容器尺寸，无尺寸时使用安全默认 `120x30`。

### 16.5 状态

必须有文字或图标+可访问名称，不能只靠颜色：

- 操作中；
- 只读；
- 操作权重连保护中；
- 可接管；
- 正在恢复；
- 机器断线；
- 会话已中断；
- 会话已退出；
- 会话已过期；
- 历史画面已截断。

### 16.6 只读行为

Viewer：

- 不绑定 xterm `onData` 到发送函数，或在发送前硬性检查 mode；
- 禁止 paste 按钮和粘贴事件写入 PTY；
- 允许鼠标选择和复制；
- 显示当前 operator 名称（如果可安全展示）；
- 保护期结束后显示“接管”按钮。

Server 仍做最终权限校验。

### 16.7 中文与复制粘贴

- 前后端协议字符串按 UTF-8 处理；
- xterm 使用支持中文的等宽字体 fallback；
- 宽字符和 emoji 宽度需人工测试；
- 复制使用 xterm selection + Clipboard API；
- 粘贴仅 operator 可用，保留 bracketed paste 语义；
- Clipboard API 不可用时给出浏览器原生快捷键提示；
- 不自动读取剪贴板，也不响应远端 OSC 52 写剪贴板。

### 16.8 审计 UI

提供轻量“操作记录”Dialog/Drawer：

- 分页展示时间、事件、操作者、Shell、结果/原因；
- 默认最近 20 条；
- 不展示输入输出；
- 不添加复杂筛选、导出或全文搜索。

---

## 17. 最小审计方案

记录事件：

| event | 触发点 |
| --- | --- |
| `created` | Server 接受创建并生成 session |
| `create_failed` | Client PTY 创建失败 |
| `attached` | 浏览器成功 attach |
| `detached` | 浏览器 attachment 移除 |
| `takeover` | Viewer 成功接管 |
| `closed` | 用户手动关闭 |
| `expired` | 30 分钟到期自动关闭 |
| `exited` | Shell 自行退出 |
| `interrupted` | Client 重启或 PTY 丢失 |

审计内容只允许：

- sessionId；
- clientId；
- shellId/shellLabel；
- event；
- identityId/actorName/source；
- timestamp；
- success/failure；
- allowlist reason 或稳定错误码。

禁止写入：

- input data；
- output data；
- snapshot；
- cwd；
- env；
- reconnect token/hash；
- socket handshake cookie/token；
- stack；
- 本地 executable 路径。

`attached/detached` 可能因刷新产生较多记录，但每次只是一条小型元数据。首版接受该开销，以满足“谁在何时连接/离开”的最小审计目标。

---

## 18. 稳定错误模型

```ts
export const TerminalErrorCode = {
  CLIENT_OFFLINE: "TERMINAL_CLIENT_OFFLINE",
  UNSUPPORTED: "TERMINAL_UNSUPPORTED",
  NATIVE_BACKEND_UNAVAILABLE: "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
  SESSION_NOT_FOUND: "TERMINAL_SESSION_NOT_FOUND",
  SESSION_LIMIT_REACHED: "TERMINAL_SESSION_LIMIT_REACHED",
  SHELL_NOT_AVAILABLE: "TERMINAL_SHELL_NOT_AVAILABLE",
  SESSION_ENDED: "TERMINAL_SESSION_ENDED",
  READ_ONLY: "TERMINAL_READ_ONLY",
  CONTROL_PROTECTED: "TERMINAL_CONTROL_PROTECTED",
  CONTROL_CONFLICT: "TERMINAL_CONTROL_CONFLICT",
  PTY_SPAWN_FAILED: "TERMINAL_PTY_SPAWN_FAILED",
  PTY_IO_FAILED: "TERMINAL_PTY_IO_FAILED",
  SNAPSHOT_FAILED: "TERMINAL_SNAPSHOT_FAILED",
  RESYNC_REQUIRED: "TERMINAL_RESYNC_REQUIRED",
  CLIENT_RESTARTED: "TERMINAL_CLIENT_RESTARTED",
  REQUEST_TIMEOUT: "TERMINAL_REQUEST_TIMEOUT",
  INPUT_TOO_LARGE: "TERMINAL_INPUT_TOO_LARGE",
  RATE_LIMITED: "TERMINAL_RATE_LIMITED",
  PROTOCOL_INVALID: "TERMINAL_PROTOCOL_INVALID",
} as const;
```

错误对象保持稳定 `code`、合适 HTTP status/Socket ack 和安全 message。未知错误统一映射为安全通用文案，不透传 stack、路径、命令、输入、输出或原生模块内部细节。

建议 HTTP 映射：

- 400：协议/尺寸/输入非法；
- 404：session 不存在；
- 409：会话上限、只读、控制权保护/冲突、已终态；
- 422：Shell/PTY 创建失败；
- 503：Client 离线或终端能力不可用；
- 504：Client 请求超时。

---

## 19. 安全设计

1. Browser `/app` 复用现有 Cookie/Bearer 身份认证。
2. Server `/client` 复用现有 PSK 认证。
3. 所有终端写操作在 Server 检查 attachment/operator。
4. reconnect token 使用高熵随机值，只存 hash，并绑定 identity/session/attachment。
5. 浏览器不能提交 executable、args、cwd 或 env。
6. Client 只执行探测白名单中的 shellId。
7. input/output/snapshot 不写 Server 数据库和普通日志。
8. 大小、尺寸、速率和内存均有界。
9. Server 不向浏览器暴露 Client PSK。
10. xterm output 作为终端控制序列处理，不插入 `dangerouslySetInnerHTML`。
11. 不启用远端写剪贴板能力。
12. UI 明示终端不是沙箱，权限等同 Client OS 用户。
13. 关闭、过期、退出和中断均幂等，避免竞态复活会话。
14. Client 上行 clientId/sessionId 必须与 socket 绑定身份和 DB 关系一致。
15. 测试和示例只运行无破坏性命令。

---

## 20. 可观测性

允许的结构化日志字段：

```text
requestId, sessionId, clientId, action, status, errorCode, durationMs
```

禁止日志字段：

```text
input, output, snapshot, cwd, env, executablePath, reconnectToken, cookie, PSK
```

建议内存指标：

- 活跃/ detached Terminal Session 数；
- operator/viewer attachment 数；
- snapshot bytes；
- resync 次数；
- 自动过期数；
- PTY 创建失败数；
- request timeout 数。

首版不要求引入新的监控系统；可在服务内部保留可测试计数或安全日志。不得为了指标记录终端正文。

---

## 21. 测试策略

### 21.1 Shared

- 所有 event/action/DTO parser 的合法和非法输入；
- 未知字段、缺失字段、错误类型；
- input/output/snapshot 大小边界；
- cols/rows 边界；
- 稳定错误码与常量；
- 运行时 parser 不接受 executable/cwd/env。

### 21.2 Client 单元测试

使用 fake PTY，覆盖：

- Windows/Linux Shell 探测顺序、去重和默认值；
- node-pty 加载失败只禁用 terminal capability；
- 创建、输入、resize、关闭；
- 每 Client 5 会话上限；
- seq 单调、chunk 切分和 UTF-8；
- snapshot 与 snapshotSeq 原子一致；
- attach/detach 取消或启动 30 分钟计时；
- Server socket 断开进入 detached 计时但不立即关闭；
- 过期清理幂等；
- Shell 自行退出；
- close/exit/expiry 竞态只有一个终态；
- generation state report；
- parent shutdown 和进程树清理；
- input/output 不进入日志。

### 21.3 Server 单元测试

- 每 Client 创建串行化和 5 会话限制；
- sanitized DB fields；
- requestId 并发、乱序、timeout 和 Client 身份绑定；
- 首个 attach 为 operator，后续为 viewer；
- 同 identity 多页面仍单写；
- 刷新 token 30 秒内恢复；
- token 错误、跨 identity、跨 session 拒绝；
- 保护期内 takeover 拒绝，期满首个成功；
- viewer input/resize 拒绝；
- snapshot syncing、增量排序、重复 seq 和 gap；
- 慢 attachment resync 不影响其他页面；
- 最后 detach 通知 Client；
- reconciliation 接受、interrupted、孤儿 close；
- 终态 CAS/幂等；
- 审计内容无 input/output/token/path；
- 审计分页符合 `PaginatedResult<T>`。

### 21.4 Frontend 单元测试

- 机器工作区出现“终端”Tab；
- Terminal route 使用满高、内部 overflow；
- capability unavailable 状态；
- Shell 选择和默认值；
- 多终端子标签及 5 个限制提示；
- xterm 创建/dispose；
- attach snapshot 后再写 delta；
- seq gap 触发 resync；
- operator 可输入，viewer 不发送输入；
- 控制权保护倒计时和接管；
- ResizeObserver 合并 resize；
- 刷新 token 存取；
- 中文、复制、粘贴权限；
- 关闭确认；
- interrupted/exited/expired 状态；
- 审计 Dialog 分页；
- 页面卸载只 detach，不 close PTY；
- Execute/Files/Pi 等现有 Tab 不回归。

### 21.5 Server-Client 集成测试

使用 fake PTY adapter 和真实 Socket.IO：

1. Browser create -> Server -> Client create -> attach；
2. input -> fake PTY -> output -> Browser；
3. resize 传递；
4. 第二浏览器只读；
5. operator disconnect/reconnect；
6. takeover；
7. snapshot + delta 恢复；
8. Server-Client 断线后 state reconcile；
9. Client generation 改变后 interrupted；
10. 30 分钟使用 fake timers 自动过期；
11. 手动关闭及审计；
12. 非法协议和跨 Client 伪造被拒绝。

### 21.6 平台人工验收

必须在真实环境执行，不能只用 fake PTY：

**Windows：**

- PowerShell 7（存在时）、Windows PowerShell、cmd；
- 中文输入与输出；
- 方向键、Tab 补全和历史；
- `Ctrl+C` 中断前台命令但不关闭 Shell；
- 全屏交互程序或等价 TUI；
- resize；
- 页面刷新后同一 PID/Shell/cwd；
- 关闭后确认进程树清理。

**Linux：**

- 默认 `$SHELL`、bash，存在时 zsh；
- `top`、`vim`；
- 中文/UTF-8；
- 方向键、Tab 补全、历史和 `Ctrl+C`；
- `stty size` 与页面尺寸一致；
- 页面刷新后同一 PID/Shell/cwd；
- 关闭和自动过期后的进程组清理。

---

## 22. 验收标准

### 22.1 功能

- 机器工作区可进入“终端”Tab。
- Windows/Linux 可创建真实 PTY 会话。
- 只显示 Client 实际可用 Shell，并提供正确默认值。
- 同一机器支持多个终端，最多 5 个。
- 普通命令、控制字符、补全、历史、全屏应用、中文和复制粘贴可用。
- resize 后远端 PTY 尺寸正确。

### 22.2 恢复

- 切换子标签不影响 PTY。
- 刷新/重新打开页面后，在保留期内恢复同一 PTY 进程。
- snapshot 与后续 output 顺序正确，不重复、不明显丢失。
- 最后一个页面离开后 30 分钟内可恢复。
- 30 分钟到期自动结束会话。
- Client/机器重启后明确显示“已中断”，不创建伪恢复进程。

### 22.3 单写多读

- 首个页面可操作，其他页面只读。
- Viewer 即使伪造 input/resize 也被 Server 拒绝。
- operator 刷新后 30 秒内恢复操作权。
- 保护期内 Viewer 不能接管。
- 保护期后只有一个 Viewer 原子接管成功。
- 接管后所有页面及时更新状态。

### 22.4 安全与审计

- Browser 与 Client 分别通过现有身份和 PSK 认证。
- 任意 executable/cwd/env 不能由浏览器下发。
- Server 数据库和日志不含输入、输出、snapshot、token、路径或环境变量。
- 审计可回答谁在何时创建、连接、接管和结束了哪个会话。
- UI 明确提示终端继承 Client OS 用户权限、不是沙箱。

### 22.5 回归

- Execute Tab 一次性命令行为不变。
- Files、FRP、Jobs、Pi 和机器心跳不回归。
- `pnpm build`、相关测试和 lint 通过。

---

## 23. 推荐文件地图

实际实施可根据现有模块边界微调，但调整后必须更新本文档。

```text
packages/shared/src/
  terminal.ts
  terminal.test.ts
  index.ts

packages/client/src/terminal/
  capability.ts
  capability.test.ts
  shell-discovery.ts
  shell-discovery.test.ts
  terminal-manager.ts
  terminal-manager.test.ts
  terminal-snapshot.ts
  terminal-snapshot.test.ts
  process-tree.ts
  protocol-bridge.ts
  protocol-bridge.test.ts

packages/server/src/terminal/
  terminal.module.ts
  terminal.controller.ts
  terminal.controller.test.ts
  terminal.service.ts
  terminal.service.test.ts
  terminal-request-broker.ts
  terminal-request-broker.test.ts
  terminal-audit.service.ts
  terminal-audit.service.test.ts

packages/sdk/src/
  terminal.ts
  terminal.test.ts

packages/frontend/src/terminal/
  terminal-socket.ts
  terminal-socket.test.ts
  terminal-view.tsx
  terminal-view.test.tsx
  terminal-tabs.tsx
  terminal-control.tsx

packages/frontend/src/pages/
  terminal-panel.tsx
  terminal-panel.test.tsx
```

既有改动点预计包括：

```text
packages/shared/src/index.ts
packages/client/src/index.ts
packages/client/src/register.ts
packages/client/package.json
packages/server/prisma/schema.prisma
packages/server/src/app.module.ts
packages/server/src/events/app.gateway.ts
packages/server/src/events/client.gateway.ts
packages/server/src/events/events.module.ts
packages/sdk/src/client.ts
packages/sdk/src/index.ts
packages/frontend/package.json
packages/frontend/src/pages/machine-workspace.tsx
pnpm-lock.yaml
```

---

# 24. 实施任务清单

> 规则：每个 Task 的所有 Step 通过后才勾选 Task 标题。执行过程中应直接更新本节复选框。所有复选框全部为 `[x]` 后，功能才算完成。
>
> ### TDD 执行约定
>
> 除 Task 1、Task 16、Task 17 这类技术实验、真实平台验收或最终检查外，所有可自动化的任务默认使用 **Red → Green → Refactor → Verify**：
>
> 1. **Impact / Baseline**：先按 `AGENTS.md` 对即将修改的既有 symbol 做 upstream impact；运行相关现有测试，确认基线为绿。HIGH/CRITICAL 必须先告知用户。新文件尚无 symbol 时无需对不存在的 symbol 做 impact，但调用它的既有接入点仍需分析。
> 2. **Red**：先写描述外部行为的失败测试，再运行指定命令，确认测试是因为待实现行为缺失而失败，而不是 import、fixture、环境或断言本身错误。必须在对应 Red 复选框中记录实际失败原因；未观察到有效红灯不得进入 Green。
> 3. **Green**：只写让当前失败测试通过的最小生产代码，不顺带实现后续 Task，不提前引入未使用抽象。
> 4. **Refactor**：在测试保持绿色的前提下消除重复、收窄类型、补充简体中文 JSDoc，并检查日志和错误信息是否安全。重构不改变本 Task 已批准行为。
> 5. **Verify**：先运行目标测试，再运行受影响包的全量测试与 build。若改动跨包，按 Shared → Client/Server → SDK → Frontend 的依赖顺序验证。
> 6. **Change review**：每个 Task 完成前运行 `gitnexus_detect_changes({ scope: "all" })`；核对影响流程后才能勾选 Task 完成项。若索引因新增代码过旧，先重建索引再检查。
>
> 测试命名应表达行为，不测试私有实现细节。时间相关逻辑使用 Vitest fake timers；Socket 使用受控 fake 或本地 Socket.IO test server；PTY 核心逻辑使用 fake adapter，真实 `node-pty` 留给技术验证与平台验收。禁止在自动化测试中执行破坏性命令。

## Task 1：原生 PTY 与 xterm 恢复能力技术验证

**方式：验收驱动 Spike（不机械套用单元 TDD）**

**产物：**

- Create: `docs/verification/interactive-terminal-pty-spike.md`
- Create（验证后可删除或移入测试夹具）: `scripts/terminal-pty-spike.cjs`
- Modify: 本文档第 6 节与“设计变更记录”中的最终依赖版本和限制

**先定义失败判据：** 安装/构建失败、Client 主入口静态加载原生模块、中文损坏、resize 无效、`Ctrl+C` 关闭整个 Shell、snapshot 无法恢复普通屏或 alternate screen，任一出现且无安全替代方案即视为 Spike 失败，不进入正式实现。

**执行细节：**

1. 在临时分支或显式 pathspec 下添加候选依赖，不先接入业务代码。
2. Spike 创建 PTY，打印唯一标记，执行 cwd/PID 查询、resize、`Ctrl+C` 和退出；不得执行破坏性命令。
3. 将 PTY 输出同时写入 headless xterm，序列化后写入新的 headless/xterm 实例，对比可见行、光标位置、颜色和尺寸。
4. Windows 至少测试 `pwsh`（存在时）、`powershell`、`cmd`；Linux 至少测试 `$SHELL` 和 `bash`。
5. 用一个故意缺失的动态 import 路径证明 capability probe 可以安全降级，且 Client 基础入口仍能加载。
6. 记录 Node、OS、架构、包版本、是否需要编译工具、命令、结果和限制；Spike 代码不得混入生产模块。

**验证命令模板：**

```bash
pnpm install
pnpm --filter @vcpdeck/client build
node scripts/terminal-pty-spike.cjs
pnpm --filter @vcpdeck/client test
```

Linux 必须在真实 Linux 环境重复执行，不能用 Windows mock 代替。

- [x] **1.1** 在 Windows x64 和 Linux x64 验证候选 `node-pty` 版本可通过 pnpm 安装、TypeScript 构建和最小运行。
- [x] **1.2** 验证当前 Node.js 版本、开发安装和目标部署环境的预编译/本地编译要求，并记录选定版本。
- [x] **1.3** 验证 `@xterm/headless` + serialize addon 对 PowerShell/cmd/bash、颜色、光标、scrollback、alternate screen 和 resize 的恢复效果。
- [x] **1.4** 验证 `node-pty` 加载失败不会阻止 Client 基础功能启动的延迟加载方案。
- [x] **1.5** 将验证结论、依赖版本和已知限制写入本文档“设计变更记录”。
- [x] **Task 1 完成：技术选型可落地且无未记录阻塞项。**

## Task 2：Shared 终端协议、限制与运行时解析

**TDD：是**

**Files：**

- Create: `packages/shared/src/terminal.ts`
- Create: `packages/shared/src/terminal.test.ts`
- Modify: `packages/shared/src/index.ts`

**Red：先写的行为测试：**

- 合法 create/attach/input/resize/state/snapshot/ack 可解析并保持判别字段；
- 未知 action、额外顶层字段、空 sessionId、错误方向事件被拒绝；
- input 按 UTF-8 字节而非 JS 字符数执行 64 KiB 边界；
- snapshot/output chunk 超限、NaN/小数/越界 cols/rows 被拒绝；
- 浏览器 create DTO 中出现 `executable/args/cwd/env` 被拒绝；
- state report 中重复 sessionId、非法日期、错误 clientId 类型被拒绝；
- parser 的失败结果只包含稳定错误，不回显原始 data。

**Red 命令：**

```bash
pnpm --filter @vcpdeck/shared test -- src/terminal.test.ts
```

预期先因类型、parser 和常量不存在而失败。

**Green：** 先定义稳定常量和判别联合，再实现最小手写 parser/type guard；不要新增 schema 库。公共类型和函数添加简体中文 JSDoc，从 `index.ts` 导出。

**Refactor：** 抽取 `isRecord`、strict keys、UTF-8 bytes、尺寸检查等小型内部 helper；确保 parser 不修改输入对象，也不使用 `any` 透传。

**Verify：**

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/shared build
```

- [x] **2.TDD-1 Baseline/Impact**：完成既有导出入口影响分析并确认 Shared 基线测试为绿。
- [x] **2.TDD-2 Red**：先提交行为测试，实际运行并记录“类型/parser/常量缺失”的有效失败原因。
- [x] **2.TDD-3 Green**：以最小协议和 parser 让新增测试转绿，不实现后续业务。
- [x] **2.TDD-4 Refactor**：在绿灯下整理 strict-key/字节/尺寸 helper、JSDoc 和安全错误。
- [x] **2.TDD-5 Verify/Review**：目标测试、Shared 全量测试、build 和 detect_changes 均通过。
- [x] **2.1** 新建 `packages/shared/src/terminal.ts` 与测试，定义 capability、Shell、Session、Audit、Browser/Client DTO、状态和错误码。
- [x] **2.2** 定义 `TerminalLimits`，覆盖会话数、30 秒保护、30 分钟 TTL、大小、尺寸、scrollback 和同步 backlog。
- [x] **2.3** 为所有跨 Socket 信任边界的消息实现运行时 parser/type guard，拒绝未知 action、非法字段和超限内容。
- [x] **2.4** 从 `packages/shared/src/index.ts` 导出公共 surface，并添加简体中文 JSDoc。
- [x] **2.5** Shared 单元测试和 build 全部通过。
- [ ] **Task 2 完成：协议有界、可解析且无 any 直穿信任边界。**

## Task 3：Prisma 会话与最小审计模型

**TDD：是（数据库迁移先做可执行验收，再实现 service mapping）**

**Files：**

- Modify: `packages/server/prisma/schema.prisma`
- Create: `packages/server/prisma/migrations/<timestamp>_add_terminal_sessions/migration.sql`
- Create: `packages/server/src/terminal/terminal-records.ts`
- Create: `packages/server/src/terminal/terminal-records.test.ts`
- Modify: 数据库隔离测试 fixture（按仓库现有位置确定）

**Red：** 先写测试证明：创建记录只接受批准字段；`toTerminalSessionInfo()` 不返回内部关系/错误原文；终态时间和原因正确映射；审计映射不允许正文类字段；分页结果字段完整。迁移测试先对一份旧 schema 临时数据库执行 migration，并查询两张新表和索引，当前应失败。

**Green：** 添加 Prisma 模型、关系、索引与 migration；实现最小 record mapper，不在本 Task 提前实现业务 service。

**关键迁移验证：**

```bash
pnpm --filter @vcpdeck/server exec prisma generate
pnpm --filter @vcpdeck/server test -- src/terminal/terminal-records.test.ts
pnpm --filter @vcpdeck/server build
```

还需使用项目现有测试数据库 helper 验证：旧 DB 升级保留 Client/Job 数据；空 DB 初始化成功；测试 DB 不触碰开发 DB。

**Refactor/安全检查：** 全文搜索新增模型写入点，确认不存在 input/output/snapshot/reconnectToken/executable/cwd/env 字段。

- [x] **3.TDD-1 Baseline/Impact**：分析 Prisma Client 关系和现有数据库测试入口，确认 Server/DB 基线为绿。
- [x] **3.TDD-2 Red**：先运行旧库升级、空库初始化和安全 mapper 失败测试，记录缺表/缺 mapper 的有效红灯。
- [x] **3.TDD-3 Green**：添加最小 schema、migration 和 mapper 使新增测试通过。
- [x] **3.TDD-4 Refactor**：在绿灯下整理 API 映射和索引，不引入业务 Service。
- [x] **3.TDD-5 Verify/Review**：迁移隔离测试、Server 测试/build 和 detect_changes 通过。
- [x] **3.1** 修改 Prisma schema，新增 `TerminalSession`、`TerminalAuditEvent` 及必要关系和索引。
- [x] **3.2** 创建正式 migration，验证已有数据库升级和空数据库初始化。
- [x] **3.3** 实现安全 API 映射，确认 DB 不含 input/output/snapshot/token/path/env。
- [x] **3.4** 为状态字段、终态字段和审计分页添加数据库层测试。
- [x] **3.5** Prisma generate、Server build 和数据库隔离测试通过。
- [ ] **Task 3 完成：会话元数据和审计可以安全持久化。**

## Task 4：Client capability 与跨平台 Shell 探测

**TDD：是**

**Files：**

- Create: `packages/client/src/terminal/capability.ts`, `capability.test.ts`
- Create: `packages/client/src/terminal/shell-discovery.ts`, `shell-discovery.test.ts`
- Modify: `packages/client/src/register.ts`, `register.test.ts`
- Modify: `packages/client/src/index.ts`（只接入延迟 probe，不静态加载 PTY）
- Modify: `packages/client/package.json`, `pnpm-lock.yaml`

**Impact：** 修改前分析 `getRegisterInfo`、`connect` 以及实际改动的既有 probe/注册 symbol。

**Red：** 依赖注入 fake platform/env/access/resolveExecutable/loadPty，覆盖：Windows 完整顺序和缺项组合；Linux `$SHELL` 不可执行时降级；同一 executable 别名去重；仅一个默认项；原生模块 load reject 返回 `TERMINAL_NATIVE_BACKEND_UNAVAILABLE`；错误不含 fake secret path；失败状态不声明 `terminal.pty`，但既有 capabilities 保持。

```bash
pnpm --filter @vcpdeck/client test -- src/terminal/capability.test.ts src/terminal/shell-discovery.test.ts src/register.test.ts
```

**Green：** 只实现安全 shellId 到内部 executable/args 的内存映射。公开 DTO 不含路径。`node-pty` 必须在 probe/manager 创建时动态 import；Client 顶层 import 图不得加载它。

**Refactor：** platform 分支保持聚焦，不创建空 factory；探测命令一律 `shell:false`/参数数组；稳定错误使用 allowlist message。

**Verify：**

```bash
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/client build
# 检查 dist 主入口没有 node-pty 顶层加载语句；具体命令按构建产物调整
```

- [x] **4.TDD-1 Baseline/Impact**：完成 `getRegisterInfo`、`connect` 等实际接入点 impact，并确认 Client 基线为绿。
- [x] **4.TDD-2 Red**：先写平台/失败组合测试并观察探测 API 缺失的有效红灯。
- [x] **4.TDD-3 Green**：实现最小延迟 probe 和 shellId registry 使测试转绿。
- [x] **4.TDD-4 Refactor**：在绿灯下去重平台逻辑、收窄公开 DTO、检查安全错误。
- [x] **4.TDD-5 Verify/Review**：目标/全量测试、Client build、顶层 import 检查和 detect_changes 通过。
- [x] **4.1** 实现终端后端延迟探测，成功时声明 `terminal.pty`，失败时返回稳定安全原因且不影响其他能力。
- [x] **4.2** 实现 Windows `pwsh -> powershell -> cmd` 探测、去重和默认选择。
- [x] **4.3** 实现 Linux `$SHELL -> bash -> zsh -> sh` 探测、可执行校验、去重和默认选择。
- [x] **4.4** 确保 API 不返回 executable 绝对路径、PATH、home 或本地 stack。
- [x] **4.5** 更新 Client 注册 capability details 和相关 fixtures/tests。
- [x] **4.6** Windows/Linux 探测单元测试与 Client build 通过。
- [ ] **Task 4 完成：Frontend 只能选择 Client 认可的安全 shellId。**

## Task 5：Client TerminalManager 与 PTY 生命周期

**TDD：是，核心任务必须严格 Red-Green-Refactor**

**Files：**

- Create: `packages/client/src/terminal/terminal-session.ts`
- Create: `packages/client/src/terminal/terminal-manager.ts`
- Create: `packages/client/src/terminal/terminal-manager.test.ts`
- Create: `packages/client/src/terminal/process-tree.ts`, `process-tree.test.ts`

**测试夹具：** 定义最小 `PtyAdapter` fake，允许测试主动 emit data/exit、记录 write/resize/kill；注入 clock/timer、shell registry、safe home 和 output listener。fake 仅在测试中，不把测试便利接口暴露为公共协议。

**Red 分批进行，不能一次写完所有生产代码：**

1. create 使用 shellId、home、固定 args/env，并拒绝未知 shell/重复 session；
2. 第 6 个活跃会话失败，终态释放名额；
3. operator input 原样 write，按 UTF-8 字节拒绝超限；resize 校验并调用 PTY；
4. data 产生严格单调 seq，64 KiB 切分，极小 chunk 按定时窗口合并；
5. 最后 detach 启动 30 分钟 timer，29:59 不关闭，30:00 关闭；reattach 取消；
6. Server disconnect 对所有 live session 进入 detached，但不立即 kill；
7. exit/close/expiry/shutdown 竞态只 settle 和释放一次；
8. close 调用平台 process-tree 清理，错误转为安全 code。

每组先运行并观察对应红灯，再写最小实现。

**目标命令：**

```bash
pnpm --filter @vcpdeck/client test -- src/terminal/terminal-manager.test.ts src/terminal/process-tree.test.ts
```

**Refactor：** 将单会话状态封装在 `TerminalSession`，Manager 负责 registry/上限；集中 settle；所有 timer/listener 在终态释放；日志依赖只接收安全 metadata。

**Verify：** 使用 fake timers 后必须恢复 real timers；运行 Client 全量测试和 build，检查无悬挂 handle。

- [x] **5.TDD-1 Baseline/Impact**：分析 Client 入口/关闭流程接入点，确认现有 Client 测试无悬挂句柄。
- [x] **5.TDD-2 Red**：按 create → 上限 → I/O → timer → disconnect → 终态竞态 → process tree 分组逐次观察有效红灯。
- [x] **5.TDD-3 Green**：每组只添加使当前失败行为通过的最小 Manager/Session 代码。
- [x] **5.TDD-4 Refactor**：保持全绿后集中 settle、timer/listener cleanup 和安全日志边界。
- [x] **5.TDD-5 Verify/Review**：fake timers 恢复、目标/全量测试、Client build 和 detect_changes 通过。
- [x] **5.1** 实现 PTY adapter 和 `TerminalManager`，支持 create/input/resize/close/exit。
- [x] **5.2** 实现每 Client 最多 5 会话的 Client 侧最终限制。
- [x] **5.3** 实现安全初始 cwd、固定 Shell 参数和环境变量策略。
- [x] **5.4** 实现 input/output 大小限制、output chunk 切分、短窗口批量和 seq。
- [x] **5.5** 实现最后 detach 后 30 分钟本地过期计时，重新 attach 取消计时。
- [x] **5.6** 实现 Server Socket 断开时会话保留但进入 detached 计时。
- [x] **5.7** 实现 shell exit、manual close、expiry 和 shutdown 的幂等资源释放。
- [x] **5.8** 实现 Windows/Linux 进程树清理和无破坏性测试。
- [x] **5.9** 使用 fake PTY 的 TerminalManager 单元测试全部通过。
- [ ] **Task 5 完成：PTY 生命周期、上限和自动清理可控。**

## Task 6：Client headless snapshot 与恢复

**TDD：是**

**Files：**

- Create: `packages/client/src/terminal/terminal-snapshot.ts`
- Create: `packages/client/src/terminal/terminal-snapshot.test.ts`
- Modify: `terminal-session.ts`, `terminal-manager.ts` 及对应测试

**Red：** 用 headless xterm 或小型 adapter 写行为测试：写入 `A(seq1)` 后 snapshot 包含 A 且 `snapshotSeq=1`；snapshot 请求与 `B(seq2)` 竞争时结果只能是“snapshot 含 B/seq2”或“不含 B/seq1”，不得交叉；resize 后 snapshot 行列一致；scrollback 上限生效；中文宽字符不破坏下一字符位置；ANSI 颜色/清屏/alternate screen 可序列化；8 MiB 超限返回有界结果与 `historyTruncated`。

**Green：** 每 session 使用单一串行队列/临界区处理 output、resize、snapshot；先更新 headless terminal 和 seq，再发布 output。不要把 snapshot 存 DB/Server 日志。

**Refactor：** 隔离 xterm 版本相关 API 到 `terminal-snapshot.ts`，便于升级；错误统一为 `TERMINAL_SNAPSHOT_FAILED`。

**Verify：**

```bash
pnpm --filter @vcpdeck/client test -- src/terminal/terminal-snapshot.test.ts src/terminal/terminal-manager.test.ts
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/client build
```

- [x] **6.TDD-1 Baseline/Impact**：分析 Task 5 新增 Manager/Session 接入面并确认其测试仍为绿。
- [x] **6.TDD-2 Red**：先写 snapshot/seq 原子性、ANSI、alternate screen、宽字符和上限测试并观察有效红灯。
- [x] **6.TDD-3 Green**：实现最小串行 snapshot adapter 使测试转绿。
- [x] **6.TDD-4 Refactor**：在绿灯下隔离 xterm 版本 API、统一错误和资源释放。
- [x] **6.TDD-5 Verify/Review**：snapshot/Manager/Client 全量测试、build 和 detect_changes 通过。
- [x] **6.1** 将每个 PTY output 串行写入 headless xterm，并维护一致的 seq/cols/rows。
- [x] **6.2** 实现有界 snapshot 序列化、`snapshotSeq` 和 `historyTruncated`。
- [x] **6.3** 实现 snapshot/output 并发下的原子顺序，避免 snapshot 包含范围与 seq 不一致。
- [x] **6.4** 实现 resize 对 PTY 和 headless terminal 的一致更新。
- [x] **6.5** 覆盖普通屏、scrollback、alternate screen、中文宽字符和超限截断测试。
- [x] **6.6** Client snapshot 单元测试与 build 通过。
- [ ] **Task 6 完成：新页面可用 snapshot + delta 重建当前终端画面。**

## Task 7：Client Socket.IO 终端桥与状态对账报告

**TDD：是**

**Files：**

- Create: `packages/client/src/terminal/protocol-bridge.ts`
- Create: `packages/client/src/terminal/protocol-bridge.test.ts`
- Modify: `packages/client/src/index.ts` 及现有 socket bridge 测试

**Impact：** 分析 `connect`、现有 REGISTER ack/STATUS_REPORT/PI_STATE 接入流程。

**Red：** 使用 fake Socket 和 fake Manager 验证：非法 request 不调用 Manager；shells/create/snapshot/close 按 requestId response；input/resize 不等待业务完成但错误安全上报；output/exit 带 session/seq；REGISTER ack 前不发 state；每次重连代次都发 state；同进程 generation 不变；state ack 的 orphan IDs 被关闭；disconnect 只调用 `handleServerDisconnect`；state JSON 不含 secret cwd/env/output。

**Green：** 实现独立 `attachTerminalBridge(socket, manager, deps)`，避免继续膨胀 `connect()`；bridge 只负责编排和 parse，业务在 Manager。

**Refactor：** 保持 Pi、Job、Terminal 三种 bridge 相互独立；listener 提供 cleanup，防止重连重复绑定。

**Verify：**

```bash
pnpm --filter @vcpdeck/client test -- src/terminal/protocol-bridge.test.ts
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/client build
```

- [x] **7.TDD-1 Baseline/Impact**：完成 `connect`、REGISTER ack 与现有 bridge 流程 impact，确认基线为绿。
- [x] **7.TDD-2 Red**：先写 request/response、重连代次、state ack 和 cleanup 测试并观察有效红灯。
- [x] **7.TDD-3 Green**：实现最小独立 terminal bridge，使新增测试转绿。
- [x] **7.TDD-4 Refactor**：在绿灯下拆分 Job/Pi/Terminal bridge listener 生命周期。
- [x] **7.TDD-5 Verify/Review**：Client 目标/全量测试、build 和 detect_changes 通过。
- [x] **7.1** 实现 terminal request/response/output/exit/state bridge，所有入站消息先 parse。
- [x] **7.2** Client 进程启动生成 `terminalGenerationId`，REGISTER ack 后上报 state。
- [x] **7.3** state report 不含 cwd、env、executable、input/output/snapshot。
- [x] **7.4** 正确应用 `acceptedSessionIds/closeSessionIds` ack，清理 Server 不接受的孤儿 PTY。
- [x] **7.5** Socket 断线不 shutdown TerminalManager；Client 正常退出时清理。
- [x] **7.6** bridge 身份、乱序、断线、重连和非法协议测试通过。
- [ ] **Task 7 完成：Client 终端可通过现有 PSK 连接安全通信并对账。**

## Task 8：Server TerminalRequestBroker 与 ClientGateway 接入

**TDD：是**

**Files：**

- Create: `packages/server/src/terminal/terminal-request-broker.ts`, `terminal-request-broker.test.ts`
- Modify: `packages/server/src/events/client.gateway.ts`, `client.gateway.test.ts`

**Impact：** 修改前分析 `ClientGateway.afterInit`、`handleRegister`、`handleDisconnect` 及实际新增 handler 所依赖的既有 symbol。

**Red（Broker）：** 并发 request 乱序正确关联；timeout 使用 fake timers；disconnect 只拒绝目标 socket/client；未知/重复 response 忽略；c2 不能 resolve c1；Emitter 未绑定和 Client offline 返回稳定错误；日志 spy 不包含 payload。

**Red（Gateway）：** 未 REGISTER 的 socket 上报 terminal 消息被拒绝；payload clientId 伪造无效；所有消息先经过 parser；output/exit/state 以绑定 clientId 交给 service；REGISTER 后 emitter room 正确；disconnect 通知 broker/service 但不直接结束 session。

**Green：** Broker 使用 `Map<requestId,{socketId/clientId,...}>`；Gateway handler 保持薄，身份从 `client.data.clientId` 获取。

**Refactor：** 若 `afterInit` emitter 绑定增多，只抽取安全的小型 bind 方法，不改变现有 Pi/Job 行为。

**Verify：**

```bash
pnpm --filter @vcpdeck/server test -- src/terminal/terminal-request-broker.test.ts src/events/client.gateway.test.ts
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/server build
```

- [x] **8.TDD-1 Baseline/Impact**：完成 ClientGateway 相关 symbol impact，确认现有 Gateway/Broker 测试为绿。
- [x] **8.TDD-2 Red**：先写 Broker 身份/超时和 Gateway 绑定身份测试并观察有效红灯。
- [x] **8.TDD-3 Green**：实现最小 Broker 与薄 Gateway handlers 使测试转绿。
- [x] **8.TDD-4 Refactor**：在绿灯下整理 emitter 绑定、pending cleanup 和安全错误映射。
- [x] **8.TDD-5 Verify/Review**：Server 目标/全量测试、build 和 detect_changes 通过。
- [x] **8.1** 实现 requestId broker、超时、断线失败、Emitter 绑定和安全错误映射。
- [x] **8.2** 验证第二台 Client 不能用第一台 requestId 伪造 response。
- [x] **8.3** 扩展 ClientGateway 接收 terminal response/output/exit/state，使用 socket 绑定 clientId。
- [x] **8.4** 实现 output seq 基础校验和终态迟到事件丢弃。
- [x] **8.5** Client disconnect 只进入可恢复状态，不立即把全部会话写成终态。
- [x] **8.6** broker/Gateway 单元测试和 Server build 通过。
- [ ] **Task 8 完成：Server 与远程 PTY 的代理链路安全可用。**

## Task 9：Server TerminalService、租约与 reconciliation

**TDD：是，使用状态机示例表和 fake timers**

**Files：**

- Create: `packages/server/src/terminal/terminal.service.ts`, `terminal.service.test.ts`
- Create: `packages/server/src/terminal/terminal-errors.ts`
- Modify: Prisma mapping/terminal module（装配留到 Task 11）

**测试依赖：** fake Prisma、Broker、Audit、clock/token generator/hash、browser emitter。token 测试只比较 hash，不把明文写 fixture snapshot。

**Red 分组：**

1. create 对同 client 串行：5 个并发成功后第 6 个稳定失败；Client create 失败使 DB `error`；
2. 首 attach operator、次 attach viewer；同 identity 仍 viewer；
3. disconnect 后 30 秒保护；合法 token 在 29.999 秒恢复；错误/跨身份/跨 session token 拒绝；
4. 30 秒后两个 takeover 并发仅一个成功并广播；
5. viewer input/resize/resync 拒绝且 Broker 零调用；
6. snapshot syncing 时 seq 增量按序暂存；重复丢弃、gap/resync、2 MiB 触发重同步；
7. 最后 detach 只发送一次 Client detach，首个 reattach 取消 detached；
8. reconcile 的四种矩阵：双方存在、DB-only、Client-only、DB 已终态但 Client 上报；
9. close/exit/expired/interrupted/error 竞态保留首个合法终态；迟到 output 不复活；
10. browser/client disconnect 与 token/attachment cleanup 无泄漏。

**Green：** 按上述分组逐组实现，不先实现后续 REST/UI。session 级互斥可用 Promise chain/小型 keyed queue；必须测试异常后队列仍可继续。

**Refactor：** 将 lease、sync backlog、terminal transition 拆成聚焦内部对象/纯函数；不提前做多 Server 抽象。

**Verify：**

```bash
pnpm --filter @vcpdeck/server test -- src/terminal/terminal.service.test.ts
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/server build
```

- [x] **9.TDD-1 Baseline/Impact**：分析将被调用的 Prisma/Broker/Audit surface，确认依赖任务测试为绿。
- [x] **9.TDD-2 Red**：按创建、lease、token、takeover、权限、同步、对账、终态竞态分组逐次观察红灯。
- [x] **9.TDD-3 Green**：每组只实现当前状态转移和副作用的最小代码。
- [x] **9.TDD-4 Refactor**：保持全绿后抽取 lease/sync/transition 纯逻辑，不提前支持多 Server。
- [x] **9.TDD-5 Verify/Review**：fake timer/并发测试、Server 全量测试/build 和 detect_changes 通过。
- [x] **9.1** 实现按 clientId 串行创建、DB 状态机和 Server 侧 5 会话限制。
- [x] **9.2** 实现 attachment/operator/viewer 状态和 reconnect token hash。
- [x] **9.3** 实现 30 秒 operator 重连保护和合法 token 重绑定。
- [x] **9.4** 实现保护期后原子 takeover，确保并发只有一个成功。
- [x] **9.5** 在 Server 强制拒绝 Viewer input/resize/resync 越权。
- [x] **9.6** 实现 snapshot syncing backlog、seq 去重/gap 和慢消费者 resync。
- [x] **9.7** 实现最后 detach 通知 Client、重新 attach 取消过期。
- [x] **9.8** 实现 generation/state reconciliation：接受存活、旧会话 interrupted、孤儿 close。
- [x] **9.9** 实现 close/exit/expired/interrupted/error 终态 CAS 和迟到事件保护。
- [x] **9.10** TerminalService fake timer、并发、恢复和安全测试通过。
- [ ] **Task 9 完成：会话恢复、单写多读和状态对账完整。**

## Task 10：最小审计服务

**TDD：是**

**Files：**

- Create: `packages/server/src/terminal/terminal-audit.service.ts`
- Create: `packages/server/src/terminal/terminal-audit.service.test.ts`

**Red：** 表驱动测试 9 种批准事件；未知 event/reason 被归一为 allowlist；actor/source/result 正确保存；输入对象即使带 `data/output/snapshot/token/path/env/stack` 也不会进入 Prisma create；列表使用 `findMany + count` 并发、`createdAt desc`、skip/take 和统一分页；终态重复调用只保留符合状态机的记录。

**Green：** Service 只接受窄 DTO，不接受任意 metadata bag；reason 仅保存稳定 code 或 allowlist 文案。

**Refactor：** 审计映射用纯函数并冻结批准事件集合；公共查询返回 Shared `TerminalAuditInfo`。

**Verify：**

```bash
pnpm --filter @vcpdeck/server test -- src/terminal/terminal-audit.service.test.ts
pnpm --filter @vcpdeck/server build
```

- [x] **10.TDD-1 Baseline/Impact**：分析 Prisma audit 写入/查询接入点，确认数据库测试基线为绿。
- [x] **10.TDD-2 Red**：先写事件 allowlist、敏感字段 canary、分页和重复终态测试并观察红灯。
- [x] **10.TDD-3 Green**：实现窄 DTO 审计 Service 使新增测试转绿。
- [x] **10.TDD-4 Refactor**：在绿灯下抽取安全 mapper 和批准事件集合。
- [x] **10.TDD-5 Verify/Review**：审计/Server 测试、build 和 detect_changes 通过。
- [x] **10.1** 实现 created/create_failed/attached/detached/takeover/closed/expired/exited/interrupted 写入。
- [x] **10.2** 实现审计分页查询，符合 `PaginatedResult<TerminalAuditInfo>`。
- [x] **10.3** 测试审计不存在 input/output/snapshot/token/path/env/stack。
- [x] **10.4** 验证重复终态不会重复写入冲突的结束审计。
- [x] **10.5** 审计服务测试和 Server build 通过。
- [ ] **Task 10 完成：最小审计可查询且不保存终端正文。**

## Task 11：REST Controller、Server 模块与 SDK

**TDD：是（Controller 与 SDK consumer contract 同步推进）**

**Files：**

- Create: `packages/server/src/terminal/terminal.controller.ts`, `terminal.controller.test.ts`
- Create: `packages/server/src/terminal/terminal.module.ts`
- Modify: `packages/server/src/app.module.ts`, `packages/server/src/events/events.module.ts`
- Create: `packages/sdk/src/terminal.ts`, `terminal.test.ts`
- Modify: `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`

**Impact：** 分析 `AppModule`、`EventsModule`、SDK Client constructor/domain 装配 symbol。

**Red（Controller）：** actor 透传；clientId/sessionId scope；create 缺 shellId、尺寸非法、额外 executable/cwd/env 返回 400；上限 409；离线 503；DELETE 幂等及不确定结果；分页 NaN/负数使用安全默认、pageSize 最大 100；service 错误映射正确；响应不含内部字段。

**Red（SDK）：** 每个 path 的 `encodeURIComponent`；分页用 URLSearchParams；create body 只有 shellId/cols/rows；AbortSignal 透传；返回 Shared 泛型；删除 method/path 正确。

```bash
pnpm --filter @vcpdeck/server test -- src/terminal/terminal.controller.test.ts
pnpm --filter @vcpdeck/sdk test -- src/terminal.test.ts
```

**Green：** 实现最小 endpoints/domain；沿用手工校验，不引入 ValidationPipe。模块装配避免 TerminalModule ↔ EventsModule 循环，必要时导出 Service/Broker 而非使用 forwardRef 逃避边界。

**Refactor：** Controller 不包含租约业务；SDK path builder 去重但不建立通用 factory。

**Verify：** Server/SDK 全量测试与 build。

- [x] **11.TDD-1 Baseline/Impact**：完成 AppModule/EventsModule/SDK domain 装配 impact，确认 Server/SDK 基线为绿。
- [x] **11.TDD-2 Red**：先写 Controller contract 和 SDK consumer contract 测试并分别观察红灯。
- [x] **11.TDD-3 Green**：实现最小 endpoints、module wiring 和 SDK domain 使测试转绿。
- [x] **11.TDD-4 Refactor**：在绿灯下去重 path/校验编排，业务仍留在 Service。
- [x] **11.TDD-5 Verify/Review**：Server/SDK 全量测试、build 和 detect_changes 通过。
- [x] **11.1** 实现 Shell、Session list/detail/create/delete 和 Audit REST endpoints。
- [x] **11.2** Controller 使用 `@Actor()`，手动校验参数并返回稳定状态码/错误码。
- [x] **11.3** DELETE close 幂等，并正确处理 Client 离线/结果不确定。
- [x] **11.4** 装配 TerminalModule、EventsModule、AppModule，避免模块循环。
- [x] **11.5** 新增 SDK terminal domain，正确 encode clientId/sessionId 和分页 query。
- [x] **11.6** Controller/SDK 单元测试、Server/SDK build 通过。
- [ ] **Task 11 完成：Frontend 可通过稳定 REST API 管理会话元数据。**

## Task 12：浏览器 `/app` Gateway 与单写多读实时协议

**TDD：是**

**Files：**

- Modify: `packages/server/src/events/app.gateway.ts`
- Create or Modify: `packages/server/src/events/app.gateway.test.ts`
- Modify: `packages/server/src/events/events.module.ts`

**Impact：** 必须先分析 `AppGateway.handleConnection`、`authenticate`、`handleDisconnect`（若当前无 disconnect 则分析 class 与认证调用链）。HIGH/CRITICAL 先告知用户。

**Red：** 未认证连接仍断开；认证后 terminal attach 能取得 actor；每类消息先 parser 后 service；service error 转安全 ack；Viewer 伪造 input 无 emitter 调用；disconnect 精确按 socketId detach；一个 socket 的多个 session 均清理；广播仅到目标 socket/attachment，不全局泄露；既有 Cookie/Bearer 认证测试保持。

**Green：** 在现有唯一 `/app` Gateway 增加薄 handlers 和 disconnect hook。不要创建第二个同 namespace 的认证 Gateway。

**Refactor：** 如 private `authenticate` 过大，只在测试保护下抽成认证 service；不得改变 Cookie/Token 优先级和安全语义。

**Verify：**

```bash
pnpm --filter @vcpdeck/server test -- src/events/app.gateway.test.ts src/terminal/terminal.service.test.ts
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/server build
```

- [x] **12.TDD-1 Baseline/Impact**：完成 AppGateway 认证/连接/断开流程 impact，确认既有认证测试为绿。
- [x] **12.TDD-2 Red**：先写认证 actor、parser、越权、广播隔离和 disconnect 测试并观察红灯。
- [x] **12.TDD-3 Green**：在唯一 `/app` Gateway 中实现最小 handlers 使测试转绿。
- [x] **12.TDD-4 Refactor**：保持全绿后整理薄 handler/认证复用，不改变认证优先级。
- [x] **12.TDD-5 Verify/Review**：Gateway/Terminal/Server 全量测试、build 和 detect_changes 通过。
- [x] **12.1** 修改前对 `AppGateway` 运行 upstream impact 并评估认证/连接流程风险。
- [x] **12.2** 在现有 AppGateway 中接入 attach/detach/input/resize/takeover/ack/resync handlers。
- [x] **12.3** 每个 handler 使用已认证 ActorContext、运行时 parser 和统一 ack。
- [x] **12.4** disconnect 时按 socketId 清理 attachments，并启动 operator 保护而非关闭 PTY。
- [x] **12.5** 实现 snapshot/output/control/state/error 向指定 attachments 广播。
- [x] **12.6** 跨 identity token、Viewer 伪造写入和 takeover 并发测试通过。
- [ ] **Task 12 完成：浏览器实时链路经过认证且写权限无法绕过。**

## Task 13：Frontend xterm 基础与 Socket hook

**TDD：是；xterm/ResizeObserver 使用 adapter，避免测试绑定 jsdom 不支持的 canvas 细节**

**Files：**

- Create: `packages/frontend/src/terminal/terminal-socket.ts`, `terminal-socket.test.ts`
- Create: `packages/frontend/src/terminal/use-terminal-session.ts`, `use-terminal-session.test.tsx`
- Create: `packages/frontend/src/terminal/terminal-view.tsx`, `terminal-view.test.tsx`
- Modify: `packages/frontend/package.json`, `pnpm-lock.yaml`, 全局/终端样式入口

**Red（socket/hook）：** attach ack 保存 token；刷新从正确 sessionStorage key 取 token；snapshot 到达前 delta 暂存；snapshot write callback 后按 seq 写 delta；重复 seq 忽略；gap 发 resync；control state 切换；断线 UI 状态；unmount detach 且不 DELETE；不同 session listener 不串流。

**Red（view）：** operator `onData` 发送，viewer 不发送；viewer 粘贴不发送；operator paste 保留完整文本；FitAddon resize 50ms 合并且只有 operator 发送；复制读取 selection；Clipboard 失败显示提示；dispose 恰好一次。

**Green：** 先定义 `TerminalAdapter` 包装 xterm 构造/write/reset/dispose/fit，测试用 fake；生产 adapter 再接真实 xterm。socket 建议由 TerminalPanel 共享一条 `/app` 连接，hook 按 session 注册监听，不为每个标签建立 socket。

**Refactor：** reducer 保持 seq/control/connection 单向状态更新；所有 timer/listener cleanup 集中；不把终端正文写 React debug log。

**Verify：**

```bash
pnpm --filter @vcpdeck/frontend test -- src/terminal/terminal-socket.test.ts src/terminal/use-terminal-session.test.tsx src/terminal/terminal-view.test.tsx
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

- [x] **13.TDD-1 Baseline/Impact**：分析 Frontend API/socket/context 接入点，确认 Frontend 基线为绿。
- [x] **13.TDD-2 Red**：先写 socket/hook/view adapter 行为测试并观察有效红灯。
- [x] **13.TDD-3 Green**：实现最小共享 socket、session reducer 和 xterm adapter 使测试转绿。
- [x] **13.TDD-4 Refactor**：在绿灯下集中 listener/timer/dispose，检查终端正文不进入日志/state 持久化。
- [x] **13.TDD-5 Verify/Review**：目标/全量 Frontend 测试、build 和 detect_changes 通过。
- [x] **13.1** 添加并锁定 xterm、fit addon、socket.io-client 依赖，样式正确引入。
- [x] **13.2** 实现共享 `/app` terminal socket 生命周期，复用 Cookie 认证且不暴露 Client PSK。
- [x] **13.3** 实现 attachment reconnect token 的 sessionStorage 隔离和清理。
- [x] **13.4** 实现 snapshot reset/write、delta seq 去重、gap/resync 和 xterm write ack。
- [x] **13.5** 实现 operator `onData`、Viewer 只读、paste 权限和 resize 合并。
- [x] **13.6** 组件卸载正确 dispose xterm/listeners/ResizeObserver/socket subscriptions，仅 detach 不 close。
- [x] **13.7** xterm wrapper 和 socket hook 单元测试通过。
- [ ] **Task 13 完成：单个浏览器终端可以安全 attach、显示和交互。**

## Task 14：Frontend Terminal Panel 与机器工作区入口

**TDD：是，采用用户行为测试而非组件快照**

**Files：**

- Create: `packages/frontend/src/pages/terminal-panel.tsx`, `terminal-panel.test.tsx`
- Create: `packages/frontend/src/terminal/terminal-tabs.tsx`
- Create: `packages/frontend/src/terminal/terminal-control.tsx`
- Create: `packages/frontend/src/terminal/terminal-audit-dialog.tsx`
- Modify: `packages/frontend/src/pages/machine-workspace.tsx`, `machine-workspace.test.tsx`

**Impact：** 分析 `MachineWorkspace`、内部 `Workspace`；若抽取 tabs/overflow helper，对实际 symbol 补跑 impact。

**Red：** 从路由渲染 Terminal Tab；不支持/离线原因；Shell 默认项；create body 来自 fit 尺寸；第 5 个后禁用新建；多个标签独立画面/状态；切换不 DELETE；离开页面只 detach；close 二次确认；operator/viewer/保护倒计时/接管；interrupted/exited/expired/error/historyTruncated；非沙箱警告始终可见；审计分页；键盘和 aria 名称；现有 Execute/Files/Pi Tab 仍渲染。

**Green：** 先接列表/创建/单标签，再多标签/control/audit，每组保持红绿循环。不要在一个巨大组件中完成所有状态；业务状态在 hook，Panel 负责编排。

**Refactor：** 复用现有 Dialog、状态组件和 SDK context；不新建第二套 API client；终端区域 `overflow-hidden`，其他 tabs 原 overflow 行为不变。

**Verify：**

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/terminal-panel.test.tsx src/pages/machine-workspace.test.tsx
pnpm --filter @vcpdeck/frontend test
pnpm --filter @vcpdeck/frontend build
```

- [x] **14.TDD-1 Baseline/Impact**：完成 MachineWorkspace/Workspace 等实际 symbol impact，确认现有页面测试为绿。
- [x] **14.TDD-2 Red**：按路由/创建/标签/control/终态/audit/a11y 分组写用户行为测试并逐次观察红灯。
- [x] **14.TDD-3 Green**：每组以最小 UI 编排使测试转绿，不复制 socket/业务状态。
- [x] **14.TDD-4 Refactor**：保持全绿后拆分聚焦组件、复用现有 UI primitive 和 overflow 规则。
- [x] **14.TDD-5 Verify/Review**：Terminal/MachineWorkspace/Frontend 全量测试、build 和 detect_changes 通过。
- [x] **14.1** 修改前对 `MachineWorkspace`/`Workspace` 运行 upstream impact。
- [x] **14.2** 增加“终端”Tab 与 `/machines/:clientId/terminal` 渲染，使用满高 `overflow-hidden`。
- [x] **14.3** 实现 Shell 菜单、新建终端、默认 Shell 和 5 会话限制提示。
- [x] **14.4** 实现多终端子标签、状态、切换和关闭确认。
- [x] **14.5** 实现 operator/viewer、30 秒保护倒计时、接管和状态广播 UI。
- [x] **14.6** 实现断线、恢复、interrupted/exited/expired/error 和 historyTruncated 展示。
- [x] **14.7** 实现中文字体 fallback、复制、operator 粘贴和 Clipboard 降级提示。
- [x] **14.8** 实现持续可见的“不是沙箱、继承 Client OS 用户权限”警告。
- [x] **14.9** 实现最小审计 Dialog/Drawer 和分页。
- [x] **14.10** Terminal Panel、MachineWorkspace 和现有 Tab 回归测试通过。
- [ ] **Task 14 完成：终端完整产品界面可用。**

## Task 15：端到端恢复、竞态与安全测试

**方式：验收测试驱动；先写跨层失败场景，再修复集成缺口**

**Files：**

- Create: `packages/server/src/terminal/terminal.integration.test.ts`（或仓库既有集成测试目录）
- Create: `packages/frontend/src/terminal/terminal-reconnect.integration.test.tsx`
- Modify: 仅修复测试暴露的各层代码和 fixture

**测试 harness：** 真实 Socket.IO Server/Client 命名空间 + 临时 SQLite + fake PTY + fake timers；Web actor 使用测试身份，Client 使用测试 PSK。每个测试使用唯一 client/session，afterEach 断开 socket、清 timer、关闭 DB 和 fake PTY。

**Red 顺序：** 先分别创建 15.1～15.8 的失败测试；一次只使一个场景变绿。特别验证 create ack 前后 output、operator 刷新时旧 socket 尚未 disconnect、snapshot 与 output 同时发生、Server/Client 双向断线、两个 takeover 同 tick、终态后迟到 output。

**Green：** 只修复集成边界；若发现设计缺口，先更新本文档和变更记录，再改代码。不得通过增加长 sleep 掩盖竞态，使用事件/ack/fake timers 建立确定性。

**安全断言：** 对数据库 JSON、审计 rows 和捕获日志做 secret canary 全文检查；canary 分别放入 input、output、snapshot、cwd/env/token，期望全部不存在。

**Verify：** 集成测试至少连续运行 3 次无 flaky，再运行全量测试；在验收记录中保存命令和结果，不保存 canary 正文。

- [x] **15.TDD-1 Baseline/Impact**：确认 Task 2～14 单包测试均为绿，并分析集成修复可能触及的既有 symbol。
- [x] **15.TDD-2 Red**：先建立真实 Socket/临时 DB/fake PTY harness，并逐个观察 15.1～15.8 场景失败。
- [x] **15.TDD-3 Green**：一次只修复一个跨层失败场景，不使用长 sleep 掩盖竞态。
- [x] **15.TDD-4 Refactor**：全绿后整理 harness/fixture/cleanup，确保测试可隔离重复运行。
- [x] **15.TDD-5 Verify/Review**：集成测试连续 3 次、全量测试和 detect_changes 通过且无 flaky。
- [x] **15.1** Browser -> Server -> Client -> fake PTY 完整创建/输入/输出/resize/close 测试通过。
- [x] **15.2** 两浏览器 operator/viewer、刷新恢复、保护期和 takeover 测试通过。
- [x] **15.3** snapshot 同步期间持续输出、gap、慢消费者和 resync 测试通过。
- [x] **15.4** Server-Client 断线后 PTY 保留和 state reconciliation 测试通过。
- [x] **15.5** Client generation 改变后旧会话 interrupted 测试通过。
- [x] **15.6** fake timers 验证 30 分钟过期和清理幂等。
- [x] **15.7** 验证 DB/日志/审计不包含测试输入、输出、snapshot、token、path/env。
- [x] **15.8** 非法协议、跨 Client、跨 identity 和超限输入攻击测试通过。
- [ ] **Task 15 完成：核心恢复、竞态和安全边界均有自动化覆盖。**

## Task 16：Windows、Linux 真实平台验收

**方式：预先定义脚本化验收，不适用单元 TDD**

**Files：**

- Create: `docs/verification/interactive-terminal-windows.md`
- Create: `docs/verification/interactive-terminal-linux.md`
- Create（可选、必须无破坏性）: `scripts/verify-interactive-terminal.*`

**执行前：** 两份记录先写明 OS/版本、Node/Client/Server/浏览器版本、Shell 版本、期望结果、实际结果、截图/日志位置和回滚方式；未执行项保持 `[ ]`，不得凭自动化测试代勾选。

**可重复验收命令建议：** `echo` 中文、查询 shell PID/cwd、长运行 sleep/ping 后 `Ctrl+C`、`stty size`（Linux）、打印 ANSI 色块、启动并退出 `vim/top` 或 Windows 等价 TUI。禁止使用删除系统文件、修改权限、关机等破坏性命令。

**恢复确认：** 刷新前记录 Shell PID 和 cwd，刷新后再次查询并比较；最后页面离开后分别在 29 分钟和 31 分钟验证恢复/过期。可在专用测试构建中缩短 TTL 做预检，但最终 30 分钟真实配置至少验收一次。

**清理确认：** 关闭/过期后检查 Shell 及普通子进程消失；明确记录主动 daemonize 进程不在保证范围。

- [x] **16.1** Windows PowerShell 7/Windows PowerShell/cmd 创建和默认选择验收通过。
- [ ] **16.2** Windows 中文、历史、补全、`Ctrl+C`、全屏交互、resize、复制粘贴通过。
- [x] **16.3** Windows 刷新后同一 PTY/cwd，手动关闭和自动过期进程树清理通过。
- [ ] **16.4** Linux `$SHELL`/bash/zsh（存在时）探测和创建验收通过。
- [ ] **16.5** Linux 中文、历史、补全、`Ctrl+C`、`vim`、`top`、`stty size`、复制粘贴通过。
- [ ] **16.6** Linux 刷新后同一 PTY/cwd，手动关闭和自动过期进程组清理通过。
- [ ] **16.7** 将平台、版本、结果和已知限制写入 `docs/verification/` 对应验收记录。
- [ ] **Task 16 完成：Windows/Linux 真实环境达到首版验收标准。**

## Task 17：最终回归、文档和完成检查

**方式：发布门禁，不新增功能**

**开始条件：** Task 1～16 的 Task 完成项全部为 `[x]`，不存在通过跳过/`.skip`/`.only` 隐藏的失败测试。

**执行顺序：** 工作树审查 → 全量 lint/test/build → 关键手工 smoke → GitNexus compare → 文档一致性 → 最终勾选。任何失败都回到对应 Task 做 Red-Green 修复，不能在本 Task 临时放宽断言。

**建议命令：**

```bash
pnpm lint
pnpm -r test
pnpm build
git diff --check
git status --short
```

同时搜索 `.only`、新增 `.skip`、`console.log` 终端正文和危险日志字段；核对 lockfile 依赖精确版本与原生模块部署说明。

- [x] **17.1** `pnpm build` 通过。
- [x] **17.2** 严格类型检查通过（项目无 ESLint 配置与 lint script，以各包 `tsc --noEmit` 严格模式作为类型门禁）。
- [x] **17.3** Shared、Client、Server、SDK、Frontend 全量测试通过。
- [x] **17.4** Execute、Files、FRP、Jobs、Pi、认证和机器心跳关键回归通过。
- [x] **17.5** 更新用户文档，说明使用方式、30 秒/30 分钟生命周期、安全边界和排障。
- [x] **17.6** 检查所有新增公共 surface 有简体中文 JSDoc，代码标识符/协议字段保持英文。
- [x] **17.7** 运行 `gitnexus_detect_changes({ scope: "compare", base_ref: "main" })`，确认影响符合预期。
- [x] **17.8** 检查本文档实现内容、文件地图、协议和代码一致；如有变化完成设计变更记录。
- [ ] **17.9** 检查 Task 1～17 的所有子项和 Task 完成项均已勾选。
- [ ] **Task 17 完成：全部设计落地，终端功能正式完成。**

---

## 25. 设计变更记录

| 日期 | 变更 | 原因 | 影响任务 |
| --- | --- | --- | --- |
| 2026-08-12 | 创建初始设计 | 需求澄清完成：真实 PTY、Windows/Linux、多会话、刷新恢复、单写多读、最小审计 | Task 1～17 |
| 2026-08-12 | 将实施清单细化为 TDD 执行计划 | 要求适合自动化的任务遵循 Red-Green-Refactor，并明确文件、失败测试、最小实现和验证命令 | Task 1～17 |
| 2026-08-12 | 锁定依赖版本：node-pty@1.1.0、@xterm/headless@6.0.0、@xterm/addon-serialize@0.14.0 | Spike 验证通过；Windows 用预编译产物，Linux 需 node-gyp；详见 docs/verification/interactive-terminal-pty-spike.md | Task 1、5、6、16 |
| 2026-08-12 | 浏览器侧会话状态事件名定为 `terminal:session-state`（设计稿 12.2 的 `terminal:state` 保留给 Client 状态对账上报） | 避免同一 Events 常量内语义冲突 | Task 2、12 |
| 2026-08-13 | 废弃 `@Ack()` 装饰器，浏览器/Client gateway 全部改用 handler 返回值自动 ack | NestJS 10.4.22 实测 @Ack() 注入的是对象而非函数；返回值路径工作正常（详见 docs/verification/interactive-terminal-windows.md） | Task 12、8、15、16 |
| 2026-08-13 | Client 终端桥响应改为 TERMINAL_RESPONSE 事件（与 Server broker 关联机制一致），不依赖 socket ack 回调 | Server 经 broker 按事件关联响应；ack 回调路径在真实链路不可用 | Task 7、15、16 |
| 2026-08-13 | Windows 端到端冒烟验收通过（创建/输入/中文/恢复/关闭/审计）；pwsh7 与全屏 TUI 等留待人工验收 | 详见 docs/verification/interactive-terminal-windows.md | Task 16 |
| 2026-08-13 | 补齐四项实现缺口：创建会话使用容器 fit 尺寸（§16.4）；前端断线/重连状态与自动重新 attach（§16.5/14.6）；Server 慢消费者 ack 阈值检测（§11.3，TerminalLimits.slowConsumerGapBlocks=512）；接管后新 operator 主动 fit 并下发权威尺寸（§10.4） | 编码核查发现设计已定义但实现缺失的项 | Task 9、13、14 |

后续任何协议、状态、依赖、超时、上限或安全边界变更都必须追加记录，不覆盖旧记录。

---

## 26. 最终设计原则

> **Terminal Session 管真实 PTY 生命周期；Client 是活跃进程与终端画面的权威来源；Server 管身份、单写多读、元数据、状态对账和最小审计；Frontend 是可重新附着的 xterm 界面；终端正文不进入数据库或日志。**

该设计优先保证：真实终端语义、Windows/Linux 一致协议、页面恢复、资源有界、权限不可绕过，以及不因审计意外保存密码和 Token。
