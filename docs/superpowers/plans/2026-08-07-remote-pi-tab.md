# 远程 Pi Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在机器工作区增加参考 `examples/pi-web` 核心逻辑的远程 Pi Tab，支持项目级 Pi Session 管理、结构化多轮交互、断线重附着、Owner/Observer 控制和图片提示。

**Architecture:** Browser 使用 VCPDeck REST + SSE，Server 只做代理、Owner 校验和安全 Job 元数据，远程 Client 以 canonical cwd 管理独立 Pi SDK 子进程。Session JSONL、模型凭据和项目资源保留在远程用户环境；每个 prompt 对应一个 sanitized `agent.run` Job，`runId === jobId`。

**Tech Stack:** TypeScript strict、Node.js `child_process.fork` IPC、`@earendil-works/pi-coding-agent` 0.84.0、NestJS 10 + Socket.IO + RxJS SSE、Prisma/SQLite、React 18 + Vite、`react-markdown` + `remark-gfm`、Vitest、Testing Library。

## Global Constraints

- 设计事实来源：`docs/superpowers/specs/2026-08-07-remote-pi-tab-design.md`。
- 页面和会话行为基准：`examples/pi-web` 的 `SessionSidebar`、`ChatWindow`、`ChatInput`、`MessageView`、`BranchNavigator`、`useAgentSession`、`rpc-manager`、`session-reader`；生产代码不得跨目录 import 示例源码。
- `examples/pi-web` 是用户已暂存的子模块，`.gitmodules` 与 `examples/pi-web` 不属于本计划提交；每次提交必须使用显式 pathspec 和 `git commit --only`。
- Pi SDK 依赖精确锁定为 `0.84.0`，不使用 `^`；**Pi capability** 最低 Node.js 为 `22.19.0`，不得提高整个 Client 主入口的 Node 门槛。
- 不调用全局 `pi`、`pi.cmd` 或 `pi --mode rpc`；不引入 xterm.js、node-pty、ConPTY 或 ANSI TUI 解析。
- Client 主入口不得静态 import Pi SDK；Pi 代码只在探测或项目 Worker 子进程中加载。
- Windows Bash 探测顺序：配置 `shellPath` → Git Bash → PATH `bash.exe`；API 只返回来源类别。
- 同一 canonical cwd 只允许一个活动回合，不同 cwd 可并行；浏览历史不获取活动回合锁。
- 每个普通 prompt 创建一个 `agent.run` Job；steer/follow-up 属于同一 Job；`runId` 使用 `jobId`。
- Job、日志和普通错误不得包含 prompt、steer/follow-up 正文、图片、Tool 参数/结果、thinking、FileRef URL、项目路径或 Session JSONL 路径。
- 只有活动 Job Owner 可 steer、follow-up、abort 和回答 Extension UI；Observer 只读；Server 必须校验所有写操作。
- thinking 正文不得离开远程 Session JSONL；单个实时事件 JSON 最多 256 KiB。
- 图片每条最多 10 张、每张最多 10 MiB、总量最多 100 MiB；只接受 PNG/JPEG/GIF/WebP。
- 注释、公共 JSDoc、错误消息和提交信息使用简体中文；代码标识符与协议字段使用英文。
- 修改既有函数、类或方法前运行 GitNexus upstream impact；各任务列出的 target 只是最低集合，执行时必须为每个实际修改的既有 symbol 补跑；HIGH/CRITICAL 先停止并告知用户。
- 每次提交前运行 `gitnexus_detect_changes({ scope: "all" })`；每个任务按 TDD 执行，验证失败不提交。

## File Map

- `packages/shared/src/pi.ts` — Pi capability、request/response/event、Session/message 与错误判别联合。
- `packages/client/src/pi/` — capability、project path、SessionReader、AgentSession wrapper、event projector、Worker、Supervisor、images。
- `packages/server/src/pi/` — run state、request broker、event broker、attachments、Controller 与 Module。
- `packages/sdk/src/pi.ts` — Pi REST API 和 SSE path builder。
- `packages/frontend/src/pi/` — 状态机、三栏模块、消息、输入、Session tree、branch、details、project picker。

**Protocol clarification:** 批准规格同时要求 `agent/new → SSE connected → prompt`，且普通 prompt 才创建 `runId/jobId`。因此本计划按规格公开 API 采用 **session-level SSE**：订阅 key 为 `clientId + sessionId`，每条 `PiEvent` 仍携带 `jobId/runId`，Server 在状态变更时验证完整四元组，Frontend 用 generation/runId 丢弃迟到事件。这消除了 prompt 前无法取得 runId 的循环，并保留 run 级隔离。

---

### Task 1: Shared Pi 协议与 capability details

**Files:**

- Create: `packages/shared/src/pi.ts`
- Create: `packages/shared/src/pi.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`, `pnpm-lock.yaml`
- Modify: `packages/server/prisma/schema.prisma`
- Create: `packages/server/prisma/migrations/20260807000001_add_pi_capability_details/migration.sql`
- Modify: `packages/server/src/client/client.service.ts`
- Create: `packages/server/src/client/client.service.test.ts`
- Modify: `packages/sdk/src/domains.test.ts` and Frontend `ClientInfo` fixtures

**Interfaces:**

- Produces: `PiCwdRef`、opaque `PiProjectKey`、`PiPromptAccepted { jobId; runId; sessionId }`、`PiCapabilityStatus`、`PiAction`、`PiRequest`、`PiResponse`、`PiEvent`、`PiStateReport`、`PiSessionInfo`、`PiSessionDetail`、`PiAgentState`、`PiClientEvent`、`PiErrorCode`。
- Produces runtime trust-boundary parsers: `parsePiRequest()`、`parsePiResponse()`、`parsePiEvent()`、`parsePiStateReport()`。
- Produces: `MachineRegister.capabilityDetails?`、`ClientInfo.capabilityDetails` 和 `Events.PI_REQUEST/PI_RESPONSE/PI_EVENT/PI_STATE`。

- [ ] **Step 1: 运行 impact**

Targets: `ClientService.register`、`ClientService.listOnline`、`Events`。Expected: 记录调用者；HIGH/CRITICAL 停止。

- [ ] **Step 2: 写 capability details 失败测试**

Create `client.service.test.ts`：

```ts
import { expect, it, vi } from "vitest";
import { ClientService } from "./client.service.js";

it("持久化并解析 Pi capability details", async () => {
  const prisma = { client: {
    upsert: vi.fn(),
    findMany: vi.fn().mockResolvedValue([{
      id: "c1", hostname: "host", os: "win32", cpuModel: "cpu", totalMemMB: 1,
      clientVersion: "1", capabilities: '["pi.probe","agent.pi"]',
      capabilityDetails: '{"pi":{"available":true,"sdkVersion":"0.84.0","nodeVersion":"22.19.0","shellKind":"git-bash"}}',
      disks: "[]", online: true, cpuPercent: null, memPercent: null, lastHeartbeatAt: null,
    }]),
  }} as never;
  const service = new ClientService(prisma);
  await service.register({
    clientId: "c1", hostname: "host", os: "win32", cpuModel: "cpu", totalMemMB: 1,
    clientVersion: "1", capabilities: ["pi.probe", "agent.pi"],
    capabilityDetails: { pi: { available: true, sdkVersion: "0.84.0", nodeVersion: "22.19.0", shellKind: "git-bash" } },
  }, "socket-1");
  expect(prisma.client.upsert).toHaveBeenCalledWith(expect.objectContaining({
    create: expect.objectContaining({ capabilityDetails: expect.stringContaining("0.84.0") }),
  }));
  expect((await service.listOnline())[0]?.capabilityDetails.pi).toMatchObject({ available: true });
});
```

- [ ] **Step 3: 写 Shared runtime parser 失败测试并运行红灯**

`pi.test.ts` 覆盖合法 action，以及非法 action、未知顶层字段、缺失 requestId、prompt 缺 session/job/run ID、runId 与 jobId 不同、attachment 数量/大小/总量超限、畸形 event/state。Client Socket 与 Server Gateway 后续都必须先 parse 再使用。先为 Shared 加与仓库一致的 Vitest dependency 与 `"test": "vitest run"` script：

```bash
pnpm --filter @vcpdeck/shared add -D vitest@3.2.7 --save-exact
```

再运行：

```bash
pnpm --filter @vcpdeck/shared test -- src/pi.test.ts
pnpm --filter @vcpdeck/server test -- src/client/client.service.test.ts
```

Expected: FAIL，parser/字段不存在。

- [ ] **Step 4: 定义 Shared 判别联合与 runtime parsers**

Create `pi.ts`，至少定义：

```ts
export type PiErrorCode =
  | "PI_CLIENT_UNSUPPORTED" | "PI_NODE_UNSUPPORTED" | "PI_BASH_NOT_FOUND"
  | "PI_RUNTIME_UNAVAILABLE" | "PI_AUTH_UNAVAILABLE" | "PI_MODEL_NOT_FOUND"
  | "PI_PROJECT_NOT_ALLOWED" | "PI_SESSION_NOT_FOUND" | "PI_PROJECT_BUSY"
  | "PI_CONTROL_FORBIDDEN" | "PI_CLIENT_DISCONNECTED" | "PI_WORKER_EXITED"
  | "PI_CLIENT_RESTARTED" | "PI_IMAGE_INVALID" | "PI_IMAGE_TOO_LARGE"
  | "PI_REQUEST_TIMEOUT";
export interface PiCwdRef { rootDir: string; relativePath: string }
export type PiCapabilityStatus =
  | { available: true; sdkVersion: string; nodeVersion: string; shellKind: "configured" | "git-bash" | "path" | "system" }
  | { available: false; code: "PI_CLIENT_UNSUPPORTED" | "PI_NODE_UNSUPPORTED" | "PI_BASH_NOT_FOUND" | "PI_RUNTIME_UNAVAILABLE" | "PI_AUTH_UNAVAILABLE"; message: string; nodeVersion?: string };
export type PiResponse =
  | { requestId: string; ok: true; data?: unknown }
  | { requestId: string; ok: false; error: { code: PiErrorCode; message: string } };
```

