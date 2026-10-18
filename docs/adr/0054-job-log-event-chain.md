# ADR-0054：Job 日志采用可持久化事件链，jobId 作为全链路关联键

- 状态：Accepted
- 日期：2026-10-17
- 决策者：项目维护者
- 关联：[ADR-0002](./0002-sqlite-prisma-control-plane.md)、[ADR-0004](./0004-typed-job-kernel.md)、[ADR-0005](./0005-shared-contracts-and-communication-channels.md)、[ADR-0009](./0009-trusted-operator-security-domain.md)、[`domain-model.md`](../domain-model.md)、[`protocols.md`](../protocols.md)、[`operations.md`](../operations.md)、[`roadmap.md`](../roadmap.md)

## 背景

Job 是远程操作的统一调度与审计信封，但此前只有**终态行 + `result` + 一份无序 raw spool**（`data/job-outputs/<jobId>.log`）。整条生命周期中最需要取证的时刻没有落点：

- 派发时刻与排队时长；
- Client 是否收到、进程是否真的 spawn、进程 exit 与 Job 结算之间的时间差；
- 超时、取消（`cancel()` 的操作者长期被 `_actor` 丢弃）、断线、重连对账、孤儿收敛。

2026-10-10 生产事故（两条 exec Job 卡在 running 17 小时、阻塞整次发布）就是典型：进程早已退出，但"子进程持有管道 → 只等 `close` → 永不结算"这一事实在现有数据里完全不可见，只能靠改代码前的经验推断。Server 日志同时是裸 `console.*`，没有任何一条带 jobId，[`operations.md`](../operations.md) §1 自己也承认"没有统一结构化日志"。

项目内已有可对齐的正面范本：`TerminalAuditEvent` + `GET /api/terminal/:sessionId/audit`（按会话分页的最小审计）。此外 roadmap 已列出「结构化脱敏日志」（第 13 条）与「Job 输出的受控持久化」（第 43 条）两个相邻方向。

约束：

- 少量可信操作者单信任域（ADR-0009），但命令、脚本、stdout/stderr 正文、环境变量与路径仍按敏感数据处理，日志与事件不得复述正文；
- Server 是唯一控制面，诊断数据必须能通过 REST/CLI 取到，不能要求 agent 登录目标机或翻多台机器的日志文件；
- 不得为观测引入新的运行组件或第三方日志设施。

## 决策

1. **Job 事件链持久化在控制面库**：新增 `JobLogEvent` 表（SQLite/Prisma，随控制面一起备份），每 Job 一条有序事件流。
   - `seq` = 自增主键，同时是对外的增量拉取游标；
   - 时间权威是**Server 接收时刻**，Client 上报的 `clientAt` 只进 `data` 用于计算本地耗时；
   - 每 Job 上限 200 条，超出时优先裁剪最旧的**非 error** 事件（错误取证不被普通日志挤掉）；
   - 全局 30 天 TTL 由 Server 定时清理；Job 行本身当前不删除，事件独立清理；
   - 写入 **best-effort**：落库失败只写 stdout，绝不阻断 Job 执行。

2. **新增 `job:log` socket 事件（Client → Server），只承载生命周期相位**。
   - 载荷为封闭枚举的 7 个相位（`received`/`spawned`/`exited`/`local_settled`/`cancel_received`/`kill_failed`/`drain_timeout`），**不承载 stdout/stderr 文本**；
   - Server 必须校验 `job.clientId === socket 绑定的 clientId`，做字段白名单与长度上限，并施加「每 Job ≤8 条、每 Client ≤30 条/分钟」限流；
   - **不提升协议版本**：旧 Client 不报相位时链仍完整（缺少 Client 内部几格）；新 Client 对旧 Server 发送 `job:log` 会被 socket.io 静默忽略，无副作用。

3. **Job 相关运行日志统一为带 jobId 的 JSONL 单行，并与事件行出自同一调用点**。
   - `recordJobLog()` 一次调用**双写** stdout 与 `JobLogEvent`，使"人可 grep 的运行日志"与"机器可查的事件链"不会漂移；
   - 事件与日志**不复述**命令/脚本正文、env、完整路径、stdout/stderr 正文、凭据（沿用 [`operations.md`](../operations.md) §4 的既有清单）；
   - 本次只统一 Job 相关日志，其余裸 `console.*` 留给 roadmap 第 13 条整体改造。

