# Pi Session Job 生命周期实施计划

> **供 Agent 执行：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，按任务逐项执行。每一步使用复选框追踪；每个生产改动都遵循 RED → GREEN → 验证 → 小提交。

**目标：** 将“每次 Prompt 一条 `agent.run`”改为“每个 Pi Session 唯一一条、可手动完成的 `agent.session` Job”，同时为每次 Prompt 生成独立 `runId`，并彻底收敛 Extension 响应、超时、刷新和 Client 重连后的 `waiting_input` 状态。

**架构：** `sessionId` 同时作为稳定 `jobId`；`runId` 只代表一次 Prompt。Server 的 `PiRunService` 负责持久化 Session Job 状态、原子 CAS、项目锁和短期连接代次 lease；`PiRequestBroker` 按 lease socket 精确路由。Client Supervisor 负责当前 Prompt run 的权威状态，Extension UI 只存在于 Client/浏览器内存。正常回答结束进入 `idle`；只有 Owner 手动操作才进入 `done`。

**技术栈：** TypeScript strict + NodeNext、NestJS 10、Prisma 7 + SQLite/libSQL、Socket.IO、RxJS SSE、React 18、Vite 5、Vitest 3、Playwright MCP、Pi SDK `0.84.0`。

## 全局约束

- 事实来源：`docs/superpowers/specs/2026-08-08-pi-session-job-lifecycle-design.md`。
- `jobId === sessionId`；每次 Prompt 的 `runId` 必须是新 UUID，不要求等于 `jobId`。
- 普通回答结束只能进入 `idle`；`done` 由固定 Owner 手动触发，并可通过后续 Prompt 重新激活。
- 只有未解决的 `select`、`confirm`、`input`、`editor` 可进入 `waiting_input`。
- Prompt、响应正文、thinking 正文、图片内容/URL、路径、`projectKey`、凭据、Extension message/options/prefill/用户输入不得进入 Job、数据库或日志。
- `pendingExtension` 只允许存在于 Client Worker 内存、`agent.state`、SSE 和当前浏览器内存。
- Pi SDK 固定为 `0.84.0`；主 Client 进程继续禁止静态导入 SDK。
- 保留现有 30 秒可取消 settlement grace。
- 不新增 Prisma model、第三方依赖、Server 轮询器或自动 Session 完成计时；generation lease 只串行短 REST/REGISTER/PI_STATE 编排，不覆盖 Agent 运行时长。
- 所有 run 状态写入必须使用带 `id + runId + 源状态` 的原子 CAS；禁止“先查再无条件更新”。
- 修改任何函数、方法或类前必须运行 `gitnexus_impact({ target, direction: "upstream" })`，报告直接调用者、受影响流程和风险；HIGH/CRITICAL 必须先停下并取得用户确认。
- 每次提交前运行 `gitnexus_detect_changes({ scope: "unstaged" })` 和 `git diff --check`。
- 每次提交使用显式 pathspec；禁止提交 `.gitmodules`、`examples/pi-web` 或其他用户已有改动。
- 当前 Remote Pi/thinking 工作仍修改了许多目标文件。执行本计划前，必须先把已完成且已验证的现有改动提交为清晰基线，或从包含这些改动的提交创建隔离 worktree；不得把旧改动混进本计划提交。
- 注释与公共 JSDoc 使用简体中文；标识符、协议字段、枚举值使用英文。
- 每个任务结束时必须能通过本任务列出的 package build；临时迁移适配器只能存在到明确写出的删除步骤。

---

## 文件职责图

### Shared 协议

- `packages/shared/src/index.ts`：`JobType.AGENT_SESSION`、`JobStatus.IDLE`、常用类型转出。
- `packages/shared/src/pi.ts`：协议版本、Session Job 快照、独立 runId、Extension 关闭事件、Agent State parser、PI_STATE ack。
- `packages/shared/src/pi.test.ts`：信任边界和 ID 约束。

### Client 权威状态

- `packages/client/src/pi/agent-session.ts`：单活动 Extension + 内存排队、timeout/resolved、abort 权威停止、Agent State。
- `packages/client/src/pi/supervisor.ts`：稳定 Session Job + 独立 run、迟到事件过滤、PI_STATE ack。
- `packages/client/src/pi/worker.ts`：在 wrapper 创建前绑定 run envelope，失败回滚。
- `packages/client/src/index.ts`：每次 Socket 连接代次重新上报 PI_STATE。
- `packages/client/src/pi/*test.ts`：Wrapper、Supervisor、Worker、Socket 重连覆盖。

### Server 状态机

- `packages/server/src/pi/pi-run.service.ts`：深模块；唯一负责 Session Job、CAS、项目锁、连接代次 readiness、Owner、快照、open/reconnect 对账和安全错误映射。
- `packages/server/src/pi/pi-event-broker.ts`：把 Client Event 路由到状态机并保持 SSE。
- `packages/server/src/events/client.gateway.ts`：PI_STATE ack 和断线状态。
- `packages/server/src/pi/pi.controller.ts`：Session create/open/prompt/abort/complete/fork/clone/delete 的 REST 编排。
- `packages/server/src/job/job.scheduler.ts`：排除新旧 Pi Job。

### SDK 与 Frontend

- `packages/sdk/src/pi.ts`：`open`、`complete`、run-scoped control。
- `packages/frontend/src/pi/use-pi-session.ts`：合并 Session Job 和 Pi Agent State 两类权威信息。
- `packages/frontend/src/pi/pi-run-details.tsx`：真实状态和手动完成。
- `packages/frontend/src/pi/pi-chat-input.tsx`、`pi-session-sidebar.tsx`、`pages/pi-panel.tsx`：Observer 全部写操作禁用。
- `packages/frontend/src/components/notification-bell.tsx`：隐藏 `agent.session`。
- `packages/frontend/src/pages/jobs-page.tsx`、`dashboard-page.tsx`：新类型/状态审计展示。

---

### 任务 1：定义 Session Job 协议和兼容版本

**文件：**

- 修改：`packages/shared/src/index.ts`
- 修改：`packages/shared/src/pi.ts`
- 测试：`packages/shared/src/pi.test.ts`
- 修改：`packages/client/src/pi/capability.ts`
- 测试：`packages/client/src/pi/capability.test.ts`

**产出接口：**

```ts
export const PI_SESSION_JOB_PROTOCOL_VERSION = 1;

// 加入现有 PiErrorCode union 与 PI_ERROR_CODES：
// "PI_STATE_PENDING" 表示本连接代次尚未完成 PI_STATE 对账。

export type PiSessionJobStatus =
  | "idle"
  | "pending"
  | "running"
  | "waiting_input"
  | "done"
  | "disconnected"
  | "error"
  | "cancelled";

export interface PiSessionJobSnapshot {
  jobId: string;
  sessionId: string;
  status: PiSessionJobStatus;
  runId: string | null;
  ownerName: string | null;
  isOwner: boolean;
  errorCode?: PiErrorCode;
  errorMessage?: string;
}

export interface PiSessionCreated {
  sessionId: string;
  jobId: string;
}

export interface PiSessionOpenResult {
  job: PiSessionJobSnapshot;
  agentState: PiAgentState;
}

export interface PiStateAck {
  acceptedRunIds: string[];
  closedRunIds: string[];
  reportAgain: boolean;
}
```

`PiCapabilityStatus` 的 `available: true` 分支新增可选字段：

```ts
sessionJobProtocolVersion?: number;
```

字段保持可选是为了让 Shared 能描述旧 Client；新 Client 必须上报 `1`，Server 在后续任务中要求精确匹配。

`PiClientEvent` 新增：

```ts
| {
    type: "extension_resolved";
    sessionId: string;
    requestId: string;
    reason: "answered" | "cancelled" | "timeout";
    hasPending: boolean;
  }
```

`PiAgentState` 新增：

```ts
pendingExtension?: PiExtensionUiRequest;
```

- [ ] **步骤 1：运行影响分析**

对 `JobType`、`JobStatus`、`PiCapabilityStatus`、`PiClientEvent`、`PiAgentState`、`parsePiRequest`、`parsePiEvent`、`parsePiStateReport` 运行 upstream impact。记录风险和受影响包。

- [ ] **步骤 2：先写协议 RED 测试**

在 `packages/shared/src/pi.test.ts` 增加：

```ts
it("允许 Session Job 使用独立 Prompt runId", () => {
  const request = parsePiRequest({
    requestId: "request-1",
    action: "agent.prompt",
    cwdRef: { rootDir: "D:\\", relativePath: "repo" },
    sessionId: "session-1",
    jobId: "session-1",
    runId: "run-1",
    payload: { prompt: "hello" },
  });
  expect(request.jobId).toBe("session-1");
  expect(request.runId).toBe("run-1");
});

it("拒绝 jobId 与 sessionId 不一致", () => {
  expect(() => parsePiRequest({
    requestId: "request-1",
    action: "agent.prompt",
    cwdRef: { rootDir: "D:\\", relativePath: "repo" },
    sessionId: "session-1",
    jobId: "other-job",
    runId: "run-1",
    payload: { prompt: "hello" },
  })).toThrow(/jobId.*sessionId/);
});

it("接受并严格校验 extension_resolved", () => {
  const event = parsePiEvent({
    clientId: "client-1",
    sessionId: "session-1",
    jobId: "session-1",
    runId: "run-1",
    event: {
      type: "extension_resolved",
      sessionId: "session-1",
      requestId: "ui-1",
      reason: "timeout",
      hasPending: false,
    },
  });
  expect(event.event.type).toBe("extension_resolved");
  expect(() => parsePiEvent({
    clientId: "client-1",
    sessionId: "session-1",
    jobId: "session-1",
    runId: "run-1",
    event: {
      type: "extension_resolved",
      sessionId: "session-1",
      requestId: "ui-1",
      reason: "unknown",
      hasPending: false,
    },
  })).toThrow(/reason/);
});

it("拒绝外层与内层 sessionId 不一致", () => {
  expect(() => parsePiEvent({
    clientId: "client-1",
    sessionId: "session-1",
    jobId: "session-1",
    runId: "run-1",
    event: { type: "agent_end", sessionId: "other-session" },
  })).toThrow(/sessionId/);
});
```

新增 `parsePiAgentState()` 测试，并建立 `PI_ERROR_CODES` 单一 allowlist，供 response/event parser 与 `safePiErrorMessage()` 复用：

```ts
it("严格解析 pendingExtension", () => {
  expect(parsePiAgentState({
    status: "waiting_for_extension_input",
    streaming: false,
    prompting: true,
    compacting: false,
    thinkingLevel: "off",
    queuedMessages: { steering: [], followUp: [] },
    pendingExtension: {
      requestId: "ui-1",
      extensionId: "project-trust",
      kind: "confirm",
      title: "Project Trust",
      message: "是否信任？",
    },
  }).pendingExtension?.requestId).toBe("ui-1");
});

it("拒绝畸形 Agent State 和非交互 pending kind", () => {
  expect(() => parsePiAgentState({
    status: "waiting_for_extension_input",
    streaming: "yes",
    prompting: true,
    compacting: false,
    thinkingLevel: "off",
    queuedMessages: { steering: [], followUp: [] },
  })).toThrow(/streaming/);
  expect(() => parsePiAgentState({
    status: "waiting_for_extension_input",
    streaming: false,
    prompting: true,
    compacting: false,
    thinkingLevel: "off",
    queuedMessages: { steering: [], followUp: [] },
    pendingExtension: {
      requestId: "ui-1",
      extensionId: "e",
      kind: "notify",
    },
  })).toThrow(/pendingExtension.kind/);
});
```

同时断言：

```ts
expect(JobType.AGENT_SESSION).toBe("agent.session");
expect(JobStatus.IDLE).toBe("idle");
expect(PI_SESSION_JOB_PROTOCOL_VERSION).toBe(1);
```

并覆盖 `PiStateReport`：活动 `running/waiting_input` 必须携带合法 projectKey，idle/error 可省略；`jobId === sessionId`、独立 `runId`、`idle` 合法；`jobId !== sessionId` 非法；`runs` 最多 1,000 项，超限拒绝。再覆盖 `prompt_error.code`、`PiResponse.error.code` 必须来自 `PI_ERROR_CODES`，message 不能超过 4 KiB。

- [ ] **步骤 3：运行 RED**

```bash
pnpm --dir "packages/shared" exec vitest run "src/pi.test.ts"
```

预期失败：当前 parser 报 `runId 必须等于 jobId`，新事件、状态、parser 和枚举不存在。

