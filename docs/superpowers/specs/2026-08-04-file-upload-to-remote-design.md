# 文件上传到远程机器设计

## 状态

- 日期：2026-08-04
- 状态：已确认，待编写实施计划
- 范围：浏览器选择单个本地文件，上传到 Storage，再写入当前文件面板所在的远程目录

## 背景

VCPDeck 已支持远程文件导出：Client 将文件上传到 Storage，Server 持久化 `File` 记录，浏览器通过签名 URL 下载。现有 `file.import` 也已支持 Client 从 Storage 下载文件并写入远程机器，但文件页还缺少浏览器选择本地文件并触发该链路的入口。

本设计新增浏览器到远程机器的上传闭环，并复用现有 Storage、`File`、Job、`file.import` 和 Client 文件安全校验能力。

## 目标与非目标

### 目标

- 文件页支持选择一个本地文件。
- 文件默认写入当前文件面板所在的远程目录。
- 浏览器直传 Storage，不让 Server 代理大文件内容。
- Storage 上传完成后，自动创建并派发现有 `file.import` Job。
- 展示浏览器到 Storage、Storage 到远程 Client 两个阶段的进度。
- 同名文件默认不覆盖；用户确认后或 API 传 `overwrite: true` 才覆盖。
- 上传成功、远程写入成功、失败和取消产生的 Storage 文件均保留，供后续统一清理任务处理。
- 导出下载继续使用相同的 File/Storage 保留策略。

### 非目标

- 首版不支持多选文件。
- 不新增 `file.upload` Job 类型。
- 不新增 Storage 自动清理任务。
- 不增加前端文件大小限制，沿用 Storage/provider 的限制和错误处理。
- 不设计新的 WebSocket 进度通道，复用现有 Job 进度轮询和 `JOB_PROGRESS`。

## 核心方案

采用“两阶段上传会话 + 导入 Job”：

```text
浏览器选择文件
  -> 创建上传会话，File + waiting_input Job
  -> 浏览器 PUT 到 Storage，显示上传进度
  -> 上传完成，激活 file.import Job
  -> Client 从 Storage 下载并写入远程目录
  -> Job 完成/失败，通知铃铛展示结果
```

使用已有 `waiting_input` 状态表示“等待浏览器完成 Storage 上传”。Storage 上传完成后 Job 转为 `pending`，交给现有 Scheduler；Client 仍只处理现有 `file.import`。

## 状态与数据模型

### Job 状态

状态转换：

```text
waiting_input
  -> pending       上传完成接口激活
  -> cancelled     用户取消
  -> error         Storage 接收阶段发生可确认的失败

pending
  -> running       现有 Scheduler 派发
  -> cancelled     现有取消流程

running
  -> done          Client 写入成功
  -> error         Client 下载、校验或写入失败
  -> disconnected 现有断线流程
```

如果浏览器在发起上传前后直接断网，Server 可能无法立即获知失败；该 Job 可以暂留 `waiting_input`，由用户取消或未来清理任务处理。已经到达 Server 但 provider 处理失败的请求应把 Job 标记为 `error`，并保留错误信息。

### File 记录

继续使用现有 `File` 表，不新增专用上传表：

- 创建上传会话时：`status = pending`，保存临时上传 key、`jobId`、`clientId`、文件名、声明大小和 MIME 类型。
- Storage 接收完成时：保存 provider 返回的真实 `key`、实际大小、SHA-256，设置 `status = completed`。
- 远程写入成功、失败或取消后都不删除 File 记录和 Storage 对象。
- `jobId`、`status`、`createdAt`、`expiresAt` 等字段为后续统一清理 Job 文件占用提供查询依据。

导出产生的 File 记录同样保留，不在本功能中改变导出下载生命周期。

## 服务端 API

### 创建上传会话

```http
POST /api/files/upload-sessions
```

请求体：

```json
{
  "clientId": "client-1",
  "rootDir": "D:\\",
  "targetPath": "downloads/report.pdf",
  "filename": "report.pdf",
  "size": 123456,
  "mimeType": "application/pdf",
  "overwrite": false
}
```

字段规则：

