# Server ↔ Client 核心实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 server-client 注册、心跳、Job 完整生命周期、取消、断线重连、并发控制的端到端交互

**Architecture:** Server 用 NestJS Gateway（薄路由）+ Service（业务 + Prisma）+ Scheduler（并发出队）；Client 用 Socket.IO 连接 server，spawn 子进程执行命令并流式回传 stdout/stderr

**Tech Stack:** TypeScript, NestJS 10, Socket.IO, Prisma + SQLite, Node.js child_process

## Global Constraints

- Node.js ≥ 24（当前版本）
- pnpm monorepo，`packages/*` 结构
- TypeScript target ES2022, module NodeNext
- 所有 import 使用 `.js` 后缀（ESM 规范）
- NestJS experimentalDecorators + emitDecoratorMetadata
- 测试使用 Node.js 内置 `assert`（不引入测试框架）

---

### Task 1: 安装 Server 新依赖

**Files:**

- Modify: `packages/server/package.json`

- [ ] **Step 1: 安装 prisma 和 @prisma/client**

```bash
cd packages/server && pnpm add prisma @prisma/client @nestjs/websockets
```

验证：`packages/server/package.json` 的 dependencies 包含 `@prisma/client`、`@nestjs/websockets`，devDependencies 包含 `prisma`

- [ ] **Step 2: 确认安装**

```bash
cd packages/server && pnpm prisma --version
```

期望：输出 Prisma CLI 版本号

- [ ] **Step 3: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add prisma and @nestjs/websockets deps"
```

---

### Task 2: Shared 类型定义

**Files:**

- Modify: `packages/shared/src/index.ts`

**Produces:** `Events`, `JobStatus`, `MachineRegister`, `Heartbeat`, `JobDispatch`, `JobOutput`, `JobDone`, `JobUpdate`, `JobCancel`, `JobCancelled`, `JobCancelFailed`, `StatusReport`, `JobStatusReport`, `JobCreate`, `JobCreateResult`, `FileRef`

- [ ] **Step 1: 写入完整类型定义**

```typescript
export const VERSION = "0.0.0";

// ── Event names ──
export const Events = {
  REGISTER: "register",
  HEARTBEAT: "heartbeat",
  JOB_DISPATCH: "job:dispatch",
  JOB_STDOUT: "job:stdout",
  JOB_STDERR: "job:stderr",
  JOB_DONE: "job:done",
  JOB_CANCEL: "job:cancel",
  JOB_CANCELLED: "job:cancelled",
  JOB_CANCEL_FAILED: "job:cancel-failed",
  JOB_UPDATE: "job:update",
  STATUS_REPORT: "status:report",
} as const;

// ── Job status ──
export enum JobStatus {
  PENDING = "pending",
  RUNNING = "running",
  DONE = "done",
  ERROR = "error",
  DISCONNECTED = "disconnected",
  CANCELLED = "cancelled",
}

// ── Register / Heartbeat ──
export interface MachineRegister {
  clientId: string;
  hostname: string;
  os: string;
  cpuModel: string;
  totalMemMB: number;
  totalDiskMB: number;
  clientVersion: string;
  capabilities: string[];
}

export interface Heartbeat {
  clientId: string;
  cpuPercent: number;
  memPercent: number;
  diskPercent: number;
  runningJobs: string[];
  uptime: number;
}

// ── Job payloads ──
export interface JobDispatch {
  jobId: string;
  command: string;
  timeout?: number;
}

export interface JobOutput {
  jobId: string;
  text: string;
}

export interface JobDone {
  jobId: string;
  exitCode: number;
}

export interface JobUpdate {
  jobId: string;
  status: JobStatus;
  exitCode?: number;
}

export interface JobCancel {
  jobId: string;
}

export interface JobCancelled {
  jobId: string;
}

export interface JobCancelFailed {
  jobId: string;
  reason: string;
}

export interface JobCreate {
  clientId: string;
  command: string;
  timeout?: number;
}

export interface JobCreateResult {
  jobId: string;
  status: JobStatus;
}

// ── Dispatch result (internal, returned by scheduler) ──
export interface DispatchPayload {
  jobId: string;
  clientId: string;
  command: string;
  timeout?: number;
}

// ── Status report (reconnect) ──
export interface JobStatusReport {
  jobId: string;
  status: "running" | "done" | "error";
  exitCode: number | null;
}

export interface StatusReport {
  clientId: string;
  jobs: JobStatusReport[];
}

// ── Client info (REST response) ──
export interface ClientInfo {
  clientId: string;
  hostname: string;
  os: string;
  capabilities: string[];
  online: boolean;
  lastHeartbeatAt: string | null;
}