`PiAction` 必须枚举 `project.resolve`、capability/models/session/agent/model/thinking/extension actions。裁剪消息类型不得直接暴露 Pi SDK 原始对象。Parsers 使用最小手写 type guards（不新增 schema 依赖），拒绝未知 action/字段和不一致的关联 ID；旧 Client 缺 `pi.probe` 时 Server 合成 `{ available:false, code:"PI_CLIENT_UNSUPPORTED" }`。`PiProjectKey` 是 Client 用启动时随机 secret 对 canonical cwd 计算的 HMAC-SHA-256 opaque digest，只用于 Server 内存锁和 state reconcile，不含或返回 cwd，不写 Job/日志/数据库；Client 重启后 key 可变化。

- [ ] **Step 5: 持久化字段**

Prisma `Client` 增加 `capabilityDetails String @default("{}")`；migration：

```sql
ALTER TABLE "Client" ADD COLUMN "capabilityDetails" TEXT NOT NULL DEFAULT '{}';
```

`ClientService` 序列化写入并安全解析。所有既有 `ClientInfo` fixture 加 `capabilityDetails: {}`。

- [ ] **Step 6: 验证**

```bash
pnpm --filter @vcpdeck/shared test -- src/pi.test.ts
pnpm --filter @vcpdeck/shared build
pnpm --filter @vcpdeck/server exec prisma generate
pnpm --filter @vcpdeck/server test -- src/client/client.service.test.ts
pnpm --filter @vcpdeck/sdk test -- src/domains.test.ts
pnpm --filter @vcpdeck/frontend test -- src/pages/machine-workspace.test.tsx src/pages/machines-page.test.tsx src/pages/frp-page.test.tsx
```

Expected: PASS。

- [ ] **Step 7: detect changes + commit**

```bash
git add packages/shared/src/pi.ts packages/shared/src/pi.test.ts packages/shared/src/index.ts packages/shared/package.json pnpm-lock.yaml packages/server/prisma/schema.prisma packages/server/prisma/migrations/20260807000001_add_pi_capability_details/migration.sql packages/server/src/client/client.service.ts packages/server/src/client/client.service.test.ts packages/sdk/src/domains.test.ts packages/frontend/src/pages/machine-workspace.test.tsx packages/frontend/src/pages/machines-page.test.tsx packages/frontend/src/pages/frp-page.test.tsx
git commit --only -m "feat(shared): 定义远程 Pi 协议" -- packages/shared/src/pi.ts packages/shared/src/pi.test.ts packages/shared/src/index.ts packages/shared/package.json pnpm-lock.yaml packages/server/prisma/schema.prisma packages/server/prisma/migrations/20260807000001_add_pi_capability_details/migration.sql packages/server/src/client/client.service.ts packages/server/src/client/client.service.test.ts packages/sdk/src/domains.test.ts packages/frontend/src/pages/machine-workspace.test.tsx packages/frontend/src/pages/machines-page.test.tsx packages/frontend/src/pages/frp-page.test.tsx
```

---

### Task 2: Client Pi 探测与项目路径安全

**Files:**

- Modify: `packages/client/package.json`, `pnpm-lock.yaml`
- Create: `packages/client/src/filesystem-roots.ts`
- Modify: `packages/client/src/file-handler.ts`
- Create: `packages/client/src/pi/node-version.ts`, `node-version.test.ts`
- Create: `packages/client/src/pi/project-path.ts`, `project-path.test.ts`
- Create: `packages/client/src/pi/capability.ts`, `capability.test.ts`, `probe-worker.ts`

**Interfaces:**

- Produces: `discoverRoots()`、`isSupportedNodeVersion()`、`resolveProjectCwd(ref)`、`projectKeyFor(canonicalCwd, processSecret)`、`probePiCapability()`。

- [ ] **Step 1: impact**

Targets: `resolveSafePath`、`handleFileOp`、当前 `discoverRoots`。

- [ ] **Step 2: 写失败测试**

```ts
it.each([["22.18.99", false], ["22.19.0", true], ["v23.0.0", true], ["invalid", false]])(
  "判断 Node %s", (version, expected) => expect(isSupportedNodeVersion(version)).toBe(expected),
);
```

`project-path.test.ts` 用临时 root/project/outside/symlink 覆盖正常、`..`、symlink、未允许 root 和 Windows 跨盘/大小写。`capability.test.ts` 通过注入 fs/spawn 依赖覆盖 configured、Git Bash、PATH、缺失、Node 过旧、SDK fail、无已认证模型。

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/client test -- src/pi/node-version.test.ts src/pi/project-path.test.ts src/pi/capability.test.ts`
Expected: FAIL。

- [ ] **Step 4: 精确添加依赖**

先核对 0.84.0 package exports 与计划中的生产 imports，再只添加实际直接 import 的包：

```bash
pnpm --filter @vcpdeck/client add @earendil-works/pi-coding-agent@0.84.0 --save-exact
```

仅当生产源码必须直接从 `@earendil-works/pi-agent-core` import API/type 时，才再执行同样的 `@0.84.0 --save-exact` 添加。确认 `package.json` 无 `^`，不要因 Pi capability 提高整个 Client 的 `engines` 门槛；旧 Node 仍须启动 exec/files/FRP。

- [ ] **Step 5: 实现 roots 与 canonical cwd**

抽取当前 `discoverRoots()`，Files 行为不变。`resolveProjectCwd()` 使用 `realpath + relative`，Windows canonical path 小写且 `/` 化；越界统一 `PI_PROJECT_NOT_ALLOWED`。Supervisor 启动时生成随机 processSecret，再计算 `projectKey = createHmac("sha256", processSecret).update(canonicalPath).digest("hex")`，API 只返回 64 hex digest。相同进程中的目录别名得到同 key，不同 canonical cwd 不同，Client 重启后 key 改变；测试不得断言或返回 path。不要复用会吞自身异常的 `resolveSafePath()`。

- [ ] **Step 6: 实现延迟探测**

主进程先检查 Node/Bash；再 `fork(dist/pi/probe-worker.js)`。只有 `probe-worker.ts` import Pi SDK，并用 `ModelRuntime.getAvailable()` 判断凭据。结果只含 sdk/node/shellKind 或安全错误，不含路径/模型凭据。

- [ ] **Step 7: 验证**

```bash
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/client build
grep -n "pi-coding-agent" packages/client/dist/index.js || true
```

Expected: PASS；`dist/index.js` 无顶层 SDK import。

- [ ] **Step 8: detect changes + commit**

```bash
git add packages/client/package.json pnpm-lock.yaml packages/client/src/filesystem-roots.ts packages/client/src/file-handler.ts packages/client/src/pi/node-version.ts packages/client/src/pi/node-version.test.ts packages/client/src/pi/project-path.ts packages/client/src/pi/project-path.test.ts packages/client/src/pi/capability.ts packages/client/src/pi/capability.test.ts packages/client/src/pi/probe-worker.ts
git commit --only -m "feat(client): 探测远程 Pi 运行能力" -- packages/client/package.json pnpm-lock.yaml packages/client/src/filesystem-roots.ts packages/client/src/file-handler.ts packages/client/src/pi/node-version.ts packages/client/src/pi/node-version.test.ts packages/client/src/pi/project-path.ts packages/client/src/pi/project-path.test.ts packages/client/src/pi/capability.ts packages/client/src/pi/capability.test.ts packages/client/src/pi/probe-worker.ts
```

---

### Task 3: Client SessionReader 与完整 Session 管理

**Files:**

- Create: `packages/client/src/pi/worker-protocol.ts`
- Create: `packages/client/src/pi/normalize.ts`
- Create: `packages/client/src/pi/session-reader.ts`
- Create: `packages/client/src/pi/session-reader.test.ts`

**Interfaces:**

- Produces: `createPiSessionReader(cwd)`，methods: `list/get/context/entryContent/rename/delete/fork/clone/navigate`。
- Produces Worker IPC request/response/event/state discriminated unions。

- [ ] **Step 1: 完整阅读参考文件**

Read: `examples/pi-web/lib/session-reader.ts`、`examples/pi-web/app/api/sessions/[id]/route.ts`、`examples/pi-web/app/api/sessions/[id]/context/route.ts`。不得修改它们。

- [ ] **Step 2: 写真实临时 Session 失败测试**

用 `SessionManager.create(cwd, sessionDir)` 创建消息、分支、parentSession。断言：列表不含 path；只列当前 cwd；context cursor 默认最新 60 条；thinking/图片/大 Tool Result 是 deferred；rename/fork/clone/navigate 正确；delete re-parent；跨 cwd sessionId 拒绝。

```ts
expect(JSON.stringify(await reader.context(sessionId))).not.toContain("secret thinking");
expect((await reader.list())[0]).not.toHaveProperty("path");
```

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/client test -- src/pi/session-reader.test.ts`
Expected: FAIL。

- [ ] **Step 4: 移植最小 reader**

移植 ToolCall normalization、sessionId path cache、迭代 tree 投影（最大深度 200）、active branch context 和 cursor 分页。thinking → deferred metadata；图片 → `entryId/blockIndex` placeholder；>256 KiB Tool Result → deferred descriptor。