4. **读取面固定为 Job 维度，并明确不做的事**。
   - `GET /api/jobs/:jobId/logs?since&limit&level` + SDK + `vcpdeck jobs logs`；
   - 不做跨 Job 日志检索接口（需要时以新 ADR 另议）；
   - 不治理输出体积（`spool` 上限、`result` 瘦身、轮转、脱敏属于 roadmap 第 43 条，另行决策）；
   - 不新增 Job 行清理策略。

## 候选方案

- **只写 Server stdout 结构化 JSONL，不落库**：最轻、零迁移；但诊断数据跨机器、按 Job 取列表需要读服务器日志文件，agent 侧拿不到稳定接口，无法满足"agent 自己查看 Job 日志列表找缺陷"，不采用。
- **每 Job 一个 JSONL 文件（与 stdout spool 同目录）**：零 schema 变更、可直接 `tail`/`grep`；但跨 Job 与按 level/时间过滤要遍历目录，REST 只能流式读单文件，且与现有 spool 的语义边界容易混淆，不采用。
- **不新增事件，只在 `JOB_DONE` 里附 diagnostics**：开销最小；但只对已结束的 Job 有效，**卡住/丢终态的 Job 恰好拿不到任何证据**——而那正是最需要证据的场景，不采用。
- **把 stdout/stderr 一并写进事件表**：单表可查全部现场；但会把正文引入诊断面，违反脱敏边界并放大 agent 读取成本，不采用（正文继续留在 spool 与 `result` 的既有路径）。

## 后果

正面：

- 一次 `vcpdeck jobs logs <jobId>` 即可看到"创建 → 派发 → Client 收到 → 进程起灭 → 结算"的完整链路，`grep '"jobId":"<id>"'` 可在服务器日志里捞出同一条链；
- 卡死、丢终态、取消未生效、断线对账这类缺陷第一次具备结构化证据；取消者与取消结果进入持久化审计；
- 诊断数据随 SQLite 备份一起走，不需要新的日志采集组件；
- 与 `TerminalAuditEvent` 形态一致，读取面（分页/过滤/CLI）共用同一套习惯。

负面与风险：

- 控制面库新增一张持续增长的表，只能靠 200 条/Job 与 30 天 TTL 兜底；若 Job 量级显著上升，需要重新评估保留策略；
- 每个 Job 最多写约 17 行事件（Server 10 + Client 7），写入量与 Job 量同阶，但相比 stdout 转发可忽略；
- 事件与 spool/`result` 存在语义重叠，必须在文档中写清"事件不含正文"，否则后来者容易把正文塞进 `data`；
- `output_first` 的首块去重依赖进程内存，Server 重启后可能重复记录一条（内容相同，可接受）；
- 灰度期（旧 Client 未升级）链路缺少 Client 相位，排错时需先确认 Client 版本，不能把"没有 `spawned`"误判为"进程没起来"。

## 验证与退出条件

实施验证：

- `grep '"jobId":"<id>"'` 能在 Server 日志中还原 create→dispatch→settled 链路；
- `vcpdeck jobs logs <jobId>` 按 `seq` 升序呈现；新 Client 可见 `received/spawned/exited/local_settled`；
- 旧 Client 场景链仍完整（仅 Server 侧事件），不产生错误或告警；
- 伪造他机 `jobId` 的 `job:log` 不产生任何行；非法载荷被丢弃且不影响连接；
- 单 Job 事件行数不超过 200；超过 30 天的事件被清理；
- `pnpm -r test`、`pnpm --filter @vcpdeck/server build`、`pnpm lint`、`git diff --check` 通过。

重新评估条件：

- 若需要跨 Job 检索、长周期保留或对事件做聚合分析（而非逐 Job 取证），应新写 ADR 评估独立日志设施或全文索引，而不是在 `JobLogEvent` 上继续加列；
- 若 roadmap 第 43 条（输出受控持久化）落地并改变"事件不含正文"的边界，需新 ADR 修正本决策第 3 条；
- 若 Job 量级增长到"事件写库"成为控制面瓶颈，应改为批量异步写入或降级为仅保留 error 事件，并按新 ADR 调整保留策略。