- [ ] **步骤 4：实现最小 Shared 协议**

在 `pi.ts` 中删除 `assertIdPair()`，改为：

```ts
function assertSessionJobPair(sessionId: unknown, jobId: unknown): void {
  if (sessionId !== undefined && jobId !== undefined && sessionId !== jobId) {
    throw new PiProtocolError("jobId 必须等于 sessionId");
  }
}
```

实现要求：

1. run-scoped action/event 必须有非空 `sessionId`、`jobId`、`runId`；只比较 `sessionId/jobId`。
2. `parsePiEvent()` 校验内外 `sessionId`、事件专属字段、Extension UI kind、字符串长度、options 数量和 allowlist error code；不能只校验 event type。
3. 新增 `parsePiAgentState()`，严格校验 status、布尔字段、thinking level、队列数组、model 和 pending Extension；`parsePiResponse()` 同样校验 error code/message 上限。
4. `PiRunSummary.status` 接受 `running | waiting_input | idle | error`，保留 `done` 仅用于旧终态摘要兼容；活动状态强制 projectKey，确保 Server 可在 ready 前重建项目锁。
5. `pi.ts` 继续自包含，不 import 同包其他模块；使用 `PiSessionJobStatus` 字符串联合，不引用 `JobStatus` enum。
6. 在 `index.ts` 显式转出新常用类型和 parser。

建议安全上限直接放在 `pi.ts`：title/message 16 KiB、error message 4 KiB、options 最多 100 项、每项 4 KiB、队列每类最多 1,000 项、PI_STATE runs 最多 1,000 项。不要新增通用 schema 框架。

- [ ] **步骤 5：让新 Client 上报协议版本**

在 `probePiCapability()` 成功分支加入：

```ts
sessionJobProtocolVersion: PI_SESSION_JOB_PROTOCOL_VERSION,
```

在 `capability.test.ts` 断言成功探测包含版本，失败探测不伪造可用版本。

- [ ] **步骤 6：运行 GREEN 和构建**

```bash
pnpm --dir "packages/shared" test
pnpm --dir "packages/shared" build
pnpm --dir "packages/client" exec vitest run "src/pi/capability.test.ts"
pnpm --dir "packages/client" build
```

- [ ] **步骤 7：检查并提交**

```bash
git add -- \
  "packages/shared/src/index.ts" \
  "packages/shared/src/pi.ts" \
  "packages/shared/src/pi.test.ts" \
  "packages/client/src/pi/capability.ts" \
  "packages/client/src/pi/capability.test.ts"
git commit -m "feat(shared): 定义 Pi Session Job 协议" --only -- \
  "packages/shared/src/index.ts" \
  "packages/shared/src/pi.ts" \
  "packages/shared/src/pi.test.ts" \
  "packages/client/src/pi/capability.ts" \
  "packages/client/src/pi/capability.test.ts"
```

---

### 任务 2：让 Extension UI 回答、超时和并发请求可收敛

**文件：**

- 修改：`packages/client/src/pi/agent-session.ts`
- 测试：`packages/client/src/pi/agent-session.test.ts`

**产出接口：**

Client Wrapper 同时只激活一个交互请求，其余请求仅保存在内存队列：

```ts
interface PendingUi {
  request: PiExtensionUiRequest;
  resolve: (value: unknown) => void;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}
```

内部方法：

```ts
private activateNextExtensionUi(): void;
private finishExtensionUi(
  requestId: string,
  reason: "answered" | "cancelled" | "timeout",
  value: unknown,
): void;
private async waitForStopped(timeoutMs: number): Promise<void>;
```

- [ ] **步骤 1：运行影响分析**

分析 `PiAgentSessionWrapperImpl.getState`、`requestExtensionUi`、`resolveExtensionUiResponse`、`send`、`destroy`。

- [ ] **步骤 2：写 Extension RED 测试**

```ts
it("agent.state 暴露当前活动 Extension 摘要", async () => {
  const { inner, wrapper } = makeWrapper();
  void (inner.uiContext?.confirm as Function)("确认", "继续吗？");
  expect(wrapper.getState().pendingExtension).toMatchObject({
    kind: "confirm",
    title: "确认",
    message: "继续吗？",
  });
});

it("回答后发出 answered 并清空状态", async () => {
  const { inner, wrapper } = makeWrapper();
  const events: PiClientEvent[] = [];
  wrapper.onEvent((event) => events.push(event));
  const promise = (inner.uiContext?.input as Function)("输入", "内容");
  const requestId = wrapper.getState().pendingExtension!.requestId;
  await wrapper.send("extension.respond", { requestId, value: "answer" });
  await expect(promise).resolves.toBe("answer");
  expect(events).toContainEqual(expect.objectContaining({
    type: "extension_resolved",
    requestId,
    reason: "answered",
    hasPending: false,
  }));
  expect(wrapper.getState().pendingExtension).toBeUndefined();
});

it("超时发出 timeout", async () => {
  vi.useFakeTimers();
  const { inner, wrapper } = makeWrapper();
  const events: PiClientEvent[] = [];
  wrapper.onEvent((event) => events.push(event));
  const promise = (inner.uiContext?.input as Function)(
    "输入",
    "内容",
    { timeout: 25 },
  );
  await vi.advanceTimersByTimeAsync(25);
  await expect(promise).resolves.toBeUndefined();
  expect(events).toContainEqual(expect.objectContaining({
    type: "extension_resolved",
    reason: "timeout",
    hasPending: false,
  }));
});

it("并发请求串行展示，解决一个后仍保持 pending", async () => {
  const { inner, wrapper } = makeWrapper();
  const events: PiClientEvent[] = [];
  wrapper.onEvent((event) => events.push(event));
  const first = (inner.uiContext?.confirm as Function)("第一项", "A");
  const second = (inner.uiContext?.input as Function)("第二项", "B");
  const firstId = wrapper.getState().pendingExtension!.requestId;
  await wrapper.send("extension.respond", { requestId: firstId, confirmed: true });
  await expect(first).resolves.toBe(true);
  expect(events).toContainEqual(expect.objectContaining({
    type: "extension_resolved",
    requestId: firstId,
    hasPending: true,
  }));
  expect(wrapper.getState().pendingExtension).toMatchObject({ title: "第二项" });
  expect(second).toBeInstanceOf(Promise);
});

it("abort 只关闭已展示请求并清除排队请求", async () => {
  const { inner, wrapper } = makeWrapper();
  const events: PiClientEvent[] = [];
  wrapper.onEvent((event) => events.push(event));
  void (inner.uiContext?.confirm as Function)("第一项", "A");
  void (inner.uiContext?.input as Function)("第二项", "B");
  const displayedId = wrapper.getState().pendingExtension!.requestId;
  await wrapper.send("agent.abort");
  expect(inner.abort).toHaveBeenCalledOnce();
  expect(events.filter((event) => event.type === "extension_resolved")).toEqual([
    expect.objectContaining({
      requestId: displayedId,
      reason: "cancelled",
      hasPending: false,
    }),
  ]);
  expect(wrapper.getState().pendingExtension).toBeUndefined();
  expect(wrapper.getState().status).toBe("idle");
});
```

`afterEach` 必须恢复 real timers。

- [ ] **步骤 3：运行 RED**

```bash
pnpm --dir "packages/client" exec vitest run "src/pi/agent-session.test.ts"
```

- [ ] **步骤 4：实现单活动请求 + 内存队列**

实现规则：

1. `requestExtensionUi()` 入队；只有队首调用 `activateNextExtensionUi()`、启动 timeout 并 emit `extension_request`。
2. `finishExtensionUi()` 只处理当前 requestId；先删除/清 timer，再 resolve，再 emit `extension_resolved`；`hasPending` 根据队列剩余数量计算。
3. 若仍有请求，emit resolved 后立刻激活下一项；Server 因 `hasPending: true` 保持 waiting。
4. confirm 取消/timeout 返回 `false`，input/editor/select 返回 `undefined`，保持 SDK 原生语义。
5. `getState()` 只返回当前活动请求的安全摘要，不暴露排队内容。
6. `agent.abort`：await `inner.abort()`，取消全部 pending，随后 `waitForStopped(5_000)`；只有 `promptRunning/isStreaming/isCompacting/pendingUi` 全部清空才返回成功，否则抛稳定 `PI_REQUEST_TIMEOUT`。
7. abort/destroy 对已展示请求恰好 emit 一次 cancelled/false；从未 emit `extension_request` 的排队请求只内部 resolve，不发虚假 `extension_resolved`；已解决 requestId 不得重复 emit。

- [ ] **步骤 5：运行 GREEN 和构建**

```bash
pnpm --dir "packages/client" exec vitest run "src/pi/agent-session.test.ts"
pnpm --dir "packages/client" build
```

- [ ] **步骤 6：检查并提交**

```bash
git add -- "packages/client/src/pi/agent-session.ts" "packages/client/src/pi/agent-session.test.ts"
git commit -m "fix(client): 收敛 Pi 扩展等待状态" --only -- \
  "packages/client/src/pi/agent-session.ts" \
  "packages/client/src/pi/agent-session.test.ts"
```

---

### 任务 3：分离 Client 的 Session Job 与 Prompt Run，并修复重连上报

**文件：**

- 修改：`packages/client/src/pi/supervisor.ts`
- 测试：`packages/client/src/pi/supervisor.test.ts`
- 修改：`packages/client/src/pi/agent-session.ts`
- 测试：`packages/client/src/pi/agent-session.test.ts`
- 修改：`packages/client/src/pi/worker.ts`
- 测试：`packages/client/src/pi/pi-worker.integration.test.ts`
- 修改：`packages/client/src/pi/session-reader.ts`
- 测试：`packages/client/src/pi/session-reader.test.ts`
- 修改：`packages/client/src/index.ts`
- 测试：`packages/client/src/pi/socket-bridge.test.ts`

**接口变化：**

```ts
export interface PiSupervisor {
  request(request: PiRequest, timeoutMs?: number): Promise<PiResponse>;
  getStateReport(): PiStateReport;
  applyStateAck(ack: PiStateAck): Promise<{ allClosed: boolean }>;
  onEvent(listener: (event: PiEvent) => void): () => void;
  shutdown(): Promise<void>;
}
```

- [ ] **步骤 1：运行影响分析**

分析 `createPiSupervisor`、`getStateReport`、`ackTerminalRuns`、`wrapPiEvent`、`startPiAgentSession`、`PiAgentSessionWrapperImpl.askConfirm/shutdown`、Worker `dispatch/handleMessage`、`PiSessionReader` 和 `attachPiBridge`。

- [ ] **步骤 2：将 Supervisor 测试 helper 改为独立 ID**

```ts
function prompt(runId: string, cwdRef = CWD_REF_A): PiRequest {
  return req({
    action: "agent.prompt",
    sessionId: "session-1",
    jobId: "session-1",
    runId,
    cwdRef,
    payload: { prompt: "hi" },
  });
}
```

新增 RED：

```ts
it("同一 Session 后续 Prompt 使用新 runId", async () => {
  const { supervisor, handles } = makeSupervisor({ autoRespond: true });
  await supervisor.request(prompt("run-1"));
  handles[0].emitMessage(event("session-1", "run-1", "agent_settled"));
  await supervisor.request(prompt("run-2"));
  expect(supervisor.getStateReport().runs).toContainEqual(expect.objectContaining({
    jobId: "session-1",
    sessionId: "session-1",
    runId: "run-2",
    status: "running",
  }));
});

it("旧 run 迟到事件不清理新 run", async () => {
  const { supervisor, handles } = makeSupervisor({ autoRespond: true });
  await supervisor.request(prompt("run-1"));
  handles[0].emitMessage(event("session-1", "run-1", "agent_settled"));
  await supervisor.request(prompt("run-2"));
  handles[0].emitMessage(event("session-1", "run-1", "agent_settled"));
  expect(supervisor.getStateReport().runs).toContainEqual(expect.objectContaining({
    runId: "run-2",
    status: "running",
  }));
});

it("只在最后一个 Extension 解决后恢复 running", async () => {
  const { supervisor, handles } = makeSupervisor({ autoRespond: true });
  await supervisor.request(prompt("run-1"));
  handles[0].emitMessage(extensionRequestEvent("session-1", "run-1", "ui-1"));
  handles[0].emitMessage(extensionResolvedEvent(
    "session-1", "run-1", "ui-1", true,
  ));
  expect(supervisor.getStateReport().runs[0]?.status).toBe("waiting_input");
  handles[0].emitMessage(extensionResolvedEvent(
    "session-1", "run-1", "ui-2", false,
  ));
  expect(supervisor.getStateReport().runs[0]?.status).toBe("running");
});

it("PI_STATE ack 只在权威 abort 成功后清理 closed run", async () => {
  const { supervisor, handles } = makeSupervisor({ autoRespond: true });
  await supervisor.request(prompt("run-1"));
  await supervisor.applyStateAck({
    acceptedRunIds: [],
    closedRunIds: ["run-1"],
    reportAgain: false,
  });
  expect(handles[0].sent).toContainEqual(expect.objectContaining({
    type: "request",
    request: expect.objectContaining({ action: "agent.abort", runId: "run-1" }),
  }));
  expect(supervisor.getStateReport().runs.some((run) => run.runId === "run-1")).toBe(false);
});

it("closed run abort 失败时保留并在下一次 PI_STATE 重报", async () => {
  const { supervisor } = makeSupervisor({
    requestOutcomes: { "agent.abort": "timeout" },
  });
  await supervisor.request(prompt("run-1"));
  await supervisor.applyStateAck({
    acceptedRunIds: [],
    closedRunIds: ["run-1"],
    reportAgain: true,
  });
  expect(supervisor.getStateReport().runs).toContainEqual(
    expect.objectContaining({ runId: "run-1" }),
  );
});
```

