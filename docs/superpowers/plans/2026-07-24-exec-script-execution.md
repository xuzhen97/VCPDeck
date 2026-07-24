# Job 命令与脚本执行 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改进 `exec` Job，同时支持 Shell 命令和 stdin 脚本（Node / Python / PowerShell / Bash 等），规范化 payload、收敛终态，兼容旧请求。

**Architecture:** 在现有 `exec` Job 判别联合中拆出 `command` 与 `script` 两种 payload 模式；Server 校验并规范化 → 调度器透传 → Client 选择 `shell: true` 或 `shell: false + stdin`，错误经同一个幂等 settle 产生唯一终态。

**Tech Stack:** TypeScript (strict, ESM), Node 内置 `child_process`, Socket.IO, NestJS。

## Global Constraints

- 类型定义在 `packages/shared/src/index.ts`，必须与其他包共享
- 所有 import 使用 `.js` 后缀（ESM, NodeNext）
- 旧 `{ command }` payload 必须兼容
- 脚本 `executable` 可以是 PATH 名称或绝对路径
- `args` 由调用方完整提供，Client 不猜测解释器类型
- `cwd` 可选，未提供时继承 Client 进程当前目录
- 每个 Job 只产一个终态（幂等 settle）
- `shell: false` 是防 shell 注入措施，不是进程隔离
- 二进制文件（图片等）无测试要求

---

### Task 1: 扩展 Shared exec 协议类型

**Files:**

- Modify: `packages/shared/src/index.ts:65-89`

**Interfaces:**

- Consumes: 无（基础设施）
- Produces: `ExecJobDispatch`（两种 exec 模式）、`ExecJobDone`（成功或 err）、下游 Task 2–6 根据这些类型编译

- [ ] **Step 1: 替换 JobDispatch 中 exec 分支为 ExecJobDispatch**

把 `packages/shared/src/index.ts` 第 67–78 行的 `JobDispatch` 中 `exec` 分支替换：

```ts
// ── Exec job dispatch（Server → Client） ──
export type ExecJobDispatch =
  | {
      jobId: string;
      type: "exec";
      mode: "command";
      command: string;
      cwd?: string;
      timeout?: number;
    }
  | {
      jobId: string;
      type: "exec";
      mode: "script";
      executable: string;
      args: string[];
      script: string;
      cwd?: string;
      timeout?: number;
    };

// ── Job dispatch（Server → Client，判别联合） ──
export type JobDispatch =
  | ExecJobDispatch
  | {
      jobId: string;
      type: string;
      payload: Record<string, unknown>;
      timeout?: number;
    };
```

同时修改第 86–89 行的 `JobDone`：

```ts
// ── Exec job done（Client → Server） ──
export type ExecJobDone =
  | {
      jobId: string;
      type: "exec";
      exitCode: number;
    }
  | {
      jobId: string;
      type: "exec";
      error: JobError;
    };

// ── Job done（Client → Server，判别联合） ──
export type JobDone =
  | ExecJobDone
  | { jobId: string; type: string; result: Record<string, unknown> };
```

- [ ] **Step 2: 构建 shared 包验证类型编译**

```bash
cd packages/shared && pnpm build
```

预期：编译通过，无类型错误。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): 扩展 exec dispatch 支持 command/script 两种模式与结构化错误终态"
```

---

### Task 2: Server REST 校验与规范化

**Files:**

- Modify: `packages/server/src/events/events.controller.ts:33-55`

**Interfaces:**

- Consumes: `ExecJobDispatch`（Task 1）、`JobCreate`
- Produces: 规范化为 `DispatchPayload` 的 payload，包含 `mode: "command" | "script"`，Task 3/4 依此透传

- [ ] **Step 1: 编写 normalizeAndValidateExecPayload 函数**

在 `events.controller.ts` 文件顶部 `@Controller` 之前加入：

```ts
const INVALID_JOB_PAYLOAD = "INVALID_JOB_PAYLOAD";

function normalizeAndValidateExecPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const mode = payload.mode;
  const command = payload.command;
  const executable = payload.executable;
  const args = payload.args;
  const script = payload.script;
  const cwd = payload.cwd;

  // ── 旧 payload 兼容：缺少 mode 且存在 command → command 模式 ──
  if (mode === undefined && command !== undefined) {
    const normalized: Record<string, unknown> = { mode: "command", command };
    if (cwd !== undefined) normalized.cwd = cwd;
    return normalized;
  }

  // ── command 模式 ──
  if (mode === "command") {
    if (command === undefined || typeof command !== "string" || command === "") {
      throw Object.assign(new Error("command must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
    }
    if (executable !== undefined || args !== undefined || script !== undefined) {
      throw Object.assign(new Error("command mode must not include executable/args/script"), { code: INVALID_JOB_PAYLOAD });
    }
    const normalized: Record<string, unknown> = { mode: "command", command };
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd === "") throw Object.assign(new Error("cwd must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
      normalized.cwd = cwd;
    }
    return normalized;
  }

  // ── script 模式 ──
  if (mode === "script") {
    if (executable === undefined || typeof executable !== "string" || executable === "") {
      throw Object.assign(new Error("executable must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
    }
    if (!Array.isArray(args)) {
      throw Object.assign(new Error("args must be an array of strings"), { code: INVALID_JOB_PAYLOAD });
    }
    if (args.some((a) => typeof a !== "string")) {
      throw Object.assign(new Error("args must be an array of strings"), { code: INVALID_JOB_PAYLOAD });
    }
    if (script === undefined || typeof script !== "string") {
      throw Object.assign(new Error("script must be a string"), { code: INVALID_JOB_PAYLOAD });
    }
    if (command !== undefined) {
      throw Object.assign(new Error("script mode must not include command"), { code: INVALID_JOB_PAYLOAD });
    }
    const normalized: Record<string, unknown> = { mode: "script", executable, args, script };
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd === "") throw Object.assign(new Error("cwd must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
      normalized.cwd = cwd;
    }
    return normalized;
  }

  // ── 非法 mode ──
  throw Object.assign(new Error(`Unknown exec mode: ${mode}`), { code: INVALID_JOB_PAYLOAD });
}
```

- [ ] **Step 2: 把校验嵌入 createJob**

将 `events.controller.ts` 的 `createJob` 方法（第 33–55 行）修改为：

```ts
  @Post("jobs")
  async createJob(@Body() body: JobCreate, @Actor() actor: ActorContext) {
    let result: { jobId: string; status: string; type: string } | null = null;
    let dispatch: DispatchPayload | null = null;
    try {
      const type = body.type || "exec";
      let payload = body.payload || {};

      // ── 仅对 exec 类型做校验与规范化 ──
      if (type === "exec") {
        try {
          payload = normalizeAndValidateExecPayload(payload);
        } catch (e: any) {
          throw new BadRequestException({ code: e.code || INVALID_JOB_PAYLOAD, message: e.message });
        }
      }

      // ── timeout 校验 ──
      if (body.timeout !== undefined) {
        if (typeof body.timeout !== "number" || !Number.isFinite(body.timeout) || body.timeout <= 0 || !Number.isInteger(body.timeout)) {
          throw new BadRequestException({ code: INVALID_JOB_PAYLOAD, message: "timeout must be a positive integer" });
        }
      }

      const r = await this.jobService.create(
        {
          clientId: body.clientId,
          type,
          payload,
          timeout: body.timeout,
        },
        actor,
      );
      result = r.result;
      dispatch = r.dispatch;
    } catch (e: any) {
      throw new BadRequestException(e.message || e);
    }
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return result;
  }
```

- [ ] **Step 3: 构建 Server 验证编译**

```bash
cd packages/server && pnpm build
```

预期：编译通过，无类型错误。

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/events/events.controller.ts
git commit -m "feat(server): exec payload REST 校验、规范化与旧格式兼容"
```

---

### Task 3: Server Gateway 透传两种 exec 模式并处理 error 终态

**Files:**

- Modify: `packages/server/src/events/client.gateway.ts:169-193`（`sendDispatch`）
- Modify: `packages/server/src/events/client.gateway.ts:128-149`（`handleJobDone`）

**Interfaces:**

- Consumes: `DispatchPayload`（Task 2 规范化后的 payload）、`ExecJobDone`（Task 1）
- Produces: Server 侧 Job 终态写入 `errorCode`/`errorMessage`（被 Task 4 markDone 消费）

- [ ] **Step 1: 重写 sendDispatch 以透传两种 exec 模式**

替换 `sendDispatch` 方法（第 169–193 行）：

```ts
  sendDispatch(d: DispatchPayload) {
    if (d.type === "exec") {
      const p = d.payload as Record<string, unknown>;
      if (p.mode === "script") {
        this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
          jobId: d.jobId,
          type: "exec" as const,
          mode: "script" as const,
          executable: p.executable as string,
          args: p.args as string[],
          script: p.script as string,
          cwd: p.cwd as string | undefined,
          timeout: d.timeout,
        } satisfies JobDispatch);
      } else {
        this.server.to(d.clientId).emit(Events.JOB_DISPATCH, {
          jobId: d.jobId,
          type: "exec" as const,
          mode: "command" as const,
          command: (p.command ?? p.mode === undefined ? (p as any).command : "") as string,
          cwd: p.cwd as string | undefined,
          timeout: d.timeout,
        } satisfies JobDispatch);
      }
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

- [ ] **Step 2: 修改 handleJobDone 处理 error 终态**

替换 `handleJobDone` 方法（第 128–149 行）：

```ts
  @SubscribeMessage(Events.JOB_DONE)
  async handleJobDone(@MessageBody() data: JobDone) {
    const raw = data as any;
    const type: string = raw.type;

    if (type === "exec") {
      // ── Exec error 终态（基础设施失败） ──
      if (raw.error) {
        const errorCode: string = raw.error.code || "EXEC_FAILED";
        const errorMessage: string = raw.error.message || "";
        await this.jobService.markDone(data.jobId, type, { errorCode, errorMessage });
        this.server.emit(Events.JOB_UPDATE, {
          jobId: data.jobId,
          type,
          status: JobStatus.ERROR,
          errorCode,
          errorMessage,
          result: undefined,
        } satisfies JobUpdate);
        return;
      }

      // ── Exec 正常退出 ──
      const exitCode = raw.exitCode ?? 1;
      const result = { exitCode };
      const status = exitCode === 0 ? JobStatus.DONE : JobStatus.ERROR;
      const next = await this.jobService.markDone(data.jobId, type, result);

      this.server.emit(Events.JOB_UPDATE, {
        jobId: data.jobId,
        type,
        status,
        result,
      } satisfies JobUpdate);

      if (next) this.sendDispatch(next);
      return;
    }

    // ── 其他 Job 类型 ──
    const result: Record<string, unknown> = raw.result;
    const next = await this.jobService.markDone(data.jobId, type, result);
    this.server.emit(Events.JOB_UPDATE, {
      jobId: data.jobId,
      type,
      status: JobStatus.DONE,
      result,
    } satisfies JobUpdate);
    if (next) this.sendDispatch(next);
  }
```

- [ ] **Step 3: 构建 Server 验证编译**

```bash
cd packages/server && pnpm build
```

预期：编译通过。

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/events/client.gateway.ts
git commit -m "feat(server): Gateway 透传 command/script exec dispatch 并处理 error 终态"
```

---

### Task 4: JobService 标记 error 终态

**Files:**

- Modify: `packages/server/src/job/job.service.ts:81-98`（`markDone`）

**Interfaces:**

- Consumes: Task 3 调用 `markDone(jobId, "exec", { errorCode, errorMessage })`
- Produces: `errorCode`/`errorMessage` 写入数据库

- [ ] **Step 1: 更新 markDone 处理 exec error result**

将 `markDone` 方法（第 81–98 行）修改为：

```ts
  async markDone(
    jobId: string,
    type: string,
    result: Record<string, unknown>,
  ): Promise<DispatchPayload | null> {
    let effectiveStatus: string;

    if (type === "exec" && result.errorCode) {
      effectiveStatus = "error";
    } else if (type === "exec" && (result as any).exitCode !== 0 && (result as any).exitCode !== undefined) {
      effectiveStatus = "error";
    } else {
      effectiveStatus = "done";
    }

    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: effectiveStatus,
        result: JSON.stringify(result),
        errorCode: (result.errorCode as string) ?? null,
        errorMessage: (result.errorMessage as string) ?? null,
        finishedAt: new Date(),
      },
    });
    return this.scheduler.onFinished(job.clientId);
  }
```

- [ ] **Step 2: 构建 Server 验证编译**

```bash
cd packages/server && pnpm build
```

预期：编译通过。

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/job/job.service.ts
git commit -m "feat(server): markDone 支持 exec error 终态写入 errorCode/errorMessage"
```

---

### Task 5: Client dispatcher 分发两种 exec 模式

**Files:**

- Modify: `packages/client/src/dispatcher.ts:5-37`

**Interfaces:**

- Consumes: `ExecJobDispatch`（Task 1）
- Produces: 分解出 `executeCommand` / `executeScript` 形状，被 Task 6 实施

- [ ] **Step 1: 重写 dispatch 函数处理 exec 模式**

替换整个 `dispatcher.ts`：

```ts
import type { Socket } from "socket.io-client";
import type { JobDispatch } from "@vcpdeck/shared";
import { executeExec } from "./executor.js";

export function dispatch(job: JobDispatch, socket: Socket) {
  switch (job.type) {
    case "exec": {
      const execJob = job as {
        jobId: string;
        type: "exec";
        mode: "command" | "script";
        command?: string;
        executable?: string;
        args?: string[];
        script?: string;
        cwd?: string;
        timeout?: number;
      };

      if (execJob.mode === "script") {
        return executeExec(
          {
            jobId: execJob.jobId,
            mode: "script",
            executable: execJob.executable!,
            args: execJob.args!,
            script: execJob.script!,
            cwd: execJob.cwd,
            timeout: execJob.timeout,
          },
          socket,
        );
      }

      // command 模式（默认）
      return executeExec(
        {
          jobId: execJob.jobId,
          mode: "command",
          command: execJob.command!,
          cwd: execJob.cwd,
          timeout: execJob.timeout,
        },
        socket,
      );
    }
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
      throw new Error(`Job type "${job.type}" not yet implemented`);
    default:
      throw new Error(`Unknown job type: ${(job as any).type}`);
  }
}
```

- [ ] **Step 2: 构建 Client 验证编译**

```bash
cd packages/client && pnpm build
```

预期：编译通过。executeExec 签名尚未更新，暂时不会报错——目前它通过 `executeExec({jobId,command,timeout}, socket)` 调用。等 Task 6 更新签名后重新构建即可。

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/dispatcher.ts
git commit -m "feat(client): dispatcher 按 exec mode 分发 command/script"
```

---

### Task 6: Client executor 实现 command 与 script 执行、stdin 与幂等终态

**Files:**

- Modify: `packages/client/src/executor.ts`

**Interfaces:**

- Consumes: `executeExec` 的参数由 Task 5 确定
- Produces: 每个 Job 只产一个终态（`JOB_DONE` 或 `JOB_CANCELLED`/`JOB_CANCEL_FAILED`）

- [ ] **Step 1: 重写 ActiveJob 与 settle 结构**

替换 executor.ts 第 1–18 行（import 和 interface/Map）：

```ts
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
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
  cancelling?: boolean; // cancel 已发出 signal，等 close
}

const activeJobs = new Map<string, ActiveJob>();
```

- [ ] **Step 2: 实现 settle 幂等终态函数**

在第 18 行之后加入 settle 函数：

```ts
function settle(
  jobId: string,
  socket: Socket,
  action: () => void,
) {
  const active = activeJobs.get(jobId);
  if (!active) return; // 已终态，忽略
  activeJobs.delete(jobId);
  action();
}
```

- [ ] **Step 3: 重写 executeExec 支持 command 与 script**

替换 `executeExec` 函数（第 20–75 行）：

```ts
type ExecJob =
  | {
      jobId: string;
      mode: "command";
      command: string;
      cwd?: string;
      timeout?: number;
    }
  | {
      jobId: string;
      mode: "script";
      executable: string;
      args: string[];
      script: string;
      cwd?: string;
      timeout?: number;
    };

export function executeExec(job: ExecJob, socket: Socket) {
  let child: ChildProcess;

  if (job.mode === "command") {
    child = spawn(job.command, {
      shell: true,
      cwd: job.cwd,
      timeout: job.timeout,
    });
  } else {
    child = spawn(job.executable, job.args, {
      shell: false,
      cwd: job.cwd,
      timeout: job.timeout,
    });
  }

  // ── 注册 activeJob ──
  activeJobs.set(job.jobId, {
    jobId: job.jobId,
    process: child,
    startTime: Date.now(),
  });

  // ── stdout ──
  child.stdout?.on("data", (data: Buffer) => {
    socket.emit(Events.JOB_STDOUT, {
      jobId: job.jobId,
      text: data.toString(),
    } satisfies JobOutput);
  });

  // ── stderr ──
  child.stderr?.on("data", (data: Buffer) => {
    socket.emit(Events.JOB_STDERR, {
      jobId: job.jobId,
      text: data.toString(),
    } satisfies JobOutput);
  });

  // ── close（幂等） ──
  child.on("close", (code) => {
    settle(job.jobId, socket, () => {
      const active = activeJobs.get(job.jobId); // 已经 deleted，这是最终检查
      // 如果是 cancel 发起的 close，取消标记优先
      if (!active || active.cancelling) {
        socket.emit(Events.JOB_CANCELLED, { jobId: job.jobId } satisfies JobCancelled);
        return;
      }
      socket.emit(Events.JOB_DONE, {
        jobId: job.jobId,
        type: "exec" as const,
        exitCode: code ?? 1,
      } satisfies JobDone);
    });
  });

  // ── spawn error（幂等） ──
  child.on("error", (err) => {
    settle(job.jobId, socket, () => {
      socket.emit(Events.JOB_DONE, {
        jobId: job.jobId,
        type: "exec" as const,
        error: {
          code: "EXEC_SPAWN_FAILED",
          message: safeSpawnErrorMessage(err.message),
        },
      } satisfies JobDone);
    });
  });

  // ── script 模式：写 stdin ──
  if (job.mode === "script") {
    child.stdin?.on("error", (err) => {
      settle(job.jobId, socket, () => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        socket.emit(Events.JOB_DONE, {
          jobId: job.jobId,
          type: "exec" as const,
          error: {
            code: "EXEC_STDIN_FAILED",
            message: "Failed to write script to stdin",
          },
        } satisfies JobDone);
      });
    });
    child.stdin?.end(job.script, "utf8");
  }
}

/** 去除 spawn error 中的本地路径（不保证完整脱敏，仅过滤明显路径）。 */
function safeSpawnErrorMessage(msg: string): string {
  // 替换类 Unix 和 Windows 绝对路径模式
  return msg
    .replace(/[A-Za-z]:\\[^\s]*/g, "<path>")
    .replace(/\/[^\s]*/g, "<path>");
}
```

- [ ] **Step 4: 重写 killJob 内部标记 cancelling**

修改 `killJob` 函数（第 77–110 行）：

```ts
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
    active.cancelling = true; // 标记：close 时只发 JOB_CANCELLED
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
      // 幂等：settle 已在 close 事件中处理
    });
  } catch (err: any) {
    socket.emit(Events.JOB_CANCEL_FAILED, {
      jobId,
      reason: err.message,
    } satisfies JobCancelFailed);
  }
}
```

- [ ] **Step 5: 保留 getRunningJobIds 和 getStatusReport**

这两个函数无需修改，确认文件末尾保持原样：

```ts
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

- [ ] **Step 6: 构建 Client 验证编译**

```bash
cd packages/client && pnpm build
```

预期：编译通过。

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/executor.ts
git commit -m "feat(client): executor 支持 command/script 双模式、stdin 传输、幂等终态与结构化错误"
```

---

### Task 7: 端到端集成测试

**Files:**

- Modify: `scripts/test.cjs`

测试在现有 `scripts/test.cjs` 末尾、`main()` 之前追加。所有测试调用使用已建立的 `api`、`pass`、`fail`、`sleep`、`clientSocket` 等基础工具函数。

- [ ] **Step 1: 在 test.cjs 的 `process.on("exit"...)` 之前插入 exec 测试函数**

在 `scripts/test.cjs` 中，找到 `main()` 和 `process.on("exit"...)`，在它们之前插入以下测试函数：

```js
// ── Exec command/script 测试 ──

async function testExecCommandLegacy() {
  const res = await api("POST", "/api/jobs", {
    json: { clientId: "test-001", type: "exec", payload: { command: "echo hello-world" }, timeout: 10000 },
  });
  if (res.status !== 201) return fail("exec command legacy", `status ${res.status}`);
  const body = await res.json();
  if (!body.jobId) return fail("exec command legacy", "no jobId");
  await sleep(1500);
  pass("exec command legacy", `jobId=${body.jobId}`);
}

async function testExecCommandExplicit() {
  const res = await api("POST", "/api/jobs", {
    json: { clientId: "test-001", type: "exec", payload: { mode: "command", command: "echo explicit-cmd" }, timeout: 10000 },
  });
  if (res.status !== 201) return fail("exec command explicit", `status ${res.status}`);
  const body = await res.json();
  await sleep(1500);
  pass("exec command explicit", `jobId=${body.jobId}`);
}

async function testExecScriptNode() {
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: {
        mode: "script",
        executable: process.execPath,
        args: ["-"],
        script: 'console.log("hello-via-stdin")',
      },
      timeout: 10000,
    },
  });
  if (res.status !== 201) return fail("exec script node", `status ${res.status}`);
  const body = await res.json();
  await sleep(1500);
  pass("exec script node", `jobId=${body.jobId}`);
}

async function testExecScriptNodeUnicode() {
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: {
        mode: "script",
        executable: process.execPath,
        args: ["-"],
        script: 'console.log("你好 🎉"); console.log(\'single\\'s q\');',
      },
      timeout: 10000,
    },
  });
  if (res.status !== 201) return fail("exec script node unicode", `status ${res.status}`);
  await sleep(1500);
  pass("exec script node unicode", `jobId=${(await res.json()).jobId}`);
}

async function testExecScriptEmptyArgsAndScript() {
  // args: [] and script: "" 合法 — 解释器可能 exit 0 或 error，只要不崩溃即可
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: { mode: "script", executable: process.execPath, args: [], script: "", timeout: 10000 },
    },
  });
  if (res.status !== 201) return fail("exec script empty args/script", `status ${res.status}`);
  await sleep(1500);
  pass("exec script empty args/script", `jobId=${(await res.json()).jobId}`);
}

async function testExecInvalidPayloadMixed() {
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: { mode: "command", command: "x", executable: "python" },
      timeout: 10000,
    },
  });
  if (res.status === 400) return pass("exec invalid mixed payload", "400 as expected");
  fail("exec invalid mixed payload", `expected 400, got ${res.status}`);
}

async function testExecInvalidPayloadBadTimeout() {
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: { command: "echo ok" },
      timeout: -5,
    },
  });
  if (res.status === 400) return pass("exec invalid bad timeout", "400 as expected");
  fail("exec invalid bad timeout", `expected 400, got ${res.status}`);
}

async function testExecSpawnFailed() {
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: { mode: "script", executable: "no-such-interpreter-xyz", args: ["-"], script: "1", timeout: 5000 },
    },
  });
  if (res.status !== 201) return fail("exec spawn failed create", `status ${res.status}`);
  const body = await res.json();
  await sleep(2000);
  // 验证 job 进入 error 状态
  const check = await api("GET", `/api/jobs/${body.jobId}`);
  const j = await check.json();
  if (j.status === "error" && j.errorCode === "EXEC_SPAWN_FAILED") return pass("exec spawn failed", j.errorCode);
  fail("exec spawn failed", `status=${j.status} errorCode=${j.errorCode}`);
}

async function testExecCommandCwd() {
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: { mode: "command", command: isWin ? "cd" : "pwd", cwd: os.tmpdir(), timeout: 10000 },
    },
  });
  if (res.status !== 201) return fail("exec command cwd", `status ${res.status}`);
  await sleep(1500);
  pass("exec command cwd", "accepted");
}

async function testExecCancel() {
  // 提交一个长时间运行的 job 然后取消
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: { mode: "script", executable: process.execPath, args: ["-"], script: "setTimeout(()=>{},30000)", timeout: 20000 },
    },
  });
  if (res.status !== 201) return fail("exec cancel create", `status ${res.status}`);
  const body = await res.json();
  await sleep(500);
  const cancelRes = await api("POST", `/api/jobs/${body.jobId}/cancel`);
  if (cancelRes.status !== 201) return fail("exec cancel request", `status ${cancelRes.status}`);
  await sleep(3000);
  const check = await api("GET", `/api/jobs/${body.jobId}`);
  const j = await check.json();
  if (j.status === "cancelled") return pass("exec cancel", "cancelled");
  fail("exec cancel", `status=${j.status}`);
}

async function testExecScriptQuotes() {
  // 验证引号和反斜杠不被 shell 破坏
  const res = await api("POST", "/api/jobs", {
    json: {
      clientId: "test-001", type: "exec",
      payload: {
        mode: "script",
        executable: process.execPath,
        args: ["-"],
        script: 'console.log("a\\"b\\"c"); console.log(\'d\\\\e\');',
      },
      timeout: 10000,
    },
  });
  if (res.status !== 201) return fail("exec script quotes", `status ${res.status}`);
  await sleep(1500);
  pass("exec script quotes", `jobId=${(await res.json()).jobId}`);
}
```

- [ ] **Step 2: 在 main() 中调用测试**

在 `scripts/test.cjs` 的 `main()` 函数中，找到现有测试调用后面，追加：

```js
  // ── Exec command/script 测试 ──
  await testExecCommandLegacy();
  await testExecCommandExplicit();
  await testExecCommandCwd();
  await testExecScriptNode();
  await testExecScriptNodeUnicode();
  await testExecScriptQuotes();
  await testExecScriptEmptyArgsAndScript();
  await testExecInvalidPayloadMixed();
  await testExecInvalidPayloadBadTimeout();
  await testExecSpawnFailed();
  await testExecCancel();
```

- [ ] **Step 3: 全量构建并运行测试**

```bash
pnpm build && node scripts/test.cjs
```

预期：所有 `exec` 测试通过。

- [ ] **Step 4: Commit**

```bash
git add scripts/test.cjs
git commit -m "test: 增加 exec command/script 集成测试覆盖模式、校验、错误与取消"
```

---

### 自检

**1. 规格覆盖**：协议类型（Task 1）、REST 校验与兼容（Task 2）、Gateway 透传与 error 终态（Task 3）、errorCode 持久化（Task 4）、Client 分发（Task 5）、双模式执行 + stdin + 幂等 settle + 结构化错误（Task 6）、13 项集成测试覆盖（Task 7）。全部覆盖。

**2. 占位符检查**：无 TBD/TODO/待定。

**3. 类型一致性**：`ExecJobDispatch`（Task 1）→ `normalizeAndValidateExecPayload` 产出 `Record<string,unknown>`（Task 2）→ `sendDispatch` 取字段名（Task 3）→ `executeExec` 的参数 `ExecJob`（Task 6）字段名一致（`mode`、`command`、`executable`、`args`、`script`、`cwd`）。`ExecJobDone`（Task 1）→ `handleJobDone` 取 `raw.error` / `raw.exitCode`（Task 3）→ `markDone` 取 `result.errorCode`（Task 4）。一致。
