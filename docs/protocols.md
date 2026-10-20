# VCPDeck API 与通信协议

> 状态：Current｜维护责任：Shared/Server 维护者｜最后核验：2026-10-19｜适用版本：`0.21.0` / 当前 `main`｜事实来源：`packages/shared/src/` 与 Server Controllers/Gateways

本文维护协议语义和兼容规则，不复制全部 DTO。字段级事实以 `@vcpdeck/shared` 导出、SDK 和 Controller 实现为准。

## 1. 协议总览

| 通道 | 路径/namespace | 用途 | 认证 |
| --- | --- | --- | --- |
| REST | `/api/*` | 资源管理、控制命令、查询 | Cookie 或 Bearer；公开端点除外 |
| Socket.IO | `/client` | Server ↔ Client 控制通道 | PSK handshake |
| Socket.IO | `/app` | Browser ↔ Server 终端 | Cookie 或 handshake Bearer |
| 签名 URL | `/api/storage/upload/*`、`download/*` 或外部 URL | 文件正文 | 签名、过期时间和范围 |
| 本机 HTTP | Launcher 随机 `127.0.0.1` 端口 | `/prepare`、`/apply` | `x-launcher-token` |

默认 JSON 请求使用 `Content-Type: application/json`。Local Release 上传和 Local 文件正文使用原始字节流；Alibaba Release/文件正文按 Server 签发的分片 URL 直接 PUT 到 Provider。

## 2. REST 约定

### 2.1 认证

- 浏览器：用户名/密码登录后取得 `vcpdeck_session` HttpOnly opaque Cookie；
- SDK/自动化：`Authorization: Bearer vcp_<opaque-token>`；仓库 CLI 的命名环境支持 Bearer，password 环境则登录取得 Cookie；两者都只访问 Server，环境选择本身不是认证或授权；
- AuthSession/Credential 明文只在调用方，SQLite 保存 SHA-256 摘要；
- 全局 AuthGuard 默认拒绝，Controller 标注 `@Public()` 才公开；
- REST 优先 Cookie、再尝试 Bearer；多数无效/过期/撤销/禁用失败当前统一为 `AUTH_REQUIRED`；
- Actor 由认证层注入，业务代码不得信任 body 中的身份字段；完整撤销和既有 Socket 边界见 [`design/identity-and-authentication.md`](./design/identity-and-authentication.md)。

当前公开端点：

- `POST /api/auth/login`
- `GET /api/health`
- `GET /api/status`
- `GET /api/releases/:version/file`
- `GET /api/client-installer/scripts/:platform`
- `GET /api/public/storage-shares/:token`（长期 opaque Token；所有文件统一 302 到当前 Provider 短期 URL）
- `GET /api/client-installer/assets/:name`、`preflight`、`POST /api/client-installer/bootstrap`（仅开关启用且当前 Release 就绪时返回安装信息）
- `GET/PUT /api/client-installer/clients/:clientId/...`（Public 路由，但必须携带当前共享 `x-vcpdeck-psk`）
- 带有效签名的 `PUT /api/storage/upload/:key`
- 带有效签名的 `GET /api/storage/download/:key`

公开不等于无约束：发布包依赖 SHA-256 完整性，Storage 端点依赖签名和过期时间。部署边界仍应限制网络可达性。

### 2.2 API 资源面

| 前缀 | 资源面 |
| --- | --- |
| `/api/auth` | 登录、登出、当前身份、Credential |
| `/api/identities` | admin 身份管理 |
| `/api/clients` | 在线 Client、别名、操作者注解、远程 DSH 地址（`dshWebUrl`，ADR-0059）和终端子资源；`PUT /api/clients/:clientId/dsh-web` 登记/清除（`{url: string \| null}`，非法返回 400 `INVALID_DSH_WEB_URL`）；`POST /api/clients/:clientId/dsh-web/start\|stop` 受管生命周期（代起 dsh web + 自动建/删 FRP 映射），`DELETE /api/clients/:clientId/dsh-web` 解除外部托管登记（ADR-0059 决策 12），`GET` 查状态（含 `mode: managed\|external`）|
| `/api/jobs` | Job 创建、分页查询、详情、取消和日志事件链 |
| `/api/files` | 文件上传/导出会话及进度 |
| `/api/storage` | 签名能力、文件流、Provider 配置和 Storage Share 管理 |
| `/api/aliyundrive` | 阿里云盘配置、OAuth 和授权验证 |
| `/api/frp` | FRPS 实例和映射 |
| `/api/agents` | 逻辑 agent 到 Client 的受控 placement |
| `/api/a2a` | A2A v1.0 JSON-RPC 入口与 Agent Card |
| `/api/tasks` | Task 审计事件链与偏差检查（只读） |
| `/api/remote-dev` | Remote Dev Session 生命周期、端口与 forward token |
| `/api/releases` | 发布上传、列表和构件下载 |
| `/api/health`、`/api/status` | 浅健康与版本/发布状态 |

完整端点优先通过 `packages/sdk/src/` 使用；终端的详细动作见 `packages/sdk/src/terminal.ts`。

### 2.3 分页

列表接口统一返回：

```ts
interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
```

默认 `page=1`、`pageSize=20`，Controller 将 pageSize 限制到 1–100。Client 在线列表和部分身份接口不是分页接口。

### 2.4 错误

目标格式：

```json
{
  "statusCode": 400,
  "code": "STABLE_ERROR_CODE",
  "message": "Safe message"
}
```

当前实现仍存在 NestJS 标准错误和领域错误格式不完全统一的情况。调用方应按以下顺序处理：

1. 使用 HTTP status 判断大类；
2. 有稳定 `code` 时做程序分支；
3. `message` 只用于安全展示，不解析其文本；
4. 未知响应转为通用错误，不展示 stack 或原始对象。

