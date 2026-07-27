# VCPDeck 前端、CLI 与 Skill 对接指南

> 更新时间：2026-07-26  
> 适用范围：当前 `main` 分支  
> 事实来源：当前代码实现优先于历史设计文档

本文用于指导 VCPDeck Frontend、CLI 和 Skill 对接当前已经实现的 Server/Client 能力。文中会明确区分可直接使用的能力、存在限制的能力和尚未实现的能力。

## 1. 当前能力矩阵

| 功能域 | Server | Client | Frontend | CLI | Skill | 对接结论 |
|---|---|---|---|---|---|---|
| 健康检查 | 已实现 | 不涉及 | SDK 已接入 | 骨架 | 骨架 | 可直接使用 |
| Cookie 登录/退出 | 已实现 | 不涉及 | 已实现 | 不适用 | 不适用 | 可直接使用 |
| Bearer Token | 已实现 | 不涉及 | Token 管理已实现 | 未实现 | 未实现 | CLI/Skill 可直接复用 SDK |
| 身份管理 | 已实现 | 不涉及 | 已实现 | 未实现 | 未实现 | 可直接使用，需 admin |
| 在线 Client 列表 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | 仅返回在线 Client |
| Job 创建/查询/取消 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | 取消仅对运行中的 exec 可靠 |
| 命令执行 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | REST 无实时输出，Frontend 展示诚实摘要 |
| 脚本执行 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | REST 无实时输出，Frontend 展示诚实摘要 |
| 轻量文件操作 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | 使用 `file.roots`，仍有路径安全限制，见 §7.7 |
| 文件导出 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | Frontend 可导出下载 |
| 文件导入 | 部分实现 | 已实现 | 未提供入口 | 未实现 | 未实现 | 只能使用现有 `fileId`，见 §8.3 |
| Storage 预签名上传/下载 | 已实现 | 已实现 | 下载用于文件导出 | 未实现 | 未实现 | 本地上传后 import 尚无闭环 |
| Storage 后端配置 | 已实现 | 不涉及 | 已实现（仅写安全字段） | 未实现 | 未实现 | 不读取 raw config |
| 阿里云盘 OAuth | 已实现 | 不涉及 | 已实现 | 未实现 | 未实现 | 只展示安全状态，授权 URL 校验 origin |
| FRP 映射 | 已实现 | 已实现 | 已实现 | 未实现 | 未实现 | 创建/查询可用；删除仍有已知缺陷 |
| Job WebSocket 实时输出 | 部分实现 | 已实现 | 未实现 | 未实现 | 未实现 | 暂不作为对接方案 |
| `agent.run` | 仅有类型占位 | 未实现 | 未实现 | 未实现 | 未实现 | 不得调用 |

当前 Frontend 已完成登录、Dashboard、在线机器工作区、command/script、Job、受控文件浏览、FRP、Storage/阿里云盘和账号设置。`packages/cli/src/index.ts` 与 `skills/vcpdeck/SKILL.md` 仍是骨架。

> **安全提示：** 当前任意已认证身份都等价于远程机器操作员，可执行 shell、操作文件并修改 Storage/FRP；Job 也不按身份隔离。只向可信操作者发放账号和 Token。

---

## 2. 公共约定

### 2.1 Server 地址

默认开发地址：

```text
http://localhost:3001
```

首次启动前必须设置：

```env
VCPDECK_ADMIN_PASSWORD=<strong-password>
VCPDECK_ADMIN_USERNAME=admin
VCPDECK_PSK=<unique-random-client-psk>
```

数据库中还没有 admin 且缺少 `VCPDECK_ADMIN_PASSWORD` 时，Server 会直接退出。Server 与 Client 未配置 `VCPDECK_PSK` 时都会使用固定开发值 `vcpdeck-dev-psk`；任何可被其他主机访问的环境都必须替换该默认值。

REST API 统一使用 `/api` 前缀。Frontend 的 Vite dev server 已将 `/api` 代理到 `http://localhost:3001`，因此浏览器代码应继续使用相对路径。

CLI 与 Skill 应允许配置 Server 地址，例如：

```text
VCPDECK_SERVER=http://localhost:3001
```

不要把末尾 `/` 和接口路径重复拼接。

### 2.2 请求格式

除预签名文件上传和下载外：

```http
Content-Type: application/json
```

时间字段为 ISO 8601 字符串；预签名 URL 的 `expiresAt` 为 Unix 毫秒时间戳。

### 2.3 认证方式

#### Frontend：Cookie Session

登录成功后 Server 设置 HttpOnly Cookie：

```text
vcpdeck_session=<opaque-session-token>
```

Frontend 请求必须带：

```ts
fetch(path, { credentials: "include" })
```

开发环境通常需要：

```env
VCPDECK_COOKIE_SECURE=false
VCPDECK_FRONTEND_ORIGIN=http://localhost:5173
```

#### CLI/Skill：Bearer Token

```http
Authorization: Bearer vcp_<token>
```

Token 仅在创建时返回一次。CLI 应保存在受限配置文件或系统凭证存储中；Skill 应通过环境变量或 CLI 配置读取，不得将 Token 写入提示词、日志或回复。

#### 公开接口

只有以下接口无需认证：

- `GET /api/health`
- `POST /api/auth/login`
- 已签名的 `PUT /api/storage/upload/:key`
- 已签名的 `GET /api/storage/download/:key`

其余 REST API 默认都需要 Cookie 或 Bearer Token。

#### 当前权限边界（重要）

VCPDeck 当前不是细粒度授权系统：普通身份与 admin 的业务权限相同，admin 只额外拥有身份管理接口。任意有效 Cookie 或 Bearer Token 都可调用远程 shell、文件、Storage、阿里云盘和 FRP 接口。

因此：

