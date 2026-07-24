# Typed Job 内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Job 模型从"命令字符串"重构为 Typed Job 内核，`exec` 退化为一种类型，预留 `file.*` 和 `agent.run` 扩展点，现有 exec 行为零回归。

**Architecture:** 单一 `job:dispatch` 事件承载判别联合 payload → Client typed dispatcher 按 `type` 分发 → Server 统一调度/审计。共享类型在 `@vcpdeck/shared`，Server 和 Client 各自引用。

**Tech Stack:** TypeScript strict, NestJS, Prisma + SQLite, Socket.IO, Node.js child_process

## Global Constraints

- `exec` Job 行为与当前完全一致（创建、调度、stdout/stderr 流、exitCode、取消、断线重连）
- 不实现任何 `file.*` 或 `agent.run` handler
- 不新增依赖
- Prisma migration 须可回滚

---

### Task 1: 更新共享类型定义

**Files:**

- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Produces: `JobType` enum, `JobStatus` (扩展 WAITING_INPUT), `JobDispatch` (判别联合), `JobDone` (判别联合), `JobError`, `JobCreate` (type+payload), `JobInfo` (type+payload+result), `DispatchPayload` (type+payload)

- [ ] **Step 1: 添加 JobType 枚举**

在 Events 常量下方插入：

```ts
// ── Job type ──
export enum JobType {
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

- [ ] **Step 2: 扩展 JobStatus 枚举**

在现有 JobStatus 枚举中添加 `WAITING_INPUT`：

```ts
export enum JobStatus {
  PENDING = "pending",
  RUNNING = "running",
  WAITING_INPUT = "waiting_input",
  DONE = "done",
  ERROR = "error",
  DISCONNECTED = "disconnected",
  CANCELLED = "cancelled",
}
```

- [ ] **Step 3: 更新 DispatchPayload**

替换现有的 `DispatchPayload` 和 `JobDispatch`：

```ts
// ── Dispatch（调度器内部产出 / 发往 Client） ──
export interface DispatchPayload {
  jobId: string;
  clientId: string;
  type: string;
  payload: Record<string, unknown>;
  timeout?: number;
}
```

- [ ] **Step 4: 更新 JobDispatch（发送给 Client 的格式）**

```ts
// ── Job dispatch（Server → Client，判别联合） ──
export type JobDispatch =
  | {
      jobId: string;
      type: "exec";
      command: string;
      timeout?: number;
    }
  | {
      jobId: string;
      type: string;
      payload: Record<string, unknown>;
      timeout?: number;
    };
```

- [ ] **Step 5: 更新 JobCreate**

```ts
export interface JobCreate {
  clientId: string;
  type: string;
  payload: Record<string, unknown>;
  timeout?: number;
}
```

- [ ] **Step 6: 更新 JobCreateResult**

```ts
export interface JobCreateResult {
  jobId: string;
  status: JobStatus;
  type: string;
}
```

- [ ] **Step 7: 更新 JobDone（Client → Server，判别联合）**

```ts
// ── Job done（Client → Server） ──
export type JobDone =
  | { jobId: string; type: "exec"; exitCode: number }
  | { jobId: string; type: string; result: Record<string, unknown> };
