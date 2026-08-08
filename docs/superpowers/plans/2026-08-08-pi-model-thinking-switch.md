# Pi Model and Thinking Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在远程 Pi Tab 右侧详情面板支持当前 Session 的模型与思考深度切换，并保持空闲校验、当前 Session 范围和现有隐私边界。

**Architecture:** 复用已有 `models.list`、`model.set`、`thinking.set` REST/Socket/Worker 链路；Shared 增加模型与 SDK 原生思考级别类型，Client state 返回当前思考级别，Frontend Hook 管理模型列表和选择状态，`PiRunDetails` 负责两个控件。Frontend 的 `auto` 只表示“不发送 thinking.set、保留远端当前默认值”，不进入 Shared/Client 协议。

**Tech Stack:** TypeScript strict + NodeNext、NestJS、Vitest、React 18、Testing Library、Pi SDK 0.84.0、pnpm workspace。

## Global Constraints

- Pi SDK 版本固定为 `0.84.0`；不要静态增加主 Client 对 Pi SDK 的 import。
- Shared/Client 思考深度只允许 `off | minimal | low | medium | high | xhigh | max`；Frontend 的 `auto` 不发送远端请求。
- 模型和思考深度切换只作用于当前 Session，不写入项目级配置、全局配置、数据库、Job 或日志。
- Agent 运行、压缩、等待扩展输入时，Frontend 控件禁用；Server 继续执行最终 `PI_PROJECT_BUSY` 校验。
- 不新增状态管理库、配置层、模型元数据服务或 Endpoint。
- Job、日志、数据库不得出现 Prompt、响应正文、凭据、路径或 Session 文件路径。
- 注释和公共 JSDoc 使用简体中文；代码标识符和协议字段使用英文。
- 每次修改函数、方法或类前先运行 GitNexus upstream impact；提交前运行 `gitnexus_detect_changes({scope:"unstaged"})`。
- 保留用户暂存的 `.gitmodules` 与 `examples/pi-web`，使用显式 pathspec 提交。
- 遵循 TDD：先写一个会失败的测试，运行确认失败，再写最小生产代码。

---

## 文件与职责映射

- Modify: `packages/shared/src/pi.ts` — `PiThinkingLevel`、`PiModelInfo` 与 `PiAgentState` 状态字段。
- Modify: `packages/shared/src/index.ts` — 显式重新导出新增 Shared 类型。
- Test: `packages/shared/src/pi.test.ts` — 思考级别和模型状态契约。
- Modify: `packages/server/src/pi/pi.controller.ts` — `thinking.set` 参数使用 Shared 校验，保持现有 Endpoint。
- Test: `packages/server/src/pi/pi.controller.test.ts` — 有效/无效思考级别和空闲请求转发。
- Modify: `packages/client/src/pi/agent-session.ts` — `getState()` 返回 thinking level，`thinking.set` 拒绝非法值。
- Test: `packages/client/src/pi/agent-session.test.ts` — 状态字段和模型/思考动作。
- Modify: `packages/sdk/src/pi.ts` — `PiModelInfo` 和 `PiAgentApi`/`PiApi.models` 返回类型收紧。
- Test: `packages/sdk/src/pi.test.ts` — models、setModel、setThinking 请求路径和 body。
- Modify: `packages/frontend/src/pi/use-pi-session.ts` — 模型列表、当前选择、切换动作、错误恢复和 `auto` 语义。
- Test: `packages/frontend/src/pi/use-pi-session.test.tsx` — Hook 级加载/切换/失败/auto 回归。
- Modify: `packages/frontend/src/pi/pi-run-details.tsx` — 右侧模型和思考深度控件。
- Test: `packages/frontend/src/pi/pi-run-details.test.tsx` — 控件渲染、禁用、回调。
- Modify: `packages/frontend/src/pages/pi-panel.tsx` — 将 Hook 的模型状态和切换动作传给桌面右栏及详情抽屉。
- Test: `packages/frontend/src/pages/pi-panel.test.tsx` — 真实 PiPanel 模型/思考交互。
- Modify: `docs/remote-pi-tab.md` — 操作说明和 `auto` 语义。