SDK 将失败归一化为 `VcpDeckApiError(status, code?, details?)`。新增接口必须提供稳定 code、合适 status 和不含敏感信息的 message。

### 2.5 幂等与重试

- GET 可安全重试；
- DELETE 只有明确声明幂等时才自动重试；
- Job 创建、终端创建等 POST 不应由客户端盲目重试；Release 直传会话按版本+平台+SHA+大小恢复，相同构件可幂等继续，但网络结果不明时仍应先查询 Release/会话状态；
- Job 取消在终态上应视为已收敛，但当前调用方仍应读取返回状态确认；
- 网络超时不等于服务端未执行，优先按资源 ID 查询结果。

### 2.6 Exec Job 协议

`POST /api/jobs` 创建 `type=exec` 的一次性远程执行。当前 command payload 为：

```json
{"mode":"command","command":"node --version","cwd":"D:/work/project"}
```

当前 script payload 为：

```json
{"mode":"script","executable":"node","args":["-"],"script":"console.log('hello')","cwd":"D:/work/project"}
```

`timeout` 位于 Job 顶层。command 使用目标系统 Shell；script 使用 `spawn(executable,args,{shell:false})` 并从 stdin 接收源码。当前允许调用方提交 executable/args 是已知安全与兼容缺口，不是长期批准协议；ADR-0010 已决定迁移到 Client 声明的 runtime ID，但尚未实现。

过程 `job:stdout/stderr` chunk 当前不持久化，但 Client 会累计完整最终输出，Server 将最终 stdout/stderr 保存到 `Job.result`。Client 对 exec timeout 使用独立计时器与平台进程树清理，并以 `EXEC_TIMEOUT` 收敛；其他信号终止使用 `EXEC_SIGNALLED`，两者保留已捕获输出。Job 详情返回顶层 `timeout`。当前仍没有 script/output 应用层上限或 cwd root 校验；显式 detached/系统服务和既有外部副作用也不由取消回滚。网络超时和 disconnected 都不证明远端未执行，调用方不得自动盲重试。完整当前边界见 [`design/remote-execution.md`](./design/remote-execution.md)。

### 2.7 Release REST 协议

| 端点 | 认证 | 当前语义 |
| --- | --- | --- |
| `POST /api/releases/uploads` | Cookie/Bearer | 提交版本、平台、SHA-256 和大小；Alibaba 返回持久化会话与分片 URL，Local 返回 `mode=server`；响应 `no-store` |
| `POST /api/releases/uploads/:sessionId/parts` | Cookie/Bearer | 刷新指定 Alibaba 分片 URL；只接受不重复的有效分片编号，响应 `no-store` |
| `POST /api/releases/uploads/:sessionId/complete` | Cookie/Bearer | 校验完成上报字节数、通知 Provider 合并并登记 Release；响应 `no-store` |
| `POST /api/releases/upload?version=&platform=&sha256=` | Cookie/Bearer | Local 或旧 Server 引导使用的原始 archive 字节流；Alibaba 后端在读取正文前返回 `RELEASE_DIRECT_UPLOAD_REQUIRED` |
| `GET /api/releases?page=&pageSize=` | Cookie/Bearer | 分页查询 Release 和 Client 更新明细 |
| `GET /api/releases/:version/file?platform=` | Public | Launcher 下载对应平台 archive；完整性以该平台构件 sha256 为准 |
| `GET /api/status` | Public | 返回 `serverVersion` 和当前活动 Release，供 Launcher 探活 |

Alibaba 模式下，预签名 URL 只在 `no-store` 响应和 CLI 内存中存在，不持久化、不记录日志；构件正文直接进入 Provider，不经过 Server。会话记录版本、平台、声明 SHA-256/大小、Provider file/upload id、分片大小、操作者和有效期。创建任务固定总大小，CLI 完成上报必须一致；Server 不读取直传正文，Launcher 下载后独立计算 SHA-256。

完成响应只证明构件已保存并登记，不证明 Server/Client 更新成功。调用方必须继续查询 Release 状态。版本号要求严格 `x.y.z`；相同平台的相同 SHA/大小可幂等跳过，不同构件拒绝覆盖，且活动 Release 期间不要并发上传新版本。详细状态和失败边界见 [`design/release-and-update.md`](./design/release-and-update.md)。

### 2.8 Client 一键安装 REST 协议

| 端点 | 认证 | 语义 |
| --- | --- | --- |
| `GET/PUT /api/client-installer/config` | Cookie/Bearer | 任意有效业务身份读取/切换持久化安装开关；不返回 PSK |
| `GET /scripts/:platform`、`GET /assets/:name` | Public | 返回不含凭据的平台引导与 Node 安装器资产 |
| `GET /preflight?platform=` | Public + 安装开关 | 返回当前版本、资产 SHA、Node/npm 镜像等非秘密引导信息 |
| `POST /bootstrap` | Public + 安装开关 | 仅当前 Server 同版本 `done` Release 有目标平台 archive 时，返回 archive、SHA 与共享 PSK；`Cache-Control: no-store, private` |
| `GET /clients/:id/status`、`PUT /clients/:id/name` | `x-vcpdeck-psk` + 安装开关 | 安装器轮询最小上线摘要并设置显示名称 |

关闭开关返回 `CLIENT_INSTALLER_DISABLED`，不影响已安装 Client。未知字段、平台和空名称严格拒绝；PSK 不得进入 URL query、日志或错误。

### 2.9 Git SSH 共享密钥 REST 协议