- [ ] **Step 5: 实现变更语义**

rename 用 `appendSessionInfo`；fork/clone 使用 Pi `SessionManager`；navigate 返回目标 context；delete 先用临时文件+rename 原子 re-parent direct children，再删 JSONL。Reader 不创建 AgentSession、不加载 extensions。Reader 负责 cwd/session membership；运行期 destructive-operation busy 与 wrapper shutdown 由 Task 5 Supervisor 再校验。

- [ ] **Step 6: 验证与提交**

```bash
pnpm --filter @vcpdeck/client test -- src/pi/session-reader.test.ts
pnpm --filter @vcpdeck/client build
git add packages/client/src/pi/worker-protocol.ts packages/client/src/pi/normalize.ts packages/client/src/pi/session-reader.ts packages/client/src/pi/session-reader.test.ts
git commit --only -m "feat(client): 管理远程 Pi Session" -- packages/client/src/pi/worker-protocol.ts packages/client/src/pi/normalize.ts packages/client/src/pi/session-reader.ts packages/client/src/pi/session-reader.test.ts
```

---

### Task 4: Client AgentSession wrapper 与事件投影

**Files:**

- Create: `packages/client/src/pi/agent-session.ts`, `agent-session.test.ts`
- Create: `packages/client/src/pi/event-projector.ts`, `event-projector.test.ts`

**Interfaces:**

- Produces: `startPiAgentSession(options): Promise<PiAgentSessionWrapper>`。
- Produces: `projectPiEvent(event): PiClientEvent | null`。

- [ ] **Step 1: 完整阅读参考**

Read: Pi Web `rpc-manager.ts`、`startup-preferences.ts`、`model-scope.ts`、`image-attachments.ts`，并核对 SDK 0.84.0 `.d.ts`。

- [ ] **Step 2: 写失败测试**

Event projector：thinking 无正文、partial 不出站、tool update dropped、>256 KiB → `history_changed`。Wrapper fake session：prompt fire-and-forget、`agent_end` 非终态、`agent_settled`、fork 后 shutdown、model/thinking、compact/abort_compaction、graceful shutdown。Extension UI 覆盖 select/confirm/input/editor/notify/setStatus/string-lines setWidget/setTitle/set_editor_text；显式 timeout 原样使用，缺省才 30 分钟；`custom()` 立即返回 undefined 并发安全 notify。

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/client test -- src/pi/event-projector.test.ts src/pi/agent-session.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现投影**

```ts
switch (event.type) {
  case "turn_start": case "turn_end": case "tool_execution_update": return null;
  case "message_update": return projectTextDeltaOrLifecycle(event); // no partial
  case "agent_end": return { type: "agent_end" };
  case "message_end": return { type: "history_changed" };
}
```

thinking 只发 progress；超大 Tool 参数/结果只发 history changed。

- [ ] **Step 5: 实现 wrapper**

使用 `createAgentSessionServices` + `createAgentSessionFromServices` + `createAgentSessionRuntime`。支持 prompt/steer/follow_up/abort/compact/abort_compaction/get_state/stats/commands/models/model/thinking/name/fork/clone/navigate/extension response 与上述标准 Extension UI。不支持 bash/set_tools/credentials/custom UI。Models action 返回 `ModelRuntime.getAvailable()` 与远程 `enabledModels` scope 的交集；set_model 不在交集时返回 `PI_MODEL_NOT_FOUND`。无 timeout 的 dialog 30 分钟取消；state 含 `waitingForExtensionInput`。

- [ ] **Step 6: 终态与清理**

Prompt resolve emit `prompt_done`；`agent_end` 不销毁；fork/clone 后立即 graceful shutdown；idle 10 分钟 shutdown；extension `session_shutdown` 后 dispose。Project Trust 必须通过标准 confirm 交给当前 Owner；无 Owner、拒绝或 timeout 时不加载项目 settings/extensions，不能自动批准。

- [ ] **Step 7: 验证与提交**

```bash
pnpm --filter @vcpdeck/client test -- src/pi/event-projector.test.ts src/pi/agent-session.test.ts
pnpm --filter @vcpdeck/client build
git add packages/client/src/pi/agent-session.ts packages/client/src/pi/agent-session.test.ts packages/client/src/pi/event-projector.ts packages/client/src/pi/event-projector.test.ts
git commit --only -m "feat(client): 驱动 Pi AgentSession" -- packages/client/src/pi/agent-session.ts packages/client/src/pi/agent-session.test.ts packages/client/src/pi/event-projector.ts packages/client/src/pi/event-projector.test.ts
```

---

### Task 5: Client project Worker、Supervisor 与 IPC 恢复

**Files:**

- Create: `packages/client/src/pi/worker.ts`
- Create: `packages/client/src/pi/supervisor.ts`, `supervisor.test.ts`
- Modify: `packages/client/src/pi/worker-protocol.ts`

**Interfaces:**

- Produces: `PiSupervisor.request()`、`getStateReport()`、`ackTerminalRuns()`、`shutdown()`、`onEvent()`。
- Worker IPC 每条消息带 `projectKey` 与 request/session/job/run 相关 ID。

- [ ] **Step 1: 写 Supervisor 失败测试**

注入 fake `forkWorker(cwd)`，覆盖：同 cwd 第二 prompt → `PI_PROJECT_BUSY`；不同 cwd 并行；只读 Session request 不取活动锁；waiting_input 保持锁；活动 Session 的 rename/delete/fork/clone/navigate/model/thinking 被拒绝；活动 Owner compact 可执行；空闲 mutation 先获取 project lock，并在 delete 前 graceful shutdown wrapper；Server disconnect 不杀 Worker；parent IPC disconnect 会杀；Worker exit → `PI_WORKER_EXITED`；terminal summary ack 前保留；idle shutdown。

```ts
await supervisor.request(prompt("D:/a", "job-a"));
await expect(supervisor.request(prompt("D:/a", "job-b"))).resolves.toMatchObject({
  ok: false, error: { code: "PI_PROJECT_BUSY" },
});
await expect(supervisor.request(prompt("D:/b", "job-c"))).resolves.toMatchObject({ ok: true });
```

- [ ] **Step 2: 红灯**

Run: `pnpm --filter @vcpdeck/client test -- src/pi/supervisor.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 Worker entry**

Worker 固定一个 canonical cwd；常驻 SessionReader；只有 agent action 才创建 wrapper。所有异常归一化为稳定 code/message，不返回 stack/path。监听 parent `disconnect`，abort/dispose 后 exit。

- [ ] **Step 4: 实现 registry、活动锁与状态**

Registry 内部 key 使用 canonical cwd；`project.resolve` 是不取 active lock 的轻量请求，解析 cwd 后只返回 opaque projectKey，供 Server 以 `clientId + projectKey` 建内存锁。Prompt 接受后：

```ts
activeRun = { jobId, runId: jobId, sessionId, status: "running" };
```

Extension dialog → waiting_input；Owner response → running；settled → terminalReports + release lock；Worker 保留到 idle timeout。

- [ ] **Step 5: 实现重连报告**

`getStateReport()` 的 active/terminal summary 含 opaque projectKey，以便同一 Client 进程断线重连后 Server 重建内存锁；不含 cwd/path/prompt。`ackTerminalRuns()` 删除 Server 已确认终态。Socket 断线不 shutdown Supervisor；Client 重启后 processSecret/projectKey 改变且旧 active turn 按 `PI_CLIENT_RESTARTED` 失败。

- [ ] **Step 6: 验证与提交**

```bash
pnpm --filter @vcpdeck/client test -- src/pi/supervisor.test.ts
pnpm --filter @vcpdeck/client build
git add packages/client/src/pi/worker.ts packages/client/src/pi/supervisor.ts packages/client/src/pi/supervisor.test.ts packages/client/src/pi/worker-protocol.ts
git commit --only -m "feat(client): 管理项目级 Pi Worker" -- packages/client/src/pi/worker.ts packages/client/src/pi/supervisor.ts packages/client/src/pi/supervisor.test.ts packages/client/src/pi/worker-protocol.ts
```

---

### Task 6: Client Socket.IO Pi bridge 与注册能力

**Files:**

- Modify: `packages/client/src/register.ts`, `index.ts`
- Create: `packages/client/src/register.test.ts`
- Create: `packages/client/src/pi/socket-bridge.test.ts`

**Interfaces:**

- Consumes: `probePiCapability()`、`PiSupervisor`、`Events.PI_*`。
- Produces: new Client 总有 `pi.probe`；只有 available 才有 `agent.pi`。

- [ ] **Step 1: impact**

Targets: `getRegisterInfo`、`connect`。

- [ ] **Step 2: 写失败测试**

Register test：可用 caps/details；不可用只有 pi.probe；序列化结果无本地路径/auth。Socket test：PI_REQUEST 先经 `parsePiRequest` 再 supervisor→PI_RESPONSE；supervisor event→PI_EVENT；REGISTER ack 完成后才 PI_STATE；state ack 后清 terminal；disconnect 不 shutdown。用延迟 ack 证明 PI_STATE 不会提前发出，而不只断言 emit 调用顺序。

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/client test -- src/register.test.ts src/pi/socket-bridge.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现 bridge**

`getRegisterInfo(piStatus)` 接受状态。`connect()` 保持同步返回 Socket，在内部共享 supervisor/probe promise。REGISTER 必须使用 Socket.IO ack；Server 完成 `register/bindSocket/join` 后 callback ack，Client 才发送现有 STATUS_REPORT 与新增 PI_STATE，避免两类重连状态抢在 socket identity 绑定前到达。

```ts
socket.on(Events.PI_REQUEST, async (request) => {
  socket.emit(Events.PI_RESPONSE, await supervisor.request(request));
});
supervisor.onEvent((event) => socket.connected && socket.emit(Events.PI_EVENT, event));
```

PI_STATE 使用 ack callback，仅清 `acceptedRunIds`。

- [ ] **Step 5: 验证与提交**

```bash
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/client build
git add packages/client/src/register.ts packages/client/src/register.test.ts packages/client/src/index.ts packages/client/src/pi/socket-bridge.test.ts
git commit --only -m "feat(client): 接入 Pi Socket bridge" -- packages/client/src/register.ts packages/client/src/register.test.ts packages/client/src/index.ts packages/client/src/pi/socket-bridge.test.ts
```

---

### Task 7: Server sanitized Pi Run 与 Owner 状态机

**Files:**

- Create: `packages/server/src/pi/pi-run.service.ts`, `pi-run.service.test.ts`
- Modify: `packages/server/src/job/job.scheduler.ts`
- Create or Modify: `packages/server/src/job/job.scheduler.test.ts`

**Interfaces:**

- Produces: `createRun/accept/waitForInput/resume/scheduleSettlement/cancelSettlement/settle/fail/cancel/markDisconnected/reconcileState/assertOwner/assertIdleMutation`。
- Job payload 仅含 `mode/operation/sessionId/hasImages/imageCount`。

- [ ] **Step 1: impact**

Targets: `JobScheduler.tryDispatch` 与 Job create/update 路径。重点确认 `agent.run` 不经 `job:dispatch`。

- [ ] **Step 2: 写 sanitized Job 与 Owner 失败测试**

```ts
it("创建的 agent.run 不包含 prompt、路径和附件 URL", async () => {
  await service.createRun(actor, { clientId: "c1", sessionId: "s1", imageCount: 2 });
  const data = prisma.job.create.mock.calls[0][0].data;
  expect(data.type).toBe("agent.run");
  expect(JSON.parse(data.payload)).toEqual({
    mode: "interactive", operation: "prompt", sessionId: "s1", hasImages: true, imageCount: 2,
  });
  expect(JSON.stringify(data)).not.toContain("secret prompt");
});