---

## Task 1: Shared model and thinking-level contracts

**Files:**

- Modify: `packages/shared/src/pi.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/pi.test.ts`

**Interfaces:**

- Produce `PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- Produce `PiModelInfo = { provider: string; modelId: string }`.
- Extend `PiAgentState` with required `thinkingLevel: PiThinkingLevel`.
- Produce `PI_THINKING_LEVELS` and `isPiThinkingLevel(value: unknown): value is PiThinkingLevel` for trust-boundary checks.

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/src/pi.test.ts`:

```ts
import { isPiThinkingLevel } from "./pi.js";

it("只接受 Pi SDK 原生思考深度", () => {
  expect(isPiThinkingLevel("high")).toBe(true);
  expect(isPiThinkingLevel("auto")).toBe(false);
  expect(isPiThinkingLevel("unknown")).toBe(false);
});
```

Update one state fixture/assertion to require:

```ts
const state = {
  status: "idle",
  streaming: false,
  prompting: false,
  compacting: false,
  thinkingLevel: "off",
  queuedMessages: { steering: [], followUp: [] },
};
expect(state.thinkingLevel).toBe("off");
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/shared test
```

Expected: FAIL because `isPiThinkingLevel` and the new state contract do not exist yet.

- [ ] **Step 3: Implement the minimal Shared contract**

In `packages/shared/src/pi.ts`, add beside the Pi protocol types:

```ts
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiModelInfo {
  provider: string;
  modelId: string;
}

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" &&
    (PI_THINKING_LEVELS as readonly string[]).includes(value);
}
```

Change `PiAgentState` to:

```ts
export interface PiAgentState {
  status: "idle" | "running" | "compacting" | "waiting_for_extension_input";
  streaming: boolean;
  prompting: boolean;
  compacting: boolean;
  thinkingLevel: PiThinkingLevel;
  queuedMessages: { steering: unknown[]; followUp: unknown[] };
  model?: PiModelInfo;
  waitingForExtensionInput?: boolean;
}
```

Re-export `PI_THINKING_LEVELS`, `PiThinkingLevel`, and `PiModelInfo` from `packages/shared/src/index.ts` using the existing explicit export pattern.

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/shared build
```

Expected: Shared tests and TypeScript build pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/pi.ts packages/shared/src/index.ts packages/shared/src/pi.test.ts
git commit --only -m "feat(shared): 增加 Pi 模型与思考深度类型"
```

---

## Task 2: Client state and action validation

**Files:**

- Modify: `packages/client/src/pi/agent-session.ts`
- Test: `packages/client/src/pi/agent-session.test.ts`

**Interfaces:**

- Consume `PiThinkingLevel`, `isPiThinkingLevel`, and `PiAgentState` from Shared.
- `PiAgentSessionWrapperImpl.getState()` returns `thinkingLevel: PiThinkingLevel` from `this.inner.thinkingLevel`.
- `wrapper.send("thinking.set", { level })` rejects an invalid value with `PI_PROTOCOL_INVALID` before calling SDK.

- [ ] **Step 1: Run the existing Client wrapper tests to establish baseline**

Run:

```bash
pnpm --filter @vcpdeck/client exec vitest run src/pi/agent-session.test.ts
```

Expected: Existing tests pass before adding the new assertions.

- [ ] **Step 2: Write the failing tests**

Add to `packages/client/src/pi/agent-session.test.ts`:

```ts
it("agent.state 返回当前 thinking level", () => {
  const { inner, wrapper } = makeWrapper();
  inner.agent.state.thinkingLevel = "high";
  expect(wrapper.getState().thinkingLevel).toBe("high");
});

it("thinking.set 校验原生 level 后调用 SDK", async () => {
  const { inner, wrapper } = makeWrapper();
  await wrapper.send("thinking.set", { level: "high" });
  expect(inner.setThinkingLevel).toHaveBeenCalledWith("high");
  await expect(wrapper.send("thinking.set", { level: "auto" })).rejects.toMatchObject({
    code: "PI_PROTOCOL_INVALID",
  });
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/client exec vitest run src/pi/agent-session.test.ts
```