- 不要把普通身份或 Token 当成只读、低权限凭证；
- 只向受信任的远程机器操作员发放身份和 Token；
- Frontend 隐藏按钮、CLI 参数确认和 Skill 确认门都不是服务端授权边界；
- 当前 Job、Client、Storage 和 FRP 数据不按身份隔离。

### 2.4 HTTP 状态与错误响应

NestJS 成功创建资源通常返回 `201`，普通查询和更新通常返回 `200`。调用端应接受接口条目中列出的成功状态，而不要只判断响应体。

当前错误格式并不完全统一，可能是：

```json
{
  "statusCode": 401,
  "code": "AUTH_REQUIRED",
  "message": "Authentication required"
}
```

也可能是 NestJS 标准错误：

```json
{
  "statusCode": 400,
  "message": "Client \"...\" is offline",
  "error": "Bad Request"
}
```

调用端应分别处理机器错误码和用户消息：

```text
分支判断：body.code → HTTP status
用户展示：经过白名单或脱敏的 body.message → HTTP statusText → 通用错误文案
```

`body.message` 可能是 string 或 string[]。不要依赖所有接口都有稳定 `code`；不要把原始服务端异常、stack 或敏感 payload 直接展示给用户。

认证守卫和文件 Job 有稳定错误码。登录及修改个人资料的业务异常当前使用普通 `Error`，Server 又没有自定义异常过滤器，因此无效凭证、身份禁用、用户名冲突和当前密码错误可能表现为 `500 Internal Server Error`，其附带的业务 code 不保证出现在 HTTP 响应中。调用端在这些接口上应把非 2xx 作为操作失败，不要依赖 401/409 或业务 code，直至 Server 修复异常映射。

### 2.5 敏感信息

以下内容不得写入日志、遥测、Skill 回复或持久化浏览器存储：

- 密码、Session Cookie、Bearer Token、Client PSK；
- Storage 预签名 URL（其 query string 含签名）；
- 阿里云盘 client secret、access token、refresh token；
- FRP auth token；
- 可能含凭证的命令、脚本、路径、Job payload 和文件内容。

`GET /api/jobs` 和 `GET /api/jobs/:jobId` 会返回完整 Job payload，而且查询不按创建者隔离：任意已认证身份都能读取最近 100 条 Job，并可按已知 ID 查看其他身份创建的 Job。Frontend、CLI 和 Skill 不得把它们描述为“我的任务”，展示前必须按 Job 类型脱敏，不能直接 dump 原始对象。多身份部署当前没有 Job 隐私边界。

---

## 3. Job 状态与轮询

### 3.1 状态

| 状态 | 含义 | 是否终态 |
|---|---|---|
| `pending` | 已创建，等待调度槽 | 否 |
| `running` | 已下发给 Client | 否 |
| `waiting_input` | 为未来交互任务预留 | 否 |
| `disconnected` | Client 断线，等待重连对账 | 否 |
| `done` | 成功完成 | 是 |
| `error` | 执行失败 | 是 |
| `cancelled` | 已取消 | 是 |

每个 Client 最多同时运行 3 个通用 Job，其余 Job 保持 `pending`。

### 3.2 首期轮询策略

Frontend、CLI 和 Skill 首期统一使用 REST：

```text
POST /api/jobs
  → 等待 1 秒
  → GET /api/jobs/:jobId
  → 间隔依次使用 1s、2s、5s
  → 后续保持 5s
  → done / error / cancelled 时停止
```

要求：

- `disconnected` 不是终态；
- 页面卸载、CLI 收到中断信号或 Skill 操作终止时停止本地轮询；
- 本地等待超时不代表远端 Job 已停止；
- 需要停止远端任务时必须调用取消接口；
- HTTP 429/5xx 或网络错误可继续按 5 秒退避，认证失败则立即停止并要求重新认证。

推荐的调用端伪代码：

```ts
const terminal = new Set(["done", "error", "cancelled"]);
const delays = [1000, 2000, 5000];

for (let attempt = 0; ; attempt++) {
  await sleep(delays[Math.min(attempt, delays.length - 1)]);
  const job = await getJob(jobId);
  if (terminal.has(job.status)) return job;
}
```

### 3.3 实时输出限制

Client 会实时发送 `job:stdout` 和 `job:stderr`，但当前 Server：

1. 只在 `/client` Socket.IO namespace 内转发；
2. 不将 stdout/stderr 持久化到数据库；
3. `/app` namespace 只实现认证，没有转发 Job 事件。

因此 REST 轮询只能得到最终状态和结构化结果，**无法获取命令或脚本的过程输出**。当前 `exec` 的最终结果也只有 `exitCode`。

后续确有需求时再增加 `/app` 事件转发、REST 断线补偿和输出持久化；当前三端不要依赖 WebSocket。

---

## 4. 健康检查

### `GET /api/health`

- 状态：**已实现，可直接对接**
- 鉴权：无需认证
- 成功：`200`

响应：

```json
{ "ok": true }
```

用途：登录页 Server 可达性检查、CLI `doctor`、Skill setup 检查。它只说明 HTTP Server 可响应，不代表数据库、Client、Storage 或 FRP 均可用。

实现：`packages/server/src/events/events.controller.ts`

---

## 5. 认证、Token 与身份管理

### 5.1 登录

#### `POST /api/auth/login`

- 状态：**已实现**
- 鉴权：无需认证
- 成功：`201`，并设置 Cookie

请求：

```json
{
  "username": "admin",
  "password": "<password>"
}
```

响应：

```json
{
  "identity": {
    "id": "uuid",
    "username": "admin",
    "displayName": "admin",
    "isAdmin": true
  }
}
```

失败：无效凭证或被禁用身份。当前 Controller 抛出普通 `Error`，默认 NestJS 处理后可能返回 `500`，而不是设计文档中的稳定 `401 AUTH_INVALID/IDENTITY_DISABLED`。Frontend 应把所有非 2xx 当作登录失败，不应通过响应差异推断用户名是否存在。

