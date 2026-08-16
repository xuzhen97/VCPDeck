# ADR-0004：Typed Job 作为可持久化远程操作内核

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：`docs/domain-model.md`、`docs/protocols.md`、`docs/design/remote-execution.md`、`docs/design/remote-files.md`

## 背景

VCPDeck 需要在不稳定的 Server–Client 长连接上执行命令、文件和 FRP 等远程操作。操作可能经历排队、派发、运行、取消、断线和重连，且需要由 Server 查询、审计和恢复。若各功能直接发送临时 Socket.IO 消息并自行维护状态，会形成多套任务协议，无法可靠判断网络超时后远端是否已经执行，也难以统一能力校验和错误处理。

同时，终端和交互式 Pi Session 是持续存在、可重新附着的远程资源，不完全符合普通一次性任务的生命周期，不能为了形式统一而强行套用相同调度语义。

## 决策

1. 需要持久化、调度、取消、恢复或审计的异步远程操作，原则上使用 Typed Job 表达。
2. Job 必须先由 Server 持久化，再尝试派发给目标 Client。
3. Job `type` 与 `payload` 使用 `@vcpdeck/shared` 定义的判别联合；Server 和 Client 都必须校验类型、输入、超时和 capability。
4. Server 是 Job 生命周期、调度和审计状态的权威；Client 负责实际执行并上报过程和结果。
5. 普通 Job 使用统一状态机。Client 断线时，活动 Job 进入 `disconnected`，而不是直接判定失败；重连后根据 Client 状态报告对账。
6. `done`、`error` 和 `cancelled` 是普通 Job 的终态，迟到事件不得覆盖已经收敛的终态。
7. 当前不引入 Redis、BullMQ 等外部消息队列作为 Job 的第二事实来源。
8. Terminal 使用专门的会话模型，不作为普通 Job 调度。
9. Pi Session 复用 `agent.session` Job 保存所有权、生命周期和最小审计，但使用专门状态机，不占普通 Job 调度槽。
10. 新增 Job 类型必须同步修改 Shared 类型与解析器、Server capability/调度、Client dispatcher、SDK 和测试。

## 候选方案

### 直接通过 Socket.IO 发送远程命令

实现简单，但网络超时后无法判断是否执行，Server 重启后没有状态，取消、重试和审计也会由各功能重复实现，因此不采用。

### 为每项能力建立独立任务表和状态机

可以针对局部需求优化，但会造成类型、错误、分页、取消和重连规则分裂。只有 Terminal、Pi 等生命周期确实不同的资源才保留专门模型。

### 引入外部消息队列

可提供更强的分布式消费能力，但当前是单 Server、少量 Client 的个人控制面，引入额外基础设施不能消除 Client 断线后的远程进程对账问题，因此当前不采用。

## 后果

### 正面

- 远程操作具备统一、可查询的生命周期；
- 创建、派发、取消和重连语义可以复用；
- capability、错误和敏感数据边界集中治理；
- Server 重启或 Client 短暂断线后仍可根据持久化状态恢复。

### 负面

- Job 状态机和迟到事件处理增加实现复杂度；
- `disconnected` 不是终态，调用方必须避免把它展示为确定失败；
- 实时 stdout/stderr 在断线期间不保证补传，Job 不能代替完整日志系统；
- 专门会话模型与通用 Job 并存，需要清晰区分调度和审计职责。

### 安全与运维影响

- Job 错误只保存稳定 `code` 和安全 `message`，不得保存 stack、密钥或非协议所需的文件正文；
- 命令、路径、环境变量和 payload 可能敏感；当前 `file.writeText` 正文属于 Job payload，`file.readText` 正文属于 Job result，列表、日志、备份和保留策略必须据实按敏感数据处理；
- 运维判断任务结果时应查询 Job 和 Client 对账状态，不能只根据一次 Socket 或 HTTP 超时下结论。

## 验证与退出条件

通过创建后派发、取消、Client 断线继续执行、重连对账、迟到终态事件、Server drain 和 capability 拒绝测试验证。

出现多 Server 分布式调度、显著并发规模、工作流编排需求，或新业务无法用现有 Job/专门会话模型正确表达时，应创建新 ADR 评估消息队列、租约和编排模型。
