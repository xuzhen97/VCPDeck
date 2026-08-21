# VCPDeck API 与通信协议

> 状态：Current｜维护责任：Shared/Server 维护者｜最后核验：2026-08-15｜事实来源：`packages/shared/src/` 与 Server Controllers/Gateways

本文维护协议语义和兼容规则，不复制全部 DTO。字段级事实以 `@vcpdeck/shared` 导出、SDK 和 Controller 实现为准。

## 1. 协议总览

| 通道 | 路径/namespace | 用途 | 认证 |
| --- | --- | --- | --- |
| REST | `/api/*` | 资源管理、控制命令、查询 | Cookie 或 Bearer；公开端点除外 |
| Socket.IO | `/client` | Server ↔ Client 控制通道 | PSK handshake |
| Socket.IO | `/app` | Browser ↔ Server 终端 | Cookie 或 handshake Bearer |
| SSE | `/api/clients/:clientId/pi/agent/:sessionId/events` | Pi 事件流 | Cookie/Bearer HTTP 认证 |
| 签名 URL | `/api/storage/upload/*`、`download/*` 或外部 URL | 文件正文 | 签名、过期时间和范围 |
| 本机 HTTP | Launcher 随机 `127.0.0.1` 端口 | `/prepare`、`/apply` | `x-launcher-token` |

默认 JSON 请求使用 `Content-Type: application/json`；Release 上传和文件正文使用原始字节流。

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
- `GET /api/client-installer/scripts/:platform`、`assets/:name`、`preflight`、`POST /api/client-installer/bootstrap`（仅开关启用且当前 Release 就绪时返回安装信息）
- `GET/PUT /api/client-installer/clients/:clientId/...`（Public 路由，但必须携带当前共享 `x-vcpdeck-psk`）
- 带有效签名的 `PUT /api/storage/upload/:key`
- 带有效签名的 `GET /api/storage/download/:key`

公开不等于无约束：发布包依赖 SHA-256 完整性，Storage 端点依赖签名和过期时间。部署边界仍应限制网络可达性。

### 2.2 API 资源面

| 前缀 | 资源面 |
| --- | --- |
| `/api/auth` | 登录、登出、当前身份、Credential |
| `/api/identities` | admin 身份管理 |
| `/api/clients` | 在线 Client、别名、终端和 Pi 子资源 |
| `/api/jobs` | Job 创建、分页查询、详情和取消 |
| `/api/files` | 文件上传/导出会话及进度 |
| `/api/storage` | 签名能力、文件流和 Provider 配置 |
| `/api/aliyundrive` | 阿里云盘配置、OAuth 和授权验证 |
| `/api/frp` | FRPS 实例和映射 |
| `/api/releases` | 发布上传、列表和构件下载 |
| `/api/health`、`/api/status` | 浅健康与版本/发布状态 |

完整端点优先通过 `packages/sdk/src/` 使用；Pi 与终端的详细动作分别见 `packages/sdk/src/pi.ts`、`terminal.ts`。

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
- Job 创建、终端创建、Release 上传等 POST 不应由客户端盲目重试，否则可能产生重复资源；
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

过程 `job:stdout/stderr` chunk 当前不持久化，但 Client 会累计完整最终输出，Server 将最终 stdout/stderr 保存到 `Job.result`。当前没有 script/output 应用层上限、稳定 `EXEC_TIMEOUT`、cwd root 校验或完整进程树取消。网络超时和 disconnected 都不证明远端未执行，调用方不得自动盲重试。完整当前边界见 [`design/remote-execution.md`](./design/remote-execution.md)。

### 2.7 Release REST 协议

| 端点 | 认证 | 当前语义 |
| --- | --- | --- |
| `POST /api/releases/upload?version=&platform=&sha256=` | Cookie/Bearer | 原始 archive 字节流；校验版本格式、平台（win-x64/linux-x64）和声明 SHA-256；两个平台构件齐备后异步触发更新 |
| `GET /api/releases?page=&pageSize=` | Cookie/Bearer | 分页查询 Release 和 Client 更新明细 |
| `GET /api/releases/:version/file?platform=` | Public | Launcher 下载对应平台 archive；完整性以该平台构件 sha256 为准 |
| `GET /api/status` | Public | 返回 `serverVersion` 和当前活动 Release，供 Launcher 探活 |

上传响应只证明构件已保存并登记，不证明 Server/Client 更新成功。调用方必须继续查询 Release 状态。版本号当前要求严格 `x.y.z`；相同版本不得复用，且活动 Release 期间不要并发上传新版本。详细状态和失败边界见 [`design/release-and-update.md`](./design/release-and-update.md)。

### 2.8 Client 一键安装 REST 协议