```

- [ ] **Step 8: 添加 JobError**

```ts
// ── Job error ──
export interface JobError {
  code: string;
  message: string;
}
```

- [ ] **Step 9: 更新 JobInfo**

```ts
export interface JobInfo {
  jobId: string;
  clientId: string;
  type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
```

- [ ] **Step 10: 更新 JobUpdate**

```ts
export interface JobUpdate {
  jobId: string;
  type: string;
  status: JobStatus;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}
```

- [ ] **Step 11: 更新 JobStatusReport（支持 waiting_input）**

```ts
export interface JobStatusReport {
  jobId: string;
  status: "running" | "waiting_input" | "done" | "error";
  exitCode: number | null;
}
```

- [ ] **Step 12: 清理旧类型引用**

更新以下接口以适配新模型（删除 command/output/exitCode，替换为 type/payload/result）：

- `JobInfo` — 已在 Step 9 更新
- `JobCreate` — 已在 Step 5 更新
- `JobUpdate` — 已在 Step 10 更新

保留不动的接口：`JobOutput`、`JobCancel`、`JobCancelled`、`JobCancelFailed`、`StatusReport`、`ClientInfo`、`MachineRegister`、`Heartbeat`、`FileRef`、`Events`。

- [ ] **Step 13: 构建验证 shared 包编译**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/shared build
```

Expected: 无类型错误，编译通过。

- [ ] **Step 14: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): Typed Job 类型系统 — JobType, JobStatus+waiting_input, 判别联合 Dispatch/Done"
```

---

### Task 2: 更新 Prisma Schema + 迁移

**Files:**

- Modify: `packages/server/prisma/schema.prisma`
- Create: `packages/server/prisma/migrations/*` (Prisma 自动生成)

**Interfaces:**

- Produces: `Job` 模型含 `type`、`payload`、`result`、`errorCode`、`errorMessage`，删除 `command`、`exitCode`、`output`

- [ ] **Step 1: 修改 Job 模型**

替换 `packages/server/prisma/schema.prisma` 中的 Job 模型：

```prisma
model Job {
  id           String    @id
  clientId     String
  client       Client    @relation(fields: [clientId], references: [id])
  type         String    @default("exec")
  status       String    @default("pending")
  payload      String    @default("{}")
  result       String?
  errorCode    String?
  errorMessage String?
  timeout      Int?
  createdAt    DateTime  @default(now())
  startedAt    DateTime?
  finishedAt   DateTime?
  updatedAt    DateTime  @updatedAt
}
```

- [ ] **Step 2: 生成 Prisma 迁移**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server exec prisma migrate dev --name typed_job_kernel
```

Expected: 迁移文件生成，SQLite 数据库 schema 更新。SQLite 中旧列 `command`/`exitCode`/`output` 被删除，新列添加。

> 注意：Prisma 对 SQLite 的 `ALTER TABLE DROP COLUMN` 支持有限。如果 Prisma 报错需要 `PRAGMA foreign_keys=OFF` 重建表，按提示操作——这是 Prisma + SQLite 的正常行为。

- [ ] **Step 3: 重新生成 Prisma Client**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server exec prisma generate
```

Expected: Prisma Client 重新生成，包含新的 Job 字段类型。

- [ ] **Step 4: Commit**

```bash
git add packages/server/prisma/
git commit -m "feat(server): Prisma Job 模型重构 — 结构化的 type/payload/result 替代 command/output"
```

---

### Task 3: 更新 Server JobService

**Files:**

- Modify: `packages/server/src/job/job.service.ts`

**Interfaces:**

- Consumes: `JobType`、`JobStatus`、`JobCreate`、`DispatchPayload`、`JobInfo` from `@vcpdeck/shared`; Prisma Client (更新后的 Job 模型)
- Produces: `create()` 新签名，`markDone()` 接收 type+result，`toJobInfo()` 映射新字段

- [ ] **Step 1: 更新导入**

在 `job.service.ts` 顶部调整导入，添加 `JobType`：

```ts
import { JobStatus } from "@vcpdeck/shared";
import type {
  JobCreateResult,
  DispatchPayload,
  StatusReport,
  JobInfo,
} from "@vcpdeck/shared";
```

- [ ] **Step 2: 重写 create() 方法**

```ts
async create(params: {
  clientId: string;
  type: string;
  payload: Record<string, unknown>;
  timeout?: number;
}): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
  const client = await this.prisma.client.findUnique({
    where: { id: params.clientId },
  });
  if (!client) {
    throw new Error(`Client "${params.clientId}" not found — register the client first`);
  }
  if (!client.online) {
    throw new Error(`Client "${params.clientId}" is offline`);
  }

  const jobId = randomUUID();
  await this.prisma.job.create({
    data: {
      id: jobId,
      clientId: params.clientId,
      type: params.type,
      status: "pending",
      payload: JSON.stringify(params.payload),
      timeout: params.timeout ?? null,
    },
  });

  const dispatch = await this.scheduler.tryDispatch(params.clientId);

  return {
    result: {
      jobId,
      status: dispatch ? JobStatus.RUNNING : JobStatus.PENDING,
      type: params.type,
    },
    dispatch,
  };
}
```

- [ ] **Step 3: 重写 markDone() 方法**

```ts
async markDone(
  jobId: string,
  type: string,
  result: Record<string, unknown>,
): Promise<DispatchPayload | null> {
  const effectiveStatus =
    type === "exec" && (result as any).exitCode !== 0 ? "error" : "done";

  const job = await this.prisma.job.update({
    where: { id: jobId },
    data: {
      status: effectiveStatus,
      result: JSON.stringify(result),
      finishedAt: new Date(),
    },
  });
  return this.scheduler.onFinished(job.clientId);
}
```

- [ ] **Step 4: 更新 appendOutputRaw() — 保留但调整存储策略**

当前 `appendOutputRaw` 将文本拼入 `output` 字段。该字段已删除，改为仅转发不做持久化（或后续引入独立的 output spool）：

```ts
async appendOutputRaw(jobId: string, _text: string) {
  // ponytail: stdout/stderr 暂不持久化，仅实时转发。后续加 output spool 时在此实现。
  const job = await this.prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  // 流式文本不再追加到数据库字段
}
```

- [ ] **Step 5: 更新 markCancelled() — 无改动**

逻辑不变，只依赖 status 字段。

- [ ] **Step 6: 更新 reconcileOnReconnect()**

调整 `StatusReport` 处理逻辑以支持 `waiting_input` 状态：

```ts
async reconcileOnReconnect(
  clientId: string,
  report: StatusReport,
): Promise<DispatchPayload[]> {
  const dispatches: DispatchPayload[] = [];

  for (const r of report.jobs) {
    const job = await this.prisma.job.findUnique({
      where: { id: r.jobId },
    });
    if (!job || job.clientId !== clientId) continue;

    if (r.status === "running" || r.status === "waiting_input") {
      if (
        job.status === "disconnected" ||
        job.status === "running" ||
        job.status === "waiting_input"
      ) {
        await this.prisma.job.update({
          where: { id: r.jobId },
          data: { status: r.status },
        });
      }
    } else {
      const newStatus = r.status === "done" ? "done" : "error";
      await this.prisma.job.update({
        where: { id: r.jobId },
        data: {
          status: newStatus,
          result: JSON.stringify({ exitCode: r.exitCode ?? 1 }),
          finishedAt: new Date(),
        },
      });
      const d = await this.scheduler.onFinished(clientId);
      if (d) dispatches.push(d);
    }
  }

  return dispatches;
}
```

- [ ] **Step 7: 更新 cancel() 方法**

`cancel()` 增加对 `waiting_input` 状态的支持：

```ts
async cancel(jobId: string): Promise<{
  cancelled: boolean;
  needsDispatch: boolean;
  clientId?: string;
}> {
  const job = await this.prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job "${jobId}" not found`);

  if (job.status === "pending" || job.status === "waiting_input") {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return { cancelled: true, needsDispatch: false };
  }

  if (job.status === "running" || job.status === "disconnected") {
    return { cancelled: false, needsDispatch: true, clientId: job.clientId };
  }

  throw new Error(`Cannot cancel job in status "${job.status}"`);
}
```

- [ ] **Step 8: 更新 toJobInfo() 映射函数**

```ts
function toJobInfo(j: {
  id: string;
  clientId: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): JobInfo {
  return {
    jobId: j.id,
    clientId: j.clientId,
    type: j.type,
    status: j.status as JobStatus,
    payload: safeJsonParse(j.payload, {}),
    result: j.result ? safeJsonParse(j.result, null) : null,
    errorCode: j.errorCode,
    errorMessage: j.errorMessage,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 9: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

Expected: 无类型错误。

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/job/job.service.ts
git commit -m "feat(server): JobService 适配 Typed Job — create/markDone/reconcile/toJobInfo"
```

---

### Task 4: 更新 Server JobScheduler

**Files:**

- Modify: `packages/server/src/job/job.scheduler.ts`

**Interfaces:**

- Consumes: 更新后的 `DispatchPayload`; Prisma Job 模型（type/payload 字段）
- Produces: `tryDispatch()` 产出包含 type+payload 的 DispatchPayload

- [ ] **Step 1: 更新 tryDispatch()**

```ts
async tryDispatch(clientId: string): Promise<DispatchPayload | null> {
  const runningCount = await this.prisma.job.count({
    where: { clientId, status: "running" },
  });
  if (runningCount >= MAX_CONCURRENT_JOBS) return null;

  const pending = await this.prisma.job.findFirst({
    where: { clientId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) return null;

  await this.prisma.job.update({
    where: { id: pending.id },
    data: { status: "running", startedAt: new Date() },
  });

  const payload = safeJsonParse(pending.payload, {});

  return {
    jobId: pending.id,
    clientId: pending.clientId,
    type: pending.type,
    payload,
    timeout: pending.timeout ?? undefined,
  };
}
```

需要在文件顶部添加 `safeJsonParse`（或从 job.service.ts 导入）。

- [ ] **Step 2: onFinished() — 无改动**

逻辑不变。

- [ ] **Step 3: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/job/job.scheduler.ts
git commit -m "feat(server): JobScheduler 产出 typed DispatchPayload"
```

---

### Task 5: 更新 Server EventsGateway

**Files:**

- Modify: `packages/server/src/events/events.gateway.ts`

**Interfaces:**

- Consumes: 更新后的 `JobDone`、`JobDispatch`、`JobUpdate`、`StatusReport`、`DispatchPayload`
- Produces: `sendDispatch()` 发 typed payload; `handleJobDone()` 处理结构化结果

- [ ] **Step 1: 更新导入**

在导入中添加 `JobType`，移除旧 `JobOutput`（如果 as 类型导入不再需要则调整）：

```ts
import { Events, JobStatus, JobType } from "@vcpdeck/shared";
import type {
  MachineRegister,
  Heartbeat,
  JobOutput,
  JobDone,
  JobCancelled,
  JobCancelFailed,
  StatusReport,
  JobUpdate,
  JobDispatch,
  DispatchPayload,
} from "@vcpdeck/shared";
```

`JobOutput` 保留导入（stdout/stderr handler 仍使用）。

- [ ] **Step 2: 更新 sendDispatch()**

```ts
sendDispatch(d: DispatchPayload) {
  // 对 exec 类型，构造判别联合的 exec 分支（含 command 字段）
  if (d.type === "exec") {
    const execPayload = d.payload as { command: string };
    this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
      jobId: d.jobId,
      type: "exec" as const,
      command: execPayload.command,
      timeout: d.timeout,
    } satisfies JobDispatch);
  } else {
    this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
      jobId: d.jobId,
      type: d.type,
      payload: d.payload,
      timeout: d.timeout,
    } satisfies JobDispatch);
  }

  this.server.emit(Events.JOB_UPDATE, {
    jobId: d.jobId,
    type: d.type,
    status: JobStatus.RUNNING,
  } satisfies JobUpdate);
}
```

- [ ] **Step 3: 更新 handleStatusReport()**

处理 `waiting_input` 状态：

```ts
@SubscribeMessage(Events.STATUS_REPORT)
async handleStatusReport(
  @ConnectedSocket() client: Socket,
  @MessageBody() data: StatusReport,
) {
  await this.clientService.bindSocket(data.clientId, client.id);
  client.join(data.clientId);

  const dispatches = await this.jobService.reconcileOnReconnect(
    data.clientId,
    data,
  );

  for (const r of data.jobs) {
    const status = 
      r.status === "running" ? JobStatus.RUNNING :
      r.status === "waiting_input" ? JobStatus.WAITING_INPUT :
      r.status === "done" ? JobStatus.DONE :
      JobStatus.ERROR;
    
    const job = await this.jobService.findById(r.jobId);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: r.jobId,
      type: job?.type ?? "exec",
      status,
      result: r.exitCode != null ? { exitCode: r.exitCode } : undefined,
    } satisfies JobUpdate);
  }

  for (const d of dispatches) {
    this.sendDispatch(d);
  }
}
```

- [ ] **Step 4: 更新 handleJobDone()**

```ts
@SubscribeMessage(Events.JOB_DONE)
async handleJobDone(@MessageBody() data: JobDone) {
  let type: string;
  let result: Record<string, unknown>;

  if (data.type === "exec") {
    type = "exec";
    result = { exitCode: data.exitCode };
  } else {
    type = data.type;
    result = data.result;
  }

  const next = await this.jobService.markDone(data.jobId, type, result);

  const status =
    type === "exec" && (result as any).exitCode !== 0
      ? JobStatus.ERROR
      : JobStatus.DONE;

  this.server.emit(Events.JOB_UPDATE, {
    jobId: data.jobId,
    type,
    status,
    result,
  } satisfies JobUpdate);

  if (next) this.sendDispatch(next);
}
```

- [ ] **Step 5: 更新 handleJobCancelled()**

```ts
@SubscribeMessage(Events.JOB_CANCELLED)
async handleJobCancelled(@MessageBody() data: JobCancelled) {
  const next = await this.jobService.markCancelled(data.jobId);
  const job = await this.jobService.findById(data.jobId);
  this.server.emit(Events.JOB_UPDATE, {
    jobId: data.jobId,
    type: job?.type ?? "exec",
    status: JobStatus.CANCELLED,
  } satisfies JobUpdate);
  if (next) this.sendDispatch(next);
}
```

- [ ] **Step 6: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/events/events.gateway.ts
git commit -m "feat(server): EventsGateway 适配 Typed Job — sendDispatch/handleJobDone/handleStatusReport"
```

---

### Task 6: 更新 EventsController

**Files:**

- Modify: `packages/server/src/events/events.controller.ts`

**Interfaces:**

- Consumes: 更新后的 `JobCreate`; `JobService.create()` 新签名
- Produces: REST API 适配新调用方式

- [ ] **Step 1: 重写 createJob()**

```ts
@Post("jobs")
async createJob(@Body() body: JobCreate) {
  let result: { jobId: string; status: string; type: string } | null = null;
  let dispatch: DispatchPayload | null = null;
  try {
    const r = await this.jobService.create({
      clientId: body.clientId,
      type: body.type || "exec",
      payload: body.payload || {},
      timeout: body.timeout,
    });
    result = r.result;
    dispatch = r.dispatch;
  } catch (e: any) {
    throw new BadRequestException(e.message);
  }
  if (dispatch) {
    this.gateway.sendDispatch(dispatch);
  }
  return result;
}
```

- [ ] **Step 2: 添加 DispatchPayload 导入**

```ts
import type { JobCreate, DispatchPayload } from "@vcpdeck/shared";
```

- [ ] **Step 3: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/events/events.controller.ts
git commit -m "feat(server): EventsController 适配 typed JobCreate"
```

---

### Task 7: 创建 Client Typed Dispatcher

**Files:**

- Create: `packages/client/src/dispatcher.ts`
- Modify: `packages/client/src/executor.ts` — 重构 executeExec 为可导出的独立函数

**Interfaces:**

- Consumes: `JobDispatch`、`JobDone` from `@vcpdeck/shared`; `Socket` from `socket.io-client`
- Produces: `dispatch(job, socket)` — 入口函数; `executeExec(job, socket)` — 从 executor.ts 搬移

- [ ] **Step 1: 将 executor.ts 中的 executeJob 改为导出并拆分**

`executor.ts` 中 `executeJob` 函数当前只处理 exec。将其重命名为 `executeExec`、保持导出，从 `dispatcher.ts` 调用。`activeJobs` Map 和 `killJob`/`getRunningJobIds`/`getStatusReport` 保留在 `executor.ts`。

在 `executor.ts` 中，`executeJob` 改名为 `executeExec`，签名不变：

```ts
export function executeExec(job: { jobId: string; command: string; timeout?: number }, socket: Socket) {
  // 保持不变，原 executeJob 的全部逻辑
}
```

同时更新 `executor.ts` 底部对 `executeExec` 的引用。

- [ ] **Step 2: 创建 dispatcher.ts**

```ts
import type { Socket } from "socket.io-client";
import type { JobDispatch } from "@vcpdeck/shared";
import { executeExec } from "./executor.js";

export function dispatch(job: JobDispatch, socket: Socket) {
  switch (job.type) {
    case "exec":
      return executeExec(
        { jobId: job.jobId, command: job.command, timeout: job.timeout },
        socket,
      );
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

- [ ] **Step 3: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/client build
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/dispatcher.ts packages/client/src/executor.ts
git commit -m "feat(client): typed dispatcher — exec 路径 + 预留 switch 扩展点"
```

---

### Task 8: 更新 Client 入口使用 Dispatcher

**Files:**

- Modify: `packages/client/src/index.ts`

**Interfaces:**

- Consumes: `dispatch` from `dispatcher.ts`; 更新后的 `JobDispatch`、`JobDone`
- Produces: 事件监听改为调用 `dispatch()`

- [ ] **Step 1: 更新导入**

```ts
import { dispatch } from "./dispatcher.js";
import {
  executeExec, // 不再直接从 index.ts 导入，由 dispatcher 内部导入
  killJob,
  getRunningJobIds,
  getStatusReport,
} from "./executor.js";
```

- [ ] **Step 2: 更新 JOB_DISPATCH 事件处理器**

```ts
socket.on(Events.JOB_DISPATCH, (data: JobDispatch) => {
  console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.type}`);
  dispatch(data, socket);
});
```

- [ ] **Step 3: 更新 JOB_DONE 事件发送**

在 `executor.ts` 的 `executeExec` 中，当前发送的是旧格式 `{ jobId, exitCode }`。更新为判别联合格式：

```ts
// 在 executeExec 的 child.on("close") 中
socket.emit(Events.JOB_DONE, {
  jobId: job.jobId,
  type: "exec" as const,
  exitCode: code ?? 1,
} satisfies JobDone);
```

同样更新 `child.on("error")` 中的 JOB_DONE 发送。

- [ ] **Step 4: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/client build
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/index.ts packages/client/src/executor.ts
git commit -m "feat(client): index.ts 适配 typed dispatch + 判别联合 job:done 格式"
```

---

### Task 9: 全量构建 + 手动冒烟测试

**Files:**

- 无代码改动

- [ ] **Step 1: 全量构建**

```bash
cd D:/VCPHub/VCPDeck && pnpm build
```

Expected: 三个包全部编译通过。

- [ ] **Step 2: 启动 Server**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server dev
```

Expected: Server 在 3001 端口启动，无启动错误。

- [ ] **Step 3: 启动 Client**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/client dev
```

Expected: Client 连接 Server，注册成功，开始心跳。

- [ ] **Step 4: 创建 exec Job 并验证完整流程**

```bash
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<YOUR_CLIENT_ID>","type":"exec","payload":{"command":"echo hello typed job"}}'
```

Expected: 返回 `{jobId, status:"done", type:"exec"}`。Server 日志显示 stdout "hello typed job"。

- [ ] **Step 5: 验证取消**

```bash
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<YOUR_CLIENT_ID>","type":"exec","payload":{"command":"sleep 30"}}'

curl -X POST http://localhost:3001/api/jobs/<JOB_ID>/cancel
```

Expected: 第二个请求返回 `{jobId, status:"cancelling"}`，随后 `job:update` 广播 `cancelled`。

- [ ] **Step 6: 验证断线重连**

- 启动一个长时间 Job（如 `sleep 120`）
- 关闭 Client 进程
- 重新启动 Client
- Expected: Server 日志显示重连核对完成，Job 恢复 `running` 或 `done/error`

- [ ] **Step 7: 验证查询**

```bash
curl http://localhost:3001/api/jobs/<JOB_ID>
```

Expected: 返回含 `type`、`payload`、`result`、`status` 字段的 JSON。

- [ ] **Step 8: Commit（如有测试配置调整）**

```bash
git add -A
git commit -m "chore: 全量构建通过，手动冒烟测试完成"
```
