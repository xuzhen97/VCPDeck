# Task 6 实施报告

## Status
未完成（实现与构建通过，但指定 Server 集成测试仍有 3 个失败，且 delete/fork/clone 的完整 reservation/补偿编排尚未完成）。

## 实现
- 新增 Session Job open/complete REST 与 SDK 方法。
- Prompt 改用稳定 session jobId + 独立 runId；控制请求改用 runId。
- SDK state 响应经 parsePiAgentState 严格校验。
- Scheduler 普通任务并发与 pending 查询排除 agent.run/agent.session。
- 删除 PiRunService legacy createRun/settle/fail/cancel/assertOwner、单参数 transition overload、markDisconnected/reconcileState。
- 新建 Session 建立同 ID agent.session，ensureSession 失败重试一次并 best-effort 补偿删除。
- requirePiClient 严格要求 sessionJobProtocolVersion=1。

## 验证
- Server 指定测试：失败（pi-flow.integration.test.ts 3 failures；其余 65 passed）。原因是该旧 loopback fixture 的 listOnline 未上报协议版本，严格版本门禁按批准计划返回 PI_CLIENT_UNSUPPORTED；该文件不在允许修改列表，未修改。
- SDK 全量测试：通过（25 passed）。
- Server build：通过。
- SDK build：通过。
- git diff --check：通过（仅 CRLF 警告）。
- GitNexus detect_changes：执行，risk critical（批准迁移范围）；详见 task-6-impact.log 与 /tmp/task6-detect.log。

## Concerns
- delete 尚未切换 beginDelete/commitDelete/rollbackDelete reservation 编排。
- fork/clone 尚未完成 ensureSession 重试与补偿、fixed Owner 全覆盖。
- complete/prompt 的全部 settlement/new-prompt 竞态矩阵未完整测试。
- 因此本提交是可构建的中间状态，不应视为 Task 6 验收完成。

## 续跑完成（c4d2e9b 之后）

### Status
完成。

### 实现
- pi-flow loopback fixture 补充 `sessionJobProtocolVersion: 1`，并稳定异步 flush。
- delete 改为 `beginDelete` reservation → lease 定向幂等删除 → 成功/不存在 commit；明确 Client 拒绝 rollback；timeout/disconnect 保留 reservation；未取得 reservation 不请求 Client。
- fork/clone 加 fixed Owner 校验，创建后复用 `ensureCreatedSession`：ensure 重试一次，仍失败同 lease best-effort delete 并抛原错误。
- rename/navigate/model/thinking 补齐 fixed Owner 校验。
- Prompt dispatch 后重新 snapshot；complete/cancelled 抢先时 best-effort 对同 runId abort 并返回稳定冲突，覆盖 success/error/timeout/disconnect。
- complete 延迟 abort 后 CAS 失败重新 snapshot，不触碰新 run。

### 验证
- 指定 Server 测试：5 files / 80 tests passed。
- Server 全量：19 files / 178 tests passed，0 failed。
- SDK 全量：5 files / 25 tests passed。
- Server build、SDK build：通过。
- legacy rg：PiRunService 旧 adapter 与单参数 transition overload 零匹配；仅普通 JobService 的 cancel/markDisconnected 生产调用保留（不属于 PiRunService adapter）。
- git diff --check：通过。
- GitNexus detect_changes：critical（已授权 Pi Controller 编排范围），46 flows。