it("只有 Owner 可以控制活动回合", async () => {
  await expect(service.assertOwner("job-1", "other")).rejects.toMatchObject({
    code: "PI_CONTROL_FORBIDDEN",
  });
});
```

再覆盖 running↔waiting_input、重复终态幂等、disconnected→reconcile、Client restart→failed。授权矩阵必须固定为：active `agent.run` 时只有 Owner 可 steer/follow-up/abort/extension response/compact/abort_compaction，任何人（包括 Owner）的 model/thinking/rename/delete/fork/clone/navigate 都拒绝；idle 时任一认证 identity 可 model/thinking/rename/delete/fork/clone/navigate；启动 compact 时取得并持有 mutation lease，initiator 是 lease owner，只有该 identity 可 abort_compaction，settled 后释放。Observer 始终可读。同 identity 多浏览器视为同一 Owner。Server 锁 key 来自 Client `project.resolve` 的 opaque projectKey，Client Supervisor 再做 canonical cwd 校验。Scheduler 测试断言 pending query 排除 `agent.run`。

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/server test -- src/pi/pi-run.service.test.ts src/job/job.scheduler.test.ts`
Expected: FAIL。

- [ ] **Step 4: 实现 run service**

创建 Job 时 `jobId = randomUUID()`、`runId = jobId`。仅保存安全 result：

```ts
{ sessionId, runId: jobId, stopReason, model: model && { provider: model.provider, modelId: model.modelId } }
```

Controller 每次写操作先调用 Client `project.resolve(cwdRef)`，得到 projectKey；`PiRunService` 仅在内存保存 `clientId + projectKey ↔ active job/mutation lease`，不持久化 key/path。`assertOwner()` 同时验证 owner、active status 与 projectKey；`assertIdleMutation()` 确认无 active run 并取得短锁。Compact lease 持续到 compact settled/failed，abort_compaction 校验 Job Owner 或 lease owner。`settle()` 幂等，不覆盖首次 terminal timestamp。Settlement 使用 Server-side 30 秒 cancellable grace：首次 idle+queue empty 只 schedule；同 run 任一新 activity/Extension request 取消；grace 到期再次查询 state 仍 idle 才 terminal，避免 idle snapshot 后 extension 注入竞态。

- [ ] **Step 5: 排除 scheduler**

`JobScheduler.tryDispatch()` pending where 加：

```ts
{ type: { not: "agent.run" } }
```

- [ ] **Step 6: 验证与提交**

```bash
pnpm --filter @vcpdeck/server test -- src/pi/pi-run.service.test.ts src/job/job.scheduler.test.ts
pnpm --filter @vcpdeck/server build
git add packages/server/src/pi/pi-run.service.ts packages/server/src/pi/pi-run.service.test.ts packages/server/src/job/job.scheduler.ts packages/server/src/job/job.scheduler.test.ts
git commit --only -m "feat(server): 持久化 Pi 运行元数据" -- packages/server/src/pi/pi-run.service.ts packages/server/src/pi/pi-run.service.test.ts packages/server/src/job/job.scheduler.ts packages/server/src/job/job.scheduler.test.ts
```

---

### Task 8: Server request/event broker 与 ClientGateway

**Files:**

- Create: `packages/server/src/pi/pi-request-broker.ts`, `pi-request-broker.test.ts`
- Create: `packages/server/src/pi/pi-event-broker.ts`, `pi-event-broker.test.ts`
- Modify: `packages/server/src/events/client.gateway.ts`, `client.gateway.test.ts`

**Interfaces:**

- `PiRequestBroker.bindEmitter/request/resolve(clientId,response)/disconnect`。
- `PiEventBroker.publish/stream/handleState`；Browser stream 是 `clientId + sessionId` 级，事件自身仍带 runId。

- [ ] **Step 1: impact**

Targets: `ClientGateway.handleConnection`、`handleDisconnect`、`handleRegister`。

- [ ] **Step 2: 写 request broker 失败测试**

覆盖 requestId 并发与乱序、15 秒 timeout、断线 reject、重复/未知 response 忽略、日志不含 payload；第二台 Client 用第一台 requestId 伪造 response 必须被拒绝。

```ts
await expect(broker.request("c1", request, 10)).rejects.toMatchObject({
  code: "PI_REQUEST_TIMEOUT",
});
```

- [ ] **Step 3: 写 event broker 失败测试**

覆盖：Session stream 收同 session 的事件并按 event.runId 识别；跨 client/session 隔离；>256 KiB → history_changed；thinking 正文移除；Extension request→waiting_input；response→running；`agent_end` 不 terminal；`prompt_done`/`agent_settled` 后查询 state，idle+queue empty 只进入 cancellable grace；grace 内 `agent_start` 取消，期满二次查询才 settle；30 秒 SSE heartbeat；state report 恢复 active/terminal 并返回 accepted IDs。第二台 Client 伪造第一台 event/state，以及 event 的 jobId/clientId/sessionId/runId 不匹配当前 Job，都必须被拒绝。

- [ ] **Step 4: 红灯**

Run: `pnpm --filter @vcpdeck/server test -- src/pi/pi-request-broker.test.ts src/pi/pi-event-broker.test.ts`
Expected: FAIL。

- [ ] **Step 5: 实现 brokers**

Request broker 使用 `Map<requestId, { clientId, resolve, reject, timer }>`，resolve 时比较已认证 socket 的 clientId。Event broker 使用按 `clientId + sessionId` 自动回收的 RxJS `Subject`，SSE stream 合并 heartbeat；publish 修改 Job 前必须查验 `jobId + clientId + sessionId + runId`。

Settlement：

```ts
const state = await requestBroker.request(clientId, {
  requestId: randomUUID(), action: "agent.state", sessionId, jobId, runId,
});
if (isIdleState(state) && state.queuedMessages.steering.length === 0 && state.queuedMessages.followUp.length === 0) {
  await runService.scheduleSettlement(jobId, state); // grace 到期后 broker 再查一次 state
}
```

- [ ] **Step 6: 接入 Gateway**

Gateway `afterInit` bind emitter；`handleRegister` 改为在 `register/bindSocket/join` 全部完成后调用 Socket.IO callback ack（可暂时保留旧 `"ack"` event 兼容旧 Client）。新增 PI_RESPONSE/PI_EVENT/PI_STATE handlers，每个都接收 `@ConnectedSocket()`，通过 `ClientService.getClientIdBySocketId(socket.id)` 取得绑定 identity，并对 payload 先运行 Shared parser。PI_RESPONSE 把绑定 clientId 交给 broker resolve；PI_EVENT/PI_STATE 要求 payload clientId 与绑定值一致。Disconnect reject pending + mark disconnected，但不请求 Client 停 Worker。PI_STATE ack 返回 acceptedRunIds。

- [ ] **Step 7: 验证与提交**

```bash
pnpm --filter @vcpdeck/server test -- src/pi/pi-request-broker.test.ts src/pi/pi-event-broker.test.ts src/events/client.gateway.test.ts
pnpm --filter @vcpdeck/server build
git add packages/server/src/pi/pi-request-broker.ts packages/server/src/pi/pi-request-broker.test.ts packages/server/src/pi/pi-event-broker.ts packages/server/src/pi/pi-event-broker.test.ts packages/server/src/events/client.gateway.ts packages/server/src/events/client.gateway.test.ts
git commit --only -m "feat(server): 桥接远程 Pi 事件" -- packages/server/src/pi/pi-request-broker.ts packages/server/src/pi/pi-request-broker.test.ts packages/server/src/pi/pi-event-broker.ts packages/server/src/pi/pi-event-broker.test.ts packages/server/src/events/client.gateway.ts packages/server/src/events/client.gateway.test.ts
```