### 5.2 登出

#### `POST /api/auth/logout`

- 鉴权：Cookie 或 Bearer
- 成功：`201`

```json
{ "ok": true }
```

Cookie 调用会撤销当前 Session 并清除 Cookie。Bearer 调用没有 Session 可撤销；撤销 CLI Token 应使用 Token 删除接口。

### 5.3 当前身份

#### `GET /api/auth/me`

- 鉴权：需要
- 成功：`200`

```json
{
  "id": "uuid",
  "username": "admin",
  "displayName": "admin",
  "isAdmin": true,
  "disabledAt": null,
  "createdAt": "2026-07-26T00:00:00.000Z"
}
```

### 5.4 修改用户名或密码

#### `PUT /api/auth/me`

- 鉴权：需要
- 成功：`200`

```json
{
  "username": "new-name",
  "password": "new-password",
  "currentPassword": "current-password"
}
```

`username`、`password` 至少提供一个；`currentPassword` 必填。成功响应：

```json
{ "ok": true }
```

Service 内部使用 `USERNAME_TAKEN` 和 `AUTH_INVALID`，但当前 Controller/异常处理不能保证它们以 409/401 或响应 code 返回；调用端暂时只能可靠判断成功或失败。

### 5.5 创建 Token

#### `POST /api/auth/tokens`

- 鉴权：需要
- 成功：`201`

请求：

```json
{ "label": "office-cli" }
```

响应：

```json
{
  "id": "credential-uuid",
  "token": "vcp_<secret>",
  "label": "office-cli"
}
```

明文 Token 只返回一次。Frontend 只应短暂显示并提供复制；离开页面后不能再次读取。

### 5.6 Token 列表

#### `GET /api/auth/tokens`

- 鉴权：需要
- 成功：`200`

```json
[
  {
    "id": "credential-uuid",
    "label": "office-cli",
    "lastUsedAt": null,
    "expiresAt": null,
    "revokedAt": null,
    "createdAt": "2026-07-26T00:00:00.000Z"
  }
]
```

列表不返回明文 Token。

### 5.7 撤销 Token

#### `DELETE /api/auth/tokens/:id`

- 鉴权：需要，只能撤销自己的 Token
- 成功：`200`
- 危险操作：需要确认

```json
{ "ok": true }
```

Frontend 应显示 Token label 并确认；CLI 要求显式 `--force`；Skill 必须先取得用户确认。

### 5.8 身份管理（admin）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/api/identities` | 无 | `IdentityInfo[]` |
| `POST` | `/api/identities` | `{username,password,displayName}` | 新建的 `IdentityInfo` |
| `POST` | `/api/identities/:id/disable` | 无 | `{ok:true}` |
| `POST` | `/api/identities/:id/enable` | 无 | `{ok:true}` |

非 admin 返回 `403 FORBIDDEN`。禁用身份会撤销其 Session；Bearer Credential 不会物理撤销，但身份禁用期间不能认证，重新启用后原 Credential 可再次使用。

实现：

- `packages/server/src/auth/auth.controller.ts`
- `packages/server/src/auth/auth.service.ts`
- `packages/server/src/identity/identity.controller.ts`

---

## 6. Client 管理

### `GET /api/clients`

- 状态：**已实现**
- 鉴权：需要
- 成功：`200`

响应：

```json
[
  {
    "clientId": "machine-uuid",
    "hostname": "workstation",
    "os": "win32 10.0.26100",
    "capabilities": ["exec", "file.read", "file.write", "frp"],
    "online": true,
    "lastHeartbeatAt": "2026-07-26T00:00:00.000Z"
  }
]
```

限制：

- 只返回当前 `online=true` 的 Client，无法查询离线机器历史；
- 心跳当前只更新 `lastHeartbeatAt`，不向 REST 返回 CPU、内存、磁盘或运行 Job；
- `lastHeartbeatAt` 在刚注册且尚未发送心跳时可能为 `null`。

调用端应先根据 capability 控制功能入口：

| 操作 | capability |
|---|---|
| 命令/脚本 | `exec` |
| list/stat/readText/export | `file.read` |
| writeText/mkdir/delete/move/import | `file.write` |
| FRP | `frp` |

注意：Server 当前没有校验 `exec` capability，只校验文件 capability；调用端仍应检查，但不能将前端检查当作安全边界。

实现：`packages/server/src/client/client.service.ts`

---

## 7. Job 与远程执行

### 7.1 创建 Job

#### `POST /api/jobs`

- 鉴权：需要
- 成功：`201`

通用请求：