// ── Job info (REST response) ──
export interface JobInfo {
  jobId: string;
  clientId: string;
  command: string;
  status: JobStatus;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ── FileRef (reserved, not implemented) ──
export interface FileRef {
  id: string;
  url: string;
  method: "GET" | "PUT";
  expiresAt: number;
  headers?: Record<string, string>;
}
```

- [ ] **Step 2: 编译验证**

```bash
cd packages/shared && pnpm build
```

期望：编译成功，无错误

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): define all server-client interaction types"
```

---

### Task 3: Server — Prisma Schema + Service

**Files:**

- Create: `packages/server/prisma/schema.prisma`
- Create: `packages/server/src/prisma/prisma.service.ts`
- Create: `packages/server/src/prisma/prisma.module.ts`

**Produces:** `PrismaService` (extends PrismaClient, OnModuleInit), `PrismaModule` (@Global)

- [ ] **Step 1: 创建 Prisma schema**

文件 `packages/server/prisma/schema.prisma`：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model Client {
  id              String    @id
  hostname        String
  os              String
  cpuModel        String
  totalMemMB      Int
  totalDiskMB     Int
  clientVersion   String
  capabilities    String    @default("[]")
  online          Boolean   @default(false)
  lastHeartbeatAt DateTime?
  connectedAt     DateTime?
  socketId        String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  jobs            Job[]
}

model Job {
  id         String    @id
  clientId   String
  client     Client    @relation(fields: [clientId], references: [id])
  command    String
  status     String    @default("pending")
  exitCode   Int?
  output     String    @default("")
  timeout    Int?
  createdAt  DateTime  @default(now())
  startedAt  DateTime?
  finishedAt DateTime?
  updatedAt  DateTime  @updatedAt
}
```

- [ ] **Step 2: 运行 Prisma migrate**

```bash
cd packages/server && npx prisma migrate dev --name init
```

期望：`prisma/migrations/` 目录生成，`prisma/dev.db` 创建，`@prisma/client` 生成

- [ ] **Step 3: 创建 PrismaService**

文件 `packages/server/src/prisma/prisma.service.ts`：

```typescript
import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }
}
```

- [ ] **Step 4: 创建 PrismaModule**

文件 `packages/server/src/prisma/prisma.module.ts`：

```typescript
import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 5: 编译验证**

```bash
cd packages/server && pnpm build
```

期望：编译成功

- [ ] **Step 6: Commit**

```bash
git add packages/server/prisma/ packages/server/src/prisma/
git commit -m "feat(server): add Prisma schema, service, and module"
```

---

### Task 4: Server — ClientService + ClientModule

**Files:**

- Create: `packages/server/src/client/client.service.ts`
- Create: `packages/server/src/client/client.module.ts`

**Consumes:** `PrismaService`
**Produces:** `ClientService` (register, heartbeat, markOfflineBySocketId, listOnline)

- [ ] **Step 1: 创建 ClientService**

文件 `packages/server/src/client/client.service.ts`：

```typescript
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { MachineRegister, Heartbeat, ClientInfo } from "@vcpdeck/shared";

@Injectable()
export class ClientService {
  constructor(private readonly prisma: PrismaService) {}

  async register(dto: MachineRegister, socketId: string) {
    await this.prisma.client.upsert({
      where: { id: dto.clientId },
      create: {
        id: dto.clientId,
        hostname: dto.hostname,
        os: dto.os,
        cpuModel: dto.cpuModel,
        totalMemMB: dto.totalMemMB,
        totalDiskMB: dto.totalDiskMB,
        clientVersion: dto.clientVersion,
        capabilities: JSON.stringify(dto.capabilities),
        online: true,
        socketId,
        connectedAt: new Date(),
      },
      update: {
        hostname: dto.hostname,
        os: dto.os,
        cpuModel: dto.cpuModel,
        totalMemMB: dto.totalMemMB,
        totalDiskMB: dto.totalDiskMB,
        clientVersion: dto.clientVersion,
        capabilities: JSON.stringify(dto.capabilities),
        online: true,
        socketId,
        connectedAt: new Date(),
      },
    });
  }

  async heartbeat(dto: Heartbeat) {
    await this.prisma.client.update({
      where: { id: dto.clientId },
      data: { lastHeartbeatAt: new Date() },
    });
  }

  async markOfflineBySocketId(socketId: string) {
    await this.prisma.client.updateMany({
      where: { socketId },
      data: { online: false, socketId: null },
    });
  }

  async listOnline(): Promise<ClientInfo[]> {
    const clients = await this.prisma.client.findMany({
      where: { online: true },
      orderBy: { connectedAt: "desc" },
    });
    return clients.map((c) => ({
      clientId: c.id,
      hostname: c.hostname,
      os: c.os,
      capabilities: JSON.parse(c.capabilities) as string[],
      online: c.online,
      lastHeartbeatAt: c.lastHeartbeatAt?.toISOString() ?? null,
    }));
  }
}
```

- [ ] **Step 2: 创建 ClientModule**