| 端点 | 认证 | 语义 |
| --- | --- | --- |
| `GET /api/git-ssh` | Cookie/Bearer | 当前密钥投影 `{ version, publicKey, fingerprint }`；未生成时为 `null`。任何响应都不含私钥或密文 |
| `POST /api/git-ssh/generate` | Cookie/Bearer | 生成新一代密钥并加密保存，并通知 Client 重新登记；根密钥缺失/非法时 `GIT_SSH_KEY_UNAVAILABLE`（400） |
| `GET /api/git-ssh/status` | Cookie/Bearer | 密钥 + 每机分发状态 `{ key, targets[] }`，`targets[].state ∈ pending \| installed \| clear-pending \| cleared \| failed \| ambiguous \| unsupported` |
| `PUT /api/git-ssh/targets` | Cookie/Bearer | 全量替换选机集合，body `{ clientIds: string[] }`；重复项、非法项或超上限 200 与未知字段 → `GIT_SSH_PROTOCOL_INVALID`（400） |

`/client` 命名空间新增两个事件（协议版本 `GIT_SSH_PROTOCOL_VERSION=1`；严格解析，未知字段与不支持版本一律拒绝）：

| 事件 | 方向 | 载荷 |
| --- | --- | --- |
| `git-ssh:command` | Server → Client | `{ protocolVersion, operationId, version, action: "install", privateKey, publicKey }` 或 `{ …, action: "clear" }`；只发往当前注册 socket，绝不像 clientId room 广播 |
| `git-ssh:ack` | Client → Server | `{ protocolVersion, operationId, version, state: "installed" \| "cleared" \| "failed", code? }`；不含私钥与原始异常；Server 仅接受匹配当前 socket 租约与 operationId 的回执 |

Client 只在收到本次 REGISTER ack、且已上报兼容 `capabilityDetails.gitSsh` 时处理指令；`installed`/`cleared` 只表示本地受管副本状态，不代表 Git 服务已授权或已撤销。

### 2.10 Job 日志事件 REST 协议

`GET /api/jobs/:jobId/logs?since=<seq>&limit=<1..200>&level=<info|warn|error>`（Cookie/Bearer）：按 `seq` 升序返回 Job 日志事件链，用于定位派发、进程、取消与对账环节。

| 参数 | 语义 |
| --- | --- |
| `since` | 增量游标，只返回 `seq` 更大的事件；缺省 0 |
| `limit` | 每页条数，服务端夹取 1..200，缺省 200 |
| `level` | 只返回指定级别；非法值 → `INVALID_JOB_LOG_QUERY`（400） |

响应 `{ jobId, events[], nextSeq }`；`events[].seq` 是全局自增序号，`nextSeq` 是下一次请求的游标（无事件时回显入参 `since`）。**返回条数小于 `limit` 即表示已到末尾**。Job 不存在返回 404。事件不复述命令、路径或 stdout/stderr 正文，正文仍在 `Job.result` 与输出 spool。契约与保留策略见 [`design/job-observability.md`](./design/job-observability.md) 与 [ADR-0054](./adr/0054-job-log-event-chain.md)。

### 2.11 A2A Task REST 与 JSON-RPC 协议

A2A 是面向“agent 调 agent”的任务契约，不是 Job 控制面，也不把 ACP 直接暴露给调用方（[ADR-0057](./adr/0057-a2a-hub-and-backend-agnostic-task-model.md)）。

- `POST /api/a2a`：认证同普通 REST（Cookie/Bearer）；body 为 A2A v1.0 JSON-RPC 请求，`params` 先经 Shared strict parser。
- `GET /api/a2a/agent-card`：返回 `supportedInterfaces`（`url`、`protocolBinding: "JSONRPC"`、`protocolVersion: "1.0"`）、能力与技能；`streaming`/`pushNotifications` 当前为 `false`。
- `GET /api/tasks/:id/events?since&limit`：只读审计链，`limit` 夹取 1..200。
- `GET /api/tasks/:id/deviation`：按路径约束和 `requiredArtifacts` 返回 `aligned`/`drifted`/`failed` 与原因。
- `api/agents`：AgentPlacement 的 CRUD；`agentId` 是逻辑名，同一 `agentId` 同时只能有一个启用的 placement，多个启用会使解析以 `AGENT_AMBIGUOUS` 失败关闭。

方法：

| 方法 | 语义 |
| --- | --- |
| `SendMessage` | 新消息创建 Task；带 `message.taskId` 时继续**进行中**的 Task 或回答权限（终态返回 `-32000 TASK_TERMINAL`，新一轮用同 `contextId` 开新 Task） |
| `GetTask` | 读取 Task；返回 `history`（inbound=user、outbound=agent，含 agent 回复正文），`historyLength` 取最近 N 条 |
| `ListTasks` | 按 `contextId`/`status` 分页；`pageToken` 是页码字符串 |
| `CancelTask` | 先取消 Task，再尽力向 Client 发 `cancel`；终态 Task 幂等返回 |

对外 Task 只使用 `status.state = TASK_STATE_*`，绝不暴露内部小写 `state`；内部基线字段位于 `metadata.vcpdeck`。ACP 权限不是标准 A2A 字段，而是声明的扩展：

```json
{
  "metadata": {
    "extensions": {
      "https://vcpdeck.dev/a2a/extensions/acp-permission/v1": {
        "requestId": "perm-1",
        "optionId": "allow-once"
      }
    }
  }
}
```

未知扩展、未知字段和未知状态一律拒绝；错误返回 JSON-RPC `error`，业务错误码（如 `TASK_TERMINAL`、`TASK_CLIENT_OFFLINE`）放在 `error.data.code`。A2A `SendMessage` 的初始响应可能已是 `working`，调用方必须用 `GetTask` 或审计链观察后续 `input-required`/终态。

当前 `input-required` 只由 ACP permission 请求触发；直接向这类 Task 追加普通文本会返回 `-32000`，必须先回答 permission。ACP 的自由文本追问没有独立的 A2A 状态：一轮 prompt 正常结束会收敛为 `completed`；需要继续时由调用方新建 Task，可用同一 `contextId` 分组。这是当前实现边界，不把 `completed` 伪造为可重开的 Task。