- `clientId`、`rootDir`、`targetPath`、`filename`、`size` 必填。
- `targetPath` 是相对于 `rootDir` 的路径。
- `overwrite` 默认 `false`。
- 首版只接受一个文件，不接受文件数组。
- 服务端校验 Client 存在、在线且具备 `file.write` 能力。

响应：

```json
{
  "jobId": "job-1",
  "fileId": "file-1",
  "status": "waiting_input",
  "upload": {
    "url": "/api/storage/upload/uuid/report.pdf?expires=...&sig=...",
    "expiresAt": 1234567890
  }
}
```

服务端创建 Job 时将 `rootDir`、`targetPath`、`fileId`、`overwrite` 保存到 payload，但 Job 状态为 `waiting_input`，不能被 Scheduler 派发。Storage 上传 URL 仍使用现有签名 PUT 机制。

### 浏览器上传 Storage

```http
PUT /api/storage/upload/:key(*)?expires=...&sig=...
```

该接口继续保持 `@Public()`，安全性由签名和过期时间保证。StorageService 在请求流上做一次流式处理：

- 传递流给 provider；
- 统计实际字节数；
- 计算 SHA-256；
- 按现有时间/字节节流规则更新关联 Job 的 `JobProgress`；
- provider 返回后，将 File 临时 key 更新为真实 key，并写入完成状态、实际大小和摘要。

浏览器使用原生 `XMLHttpRequest` 发送 PUT，并监听 `upload.onprogress`。不新增上传依赖，也不经过 Server 内存缓冲。

### 完成并激活上传会话

```http
POST /api/files/upload-sessions/:jobId/complete
```

服务端校验：

- Job 存在且类型为 `file.import`；
- Job 与 File 关联一致；
- Job 当前为 `waiting_input`；
- File 状态为 `completed`，且拥有真实 key、实际大小和 SHA-256。

通过后：

1. 根据 File 真实 key 签发 Storage 下载 URL；
2. 把 `downloadRef`、`size`、`sha256` 写入 Job payload；
3. 将 Job 状态改为 `pending`；
4. 调用现有 Scheduler；
5. 若有可用 Client，发送已有 `file.import` dispatch；
6. 返回 Job 当前信息。

该接口幂等：已经处于 `pending`、`running` 或终态的 Job 重复调用时返回当前状态，不重复派发；`cancelled` 或上传未完成的 Job 返回稳定错误。

## 共享协议与 SDK

### `file.import` payload

在现有导入 payload 上增加：

```ts
interface FileImportPayload {
  rootDir: string;
  targetPath: string;
  downloadRef: FileRef;
  size: number;
  sha256: string;
  overwrite?: boolean;
}
```

### SDK API

SDK 增加上传会话和完成操作，复用现有 `VcpDeckClient.request`：

- `files.createUploadSession(input, signal?)`：创建会话并返回 `jobId`、`fileId`、签名上传 URL。
- `files.completeUpload(jobId, signal?)`：激活会话并返回 Job 信息。
- `files.import(clientId, payload, signal?)`：保留现有接口，增加可选 `overwrite`，支持调用方直接传 `true`。

浏览器文件页负责使用返回的 URL 执行 XHR，以获得上传进度；SDK 不新增第三方上传依赖。已有直接创建 `file.import` Job 的调用方可以使用同一个 `fileId` 再次下发，避免覆盖冲突后重复上传。

## Client 写入与覆盖语义

Client 接收到 `file.import` 后：

1. 使用现有 `resolveSafePath` 校验 `rootDir` 和目标路径；
2. 从 Storage 下载到目标路径旁的临时文件；
3. 流式计算 SHA-256，并按 `size` 上报 Storage 到 Client 的传输进度；
4. 摘要不匹配时删除临时文件，返回 `SHA256_MISMATCH`；
5. 摘要校验成功后检查目标路径；
6. `overwrite !== true` 且目标存在时删除临时文件，返回 `PATH_CONFLICT`；
7. `overwrite === true` 时只允许替换已有文件，目标是目录时仍返回 `PATH_CONFLICT`；
8. 在临时文件校验成功后，用平台兼容的替换方式写入目标文件；
9. 任意异常路径都尝试删除临时文件。

已有目标文件在下载和摘要校验完成前不得被修改。路径安全校验仍由 Client 作为最终边界，不能由前端目录列表替代。

## 前端交互

### 文件页

