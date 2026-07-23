# Server ↔ Client 交互模型 — 核心实现设计

> 状态：设计中 | 2026-07-23
> 基于：`docs/server-client-interaction-design.md`（已确认的交互模型）

## 范围

实现设计文档的第 1-6 节：

- ✅ 注册 + 心跳（§3）
- ✅ Job 完整生命周期（§4）：dispatch → stdout/stderr → done/error
- ✅ 取消执行（§4）：SIGTERM → SIGKILL，三态确认
- ✅ 断线重连 + status:report（§5）
- ✅ 并发控制（§6）：maxConcurrentJobs，server 调度出队
- ❌ 存储 / 文件操作 FileRef（§7）—— 接口预留，本次不实现
- ❌ FRP 隧道（§8）—— 本次不实现

---

## 1. Shared 类型定义 (`packages/shared/src/index.ts`)

### 事件常量

```ts
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
  JOB_CREATE: "job:create",
  STATUS_REPORT: "status:report",
} as const;
```

### JobStatus 枚举

`pending | running | done | error | disconnected | cancelled`

### 核心接口

| 接口 | 方向 | 用途 |
|---|---|---|
| `MachineRegister` | C → S | 注册时发送的静态信息（clientId, hostname, os, cpu, mem, disk, version, capabilities） |
| `Heartbeat` | C → S | 30s 心跳 + cpu/mem/disk 百分比 + runningJobs + uptime |
| `JobDispatch` | S → C | { jobId, command, timeout? } |
| `JobOutput` | C → S | { jobId, text } — stdout/stderr 复用 |
| `JobDone` | C → S | { jobId, exitCode } |
| `JobUpdate` | S → FE | { jobId, status, exitCode? } — 状态变更广播 |
| `JobCancel` | S → C | { jobId } |
| `JobCancelled` | C → S | { jobId } — 取消成功确认 |
| `JobCancelFailed` | C → S | { jobId, reason } — 取消失败 |
| `StatusReport` | C → S | 重连时上报所有 job 状态 |
| `JobCreate` | FE → S | REST body: { clientId, command, timeout? } |
| `JobCreateResult` | S → FE | { jobId, status } |
| `FileRef` | — | 预留接口，本次不实现 |

---

## 2. Server 架构 (`packages/server/src/`)

### 分层

```
events/
  events.module.ts        # 注册 Gateway + Controller
  events.gateway.ts       # Socket.IO 事件入口（薄层，只做路由 + 广播）
  events.controller.ts   # REST API（薄层，参数校验 + 调 Service）

client/
  client.module.ts
  client.service.ts       # 注册/心跳/在线状态 — 业务 + Prisma

job/
  job.module.ts
  job.service.ts          # Job CRUD + 状态流转 + 取消 — 业务 + Prisma
  job.scheduler.ts        # 并发调度 + 出队逻辑
```

**原则**：Gateway 和 Controller 只做参数提取和事件路由，业务逻辑在 Service 层，Service 通过 Prisma 读写 SQLite。

### 数据模型（Prisma）

```prisma
model Client {
  id              String   @id                    // clientId
  hostname        String
  os              String
  cpuModel        String
  totalMemMB      Int
  totalDiskMB     Int
  clientVersion   String
  capabilities    String   @default("[]")         // JSON array
  online          Boolean  @default(false)
  lastHeartbeatAt DateTime?
  connectedAt     DateTime?
  socketId        String?                          // 当前 WebSocket socket.id
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  jobs            Job[]
}

model Job {
  id         String    @id                        // jobId
  clientId   String
  client     Client    @relation(fields: [clientId], references: [id])
  command    String
  status     String    @default("pending")        // JobStatus
  exitCode   Int?
  output     String    @default("")               // stdout + stderr 累积
  timeout    Int?
  createdAt  DateTime  @default(now())
  startedAt  DateTime?
  finishedAt DateTime?
  updatedAt  DateTime  @updatedAt
}
```

### ClientService

| 方法 | 触发 | 操作 |
|---|---|---|
| `register(dto)` | `register` 事件 | upsert client，设 online=true, socketId, connectedAt |
| `heartbeat(dto)` | `heartbeat` 事件 | 更新 lastHeartbeatAt |
| `markOfflineBySocketId(socketId)` | `disconnect` | 按 socketId 找到 client → online=false, socketId=null |
| `listOnline()` | REST GET | 查 online=true |

### JobService

| 方法 | 触发 | 操作 |
|---|---|---|
| `create(clientId, command, timeout?)` | POST /api/jobs | INSERT status=pending → 调 scheduler.tryDispatch |
| `dispatch(jobId)` | scheduler 出队时 | status=running, startedAt=now, Gateway 下发 |
| `appendOutput(jobId, text)` | stdout/stderr | 追加 output 字段 |
| `markDone(jobId, exitCode)` | job:done | status=done/error, exitCode, finishedAt → scheduler.onFinished |
| `markCancelled(jobId)` | job:cancelled | status=cancelled → scheduler.onFinished |
| `markCancelFailed(jobId, reason)` | job:cancel-failed | 记录日志，状态不变 |
| `markDisconnected(clientId)` | disconnect | running → disconnected |
| `reconcileOnReconnect(clientId, report)` | status:report | 逐一更新 job 状态，running 的恢复 activeCount |
| `cancel(jobId)` | POST cancel | pending → 直接 cancelled；running → Gateway 下发 cancel 指令 |
| `list()` | REST GET | 全量查询 |