### 2.12 Remote Dev Session REST 协议

RDS 是独立人机开发会话域（[ADR-0058](./adr/0058-remote-dev-session.md)），不是 A2A Task 或 Job。

| 方法/路径 | 语义 |
| --- | --- |
| `POST /api/remote-dev/sessions` | 创建；body `{clientId, agentPlacementId, workspaceRoot, label?, resumeFromSessionId?}`；校验 Client 在线、`remote-dev` capability、placement 归属与 workspace roots；带 `resumeFromSessionId` 时按续接规则校验（同 Client/placement/workspace、源会话已终态、有 `acpSessionId`、调用者是 owner） |
| `GET /api/remote-dev/sessions` | 分页；`clientId`/`state` 过滤 |
| `GET /api/remote-dev/sessions/:id` | 详情；不返回 token/正文 |
| `DELETE /api/remote-dev/sessions/:id` | 关闭；关闭子终端与端口，等待 Client ack；不把失败报告为成功 |
| `GET/POST /api/remote-dev/sessions/:id/ports` | 端口列表 / 打开（`1024-65535`，每会话最多 8 个） |
| `DELETE /api/remote-dev/sessions/:id/ports/:portId` | 关闭端口 |
| `POST /api/remote-dev/sessions/:id/ports/:portId/forward-token` | 签发短期 forward token（10 分钟，只在 Server 内存存 hash） |

错误码包括 `RDS_CLIENT_OFFLINE`、`RDS_UNSUPPORTED_CLIENT`、`RDS_PLACEMENT_INVALID`、`RDS_WORKSPACE_INVALID`、`RDS_LIMIT_EXCEEDED`、`RDS_OPERATOR_REQUIRED`（含"续接非自己创建的会话"）、`RDS_RESUME_NOT_ALLOWED`、`RDS_RESUME_UNAVAILABLE`、`RDS_RESUME_MISMATCH`、`RDS_PORT_INVALID`、`RDS_COMMAND_FAILED`。`workspaceRoot` 先由 Server 做词法 roots 边界检查，Client 启动 ACP Host 前再做 realpath/canonical 校验；越界拒绝，不做宽松猜测。

## 3. `/client` Socket.IO 协议

Client 使用 `auth.psk` 建立连接。注册成功后，Server 将 Client room 标识绑定到 `clientId`。

### 3.1 连接生命周期

```text
connect(PSK) → register → ack → status/pi/terminal state report → heartbeat
      └─ disconnect → Server 标记离线 → 自动重连 → 重新注册和对账
```

Client 当前每 5 秒发送心跳。Server 每 5 秒扫描一次在线 Client，超过 30 秒未收到心跳（首次注册后也未收到心跳则以 connectedAt 判断）即按当前 socket lease 原子标记离线，并执行与 Socket 断线相同的 Job、FRP、Pi 和 Terminal 清理；实际 Socket 断开仍会立即触发相同处理。

### 3.2 事件方向

| 事件 | 方向 | 语义 |
| --- | --- | --- |
| `register` | Client → Server | 注册静态信息、版本和 capability；可选 `remoteDevSessions: {sessionId, generationId}[]`（缺省=旧 Client 未报告，空数组=明确无存活 RDS 会话） |
| `heartbeat` | Client → Server | 动态指标和运行 Job |
| `status:report` | Client → Server | 通用 Job 重连对账 |
| `job:dispatch` | Server → Client | 下发判别联合 Job |
| `job:stdout/stderr/progress/done` | Client → Server | Job 过程与终局 |
| `job:cancel` | Server → Client | 请求取消 |
| `job:cancelled/cancel-failed` | Client → Server | 取消结果 |
| `job:log` | Client → Server | Job 生命周期相位（`received/spawned/exited/local_settled/cancel_received/kill_failed/drain_timeout`）；只承载相位，不承载输出正文 |
| `terminal:request` | Server → Client | PTY 创建、attach、输入等请求 |
| `terminal:response/output/exit/state` | Client → Server | PTY 响应、输出和对账 |
| `update:request` | Server → Client | 请求准备目标版本 |
| `update:ready/failed` | Client → Server | 更新停机准备或失败摘要 |
| `server:shutdown` | Server → Client | Server 即将更新重启 |
| `frp:state` | Client → Server | FRP runtime 安全快照（状态、generation、proxy 摘要）；REGISTER 确认后立即首报，之后每次状态变化上报 |
| `frp:state-ack` | Server → Client | 严格确认（accepted + action）；Client 只接受当前 connection generation 的 ack |
| `task:command` | Server → Client | A2A Task 的受控 ACP 命令：`start/prompt/cancel/permission/close` |
| `task:command-result` | Client → Server | 按 `requestId` 回报命令结果；可带 `stopReason` |
| `task:event` | Client → Server | ACP 归一化事件（message/tool/plan/permission/usage/session） |
| `rds:command` | Server → Client | RDS 受控命令：`session.create/close`、`agent.prompt/cancel/permission`；`session.create` 可带可选 `acpSessionId`（续接） |
| `rds:command-result` | Client → Server | 按 `requestId` 回报；create 带 `generationId`，prompt 带 `stopReason` |
| `rds:event` | Client → Server | RDS 归一化 ACP 事件与状态（`agent.event/agent.status/session.ended`） |
| `rds:acp-session` | Client → Server | 创建成功后上报 ACP 侧 `sessionId`（`{sessionId, generationId, acpSessionId}`）；独立事件以便旧 Server 静默忽略 |
| `rds:transcript` | Server → Browser | 附着成功后回放会话 transcript：`{sessionId, entries, truncated}`；`entries[]` 为 `{seq, at, kind:"prompt", text}` 或 `{seq, at, kind:"event", event}` |
| `dshweb:command` | Server → Client | 远程 DSH 受管生命周期：`{requestId, action:"start"\|"stop", clientId, port}`；Server 分配 loopback 端口，Client 只按它启动 |
| `dshweb:result` | Client → Server | 回执：`{requestId, ok, port?, token?, error?}`；token 只在此通道传递，不写日志 |