Expected: FAIL because `getState()` omits `thinkingLevel` and invalid levels are currently cast and forwarded.

- [ ] **Step 4: Implement the minimal Client behavior**

In `getState()` return:

```ts
thinkingLevel: this.inner.thinkingLevel,
```

In `case "thinking.set"` validate before calling the SDK:

```ts
const level = payload.level;
if (!isPiThinkingLevel(level)) {
  return {
    ok: false,
    error: { code: "PI_PROTOCOL_INVALID", message: "Invalid thinking level" },
  };
}
this.inner.setThinkingLevel(level);
return null;
```

Do not add `auto` to Client/SDK types; the Frontend will omit the request for `auto`.

- [ ] **Step 5: Run the tests and verify GREEN**

Run:

```bash
pnpm --filter @vcpdeck/client exec vitest run src/pi/agent-session.test.ts
pnpm --filter @vcpdeck/client build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/pi/agent-session.ts packages/client/src/pi/agent-session.test.ts
git commit --only -m "feat(client): 返回并校验 Pi 思考深度"
```

---

## Task 3: Server and SDK type/error coverage

**Files:**

- Modify: `packages/server/src/pi/pi.controller.ts`
- Modify: `packages/sdk/src/pi.ts`
- Test: `packages/server/src/pi/pi.controller.test.ts`
- Test: `packages/sdk/src/pi.test.ts`

**Interfaces:**

- Keep the existing endpoints:
  - `POST /api/clients/:clientId/pi/agent/:sessionId/model`
  - `POST /api/clients/:clientId/pi/agent/:sessionId/thinking`
- `setThinking` accepts only `PiThinkingLevel`; invalid values return `BadRequestException` with `PI_PROTOCOL_INVALID`.
- `PiApi.models()` returns `Promise<PiModelInfo[]>`.

- [ ] **Step 1: Write the failing Server tests**

In `packages/server/src/pi/pi.controller.test.ts`, add:

```ts
it("thinking.set 校验 SDK 原生 level 并转发 cwd/session", async () => {
  const { controller, requests, runs } = makeController();
  requests.request.mockResolvedValue({ ok: true, data: { projectKey: "k".repeat(64) } });

  await controller.setThinking("c1", "s1", {
    rootDir: "D:\\",
    relativePath: "repo",
    level: "high",
  });

  expect(runs.assertIdleMutation).toHaveBeenCalledWith("c1", "k".repeat(64));
  expect(requests.request).toHaveBeenLastCalledWith("c1", expect.objectContaining({
    action: "thinking.set",
    sessionId: "s1",
    cwdRef: { rootDir: "D:\\", relativePath: "repo" },
    payload: { level: "high" },
  }));
});

it("thinking.set 拒绝 auto 和未知 level", async () => {
  const { controller } = makeController();
  await expect(controller.setThinking("c1", "s1", {
    rootDir: "D:\\",
    relativePath: "repo",
    level: "auto",
  })).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
});
```

- [ ] **Step 2: Run the Server tests and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/pi/pi.controller.test.ts
```

Expected: the invalid `auto` case fails because the controller currently accepts any string.

- [ ] **Step 3: Implement Server validation and SDK types**

In `pi.controller.ts`, import `isPiThinkingLevel` and change the `setThinking` validation to:

```ts
if (!isPiThinkingLevel(level)) {
  throw badRequest("PI_PROTOCOL_INVALID", "invalid thinking level");
}
```

In `packages/sdk/src/pi.ts`:

```ts
import type { PiModelInfo, PiThinkingLevel } from "@vcpdeck/shared";