| 端点 | 认证 | 语义 |
| --- | --- | --- |
| `GET/PUT /api/client-installer/config` | Cookie/Bearer | 任意有效业务身份读取/切换持久化安装开关；不返回 PSK |
| `GET /scripts/:platform`、`GET /assets/:name` | Public | 返回不含凭据的平台引导与 Node 安装器资产 |
| `GET /preflight?platform=` | Public + 安装开关 | 返回当前版本、资产 SHA、Node/npm 镜像等非秘密引导信息 |
| `POST /bootstrap` | Public + 安装开关 | 仅当前 Server 同版本 `done` Release 有目标平台 archive 时，返回 archive、SHA 与共享 PSK；`Cache-Control: no-store, private` |
| `GET /clients/:id/status`、`PUT /clients/:id/name` | `x-vcpdeck-psk` + 安装开关 | 安装器轮询最小上线摘要并设置显示名称 |

关闭开关返回 `CLIENT_INSTALLER_DISABLED`，不影响已安装 Client。未知字段、平台和空名称严格拒绝；PSK 不得进入 URL query、日志或错误。

## 3. `/client` Socket.IO 协议

Client 使用 `auth.psk` 建立连接。注册成功后，Server 将 Client room 标识绑定到 `clientId`。

### 3.1 连接生命周期

```text
connect(PSK) → register → ack → status/pi/terminal state report → heartbeat
      └─ disconnect → Server 标记离线 → 自动重连 → 重新注册和对账
```

Client 当前每 5 秒发送心跳。Server 以实际 Socket 断开作为离线信号，没有独立心跳超时扫描器。

### 3.2 事件方向

| 事件 | 方向 | 语义 |
| --- | --- | --- |
| `register` | Client → Server | 注册静态信息、版本和 capability |
| `heartbeat` | Client → Server | 动态指标和运行 Job |
| `status:report` | Client → Server | 通用 Job 重连对账 |
| `job:dispatch` | Server → Client | 下发判别联合 Job |
| `job:stdout/stderr/progress/done` | Client → Server | Job 过程与终局 |
| `job:cancel` | Server → Client | 请求取消 |
| `job:cancelled/cancel-failed` | Client → Server | 取消结果 |
| `pi:request` | Server → Client | Pi 动作请求 |
| `pi:response/event/state` | Client → Server | Pi 响应、事件和权威状态 |
| `terminal:request` | Server → Client | PTY 创建、attach、输入等请求 |
| `terminal:response/output/exit/state` | Client → Server | PTY 响应、输出和对账 |
| `update:request` | Server → Client | 请求准备目标版本 |
| `update:ready/failed` | Client → Server | 更新停机准备或失败摘要 |
| `server:shutdown` | Server → Client | Server 即将更新重启 |

所有跨信任边界 payload 长期必须先通过 Shared parse 函数或等价严格校验，再进入领域服务。Pi/Terminal 当前已采用严格 parser；exec 和文件 Job 的双端校验仍有本文件所列实现偏移。

### 3.3 Job 对账

- 断线时 Server 将活跃 Job 标为 `disconnected`；
- Client 本地进程可以继续运行；
- 重连后 Client 上报 running/waiting_input/done/error；
- Server 按 jobId 对账并恢复状态；
- 中间 stdout/stderr 不保证断线补传，调用方不能把实时输出当作持久审计日志。

## 4. `/app` Socket.IO 协议

该 namespace 当前只承载浏览器终端。连接认证后，Server 将 Actor 绑定到 socket。

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

## 5. Pi REST + SSE

Pi 的控制命令走 REST，持续事件走 SSE：

```text
REST command → Server ownership/CAS → pi:request → Client Worker
Client event → pi:event → Server projection → SSE subscribers
```

SSE：

- session 级订阅；
- 30 秒心跳；
- EventSource 可自动重连；
- 事件用于实时投影，不是持久消息队列；
- 断线恢复应重新读取 Session detail/context 和权威 Agent state，不能仅依赖补收事件。

Pi 使用精确协议版本 `PI_SESSION_JOB_PROTOCOL_VERSION = 1`。不匹配时 Server 返回 `PI_CLIENT_UNSUPPORTED`，不得尝试猜测兼容。

当前协议不变量：

- 一个 Session 对应一条 `agent.session` Job，且 `jobId === sessionId`；每次 Prompt 使用独立 `runId`；
- `/client` 使用严格解析的 `PI_REQUEST/PI_RESPONSE/PI_EVENT/PI_STATE`，未知 action/event/额外字段明确拒绝；
- cwd 以 Files roots 的 `{rootDir,relativePath}` 表达，由 Client realpath/canonicalize 并拒绝 symlink 越界；
- 同一 Client 的同一 projectKey 只允许一个活动 Run，Client 重启后 projectKey 重新生成；
- 新 Socket generation 必须先完成 PI_STATE 对账；此前控制请求返回 `PI_STATE_PENDING`；
- Session Job 只保存 Owner、状态、当前 runId 和安全错误，不保存 prompt、正文、thinking、真实 cwd 或 Extension 输入；
- 只有 `select/confirm/input/editor` Extension 请求进入 `waiting_input`；
- 图片最多 10 张、单张 10 MiB、总量 100 MiB，临时上传引用 TTL 15 分钟；
- SSE 和 Broker 都不是持久队列，断线期间增量可能丢失，必须从远程 Session/context 和权威 state 恢复。

