# Code Context

## Files Retrieved

1. `packages/shared/src/index.ts` (lines 3-16, 18-26, 49-114, 126-146) - 事件、Job 状态与全部线上 payload；`FileRef` 仅保留未实现。
2. `packages/server/prisma/schema.prisma` (lines 10-41) - Client capability 与 Job 持久化模型。
3. `packages/server/src/job/job.service.ts` (lines 20-65, 67-132, 134-195) - 创建、输出累加、完成/取消、断线恢复、查询映射。
4. `packages/server/src/job/job.scheduler.ts` (lines 5-44) - 每 client 并发上限与 FIFO dispatch。
5. `packages/server/src/events/events.gateway.ts` (lines 38-56, 75-104, 106-161) - WebSocket 生命周期、输出/完成事件和 dispatch。
6. `packages/server/src/events/events.controller.ts` (lines 24-74) - 当前 REST surface 仅接受 command job。
7. `packages/client/src/executor.ts` (lines 13-67, 69-119) - 唯一执行器是 `spawn(..., { shell: true })`，以及进程取消/内存态恢复报告。
8. `packages/client/src/index.ts` (lines 12-66) - 注册、状态报告、心跳以及 JOB_DISPATCH/CANCEL 路由。

## Key Code

### 当前 Job 的真实抽象

当前 Job 不是通用任务，也不是 typed operation；它是“面向指定 client、通过系统 shell 执行的一段字符串命令”的持久化队列项：

```ts
// packages/shared/src/index.ts:50-54
interface JobDispatch {
  jobId: string;
  command: string;
  timeout?: number;
}

// packages/client/src/executor.ts:21-25
const child = spawn(job.command, {
  shell: true,
  timeout: job.timeout,
});
```

数据库同样只表达 `command/status/exitCode/output/timeout`，没有 `type`、结构化输入、结构化结果、文件元数据或 blob 引用（`packages/server/prisma/schema.prisma:28-40`）。状态机可复用于异步文件操作，但 payload/result 语义不可直接复用。

### 实际执行流

1. `POST /api/jobs` 接收 `{clientId, command, timeout}`（`events.controller.ts:24-42`；`shared/index.ts:85-89`）。
2. `JobService.create` 要求 client 已存在且在线，插入 pending Job，然后调用 scheduler（`job.service.ts:20-55`）。因此当前不能为离线 client 预排任务。
3. scheduler 按 client 统计 running（最多 3），取最早 pending，先写 running，再返回 command dispatch（`job.scheduler.ts:13-38`）。
4. gateway 向 client room 发 `job:dispatch`（`events.gateway.ts:147-156`）。
5. client 固定路由到 `executeJob`，交给平台 shell（`client/index.ts:44-47`；`client/executor.ts:21-25`）。
6. stdout/stderr 都作为 UTF-8-ish 文本 chunk 上报并拼入同一个 DB `output` 字符串（`executor.ts:33-45`；`events.gateway.ts:106-117`；`job.service.ts:58-65`）。
7. close 只返回 exitCode；服务端据此判定 done/error，并 dispatch 下一项（`executor.ts:47-65`；`job.service.ts:67-80`）。
8. 取消仅针对 child process；断线时 server 标记 disconnected，client 重连只报告进程内 `activeJobs`（`executor.ts:69-119`；`job.service.ts:90-132`）。client 进程重启后无恢复信息。

## 文件操作逐项兼容性