---

### Task 9: Server Pi REST/SSE 与 SDK

**Files:**

- Create: `packages/server/src/pi/pi.controller.ts`, `pi.controller.test.ts`, `pi.module.ts`
- Modify: `packages/server/src/app.module.ts`, `events/events.module.ts`
- Create: `packages/sdk/src/pi.ts`, `pi.test.ts`
- Modify: `packages/sdk/src/client.ts`, `index.ts`

**Interfaces:**

- Produces machine-scoped Pi REST/SSE endpoints。
- Produces `VcpDeckClient.pi`: capability/models/sessions/agent/eventsPath。

- [ ] **Step 1: impact**

Targets: `AppModule`、`EventsModule`、`VcpDeckClient` constructor。

- [ ] **Step 2: 写 Controller 失败测试**

Mock brokers/run service，覆盖：sessions/models 转发 cwdRef；session detail/context/content；每个写操作先 `project.resolve`，别名 cwd 得到同 opaque projectKey；prompt 请求带 transient `submissionId`，先 create sanitized run，再向 session SSE 发布匹配的安全 `run_created{submissionId,runId}`，最后 dispatch，并返回权威 `PiPromptAccepted { jobId, runId, sessionId }`；Controller 与 SDK 测试必须断言三个字段，供 SSE 断线 fallback；request fail 时 Job fail；active Owner 可 steer/followUp/abort/extension/compact/abort-compact；active 时 model/thinking/rename/delete/fork/clone/navigate 对所有身份拒绝；idle model/thinking/rename/delete/fork/clone/navigate 走短 mutation lock；idle compact 持有 lease，只有 initiator 可 abort-compact；SSE Observer 无需 Owner；body 经 Shared parser/手工参数校验返回稳定 400；running endpoint 用于 reattach。`submissionId`/projectKey 不写 Job/日志/数据库。

- [ ] **Step 3: 写 SDK 失败测试**

```ts
await client.pi.sessions.list("c/1", { rootDir: "D:\\", relativePath: "repo" });
expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/clients/c%2F1/pi/sessions?"), expect.any(Object));
expect(client.pi.agent.eventsPath("c/1", "s/1")).toContain("c%2F1");
```

- [ ] **Step 4: 红灯**

```bash
pnpm --filter @vcpdeck/server test -- src/pi/pi.controller.test.ts
pnpm --filter @vcpdeck/sdk test -- src/pi.test.ts
```

Expected: FAIL。

- [ ] **Step 5: 实现 Controller**

Prefix `api/clients/:clientId/pi`。使用 `@Actor()`；沿用项目手动校验，不引入 ValidationPipe。Endpoints：

```text
GET    capability
GET    models?rootDir=&relativePath=
GET    sessions?rootDir=&relativePath=
GET    sessions/:sessionId?rootDir=&relativePath=
GET    sessions/:sessionId/context?rootDir=&relativePath=&leafId=&cursor=
GET    sessions/:sessionId/entries/:entryId/content?rootDir=&relativePath=&blockIndex=
PATCH  sessions/:sessionId
DELETE sessions/:sessionId
POST   sessions/:sessionId/fork
POST   sessions/:sessionId/clone
POST   sessions/:sessionId/navigate
POST   agent/new
GET    agent/:sessionId
POST   agent/:sessionId
GET    agent/:sessionId/events
GET    running
POST   agent/:sessionId/steer
POST   agent/:sessionId/follow-up
POST   agent/:sessionId/abort
POST   agent/:sessionId/compact
POST   agent/:sessionId/abort-compact
POST   agent/:sessionId/model
POST   agent/:sessionId/thinking
POST   agent/:sessionId/extension-response
```

New Session 与 prompt 必须分开。SSE 是 session-level，不要求 prompt 后才存在的 runId：`agent/new` 返回真实 sessionId → Frontend 连接 `/events` 并等 connected → POST prompt（带 transient `submissionId`）→ Server 创建 Job 后先发 `run_created` 再 dispatch。Frontend 以 submissionId 绑定 runId；每个后续事件携带 runId，generation/runId 丢弃旧 run。这样 prompt HTTP ack 前出现的首个 Agent 事件也不会丢失。

- [ ] **Step 6: 装配模块**

避免循环：`PiModule` imports Client/Job/File/Storage，exports brokers/services；`EventsModule` imports PiModule；PiModule 不 import EventsModule；AppModule import PiModule 提供 Controller。

- [ ] **Step 7: 实现 SDK**

`createPiApi(client)` 使用 URLSearchParams/encodeURIComponent。`eventsPath(clientId, sessionId)` 返回 session-level path，不接收 runId；Frontend cookie auth 用 EventSource。SDK method/path 必须逐项与上面的批准 API 表一致。

- [ ] **Step 8: 验证与提交**

```bash
pnpm --filter @vcpdeck/server test -- src/pi/pi.controller.test.ts
pnpm --filter @vcpdeck/server build
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/sdk build
git add packages/server/src/pi/pi.controller.ts packages/server/src/pi/pi.controller.test.ts packages/server/src/pi/pi.module.ts packages/server/src/app.module.ts packages/server/src/events/events.module.ts packages/sdk/src/pi.ts packages/sdk/src/pi.test.ts packages/sdk/src/client.ts packages/sdk/src/index.ts
git commit --only -m "feat(server): 提供远程 Pi API" -- packages/server/src/pi/pi.controller.ts packages/server/src/pi/pi.controller.test.ts packages/server/src/pi/pi.module.ts packages/server/src/app.module.ts packages/server/src/events/events.module.ts packages/sdk/src/pi.ts packages/sdk/src/pi.test.ts packages/sdk/src/client.ts packages/sdk/src/index.ts
```

---

### Task 10: Frontend 结构化消息与回合分组

**Files:**

- Modify: `packages/frontend/package.json`, `pnpm-lock.yaml`
- Create: `packages/frontend/src/pi/normalize.ts`, `normalize.test.ts`
- Create: `packages/frontend/src/pi/turn-groups.ts`, `turn-groups.test.ts`
- Create: `packages/frontend/src/pi/pi-message-view.tsx`, `pi-message-view.test.tsx`

**Interfaces:**

- Produces: `normalizeToolCalls()`、`buildTurnGroups()`、`PiMessageView`。

- [ ] **Step 1: 添加最小 Markdown 依赖**

```bash
pnpm --filter @vcpdeck/frontend add react-markdown@10.1.0 remark-gfm@4.0.1
```

不添加 rehype-raw、Mermaid、KaTeX 或 syntax highlighter。

- [ ] **Step 2: 写失败测试**

ToolCall 规范化 `{id,name,arguments}`；process details 折叠；最终 assistant 独立；Markdown/GFM；Tool header/result/error/usage；防御性含 secret thinking 输入不渲染正文。

```ts
expect(normalizeToolCalls(raw)).toMatchObject({
  content: [{ toolCallId: "c1", toolName: "bash", input: { command: "pwd" } }],
});
```

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/frontend test -- src/pi/normalize.test.ts src/pi/turn-groups.test.ts src/pi/pi-message-view.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 移植纯逻辑**

从 Pi Web `normalize`、`findFinalAssistantIndex` 和 `ProcessDetailsGroup` 逻辑移植为纯函数，不复制整组件。

- [ ] **Step 5: 实现安全 MessageView**

`react-markdown + remark-gfm`，禁 raw HTML；link rel noopener；Tool 默认摘要、展开 bounded params/result；edit result 用普通 `<pre>`；thinking 只显示阶段/时长。

- [ ] **Step 6: 验证与提交**

```bash
pnpm --filter @vcpdeck/frontend test -- src/pi/normalize.test.ts src/pi/turn-groups.test.ts src/pi/pi-message-view.test.tsx
pnpm --filter @vcpdeck/frontend build
git add packages/frontend/package.json pnpm-lock.yaml packages/frontend/src/pi/normalize.ts packages/frontend/src/pi/normalize.test.ts packages/frontend/src/pi/turn-groups.ts packages/frontend/src/pi/turn-groups.test.ts packages/frontend/src/pi/pi-message-view.tsx packages/frontend/src/pi/pi-message-view.test.tsx
git commit --only -m "feat(frontend): 渲染 Pi 结构化消息" -- packages/frontend/package.json pnpm-lock.yaml packages/frontend/src/pi/normalize.ts packages/frontend/src/pi/normalize.test.ts packages/frontend/src/pi/turn-groups.ts packages/frontend/src/pi/turn-groups.test.ts packages/frontend/src/pi/pi-message-view.tsx packages/frontend/src/pi/pi-message-view.test.tsx
```

---

### Task 11: Frontend SSE 与 `usePiSession` 状态机

**Files:**

- Create: `packages/frontend/src/pi/pi-stream.ts`, `pi-stream.test.ts`
- Create: `packages/frontend/src/pi/use-pi-session.ts`, `use-pi-session.test.tsx`

**Interfaces:**

- Produces: `openPiEventStream(path, handlers)`。
- Produces hook state/actions: messages/session/agent/runId/send/steer/followUp/abort/compact/model/thinking/extension/navigate/fork/clone。

- [ ] **Step 1: 完整阅读 Pi Web 回归基准**