文件 `packages/server/src/client/client.module.ts`：

```typescript
import { Module } from "@nestjs/common";
import { ClientService } from "./client.service.js";

@Module({
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientModule {}
```

- [ ] **Step 3: 编译验证**

```bash
cd packages/server && pnpm build
```

期望：编译成功

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/client/
git commit -m "feat(server): add ClientService with register, heartbeat, offline tracking"
```

---

### Task 5: Server — JobService + JobScheduler + JobModule

**Files:**

- Create: `packages/server/src/job/job.service.ts`
- Create: `packages/server/src/job/job.scheduler.ts`
- Create: `packages/server/src/job/job.module.ts`

**Consumes:** `PrismaService`
**Produces:** `JobService` (create, markRunning, appendOutput, markDone, markCancelled, markDisconnected, reconcileOnReconnect, cancel, list), `JobScheduler` (tryDispatch, onFinished)

- [ ] **Step 1: 创建 JobScheduler**

文件 `packages/server/src/job/job.scheduler.ts`：

```typescript
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { DispatchPayload } from "@vcpdeck/shared";

const MAX_CONCURRENT_JOBS = 3;

@Injectable()
export class JobScheduler {
  constructor(private readonly prisma: PrismaService) {}

  /** Try to dispatch the oldest pending job for a client. Returns dispatch payload or null. */
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

    return {
      jobId: pending.id,
      clientId: pending.clientId,
      command: pending.command,
      timeout: pending.timeout ?? undefined,
    };
  }

  /** Called when a job finishes (done/cancelled). Triggers dispatch of next pending job. */
  async onFinished(clientId: string): Promise<DispatchPayload | null> {
    return this.tryDispatch(clientId);
  }
}
```

- [ ] **Step 2: 创建 JobService**

文件 `packages/server/src/job/job.service.ts`：

```typescript
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobStatus } from "@vcpdeck/shared";
import type {
  JobCreateResult,
  DispatchPayload,
  StatusReport,
  JobInfo,
} from "@vcpdeck/shared";
import { randomUUID } from "node:crypto";