| 操作 | 复用 command job | typed job | 独立 file protocol | 结论 |
|---|---|---|---|---|
| `list` | 技术上可调用 `ls/dir`，但输出依赖 OS/locale、无稳定字段、路径 shell 注入风险 | 很适合：结构化 `{path}` → entries | 非必需 | **command 仅原型可用；正式能力应 typed** |
| `read`（小文本） | 可 `cat/type`，但编码、错误与 stdout 混合且无大小界限 | 适合，返回结构化文本/编码/metadata，并设大小上限 | 大文件需要 | **小文本 typed；大/二进制走数据协议** |
| `write`（小文本） | 需 shell quoting/重定向/base64，跨平台脆弱，内容可能进入 command 与日志 | 适合，使用 Node `fs`，显式 encoding、overwrite/atomic 语义 | 大内容需要 | **小文本 typed；大内容引用上传对象** |
| `upload`（server/user → client） | 可让 client 执行 curl/PowerShell，但依赖外部工具、URL quoting 与凭据暴露 | Job 可承载控制面 `{destination, fileRef}` | **必需的数据面**：预签名 GET/流式传输、校验和 | **不应把字节塞 command/output；FileRef 方向上已有 GET 形状但未接线** |
| `download`（client → server/user） | 可 base64 到 stdout，但内存/DB/Socket 文本膨胀且无背压 | Job 可承载 `{source, fileRef}` 与进度/结果 | **必需的数据面**：client PUT/流式传输、校验和 | **FileRef 的 PUT 形状可作为起点，但当前完全未实现** |
| `delete` | `rm/del` 可做但高危 quoting、平台差异、缺少 root 边界 | 很适合；结构化 path、recursive/force，client 端校验 | 非必需 | **typed，且必须做允许根目录/路径规范化/能力校验** |
| `move` | `mv/move` 可做但覆盖、跨卷、平台语义不一致 | 很适合；`source/destination/overwrite` | 跨 client 移动需 download+upload 数据面 | **同 client typed；跨 client 编排两个传输任务** |

## 具体发现与严重度

- **高：协议和存储被 `command: string` 锁死。** `JobCreate`、`JobDispatch`、`DispatchPayload`、`JobInfo` 均只有 command（`packages/shared/src/index.ts:49-102,126-137`），Prisma Job 也要求 command（`packages/server/prisma/schema.prisma:28-40`），controller/service/scheduler/gateway 全链路透传它（`events.controller.ts:24-42`; `job.service.ts:20-55`; `job.scheduler.ts:13-38`; `events.gateway.ts:147-152`）。增加文件操作若不扩展协议，只能拼 shell。
- **高：二进制与大文件没有可用通道。** `JobOutput.text` 是字符串（`shared/index.ts:56-59`），client 对 Buffer 直接 `toString()`（`client/executor.ts:33-45`），server 把 chunk 读改写追加到单个 SQLite String（`job.service.ts:58-65`）。会破坏任意二进制；大文件产生内存、Socket、DB 膨胀，且并发 chunk 存在丢更新风险。
- **高：command 方案扩大命令注入与跨平台风险。** 任意路径/内容最终进入 `spawn(command, {shell:true})`（`client/executor.ts:21-25`）。文件名含引号、通配符、换行或 shell 元字符时既可能失败也可能执行额外命令；Windows/POSIX 命令不一致。
- **高：当前事件处理未校验上报者和 job 归属。** stdout/stderr/done handler 仅按 payload `jobId` 更新（`events.gateway.ts:107-127`），未使用 `ConnectedSocket` 验证 clientId/job.clientId；持有 PSK 的任意 client 理论上可污染或结束别的 Job。文件写删和传输若沿用该信任模型，影响更严重。
- **中：结果模型只有混合文本 output + exitCode。** stdout/stderr 在 DB 合并（`events.gateway.ts:107-116`; `job.service.ts:58-64`），无法稳定表达目录 entries、stat、校验和、传输字节数、目标路径或领域错误码。
- **中：调度并发有竞态。** `count`、`findFirst`、`update` 非事务原子声明（`job.scheduler.ts:13-33`）；并发 create/finish 可能重复选中 pending 或越过上限。文件写/move/delete 更需要同路径冲突策略，但现模型只有“每 client 最多 3”。
- **中：运行恢复只覆盖仍存活的 child process。** activeJobs 是进程内 Map（`client/executor.ts:19,27-31,108-119`）；client 重启后，server 的 disconnected Job 无法得知真实文件操作是否已提交。write/move/delete 必须定义幂等性、operationId 或可核验终态。
- **中：`FileRef` 是孤立保留类型。** 仅定义 `id/url/method/expiresAt/headers`（`shared/index.ts:139-146`），没有事件、REST、Job 字段、存储或 client 消费者；它证明了数据面方向，但不代表已有功能。
- **中：能力声明未参与 dispatch。** client 有 `capabilities`（`shared/index.ts:29-38`; Prisma `schema.prisma:18`），但 Job create/dispatch 不检查需要的 capability（`job.service.ts:20-55`）。typed file job 需要版本/能力门控。
- **低：创建时强制 online。** `job.service.ts:25-34` 阻止离线排队；对长传输/稍后同步是否合理需产品决定，但不是实现文件管理的硬阻塞。