所有跨信任边界 payload 长期必须先通过 Shared parse 函数或等价严格校验，再进入领域服务。Terminal 当前已采用严格 parser；exec 和文件 Job 的双端校验仍有本文件所列实现偏移。

### 3.3 Job 对账

- 断线时 Server 将活跃 Job 标为 `disconnected`；
- Client 本地进程可以继续运行；
- 重连后 Client 上报 running/waiting_input/done/error；
- Server 按 jobId 对账并恢复状态；
- 中间 stdout/stderr 不保证断线补传，调用方不能把实时输出当作持久审计日志。

### 3.4 Job 日志相位（`job:log`）

Client 在上报终态之外，另发一条只含生命周期事实的相位流：`received`（收到派发）、`spawned`、`exited`、`local_settled`、`cancel_received`、`kill_failed`、`drain_timeout`。

- 载荷：`{ jobId, event, level?, code?, message?, data?, clientAt? }`；`data` 只允许扁平字符串/数字/布尔，≤8 键、序列化 ≤1 KB，`message` ≤200 字符；
- Server 严格解析：未知事件、未知字段、嵌套 data、超长文本一律丢弃，**不影响连接与 Job**；
- 归属校验：事件只接受 `job.clientId` 与该 socket 绑定的 `clientId` 一致的上报，防止跨 Job 注入；
- 限流：每 Job ≤8 条、每 Client ≤30 条/分钟（内存窗口，进程重启重置）；
- 时间权威是 Server 接收时刻；`clientAt` 只进 `data`，用于与目标机本地日志对时；
- **不提升协议版本**：旧 Client 不报相位时事件链仍完整；新 Client 对旧 Server 发送该事件会被静默忽略。

### 3.5 A2A Task 派发通道

Server 只为已解析的 `AgentPlacement` 下发 `task:command`，不把任意 shell 或未注册命令交给 Client。命令和事件都以 `{ taskId, attemptId }` 归属；Server 丢弃旧 socket、错误 attempt 或无法关联的迟到事件。当前只执行 `acp` adapter；`cli` 保留，派发会以 `TASK_ADAPTER_UNSUPPORTED` 失败关闭。

- `start` 携带 placement 的 `command/args/cwd`；Client 启动 ACP Host 后返回 `ok`，Server 再在后台发送 `prompt`。
- `prompt` 的 `requestId` 关联本轮；Client 返回 `{ ok, stopReason? }`，Server 按 `stopReason` 收敛 Task。
- `permission.requested` 进入 `input-required`；`permission` 命令携带 `permissionRequestId` 与 `optionId`，Client 必须回传对应 ACP 决策。
- `cancel` 只表示取消请求；Server 不把取消信号直接当终态，要等本轮结果或离线收敛。
- Client 确认离线（无存活 socket）时，Server 将未完成 Task 置 `failed/TASK_CLIENT_DISCONNECTED`，并审计 `task.failed`。

Client 的 `acp` capability 只表示可以承载 ACP Host；具体 agent 是否可用由 AgentPlacement 的 `enabled` 与执行结果决定。

## 4. `/app` Socket.IO 协议

该 namespace 当前承载浏览器终端与 Remote Dev Session 控制面。连接认证后，Server 将 Actor 绑定到 socket。

浏览器请求事件：

- `terminal:attach`
- `terminal:detach`
- `terminal:input`
- `terminal:resize`
- `terminal:takeover`
- `terminal:ack-output`
- `terminal:resync`

Server 推送事件：

- `terminal:snapshot`
- `terminal:output`
- `terminal:control`
- `terminal:session-state`
- `terminal:resync-required`
- `terminal:error`

