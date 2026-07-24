# Typed Job 内核架构设计

> 状态：已确认 | 2026-07-24

## 目标

将当前"Job = Shell 命令"的模型重构为 Typed Job 内核，使 `exec`、`file.*`、`agent.run` 等不同远程操作共享统一的状态机、调度、审计和扩展机制，同时保障现有 `exec` 行为零回归。

## 非目标（本次不实现）

- file.* 和 agent.run 的具体 handler 实现
- Storage / FileRef 实现
- Agent Worker + Pi SDK 集成
- JobEvent / AgentRun / Artifact 持久化
- 断线事件 spool 与 sequence 补传
- Capability 校验的完整映射表（类型已定义，校验逻辑不实现）
- 路径安全策略

## 1. 类型系统（shared 协议层）

### 1.1 JobType 枚举

```ts
enum JobType {
  EXEC = "exec",
  FILE_LIST = "file.list",
  FILE_STAT = "file.stat",
  FILE_READ_TEXT = "file.readText",
  FILE_WRITE_TEXT = "file.writeText",
  FILE_MKDIR = "file.mkdir",
  FILE_DELETE = "file.delete",
  FILE_MOVE = "file.move",
  FILE_DOWNLOAD = "file.download",
  FILE_UPLOAD = "file.upload",
  AGENT_RUN = "agent.run",
}
```

### 1.2 Dispatch 协议

```ts
// Server → Client：判别联合
type JobDispatch =
  | { jobId: string; type: "exec"; command: string; timeout?: number }
  | { jobId: string; type: string; payload: Record<string, unknown>; timeout?: number };
```

`type: "exec"` 有完整字段定义。其余类型用 `Record<string, unknown>` 兜底，后续各自收窄。

### 1.3 结果协议

```ts
// Client → Server：最终结果
type JobDone =
  | { jobId: string; type: "exec"; exitCode: number }
  | { jobId: string; type: string; result: Record<string, unknown> };
```

### 1.4 流式输出

`job:stdout` / `job:stderr` 事件保持不变，所有类型共用——实时文本流不关心 type。

```ts
interface JobOutput {
  jobId: string;
  text: string;
}
```

### 1.5 错误模型

```ts
interface JobError {
  code: string;    // e.g. "PATH_NOT_FOUND", "PERMISSION_DENIED", "TIMEOUT"
  message: string;
}
```

### 1.6 服务端创建接口

```ts
interface JobCreate {
  clientId: string;
  type: string;              // JobType
  payload: Record<string, unknown>;
  timeout?: number;
}
```

---

## 2. 状态机

### 2.1 状态枚举

```ts
enum JobStatus {
  PENDING = "pending",
  RUNNING = "running",
  WAITING_INPUT = "waiting_input",
  DONE = "done",
  ERROR = "error",
  CANCELLED = "cancelled",
  DISCONNECTED = "disconnected",
}
```

### 2.2 合法流转

```text
pending → running
pending → cancelled

running → done
running → error
running → cancelled
running → disconnected
running → waiting_input

waiting_input → running
waiting_input → done
waiting_input → cancelled
waiting_input → disconnected

disconnected → running
disconnected → waiting_input
disconnected → done
disconnected → error
disconnected → cancelled
```

### 2.3 设计原则

- `waiting_input` 是通用状态设施，不做 type 限制。`exec` 和 `file.*` 的 handler 永远不会进入此状态；`agent.run`（interactive）和未来的交互式终端使用
- `waiting_input` 不计入 `maxConcurrentJobs`，只计入 `maxInteractiveSessions`
- `disconnected` 期间 Server 无法区分 Client 状态，重连后 Client 通过 `status:report` 回报实际状态

---

## 3. 数据库模型

删除 `command`、`exitCode`、`output`，替换为结构化列：

```prisma
model Job {
  id           String    @id
  clientId     String
  client       Client    @relation(fields: [clientId], references: [id])
  type         String    @default("exec")
  status       String    @default("pending")
  payload      String    @default("{}")       // JSON 文本
  result       String?                         // JSON 文本
  errorCode    String?
  errorMessage String?
  timeout      Int?
  createdAt    DateTime  @default(now())
  startedAt    DateTime?
  finishedAt   DateTime?
  updatedAt    DateTime  @updatedAt
}
```

`exec` Job 示例：`payload = '{"command":"ls -la"}'`，`result = '{"exitCode":0}'`。

---

## 4. Client 架构

### 4.1 Typed Dispatcher