- [ ] **步骤 3：增加 Worker envelope 与只读 state RED 测试**

真实 Worker 集成测试覆盖：

1. `jobId = sessionId` 且 `runId` 独立透传；
2. Project Trust 必须在 Prompt envelope 绑定后才触发：Worker 先设置 `active={jobId,runId,sessionId,cancelToken}`，立即创建并保存单个可取消 `promptPipeline`，再响应 accepted；以 `ProjectTrustStore=false` 创建受限 wrapper是 pipeline 的第一项 await，不得在登记 pipeline 前等待。pipeline 随后由 wrapper confirm；确认后持久化 trust、销毁受限 wrapper、按已信任状态重建一次再 Prompt；拒绝/超时继续受限运行。每个 await 后校验 matching runId；abort/complete 使 pipeline 失效并等待停止，失效后不得开始模型。`extension_request` 必须带当前新 run envelope；
3. `ensureWrapper` 失败或图片下载失败后清除提前绑定的 envelope，PI_STATE 不出现幽灵 active run；
4. 下一次 Prompt 不复用失败 runId；
5. 无 runId 的 `agent.state` 通过 `PiSessionReader.state(sessionId)` 返回 `status: idle` 和 JSONL 中最近的 model/thinking，不调用 `startPiAgentSession`、不加载 Project Trust/Extension；
6. 有 matching runId 的 `agent.state` 才使用 wrapper 权威状态和 pendingExtension；
7. `agent.prompt` 在绑定 pipeline 后立即 accepted，不等待 wrapper/trust；abort 发生在 `ensureRestrictedWrapper` pending 时，晚到 wrapper 被关闭且 Prompt 未调用；
8. trust pending 期间 abort 后 pipeline 不启动模型，状态最终 idle；trust=true 重建 wrapper 期间 abort 时，新 wrapper 被关闭且不 Prompt；
9. 同一项目同时只允许一个 promptPipeline。

- [ ] **步骤 4：增加 Socket 重连 RED 测试**

在 `socket-bridge.test.ts` 模拟两个连接代次：

```ts
it("每次 reconnect 的 REGISTER ack 都重新发送 PI_STATE", async () => {
  const { socket, emitCalls } = fakeSocket();
  const { deps } = await makeDeps();
  const bridge = attachPiBridge(socket, deps);

  await bridge.onConnected();
  registerAckAt(emitCalls, 0)();
  expect(emitCalls.filter((call) => call.event === Events.PI_STATE)).toHaveLength(1);

  await bridge.onConnected();
  registerAckAt(emitCalls, 1)();
  expect(emitCalls.filter((call) => call.event === Events.PI_STATE)).toHaveLength(2);
});

it("closed abort 首次超时后有界重试成功并二次 PI_STATE", async () => {
  vi.useFakeTimers();
  const { socket, supervisor } = makeBridge({
    applyStateAck: vi.fn()
      .mockResolvedValueOnce({ allClosed: false })
      .mockResolvedValueOnce({ allClosed: true }),
  });
  deliverStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: true });
  await vi.runAllTimersAsync();
  expect(supervisor.applyStateAck).toHaveBeenCalledTimes(2);
  expect(countStateReports()).toBe(2);
  expect(socket.disconnect).not.toHaveBeenCalled();
});

it("closed abort 重试耗尽后受控重连并完成新 generation 上报", async () => {
  vi.useFakeTimers();
  const { socket, emitCalls } = makeBridge({ allClosed: false });
  deliverStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: true });
  await vi.runAllTimersAsync();
  expect(socket.disconnect).toHaveBeenCalledOnce();
  expect(socket.connect).toHaveBeenCalledOnce();
  fireConnect();
  await registerAckAt(emitCalls, 1)();
  expect(countRegisterCalls()).toBe(2);
  expect(countStatusReports()).toBe(2);
  expect(countStateReports()).toBeGreaterThanOrEqual(2);
});

it("旧 generation 的 reconnect timer 不扰动已变化但再次断线的新代次", async () => {
  vi.useFakeTimers();
  const { socket } = makeBridge({ allClosed: false });
  deliverStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: true });
  fireConnect(); // 递增 generation
  socket.connected = false; // 新代次随后也断线，确保只验证 generation guard
  await vi.runAllTimersAsync();
  expect(socket.connect).not.toHaveBeenCalled();
});

it("同 generation 已连接时 reconnect timer 不重复连接", async () => {
  vi.useFakeTimers();
  const { socket } = makeBridge({ allClosed: false });
  deliverStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: true });
  socket.connected = true;
  await vi.runAllTimersAsync();
  expect(socket.connect).not.toHaveBeenCalled();
});
```

第二个 PI_STATE ack 必须调用 `const {allClosed}=await applyStateAck({acceptedRunIds,closedRunIds,reportAgain})`。当 `reportAgain===true&&allClosed` 时，bridge 在同一 generation 立即再次发送 `getStateReport()`。若 allClosed=false，对 closed abort 最多延迟重试 2 次；重试成功后再次 PI_STATE。连续二次报告仍要求 reportAgain，或 abort 重试耗尽时，执行受控重连：记录当前 generation，调用 `socket.disconnect()`，再由短延迟 timer 在“generation 未变化且 socket 仍未连接”时显式 `socket.connect()`。主动 `disconnect()` 本身会禁用自动重连，绝不能只调用 disconnect 或声称它会自动触发 backoff。新 connect 必须走现有 handler 的完整 REGISTER ack → STATUS_REPORT + PI_STATE，并产生新 generation。

- [ ] **步骤 5：运行 RED**

```bash
pnpm --dir "packages/client" exec vitest run \
  "src/pi/supervisor.test.ts" \
  "src/pi/agent-session.test.ts" \
  "src/pi/pi-worker.integration.test.ts" \
  "src/pi/session-reader.test.ts" \
  "src/pi/socket-bridge.test.ts"
```

- [ ] **步骤 6：实现 Supervisor 和 Worker**

Supervisor 规则：

1. 所有 Worker Event 同时匹配 `jobId + runId` 才能改变 `activeRun`。
2. interactive request → waiting；`extension_resolved.hasPending === false` → running。
3. Worker 在 matching `agent_settled/prompt_error` 时先清自己的 `active/promptPipeline`，再上报事件；Supervisor 同时产生 `idle` terminal summary并清 activeRun。原始 prompt_error message 只作为实时事件转发。matching abort 权威完成也清 Worker active/pipeline；旧 run 事件不得清新 run。
4. Worker exit 产生 `error` summary。
5. settlement 路由回退 Map 使用 `runId` 作为 key，value 包含 cwd/job/session；避免同一 Job 多 run 冲突。
6. `applyStateAck` 按 runId 清理 accepted terminal；对 closed active run 通过 Supervisor 内部 worker handle 直接发送 `agent.abort`（不经过 Server request/generation lease），只有权威停止成功才清理，并返回 `{allClosed}` 给 bridge。abort timeout/Worker error 时保留摘要并返回 false；bridge 做最多 2 次有界延迟重试，耗尽后执行 `disconnect()` + generation-scoped timer 显式 `connect()` 的受控重连，不得静默遗忘仍可能运行的 Client Agent。
7. 删除 `extension.respond` 请求返回时的乐观 running 更新；只能由 Worker 的 `extension_resolved` 驱动。

Worker 规则：

`PiSessionReader` 增加只读 `state(sessionId): Promise<PiAgentState>`，复用现有 JSONL branch 读取逻辑，只投影最近的 model/thinking 与固定 `{status:"idle",streaming:false,prompting:false,compacting:false,queuedMessages:{steering:[],followUp:[]}}`；若 JSONL 无 thinking，使用协议默认 `off`，但不写回文件。不得加载 SDK Agent services 或 Extensions。Worker 的 `agent.state` 在 `request.runId` 存在且精确匹配 active run 时读取 wrapper；runId 不匹配返回 `PI_CONTROL_FORBIDDEN`，无 runId 才调用 reader.state。

实现固定路径（已核对 SDK 0.84.0）：`startPiAgentSession` 创建 services 时，未决定 trust 一律返回 false，因此先得到不加载项目资源的受限 wrapper；不要在此阶段 ask。Worker 收到 `agent.prompt` 时先绑定 envelope，创建唯一 `promptPipeline` 并立即返回 accepted；pipeline 调用 wrapper 的幂等 `ensureProjectTrust()`：若项目无需信任或已有决定直接返回，未决定时发 confirm。确认返回后该 trust request 已先发 `extension_resolved`；确认 true 时写入 `ProjectTrustStore`，再 shutdown 受限 wrapper并调用现有 `startPiAgentSession` 重建一次，不能让 shutdown 为已解决 request 重复发 cancelled；拒绝/超时保留受限 wrapper；最后发送 Prompt。pipeline 在信任、shutdown、重建、附件下载每个 await 后验证 matching runId。`agent.abort` 先使 matching pipeline 失效、取消 pending UI，再等待 pipeline/Agent 权威停止；pipeline 失效后关闭刚重建 wrapper且不得调用 Prompt。只在现有 wrapper/worker 增加最小字段/方法，不新增 factory/interface，也不调用 SDK 未公开 reload API。

```ts
if (active !== null) {
  throw Object.assign(new Error("Pi project is busy"), {
    code: "PI_PROJECT_BUSY",
  });
}
const cancelToken = { cancelled: false };
active = { jobId, runId, sessionId, cancelToken };
promptPipeline = (async () => {
  const wrapper = await ensureRestrictedWrapper(sessionId);
  if (!isCurrentRun(jobId, runId, cancelToken)) {
    await wrapper.shutdown();
    return;
  }
  await runPromptPipeline(jobId, runId, cancelToken, wrapper, payload);
})();
void promptPipeline.catch((error) => emitPromptError(runId, error));
return { accepted: true };
```

不得保存或恢复 previous envelope；新 Prompt 绑定前必须断言 `active === null`。增加防御测试：即使测试 seam 注入旧 active，新的 Prompt 也返回 `PI_PROJECT_BUSY` 而不是覆盖；pipeline 内 wrapper/附件失败时仅 matching run 可清 active并发 prompt_error，由 Supervisor/Server matching CAS 释放项目锁。

- [ ] **步骤 7：实现每连接代次上报**

`attachPiBridge` 使用递增 generation：

```ts
let connectionGeneration = 0;

async onConnected() {
  const generation = ++connectionGeneration;
  let reported = false;
  const onRegistered = () => {
    if (generation !== connectionGeneration || reported) return;
    reported = true;
    // 每代发送 STATUS_REPORT + PI_STATE
  };
  // REGISTER callback 和旧 ack event 都指向本代 onRegistered
}
```

禁止进程生命周期 `registered` 布尔值。增加 bridge 内私有 `scheduleControlledReconnect(generation)`：先 `socket.disconnect()`；短延迟后仅当 `generation === connectionGeneration && !socket.connected` 时调用公开 `socket.connect()`。不触碰 Socket.IO 私有 Manager/transport；`connect` 事件仍是唯一调用 `onConnected()`、递增 generation并发送 REGISTER 的入口。

- [ ] **步骤 8：运行 GREEN 和构建**

```bash
pnpm --dir "packages/client" exec vitest run "src/pi"
pnpm --dir "packages/client" build
```

- [ ] **步骤 9：检查并提交**