请求使用 Socket.IO ack 返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`。只有 operator 可以输入和 resize；viewer 只能观察。Browser 在 sessionStorage 保存 reconnect token，Server 只保存内存 hash；operator 断线后有 30 秒保护，之后 viewer 可 takeover。

输出目标模型是 snapshot + 有序 delta：Client headless xterm 提供 snapshot，网络 chunk 携带 seq，Browser ack 用于慢消费者检测，落后 512 个块后要求 resync。当前协议实现存在以下偏移：

- snapshotSeq 按原始 PTY write 计数，网络 output seq 按聚合/拆分后的 chunk 计数，两者不总是同一序列；
- Server 收到 Client 上游 seq gap 时直接丢弃，不主动向 Browser 发 resync-required；
- snapshot 超限 raw 回退使用 JS 字符截断，不保证 UTF-8 8 MiB；
- 单次 input 限制 64 KiB，但没有持续字节速率限制，`TERMINAL_RATE_LIMITED` 尚未使用。

Client REGISTER 后上报 generationId 和内存 Session。Server 当前按“DB/报告集合是否存在”对账，没有保存或比较 generationId；DB 非终态但本次未上报的会话会被标为 interrupted。Client 本地 30 分钟 expired 当前不主动上报 Server，attach/detach 也未完整同步 SQLite active/detached 时间字段。完整事实见 [`design/remote-terminal.md`](./design/remote-terminal.md)。

### 4.1 RDS attachment 与浏览器事件

RDS 浏览器请求（均通过 ack）：

- `rds:attach` `{sessionId, reconnectToken?}`：首个 operator，后续 viewer；返回 `{attachmentId, mode, reconnectToken}`；
- `rds:detach`、`rds:prompt`、`rds:cancel`、`rds:permission`、`rds:port.open`、`rds:port.close`、`rds:resync`；
- 只有 operator 可 prompt/cancel/permission/端口操作；viewer 只读。

Server 推送：

- `rds:state` `{session, ports, attachment?}`；
- `rds:agent:event`（ACP 归一化事件，带 `seq`）；
- `rds:transcript` `{sessionId, entries, truncated}`：`rds:attach` 成功后在 `rds:state` 之后单独下发，回放该会话最近的对话（最多 400 条）；旧前端忽略未订阅事件，不影响附着；
- `rds:port:state`；
- `rds:closed`；
- `rds:error` `{code, message}`。

transcript 由 Server 侧落库（RemoteDevEvent）：gent.event 到达时合并写入，prompt 在命令发出前写入、失败回滚。	runcated=true 表示更早记录已按上限丢弃。

### 4.2 RDS 数据面 namespace

- `/remote-dev/tunnel`：Client 出站；PSK + `{clientId, sessionId}` 认证，一个 RDS 一条隧道。
- `/remote-dev/forward`：CLI 入站；`{token, sessionId, portId}` 认证，token 由 forward-token REST 签发。
- 事件：`rds:stream:hello`、`rds:stream:frame`、`rds:stream:close`；二进制帧布局为 `version(1)|type(1)|streamId(4 BE)|length(4 BE)|payload`，payload 上限 64 KiB。
- `OPEN` 的 payload 只含 `{remotePort}`；Client 只连接目标机 `127.0.0.1`，不接受远端 host。`DATA/CLOSE/ERROR` 按 streamId 多路复用；Server 校验 stream 属于当前 forward 连接，并要求 `OPEN.remotePort` 与该 token 对应的已打开端口一致。
- 当前 forward token 只在 Server 内存保存 hash，重启即失效；关闭端口会撤销 token 并断开对应 forward，关闭 RDS 会关闭端口与隧道、通知 CLI 关闭残留 stream。

## 5. 远程 Agent（已退役）

Pi 专用 REST、SSE 事件流、协议版本与能力摘要已按
[ADR-0049](./adr/0049-retire-pi-dsh-integrations-and-focus-on-core-capabilities.md) 退役；
P2P 隧道协议、`tunnel:*` 事件与 `capabilityDetails.p2pTunnel` 已按
[ADR-0053](./adr/0053-retire-p2p-tunnel-and-browser-remote-desktop.md) 退役。
当前协议面只有基础能力（Job、文件、FRP、Terminal、Git SSH、Release）。

## 6. 远程文件与 Storage 协议

远程文件操作复用 Typed Job；import/export 进一步遵循“控制面先建资源，数据面再传正文，完成端点最后收敛”的顺序。Server 负责 Identity、File、Job、传输会话和完成状态；目标路径操作由 Client 执行，正文数据路径由 Provider 决定。远程文件当前边界见 [`design/remote-files.md`](./design/remote-files.md)，Provider 内部设计见 [`design/storage.md`](./design/storage.md)。

### 6.1 文件 Job

| capability | Job 类型 | 主要 payload/result |
| --- | --- | --- |
| `file.read` | `file.roots/list/stat/readText/export` | roots、rootDir/path、目录/文本结果或 File 引用 |
| `file.write` | `file.writeText/mkdir/delete/move/import` | rootDir、路径、文本、覆盖/递归参数或 FileRef |

轻量 `files` SDK 通过 Job create + wait 提供同步式调用体验；Browser AbortSignal 只中止本地 HTTP/等待，不代表远端 Job 已取消。`readText` 默认请求 262144 字节上限，返回 content 进入 `Job.result`；`writeText` 的 content 进入 `Job.payload`。两者都通过 Socket.IO 并持久化到 SQLite，不适用“大文件正文不进入控制面”的结论。

当前协议缺口：

- 非 exec 的通用 `JobDispatch` 仍是宽泛 `type:string + payload`，文件 Job 没有 Server/Client 双端严格 parser；
- `rootDir` 由调用方提交，未强制来自 Client `file.roots`；当前 symlink 和不存在目标父链校验不完整；
- running 文件 Job 的 `timeout`/`job:cancel` 不会可靠中止 fs、HTTP 或分片操作；
- 文件操作未完整进入 Client 重连状态报告，断线期间 progress/done 不保证补报；
- Shared `FileTransferResult.sha256` 是必填，但当前 import 实际结果不总是提供；import 当前只校验字节数，不校验 SHA-256；
- Gateway 的通用 progress/done/cancelled handler 当前未在 handler 内再次核对当前 Socket 与 Job 的 Client 归属；
- 非 exec error 分支调用 `markDone()` 后没有发送其返回的下一条 dispatch，scheduler 可能已把后续 Job 标为 running，而 Client 实际未收到。

文件错误的目标稳定集合为 `PATH_NOT_FOUND`、`PATH_NOT_ALLOWED`、`PATH_CONFLICT`、`IO_ERROR`、`SIZE_EXCEEDED` 和 `SHA256_MISMATCH`；当前 `SHA256_MISMATCH` 未在 import 使用，部分 Node 错误 code 仍可能原样进入结果。调用方不得解析 message 或假设所有错误已经统一。

### 6.2 端点分组

认证控制端点：

| 前缀/端点 | 用途 |
| --- | --- |
| `/api/files/upload-sessions*` | Browser 上传后导入远程机器：创建、进度、分片续期和完成 |
| `/api/files/export-sessions*` | SDK 导出直传：创建和完成（用户 Cookie/Bearer） |
| `/api/files/client-export-sessions*` | Client 导出直传：创建、分片续期和完成；Public 路由但必须携带 `x-vcpdeck-psk` |
| `/api/storage/upload-token`、`download-token` | 签发 Local 或 Provider 下载能力 |
| `/api/storage/download-redirect/:key` | 认证稳定下载入口；每次请求实时取得临时下载 URL并 302 |
| `/api/storage/raw/:key` | 认证受控删除入口；已登记 File 必须经过 FileService 保留锁 |
| `/api/storage/shares`、`/api/storage/shares/:id` | 认证创建、查询、列表和撤销长期分享；管理响应不返回 Token 或 sharePath |
| `/api/storage/config` | 查询安全后端摘要或切换当前后端 |
| `/api/aliyundrive/*` | 阿里云配置、OAuth、状态、验证和撤销 |

数据端点和外部能力：

- Local：带有效 HMAC 的 `PUT /api/storage/upload/:key` 和 `GET /api/storage/download/:key`；
- Alibaba：Browser/Client 直接使用短期分片 PUT URL 和临时下载 URL；
- 短期 URL 持有者具备其约束范围内的能力，因此数据端点不再要求 Cookie/Bearer。
- Storage Share 公开端点只接受 43 字符 Base64URL Token；未知 Token 返回 404，撤销/失效返回 410，Provider 暂时不可用返回 503；Token 哈希查询和错误投影不泄露 File ID、Storage key 或 Provider URL。
- Storage Share 对图片和普通文件统一返回不可缓存 302；Alibaba 等外部 Provider 由调用方直连，Local 重定向到 Server 的签名下载端点。MIME、附件下载、缓存和内联行为由 Provider 响应决定。

字段级事实以 Shared 的 `FileRef`/`UploadTarget`、SDK 的 `files`/`storage`/`aliyundrive` 和当前 Controller 为准，本文不复制全部 DTO。

### 6.3 Local 代理传输

1. Server 创建 pending File 并签发绑定 `action + key + expires` 的 URL；
2. Browser 或 Client 将原始字节 PUT 到 Server；
3. Server 验签、流式写入 Provider、计算实际大小和 SHA-256；
4. File 进入 completed，关联 Job 再继续派发或收敛；
5. 下载时使用短期 GET URL，或由 Browser 访问认证稳定入口实时重定向。

Local `signSecret` 在缺失时由 Server 生成并持久化到 `StorageBackendConfig.config`。正常重启不会自动轮换该密钥；URL 仍会因到期、配置/密钥被替换或对象不可用而失效。

### 6.4 Alibaba 分片直传

Browser 上传后导入远程机器：

1. `POST /api/files/upload-sessions` 创建 `waiting_input` Job、pending File 和分片会话；
2. Browser 并发 PUT 分片，并可上报进度；
3. 分片 URL 以 403 失效时，通过 `part-urls` 续期指定分片；
4. Browser 调用 complete 并提交 `uploadedBytes`；
5. Server 校验声明大小、调用 Provider 合并分片、将 File 置 completed；
6. Job 进入 pending/running，Client 使用外部临时 GET URL导入目标路径。

Client 导出：Client stat 文件后通过 `/api/files/client-export-sessions*` 创建 export session（携带 `x-vcpdeck-psk`），直接上传分片；分片 URL 返回 403 时通过 `part-urls` 续期指定分片，完成后 Server 将 File 置 completed，再由 Client 上报 Job 结果。PSK 只发送到 Server 控制端点，不发送到 Provider。

Alibaba 直传以字节数和 Provider 完成响应收敛，Server 不读取全部正文；Client 在上传完成后顺序读源文件计算 SHA-256 并随结果上报，Server 回填 `File.sha256`，因此是 Client 端哈希，不提供 Local 路径同等级的 Server 端 SHA-256 保证。

### 6.5 重试、幂等与恢复

- 创建上传/导出会话和完成请求不能因网络超时盲目重复；应先查询 Job/File 状态；
- complete 对已经进入 pending/running/终态的导入 Job按当前状态收敛，不应重复派发；
- URL 不得长期缓存，到期后重新申请；
- Alibaba 的 `fileId/uploadId` 会话映射和 OAuth PKCE 会话当前在 Server 内存，Server 重启后未完成操作需重新创建；
- Provider 切换不迁移旧对象，历史 File 仍依赖原 `storageKind`；
- Storage 下载和传输失败不等于可以直接删除 File 或对象，应结合 Job/File/Provider 状态核对；
- write/move/delete/import 的结果不明时不得自动盲重试，应先核对目标路径、临时文件、Job 和 File；
- import 异常会尽力清理临时文件，但取消、崩溃和强制停止不保证无残留；overwrite 已删除旧目标后 rename 失败可能丢失原目标。

### 6.6 安全约束

- 上传签名与下载签名不能混用；
- URL、签名、OAuth code/token 和外部 Provider 响应不得进入日志、Job 文本或 Agent 回复；
- Browser/Client 不持有 Provider 长期主凭据；
- Client 只有在 Shared 明确标记 `direct=true` 时才允许访问 Server origin 之外的临时 URL；
- Storage 完成不替代远程路径安全；Client 当前只实现不完整的 lexical root/realpath 检查和 overwrite 处理，在 rootDir 认证、symlink 与不存在目标父链修复前不能视为完整授权；
- 配置与状态 API 只返回安全摘要，不返回原始配置 JSON 和 Token。

## 7. Release 更新与 Launcher 控制协议

### 7.1 Server ↔ Client

- `update:request` 携带 `releaseVersion`、archive URL、SHA-256 和可选 drain 超时；
- Client prepare 成功并完成有界等待后发送 `update:ready`；
- prepare/apply 失败时发送带安全原因摘要的 `update:failed`；
- Client 重新注册且 `clientVersion` 等于目标版本，才是更新成功的最终信号；
- `server:shutdown` 只是 Server 即将重启的通知，不是持久消息或成功确认。

### 7.2 业务进程 ↔ Launcher

Launcher 在 `127.0.0.1` 随机端口监听，将 `{port,token,pid}` 写入 `control.json`。业务进程使用：

1. `POST /prepare`：下载、SHA-256 校验、解压目标版本；
2. `POST /apply`：对已 prepare 的内存目标执行 preStart、停止、切换、启动、探活，失败则回退。

请求必须携带 `x-launcher-token`。控制文件和 Token 仅允许本机运行账户读取。Launcher 重启会丢失 pending 目标，调用方必须重新 prepare；apply 的 HTTP 连接因业务进程被停止而中断可以是正常结果。完整设计见 [`design/release-and-update.md`](./design/release-and-update.md)。

## 7. FRP REST 与 Typed Job

### 7.1 FrpsInstance

```text
POST   /api/frp/instances
GET    /api/frp/instances?page=&pageSize=
GET    /api/frp/instances/:id
PUT    /api/frp/instances/:id
DELETE /api/frp/instances/:id
POST   /api/frp/instances/:id/probe
POST   /api/frp/instances/:id/set-default
```

实例响应 `FrpsInstanceInfo` 当前包含明文 `authToken` 和 `dashboardPassword`；调用方、日志和 UI 必须按秘密处理。这是当前安全缺口，不是推荐 API 设计。默认实例由应用代码维护，没有 DB 唯一约束或事务保证。

Probe 返回 TCP、Dashboard、auth、version 和 proxy 摘要。无 Dashboard 时 `ok` 只表示 TCP 可达；有 Dashboard 时 `ok` 当前由 authValid 决定，不是完整映射健康检查。

### 7.2 FrpMapping

```text
POST   /api/frp/mappings
GET    /api/frp/mappings?clientId=&page=&pageSize=
GET    /api/frp/mappings/:id
DELETE /api/frp/mappings/:id
```

创建请求可选 `name`、`frpsInstanceId` 和 `timeoutSeconds`（默认 30，范围 1–300）。省略 name 时 Server 按 `<proxyType>-<localPort>` 生成同实例唯一名称；TCP 可选 remotePort，HTTP/HTTPS 必须提供 customDomain 且不分配 remotePort。Server 要求目标实例配置可认证 Dashboard，持久化 `provisioning` mapping 与 running `frp.create` Job 后立即派发。响应包含 `operationJobId`；调用方等待该 Job。Client 完成本地 frpc 动作且 Dashboard 确认同类型/name 的 proxy 出现后才进入 `active`。`active` 不证明 local service、DNS、TLS 或公网可达。

创建确认失败自动派发 `frp.delete` 回滚；回滚成功后删除 mapping，回滚失败保留 `error`。删除先把 mapping 置为 `deleting` 并返回含新 `operationJobId` 的映射，只有 Client 清理且 Dashboard 确认 proxy 消失后才删除记录；失败保留 `errorCode/errorMessage` 并允许再次 DELETE 重试。Client 断线仍只把 active 标为 inactive，独立 frpc 可能继续工作。

恢复对账（capability `frp.reconcileProtocolVersion=1` 的 Client）：Client 重连后按 SQLite 期望集合做三方比较（SQLite × Client 快照 × Dashboard），可恢复状态（active/inactive/reconciling）的映射进入 `reconcile` 周期：Server 创建内部 `frp.reconcile` system Job 并精确派发到当前 socket，Client 重建 TOML 并重启 frpc；Job 结果只含 connectionGeneration/runtimeGeneration/status/loadedMappingIds 安全投影，Server 再按 Dashboard 有界复检，确认通过回 active。重试为 5s/30s 有限槽位，耗尽回 `inactive + FRP_RECONCILE_FAILED`。Client 侧 frpc 崩溃自愈（retrying/failed 上报）由 Client 独占，不派发 Server 重试。恢复周期进行中 create/delete 返回 409 `FRP_RECONCILE_BUSY`（调用方可有限重试）；provisioning/deleting/error 不参与自动恢复。frpc 崩溃自愈与 Job 结果均不向 Server 上报 TOML、stdout/stderr 或凭据。

### 7.3 Job payload 与多实例偏移

- `frp.create` payload 含完整 frps serverAddr/serverPort/authToken，并进入 Job/SQLite；
- `frp.delete` 含 mappingId/name；
- `frp.reconcile` payload 含本轮期望集合（完整 proxy 配置）与 frps 实例信息（含 authToken，仅进入 Job/SQLite）；Job 结果与安全 ack 只含 generation/status/mappingId 投影，不含 Token/TOML/stderr；
- `frp.list` 返回 Client 进程内 registry；
- `frp:state` 报告由 Shared 严格 parser 校验（未知字段、未知状态、代次不匹配均拒绝）；capability 协商失败或旧 Server 不触发恢复；
- FRP 创建 REST 输入由 Shared 严格 parser 拒绝未知字段和类型冲突，写操作错误使用稳定安全 code；内部 Job 仍未保存完整 Actor；
- Client 只有单个 frpc/lastFrpsInfo；Server 当前拒绝同一 Client 跨 FrpsInstance 创建映射。

完整数据权威、安全和恢复边界见 [`design/frp.md`](./design/frp.md)。

## 8. 协议变更流程

1. 判断是否为兼容扩展、行为变化或破坏性变化；
2. 重大变化写 ADR；
3. 先更新 Shared 类型、事件名、解析器和协议版本；
4. Server 在接受新消息前保持对旧 Client 的明确兼容或明确拒绝；
5. 同步 Client、SDK、Frontend、测试和 `compatibility.md`；
6. 在 CHANGELOG 记录迁移要求；
7. 禁止仅在某一端添加未经 Shared 定义的隐式字段。
