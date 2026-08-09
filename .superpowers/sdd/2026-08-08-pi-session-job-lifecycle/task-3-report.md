# Task 3 实施报告

## 状态

已实现 Client Session Job / Prompt Run 分离、Worker prompt pipeline cancellation、只读 `agent.state`、PI_STATE 每连接代次上报与受控重连。

## RED / GREEN

- RED：`supervisor.test.ts` 新增独立 runId、旧 run CAS、Extension resolved、PI_STATE closed abort 测试；初次 7/15 失败，缺少 `applyStateAck` 等目标行为。
- RED：`session-reader.test.ts` 新增只读 state 投影测试；初次 2/12 失败，`state` 尚不存在。
- RED：`agent-session.test.ts` 新增幂等 Project Trust 测试；类型检查确认方法缺失。
- GREEN：`pnpm --dir "packages/client" exec vitest run "src/pi"`：10 files / 106 tests 全通过。

## Build / checks

- `pnpm --dir "packages/client" build`：通过。
- `git diff --check`：通过。
- `gitnexus impact ... --repo VCPDeck --direction upstream`：索引来自 sibling repo 且落后 89 commits；目标多为 not found，风险 UNKNOWN，无 HIGH/CRITICAL。
- `gitnexus detect-changes --scope unstaged --repo VCPDeck`：旧索引报告 `No changes detected`，结果不可信但已记录。

## Changed files

- `packages/client/src/index.ts`
- `packages/client/src/pi/agent-session.ts`
- `packages/client/src/pi/agent-session.test.ts`
- `packages/client/src/pi/session-reader.ts`
- `packages/client/src/pi/session-reader.test.ts`
- `packages/client/src/pi/socket-bridge.test.ts`
- `packages/client/src/pi/supervisor.ts`
- `packages/client/src/pi/supervisor.test.ts`
- `packages/client/src/pi/worker.ts`

未修改 `.gitmodules` 或 `examples/pi-web`，未新增依赖或新抽象文件。

## 实现摘要

- Supervisor 用 `jobId + runId` matching CAS 处理活动 run，terminal cwd fallback 改为 runId key；PI_STATE ack 按 runId 清 terminal，closed active run 直接向 Worker 发权威 abort，失败保留。
- Worker 在任何 wrapper/trust/附件 await 前绑定 envelope 和 cancellable pipeline，并立即 accepted；每个 await 后检查 token/current run，失效 wrapper 会 shutdown；matching settled/error/abort 先清 active/pipeline。
- `agent.state` 无 runId 时由 SessionReader 读取 JSONL branch 的最近 model/thinking 并返回固定 idle；有 runId 仅 matching active run 读取 wrapper。
- Project Trust 先创建受限 wrapper，确认 true 持久化后 shutdown 并重建一次；确认流程幂等。
- Bridge 每 connect 递增 generation；REGISTER ack 每代发送 STATUS_REPORT + PI_STATE；closed abort 有界重试，耗尽后 `disconnect()` 并由 generation/connected guard timer 显式 `connect()`。

## Commit

SHA：`0452b98`。

## Residual risks

- GitNexus 索引陈旧，impact/detect 无法准确映射本 worktree 的新增符号。
- Worker cancellation 的最深 pending 时序主要由实现 guard 与现有真实子进程集成覆盖；本次未引入额外测试 seam 或依赖。

## Fix round 1

### 状态

已处理 reviewer round 1 的全部生产问题：abort 失败可重试、Supervisor 权威成功清 active、完整 envelope matching、wrapper event 绑定 run generation、安全错误投影、Project Trust rebuild 语义，以及 bridge 重试/受控重连 guards。

### TDD 记录

- RED：新增 `abort 首次失败仍取消 pending UI，第二次会重试底层 abort`，首次因 pending trust 未被取消而超时；将 UI cancellation 移至底层 abort 前后 GREEN。
- RED：新增 bridge `closed abort 首次失败后重试成功并再次报告 PI_STATE`，首次仅 2 次 PI_STATE；修正 retry 成功后的二次报告条件后 GREEN。
- Coverage GREEN：Supervisor matching abort 成功清 active 的 seam 已存在，本轮补充下一 Prompt 成功断言；Worker 真实子进程新增 trust pending abort 与 matching/mismatching state 覆盖。
- 新增 bridge retry exhausted、old generation timer、connected guard 回归测试。

### 修复摘要

- Worker 使用 `jobId + sessionId + runId + cancelToken` CAS；所有有 runId 控制请求要求完整 envelope matching。
- wrapper listener 在 prompt pipeline 内绑定所属 run，不再读取事件到达时的当前 active；terminal 只 CAS 清所属 run。
- abort 先取消 pipeline/UI，但仅在 wrapper abort 与 pipeline 收敛成功后清 active；失败保留 envelope，允许同一请求重试。
- Worker 错误 code 只接受 shared `PI_ERROR_CODES`，消息通过 `safePiErrorMessage` 输出固定安全文案；未知错误映射 `PI_RUNTIME_UNAVAILABLE`。
- `ensureProjectTrust()` 仅在本次新确认 trust=true 时返回 true；已有决定或无需 trust 不触发 rebuild。
- bridge 在 abort retry 成功后再次报告 PI_STATE；耗尽后 disconnect + generation/connected guarded explicit connect。
- 删除 `PiSupervisor.applyStateAck` 行尾空格。

### 验证

- `pnpm --dir "packages/client" exec vitest run "src/pi/agent-session.test.ts"`：24 tests GREEN（RED 修复后）。
- `pnpm --dir "packages/client" exec vitest run "src/pi/agent-session.test.ts" "src/pi/supervisor.test.ts" "src/pi/socket-bridge.test.ts"`：3 files / 50 tests GREEN。
- `pnpm --dir "packages/client" build && pnpm --dir "packages/client" exec vitest run "src/pi/pi-worker.integration.test.ts"`：build 通过；6 integration tests GREEN。
- GitNexus upstream impact：索引来自 sibling repo 且落后 90 commits，相关新增符号均 UNKNOWN/not found，无 HIGH/CRITICAL。

### Residual risks

- GitNexus 索引陈旧，impact/detect-changes 只能作为不完整证据；以 focused tests、全 Pi tests、TypeScript build 和 diff check 为准。
