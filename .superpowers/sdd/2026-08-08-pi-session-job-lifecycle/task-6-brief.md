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

## Fix round 1（Reviewer findings）

- [x] SDK `complete()` 无 runId 发送 `{}`，有 runId 发送 `{ runId }`。
- [x] 无 runId complete 支持 idle/error/done 原子完成。
- [x] control 与 idle mutation 公共入口统一执行 Pi Session Job 协议门禁。
- [x] run-scoped REST body 统一使用对象、非空与长度校验。
- [x] Prompt dispatch 不确定结果按同 lease 权威 state 对账；断线精确 CAS matching run。
- [x] Delete 仅对执行前拒绝直接 rollback；其他失败经同 lease `session.get` 确认。
- [x] 补齐 SDK、Controller、Service 与 loopback integration 回归测试。
