# Job 日志与事件链

> 状态：Current｜维护责任：Server/Client 维护者｜最后核验：2026-10-18｜适用版本：`0.20.1` / 当前 `main`
>
> 长期决策见 [ADR-0054](../adr/0054-job-log-event-chain.md)；代码与 Shared、Prisma schema 是运行事实的最终权威。

## 1. 问题与非目标

Job 此前只有终态行、`Job.result` 和一份无序 raw spool（`data/job-outputs/<jobId>.log`）。派发时刻、Client 是否收到、进程是否真的起来、exit 与结算的时间差、超时/取消/断线/对账/孤儿收敛都没有落点——2026-10-10 那次"进程早退了但管道没关，Job 卡 running 17 小时"只能靠读代码推断。

本专题解决"**按 jobId 还原一条可查询的链路**"。非目标：

- 不做 stdout/stderr 大小限制、截断、轮转或 `Job.result` 瘦身（属于 roadmap 第 43 条）；
- 不做跨 Job 的日志检索、聚合分析或独立日志设施；
- 不清理 Job 行，也不改变 Job 状态机语义；
- Job 之外的 Server/Client `console.*` 仍是普通日志（roadmap 第 13 条）。

## 2. 架构与数据

`JobLogEvent`（SQLite/Prisma，随控制面备份）：

- `seq` = 自增主键，同时是 REST 增量游标；
- 字段：`jobId`、`at`、`source`(`server|client`)、`event`、`level`、`code`、`message`、`data`(JSON)；
- 索引：`(jobId, id)`、`(at)`、`(level, at)`。

写入点是 `JobLogService.record()`，一次调用**双写**：

1. stdout 单行 JSONL（`scope:"job"`、`jobId`、`event`、`source`…）；
2. `JobLogEvent` 行。

因此 `grep '"jobId":"<id>"'`（运行日志）与 `vcpdeck jobs logs <jobId>`（事件链）不会漂移。写入 best-effort：数据库失败只补一条 stdout 警告，绝不阻断 Job。

输出落盘按 Job 串行化，`JOB_DONE` 结算前会 flush 该 Job 的在途输出队列：因此链上 `output_first` 一定早于 `settled`，`settled.spoolBytes` 反映结算时刻的真实落盘量（快速 Job 不会因为竞态得到 0）。

保留策略：每 Job 上限 200 条（超出时优先裁剪最旧的非 error 事件，错误取证最后才动）；全局 30 天 TTL，`JobLogService` 每 6 小时清理一次（timer `unref`）。Job 行本身当前不删除，事件独立清理。

## 3. 协议

- Client → Server：`job:log`，载荷 `{ jobId, event, level?, code?, message?, data?, clientAt? }`；
- REST：`GET /api/jobs/:jobId/logs?since&limit&level` → `{ jobId, events[], nextSeq }`；
- SDK：`jobs.logs(jobId, { since, limit, level }, signal)`；
- CLI：`vcpdeck jobs logs <jobId> [--since] [--limit] [--level] [--json]`；
- Frontend：Job 详情页「日志事件」只读时间线。

## 4. 事件与采集点

| source | event | 采集点 |
| --- | --- | --- |
| server | `created` | `JobService.create` / `createUploadSession`（含操作者、类型、模式、超时、请求 id） |
| server | `dispatched` | `JobScheduler.tryDispatch`（排队时长、并发数） |
| server | `output_first` | `ClientGateway.handleJobStdout/Stderr` 首块（内存去重） |
| server | `cancel_requested` | `JobService.cancel`（此前被丢弃的 actor 进审计） |
| server | `cancel_confirmed` | 待派发分支由 `JobService.cancel` 直接结算（`data.by="server"`）；运行中由 `JobService.markCancelled` 在 Client 确认后写入 |
| server | `cancel_failed` | `ClientGateway.handleJobCancelFailed` |
| server | `client_offline` | `JobService.markDisconnected`（逐 Job） |
| server | `reconciled` | `JobService.reconcileOnReconnect` |
| server | `orphaned` | `JobService.failOrphaned` |
| server | `settled` | `JobService.markDone`（状态、耗时、exitCode、输出字节、spool 字节） |
| client | `received` / `spawned` / `exited` / `local_settled` / `cancel_received` / `kill_failed` / `drain_timeout` | `packages/client/src/executor.ts` |