```bash
git add -- \
  "packages/client/src/pi/supervisor.ts" \
  "packages/client/src/pi/supervisor.test.ts" \
  "packages/client/src/pi/agent-session.ts" \
  "packages/client/src/pi/agent-session.test.ts" \
  "packages/client/src/pi/worker.ts" \
  "packages/client/src/pi/pi-worker.integration.test.ts" \
  "packages/client/src/pi/session-reader.ts" \
  "packages/client/src/pi/session-reader.test.ts" \
  "packages/client/src/index.ts" \
  "packages/client/src/pi/socket-bridge.test.ts"
git commit -m "feat(client): 分离 Pi Session Job 与 Prompt Run" --only -- \
  "packages/client/src/pi/supervisor.ts" \
  "packages/client/src/pi/supervisor.test.ts" \
  "packages/client/src/pi/agent-session.ts" \
  "packages/client/src/pi/agent-session.test.ts" \
  "packages/client/src/pi/worker.ts" \
  "packages/client/src/pi/pi-worker.integration.test.ts" \
  "packages/client/src/pi/session-reader.ts" \
  "packages/client/src/pi/session-reader.test.ts" \
  "packages/client/src/index.ts" \
  "packages/client/src/pi/socket-bridge.test.ts"
```

---

### 任务 4：建立原子化 Pi Session Job 状态机

**文件：**

- 修改：`packages/server/src/pi/pi-run.service.ts`
- 测试：`packages/server/src/pi/pi-run.service.test.ts`

**深模块接口：**

```ts
ensureSession(
  actor: ActorContext,
  input: { clientId: string; sessionId: string },
): Promise<void>;

snapshot(
  sessionId: string,
  identityId: string,
): Promise<PiSessionJobSnapshot>;

startRun(
  actor: ActorContext,
  input: { clientId: string; sessionId: string; projectKey: string },
): Promise<{ jobId: string; runId: string }>;

accept(jobId: string, runId: string): Promise<boolean>;
waitForInput(jobId: string, runId: string): Promise<boolean>;
resume(jobId: string, runId: string): Promise<boolean>;
finishRun(jobId: string, runId: string): Promise<boolean>;
completeSession(jobId: string, runId?: string): Promise<boolean>;
beginDelete(
  jobId: string,
  identityId: string,
): Promise<{
  deleteToken: string;
  previousStatus: "idle" | "done" | "error";
  existingReservation: boolean;
}>;
rollbackDelete(jobId: string, deleteToken: string): Promise<boolean>;
commitDelete(jobId: string, deleteToken: string): Promise<boolean>;
failSession(
  jobId: string,
  runId: string,
  code: PiErrorCode,
): Promise<boolean>;
reconcileOpen(
  jobId: string,
  runId: string,
  state: PiAgentState,
): Promise<boolean>;
assertSessionOwner(jobId: string, identityId: string): Promise<void>;
assertCurrentRunOwner(
  jobId: string,
  runId: string,
  identityId: string,
): Promise<void>;
scheduleSettlement(
  jobId: string,
  runId: string,
  onSettle: () => Promise<void>,
): Promise<void>;
cancelSettlement(jobId: string, runId: string): void;
markReconcilePending(clientId: string, socketId: string): Promise<void>;
reconcileGeneration(
  clientId: string,
  socketId: string,
  report: PiStateReport,
): Promise<PiStateAck>;
disconnectGeneration(clientId: string, socketId: string): Promise<boolean>;
withReconciledClient<T>(
  clientId: string,
  operation: (lease: { clientId: string; socketId: string }) => Promise<T>,
): Promise<T>;
withReconciledSocket<T>(
  clientId: string,
  socketId: string,
  operation: () => Promise<T>,
): Promise<T>;
```

当前 run 只以安全 JSON 存在 `Job.payload`；`Job.progress` 保持 `null`，继续只表示文件传输字节进度：

```ts
function runPayload(runId: string): string {
  return JSON.stringify({ runId });
}

function deletePayload(
  deleteToken: string,
  previousStatus: "idle" | "done" | "error",
): string {
  return JSON.stringify({ deleteToken, previousStatus });
}

const EMPTY_SESSION_PAYLOAD = "{}";
```

- [ ] **步骤 1：运行影响分析**

分析 `PiRunService` 全部 public method，重点报告 `createRun`、`settle`、`fail`、`cancel`、`markDisconnected`、`reconcileState`、`assertOwner`、`listActiveByClient` 的直接调用者；旧 `markDisconnected/reconcileState` 将在任务 5 由 generation-aware `disconnectGeneration/reconcileGeneration` 替换。

- [ ] **步骤 2：扩展 Prisma 内存 fake**

支持 `create/findUnique/findMany/update/updateMany`，`updateMany` 必须真实执行 `id/type/status/payload` 条件，以便测试 CAS，而不是无条件修改对象。

- [ ] **步骤 3：写创建、Owner 和独立 run RED**

```ts
it("ensureSession 以 sessionId 幂等创建 idle agent.session", async () => {
  await service.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
  await service.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0]).toMatchObject({
    id: "s1",
    clientId: "c1",
    type: "agent.session",
    status: "idle",
    createdByIdentityId: "user-1",
  });
});

it("并发唯一键冲突后校验已有 Owner，不覆盖 Owner", async () => {
  prisma.job.create.mockRejectedValueOnce({ code: "P2002" });
  prisma.job.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
    id: "s1",
    clientId: "c1",
    type: "agent.session",
    createdByIdentityId: "user-1",
  });
  await expect(service.ensureSession(otherActor, {
    clientId: "c1",
    sessionId: "s1",
  })).resolves.toBeUndefined();
  expect(prisma.job.update).not.toHaveBeenCalled();
});

it("每次 startRun 保持 jobId 并生成新 runId", async () => {
  await service.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
  const first = await service.startRun(actor, {
    clientId: "c1", sessionId: "s1", projectKey: "project-1",
  });
  await service.finishRun(first.jobId, first.runId);
  const second = await service.startRun(actor, {
    clientId: "c1", sessionId: "s1", projectKey: "project-1",
  });
  expect(first.jobId).toBe("s1");
  expect(second.jobId).toBe("s1");
  expect(second.runId).not.toBe(first.runId);
});
```

- [ ] **步骤 4：写完整状态矩阵 RED**

逐项断言：

```text
idle → pending → running → waiting_input → running → idle
done → pending → running
idle → done
done → done（幂等）
pending → done
running/waiting_input → done（必须匹配 runId）
disconnected → done（不需要 Client 在线）
idle/done → pending 时清 finishedAt/result/error*
删除保留：idle/done/error → cancelled + {deleteToken,previousStatus}
删除提交：cancelled + matching deleteToken → cancelled + {}
明确未删除或 session.get 确认仍存在后的删除回滚：cancelled + matching deleteToken → payload 中 previousStatus
删除：pending/running/waiting_input/disconnected → PI_PROJECT_BUSY
```

增加 CAS 竞态测试：

```ts
it("提前到达的 Extension 不被 accept 覆盖", async () => {
  const { jobId, runId } = await start();
  await service.waitForInput(jobId, runId);
  expect(await service.accept(jobId, runId)).toBe(false);
  expect(currentJob()).toMatchObject({ status: "waiting_input" });
});

it("complete 与 settlement 并发时 done 不回退 idle", async () => {
  const { jobId, runId } = await running();
  await service.completeSession(jobId, runId);
  expect(await service.finishRun(jobId, runId)).toBe(false);
  expect(currentJob()).toMatchObject({ status: "done" });
});

it("旧 run 不能修改新 run", async () => {
  const first = await running();
  await service.finishRun(first.jobId, first.runId);
  const second = await service.startRun(actor, input);
  expect(await service.waitForInput(first.jobId, first.runId)).toBe(false);
  expect(currentJob()).toMatchObject({
    status: "pending",
    payload: JSON.stringify({ runId: second.runId }),
    progress: null,
  });
});

it("旧 run 的迟到 activity 不取消新 run settlement", async () => {
  const first = await running();
  await service.scheduleSettlement(first.jobId, first.runId, vi.fn());
  await service.finishRun(first.jobId, first.runId);
  const second = await service.startRun(actor, input);
  const onSecond = vi.fn();
  await service.scheduleSettlement(second.jobId, second.runId, onSecond);
  service.cancelSettlement(first.jobId, first.runId);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(onSecond).toHaveBeenCalledOnce();
});

it("delete 与 startRun 竞争时只有一方取得 CAS", async () => {
  const reservation = await service.beginDelete("s1", actor.identityId);
  await expect(service.startRun(actor, input)).rejects.toMatchObject({
    code: "PI_PROJECT_BUSY",
  });
  expect(await service.commitDelete("s1", reservation.deleteToken)).toBe(true);
});

it("删除失败只用 matching deleteToken 回滚原状态", async () => {
  const reservation = await service.beginDelete("s1", actor.identityId);
  expect(await service.rollbackDelete(
    "s1",
    reservation.deleteToken,
  )).toBe(true);
  expect(currentJob()).toMatchObject({ status: "idle", payload: "{}" });
});
```

- [ ] **步骤 5：写断线、open、readiness 和 PI_STATE 对账 RED**

先覆盖连接代次 lease：

1. `withReconciledClient` 未 ready 时抛 `PI_STATE_PENDING`；`withReconciledSocket` 对旧/pending socket 同样拒绝；
2. operation 持有 lease 跨 await 时，新 socket 的 `markReconcilePending` 必须排队，不能中途切换；operation 结束后才变 pending；
3. 新代次 pending 后，旧 socket 的 `reconcileGeneration` 在任何 DB/锁写入前返回 `PI_STATE_PENDING` ack/error，不修改状态；
4. `disconnectGeneration(clientId,oldSocket)` 在新 socket ready 后返回 false，且不改 Job、锁或 readiness；当前 socket 断线才原子清 readiness并 CAS disconnected。

再覆盖：

1. `pending/running/waiting_input` 断线均进入 `disconnected` 并保留 runId/锁；
2. matching report 恢复 running/waiting；
3. matching idle summary → Job idle、payload 恢复 `{}`、progress 保持 `null`、释放锁、ack acceptedRunIds；
4. DB 活动 run 不在 PI_STATE → `error/PI_CLIENT_RESTARTED`；
5. DB done/cancelled 收到旧 active summary → 不复活，ack closedRunIds；
6. `/open` 时 Job waiting 但 Agent State 无 pending 且仍 active → running；
7. `/open` 时 Job waiting/running 但 Agent State idle → idle 并释放锁；
8. legacy `agent.run` 不自动改写。

- [ ] **步骤 6：写安全错误 RED**

```ts
it("持久化错误按精确 run CAS 且不保存原始 sentinel", async () => {
  const sentinel = "PROMPT=C:\\secret TOKEN=abc123";
  const { jobId, runId } = await running();
  expect(await service.failSession(jobId, runId, "PI_CLIENT_RESTARTED")).toBe(true);
  expect(JSON.stringify(jobs())).not.toContain(sentinel);
  expect(currentJob()).toMatchObject({
    errorCode: "PI_CLIENT_RESTARTED",
    errorMessage: "Client restarted before the Pi run could be recovered",
  });
});

it("旧 run failure 不修改新 run 或释放新锁", async () => {
  const first = await running();
  await service.finishRun(first.jobId, first.runId);
  const second = await service.startRun(actor, input);
  expect(await service.failSession(
    first.jobId,
    first.runId,
    "PI_WORKER_EXITED",
  )).toBe(false);
  expect(currentJob()).toMatchObject({
    status: "pending",
    payload: runPayload(second.runId),
  });
  expect(service.hasLock(second.jobId, second.runId)).toBe(true);
});
```

`safePiErrorMessage(code)` 必须是 exhaustively tested allowlist；未知 code 固定映射为 `Pi session failed`。禁止接受原始 message 参数。

- [ ] **步骤 7：运行 RED**

```bash
pnpm --dir "packages/server" exec vitest run "src/pi/pi-run.service.test.ts"
```

- [ ] **步骤 8：实现 CAS 状态机**

核心 CAS 示例：

```ts
const updated = await this.prisma.job.updateMany({
  where: {
    id: jobId,
    payload: runPayload(runId),
    status: { in: [JobStatus.RUNNING, JobStatus.WAITING_INPUT] },
  },
  data: {
    status: JobStatus.IDLE,
    payload: EMPTY_SESSION_PAYLOAD,
    progress: null,
    finishedAt: null,
  },
});
if (updated.count === 0) return false;
this.releaseLock(jobId, runId);
return true;
```

实现规则：