### JobScheduler

- 每个 client 维护 maxConcurrentJobs（默认 3）
- `tryDispatch(clientId)`：`COUNT(status=running)` < max ? 取 status=pending ORDER BY createdAt ASC LIMIT 1 → `jobService.dispatch()`
- `onFinished(clientId)`：job done/cancelled 后调用，触发 tryDispatch

### 状态机

```
POST /api/jobs
  → pending → (scheduler 有空位) → dispatch → running
                                              ↓
                              done | error | cancelled | disconnected
disconnected + reconnect (status:report)
  → running | done | error

pending + cancel → cancelled（直接改 DB）
running + cancel → Gateway 下发 job:cancel → cancelled | cancel-failed
```

### Gateway

所有 Socket.IO 事件处理，注入 ClientService + JobService：

- `connection`：PSK 校验
- `register`：`clientService.register()` + 绑定 socketId
- `heartbeat`：`clientService.heartbeat()`
- `disconnect`：`clientService.markOfflineBySocketId()` + `jobService.markDisconnected()`
- `status:report`：`jobService.reconcileOnReconnect()` → scheduler.tryDispatch
- `job:stdout/stderr`：`jobService.appendOutput()` + broadcast 给 frontend
- `job:done`：`jobService.markDone()` → scheduler.onFinished
- `job:cancelled`：`jobService.markCancelled()` → scheduler.onFinished
- `job:cancel-failed`：`jobService.markCancelFailed()` + broadcast

### REST Controller

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/jobs` | body: JobCreate → jobService.create() |
| `POST` | `/api/jobs/:jobId/cancel` | jobService.cancel() |
| `GET` | `/api/clients` | clientService.listOnline() |
| `GET` | `/api/jobs` | jobService.list() |

---

## 3. Client 实现 (`packages/client/src/`)

### 模块

```
client/src/
  index.ts        # connect() 主入口
  register.ts     # getRegisterInfo() — 收集机器信息
  heartbeat.ts    # getHeartbeat() — 收集动态指标
  executor.ts     # executeJob() / killJob() — 子进程管理
```

### register.ts

- `clientId`：首次运行生成 UUID，写入 `~/.vcpdeck/client-id`，后续从文件读
- 收集：hostname, os, cpuModel, totalMemMB, totalDiskMB, clientVersion, capabilities

### heartbeat.ts

- cpuPercent：`os.loadavg()[0] * 100 / cpuCount`
- memPercent：`(1 - freemem / totalmem) * 100`
- diskPercent：检查根分区（可选，失败返回 0）
- runningJobs：从 executor 的 activeJobs Map 取 key 列表
- uptime：`process.uptime()`

### executor.ts

- `executeJob(job, socket)`：`spawn(command, { shell: true })`；stdout/stderr data 事件 → emit；close → emit job:done；error → emit stderr + job:done exitCode=1
- `killJob(jobId, socket)`：SIGTERM → 5s 后 SIGKILL → 成功后 emit job:cancelled，失败 emit job:cancel-failed
- 维护 `activeJobs: Map<jobId, { process, startTime }>`

### index.ts — 主流程

```
io(SERVER_URL, { auth: { psk: PSK }, reconnection: true })
  ├─ connect → emit register + status:report
  ├─ 30s setInterval → emit heartbeat
  ├─ job:dispatch → executeJob()
  ├─ job:cancel → killJob()
  └─ disconnect → 日志（Socket.IO 自动重连）
```

重连后的 `status:report` payload：

```ts
{
  clientId,
  jobs: [...activeJobs].map(([id, job]) => ({
    jobId: id,
    status: job.process.exitCode === null ? "running"
          : job.process.exitCode === 0 ? "done" : "error",
    exitCode: job.process.exitCode,
  }))
}
```

### 环境变量

| 变量 | 默认值 |
|---|---|
| `VCPDECK_SERVER` | `http://localhost:3001` |
| `VCPDECK_PSK` | `vcpdeck-dev-psk` |
| `VCPDECK_CLIENT_ID` | 从 `~/.vcpdeck/client-id` 读取 |

---

## 4. 数据流总览

```
REST POST /api/jobs
  → JobService.create (pending)
  → JobScheduler.tryDispatch (有空位？)
  → JobService.dispatch (running)
  → Gateway.emit("job:dispatch", clientId room)
  → Client.executeJob (spawn)
  → Client.emit("job:stdout" / "job:stderr" / "job:done")
  → Gateway broadcast to frontend
  → JobService.markDone + JobScheduler.onFinished
  → tryDispatch (检查队列)
```

---

## 5. 边界与外延

**本次不做**：

- Storage 抽象层 + FileRef 文件操作
- FRP 隧道管理
- Job 输出历史查询的分页/过滤
- PSK 轮换/分发机制
- client 命令白名单/沙箱

**接口已预留**：FileRef 类型已定义，tunnel 事件名已预留。

---

## 6. 疑问与决策

| 决策 | 结论 |
|---|---|
| DB | SQLite + Prisma，零运维 |
| 并发上限 | 默认 3，后续可配 |
| 取消语义 | 严格确认（client 证实 kill 成功/失败） |
| 重连输出 | 断线期间输出丢失，重连后只恢复最终状态 |
| 心跳指标 | cpu/mem 百分比 + runningJobs |
| clientId | 首次生成 UUID 持久化文件 |