export interface PiAgentApi {
  // existing methods...
  setThinking(
    clientId: string,
    sessionId: string,
    cwdRef: PiCwdRef,
    level: PiThinkingLevel,
  ): Promise<unknown>;
}
```

Change `PiApi.models` to `Promise<PiModelInfo[]>` and the `models` implementation response type to the same. Keep the HTTP endpoint and request body unchanged.

- [ ] **Step 4: Add SDK request coverage**

In `packages/sdk/src/pi.test.ts`, add:

```ts
it("agent.setModel/setThinking 使用当前 session endpoint", async () => {
  const { client, fetcher } = makeClient();
  const cwdRef = { rootDir: "D:\\", relativePath: "repo" };

  await client.pi.agent.setModel("c1", "s1", cwdRef, "provider", "model");
  await client.pi.agent.setThinking("c1", "s1", cwdRef, "high");

  expect(fetcher.mock.calls[0]?.[0]).toContain("/api/clients/c1/pi/agent/s1/model");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  expect(fetcher.mock.calls[1]?.[0]).toContain("/api/clients/c1/pi/agent/s1/thinking");
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
});
```

- [ ] **Step 5: Run Server/SDK tests and verify GREEN**

Run:

```bash
pnpm --filter @vcpdeck/server exec vitest run src/pi/pi.controller.test.ts
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/server build
pnpm --filter @vcpdeck/sdk build
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/pi/pi.controller.ts packages/server/src/pi/pi.controller.test.ts packages/sdk/src/pi.ts packages/sdk/src/pi.test.ts
git commit --only -m "feat(pi): 校验思考深度并收紧接口类型"
```

---

## Task 4: Hook model loading and session-level switching

**Files:**

- Modify: `packages/frontend/src/pi/use-pi-session.ts`
- Test: `packages/frontend/src/pi/use-pi-session.test.tsx`

**Interfaces:**

- Add `PiModelInfo` to `PiSessionState` as `models: PiModelInfo[]`.
- Add `thinkingSelection: "auto" | PiThinkingLevel` to `PiSessionState`.
- Add actions:
  - `setModel(provider: string, modelId: string): Promise<void>`
  - `setThinking(level: "auto" | PiThinkingLevel): Promise<void>`
- `openSession` loads `pi.models(clientId, cwdRef)` and `agent.state`; if model loading fails, preserve session opening and expose `error`.
- Successful non-auto thinking switch updates both selection and `agentState.thinkingLevel`; `auto` updates only `thinkingSelection` and makes no SDK call.
- Failed switches leave the old selection/model and set `state.error`.
- `setModel` and non-auto `setThinking` must not run unless the current state is idle; the UI also disables them.

- [ ] **Step 1: Write failing Hook tests**

Extend `makePi()` state data with:

```ts
models: vi.fn(async () => [
  { provider: "p", modelId: "m1" },
  { provider: "p", modelId: "m2" },
]),
agent.state: vi.fn(async () => ({
  status: "idle",
  streaming: false,
  prompting: false,
  compacting: false,
  thinkingLevel: "off",
  model: { provider: "p", modelId: "m1" },
  queuedMessages: { steering: [], followUp: [] },
})),
```

Add tests:

```ts
it("打开 Session 加载模型并显示当前 thinking level", async () => {
  vi.stubGlobal("EventSource", MockEventSource);
  const pi = makePi();
  const { result } = renderHook(() => usePiSession(pi));

  await act(async () => {
    await result.current.actions.openSession("c1", "s1", CWD);
  });

  expect(result.current.state.models).toEqual([
    { provider: "p", modelId: "m1" },
    { provider: "p", modelId: "m2" },
  ]);
  expect(result.current.state.agentState?.thinkingLevel).toBe("off");
  expect(result.current.state.thinkingSelection).toBe("off");
});

it("切换模型和 thinking level，auto 不发送 setThinking", async () => {
  vi.stubGlobal("EventSource", MockEventSource);
  const pi = makePi();
  const { result } = renderHook(() => usePiSession(pi));
  await act(async () => result.current.actions.openSession("c1", "s1", CWD));

  await act(async () => result.current.actions.setModel("p", "m2"));
  await act(async () => result.current.actions.setThinking("high"));
  await act(async () => result.current.actions.setThinking("auto"));

  expect(pi.agent.setModel).toHaveBeenCalledWith("c1", "s1", CWD, "p", "m2");
  expect(pi.agent.setThinking).toHaveBeenCalledTimes(1);
  expect(pi.agent.setThinking).toHaveBeenCalledWith("c1", "s1", CWD, "high");
  expect(result.current.state.thinkingSelection).toBe("auto");
});
```

- [ ] **Step 2: Run the Hook tests and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/use-pi-session.test.tsx
```