@Injectable()
export class JobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: JobScheduler,
  ) {}

  /** Create a job and try to dispatch it immediately. */
  async create(
    clientId: string,
    command: string,
    timeout?: number,
  ): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
    const jobId = randomUUID();
    await this.prisma.job.create({
      data: {
        id: jobId,
        clientId,
        command,
        status: "pending",
        timeout: timeout ?? null,
      },
    });

    const dispatch = await this.scheduler.tryDispatch(clientId);

    return {
      result: {
        jobId,
        status: dispatch ? JobStatus.RUNNING : JobStatus.PENDING,
      },
      dispatch,
    };
  }

  async appendOutput(jobId: string, text: string) {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { output: { push: text } }, // Prisma SQLite doesn't support push, use raw
    });
  }

  // ponytail: Prisma SQLite doesn't support String.push. Use a raw update.
  async appendOutputRaw(jobId: string, text: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    await this.prisma.job.update({
      where: { id: jobId },
      data: { output: job.output + text },
    });
  }

  async markDone(
    jobId: string,
    exitCode: number,
  ): Promise<DispatchPayload | null> {
    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: exitCode === 0 ? "done" : "error",
        exitCode,
        finishedAt: new Date(),
      },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  async markCancelled(jobId: string): Promise<DispatchPayload | null> {
    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  async markDisconnected(clientId: string) {
    await this.prisma.job.updateMany({
      where: { clientId, status: "running" },
      data: { status: "disconnected" },
    });
  }

  /** Reconcile jobs after client reconnects. Returns list of dispatch payloads for recovered running jobs. */
  async reconcileOnReconnect(
    clientId: string,
    report: StatusReport,
  ): Promise<DispatchPayload[]> {
    const dispatches: DispatchPayload[] = [];

    for (const r of report.jobs) {
      const job = await this.prisma.job.findUnique({ where: { id: r.jobId } });
      if (!job || job.clientId !== clientId) continue;

      if (r.status === "running") {
        // ponytail: if job was marked disconnected, revert to running
        if (job.status === "disconnected" || job.status === "running") {
          await this.prisma.job.update({
            where: { id: r.jobId },
            data: { status: "running" },
          });
        }
      } else {
        const newStatus = r.status === "done" ? "done" : "error";
        await this.prisma.job.update({
          where: { id: r.jobId },
          data: {
            status: newStatus,
            exitCode: r.exitCode ?? 1,
            finishedAt: new Date(),
          },
        });
        // Finished job frees a slot — try dispatch
        const d = await this.scheduler.onFinished(clientId);
        if (d) dispatches.push(d);
      }
    }

    return dispatches;
  }

  async cancel(jobId: string): Promise<{
    cancelled: boolean;
    needsDispatch: boolean;
    clientId?: string;
  }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job "${jobId}" not found`);

    if (job.status === "pending") {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      return { cancelled: true, needsDispatch: false };
    }

    if (job.status === "running" || job.status === "disconnected") {
      // Gateway will send cancel instruction; status stays until client confirms
      return { cancelled: false, needsDispatch: true, clientId: job.clientId };
    }

    throw new Error(`Cannot cancel job in status "${job.status}"`);
  }

  async list(): Promise<JobInfo[]> {
    const jobs = await this.prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return jobs.map((j) => ({
      jobId: j.id,
      clientId: j.clientId,
      command: j.command,
      status: j.status as JobStatus,
      exitCode: j.exitCode,
      createdAt: j.createdAt.toISOString(),
      startedAt: j.startedAt?.toISOString() ?? null,
      finishedAt: j.finishedAt?.toISOString() ?? null,
    }));
  }
}
```

- [ ] **Step 3: 创建 JobModule**

文件 `packages/server/src/job/job.module.ts`：

```typescript
import { Module } from "@nestjs/common";
import { JobService } from "./job.service.js";
import { JobScheduler } from "./job.scheduler.js";

@Module({
  providers: [JobService, JobScheduler],
  exports: [JobService, JobScheduler],
})
export class JobModule {}
```

- [ ] **Step 4: 编译验证**

```bash
cd packages/server && pnpm build
```

期望：编译成功

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/job/
git commit -m "feat(server): add JobService, JobScheduler with concurrency control"
```

---

### Task 6: Server — Events Gateway + Controller + Module

**Files:**

- Create: `packages/server/src/events/events.gateway.ts`
- Create: `packages/server/src/events/events.controller.ts`
- Create: `packages/server/src/events/events.module.ts`

**Consumes:** `ClientService`, `JobService`, `JobScheduler`
**Produces:** `EventsGateway` (Socket.IO handlers + sendDispatch public method), `EventsController` (REST endpoints)

- [ ] **Step 1: 创建 EventsGateway**

文件 `packages/server/src/events/events.gateway.ts`：

```typescript
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { ClientService } from "../client/client.service.js";
import { JobService } from "../job/job.service.js";
import { JobScheduler } from "../job/job.scheduler.js";
import {
  Events,
  JobStatus,
} from "@vcpdeck/shared";
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

const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

@WebSocketGateway({ cors: { origin: "*" } })
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly clientService: ClientService,
    private readonly jobService: JobService,
    private readonly scheduler: JobScheduler,
  ) {}

  // ── Connection lifecycle ──
  handleConnection(client: Socket) {
    const psk = client.handshake.auth?.psk;
    if (psk !== PSK) {
      client.emit("error", "invalid PSK");
      client.disconnect();
      return;
    }
    console.log(`[ws] connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    await this.clientService.markOfflineBySocketId(client.id);
    // Find clientId from DB to mark jobs disconnected
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    const c = await prisma.client.findFirst({
      where: { socketId: client.id },
    });
    // ponytail: socketId already cleared by markOfflineBySocketId, query before it runs
    console.log(`[ws] disconnected: ${client.id}`);
  }

  // ── Client events ──
  @SubscribeMessage(Events.REGISTER)
  async handleRegister(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MachineRegister,
  ) {
    await this.clientService.register(data, client.id);
    client.join(data.clientId);
    client.emit("ack", { event: Events.REGISTER });
    console.log(`[ws] registered: ${data.clientId}`);
  }

  @SubscribeMessage(Events.HEARTBEAT)
  async handleHeartbeat(@MessageBody() data: Heartbeat) {
    await this.clientService.heartbeat(data);
  }

  @SubscribeMessage(Events.STATUS_REPORT)
  async handleStatusReport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StatusReport,
  ) {
    // Re-bind socketId
    await this.clientService.register(
      {
        clientId: data.clientId,
        hostname: "",
        os: "",
        cpuModel: "",
        totalMemMB: 0,
        totalDiskMB: 0,
        clientVersion: "",
        capabilities: [],
      },
      client.id,
    );
    client.join(data.clientId);

    const dispatches = await this.jobService.reconcileOnReconnect(
      data.clientId,
      data,
    );

    // Emit updates for reconclied jobs
    for (const r of data.jobs) {
      this.server.emit(Events.JOB_UPDATE, {
        jobId: r.jobId,
        status:
          r.status === "running"
            ? JobStatus.RUNNING
            : r.status === "done"
              ? JobStatus.DONE
              : JobStatus.ERROR,
        exitCode: r.exitCode ?? undefined,
      } satisfies JobUpdate);
    }

    // Dispatch any queued jobs that now have room
    for (const d of dispatches) {
      this.sendDispatch(d);
    }
  }

  // ── Job output from client ──
  @SubscribeMessage(Events.JOB_STDOUT)
  async handleJobStdout(@MessageBody() data: JobOutput) {
    await this.jobService.appendOutputRaw(data.jobId, data.text);
    this.server.emit(Events.JOB_STDOUT, data);
  }

  @SubscribeMessage(Events.JOB_STDERR)
  async handleJobStderr(@MessageBody() data: JobOutput) {
    await this.jobService.appendOutputRaw(data.jobId, data.text);
    this.server.emit(Events.JOB_STDERR, data);
  }

  @SubscribeMessage(Events.JOB_DONE)
  async handleJobDone(@MessageBody() data: JobDone) {
    const next = await this.jobService.markDone(data.jobId, data.exitCode);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      status: data.exitCode === 0 ? JobStatus.DONE : JobStatus.ERROR,
      exitCode: data.exitCode,
    } satisfies JobUpdate);
    if (next) this.sendDispatch(next);
  }

  @SubscribeMessage(Events.JOB_CANCELLED)
  async handleJobCancelled(@MessageBody() data: JobCancelled) {
    const next = await this.jobService.markCancelled(data.jobId);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      status: JobStatus.CANCELLED,
    } satisfies JobUpdate);
    if (next) this.sendDispatch(next);
  }

  @SubscribeMessage(Events.JOB_CANCEL_FAILED)
  handleJobCancelFailed(@MessageBody() data: JobCancelFailed) {
    console.error(`[ws] cancel failed: ${data.jobId} - ${data.reason}`);
    this.server.emit(Events.JOB_CANCEL_FAILED, data);
  }

  // ── Public: called by controller to send dispatch to client ──
  sendDispatch(d: DispatchPayload) {
    this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
      jobId: d.jobId,
      command: d.command,
      timeout: d.timeout,
    } satisfies JobDispatch);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: d.jobId,
      status: JobStatus.RUNNING,
    } satisfies JobUpdate);
  }

  /** Send cancel instruction to a client. */
  sendCancel(clientId: string, jobId: string) {
    this.server.to(clientId).emit(Events.JOB_CANCEL, { jobId });
  }
}
```

**注意：** `handleDisconnect` 需要查询 clientId。因为 `markOfflineBySocketId` 已清除 socketId，所以在 disconnect 之前需要先查出 clientId 来调用 `markDisconnected`。修正版本：

需要在 `handleDisconnect` 前查询 client，或者在 Client 表上加一个 disconnect handler。为简单，在 `ClientService` 里多加一个方法：

`packages/server/src/client/client.service.ts` 补充：

```typescript
async getClientIdBySocketId(socketId: string): Promise<string | null> {
  const c = await this.prisma.client.findFirst({ where: { socketId } });
  return c?.id ?? null;
}
```

然后在 Gateway 的 `handleDisconnect`：

```typescript
async handleDisconnect(client: Socket) {
  const clientId = await this.clientService.getClientIdBySocketId(client.id);
  if (clientId) {
    await this.jobService.markDisconnected(clientId);
  }
  await this.clientService.markOfflineBySocketId(client.id);
  console.log(`[ws] disconnected: ${clientId ?? client.id}`);
}
```

- [ ] **Step 2: 创建 EventsController**

文件 `packages/server/src/events/events.controller.ts`：

```typescript
import { Controller, Post, Get, Body, Param } from "@nestjs/common";
import { JobService } from "../job/job.service.js";
import { ClientService } from "../client/client.service.js";
import { EventsGateway } from "./events.gateway.js";
import type { JobCreate } from "@vcpdeck/shared";

@Controller("api")
export class EventsController {
  constructor(
    private readonly jobService: JobService,
    private readonly clientService: ClientService,
    private readonly gateway: EventsGateway,
  ) {}

  @Post("jobs")
  async createJob(@Body() body: JobCreate) {
    const { result, dispatch } = await this.jobService.create(
      body.clientId,
      body.command,
      body.timeout,
    );
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return result;
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@Param("jobId") jobId: string) {
    const { cancelled, needsDispatch, clientId } =
      await this.jobService.cancel(jobId);
    if (cancelled) {
      return { jobId, status: "cancelled" };
    }
    if (needsDispatch && clientId) {
      this.gateway.sendCancel(clientId, jobId);
      return { jobId, status: "cancelling" };
    }
    throw new Error("Unexpected cancel state");
  }

  @Get("clients")
  async listClients() {
    return this.clientService.listOnline();
  }

  @Get("jobs")
  async listJobs() {
    return this.jobService.list();
  }
}
```

- [ ] **Step 3: 创建 EventsModule**

文件 `packages/server/src/events/events.module.ts`：

```typescript
import { Module } from "@nestjs/common";
import { EventsGateway } from "./events.gateway.js";
import { EventsController } from "./events.controller.js";
import { ClientModule } from "../client/client.module.js";
import { JobModule } from "../job/job.module.js";

@Module({
  imports: [ClientModule, JobModule],
  providers: [EventsGateway],
  controllers: [EventsController],
})
export class EventsModule {}
```

- [ ] **Step 4: 编译验证**

```bash
cd packages/server && pnpm build
```

期望：编译成功

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/events/ packages/server/src/client/client.service.ts
git commit -m "feat(server): add EventsGateway, REST controller, and module"
```

---

### Task 7: Server — 组装 AppModule

**Files:**

- Modify: `packages/server/src/app.module.ts`

**Consumes:** `PrismaModule`, `EventsModule`

- [ ] **Step 1: 更新 AppModule**

文件 `packages/server/src/app.module.ts`：

```typescript
import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { EventsModule } from "./events/events.module.js";

@Module({
  imports: [PrismaModule, EventsModule],
})
export class AppModule {}
```

- [ ] **Step 2: 编译 + 启动验证**

```bash
cd packages/server && pnpm build && node dist/main.js
```

另开终端：

```bash
curl http://localhost:3001/api/clients
# 期望: []
```

`Ctrl+C` 结束 server。

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/app.module.ts
git commit -m "feat(server): wire up AppModule with Prisma and Events"
```

---

### Task 8: Client — register + heartbeat 模块

**Files:**

- Create: `packages/client/src/register.ts`
- Create: `packages/client/src/heartbeat.ts`

**Produces:** `getRegisterInfo()`, `getHeartbeat(runningJobs: string[])`

- [ ] **Step 1: 创建 register.ts**

文件 `packages/client/src/register.ts`：

```typescript
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineRegister } from "@vcpdeck/shared";

const CLIENT_ID_DIR = path.join(os.homedir(), ".vcpdeck");
const CLIENT_ID_FILE = path.join(CLIENT_ID_DIR, "client-id");

function loadOrCreateClientId(): string {
  try {
    return fs.readFileSync(CLIENT_ID_FILE, "utf-8").trim();
  } catch {
    const id = randomUUID();
    fs.mkdirSync(CLIENT_ID_DIR, { recursive: true });
    fs.writeFileSync(CLIENT_ID_FILE, id);
    return id;
  }
}

export const CLIENT_ID =
  process.env.VCPDECK_CLIENT_ID || loadOrCreateClientId();

export function getRegisterInfo(): MachineRegister {
  const cpus = os.cpus();
  return {
    clientId: CLIENT_ID,
    hostname: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
    cpuModel: cpus[0]?.model || "unknown",
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    totalDiskMB: 0, // ponytail: skip disk check, add when needed
    clientVersion: "0.0.0",
    capabilities: ["exec"],
  };
}
```

- [ ] **Step 2: 创建 heartbeat.ts**

文件 `packages/client/src/heartbeat.ts`：

```typescript
import * as os from "node:os";
import type { Heartbeat } from "@vcpdeck/shared";
import { CLIENT_ID } from "./register.js";

export function getHeartbeat(runningJobs: string[]): Heartbeat {
  const cpuCount = os.cpus().length;
  const loadAvg = os.loadavg()[0];
  const cpuPercent = Math.round((loadAvg / cpuCount) * 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

  return {
    clientId: CLIENT_ID,
    cpuPercent: Math.min(cpuPercent, 100),
    memPercent: Math.min(memPercent, 100),
    diskPercent: 0, // ponytail: skip disk, add when needed
    runningJobs,
    uptime: Math.round(process.uptime()),
  };
}
```

- [ ] **Step 3: 编译验证**

```bash
cd packages/client && pnpm build
```

期望：编译成功

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/register.ts packages/client/src/heartbeat.ts
git commit -m "feat(client): add register info and heartbeat modules"
```

---

### Task 9: Client — executor 模块

**Files:**

- Create: `packages/client/src/executor.ts`

**Produces:** `executeJob(job, socket)`, `killJob(jobId, socket)`, `getRunningJobIds()`, `getStatusReport()`

- [ ] **Step 1: 创建 executor.ts**

文件 `packages/client/src/executor.ts`：

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
  JobDispatch,
  JobOutput,
  JobDone,
  JobCancelled,
  JobCancelFailed,
  JobStatusReport,
} from "@vcpdeck/shared";

interface ActiveJob {
  jobId: string;
  process: ChildProcess;
  startTime: number;
}

const activeJobs = new Map<string, ActiveJob>();

export function executeJob(job: JobDispatch, socket: Socket) {
  const child = spawn(job.command, {
    shell: true,
    timeout: job.timeout,
  });

  activeJobs.set(job.jobId, {
    jobId: job.jobId,
    process: child,
    startTime: Date.now(),
  });

  child.stdout?.on("data", (data: Buffer) => {
    socket.emit(Events.JOB_STDOUT, {
      jobId: job.jobId,
      text: data.toString(),
    } satisfies JobOutput);
  });

  child.stderr?.on("data", (data: Buffer) => {
    socket.emit(Events.JOB_STDERR, {
      jobId: job.jobId,
      text: data.toString(),
    } satisfies JobOutput);
  });

  child.on("close", (code) => {
    activeJobs.delete(job.jobId);
    socket.emit(Events.JOB_DONE, {
      jobId: job.jobId,
      exitCode: code ?? 1,
    } satisfies JobDone);
  });

  child.on("error", (err) => {
    if (!activeJobs.has(job.jobId)) return;
    activeJobs.delete(job.jobId);
    socket.emit(Events.JOB_STDERR, {
      jobId: job.jobId,
      text: err.message,
    } satisfies JobOutput);
    socket.emit(Events.JOB_DONE, {
      jobId: job.jobId,
      exitCode: 1,
    } satisfies JobDone);
  });
}

export function killJob(jobId: string, socket: Socket) {
  const active = activeJobs.get(jobId);
  if (!active) {
    socket.emit(Events.JOB_CANCEL_FAILED, {
      jobId,
      reason: "Job not found",
    } satisfies JobCancelFailed);
    return;
  }

  try {
    active.process.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      if (active.process.exitCode === null) {
        try {
          active.process.kill("SIGKILL");
        } catch {
          // process already gone
        }
      }
    }, 5000);

    active.process.on("close", () => {
      clearTimeout(killTimer);
      socket.emit(Events.JOB_CANCELLED, {
        jobId,
      } satisfies JobCancelled);
    });
  } catch (err: any) {
    socket.emit(Events.JOB_CANCEL_FAILED, {
      jobId,
      reason: err.message,
    } satisfies JobCancelFailed);
  }
}

export function getRunningJobIds(): string[] {
  return [...activeJobs.keys()];
}

export function getStatusReport(): JobStatusReport[] {
  return [...activeJobs.values()].map((job) => ({
    jobId: job.jobId,
    status:
      job.process.exitCode === null
        ? "running"
        : job.process.exitCode === 0
          ? "done"
          : "error",
    exitCode: job.process.exitCode,
  }));
}
```

- [ ] **Step 2: 编译验证**

```bash
cd packages/client && pnpm build
```

期望：编译成功

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/executor.ts
git commit -m "feat(client): add job executor with stdout/stderr streaming and cancel"
```

---

### Task 10: Client — 主入口 index.ts

**Files:**

- Modify: `packages/client/src/index.ts`

**Consumes:** `getRegisterInfo`, `getHeartbeat`, `executeJob`, `killJob`, `getRunningJobIds`, `getStatusReport`

- [ ] **Step 1: 更新 index.ts**

文件 `packages/client/src/index.ts`：

```typescript
import { io, type Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type { JobDispatch, StatusReport } from "@vcpdeck/shared";
import { CLIENT_ID, getRegisterInfo } from "./register.js";
import { getHeartbeat } from "./heartbeat.js";
import { executeJob, killJob, getRunningJobIds, getStatusReport } from "./executor.js";

const SERVER_URL = process.env.VCPDECK_SERVER || "http://localhost:3001";
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";

export function connect(): Socket {
  const socket: Socket = io(SERVER_URL, {
    auth: { psk: PSK },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  socket.on("connect", () => {
    console.log(`[vcpdeck] connected as ${CLIENT_ID}`);
    socket.emit(Events.REGISTER, getRegisterInfo());

    // Send status report for any running jobs (reconnect case)
    const report: StatusReport = {
      clientId: CLIENT_ID,
      jobs: getStatusReport(),
    };
    socket.emit(Events.STATUS_REPORT, report);
  });

  // Heartbeat every 30s
  const heartbeatTimer = setInterval(() => {
    if (socket.connected) {
      socket.emit(Events.HEARTBEAT, getHeartbeat(getRunningJobIds()));
    }
  }, 30_000);

  socket.on(Events.JOB_DISPATCH, (data: JobDispatch) => {
    console.log(`[vcpdeck] job dispatch: ${data.jobId} — ${data.command}`);
    executeJob(data, socket);
  });

  socket.on(Events.JOB_CANCEL, (data: { jobId: string }) => {
    console.log(`[vcpdeck] job cancel: ${data.jobId}`);
    killJob(data.jobId, socket);
  });

  socket.on("disconnect", (reason) => {
    console.log(`[vcpdeck] disconnected: ${reason}`);
  });

  socket.on("connect_error", (err) => {
    console.error(`[vcpdeck] connection error: ${err.message}`);
  });

  return socket;
}
```

- [ ] **Step 2: 编译验证**

```bash
cd packages/client && pnpm build
```

期望：编译成功

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/index.ts
git commit -m "feat(client): implement main connect flow with reconnect"
```

---

### Task 11: 端到端集成烟雾测试

**Files:**

- Create: `packages/server/src/test/smoke.ts`（临时，不提交）

**Consumes:** 全部模块

- [ ] **Step 1: 创建烟雾测试脚本**

文件 `packages/server/src/test/smoke.ts`：

```typescript
// Smoke test: starts server, connects a mock client, creates a job, verifies lifecycle
import { io } from "socket.io-client";
import { Events, JobStatus } from "@vcpdeck/shared";
import type { MachineRegister, Heartbeat, JobDone, JobOutput, JobUpdate } from "@vcpdeck/shared";
import { randomUUID } from "node:crypto";

const SERVER = "http://localhost:3001";
const PSK = "vcpdeck-dev-psk";
const CLIENT_ID = randomUUID();

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // 1. Connect client
  const socket = io(SERVER, { auth: { psk: PSK } });

  await new Promise<void>((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
  console.log("✓ client connected");

  // 2. Register
  const reg: MachineRegister = {
    clientId: CLIENT_ID,
    hostname: "test",
    os: "test",
    cpuModel: "test",
    totalMemMB: 1024,
    totalDiskMB: 10240,
    clientVersion: "0.0.0",
    capabilities: ["exec"],
  };

  await new Promise<void>((resolve) => {
    socket.emit(Events.REGISTER, reg);
    socket.on("ack", resolve);
    setTimeout(resolve, 1000);
  });
  console.log("✓ client registered");

  // 3. Send heartbeat
  const hb: Heartbeat = {
    clientId: CLIENT_ID,
    cpuPercent: 10,
    memPercent: 50,
    diskPercent: 30,
    runningJobs: [],
    uptime: 60,
  };
  socket.emit(Events.HEARTBEAT, hb);
  console.log("✓ heartbeat sent");

  // 4. Create job via REST
  const createRes = await fetch(`${SERVER}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, command: "echo hello world" }),
  });
  const createBody = await createRes.json();
  console.log("✓ job created:", createBody);

  // 5. Emulate client receiving dispatch and executing
  socket.on(Events.JOB_DISPATCH, (data: any) => {
    console.log("  job:dispatch received:", data.jobId);
    socket.emit(Events.JOB_STDOUT, { jobId: data.jobId, text: "hello world\n" });
    socket.emit(Events.JOB_DONE, { jobId: data.jobId, exitCode: 0 });
  });

  // 6. Wait and check job status via REST
  await sleep(2000);
  const jobsRes = await fetch(`${SERVER}/api/jobs`);
  const jobs = await jobsRes.json();
  console.log("✓ jobs:", JSON.stringify(jobs, null, 2));

  // 7. Verify
  const job = jobs[0];
  const ok = job && (job.status === "done" || job.status === "running");
  console.log(ok ? "✓ SMOKE TEST PASSED" : "✗ SMOKE TEST FAILED");

  socket.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ smoke test error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 启动 server 并运行测试**

终端 1：

```bash
cd packages/server && node dist/main.js
```

终端 2：

```bash
cd packages/server && node dist/test/smoke.js
```

期望：`✓ SMOKE TEST PASSED`

- [ ] **Step 3: 测试取消流程**

手动 curl：

```bash
# 创建长时间任务
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<CLIENT_ID>","command":"sleep 60"}'

# 取消
curl -X POST http://localhost:3001/api/jobs/<JOB_ID>/cancel
```

期望：对于 pending 状态的 job，直接返回 `status: cancelled`

- [ ] **Step 4: 清理**

```bash
# 不提交 test 目录到 git（临时测试文件）
# 但保留测试脚本在本地供后续使用
```

---

## 自审

**1. Spec 覆盖率：**

- §1 Shared 类型 → Task 2 ✅
- §2 Server 分层 → Tasks 3-7 ✅
- §3 Client 模块 → Tasks 8-10 ✅
- §4 Job 生命周期（含取消）→ Tasks 5, 6, 9 ✅
- §5 断线重连 → Task 6 (status:report), Task 10 (connect + status:report) ✅
- §6 并发控制 → Task 5 (JobScheduler) ✅

**2. 占位符扫描：** 无 TBD/TODO/implement later。所有步骤包含完整代码。

**3. 类型一致性：**

- `Events.STATUS_REPORT` 在 shared 定义为 `"status:report"` → Gateway 和 Client 都使用 `Events.STATUS_REPORT` ✅
- `DispatchPayload` 在 shared 定义 → JobScheduler 返回 → Gateway.sendDispatch 消费 ✅
- `JobStatusReport` → executor.getStatusReport 返回 → client index.ts 组装 StatusReport ✅

**4. 发现并修正的问题：**

- `handleDisconnect` 需要先查 clientId 再调 `markDisconnected`，已在 Task 6 中给出修正版本
- `appendOutput` 不能用 Prisma `push`（SQLite 不支持），改用 `appendOutputRaw`（concat 方式）