## Architecture

三种方案不应三选一地完全替代：

- **保留现有 command job**：继续服务远程命令，不把文件路径/内容拼进 command。它可作为开发期探针，不应成为正式文件 API。
- **最小扩展为 typed job（控制面）**：复用现有 Job 的 ID、client 归属、pending/running/done/error/cancel/disconnect、调度和 UI 更新概念。增加 discriminant（如 `type: "command" | "file.list" | ...`）及结构化 request/result；client 根据 type 分派到 shell executor 或 Node `fs` handler。
- **独立 file protocol（数据面）**：仅 upload/download 以及大 read/write 使用。Job 负责授权后的 file reference、目标路径、状态、取消、校验结果；实际 bytes 通过预签名 GET/PUT 或专门流式通道，不进入 stdout/output。现有 `FileRef` 可演进复用，但目前没有实现。

因此建议是“typed Job 控制面 + 独立字节数据面”，不是把所有文件操作都做成另一套脱离 Job 生命周期的协议。

## 最小演进建议

1. **先定义 shared discriminated union，保持 command 向后兼容。** 给 create/dispatch 增加 `type` 和结构化 `payload`；command 可视为 `type: "command"`。文件首批只做 metadata operations：`file.list/readText/writeText/delete/move`。不要先建通用 workflow/factory。
2. **Prisma 最少增加 `type`、`payload`、`result`（SQLite 可用 JSON 字符串），让 `command` 可空或保留兼容。** 状态机与 scheduler 先复用；输出流只属于 command，typed result 单独落库并限制尺寸。
3. **client 增加单个 typed dispatcher，文件 handler 直接用 Node `fs/promises`。** 在 trust boundary 校验 union、路径规范化、允许根目录、大小限制、overwrite/recursive 标志；不要生成 shell 命令。
4. **随后只为字节传输接通 `FileRef`。** upload job 让 client GET，download job 让 client PUT；传 checksum/size，凭据不记录到 Job output/日志，处理过期与重试。小文本 read/write 可暂不走该通道。
5. **在开放 destructive/transfer 操作前补安全关联。** gateway 必须将 socket 绑定的 client 与 Job.clientId 对照；创建/dispatch 检查 capability；稳定领域错误 `code`，避免只靠 exitCode。
6. **文件写/move 使用临时文件 + rename，并给传输/变更操作幂等标识或可核验结果。** 这比试图持久化恢复任意进程更小且更可靠。
7. **在文件并发确有需求时再升级调度。** 首版可保留每 client 上限，但至少原子 claim pending；同路径串行/锁仅在出现并发写需求时添加。

## Residual Risks / Open Questions

- 允许访问的根目录、符号链接是否可穿越根目录、Windows drive/UNC 支持范围尚无产品定义。
- read/write 的“小文本”尺寸上限、编码策略、是否允许覆盖/递归删除需明确。
- upload/download 的存储后端与 URL 签发者未出现于所读代码；`FileRef` 本身不足以判断最终认证模型。
- 跨 client move 实质是复制后删除，需定义失败补偿；不应伪装成单机原子 move。
- 本次是指定文件的静态只读分析，未运行测试，也未检查未指定文档是否已有未来协议约束。

## Start Here

先打开 `packages/shared/src/index.ts:49-146`：这里是 command-only 锁定发生的公共协议入口，也是以最小兼容 diff 引入 typed Job 与接通 `FileRef` 的第一处。随后沿 `job.scheduler.ts` → `events.gateway.ts` → `client/src/index.ts` → `executor.ts` 追踪分派。