完整当前行为见 [`design/remote-pi.md`](./design/remote-pi.md)。

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
- Shared `FileTransferResult.sha256` 是必填，但 Alibaba export 和当前 import 实际结果不总是提供；import 当前只校验字节数，不校验 SHA-256；
- Gateway 的通用 progress/done/cancelled handler 当前未在 handler 内再次核对当前 Socket 与 Job 的 Client 归属；
- 非 exec error 分支调用 `markDone()` 后没有发送其返回的下一条 dispatch，scheduler 可能已把后续 Job 标为 running，而 Client 实际未收到。

文件错误的目标稳定集合为 `PATH_NOT_FOUND`、`PATH_NOT_ALLOWED`、`PATH_CONFLICT`、`IO_ERROR`、`SIZE_EXCEEDED` 和 `SHA256_MISMATCH`；当前 `SHA256_MISMATCH` 未在 import 使用，部分 Node 错误 code 仍可能原样进入结果。调用方不得解析 message 或假设所有错误已经统一。

### 6.2 端点分组

认证控制端点：

| 前缀/端点 | 用途 |
| --- | --- |
| `/api/files/upload-sessions*` | Browser 上传后导入远程机器：创建、进度、分片续期和完成 |
| `/api/files/export-sessions*` | Client 导出直传：创建和完成；分片续期存在下述已知路由缺口 |
| `/api/storage/upload-token`、`download-token` | 签发 Local 或 Provider 下载能力 |
| `/api/storage/download-redirect/:key` | 认证稳定下载入口；每次请求实时取得临时下载 URL并 302 |
| `/api/storage/config` | 查询安全后端摘要或切换当前后端 |
| `/api/aliyundrive/*` | 阿里云配置、OAuth、状态、验证和撤销 |

数据端点和外部能力：

- Local：带有效 HMAC 的 `PUT /api/storage/upload/:key` 和 `GET /api/storage/download/:key`；
- Alibaba：Browser/Client 直接使用短期分片 PUT URL 和临时下载 URL；
- 短期 URL 持有者具备其约束范围内的能力，因此数据端点不再要求 Cookie/Bearer。

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

Client 导出：Client stat 文件后创建 export session，直接上传分片，完成后 Server 将 File 置 completed，再由 Client 上报 Job 结果。当前 Client 用于导出 URL 续期的 `/api/files/export-sessions/:jobId/part-urls` 与 Server 已实现的 upload-sessions 路由不一致，因此导出续期尚不可依赖；URL 过期后应重新执行导出。

Alibaba 直传当前以字节数和 Provider 完成响应收敛，Server 不读取全部正文，因此 `File.sha256` 为空，不提供 Local 路径同等级的 Server 端 SHA-256 保证。

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

创建请求可选 `frpsInstanceId`；省略时使用默认实例。Server 检查 Client 在线且声明 `frp`，持久化 inactive mapping 和 pending `frp.create` Job，再立即派发。`active` 当前只表示 Client spawn 未同步失败，不证明 FRPS 注册、local service 或公网可达。

删除当前先删除 FrpMapping，再派发 `frp.delete`；响应 `{deleted:true}` 不证明远端 proxy 已清理。Client 断线会让 Server status 变 inactive，但独立 frpc 可能继续工作。

### 7.3 Job payload 与多实例偏移

- `frp.create` payload 含完整 frps serverAddr/serverPort/authToken，并进入 Job/SQLite；
- `frp.delete` 含 mappingId/name；
- `frp.list` 返回 Client 进程内 registry；
- FRP Job 当前缺严格 Shared parser、稳定错误码和完整 Actor；
- Server 可选择多个 FrpsInstance，但 Client 只有单个 frpc/lastFrpsInfo；同一 Client 不能可靠同时使用多个实例。

完整数据权威、安全和恢复边界见 [`design/frp.md`](./design/frp.md)。

## 8. 协议变更流程

1. 判断是否为兼容扩展、行为变化或破坏性变化；
2. 重大变化写 ADR；
3. 先更新 Shared 类型、事件名、解析器和协议版本；
4. Server 在接受新消息前保持对旧 Client 的明确兼容或明确拒绝；
5. 同步 Client、SDK、Frontend、测试和 `compatibility.md`；
6. 在 CHANGELOG 记录迁移要求；
7. 禁止仅在某一端添加未经 Shared 定义的隐式字段。