```json
{
  "clientId": "machine-uuid",
  "type": "exec",
  "payload": {},
  "timeout": 30000
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `clientId` | string | 是 | 在线 Client ID |
| `type` | string | 是 | Job 类型；不要发送未知类型 |
| `payload` | object | 是 | 类型对应参数 |
| `timeout` | positive integer | 否 | Client 进程超时，毫秒 |

响应：

```json
{
  "jobId": "job-uuid",
  "status": "running",
  "type": "exec"
}
```

并发槽已满时初始状态为 `pending`。

### 7.2 Job 列表

#### `GET /api/jobs`

- 鉴权：需要
- 成功：`200`
- 返回最近 100 条，按创建时间倒序
- 当前没有分页、筛选、按 Client 查询或按创建者隔离

### 7.3 Job 详情

#### `GET /api/jobs/:jobId`

- 鉴权：需要
- 成功：`200`
- 不存在：`404`

```json
{
  "jobId": "job-uuid",
  "clientId": "machine-uuid",
  "type": "exec",
  "status": "done",
  "payload": {
    "mode": "command",
    "command": "node --version"
  },
  "result": {
    "exitCode": 0
  },
  "errorCode": null,
  "errorMessage": null,
  "createdAt": "2026-07-26T00:00:00.000Z",
  "startedAt": "2026-07-26T00:00:00.010Z",
  "finishedAt": "2026-07-26T00:00:00.100Z",
  "createdByIdentityId": "identity-uuid",
  "createdByName": "Admin",
  "createdVia": "web"
}
```

### 7.4 取消 Job

#### `POST /api/jobs/:jobId/cancel`

- 鉴权：需要
- 成功：`201`

可能响应：

```json
{ "jobId": "job-uuid", "status": "cancelled" }
```

或：

```json
{ "jobId": "job-uuid", "status": "cancelling" }
```

行为：

- `pending` Job 可由 Server 立即标记 `cancelled`；
- `running` Job 先返回 `cancelling`，必须继续轮询直至终态；
- 当前 Client 的取消注册表只跟踪 `exec` 子进程；运行中的 file/FRP Job 取消通常会返回 cancel failed，且 REST 没有稳定反馈该失败；
- 已终态 Job 的取消错误格式不稳定。

因此首期 UI/CLI/Skill 只应承诺可靠取消 `exec`。其他类型可以提供“请求取消”，但必须说明可能无法中止。

### 7.5 command 模式

```json
{
  "clientId": "machine-uuid",
  "type": "exec",
  "payload": {
    "mode": "command",
    "command": "node --version",
    "cwd": "D:/work/project"
  },
  "timeout": 30000
}
```

`mode` 可省略：当 payload 有 `command` 时 Server 会兼容为 command 模式。新调用端应始终显式传 `mode`。

Client 使用系统 shell 执行整段 command。不要将不可信字符串直接拼入命令；Frontend 和 Skill 应将用户看到的完整命令作为确认对象。

成功：

```json
{
  "status": "done",
  "result": { "exitCode": 0 }
}
```

非零退出：

```json
{
  "status": "error",
  "result": { "exitCode": 1 }
}
```

### 7.6 script 模式

```json
{
  "clientId": "machine-uuid",
  "type": "exec",
  "payload": {
    "mode": "script",
    "executable": "node",
    "args": ["-"],
    "script": "console.log('hello')",
    "cwd": "D:/work/project"
  },
  "timeout": 30000
}
```

约束：

- `executable` 为非空字符串；
- `args` 必须是字符串数组；
- `script` 必须是字符串，通过 stdin 写给进程；
- script 模式禁止同时传 `command`；
- Client 使用 `shell: false`，调用端必须明确提供 executable 和 args。

基础设施错误可能返回：

- `EXEC_SPAWN_FAILED`
- `EXEC_STDIN_FAILED`

### 7.7 远程文件操作

所有文件 Job 都要求：

```json
{
  "path": "relative/path.txt",
  "rootDir": "D:/allowed/root"
}
```

Server 将 `rootDir` 原样下发，Client 做路径处理。**`rootDir` 不是 Server 预配置的 allowlist**，拥有业务 API 调用权的身份可以自行指定它，因此当前隔离主要防止 `path` 逃逸调用方给出的 root，而不是限制调用者能访问机器上的哪些根目录。

此外，当前 `resolveSafePath` 存在两个实现限制：

1. 路径比较前会把完整路径转为小写；在 Linux 等大小写敏感文件系统上可能访问错误路径；
2. symlink/junction 逃逸检测抛出的错误会被同一 `catch` 吞掉，不能视为有效安全边界。

在修复前：

- 不要让不可信用户自由填写 `rootDir`；
- Frontend 应从受控配置选择 root，而不是普通文本框；
- CLI/Skill 只为受信任操作者开放文件能力；
- 不要在包含不可信 symlink/junction 的目录树中执行文件 Job。

#### `file.list`

请求 payload：

```json
{ "path": ".", "rootDir": "D:/work" }
```

结果：

```json
{
  "entries": [
    {
      "name": "src",
      "kind": "dir",
      "size": 0,
      "mtime": "2026-07-26T00:00:00.000Z"
    }
  ]
}
```

#### `file.stat`

```json
{ "path": "README.md", "rootDir": "D:/work" }
```

结果：

```json
{
  "name": "README.md",
  "kind": "file",
  "size": 1024,
  "mtime": "2026-07-26T00:00:00.000Z"
}
```

#### `file.readText`

```json
{
  "path": "README.md",
  "rootDir": "D:/work",
  "maxBytes": 262144
}
```

`maxBytes` 默认 256 KiB。结果：

```json
{ "content": "# Project\n", "size": 10 }
```

#### `file.writeText`

```json
{
  "path": "notes/result.txt",
  "rootDir": "D:/work",
  "content": "done\n"
}
```

Client 先写临时文件再 rename。父目录必须已存在。该操作会替换目标，属于危险操作。

结果：

```json
{ "path": "<client-resolved-path>" }
```

#### `file.mkdir`

```json
{ "path": "artifacts/run-1", "rootDir": "D:/work" }
```

递归创建，已存在时仍可成功。

#### `file.delete`

```json
{
  "path": "artifacts/run-1",
  "rootDir": "D:/work",
  "recursive": true
}
```

- 非空目录必须显式 `recursive: true`；
- 当前实现使用 `force: true`，目标不存在也可能返回成功；
- Frontend 二次确认并展示 root + path；
- CLI 要求 `--recursive`，并建议再要求 `--force`；
- Skill 必须在执行前取得用户确认。

#### `file.move`

```json
{
  "source": "old.txt",
  "destination": "archive/new.txt",
  "rootDir": "D:/work",
  "overwrite": false
}
```

目标存在且没有 `overwrite: true` 时返回 `PATH_CONFLICT`。覆盖属于危险操作。

### 7.8 文件错误码

| code | 含义 | 建议 |
|---|---|---|
| `PATH_NOT_FOUND` | 路径不存在 | 允许用户刷新或改路径后重试 |
| `PATH_NOT_ALLOWED` | path 逃逸给定 root | 不自动重试 |
| `PATH_CONFLICT` | 非空目录或目标已存在 | 修改显式参数后再操作 |
| `SIZE_EXCEEDED` | 文本超过读取上限 | 改用 export |
| `SHA256_MISMATCH` | import 校验失败 | 重新上传/导入 |
| `IO_ERROR` | 文件或传输错误 | 展示安全摘要，可人工重试 |

实现：

- `packages/server/src/events/events.controller.ts`
- `packages/server/src/job/job.service.ts`
- `packages/client/src/executor.ts`
- `packages/client/src/file-handler.ts`

---

## 8. Storage 与文件传输

### 8.1 申请上传 URL

#### `POST /api/storage/upload-token`

- 鉴权：需要
- 成功：`201`

```json
{
  "jobId": "caller-reference",
  "clientId": "machine-uuid",
  "filename": "data.json",
  "size": 1024,
  "mimeType": "application/json",
  "ttlSeconds": 3600
}
```

响应：

```json
{
  "url": "/api/storage/upload/<key>?expires=<ms>&sig=<secret>",
  "expiresAt": 1784000000000
}
```

随后向 `url` 发送原始文件字节：

```http
PUT <url>
Content-Type: application/json