Expected: FAIL because state and actions do not exist and `makePi()` has no model endpoint mock.

- [ ] **Step 3: Implement model loading and state actions**

Add Frontend-only types:

```ts
type PiThinkingSelection = "auto" | PiThinkingLevel;
```

Add `models` and `thinkingSelection` to `PiSessionState`/`INITIAL_STATE`. In `openSession`, request models in parallel with history/state, validate the response as `PiModelInfo[]`, and retain an empty list plus error if it fails.

Implement actions with the current refs:

```ts
setModel: async (provider, modelId) => {
  if (!isIdleState()) return;
  const c = clientIdRef.current;
  const s = sessionIdRef.current;
  const cwd = cwdRefRef.current;
  if (!c || !s || !cwd) return;
  try {
    await pi.agent.setModel(c, s, cwd, provider, modelId);
    await refreshState();
  } catch (err) {
    setState((st) => ({ ...st, error: errorText(err) }));
    throw err;
  }
},
setThinking: async (level) => {
  if (level === "auto") {
    setState((st) => ({ ...st, thinkingSelection: "auto", error: null }));
    return;
  }
  if (!isIdleState()) return;
  // call pi.agent.setThinking, then refreshState, then set thinkingSelection
},
```

Use the existing `agentState.status` and frontend `state.status` as the idle guard; do not add a second lock. Keep the previous controlled selection until the remote request succeeds, except `auto`, which is deliberately local no-op.

- [ ] **Step 4: Run Hook tests and verify GREEN**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/use-pi-session.test.tsx
```

Expected: all Hook tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/pi/use-pi-session.ts packages/frontend/src/pi/use-pi-session.test.tsx
git commit --only -m "feat(frontend): 支持 Pi 会话模型与思考切换"
```

---

## Task 5: Right-panel controls and PiPanel wiring

**Files:**

- Modify: `packages/frontend/src/pi/pi-run-details.tsx`
- Modify: `packages/frontend/src/pages/pi-panel.tsx`
- Test: `packages/frontend/src/pi/pi-run-details.test.tsx`
- Test: `packages/frontend/src/pages/pi-panel.test.tsx`

**Interfaces:**

- `PiRunDetails` receives:
  - `models: PiModelInfo[]`
  - `thinkingSelection: "auto" | PiThinkingLevel`
  - `disabled: boolean`
  - `onModelChange(provider: string, modelId: string): void`
  - `onThinkingChange(level: "auto" | PiThinkingLevel): void`
- The same props are used by desktop right panel and mobile details Drawer.
- Controls use native `<select>`; no new component dependency.
- Model option value is `${provider}\u0000${modelId}` to avoid ambiguity and display text is `${provider} / ${modelId}`.
- Thinking option labels are Chinese, values remain protocol strings.

- [ ] **Step 1: Write failing component tests**

Create `packages/frontend/src/pi/pi-run-details.test.tsx` with:

```tsx
it("渲染模型和思考深度选择器", () => {
  const onModelChange = vi.fn();
  const onThinkingChange = vi.fn();
  render(
    <PiRunDetails
      agentState={{
        status: "idle",
        streaming: false,
        prompting: false,
        compacting: false,
        thinkingLevel: "medium",
        model: { provider: "p", modelId: "m1" },
        queuedMessages: { steering: [], followUp: [] },
      }}
      models={[{ provider: "p", modelId: "m1" }, { provider: "p", modelId: "m2" }]}
      thinkingSelection="medium"
      disabled={false}
      onModelChange={onModelChange}
      onThinkingChange={onThinkingChange}
      runId={null}
      sessionId="s1"
      ownerName={null}
      isObserver={false}
    />,
  );
  expect(screen.getByLabelText("模型")).toHaveValue("p\u0000m1");
  expect(screen.getByLabelText("思考深度")).toHaveValue("medium");
});

it("运行中禁用两个选择器并转发空闲选择", () => {
  const onModelChange = vi.fn();
  const onThinkingChange = vi.fn();
  // render with disabled=true, assert both disabled;
  // render with disabled=false, fireEvent.change and assert callbacks.
});
```