Read: `examples/pi-web/hooks/useAgentSession.ts`、`examples/pi-web/hooks/useAgentSession.test.mjs`、`examples/pi-web/app/api/agent/events-route.test.mjs`。记录 stream ready timeout、30 秒 idle grace、reconcile 与 settlement 行为。

- [ ] **Step 2: 写状态机失败测试**

覆盖：session-level stream connected 前不 prompt，且 URL 不需要尚未创建的 runId；复用 open stream；每次 send 生成 submissionId，正常路径用 `run_created` 在 prompt HTTP response 前绑定 runId，紧随其后的首个 Agent event 不丢失；若 SSE 在 `run_created` 前断开，则同 generation 的 prompt HTTP response 或 reconnect 后权威 agent/running state 可补绑 runId；不匹配 submissionId/runId 的迟到事件丢弃；`agent_end` 不结束；`prompt_done/agent_settled` 后 history+state reconcile；grace 期间 extension-injected `agent_start` 取消关闭；visibility/online reconcile；断线后 idle state 完成 UI；new→stream ready→prompt；prompt delivery fail 保留空 Session。

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/frontend test -- src/pi/pi-stream.test.ts src/pi/use-pi-session.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 实现 EventSource wrapper**

使用 native EventSource/cookie auth，封装 connected promise、fatal close、自动 reconnect、manual close。解析失败不记录 raw event body。

- [ ] **Step 5: 实现 reducer 与 monotonic generation**

```ts
const promptGenerationRef = useRef(0);
const activeRunIdRef = useRef<string | null>(null);
const sessionIdRef = useRef<string | null>(null);
```

所有 async result 写 state 前检查 generation/runId。Send 前生成 `submissionId = crypto.randomUUID()` 并标记 pending generation；匹配 `run_created` 是正常快速路径。若尚未绑定，当前 generation 的 POST response 可原子补绑 activeRunId；若 response 也丢失，reconnect 后 `GET agent/:sessionId` 或 `GET running` 的权威 snapshot 可在确认 session/owner/status 后补绑。已绑定时任何来源的不同 runId 都拒绝，防止旧 run 复活。历史是事实来源；实时只维护 streaming tail；`history_changed` debounce reload。

- [ ] **Step 6: settlement/reconcile/grace**

不在 `agent_end` close；终态先 get state；idle 后 30 秒 grace；visibility/online 立即 reconcile；unmount 只 close Browser stream，不 abort Worker。

- [ ] **Step 7: 验证与提交**

```bash
pnpm --filter @vcpdeck/frontend test -- src/pi/pi-stream.test.ts src/pi/use-pi-session.test.tsx
pnpm --filter @vcpdeck/frontend build
git add packages/frontend/src/pi/pi-stream.ts packages/frontend/src/pi/pi-stream.test.ts packages/frontend/src/pi/use-pi-session.ts packages/frontend/src/pi/use-pi-session.test.tsx
git commit --only -m "feat(frontend): 管理 Pi 会话状态" -- packages/frontend/src/pi/pi-stream.ts packages/frontend/src/pi/pi-stream.test.ts packages/frontend/src/pi/use-pi-session.ts packages/frontend/src/pi/use-pi-session.test.tsx
```

---

### Task 12: Frontend 三栏 Pi Panel 与完整 Session UI

**Files:**

- Create: `packages/frontend/src/pages/pi-panel.tsx`, `pi-panel.test.tsx`
- Create: `packages/frontend/src/pi/pi-session-sidebar.tsx`
- Create: `packages/frontend/src/pi/pi-chat-window.tsx`
- Create: `packages/frontend/src/pi/pi-chat-input.tsx`
- Create: `packages/frontend/src/pi/pi-branch-navigator.tsx`
- Create: `packages/frontend/src/pi/pi-run-details.tsx`
- Create: `packages/frontend/src/pi/pi-extension-dialog.tsx`
- Create: `packages/frontend/src/pi/pi-project-picker.tsx`
- Modify: `packages/frontend/src/pages/machine-workspace.tsx`, `machine-workspace.test.tsx`
- Modify: `packages/frontend/src/app/routes.tsx`

**Interfaces:**

- Route: `/machines/:clientId/pi`。
- Desktop: 初始 280px left / fluid center / 320px right，左右宽度可拖动；窄屏使用现有 Drawer。

- [ ] **Step 1: impact**

Targets: `MachineWorkspace`、internal `Workspace`、`AppRoutes`、`useFileBrowser`。若修改 hook 则先 impact；优先直接复用其 public surface。

- [ ] **Step 2: 写 Pi Panel 失败测试**

Mock SDK/EventSource。覆盖：

- machine nav 有 Pi tab 并 route render；
- capability unavailable 显示对应 code/reason，所有 prompt 控件 disabled；
- 三栏 landmark/project/session/chat/details；
- 从 Files roots/list 选择目录，不接受自由路径；
- Session new/resume/rename/delete/fork/clone/navigate；
- Owner 控件可用，Observer disabled 且仍见历史；
- Extension select/confirm/input/editor，以及 notify/status/widget/title/editor-text 的非阻塞展示；
- 最近项目按机器分组、限量写 localStorage，再选择时由 Client 重验；
- Run Details 含 canonical cwd、context window/percent、cost、Session ID、Job/Run ID；
- 显示“cwd 不是沙箱、继承远程 OS 用户权限”的高权限告警；
- desktop resize handle 与 mobile 两个 Drawer；
- Execute tab 仍存在。

- [ ] **Step 3: 红灯**

Run: `pnpm --filter @vcpdeck/frontend test -- src/pages/pi-panel.test.tsx src/pages/machine-workspace.test.tsx`
Expected: FAIL。

- [ ] **Step 4: 实现目录 picker 与 sidebar**

`PiProjectPicker` 复用 `sdk.files.roots/list`（可直接复用 `useFileBrowser`，若其单选状态不适合则只抽取一个无副作用的 path helper）。只允许目录 entry。最近项目 localStorage 只存 `{clientId,rootDir,relativePath}`，每机器最多 10 个；重新选择先调用 capability/session query 触发 canonical validation，越界/不存在时移除。Sidebar 参考 Pi Web：project header、new、active session、rename/delete/fork/clone actions；delete confirm 用现有 Dialog。

- [ ] **Step 5: 实现 center chat**

`PiChatWindow` 做 cursor 上翻、Process Details、streaming tail、branch navigator、空 Session recoverable state。`PiChatInput` 支持：

- idle prompt；
- running 时 Steer/Follow-up 切换；
- abort；
- compact/abort compact；
- slash command autocomplete；
- model/thinking controls；
- attachment draft slots。

不实现 `!`/`!!` 或 terminal semantics。

- [ ] **Step 6: 实现 right details 与 Extension UI**

Right panel 显示 provider/model、thinking level（无正文）、context tokens/window/percent、usage/cost、canonical cwd、Session ID、Job/Run ID、owner/observer、queue counts、run status/timestamps。运行期 model/thinking disabled。Extension dialog 使用现有 Dialog；editor 用 textarea；Owner response 调 hook action；notify/status/widget/title/editor-text 只展示安全字符串行。页面固定显示 cwd 非沙箱高权限告警。

- [ ] **Step 7: route 与 responsive layout**

Machine nav 的 Pi item 指向 `/machines/${client.id}/pi`；`Workspace` 对 `tab === "pi"` 渲染 `PiPanel`。Desktop 用 pointer/keyboard accessible separators 调整左右宽度并保存在 localStorage；`lg` 以下左右 Drawer；保证输入框与 active controls 可键盘访问，status 非只靠颜色。

- [ ] **Step 8: 验证与提交**

```bash
pnpm --filter @vcpdeck/frontend test -- src/pages/pi-panel.test.tsx src/pages/machine-workspace.test.tsx src/pages/execute-panel.test.tsx
pnpm --filter @vcpdeck/frontend build
git add packages/frontend/src/pages/pi-panel.tsx packages/frontend/src/pages/pi-panel.test.tsx packages/frontend/src/pi/pi-session-sidebar.tsx packages/frontend/src/pi/pi-chat-window.tsx packages/frontend/src/pi/pi-chat-input.tsx packages/frontend/src/pi/pi-branch-navigator.tsx packages/frontend/src/pi/pi-run-details.tsx packages/frontend/src/pi/pi-extension-dialog.tsx packages/frontend/src/pi/pi-project-picker.tsx packages/frontend/src/pages/machine-workspace.tsx packages/frontend/src/pages/machine-workspace.test.tsx packages/frontend/src/app/routes.tsx
git commit --only -m "feat(frontend): 添加远程 Pi 工作区" -- packages/frontend/src/pages/pi-panel.tsx packages/frontend/src/pages/pi-panel.test.tsx packages/frontend/src/pi/pi-session-sidebar.tsx packages/frontend/src/pi/pi-chat-window.tsx packages/frontend/src/pi/pi-chat-input.tsx packages/frontend/src/pi/pi-branch-navigator.tsx packages/frontend/src/pi/pi-run-details.tsx packages/frontend/src/pi/pi-extension-dialog.tsx packages/frontend/src/pi/pi-project-picker.tsx packages/frontend/src/pages/machine-workspace.tsx packages/frontend/src/pages/machine-workspace.test.tsx packages/frontend/src/app/routes.tsx
```

---

### Task 13: 图片 FileRef、Client 校验与历史媒体惰性加载

**Files:**