1. `ensureSession` 遇到 Prisma `P2002` 后读取 winner，并验证 clientId/type；绝不覆盖 Owner。
2. `startRun` 在第一个 await 前放置 provisional 内存锁；DB CAS 失败立即释放。只接受 idle/done；error 不可自动重开。若 Job 仍有上一 run，Controller 必须先执行权威 idle 对账，不能由 `startRun` 猜测。
3. `startRun` 清空 `result/finishedAt/errorCode/errorMessage`，将 payload 精确写为 `{runId}`、progress 写为 `null`，不保存 imageCount/projectKey/path；idle/done/error/cancelled 转换将 payload 恢复为 `{}`。
4. `accept` 只做 pending → running；若当前已 waiting，返回 false 而不覆盖。
5. 所有转换使用 `updateMany` CAS；成功才调整锁。每个内存锁记录 `jobId + runId`，`releaseLock(jobId, runId)` 只释放精确匹配者，旧 run 不得释放新 run 锁。
6. `completeSession`：active 状态必须提供精确 runId；pending/active/disconnected 均可 CAS done；done 幂等。
7. `beginDelete` 只接受 fixed Owner 且状态为 idle/done/error，或返回已有同 Owner reservation；原子写入 `cancelled + {deleteToken,previousStatus}` 后才算取得删除权。`rollbackDelete/commitDelete` 都要求 matching token；rollback 从 payload 读取 previousStatus，不能接受调用方伪造；活动状态抛 `PI_PROJECT_BUSY`。
8. `disconnectGeneration` 在 matching 当前 socket 的 generation lease 内将 pending/running/waiting_input 精确 CAS 为 disconnected 并保留 runId/锁；旧 socket 不调用任何 Pi disconnected 更新。
9. `reconcileGeneration` 返回 `{acceptedRunIds,closedRunIds,reportAgain}`；内部 private `reconcileState` 不可绕过 socket generation。
10. `snapshot` 只返回安全字段和 `isOwner`；删除保留期间不暴露 deleteToken。
11. `listActiveByClient` 只查 `agent.session` 的 pending/running/waiting/disconnected，并从 payload 解析唯一允许的 `runId`；畸形 payload 不能被当成活动 run。
12. settlement timer Map 以 `${jobId}:${runId}` 为 key；schedule/cancel/timer callback 均校验精确 runId。
13. per-client 串行队列保护 generation/readiness 与短期 REST lease；`withReconciledClient` operation 结束前 REGISTER 不能切换 socket；inbound PI_EVENT 用 `withReconciledSocket(clientId,socketId)` 在同一队列内验证并处理。`disconnectGeneration` 只有 matching 当前 socket 才原子清 readiness、调用 run-scoped disconnected CAS；旧 socket 无副作用。
14. `reconcileGeneration(clientId,socketId,report)` 是唯一 PI_STATE 入口：在同一队列临界区内先验证 socket 仍是 pending 当前代次，再执行所有 DB CAS/锁重建，最后无冲突且无需关闭 Client 活动 run时才原子标 ready并返回 ack。旧 socket 在任何写入前退出。若同一 projectKey 报告两个活动 run，或 done/cancelled Job 仍报告 active run，精确收敛并返回 closedRunIds、`reportAgain:true`，本次不 ready。Client 成功 abort 后立即二次 PI_STATE；只有新报告中相关 run 消失才 ready。

为保证本任务提交后 Server 可构建，暂时保留现有 `createRun/settle/fail/cancel/assertOwner` 作为明确标注的迁移 adapter；旧 `accept(jobId)`、`waitForInput(jobId)`、`resume(jobId)` 也保留 overload，只能查询并操作 legacy `agent.run`（其 jobId/runId 相同），不得猜测 `agent.session` 的独立 runId。新的 run-scoped settlement 签名在本任务直接实现，Broker 当前旧调用同步由 adapter 包装到 legacy run。`reconcileState` 降为 private helper，只能从 `reconcileGeneration` 的 matching-socket 临界区调用。任务 5/6 迁移调用后必须删除全部 adapter，并通过 grep 证明无生产调用。

- [ ] **步骤 9：运行 GREEN 和 Server build**

```bash
pnpm --dir "packages/server" exec vitest run "src/pi/pi-run.service.test.ts"
pnpm --dir "packages/server" build
```

- [ ] **步骤 10：检查并提交**

```bash
git add -- "packages/server/src/pi/pi-run.service.ts" "packages/server/src/pi/pi-run.service.test.ts"
git commit -m "feat(server): 建立 Pi Session Job 状态机" --only -- \
  "packages/server/src/pi/pi-run.service.ts" \
  "packages/server/src/pi/pi-run.service.test.ts"
```

---

### 任务 5：接入 Broker、Gateway 和重连对账

**文件：**

- 修改：`packages/server/src/pi/pi-event-broker.ts`
- 测试：`packages/server/src/pi/pi-event-broker.test.ts`
- 修改：`packages/server/src/pi/pi-request-broker.ts`
- 测试：`packages/server/src/pi/pi-request-broker.test.ts`
- 修改：`packages/server/src/events/client.gateway.ts`
- 测试：`packages/server/src/events/client.gateway.test.ts`
- 修改：`packages/server/src/pi/pi-flow.integration.test.ts`

- [ ] **步骤 1：运行影响分析**

分析 `PiEventBroker.publish/scheduleSettlementCheck`、旧 `handleState` 的调用者、`PiRequestBroker.bindEmitter/request/resolve/disconnect`、`ClientGateway.afterInit/handleRegister/handlePiResponse/handlePiEvent/handlePiState/handleDisconnect` 和 `PiRunService` generation lease methods。任务内删除 `PiEventBroker.handleState`，PI_STATE 只进 `PiRunService.reconcileGeneration`。

- [ ] **步骤 2：写 Broker RED**

```ts
it("interactive request 使用 jobId + runId 进入 waiting", async () => {
  await broker.publish(makeEvent({
    jobId: "s1",
    runId: "r1",
    event: { type: "extension_request", sessionId: "s1", ui: confirmUi },
  }));
  expect(runs.waitForInput).toHaveBeenCalledWith("s1", "r1");
});

it("仍有排队 Extension 时不恢复 running", async () => {
  await broker.publish(makeEvent({
    jobId: "s1",
    runId: "r1",
    event: {
      type: "extension_resolved",
      sessionId: "s1",
      requestId: "ui-1",
      reason: "answered",
      hasPending: true,
    },
  }));
  expect(runs.resume).not.toHaveBeenCalled();
});

it("最后一个 Extension 解决后恢复 running", async () => {
  await broker.publish(makeEvent({
    jobId: "s1",
    runId: "r1",
    event: {
      type: "extension_resolved",
      sessionId: "s1",
      requestId: "ui-2",
      reason: "timeout",
      hasPending: false,
    },
  }));
  expect(runs.resume).toHaveBeenCalledWith("s1", "r1");
});

it("settlement 只把当前 run 收敛为 idle", async () => {
  const { broker, runs, getOnSettle } = makeSettleBroker(idleAgentState);
  await broker.publish(makeEvent({
    jobId: "s1",
    runId: "r1",
    event: { type: "agent_settled", sessionId: "s1" },
  }));
  await getOnSettle()!();
  expect(runs.scheduleSettlement).toHaveBeenCalledWith(
    "s1",
    "r1",
    expect.any(Function),
  );
  expect(runs.finishRun).toHaveBeenCalledWith("s1", "r1");
  expect(runs.completeSession).not.toHaveBeenCalled();
});

it("run-1 迟到 activity 不取消 run-2 settlement", async () => {
  await broker.publish(makeEvent({
    jobId: "s1",
    runId: "r1",
    event: { type: "message_update", sessionId: "s1", message: {} },
  }));
  expect(runs.cancelSettlement).toHaveBeenCalledWith("s1", "r1");
  expect(runs.cancelSettlement).not.toHaveBeenCalledWith("s1", "r2");
});
```

保留 `notify` 不 wait、不取消 settlement 的回归测试。`prompt_error` 只调用 `finishRun(jobId,runId)`；code/message 继续随当前 SSE 事件展示，不传给持久化状态机。删除旧 `handleState` 测试，并在 Gateway/RunService 测试中覆盖唯一的 `reconcileGeneration` 路径。

- [ ] **步骤 3：写 Gateway/PI_STATE ack RED**

```ts
it("PI_STATE 返回 accepted 和 closed run IDs", async () => {
  piRuns.reconcileGeneration.mockResolvedValue({
    acceptedRunIds: ["run-idle"],
    closedRunIds: ["run-stale"],
    reportAgain: false,
  });
  const ack = vi.fn();
  await gateway.handlePiState(socket, report, ack);
  expect(ack).toHaveBeenCalledWith({
    acceptedRunIds: ["run-idle"],
    closedRunIds: ["run-stale"],
    reportAgain: false,
  });
});

it("REGISTER 在 ack 前进入 pending generation", async () => {
  const order: string[] = [];
  piRuns.markReconcilePending.mockImplementation(async () => order.push("pending"));
  ack.mockImplementation(() => order.push("ack"));
  await gateway.handleRegister(socket, registration, ack);
  expect(piRuns.markReconcilePending).toHaveBeenCalledWith("c1", socket.id);
  expect(order).toEqual(["pending", "ack"]);
});

it("合法 PI_STATE 在单一 generation 临界区对账并 ready", async () => {
  piRuns.reconcileGeneration.mockResolvedValue({
    acceptedRunIds: [],
    closedRunIds: [],
    reportAgain: false,
  });
  await gateway.handlePiState(socket, report, ack);
  expect(piRuns.reconcileGeneration).toHaveBeenCalledWith("c1", socket.id, report);
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ reportAgain: false }));
});

it("旧 socket 的迟到 PI_EVENT 不进入状态机", async () => {
  oldSocket.data.clientId = "c1";
  piRuns.withReconciledSocket.mockRejectedValue(
    Object.assign(new Error("stale"), { code: "PI_STATE_PENDING" }),
  );
  await gateway.handlePiEvent(oldSocket, event);
  expect(piEvents.publish).not.toHaveBeenCalled();
});

it("Pi Response 不依赖已被新 REGISTER 覆盖的 DB socketId", async () => {
  const promise = broker.request({ clientId: "c1", socketId: "socket-1" }, request);
  await gateway.handlePiResponse(oldSocket, response);
  await expect(promise).resolves.toEqual(response);
  expect(clientService.getClientIdBySocketId).not.toHaveBeenCalled();
});

it("Pi request 只投递 lease socket，其他 socket 响应不能 resolve", async () => {
  const promise = broker.request({ clientId: "c1", socketId: "socket-2" }, request);
  expect(emit).toHaveBeenCalledWith("socket-2", request);
  broker.resolve("socket-1", response);
  expect(isPending(promise)).toBe(true);
  broker.resolve("socket-2", response);
  await expect(promise).resolves.toEqual(response);
});

it("旧 socket 断线不失败新 socket 的 pending request", async () => {
  const promise = broker.request({ clientId: "c1", socketId: "socket-2" }, request);
  broker.disconnect("socket-1");
  expect(isPending(promise)).toBe(true);
  broker.resolve("socket-2", response);
  await expect(promise).resolves.toEqual(response);
});

it("当前 socket 断线先失败 pending request 再取得 generation queue", async () => {
  const order: string[] = [];
  broker.disconnect.mockImplementation(() => order.push("request-disconnected"));
  piRuns.disconnectGeneration.mockImplementation(async () => {
    order.push("generation-disconnected");
    return true;
  });
  await gateway.handleDisconnect(socket);
  expect(order).toEqual(["request-disconnected", "generation-disconnected"]);
});

it("projectKey 冲突要求 Client 关闭后立即二次报告", async () => {
  piRuns.reconcileGeneration.mockResolvedValue({
    acceptedRunIds: [],
    closedRunIds: ["run-1", "run-2"],
    reportAgain: true,
  });
  await gateway.handlePiState(socket, conflictingReport, ack);
  expect(piRuns.reconcileGeneration).toHaveBeenCalledWith(
    "c1",
    socket.id,
    conflictingReport,
  );
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ reportAgain: true }));
});

it("断线只关闭 matching 当前 generation", async () => {
  piRuns.disconnectGeneration.mockResolvedValue(false);
  await gateway.handleDisconnect(oldSocket);
  expect(piRuns.disconnectGeneration).toHaveBeenCalledWith("c1", oldSocket.id);
  expect(currentJob()).toMatchObject({ status: "running" });
});
```

- [ ] **步骤 4：写 loopback RED**