Use actual `fireEvent.change` calls with `{ target: { value: "p\\u0000m2" } }` and `{ target: { value: "high" } }` so the test checks callback values, not just DOM presence.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-run-details.test.tsx
```

Expected: FAIL because the controls and props do not exist.

- [ ] **Step 3: Implement the controls**

Add a “模型” control below the current model display:

```tsx
<label className="block text-xs">
  模型
  <select
    aria-label="模型"
    disabled={disabled || models.length === 0}
    value={currentModelValue}
    onChange={(event) => {
      const [provider, modelId] = event.target.value.split("\u0000");
      if (provider && modelId) onModelChange(provider, modelId);
    }}
  >
    {models.map((model) => (
      <option key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>
        {model.provider} / {model.modelId}
      </option>
    ))}
  </select>
</label>
```

Add a thinking selector using exactly:

```ts
const THINKING_OPTIONS = [
  ["auto", "自动"],
  ["off", "关闭"],
  ["minimal", "最低"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "超高"],
  ["max", "最大"],
] as const;
```

Use `disabled={disabled}` and call `onThinkingChange(event.target.value as PiThinkingSelection)`.

In `PiPanel`, derive:

```ts
const settingsDisabled = !sessionId || state.status !== "idle" || state.agentState?.status !== "idle";
```

Pass models, thinking selection, and callbacks to both `PiRunDetails` instances. Use `void actions.setModel(...)` / `void actions.setThinking(...)`; Hook owns error state.

- [ ] **Step 4: Add PiPanel interaction assertions**

Update the existing PiPanel SDK mock so `pi.models` returns two models and `agent.state` includes `thinkingLevel` and `model`. After opening a Session, assert:

```ts
expect(screen.getByLabelText("模型")).toBeEnabled();
expect(screen.getByLabelText("思考深度")).toHaveValue("off");
```

Change the model select and assert `sdk.pi.agent.setModel` receives `("c1", "s1", CWD, "p", "m2")`; change thinking to `high` and assert `sdk.pi.agent.setThinking` receives `("c1", "s1", CWD, "high")`; change to `auto` and assert the call count does not increase.

- [ ] **Step 5: Run Frontend tests and verify GREEN**

Run:

```bash
pnpm --filter @vcpdeck/frontend exec vitest run src/pi/pi-run-details.test.tsx src/pages/pi-panel.test.tsx
pnpm --filter @vcpdeck/frontend build
```

Expected: all pass; build has only the existing dependency warnings.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/pi/pi-run-details.tsx packages/frontend/src/pi/pi-run-details.test.tsx packages/frontend/src/pages/pi-panel.tsx packages/frontend/src/pages/pi-panel.test.tsx
git commit --only -m "feat(frontend): 添加 Pi 模型与思考深度控件"
```

---

## Task 6: Documentation and full verification

**Files:**

- Modify: `docs/remote-pi-tab.md`
- No changes: `.gitmodules`, `examples/pi-web`

- [ ] **Step 1: Update operations documentation**

Add a Chinese section to `docs/remote-pi-tab.md` after the usage section:

```md
### 模型与思考深度

打开 Session 后，右侧“运行详情”可切换当前 Session 的模型和思考深度。模型显示为 `provider / modelId`；思考深度支持自动、关闭、最低、低、中、高、超高、最大。Agent 运行、压缩或等待扩展输入时不能切换。

“自动”是页面侧选项，不会向 Pi SDK 发送 `auto`；它保留远程 Session 当前默认值。切换只影响当前 Session，不会修改项目或全局 Pi 配置。远程 Client 仍会校验模型认证、模型可用性和项目空闲状态。
```