<raw bytes>
```

上传响应：

```json
{ "key": "uuid/data.json", "size": 1024 }
```

预签名 URL 是短期凭证，不要记录完整 query string。

### 8.2 申请下载 URL

#### `POST /api/storage/download-token`

```json
{ "key": "uuid/data.json", "ttlSeconds": 3600 }
```

响应：

```json
{
  "url": "/api/storage/download/<key>?expires=<ms>&sig=<secret>",
  "expiresAt": 1784000000000
}
```

对返回 URL 发起 `GET`，响应为文件流，并包含 Content-Type、Content-Disposition 和 Content-Length。

### 8.3 `file.export` 与 `file.import`

#### 导出：Client → Storage

创建 Job：

```json
{
  "clientId": "machine-uuid",
  "type": "file.export",
  "payload": {
    "path": "logs/app.log",
    "rootDir": "D:/service"
  },
  "timeout": 30000
}
```

Server 自动创建 File 记录和上传 URL。完成结果：

```json
{
  "fileId": "file-uuid",
  "key": "uuid/app.log",
  "size": 12345,
  "sha256": "hex-digest"
}
```

使用 `key` 调 `/api/storage/download-token` 即可下载；使用 `fileId` 可作为后续 import 的来源。

#### 导入：Storage → Client

创建 Job：

```json
{
  "clientId": "machine-uuid",
  "type": "file.import",
  "payload": {
    "targetPath": "config/imported.json",
    "rootDir": "D:/service",
    "fileId": "file-uuid"
  },
  "timeout": 30000
}
```

**当前限制：** 通用 `/api/storage/upload-token` 只创建 Storage 对象，不创建 Prisma `File` 记录，也不返回 `fileId`。因此“用户从本地上传一个新文件，再 import 到 Client”的公开链路目前缺少从上传对象创建/取得 `fileId` 的接口。

当前可用路径只有：

1. 先通过 `file.export` 得到一个 completed `fileId`；
2. 再用该 `fileId` import 到目标路径或其他在线 Client。

Frontend、CLI 和 Skill 不得从 `key` 猜测 `fileId`。若要支持本地文件上传后导入，需要 Server 后续补齐 File 记录创建/确认接口。

另一个已知问题：Client 的 import 完成结果当前把 `downloadRef.expiresAt` 错当成 `size` 返回。因此 import 的 `result.size` 不可信，应以随后 `file.stat` 的结果为准。

### 8.4 删除 Storage 对象

#### `DELETE /api/storage/:key`

- 鉴权：需要
- 危险操作：需要确认

```json
{ "ok": true }
```

`key` 包含 `/` 时必须作为路径整体正确编码。删除对象不会自动清理相关 Job/File 审计记录；调用端应避免把它描述成“删除远程 Client 文件”。

### 8.5 Storage 后端配置

#### `GET /api/storage/config`

响应：

```json
{
  "kind": "local",
  "config": { "baseDir": "./data/storage" },
  "updatedAt": "2026-07-26T00:00:00.000Z"
}
```

#### `PUT /api/storage/config`

切换本地存储：

```json
{
  "kind": "local",
  "config": { "baseDir": "./data/storage" }
}
```

切换阿里云盘通常只需在 OAuth 配置完成后发送：

```json
{ "kind": "alibaba" }
```

更新后 Server 热加载 provider。

安全限制：`GET /api/storage/config` 当前会原样返回数据库中的 config；当后端为 `alibaba` 时可能包含 client secret、access token 和 refresh token。该接口对所有已认证身份开放，不限 admin。Frontend 不应显示或缓存原始 config；CLI/Skill 不应原样输出。生产使用前建议后续在 Server 增加脱敏和 admin 限制。

实现：

- `packages/server/src/storage/storage.controller.ts`
- `packages/server/src/storage/storage.service.ts`
- `packages/server/src/file/file.service.ts`
- `packages/client/src/transfer-handler.ts`

---

## 9. 阿里云盘配置与 OAuth

所有接口需要认证，但当前不要求 admin。

### 9.1 查询状态

#### `GET /api/aliyundrive/status`

```json
{
  "configured": true,
  "authorized": true,
  "hasAuth": true,
  "isExpired": false,
  "clientId": "app-client-id",
  "openapiBase": "https://openapi.alipan.com",
  "transferFolder": "VCPDeck",
  "driveId": "drive-id",
  "expiresAt": 1784000000000
}
```

该响应不包含 Token，可用于设置页。

### 9.2 保存配置

#### `PUT /api/aliyundrive/config`

```json
{
  "clientId": "app-client-id",
  "clientSecret": "<optional-secret>",
  "openapiBase": "https://openapi.alipan.com",
  "transferFolder": "VCPDeck"
}
```

`clientId` 必填。省略 `clientSecret` 时保留已有值。

**安全限制：** Controller 只显式移除 `clientSecret`，但会把已有 config 中的其他字段展开到响应；如果已经完成授权，响应可能包含 access token 或 refresh token。调用端应忽略/丢弃非状态字段，禁止记录完整响应。状态展示应改调 `/status`。

### 9.3 发起 OAuth

#### `POST /api/aliyundrive/oauth/start`

无请求体。响应：

```json
{
  "state": "random-state",
  "authorizationUrl": "https://.../oauth/authorize?...",
  "expiresAt": 1784000000000
}
```

流程：

1. Frontend 在新标签页打开 `authorizationUrl`；CLI 打印 URL；Skill 可请求用户打开 URL；
2. 用户在阿里云盘完成授权并取得 code；
3. 在 10 分钟内提交 state + code。

OAuth 会话只保存在 Server 内存中，Server 重启后必须重新 start。

### 9.4 完成 OAuth

#### `POST /api/aliyundrive/oauth/complete`

```json
{
  "state": "state-from-start",
  "code": "authorization-code"
}
```

响应：

```json
{
  "authorized": true,
  "expiresAt": 1784000000000
}
```

完成授权后调用 `/api/aliyundrive/status` 确认，再用 `PUT /api/storage/config` 将 `kind` 设为 `alibaba`。

### 9.5 撤销本地授权

#### `POST /api/aliyundrive/oauth/revoke`

- 危险操作：需要确认

```json
{ "revoked": true }
```

该操作清除 VCPDeck 数据库中的 Token，不保证调用阿里云盘远端撤销授权。完成后重新查询 status。

实现：`packages/server/src/storage/aliyundrive.controller.ts`

---

## 10. FRP 端口映射

前提：

- Client 在线且 capabilities 含 `frp`；
- Client 可找到匹配平台的 frpc；
- Server 已配置 `FRP_PUBLIC_HOST`、`FRPS_BIND_PORT`、`FRPS_TOKEN`；
- 端口范围默认为 `20000..21000`。

### 10.1 创建映射

#### `POST /api/frp/mappings`

```json
{
  "clientId": "machine-uuid",
  "name": "local-web",
  "proxyType": "tcp",
  "localIp": "127.0.0.1",
  "localPort": 3000,
  "remotePort": 20080
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `clientId` | 是 | 在线且支持 FRP 的 Client |
| `name` | 是 | frpc proxy 名称 |
| `proxyType` | 是 | `tcp`、`http`、`https` |
| `localIp` | 否 | 默认 `127.0.0.1` |
| `localPort` | 是 | 本地服务端口 |
| `remotePort` | 否 | 首选公网端口，省略则自动分配 |
| `customDomain` | 否 | HTTP/HTTPS 自定义域名 |

响应立即返回，不等待 frpc 启动：

```json
{
  "id": "fm_12345678",
  "clientId": "machine-uuid",
  "name": "local-web",
  "proxyType": "tcp",
  "localIp": "127.0.0.1",
  "localPort": 3000,
  "remotePort": 20080,
  "customDomain": null,
  "status": "inactive",
  "publicUrl": "frp.example.com:20080",
  "createdAt": "2026-07-26T00:00:00.000Z",
  "updatedAt": "2026-07-26T00:00:00.000Z"
}
```

创建接口不返回内部 Job ID。调用端应轮询映射详情：

```text
GET /api/frp/mappings/:id
  → inactive：继续等待
  → active：成功
  → error：失败
```

建议沿用 1s、2s、5s 间隔，并设置调用端等待上限。`inactive` 也可能表示 Client 后续断线。

### 10.2 列表和详情

```http
GET /api/frp/mappings
GET /api/frp/mappings?clientId=<clientId>
GET /api/frp/mappings/:id
```

列表返回 `FrpMappingInfo[]`；详情返回单个映射。当前不存在时详情使用 `400`，不是 `404`。

### 10.3 删除映射

#### `DELETE /api/frp/mappings/:id`

- 危险操作：必须确认

```json
{ "id": "fm_12345678", "deleted": true }
```

**当前已知缺陷：** Server 会先删除数据库映射，再下发 `frp.delete` Job；Client 完成后 Gateway 又尝试更新已删除映射状态，可能导致 Prisma 更新失败，使内部删除 Job 无法正常进入终态。REST 会在下发前就返回 `deleted: true`，因此它只代表 Server 记录已删除，不足以证明 Client frpc 已清理成功。

在修复前：

- Frontend/CLI/Skill 必须把结果描述为“已提交删除并移除 Server 映射记录”；
- 不应宣称远端 frpc 已确认清理；
- 关键映射删除后应人工检查目标端口或 Client frpc 状态。

实现：

- `packages/server/src/frp/frp.controller.ts`
- `packages/server/src/frp/frp.service.ts`
- `packages/client/src/frpc-daemon.ts`

---

## 11. Frontend 与 SDK 现状

### 11.1 复用 `@vcpdeck/sdk`

`packages/sdk` 提供框架无关的 REST 客户端，统一 Cookie/Bearer 认证、错误归一化、业务 API 和 Job 轮询。Frontend 通过 `SdkProvider` 复用同一实例，不另写 fetch 或轮询逻辑；CLI/Skill 后续也应直接复用该包。

```ts
import { VcpDeckClient } from "@vcpdeck/sdk";

const sdk = new VcpDeckClient({
  baseUrl: "http://localhost:3001",
  auth: { type: "bearer", token: process.env.VCPDECK_TOKEN! },
});

const clients = await sdk.clients.list();
const job = await sdk.jobs.create({
  clientId: clients[0].clientId,
  type: "exec",
  payload: { mode: "command", command: "node --version" },
});
const terminal = await sdk.jobs.wait(job.jobId);
```

浏览器使用 Cookie 时改为 `auth: { type: "cookie" }` 和相对 `baseUrl`。`VcpDeckApiError` 保留 HTTP `status`、稳定 `code`（若 Server 提供）和安全 `message`。

### 11.2 页面行为

- Client 离线或 capability 不满足时禁用提交按钮，但仍处理 Server 端拒绝；
- Job 创建后立即展示 `jobId` 和初始状态；
- 页面卸载或切换 Job 时清除 timer/AbortController；
- 终态后停止轮询；
- `error` 同时展示 `errorCode` 和安全 message；
- 不显示未经脱敏的 Job payload；
- 文件 delete/move overwrite、Token revoke、Storage delete、OAuth revoke、FRP delete 均二次确认；
- 预签名 URL 只保存在内存中并尽快使用。

### 11.3 Frontend Definition of Done

- [x] Cookie 登录、登出、401 跳转正确；
- [x] 可查看在线 Client 与 capabilities；
- [x] 可创建、查询、轮询和取消 exec Job；
- [x] 正确区分 `done/error/cancelled/disconnected`；
- [x] 页面卸载时中止资源和 Job 轮询；
- [x] 文件操作使用 `file.roots`，并对删除/覆盖要求精确目标确认；
- [x] export 可下载；不提供缺少 `fileId` 闭环的本地 import UI；
- [x] 阿里云盘配置/OAuth 只读取安全状态，不读取 raw config；
- [x] FRP 创建可轮询状态，删除显示 Client 清理未确认；
- [x] 加载、空列表和错误状态有明确 UI。

仍未实现实时 stdout/stderr、本地上传后 import、离线 Client 历史和 `agent.run`；这些限制不能由 Frontend 伪造或绕过。

---

## 12. CLI 对接建议

当前 CLI 仅打印 `vcpdeck`，可直接围绕 REST API 实现，不需要额外协议层。

### 12.1 建议命令映射

```text
vcpdeck health
vcpdeck auth me
vcpdeck auth token create|list|revoke
vcpdeck identity list|create|disable|enable
vcpdeck client list
vcpdeck job list|get|cancel
vcpdeck exec --client <id> --command <cmd> [--cwd] [--timeout]
vcpdeck script --client <id> --executable <bin> --arg <arg>... [--file|-]
vcpdeck file list|stat|read|write|mkdir|delete|move|export|import
vcpdeck storage config|get|set
vcpdeck storage upload|download|delete
vcpdeck aliyundrive status|config|oauth-start|oauth-complete|revoke
vcpdeck frp list|get|create|delete
```

这只是对现有 API 的薄映射；不要先建立通用插件系统、命令工厂或生成器。

### 12.2 配置与输出

最低配置：

```text
serverUrl
bearerToken
```

要求：

- 支持 `--json`，输出稳定 JSON，便于 Skill 调用；
- 默认人类输出只展示安全摘要；
- Token 不出现在参数回显、错误、debug 日志或 shell history 建议中；
- `exec` 等待超时应返回非零退出码，但不能谎称远端任务已取消；
- 远端 Job `error` 返回非零退出码；
- 认证失败、网络失败、本地等待超时和远端失败使用可区分的错误类型或退出码；
- Ctrl+C 首次只停止本地等待并提示 Job ID；只有显式选择取消才请求远端取消。

### 12.3 危险参数

- `file delete`：目录递归必须 `--recursive`，所有删除建议要求 `--force`；
- `file move`：覆盖必须 `--overwrite`；
- `storage delete`、`token revoke`、`aliyundrive revoke`、`frp delete`：要求 `--force`；
- 非交互环境缺少显式参数时直接失败，不默认同意。

### 12.4 CLI Definition of Done

- [ ] Server URL 与 Token 可安全配置；
- [ ] `health` 与 `auth me` 可诊断连接；
- [ ] 支持 client/job/exec 的人类输出和 `--json`；
- [ ] Job 轮询正确处理终态、断线和本地超时；
- [ ] 文件、Storage、阿里云盘、FRP 命令覆盖本文接口；
- [ ] 危险操作缺少显式参数时拒绝执行；
- [ ] stdout/stderr 限制有清晰提示；
- [ ] 输出和错误不泄露凭证、预签名 URL或敏感 payload。

---

## 13. Skill 完善建议

当前 `skills/vcpdeck/SKILL.md` 只有 setup 骨架。建议 Skill 默认调用 CLI 的 `--json` 模式，而不是在 Skill 中重复实现 HTTP、Token 读取和轮询。

### 13.1 意图映射

| 用户意图 | CLI/API 行为 |
|---|---|
| 查看可用机器 | `client list` |
| 在某机器执行命令 | 选 Client → capability 检查 → `exec` → 轮询 |
| 读取/写入远程文件 | 选 Client/root → 对应 file Job |
| 下载远程文件 | `file.export` → 等终态 → download token |
| 上传本地文件到远程 | 当前说明 import 的 fileId 阻塞，不伪造流程 |
| 创建公网映射 | `frp create` → 轮询 mapping |
| 删除文件/映射/Token | 停在确认门，确认后再调用 |
| 配置阿里云盘 | config → oauth start → 等用户 code → complete → status |

### 13.2 Skill 行为约束

1. 操作前列出匹配的在线 Client；名称不唯一时询问，不猜 clientId；
2. 检查 capability，不支持时解释原因；
3. 命令执行前展示目标 Client、cwd 和完整命令；
4. 删除、覆盖、撤销、FRP 删除必须复述影响并取得用户确认；
5. 轮询只在 `done/error/cancelled` 停止；
6. `disconnected` 应说明正在等待 Client 重连；
7. 回复只包含安全摘要、Job ID、终态、exitCode/错误码和下一步；
8. 不回显 Token、签名 URL、密码、PSK、云盘凭证或完整敏感 payload；
9. 遇到本文标记的阻塞能力时明确停止，不通过任意 shell 命令绕过，除非用户明确要求并确认风险；
10. 当前没有实时 stdout，不能承诺“流式显示日志”。

### 13.3 Skill Definition of Done

- [ ] setup 能检查 Server 地址、Token 与 `auth me`；
- [ ] 能列 Client 并按 capability 过滤；
- [ ] 常用意图稳定映射到 CLI `--json`；
- [ ] Job 轮询和终态判断正确；
- [ ] 所有危险操作具备用户确认门；
- [ ] 对 import、实时输出、FRP 删除缺陷有准确说明；
- [ ] 回复和日志不泄露敏感信息。

---

## 14. 错误处理速查

| 场景 | 调用端行为 |
|---|---|
| `401 AUTH_REQUIRED` | Frontend 跳登录；CLI/Skill 提示配置或更新 Token |
| `403 FORBIDDEN` | 提示需要 admin，不重试 |
| `400 Client ... offline` | 刷新 Client 列表，保留用户输入 |
| capability 缺失 | 禁用入口并解释，不自动改用 exec 绕过 |
| Job `pending` | 继续轮询 |
| Job `disconnected` | 继续低频轮询，提示等待重连 |
| Job `error` | 停止轮询，展示 errorCode、安全 message 或 exitCode |
| `PATH_NOT_FOUND` | 允许刷新目录或修改路径 |
| `PATH_CONFLICT` | 要求用户显式确认 recursive/overwrite 后重试 |
| `PATH_NOT_ALLOWED` | 停止，不自动放宽 root |
| `SIZE_EXCEEDED` | 建议 file.export |
| `SHA256_MISMATCH` | 重新准备来源并重试 import |
| 预签名 URL 403 | 重新申请 URL，不复用过期签名 |
| 网络/5xx | 5 秒退避；超过调用端上限后返回 Job ID供后续查询 |

---

## 15. 当前限制与后续扩展

以下不是 Frontend、CLI 或 Skill 应自行绕过的问题：

1. **实时输出不可用于 REST**：stdout/stderr 未持久化，`/app` 未接收 Job 事件；
2. **本地上传后 import 缺 `fileId` 链路**：Storage 上传接口不创建 File 记录；
3. **import 结果 size 错误**：当前返回 URL 过期时间而非文件大小；
4. **文件路径安全边界不足**：rootDir 由调用者提供，Linux 路径被小写化，symlink 逃逸检查无效；
5. **FRP 删除确认缺陷**：数据库记录先删，完成回调再更新已删除记录；
6. **非 exec 取消不可靠**：Client 取消注册表只跟踪 exec 子进程；
7. **Storage/阿里云盘配置响应可能泄露凭证**：缺少 Server 端脱敏和 admin 限制；
8. **`agent.run` 未实现**：不得创建该类型 Job；
9. **Client REST 只列在线机器**：没有离线历史、详情、指标或分页；
10. **Job 列表固定最近 100 条**：没有分页、筛选、删除和输出检索；
11. **错误响应不统一**：部分接口没有稳定 code；
12. **审计不完整**：通用 Job 记录 actor，但 FRP 内部 Job 直接创建，缺少创建者字段；
13. **未知 Job 类型未被 Server 拒绝**：调用端必须使用本文确认的类型，Server 后续应加 allowlist 校验；
14. **无业务授权与数据隔离**：普通身份可调用全部远程操作接口，Job 可跨身份查询；
15. **认证业务错误映射不正确**：登录和个人资料更新的预期 401/409 可能返回 500；
16. **Client PSK 有固定开发默认值**：生产或共享网络环境必须显式配置唯一 PSK。

后续扩展优先级建议：先修安全和数据正确性（路径、凭证脱敏、import、FRP delete），再补统一错误模型和分页，最后根据实际需求增加 `/app` 实时事件与输出 spool。

---

## 16. 实现索引

| 领域 | 代码位置 |
|---|---|
| 共享类型、状态、错误码 | `packages/shared/src/index.ts` |
| REST 健康、Client、Job | `packages/server/src/events/events.controller.ts` |
| Client Socket.IO 生命周期 | `packages/server/src/events/client.gateway.ts` |
| App Socket.IO 认证骨架 | `packages/server/src/events/app.gateway.ts` |
| Job 业务与调度 | `packages/server/src/job/job.service.ts`, `job.scheduler.ts` |
| 认证与 Token | `packages/server/src/auth/` |
| 身份管理 | `packages/server/src/identity/` |
| Storage REST 与业务 | `packages/server/src/storage/` |
| 文件审计记录 | `packages/server/src/file/` |
| FRP REST 与业务 | `packages/server/src/frp/` |
| Client dispatcher | `packages/client/src/dispatcher.ts` |
| 命令/脚本执行 | `packages/client/src/executor.ts` |
| 轻量文件操作 | `packages/client/src/file-handler.ts` |
| 文件传输 | `packages/client/src/transfer-handler.ts` |
| frpc 管理 | `packages/client/src/frpc-daemon.ts` |
| 框架无关 SDK | `packages/sdk/src/` |
| Frontend API 与页面 | `packages/frontend/src/api/`, `packages/frontend/src/pages/` |
| CLI 骨架 | `packages/cli/src/index.ts` |
| Skill 骨架 | `skills/vcpdeck/SKILL.md` |
| 通用集成测试 | `scripts/test.cjs` |
| FRP 集成测试 | `scripts/test-frp.cjs` |