在 `pi-flow.integration.test.ts` 用 `jobId: session-1`、`runId: run-1` 覆盖：

1. settlement → idle，不是 done；
2. request → waiting → resolved → running → idle；
3. run-1 迟到 settlement 不影响 run-2；
4. complete 与 settlement 交错后保持 done；
5. Server 重启锁为空时，REGISTER 与 PI_STATE 之间所有 PI_REQUEST REST 返回 `PI_STATE_PENDING`；合法 PI_STATE 对账重建 `jobId+runId` 项目锁后才允许；同 projectKey 冲突报告返回 closedRunIds/reportAgain，Client abort 后二次 PI_STATE 才 ready；
6. REST lease 跨 await 时新 REGISTER 排队；本次 request 精确发往 lease.socketId，旧/新 socket 响应不能串线；
7. socket-2 ready 后 socket-1 迟到 disconnect 不改变 Job/锁/readiness；
8. Prisma calls 和 Job 字段不含 Prompt、thinking、路径、token、Extension 输入 sentinels；
9. 原始 `prompt_error.message` sentinel 不进入持久化字段。

- [ ] **步骤 5：运行 RED**

```bash
pnpm --dir "packages/server" exec vitest run \
  "src/pi/pi-event-broker.test.ts" \
  "src/pi/pi-request-broker.test.ts" \
  "src/events/client.gateway.test.ts" \
  "src/pi/pi-run.service.test.ts" \
  "src/pi/pi-flow.integration.test.ts"
```

- [ ] **步骤 6：实现路由**

```ts
if (interactiveExtension) {
  await this.runs.waitForInput(jobId, runId);
}
if (event.event.type === "extension_resolved" && !event.event.hasPending) {
  await this.runs.resume(jobId, runId);
}
if (event.event.type === "prompt_error") {
  this.runs.cancelSettlement(jobId, runId);
  await this.runs.finishRun(jobId, runId);
}
```

settlement callback 必须在 `withReconciledClient` generation lease 内按 lease.socketId 请求 `agent.state`，再对 `response.data` 调用 `parsePiAgentState()`、检查 idle/queue empty，最后 `finishRun(jobId,runId)`。REGISTER 在该短查询/CAS 完成后才切代；畸形 state 不能 settle。`prompt_error` 通过 SSE 给当前页面，`finishRun` 不接收或持久化错误信息。

在已有 `PiRunService` 内增加 per-client 短串行队列和 generation/readiness。`markReconcilePending` 通过队列在 REGISTER ack 前切换 socket；`reconcileGeneration(clientId,socketId,report)` 在同一队列临界区先校验 pending 当前 socket，再完成私有 `reconcileState`、锁重建和 ready 提交；旧 socket 在任何写入前退出。Controller 使用 `withReconciledClient` 把一次短 REST 编排包在同一队列里。复用已有深模块，不新增 service、DB 字段或定时器。

Gateway 注册成功时设置 `socket.data.clientId = data.clientId`；Pi response/event/state/disconnect 使用这个经 REGISTER 绑定的值和 generation map，不依赖可能已被新 REGISTER 覆盖的 DB `socketId` 查询。`PiRequestBroker.bindEmitter` 改为 `(socketId,request)`，pending request 同时记录 `{clientId,socketId}`；`request(lease,request)` 接收 generation lease。Gateway 用 `this.server.to(socketId).emit` 精确下发，`handlePiResponse` 直接以 `client.id` 解析，只有 response socket 与 pending lease socket 相同才 resolve；不要让 response handler 获取 generation queue，否则会与正在等待该 response 的 REST lease 死锁。`handleDisconnect` 必须先在 generation 队列外调用 `piRequests.disconnect(client.id)`，立即失败该 socket 的 pending REST request并释放其 lease，再 await `disconnectGeneration`；否则会由正在等待 response 的 lease 阻塞到超时。`disconnect(socketId)` 只影响该 socket，旧 socket 断线不能失败新 socket 请求。`handlePiEvent` 用 `runs.withReconciledSocket(socket.data.clientId,client.id,() => publish(...))`；pending/旧 socket 事件忽略，权威恢复依赖 PI_STATE/Session JSONL。禁止继续向 clientId room 广播 Pi request。

Gateway `handlePiState()` 只调用 `PiRunService.reconcileGeneration(clientId,socket.id,report)` 并原样 ack；删除 `PiEventBroker.handleState`，不得保留第二条对账路径，也不得分开调用 reconcile/mark-ready。冲突时 ack `closedRunIds + reportAgain:true` 但不 ready。`disconnectGeneration` 只有 matching 当前 socket 时才在队列内原子清 readiness并 CAS disconnected；旧 socket 断线无副作用。

- [ ] **步骤 7：运行 GREEN 和 build**

```bash
pnpm --dir "packages/server" exec vitest run \
  "src/pi/pi-event-broker.test.ts" \
  "src/pi/pi-request-broker.test.ts" \
  "src/events/client.gateway.test.ts" \
  "src/pi/pi-run.service.test.ts" \
  "src/pi/pi-flow.integration.test.ts"
pnpm --dir "packages/server" build
```

- [ ] **步骤 8：检查并提交**

```bash
git add -- \
  "packages/server/src/pi/pi-event-broker.ts" \
  "packages/server/src/pi/pi-event-broker.test.ts" \
  "packages/server/src/pi/pi-request-broker.ts" \
  "packages/server/src/pi/pi-request-broker.test.ts" \
  "packages/server/src/events/client.gateway.ts" \
  "packages/server/src/events/client.gateway.test.ts" \
  "packages/server/src/pi/pi-run.service.ts" \
  "packages/server/src/pi/pi-run.service.test.ts" \
  "packages/server/src/pi/pi-flow.integration.test.ts"
git commit -m "fix(server): 收敛 Pi Session 等待与重连状态" --only -- \
  "packages/server/src/pi/pi-event-broker.ts" \
  "packages/server/src/pi/pi-event-broker.test.ts" \
  "packages/server/src/pi/pi-request-broker.ts" \
  "packages/server/src/pi/pi-request-broker.test.ts" \
  "packages/server/src/events/client.gateway.ts" \
  "packages/server/src/events/client.gateway.test.ts" \
  "packages/server/src/pi/pi-run.service.ts" \
  "packages/server/src/pi/pi-run.service.test.ts" \
  "packages/server/src/pi/pi-flow.integration.test.ts"
```

---

### 任务 6：实现 Session Job REST、SDK 和调度边界

**文件：**

- 修改：`packages/server/src/pi/pi.controller.ts`
- 测试：`packages/server/src/pi/pi.controller.test.ts`
- 修改：`packages/server/src/pi/pi-run.service.ts`
- 测试：`packages/server/src/pi/pi-run.service.test.ts`
- 修改：`packages/server/src/job/job.scheduler.ts`
- 测试：`packages/server/src/job/job.scheduler.test.ts`
- 修改：`packages/sdk/src/pi.ts`
- 测试：`packages/sdk/src/pi.test.ts`

**REST：**

```http
POST /api/clients/:clientId/pi/agent/:sessionId/open
POST /api/clients/:clientId/pi/agent/:sessionId/complete
```

**SDK：**

```ts
open(
  clientId: string,
  sessionId: string,
  cwdRef: PiCwdRef,
  signal?: AbortSignal,
): Promise<PiSessionOpenResult>;

complete(
  clientId: string,
  sessionId: string,
  runId?: string,
  signal?: AbortSignal,
): Promise<PiSessionJobSnapshot>;
```

- [ ] **步骤 1：运行影响分析**

分析 `PiController.requirePiClient/newSession/openSession/prompt/abort/extensionResponse/forkSession/cloneSession/deleteSession/setModel/setThinking`、`PiRunService.withReconciledClient`、`createPiApi`、`JobScheduler.tryDispatch`。

- [ ] **步骤 2：写 Controller RED**

扩展 fake service，加入新接口。覆盖：

```ts
it("newSession 创建同 ID Session Job", async () => {
  requests.request.mockResolvedValueOnce({
    ok: true,
    data: { sessionId: "s1" },
  });
  const result = await controller.newSession("c1", CWD_BODY, actor);
  expect(runs.ensureSession).toHaveBeenCalledWith(actor, {
    clientId: "c1",
    sessionId: "s1",
  });
  expect(result).toEqual({ sessionId: "s1", jobId: "s1" });
});

it("open 验证 Session、补建 Job、原子对账并返回双权威状态", async () => {
  requests.request
    .mockResolvedValueOnce({ ok: true, data: sessionDetail })
    .mockResolvedValueOnce({ ok: true, data: waitingAgentState });
  const result = await controller.openSession("c1", "s1", CWD_BODY, actor);
  expect(runs.withReconciledClient).toHaveBeenCalledWith(
    "c1",
    expect.any(Function),
  );
  expect(runs.ensureSession).toHaveBeenCalled();
  expect(runs.reconcileOpen).toHaveBeenCalledWith("s1", "run-1", waitingAgentState);
  expect(result).toEqual({ job: jobSnapshot, agentState: waitingAgentState });
});

it("没有活动 run 的 open 只返回只读 idle state", async () => {
  runs.snapshot.mockResolvedValue({ ...idleSnapshot, runId: null });
  requests.request
    .mockResolvedValueOnce({ ok: true, data: sessionDetail })
    .mockResolvedValueOnce({ ok: true, data: idleAgentState });
  await controller.openSession("c1", "s1", CWD_BODY, actor);
  expect(requests.request).toHaveBeenLastCalledWith("c1", expect.objectContaining({
    action: "agent.state",
    sessionId: "s1",
    runId: undefined,
  }));
});

it("Prompt 创建独立 runId 并保留稳定 jobId", async () => {
  runs.startRun.mockResolvedValue({ jobId: "s1", runId: "run-1" });
  await controller.prompt("c1", "s1", promptBody, actor);
  expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: "s1",
    jobId: "s1",
    runId: "run-1",
    event: expect.objectContaining({ type: "run_created", runId: "run-1" }),
  }));
});

it.each(["success", "timeout", "disconnect"])(
  "pending complete 后即使 dispatch %s 也补发同 run abort",
  async (outcome) => {
    arrangeDispatchOutcome(outcome);
    runs.snapshot.mockResolvedValue({ ...doneSnapshot, runId: null });
    await expect(controller.prompt("c1", "s1", promptBody, actor)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PI_CONTROL_FORBIDDEN" }),
    });
    expect(requests.request).toHaveBeenCalledWith("c1", expect.objectContaining({
      action: "agent.abort",
      jobId: "s1",
      runId: "run-1",
    }));
  },
);
```

还要覆盖：

1. 协议版本缺失/错误时 `/open`、Prompt、控制操作返回 `PI_CLIENT_UNSUPPORTED`；
2. fixed Owner；非 Owner 的全部 mutation 在 Client request 前失败；
3. new/fork/clone 的 `ensureSession` 失败时重试，仍失败则 Client `session.delete` 补偿；
4. delete 活动 Session 在 Client delete 前失败；idle delete 先 `beginDelete`，Client 明确未执行或 `session.get` 确认仍存在才 matching-token rollback，成功/已不存在 commit；timeout/disconnect 保留 reservation并可重试；delete 与 startRun 并发只有一方成功；
5. abort 带 runId，Client 权威停止成功后 `finishRun`；
6. idle complete 直接 done；running/waiting complete 先权威 abort；pending complete 直接 done；disconnected complete 不请求 Client；
7. complete done 幂等；延迟 abort 期间 settlement/new Prompt 抢先时，complete 不修改或 abort 新 run并返回稳定冲突；
8. REGISTER 与合法 PI_STATE 之间，所有需要 PI_REQUEST 的 REST 返回 `PI_STATE_PENDING`，不发送 Client request；入口获得 lease 后，第一个 awaited Client response 前模拟新 REGISTER，断言 REGISTER 排队，旧 operation 只投递 lease.socketId 并完成后才切代；
9. `/open`/`complete` 手工拒绝非对象 body、空/非字符串/超长 runId 和畸形 cwd；
10. raw Client error sentinel 不交给持久化状态机；
11. `requestOnce` 签名改为 `requestOnce(lease,request)`；Pi mutation/open/prompt/settlement 不允许再传裸 clientId，TypeScript 迫使调用方持有 generation lease。

- [ ] **步骤 3：写 SDK RED**