- Modify: `packages/shared/src/pi.ts`
- Modify: `packages/server/prisma/schema.prisma`
- Create: `packages/server/prisma/migrations/20260807000002_add_pi_file_scope/migration.sql`
- Modify: `packages/server/src/file/file.service.ts`, `file.service.test.ts`, `file-cleanup.service.ts`
- Modify: `packages/server/src/storage/providers/storage-provider.interface.ts`
- Modify: `packages/server/src/storage/storage.service.ts`, `storage.service.test.ts`
- Create: `packages/server/src/pi/pi-attachment.service.ts`, `pi-attachment.service.test.ts`
- Modify: `packages/server/src/pi/pi.controller.ts`, `pi.controller.test.ts`, `pi.module.ts`
- Modify: `packages/sdk/src/pi.ts`, `pi.test.ts`
- Create: `packages/client/src/pi/images.ts`, `images.test.ts`
- Modify: `packages/client/src/pi/worker.ts`, `session-reader.ts`
- Modify: `packages/frontend/src/pi/pi-chat-input.tsx`, `pi-message-view.tsx`, `use-pi-session.ts`
- Create: `packages/frontend/src/pi/pi-attachments.test.tsx`

**Interfaces:**

- Produces: `PiAttachmentDraft`、transient `PiAttachmentRef`、`PiDeferredMediaRef`。
- Produces Server endpoints: create/complete prompt upload；prepare history media download。
- Produces Client `downloadPromptImages(refs)` 与 Worker history-image upload event。

- [ ] **Step 1: impact**

Targets: `FileService.createPending/createDownloadToken/delete/getExpiredFiles`、`FileCleanupService.cleanup`、`StorageService.createUploadToken/createDownloadToken/receiveUpload`、`PiController`、`PiSessionReader.entryContent`。HIGH/CRITICAL 停止。

- [ ] **Step 2: 写 Server attachment 失败测试**

覆盖：最多 10；每张 ≤10 MiB；总量 ≤100 MiB；MIME allowlist；当前模型不支持 image input 时在创建 Job 前拒绝；创建 File row `purpose=pi_prompt`、15 分钟 TTL、目标 client；complete 后比对 size/mime/hash；prompt accepted/rejected/worker fail 都 cleanup；download ref 只用于指定 client；历史图片由 Client 临时上传，返回短时 GET ref；普通响应/日志/Job 不持久化 signed URL。

```ts
await expect(service.createPromptUploads(actor, "c1", elevenImages)).rejects.toMatchObject({
  code: "PI_IMAGE_INVALID",
});
expect(await prisma.file.findMany()).toEqual(expect.arrayContaining([
  expect.objectContaining({ purpose: "pi_prompt", clientId: "c1" }),
]));
```

- [ ] **Step 3: 写 Client 图片失败测试**

Mock fetch streams，覆盖：Content-Length 与真实 bytes 双上限；总量；declared MIME；PNG/JPEG/GIF/WebP magic；SHA-256；FileRef 的 fileId/expected hash/size/MIME/allowed origin；默认 `redirect:"manual"`，如 Storage provider 必须 redirect 则逐跳校验协议与 allowlist；下载后生成 Pi SDK image content；任何失败清全部 buffer 并返回 `PI_IMAGE_INVALID/TOO_LARGE`。不能凭 URL 参数外观判断可信。

- [ ] **Step 4: 写 Frontend 图片失败测试**

覆盖 picker/drag-drop；idle-only；10/10MiB/100MiB 客户端提示；create upload→XHR PUT→complete→prompt refs；running steer/follow-up 禁图片；历史 placeholder 点击后请求短时 URL；草稿按 `clientId+sessionId/new-project` 存内存/local draft metadata，但不把 File 内容写 localStorage。

- [ ] **Step 5: 红灯**

```bash
pnpm --filter @vcpdeck/server test -- src/pi/pi-attachment.service.test.ts src/pi/pi.controller.test.ts src/file/file.service.test.ts src/storage/storage.service.test.ts
pnpm --filter @vcpdeck/client test -- src/pi/images.test.ts
pnpm --filter @vcpdeck/frontend test -- src/pi/pi-attachments.test.tsx
```

Expected: FAIL。

- [ ] **Step 6: 扩展 File TTL scope**

`File` 同时调整：

```prisma
jobId   String?
purpose String  @default("job")
```

SQLite migration 使用 table-rebuild 保留全部既有 File rows，把 `jobId` 改为 nullable 并加 purpose；不得创建伪 Job。当前 schema 的 `File.jobId` 只是无 relation 的标量，因此不需要新增/修改 Prisma relation。`FileMeta.jobId`、`FileService.createPending()` 的 jobId 同步改 optional；Storage progress 只在非空 jobId 且 job type 为 `file.import` 时更新。`file.service.test.ts` 与 `storage.service.test.ts` 覆盖：旧 Job file 行为、null jobId 的 pi_prompt/pi_history upload、默认 purpose、expiresAt、download/delete。Cleanup 继续复用现有 scheduler。

- [ ] **Step 7: 实现 attachment service 与 API**

复用 `FileService/StorageService`，不建新存储抽象。Prompt upload session 返回 `{ fileId, uploadUrl, expiresAt }`；complete 读取 File record 校验；给 Client 的 transient descriptor 必须含 opaque fileId、expected hash/size/MIME、allowed origin/provider 与短期 GET URL；Client ack 后 best-effort delete，拒绝/失败由 finally+TTL cleanup。

历史 media 采用可执行三阶段协议：1) Client 验证 cwd/session/entry/block 并返回 MIME/size/hash；2) Server 创建 `purpose=pi_history` 短 TTL、绑定 clientId 的 File row和 signed PUT descriptor；3) Client 上传并 complete，Server 校验后才向 Browser 返回短期 GET ref。测试 upload fail、disconnect、missing complete、expired GET 与 TTL cleanup；任何 URL 不进入 Job/日志/普通 event。

- [ ] **Step 8: 实现 Client 校验**

`images.ts` 流式计数并 hash；magic signatures：PNG 8 bytes、JPEG FF D8 FF、GIF87a/GIF89a、WebP RIFF+WEBP。成功后才转 base64 并交 `agent.prompt(text,{images})`。不得在日志/IPC state/event 中放 base64。

- [ ] **Step 9: 实现 Frontend flow**

复用 `uploadFile()`；上传完成后 hook 仅持有 opaque fileId/ref metadata；send 后立即清 UI draft；失败保留可重试 draft。History image 用 `<button>` 惰性加载，loaded URL 不写缓存，过期可重新请求。

- [ ] **Step 10: 验证与提交**

```bash
pnpm --filter @vcpdeck/server exec prisma generate
pnpm --filter @vcpdeck/server test -- src/pi/pi-attachment.service.test.ts src/pi/pi.controller.test.ts src/file/file.service.test.ts src/storage/storage.service.test.ts
pnpm --filter @vcpdeck/client test -- src/pi/images.test.ts
pnpm --filter @vcpdeck/frontend test -- src/pi/pi-attachments.test.tsx
pnpm --filter @vcpdeck/server build
pnpm --filter @vcpdeck/client build
pnpm --filter @vcpdeck/frontend build
git add packages/shared/src/pi.ts packages/server/prisma/schema.prisma packages/server/prisma/migrations/20260807000002_add_pi_file_scope/migration.sql packages/server/src/file/file.service.ts packages/server/src/file/file.service.test.ts packages/server/src/file/file-cleanup.service.ts packages/server/src/storage/providers/storage-provider.interface.ts packages/server/src/storage/storage.service.ts packages/server/src/storage/storage.service.test.ts packages/server/src/pi/pi-attachment.service.ts packages/server/src/pi/pi-attachment.service.test.ts packages/server/src/pi/pi.controller.ts packages/server/src/pi/pi.controller.test.ts packages/server/src/pi/pi.module.ts packages/sdk/src/pi.ts packages/sdk/src/pi.test.ts packages/client/src/pi/images.ts packages/client/src/pi/images.test.ts packages/client/src/pi/worker.ts packages/client/src/pi/session-reader.ts packages/frontend/src/pi/pi-chat-input.tsx packages/frontend/src/pi/pi-message-view.tsx packages/frontend/src/pi/use-pi-session.ts packages/frontend/src/pi/pi-attachments.test.tsx
git commit --only -m "feat(pi): 支持临时图片附件" -- packages/shared/src/pi.ts packages/server/prisma/schema.prisma packages/server/prisma/migrations/20260807000002_add_pi_file_scope/migration.sql packages/server/src/file/file.service.ts packages/server/src/file/file.service.test.ts packages/server/src/file/file-cleanup.service.ts packages/server/src/storage/providers/storage-provider.interface.ts packages/server/src/storage/storage.service.ts packages/server/src/storage/storage.service.test.ts packages/server/src/pi/pi-attachment.service.ts packages/server/src/pi/pi-attachment.service.test.ts packages/server/src/pi/pi.controller.ts packages/server/src/pi/pi.controller.test.ts packages/server/src/pi/pi.module.ts packages/sdk/src/pi.ts packages/sdk/src/pi.test.ts packages/client/src/pi/images.ts packages/client/src/pi/images.test.ts packages/client/src/pi/worker.ts packages/client/src/pi/session-reader.ts packages/frontend/src/pi/pi-chat-input.tsx packages/frontend/src/pi/pi-message-view.tsx packages/frontend/src/pi/use-pi-session.ts packages/frontend/src/pi/pi-attachments.test.tsx
```

---

### Task 14: 断线/重启/安全集成回归

**Files:**

- Create: `packages/client/src/pi/pi-worker.integration.test.ts`
- Create: `packages/server/src/pi/pi-flow.integration.test.ts`
- Create: `packages/frontend/src/pi/pi-reconnect.integration.test.tsx`
- Modify: implementation files only where these tests reveal a defect

**Test boundary:**