- 在当前目录工具栏增加“上传文件”入口。
- 使用单文件 `<input type="file">`，文件名作为当前目录下的目标文件名。
- 选择文件后先检查当前已加载目录列表中的同名文件。
- 无同名文件：创建会话时传 `overwrite: false`，直接开始上传。
- 有同名文件：弹出确认；用户确认后创建会话时传 `overwrite: true`。
- 上传阶段显示文件名、已传字节/总字节和百分比。
- Storage 上传完成后进入“正在写入远程目录”，继续显示 Job 进度。
- Job 成功后刷新当前目录；失败显示稳定错误码和错误原因。
- 如果出现列表加载后到 Client 写入前的并发冲突，保留已上传的 File，提示用户确认覆盖，并使用同一个 `fileId` 创建新的 `file.import` Job，传 `overwrite: true`，不重复上传。

### 顶部任务通知

现有通知组件将 `waiting_input` 加入活动状态：

- `waiting_input`：显示“正在上传到 Storage”及上传进度；
- `pending`：显示等待派发；
- `running`：显示“正在写入远程目录”及 Client 传输进度；
- `done`：显示完成；
- `error`：显示错误原因；
- `cancelled`：显示已取消。

上传到远程机器的 Job 不显示导出下载按钮；导出 Job 继续保留原有下载按钮。

## 错误处理

### 浏览器到 Storage

- 签名过期或无效：HTTP `403`，不激活 Job，保留记录。
- 浏览器网络中断：文件页显示上传失败；可通过现有取消接口结束 Job，Storage/File 不主动删除。
- provider 上传失败或流异常：Job 进入 `error`，返回 `IO_ERROR`，不激活 Job。
- 实际大小以流统计结果为准；provider 无法完成时不把 File 标记为 completed。

### Storage 到 Client

复用现有稳定错误码：

- `PATH_NOT_FOUND`：目标父路径不可用；
- `PATH_NOT_ALLOWED`：路径越过根目录或 symlink 安全边界；
- `PATH_CONFLICT`：同名文件未授权覆盖，或目标是目录；
- `SHA256_MISMATCH`：下载内容与 File 摘要不一致；
- `IO_ERROR`：其他传输或文件系统错误。

上传后的 Storage 文件和 File 记录在所有上述错误中保留，交由后续统一清理任务处理。

## 测试设计

### Server

- 创建上传会话会创建正确的 File 和 `waiting_input` Job。
- `waiting_input` Job 不会被 Scheduler 派发。
- Storage 接收流会保存真实 key、实际大小和 SHA-256，并更新进度。
- Storage 上传未完成时，完成接口拒绝激活。
- 完成接口会补全 `file.import` payload、转为 `pending` 并派发。
- 完成接口重复调用幂等，不重复派发。
- 错误 Job 状态、错误 File 关联和不存在资源会返回稳定错误。
- 原有导出上传、真实 key 持久化和下载签名流程回归通过。

### Client

- `overwrite: false` 遇到已有文件返回 `PATH_CONFLICT`，原文件不变。
- `overwrite: true` 能替换已有文件；目标目录仍不被删除。
- SHA-256 不匹配时不修改已有目标文件。
- 写入过程会上报进度，结果 size 使用真实文件大小。
- 路径越界和 symlink 安全校验继续有效。
- 所有失败路径都会尝试清理临时文件。

### SDK / Frontend

- SDK 能创建上传会话、完成会话，并传递 `overwrite`。
- XHR 成功、失败、取消和 progress 事件更新正确。
- 文件页默认使用当前目录和所选文件名。
- 同名文件先确认，确认后传 `overwrite: true`。
- 上传成功后刷新文件列表；失败显示错误码和原因。
- 通知铃铛展示 `waiting_input`、`pending`、`running`、完成、失败和取消状态。
- 导出下载通知和文件页下载行为不回归。

## 后续清理支持

本功能不实现清理任务，也不在成功或失败时主动删除 Storage 对象。File 与 Job 保持关联，后续清理任务可以按以下条件组合处理：

- Job 类型与状态；
- File 状态；
- `createdAt` / `finishedAt` / `expiresAt`；
- Client、调用者或任务来源；
- 是否存在可重试的失败 Job。

这套信息同时覆盖导出下载和浏览器上传产生的文件占用。