```ts
await client.pi.agent.open("c1", "s1", CWD);
expect(request).toHaveBeenCalledWith(
  "POST",
  "/api/clients/c1/pi/agent/s1/open",
  CWD,
  undefined,
);

await client.pi.agent.complete("c1", "s1", "run-1");
expect(request).toHaveBeenCalledWith(
  "POST",
  "/api/clients/c1/pi/agent/s1/complete",
  { runId: "run-1" },
  undefined,
);

await client.pi.agent.abort("c1", "s1", "run-1");
expect(request).toHaveBeenCalledWith(
  "POST",
  "/api/clients/c1/pi/agent/s1/abort",
  { runId: "run-1" },
);
```

`state()` 对响应调用 `parsePiAgentState()`；run-scoped steer/follow-up/abort/compact/abortCompact/extensionResponse body 都使用 `runId`，REST 自行推导 `jobId = sessionId`。

- [ ] **步骤 4：写 Scheduler RED**

```ts
expect(prisma.job.count).toHaveBeenCalledWith({
  where: {
    clientId: "c1",
    status: "running",
    type: { notIn: ["agent.run", "agent.session"] },
  },
});
expect(prisma.job.findFirst).toHaveBeenCalledWith(expect.objectContaining({
  where: {
    clientId: "c1",
    status: "pending",
    type: { notIn: ["agent.run", "agent.session"] },
  },
}));
```

- [ ] **步骤 5：运行 RED**

```bash
pnpm --dir "packages/server" exec vitest run \
  "src/pi/pi.controller.test.ts" \
  "src/job/job.scheduler.test.ts"
pnpm --dir "packages/sdk" exec vitest run "src/pi.test.ts"
```

- [ ] **步骤 6：实现 Controller 编排**

1. `requirePiClient` 要求 `sessionJobProtocolVersion === 1`。凡是会发送 `PI_REQUEST` 的 REST（包括 session list/history/model 等只读请求）都将完整编排放入 `runs.withReconciledClient(clientId,async (lease)=>...)`，并将 lease 传给每次 `requestOnce`；只有纯读 Server DB 的 capability/SSE 建连不取 lease。未 ready 的短窗口统一返回 `PI_STATE_PENDING`，禁止裸 clientId room 路由或只在入口做一次布尔检查。
2. new/fork/clone：完整流程也持有 generation lease。Client 创建 → `ensureSession`；P2002 由 service 处理；其他 DB 失败有限重试一次，仍失败则按同 lease best-effort Client delete，再抛原错误，绝不返回无 Job 的成功响应。删除 timeout/disconnect 时不声称已清理；若残留远程 Session，它继续出现在 Session 列表，并在后续首次成功 `/open` 按旧 Session 规则惰性补建 Job/Owner。首版不新增补偿事务表或后台协调器。
3. `/open`：验证 `session.get` → ensure Job → 取 snapshot。若有 runId，以精确 envelope 请求 `agent.state`，调用 `parsePiAgentState` → `reconcileOpen(jobId, runId, state)`；若无 runId，仍调用现有 `agent.state`，但 Client Worker 必须走 SessionReader-only 分支返回 JSONL 的 model/thinking + 确定 idle，不创建 wrapper、不加载 Extension、不恢复 pending UI。返回最新 `{job,agentState}`。
4. Prompt：整个流程持有 generation lease。若 Job 仍有上一 `runId`，先用该 lease+envelope 查询并 `parsePiAgentState()`；若权威 idle/队列空/无 pending Extension，则 `finishRun` 提前收敛，否则返回 `PI_PROJECT_BUSY`。随后 `startRun` → publish run_created → 按 lease.socketId 精确 Client request → `accept`。明确失败且 Worker 未开始则 matching `finishRun` 回 idle；timeout 等不确定结果查询同 lease 的 `agent.state`：未开始→idle，active→accept/reconcile，socket 断开→matching disconnected。所有 success/error/timeout/disconnect 均 finally-style 复查；若 Job 已 done/cancelled，best-effort 同 runId abort。CAS 失败时绝不猜测或影响新 run。
5. abort：`assertCurrentRunOwner` → Client `agent.abort` 权威成功 → `finishRun`。
6. complete：idle/error/done 直接 service complete；pending/disconnected 用 CAS 直接 complete；running/waiting 先 Client abort 权威成功再 complete。异步 abort 后若 matching-run CAS 失败，重新 snapshot；若新 run 已存在，返回稳定冲突且绝不 abort 新 run。
7. delete：`beginDelete` 取得或复用 CAS reservation → 按 lease.socketId 幂等 Client delete → 确认成功/Session 不存在则 `commitDelete`。只有 Client 明确报告“未执行”，或随后 `session.get` 权威确认仍存在，才 matching-token `rollbackDelete`；timeout/disconnect 保留 reservation，禁止 Prompt，Owner 可重试。未取得 reservation 不得调用 Client。
8. rename/fork/clone/navigate/model/thinking 都加 `@Actor` 和 fixed Owner 校验。
9. `/open`、`/complete` 和 run-scoped body 手工校验类型/长度；Server 错误映射保留 allowlist code，不把原始 Client message 传给 Job service 或日志。

- [ ] **步骤 7：实现 SDK 与 Scheduler**

新增 `open/complete`，收紧返回类型为 `PiSessionCreated/PiSessionOpenResult/PiSessionJobSnapshot`。保留 session-level `eventsPath`。`running()` 可暂留兼容，但 Frontend 后续不再使用。

Scheduler 的 `runningCount` 和 pending `findFirst` 都排除 `agent.run` 与 `agent.session`，避免长期 Pi Session 占满普通任务并发额度。

- [ ] **步骤 8：删除迁移 adapter**

从 `PiRunService` 删除任务 4 暂留的 `createRun/settle/fail/cancel/assertOwner` 旧接口，以及单参数 `accept/waitForInput/resume` overload，并运行：

```bash
rg -n '\.(createRun|settle|fail|cancel|assertOwner)\(' "packages/server/src"
rg -n '\.(accept|waitForInput|resume)\([^,\n]+\)' "packages/server/src"
```

生产代码必须零匹配旧接口；测试只允许测试名称文本，不允许旧调用。

- [ ] **步骤 9：运行 GREEN 和构建**

```bash
pnpm --dir "packages/server" exec vitest run \
  "src/pi/pi.controller.test.ts" \
  "src/job/job.scheduler.test.ts" \
  "src/pi/pi-run.service.test.ts" \
  "src/pi/pi-event-broker.test.ts" \
  "src/pi/pi-flow.integration.test.ts"
pnpm --dir "packages/sdk" test
pnpm --dir "packages/server" build
pnpm --dir "packages/sdk" build
```

- [ ] **步骤 10：检查并提交**

```bash
git add -- \
  "packages/server/src/pi/pi.controller.ts" \
  "packages/server/src/pi/pi.controller.test.ts" \
  "packages/server/src/pi/pi-run.service.ts" \
  "packages/server/src/pi/pi-run.service.test.ts" \
  "packages/server/src/job/job.scheduler.ts" \
  "packages/server/src/job/job.scheduler.test.ts" \
  "packages/sdk/src/pi.ts" \
  "packages/sdk/src/pi.test.ts"
git commit -m "feat(pi): 添加 Session Job 控制接口" --only -- \
  "packages/server/src/pi/pi.controller.ts" \
  "packages/server/src/pi/pi.controller.test.ts" \
  "packages/server/src/pi/pi-run.service.ts" \
  "packages/server/src/pi/pi-run.service.test.ts" \
  "packages/server/src/job/job.scheduler.ts" \
  "packages/server/src/job/job.scheduler.test.ts" \
  "packages/sdk/src/pi.ts" \
  "packages/sdk/src/pi.test.ts"
```

---

### 任务 7：让 Frontend 以 Session Job 为权威，并限制 Observer

**文件：**

- 修改：`packages/frontend/src/pi/use-pi-session.ts`
- 测试：`packages/frontend/src/pi/use-pi-session.test.tsx`
- 修改：`packages/frontend/src/pi/pi-reconnect.integration.test.tsx`
- 修改：`packages/frontend/src/pi/pi-run-details.tsx`
- 测试：`packages/frontend/src/pi/pi-run-details.test.tsx`
- 修改：`packages/frontend/src/pi/pi-chat-input.tsx`
- 创建：`packages/frontend/src/pi/pi-chat-input.test.tsx`
- 修改：`packages/frontend/src/pi/pi-session-sidebar.tsx`
- 创建：`packages/frontend/src/pi/pi-session-sidebar.test.tsx`
- 修改：`packages/frontend/src/pages/pi-panel.tsx`
- 测试：`packages/frontend/src/pages/pi-panel.test.tsx`
- 修改：`packages/frontend/src/components/notification-bell.tsx`
- 测试：`packages/frontend/src/components/notification-bell.test.tsx`
- 修改：`packages/frontend/src/pages/jobs-page.tsx`
- 测试：`packages/frontend/src/pages/jobs-page.test.tsx`
- 修改：`packages/frontend/src/pages/dashboard-page.tsx`
- 创建：`packages/frontend/src/pages/dashboard-page.test.tsx`

**Hook 接口：**

```ts
export type PiSessionStatus =
  | "idle"
  | "loading"
  | "running"
  | "waiting_input"
  | "done"
  | "disconnected"
  | "error";

export interface PiSessionState {
  // 保留现有字段
  job: PiSessionJobSnapshot | null;
}

export interface PiSessionActions {
  // 保留现有 action
  complete(): Promise<void>;
}
```

- [ ] **步骤 1：运行影响分析**

分析 `usePiSession`、`PiSessionState`、`PiSessionActions`、`PiRunDetails`、`PiChatInput`、`PiSessionSidebar`、`PiPanel`、`NotificationBell`、`JobsPage`、`DashboardPage`。

- [ ] **步骤 2：扩展 Hook fake 并写 RED**

默认 fake：

```ts
open: vi.fn(async () => ({
  job: {
    jobId: "s1",
    sessionId: "s1",
    status: "idle",
    runId: null,
    ownerName: "User",
    isOwner: true,
  },
  agentState: idleAgentState,
})),
prompt: vi.fn(async () => ({
  jobId: "s1",
  sessionId: "s1",
  runId: "run-1",
})),
complete: vi.fn(async () => ({
  jobId: "s1",
  sessionId: "s1",
  status: "done",
  runId: null,
  ownerName: "User",
  isOwner: true,
})),
```

覆盖：

1. `openSession` 使用 `agent.open`，不再调用 `pi.running`；
2. done Job + idle Agent → UI done；
3. 仅 matching run 的 `/open.agentState.pendingExtension` 恢复弹框；无 runId 的只读 open 不产生弹框；
4. waiting Job 但 open 已对账为 idle → 可立即发送 Prompt，不出现 `PI_PROJECT_BUSY`；
5. done 发送 → running，并绑定独立 runId；
6. matching agent_settled → idle；旧 run 事件不影响新 run；
7. `extension_resolved` 只关闭相同 requestId；新 request 不被旧 resolved 关闭；
8. abort 传当前 runId并回 idle；complete 活动后回 done；
9. error 禁止 send；
10. Session generation guard 覆盖 `/open`、history、model、Extension response；
11. 上一 run 仍处于 settlement grace 时立即发送下一条普通 Prompt，Server 权威确认上一 run idle 后提前收敛并接受新 run。

刷新恢复测试：

```ts
(pi.agent.open as Mock).mockResolvedValueOnce({
  job: { ...waitingJob, runId: "run-1" },
  agentState: {
    ...idleAgentState,
    status: "waiting_for_extension_input",
    prompting: true,
    pendingExtension: {
      requestId: "ui-1",
      extensionId: "project-trust",
      kind: "confirm",
      title: "Project Trust",
      message: "是否信任？",
    },
  },
});
await act(() => result.current.actions.openSession("c1", "s1", CWD));
expect(result.current.state.pendingExtension).toMatchObject({ requestId: "ui-1" });
```

- [ ] **步骤 3：写 UI/Observer RED**

`PiRunDetails`：

```tsx
it("idle Owner 可以标记完成", async () => {
  const onComplete = vi.fn();
  renderDetails({ job: idleOwnerJob, onComplete });
  await userEvent.click(screen.getByRole("button", { name: "标记完成" }));
  expect(onComplete).toHaveBeenCalledOnce();
});

it("活动时显示停止并标记完成", () => {
  renderDetails({ job: { ...runningOwnerJob, runId: "run-1" } });
  expect(screen.getByRole("button", { name: "停止并标记完成" })).toBeTruthy();
});

it("done 显示可重新激活说明", () => {
  renderDetails({ job: doneOwnerJob });
  expect(screen.getByText("已完成，可继续提问以重新激活")).toBeTruthy();
});

it("Observer 不显示完成按钮", () => {
  renderDetails({ job: { ...idleOwnerJob, isOwner: false } });
  expect(screen.queryByRole("button", { name: /标记完成/ })).toBeNull();
});
```

