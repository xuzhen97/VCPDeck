# ADR-0008：Pi Session 使用稳定 Session Job 与独立 Run 身份

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：[`docs/design/remote-pi.md`](../design/remote-pi.md)、[`docs/domain-model.md`](../domain-model.md)、[`docs/protocols.md`](../protocols.md)

## 背景

早期远程 Pi 将每次 Prompt 建模为一条 `agent.run` Job，并令 Job 与 Run 使用同一标识。这会把持续存在的 Session 拆成多个孤立任务，难以表达“本轮回答结束但 Session 仍可继续”、人工标记完成、Extension 等待输入、重连恢复和旧事件隔离。

Pi 的事件和状态跨越 Browser、Server、Client Worker 与远程 Session JSONL。网络延迟、settlement timer、abort、Client 重连和连续 Prompt 可能并发发生。如果只按 Session ID 更新状态，旧 Prompt 的迟到事件可能覆盖新 Prompt；如果先读取再无条件写入，也可能在 complete、abort 和 settlement 之间产生竞态。

## 决策

1. 每个 Pi Session 唯一对应一条 `type=agent.session` 的 Job，且 `jobId === sessionId`。
2. Session Job 表示整个 Pi Session 的所有权、生命周期和最小审计，不再为每次 Prompt 创建独立 `agent.run` Job。
3. 每次 Prompt 生成新的 UUID `runId`。`runId` 标识一次 Prompt/回答执行，并用于事件、控制请求、settlement timer、项目锁和并发状态转换。
4. 一轮回答权威结算后，Session Job 回到 `idle`，不自动进入 `done`。
5. `done` 表示 Owner 人工认为 Session 工作已完成；后续 Prompt 可以重新激活同一 Session Job并生成新 `runId`。
6. 固定 Owner 控制 Session 和当前 Run。其他身份不能发送 Prompt、abort、Extension response、complete 或删除。
7. 同一 Client 的同一 `projectKey` 同时只允许一个活跃 Run；项目锁必须绑定 `jobId + runId`。
8. 活动 Run 的状态转换必须使用包含当前 `runId` 和允许源状态的条件更新/CAS。禁止旧 Run 的事件、计时器或锁操作影响新 Run。
9. abort、complete、Extension response、settlement 和重连终态确认必须校验当前 `jobId + runId`。
10. `waiting_input` 表示当前 Run 正等待受支持的 Extension UI 输入；输入正文不持久化。
11. Client 每次新 Socket 连接代次注册后必须重新上报 Pi 权威状态。Server 完成数据库对账和项目锁重建前，不接受需要向 Client 发请求的 Pi 操作。
12. Client 权威报告中不存在数据库记录的活动 Run 时，Server 必须收敛为安全状态，不能继续假装该 Run 存活。
13. Pi Session Job 协议版本必须精确匹配；不匹配时明确拒绝 Pi 功能。

## 候选方案

### 每次 Prompt 一条 `agent.run` Job

可直接复用普通任务列表，但无法自然表示持续 Session、人工完成和多轮上下文，并使一个 Session 的所有权和状态分散，因此被当前模型取代。

### `runId` 始终等于 `jobId`

标识更少，但无法区分同一 Session 的连续 Prompt，也不能阻止旧事件覆盖新 Run，因此不采用。

### 新增独立 PiSession/PiRun 数据表

模型最显式，但当前 Job 已能承载 Session 所有权和安全生命周期元数据；增加新表会扩大迁移和查询面。若未来支持并行 Run、多人协作或独立运行历史，再重新评估。

### 仅使用内存锁和事件顺序

实现较轻，但 Server 重启、网络重排和并发回调会丢失保护，因此活动转换仍必须落到数据库 CAS 和 Client 权威对账。

## 后果

### 正面

- Session、Job 和 Run 的身份职责清晰；
- 多轮 Prompt 共享稳定生命周期和 Owner；
- 迟到事件、旧 timer 和旧 Socket 无法合法覆盖当前 Run；
- 人工完成与模型本轮回答结束不再混为一谈；
- 重连可以按精确 Run 身份对账。

### 负面

- `agent.session` 的 `done` 与普通 Job 终态语义不同，调用方必须按类型解释；
- CAS、连接 generation、项目锁和 settlement 增加实现复杂度；
- Job payload 只能保存当前 `runId` 等安全元数据，不能作为完整 Run 历史；
- 当前模型不支持同一 Session 多个并行 Run。

### 安全与隐私影响

- Server 和 Job 不保存 prompt、回复、thinking、真实路径、图片正文或 Extension 输入；
- `projectKey` 只用于同 Client 项目互斥，不向 Browser 暴露真实 canonical cwd；
- Pi 工具继承 Client 运行账户权限，Project Trust 不是容器沙箱；
- 所有 Client Pi 状态和事件仍属于不可信协议输入，必须严格解析。

## 验证与退出条件

至少验证：`jobId === sessionId`、连续 Prompt 使用不同 `runId`、旧事件/旧 timer 不影响新 Run、settlement 回到 `idle`、人工 complete 与重新激活、Extension `waiting_input`、abort、Socket 重连对账、Client 进程重启、项目锁冲突和协议版本拒绝。

需要同一 Session 并行 Run、Owner 转移、多人协作、独立持久化 Run 历史，或不再复用 Job 时，应创建新 ADR 替代本决策并提供数据迁移方案。