- Client integration 使用临时 `PI_CODING_AGENT_DIR`、临时 cwd 和 fake model/provider/AgentSession factory，真实创建 JSONL 与 Worker child process。
- Server integration 使用 loopback `PiRequestBroker` emitter 和协议 fake Client；不得让 Server test import Client package。
- Frontend integration 使用真实 `usePiSession + PiPanel`，mock SDK transport/EventSource；不得 snapshot-only。

- [ ] **Step 1: 写 Client Worker integration**

覆盖：new Session→prompt→Tool Call→result→answer；resume 第二轮；rename/delete/fork/clone/navigate；同 cwd busy/different cwd parallel；Project Trust confirm 映射 Extension UI；Fork wrapper 清理；Socket bridge detached 期间 Worker 继续，state report 含 terminal；parent/Client restart 时 active turn 失败但 JSONL 可恢复；thinking 不出 IPC；图片 FileRef/hash/magic/cleanup。

- [ ] **Step 2: 写 Server loopback integration**

协议 fake 收 PI_REQUEST 并异步回 PI_RESPONSE/PI_EVENT/PI_STATE。覆盖：Owner prompt→sanitized Job→SSE→settled；Observer 收 SSE 但 control 403；迟到旧 runId 丢弃；disconnect→disconnected→state reconcile；restart 无 active report→`PI_CLIENT_RESTARTED`；数据库 JSON 搜索不含 sentinel prompt/image URL/thinking/tool args/result。

```ts
const leaked = JSON.stringify(await dumpPiRows(prisma));
for (const secret of [promptSentinel, signedUrlSentinel, thinkingSentinel, toolResultSentinel]) {
  expect(leaked).not.toContain(secret);
}
```

- [ ] **Step 3: 写 Frontend reconnect integration**

覆盖两阶段 new Session、stream reconnect、history reconciliation、old run race、Owner/Observer、Extension waiting、branch navigation、图片 upload/cleanup、mobile drawer，确认 Execute route 无回归。

- [ ] **Step 4: 运行 integration tests 并修最小缺陷**

```bash
pnpm --filter @vcpdeck/client test -- src/pi/pi-worker.integration.test.ts
pnpm --filter @vcpdeck/server test -- src/pi/pi-flow.integration.test.ts
pnpm --filter @vcpdeck/frontend test -- src/pi/pi-reconnect.integration.test.tsx
```

先运行并记录结果：若 PASS，不修改实现；若 FAIL，只修导致失败的最小根因并重跑。严格 red/green 已在 Task 1–13 的行为实现前完成，本任务不人为制造失败。

- [ ] **Step 5: 运行完整 Pi 回归**

```bash
pnpm --filter @vcpdeck/client test -- src/pi
pnpm --filter @vcpdeck/server test -- src/pi src/events/client.gateway.test.ts src/job/job.scheduler.test.ts
pnpm --filter @vcpdeck/frontend test -- src/pi src/pages/pi-panel.test.tsx src/pages/machine-workspace.test.tsx src/pages/execute-panel.test.tsx
```

Expected: PASS。

- [ ] **Step 6: detect changes + commit**

先运行 `gitnexus_detect_changes({ scope: "all" })`，确认修复只涉及断线/安全预期流程。integration tests 可能暴露 Pi 目录外的根因（Client socket bridge、Gateway、scheduler、Shared/SDK 或 machine route）；允许修复这些最小根因，但禁止 `git add -A`。先用 `git diff --name-only` 生成并人工审核精确文件列表，再逐个列入：

```bash
files=(
  "packages/client/src/pi/pi-worker.integration.test.ts"
  "packages/server/src/pi/pi-flow.integration.test.ts"
  "packages/frontend/src/pi/pi-reconnect.integration.test.tsx"
)
# 每修复一个真实根因，就在审核该文件 diff 后，把它的真实 repo-relative 路径追加到 files 数组。
printf '%s\n' "${files[@]}"
git add -- "${files[@]}"
git diff --cached --name-only -- "${files[@]}"
git commit --only -m "test(pi): 覆盖远程会话恢复" -- "${files[@]}"
```

若无根因修复，数组保持三个 test 文件；不得把 `.gitmodules` 或 `examples/pi-web` 加入数组。

---

### Task 15: 运维文档与最终验证

**Files:**

- Modify: `README.md`
- Create: `docs/remote-pi-tab.md`
- Modify: `packages/client/package.json` only if an explicit `shellPath` config key must be documented in its existing config surface

- [ ] **Step 1: 写用户与运维文档**

`docs/remote-pi-tab.md` 说明：

- Pi Tab runtime 要求 Node `>=22.19.0`，但旧 Node 下 Client 的 exec/files/FRP 仍运行；Windows Pi-compatible Bash 探测和 `shellPath`；
- Client bundled Pi SDK `0.84.0`，复用远程 `~/.pi/agent`；
- Files roots 项目选择；Pi Tab vs Execute Tab；
- Owner/Observer、project lock、disconnect/restart 语义；
- Session JSONL source-of-truth 与完整 Session 操作；
- 图片限制、TTL、隐私；
- stable error codes 与排障；
- 不使用全局 Pi/PTY/PowerShell fallback。

README 只加简短功能项和文档链接，不复制全文。

- [ ] **Step 2: 文档一致性检查**

Run：

```bash
grep -R "\^0\.84\.0\|pi --mode rpc\|node-pty\|xterm" packages/client/package.json packages/client/src packages/server/src packages/frontend/src || true
grep -R "22\.19\.0\|0\.84\.0\|PI_BASH_NOT_FOUND" docs/remote-pi-tab.md packages/client/src/pi packages/shared/src/pi.ts
grep -R "promptSentinel\|thinkingSentinel\|signedUrlSentinel" packages/*/src/pi/*.test.*
```

Expected: production code 无禁用方案；文档和实现版本/错误码一致；安全 sentinel tests 存在。

- [ ] **Step 3: 主动诊断**

Run LSP diagnostics on：

```text
packages/shared/src/pi.ts
packages/client/src/pi/
packages/server/src/pi/
packages/sdk/src/pi.ts
packages/frontend/src/pi/
packages/frontend/src/pages/pi-panel.tsx
```

Expected: 0 errors。再运行 `lens_diagnostics({ mode: "all" })`，修复本会话编辑文件的 blocking findings。

- [ ] **Step 4: 全量自动验证**

当前仓库的 root `pnpm lint` 基线不可执行（workspace packages 未定义 lint script，且未安装 ESLint）；本功能不为此额外引入 linter。以 Task 15 Step 3 的 LSP/lens diagnostics 加下列真实脚本作为自动 gate：

```bash
pnpm test
pnpm build
```

Expected: exit 0。若 full test 太慢，仍必须完成，不能以 focused tests 代替最终验收。另运行一次 `pnpm lint` 记录其已知基线失败，但不得误报为本功能回归或声称 lint 通过。

- [ ] **Step 5: 手工平台验收**

逐项记录结果：

1. Windows Node 22.19+ + Git Bash：capability available，new/resume prompt 可用。
2. Windows 缺 Bash：Pi Tab disabled，`PI_BASH_NOT_FOUND`，Execute/Files 可用。
3. Windows Node <22.19：Pi Tab disabled，`PI_NODE_UNSUPPORTED`。
4. Linux + Bash：可用。
5. Desktop 三栏；中屏右 Drawer；小屏左右 Drawer。
6. Browser close/reopen：Worker 继续，history/Job reconcile。
7. Client restart：active run 标记 `PI_CLIENT_RESTARTED`，Session JSONL 可 resume。

无法访问某个平台时，在最终报告明确标为“未人工验证”，不得伪称通过。

- [ ] **Step 6: 最终 staged-file 与 graph 审计**

```bash
git status --short
git diff --cached --name-only
git log --oneline --decorate -15
```

Expected: `.gitmodules` 与 `examples/pi-web` 仍保持用户原有 staged 状态；任何计划相关 commit 都不包含它们。Run `gitnexus_detect_changes({ scope: "compare", base_ref: "ee8f462cb017fb2fc43d5f66a2890b0dc8525988" })`，确认影响只覆盖 remote Pi Tab、必要 Client metadata 和 Storage TTL scope。

- [ ] **Step 7: 文档 commit**

```bash
git add README.md docs/remote-pi-tab.md
git commit --only -m "docs: 说明远程 Pi Tab" -- README.md docs/remote-pi-tab.md
```

---

## Completion Checklist

- [ ] Shared protocol is fully discriminated and contains every stable error code.
- [ ] Node/Bash/SDK/auth capability failures disable only Pi Tab.
- [ ] Session list/history never expose project or JSONL absolute paths.
- [ ] Session new/resume/rename/delete/fork/clone/navigate all have tests.
- [ ] Same canonical cwd is serialized; different cwd runs in parallel.
- [ ] `agent_end` is non-terminal; settlement checks state and both queues.
- [ ] Owner/Observer is enforced on Server, not only hidden in Frontend.
- [ ] Browser/Server disconnect does not stop Worker; restart semantics are explicit.
- [ ] Prompt/response/tool/thinking/image/path data is absent from Jobs, logs and DB.
- [ ] Images use temporary FileRef, triple validation and TTL cleanup.
- [ ] Pi Web regressions are ported as behavioral tests, not imports or snapshots.
- [ ] Execute, Files, FRP and existing Job flows still pass.
- [ ] LSP/lens diagnostics、`pnpm test`、`pnpm build` pass；`pnpm lint` 的既有缺失-script baseline 已如实记录。
- [ ] `.gitmodules` and `examples/pi-web` are absent from every implementation commit.