Observer 测试必须断言：

- `PiChatInput` textarea、附件、Steer、Follow-up、abort、compact 全禁用/不渲染；
- `PiSessionSidebar` 只有当前 `mutableSessionId` 对应卡片显示 rename/fork/clone/delete；其他 Session 只读；
- model/thinking select 禁用；
- `PiPanel` 不再硬编码 `isObserver = false`，而使用 `state.job?.isOwner === false`；
- Server 仍是最终权限边界。

- [ ] **步骤 4：写全局展示 RED**

1. NotificationBell 同时隐藏 `agent.run` 和 `agent.session`；
2. Jobs：`agent.session → Pi 会话`、`idle → 空闲`，状态过滤器包含 idle，tone neutral；
3. Dashboard 同样显示新类型/状态；创建独立 `dashboard-page.test.tsx`，不使用大快照。

- [ ] **步骤 5：运行 RED**

```bash
pnpm --dir "packages/frontend" exec vitest run \
  "src/pi/use-pi-session.test.tsx" \
  "src/pi/pi-reconnect.integration.test.tsx" \
  "src/pi/pi-run-details.test.tsx" \
  "src/pi/pi-chat-input.test.tsx" \
  "src/pi/pi-session-sidebar.test.tsx" \
  "src/pages/pi-panel.test.tsx" \
  "src/components/notification-bell.test.tsx" \
  "src/pages/jobs-page.test.tsx" \
  "src/pages/dashboard-page.test.tsx"
```

- [ ] **步骤 6：实现 Hook 双权威合并**

```ts
function effectiveStatus(
  job: PiSessionJobSnapshot,
  agent: PiAgentState,
): PiSessionStatus {
  if (job.status === "done") return "done";
  if (job.status === "disconnected") return "disconnected";
  if (job.status === "error") return "error";
  if (agent.pendingExtension) return "waiting_input";
  return agent.status === "idle" ? "idle" : "running";
}
```

规则：

1. `openSession()` 以 `agent.open()` 返回的 `{job,agentState}` 为权威；history/models 可并行，但都受 generation guard。
2. `activeRunIdRef = job.runId`；删除旧 `running()` 附着逻辑。
3. `run_created` 只绑定 matching submission；agent_settled 只清 matching run，并重新 open/history 对账。
4. `send` 只允许 idle/done Owner；不发明 runId。
5. `extension_resolved` 只关闭 matching requestId；紧随其后的新 extension_request 可建立新弹框。
6. abort/complete 使用当前 runId，并用 SDK 返回快照替换本地 Job。
7. 保留 retired run 和 Session generation guard。

- [ ] **步骤 7：实现最小 UI**

`PiRunDetails` 使用 Job 状态，显示：

```text
Session / Job: <sessionId>
Current Run: <runId 或 —>
```

Owner-only 按钮：

```tsx
<Button type="button" variant="outline" onClick={onComplete}>
  {job.runId ? "停止并标记完成" : "标记完成"}
</Button>
```

不增加第二入口或确认弹框。Observer 用现有 disabled/readOnly prop 统一约束所有 mutation。

- [ ] **步骤 8：运行 GREEN 和 Frontend build**

```bash
pnpm --dir "packages/frontend" test
pnpm --dir "packages/frontend" build
```

- [ ] **步骤 9：检查并提交**

```bash
git add -- \
  "packages/frontend/src/pi/use-pi-session.ts" \
  "packages/frontend/src/pi/use-pi-session.test.tsx" \
  "packages/frontend/src/pi/pi-reconnect.integration.test.tsx" \
  "packages/frontend/src/pi/pi-run-details.tsx" \
  "packages/frontend/src/pi/pi-run-details.test.tsx" \
  "packages/frontend/src/pi/pi-chat-input.tsx" \
  "packages/frontend/src/pi/pi-chat-input.test.tsx" \
  "packages/frontend/src/pi/pi-session-sidebar.tsx" \
  "packages/frontend/src/pi/pi-session-sidebar.test.tsx" \
  "packages/frontend/src/pages/pi-panel.tsx" \
  "packages/frontend/src/pages/pi-panel.test.tsx" \
  "packages/frontend/src/components/notification-bell.tsx" \
  "packages/frontend/src/components/notification-bell.test.tsx" \
  "packages/frontend/src/pages/jobs-page.tsx" \
  "packages/frontend/src/pages/jobs-page.test.tsx" \
  "packages/frontend/src/pages/dashboard-page.tsx" \
  "packages/frontend/src/pages/dashboard-page.test.tsx"
git commit -m "feat(frontend): 支持 Pi Session Job 生命周期" --only -- \
  "packages/frontend/src/pi/use-pi-session.ts" \
  "packages/frontend/src/pi/use-pi-session.test.tsx" \
  "packages/frontend/src/pi/pi-reconnect.integration.test.tsx" \
  "packages/frontend/src/pi/pi-run-details.tsx" \
  "packages/frontend/src/pi/pi-run-details.test.tsx" \
  "packages/frontend/src/pi/pi-chat-input.tsx" \
  "packages/frontend/src/pi/pi-chat-input.test.tsx" \
  "packages/frontend/src/pi/pi-session-sidebar.tsx" \
  "packages/frontend/src/pi/pi-session-sidebar.test.tsx" \
  "packages/frontend/src/pages/pi-panel.tsx" \
  "packages/frontend/src/pages/pi-panel.test.tsx" \
  "packages/frontend/src/components/notification-bell.tsx" \
  "packages/frontend/src/components/notification-bell.test.tsx" \
  "packages/frontend/src/pages/jobs-page.tsx" \
  "packages/frontend/src/pages/jobs-page.test.tsx" \
  "packages/frontend/src/pages/dashboard-page.tsx" \
  "packages/frontend/src/pages/dashboard-page.test.tsx"
```

---

### 任务 8：更新文档并完成真实生命周期验证

**文件：**

- 修改：`docs/remote-pi-tab.md`
- 验证：所有实现文件

旧 `agent.run` 记录在本次范围内只保留为历史审计数据；不提供缺少实时 Client 权威证据的批量清理脚本，也不自动改写状态。

- [ ] **步骤 1：更新当前事实文档**

`docs/remote-pi-tab.md` 明确：

- 每个 Session 唯一 `agent.session`；
- `jobId === sessionId`；每个 Prompt 新 `runId`；
- 回答完成 → idle；Owner 手动完成 → done；
- done 可重新激活；error 不可直接 Prompt；
- pending/断线/删除语义；
- Extension 排队、回答、取消、超时、刷新恢复；
- `/open` Server 对账；
- 每次 Socket 重连上报 PI_STATE；
- 原子 CAS 与安全错误映射；
- 旧 `agent.run` 仅为历史记录；
- thinking 文本既有隐私说明保持不变。

- [ ] **步骤 2：运行可移植类型检查和 package tests**

```bash
pnpm --dir "packages/shared" test
pnpm --dir "packages/client" test
pnpm --dir "packages/server" test
pnpm --dir "packages/sdk" test
pnpm --dir "packages/frontend" test
pnpm --dir "packages/shared" build
pnpm --dir "packages/client" build
pnpm --dir "packages/server" build
pnpm --dir "packages/sdk" build
pnpm --dir "packages/frontend" build
```

必须零失败。LSP/Lens 作为附加检查；若与新鲜 `tsc` 冲突，记录缓存差异，但不得忽略真实 primary-language error。

- [ ] **步骤 3：运行根构建与集成测试**

```bash
pnpm build
pnpm test
git diff --check
```

验收以零失败为准，不绑定历史测试数量。

- [ ] **步骤 4：启动隔离的真实 Pi 环境**

```bash
export PI_CODING_AGENT_DIR="$PWD/.tmp/pi-session-job-e2e"
pnpm dev:all
```

禁止杀死 Pi 主进程或 VS Code Pi RPC；只停止本命令创建的进程树。

- [ ] **步骤 5：使用 Playwright MCP 验证真实 UI**

使用已认证浏览器 profile，逐项取证：

1. 创建 Session：Job type=`agent.session`，`jobId === sessionId`，status=`idle`。
2. Server 重启或模拟 readiness pending：REGISTER 与合法 PI_STATE 之间所有 PI_REQUEST REST 返回 `PI_STATE_PENDING`，对账后恢复。
3. 发送 Prompt：accepted response 的 `jobId === sessionId` 且 `runId !== sessionId`。
4. 回答结束：UI 和 Job 为 `idle`，不是 waiting/done；在 30 秒 grace 内立即再发 Prompt也成功，新 runId 不同。
5. 触发真实 Project Trust 或测试 Extension confirm：Job waiting，弹框出现。
6. 刷新页面：同 requestId 弹框从 matching run 的 `/open.agentState.pendingExtension` 恢复。
7. 回答弹框：Job running，settlement 后 idle。
8. 触发两个受控交互请求：解决第一个时仍 waiting，解决第二个后 running/idle。
9. 点击“标记完成”：Job done，历史仍可读。
10. 再发 Prompt：同一 Job 重新激活，新 runId 与上次不同。
11. 运行时点击“停止并标记完成”：权威 abort 后 done。
12. Observer 身份打开同一 Session：所有写控件禁用，历史/SSE 可见。
13. Client 断开再连接：第二次 PI_STATE 确实发送；无法恢复的 run error，Server 已 done 的旧 run 被 closedRunIds 清理。
14. 删除空闲 Session：远程删除失败时 Job 回滚；删除与 Prompt 竞态只有一方成功。
15. 通知铃中没有 `agent.session`、`agent.run` 或 Pi 的 Storage 上传文案。

保存右侧 done 状态截图和只含 ID/状态、不含 Prompt/thinking 的 network artifact。

- [ ] **步骤 6：验证数据库与日志隐私**

使用唯一、无害 sentinel 分别放入 Prompt、模型错误、thinking 和 Extension 输入。查询目标 Job 的 `payload/result/progress/errorMessage` 和 Server 日志，断言 sentinel 全部不存在。

允许持久化的只有：Session ID、Client ID、状态、Owner 审计、安全 `{runId}`、模型安全摘要、稳定 error code 和 Server allowlist message。

- [ ] **步骤 7：运行最终代码智能检查**

1. `gitnexus_detect_changes({ scope: "compare", base_ref: "main" })`，检查受影响流程；
2. `lens_diagnostics({ mode: "all" })` 检查全部编辑文件；
3. `git status --short` 和 `git diff --cached --name-only`；
4. 明确确认 `.gitmodules`、`examples/pi-web` 未进入任何生命周期提交。

- [ ] **步骤 8：请求独立代码审查**

使用 `requesting-code-review`。Reviewer 必查：

- stale run rejection；
- CAS 并发；
- pending/disconnected complete；
- fixed Owner/Observer；
- Extension 排队、timeout、刷新恢复；
- 每次 Socket 重连 PI_STATE；
- open/reconnect 对账和项目锁释放；
- 原始错误消息与正文隐私；
- legacy 兼容。

修复经过验证的 review finding 后，重跑相关 focused tests、`pnpm build`、`pnpm test`。

- [ ] **步骤 9：提交文档**

```bash
git add -- "docs/remote-pi-tab.md"
git commit -m "docs: 更新 Pi Session Job 生命周期" --only -- \
  "docs/remote-pi-tab.md"
```

---

## 自审结果

- **需求覆盖：** `sessionId = jobId`、独立 runId、fixed Owner、手动可逆 done、回答后 idle、abort-to-idle、active/pending/disconnected complete、new/fork/clone/open/delete、waiting_input 回答/超时/并发/刷新、Socket 重连、PI_STATE 对账、Observer、隐私和 Playwright 均有明确任务。
- **竞态覆盖：** accept 与早到 Extension、complete 与 settlement、新 Prompt 与 complete、旧 PI_STATE 与 done、旧 run 与新 run 均要求 CAS 测试。
- **接口一致：** `PiSessionJobSnapshot` 是 REST/SDK/Frontend 的统一 Job 状态；`PiSessionOpenResult` 同时返回 Job 与已校验 Agent State；`PiStateAck` 包含 accepted/closed run IDs 与 `reportAgain`。
- **最小范围：** 不新增数据库表、依赖、轮询器、自动完成、持久化 Extension 内容、第二个 done 入口或无权威证据的 legacy 清理工具。
- **无占位：** 每个任务给出确切文件、接口、RED 断言、实现约束、验证命令和提交边界。