`local_settled` 与 `settled` 刻意分开：前者证明 Client 已结算，后者证明 Server 收到了。两者只有一条时，问题出在传输或网关，而不是执行本身。

## 5. 失败路径与已知偏移

- **卡住无输出**：链上可见 `dispatched` 但无 `output_first`；若 Client 是新版本且也无 `spawned`，说明进程没起来。
- **进程已退但 Job 未结算**（10-10 事故）：可见 `exited`/`local_settled` 而后端只有 `dispatched`，或 `drain_timeout` 出现。
- **取消未生效**：`cancel_requested` 后无 `cancel_confirmed`，并可能以 `cancel_failed` + `orphaned` 收敛。
- **断线**：`client_offline` 之后若无 `reconciled`，Job 停在 `disconnected`（非终态）。
- **首块去重依赖进程内存**：Server 重启后可能重复记一条 `output_first`（内容相同，可接受）。
- **灰度期**：旧 Client 不上报相位，链只有 Server 事件；不能把"没有 `spawned`"直接判成"进程没起来"。
- **`frp.reconcile`**：由恢复编排直接建行并结算，事件链从 `dispatched` 起，终态以 Job 行为准。

## 6. 安全、隐私与运维

- 事件不复述命令/脚本、env、完整路径、stdout/stderr 正文与凭据；正文仍在 `Job.result` 与 spool；
- `message` ≤200 字符；`data` ≤8 键、值仅字符串/数字/布尔、序列化 ≤1 KB；超限在 Shared parser 处拒绝；
- `job:log` 必须通过 `job.clientId === socket clientId` 归属校验，否则静默丢弃；每 Job ≤8 条、每 Client ≤30 条/分钟；
- 取消者与取消结果进入持久化审计，回答"谁取消的、取消有没有生效"；
- 排错口径：`jobs list --status=error` → `jobs get <jobId>` → `jobs logs <jobId>`；需要正文再用 `jobs get`（输出 spool）。

## 7. 兼容、迁移与回滚

- 新增表属增量 schema 变更：`prisma db push` 可直接同步，不触发数据丢失保护；仓库仍保留 `20261017000000_job_log_events` 迁移供生产审查；
- 新增 socket 事件**不提升协议版本**：旧 Client 不发；新 Client 对旧 Server 发送会被静默忽略；
- 回滚到不含本能力的 Server 时，`JobLogEvent` 表成为未使用表（不删数据，不影响启动）；事件表只增不损，回退后重新升级可继续读取。

## 8. 测试与验收

- Shared：`packages/shared/src/job-log.test.ts`（枚举封闭、未知字段/事件拒绝、长度与 data 限制）；
- Server：`job-log.service.test.ts`（双写、失败降级、游标、cap 裁剪、TTL、限流）、`client.gateway.test.ts`（归属校验、限流、首块去重、cancel_failed）、`events.controller.test.ts`（分页/游标/非法参数/404）、`job.service.test.ts` / `job.scheduler.test.ts`（采集点）；
- Client：`job-log.test.ts`、`executor.test.ts`（相位顺序、超时/取消/排空路径）；
- SDK / CLI / Frontend：`logs` 调用、表格与 `--json`、时间线渲染；
- 验收：`grep '"jobId":"<id>"'` 能还原 create→dispatch→settled；旧 Client 场景链仍完整；伪造他机 `jobId` 不落行；单 Job ≤200 条；超过 30 天被清理。

## 9. 与 ADR、Current 文档的关系

- 决策与边界：[ADR-0054](../adr/0054-job-log-event-chain.md)；
- 实体与不变量：[`../domain-model.md`](../domain-model.md) §5.3；
- 协议：[`../protocols.md`](../protocols.md) §2.10、§3.4；
- 运维与脱敏：[`../operations.md`](../operations.md) §1、§4；
- 执行与输出边界：[`remote-execution.md`](./remote-execution.md)；
- CLI 能力说明：[`../../skills/vcpdeck/SKILL.md`](../../skills/vcpdeck/SKILL.md)。