- [ ] **Step 2: Run all package tests and builds**

Run:

```bash
pnpm --filter @vcpdeck/shared test
pnpm --filter @vcpdeck/client test
pnpm --filter @vcpdeck/server test
pnpm --filter @vcpdeck/sdk test
pnpm --filter @vcpdeck/frontend test
pnpm build
pnpm test
```

Expected: all package tests, full build, and existing e2e pass. Existing Vite/Radix `use client` warnings may remain; no new errors are acceptable.

- [ ] **Step 3: Run diagnostics and scope checks**

Run:

```bash
pnpm --filter @vcpdeck/shared build
pnpm --filter @vcpdeck/client build
pnpm --filter @vcpdeck/server build
pnpm --filter @vcpdeck/sdk build
pnpm --filter @vcpdeck/frontend build
git diff --check
node .gitnexus/run.cjs detect-changes --scope unstaged
```

Run `lens_diagnostics(mode="all")` on all edited source/test files and fix every new blocker. Revert only formatter-only rewrites outside the feature files.

- [ ] **Step 4: Review the final diff**

Confirm the final diff contains only:

```text
packages/shared/src/pi.ts
packages/shared/src/index.ts
packages/shared/src/pi.test.ts
packages/server/src/pi/pi.controller.ts
packages/server/src/pi/pi.controller.test.ts
packages/client/src/pi/agent-session.ts
packages/client/src/pi/agent-session.test.ts
packages/sdk/src/pi.ts
packages/sdk/src/pi.test.ts
packages/frontend/src/pi/use-pi-session.ts
packages/frontend/src/pi/use-pi-session.test.tsx
packages/frontend/src/pi/pi-run-details.tsx
packages/frontend/src/pi/pi-run-details.test.tsx
packages/frontend/src/pages/pi-panel.tsx
packages/frontend/src/pages/pi-panel.test.tsx
docs/remote-pi-tab.md
```

Keep `.gitmodules` and `examples/pi-web` untouched and uncommitted.

- [ ] **Step 5: Run final change detection**

Run:

```bash
gitnexus_detect_changes({ scope: "unstaged", repo: "VCPDeck" })
```

Confirm only the model/thinking feature flows are affected and risk is low or explicitly reviewed.

- [ ] **Step 6: Commit**

```bash
git add docs/remote-pi-tab.md packages/shared/src/pi.ts packages/shared/src/index.ts packages/shared/src/pi.test.ts packages/server/src/pi/pi.controller.ts packages/server/src/pi/pi.controller.test.ts packages/client/src/pi/agent-session.ts packages/client/src/pi/agent-session.test.ts packages/sdk/src/pi.ts packages/sdk/src/pi.test.ts packages/frontend/src/pi/use-pi-session.ts packages/frontend/src/pi/use-pi-session.test.tsx packages/frontend/src/pi/pi-run-details.tsx packages/frontend/src/pi/pi-run-details.test.tsx packages/frontend/src/pages/pi-panel.tsx packages/frontend/src/pages/pi-panel.test.tsx
git commit --only -m "feat(pi): 支持模型与思考深度切换"
```

---

## Plan self-review

- **Spec coverage:** Right-panel placement, provider/model display, eight frontend choices, `auto` no-op semantics, seven-value Shared/Client state, idle-only behavior, session-only scope, error recovery, privacy, tests, docs, and final verification are covered by Tasks 1–6.
- **No placeholders:** No TODO/TBD/“implement later” steps remain; all implementation steps name files, functions, values, test commands, and expected outcomes.
- **Type consistency:** `PiThinkingLevel` is defined in Task 1, consumed by Client/Server/SDK in Tasks 2–3, and wrapped only by Frontend `PiThinkingSelection` in Tasks 4–5. `PiModelInfo` is defined in Task 1 and used by SDK/Hook/UI.
- **Scope boundary:** No new endpoint, persistence layer, model metadata service, dependency, or global configuration is introduced.
- **Repository hygiene:** Existing unrelated formatter changes and user-staged `.gitmodules`/`examples/pi-web` are explicitly excluded from feature commits.