```ts
// client/src/dispatcher.ts
function dispatch(job: JobDispatch, socket: Socket) {
  switch (job.type) {
    case "exec":
      return executeExec(job, socket);
    case "file.list":
    case "file.stat":
    case "file.readText":
    case "file.writeText":
    case "file.mkdir":
    case "file.delete":
    case "file.move":
    case "file.download":
    case "file.upload":
    case "agent.run":
      // ponytail: 扩展点在 switch，后续每个 type 收敛到独立 handler 文件
      throw new Error(`Job type "${job.type}" not yet implemented`);
    default:
      throw new Error(`Unknown job type: ${(job as any).type}`);
  }
}
```

### 4.2 能力声明

Client 注册时声明已实现的能力：

```ts
capabilities: ["exec"]  // 后续扩展 "file.read", "file.write", "agent.pi"
```

### 4.3 现有逻辑兼容

`executeExec()` 从原 `executor.ts` 搬入 dispatcher，逻辑零改动。`activeJobs` Map 和 `killJob` / `getRunningJobIds` / `getStatusReport` 保留，增加 `waiting_input` 状态支持（心跳上报时包含 `waiting_input` 的 jobId）。

---

## 5. Server 架构

### 5.1 JobService

```ts
// 旧签名
async create(clientId: string, command: string, timeout?: number)

// 新签名
async create(params: {
  clientId: string;
  type: JobType;
  payload: Record<string, unknown>;
  timeout?: number;
}): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }>
```

内部流程：校验 client 存在 & online → 校验 capability → 入库 → tryDispatch。

### 5.2 结果处理

```ts
// 收到 job:done 后
async markDone(
  jobId: string,
  type: JobType,
  result: Record<string, unknown>
): Promise<DispatchPayload | null> {
  const effectiveStatus =
    type === "exec" && (result as any).exitCode !== 0 ? "error" : "done";

  await this.prisma.job.update({
    where: { id: jobId },
    data: {
      status: effectiveStatus,
      result: JSON.stringify(result),
      finishedAt: new Date(),
    },
  });
  return this.scheduler.onFinished(clientId);
}
```

### 5.3 Scheduler

`tryDispatch` / `onFinished` 逻辑不变：FIFO + 每 Client 最多 3 并发。`waiting_input` 不计入并发数。

---

## 6. 扩展方式

新增 Job 类型只需三步——不需要新 Socket.IO 事件、不需要新数据库表：

```
1. shared：JobType 加枚举值，JobDispatch/JobDone 加成员
2. Client：dispatcher.ts 的 switch 加一个 case
3. Server：capability 映射表加一行
```

---

## 7. 事件兼容

Socket.IO 事件名保持不变。变化的是 payload 内容：

| 事件 | 旧 payload | 新 payload |
|---|---|---|
| `job:dispatch` | `{jobId, command, timeout}` | `{jobId, type, command?\|payload?, timeout}` |
| `job:done` | `{jobId, exitCode}` | `{jobId, type, exitCode?\|result?}` |
| `job:stdout` | `{jobId, text}` | 不变 |
| `job:stderr` | `{jobId, text}` | 不变 |
| `job:update` | `{jobId, status, exitCode?}` | `{jobId, type, status, result?}` |

---

## 8. 变更清单

| 文件 | 变更 |
|---|---|
| `packages/shared/src/index.ts` | 新增 JobType、JobStatus(+waiting_input)、JobDispatch(判别联合)、JobDone(判别联合)、JobError、JobCreate(type+payload) |
| `packages/server/prisma/schema.prisma` | Job 表：删除 command/exitCode/output，新增 type/payload/result/errorCode/errorMessage |
| `packages/server/src/job/job.service.ts` | create() 签名改为 typed；markDone() 接收 type+result；appendOutputRaw() 保留用于流式文本 |
| `packages/server/src/job/job.scheduler.ts` | 零改动（或仅解新字段） |
| `packages/server/src/events/events.gateway.ts` | `job:dispatch` 发送新格式 payload；`job:done` 处理新格式 |
| `packages/client/src/index.ts` | 事件监听改为调用 dispatcher.dispatch() |
| `packages/client/src/dispatcher.ts` | 新建，含 switch + executeExec |
| `packages/client/src/executor.ts` | executeExec 搬入 dispatcher，原文件删除或重新导出 |

---

## 9. 验收标准

- 现有 `exec` Job 创建、调度、执行、输出流、完成、取消、断线重连行为不变
- `file.list` 等未实现 type 的 Job 在 dispatch 时 Client 抛出 "not yet implemented"，Server 可正常入库和查询
- `waiting_input` 状态可正常入库、更新、查询和广播，不计入并发限制
- Prisma migrate 后旧 exec Job 可正常读写（新字段有默认值）
