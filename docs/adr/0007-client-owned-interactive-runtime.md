# ADR-0007：远程交互运行态驻留 Client，Server 最小持久化

- 状态：Accepted
- 日期：2026-08-15（补录既有决策）
- 决策者：项目维护者
- 关联：[`docs/design/remote-terminal.md`](../design/remote-terminal.md)、[`docs/design/remote-pi.md`](../design/remote-pi.md)、[`docs/security.md`](../security.md)

## 背景

Terminal 和远程 Pi 都是长生命周期、可重新附着的交互资源。真实 PTY、目标文件系统、Pi Worker 和 Session JSONL 位于目标机器；Server 无法仅凭数据库状态重建这些资源。终端输入输出、Pi prompt、thinking、工具结果和路径还可能包含密码、Token、源码与其他高敏感数据。

若 Server 镜像完整正文，会建立第二事实来源，增加容量、脱敏、授权、保留和泄露风险；若只使用 Server 内存，又无法在 Server 重启或浏览器刷新后正确恢复。因此必须明确各层的数据权威和最小持久化边界。

## 决策

### 共同原则

1. 真实交互运行资源驻留在 Client；Client 是活跃资源和当前运行状态的权威。
2. Server 保存身份、所有权、生命周期、可恢复控制元数据和最小审计，不默认镜像交互正文。
3. Frontend 是可刷新、可重新附着的界面，不是远程资源的事实来源。
4. 浏览器刷新或临时断线不得隐式创建新的 PTY 或 Pi Session。
5. Server 重启后必须通过 REST 持久化元数据和 Client 权威状态恢复，而不能根据旧内存事件推断资源仍存在。
6. Client Socket 短暂重连与 Client 进程重启必须区别处理：前者可对账恢复，后者可能意味着真实运行资源已经消失。

### Terminal

1. Client `TerminalManager` 管理真实 PTY、输出序号、scrollback 和 headless snapshot。
2. Server 保存 TerminalSession 元数据、attachment/operator lease 和 TerminalAuditEvent 生命周期审计。
3. 首个有效 attachment 获得 operator，其他 attachment 作为 viewer；控制权由 Server 协调。
4. Server 不持久化终端输入、输出正文、snapshot 或 reconnect token。
5. Client 进程重启后，未被权威状态上报的旧会话收敛为 `interrupted`，不得伪装恢复。

### Pi

1. Client 持有实际 Pi Worker、Pi Session 和远程 Session JSONL。
2. 远程 Session JSONL 是 Pi 对话正文的事实来源。
3. Server 保存 Session Owner、生命周期、当前 Run 身份和安全元数据，不保存 prompt、回复、thinking、真实 cwd 或 Extension 输入正文。
4. SSE 只投影实时事件。断线后，Frontend 必须重新读取 Session/context 和 Agent 权威状态，不能依赖事件补传恢复完整事实。

## 候选方案

### Server 镜像完整 Terminal/Pi 正文

可提供统一回放和检索，但会复制高敏感数据，建立第二事实来源，并显著增加容量、授权、脱敏和保留责任，因此当前不采用。

### Browser 直接持有运行资源

减少 Server 中转，但浏览器刷新即丢失状态，也会绕过中心认证和控制权协调，因此不采用。

### 所有交互资源只保存在 Server 内存

实现简单，但 Server 重启后无法恢复元数据和审计，也无法区分真实资源是否仍在 Client，因此不采用。

### 将 Terminal 和 Pi 都建模为普通 Job

可以复用部分状态字段，但无法正确表达多次 attach、持续会话、交互输入和正文事实来源，因此仅复用必要的 Job 元数据，不共享普通调度语义。

## 后果

### 正面

- 真实运行资源与目标机器保持一致；
- Server 数据库不默认积累终端和 Agent 高敏感正文；
- Browser 和 Server 可以重启并重新附着；
- 数据权威明确，故障恢复可通过对账而不是猜测完成。

### 负面

- Client 进程故障可能导致不可恢复的 PTY 或活动 Pi Run；
- Server 无法仅靠数据库提供完整正文回放或全文检索；
- 需要 generation、snapshot、序号、lease 和状态对账等额外协议；
- 实时事件不保证永久保存，调用方必须主动重新读取权威状态。

### 安全与运维影响

- Client 运行账户决定 PTY、文件和 Pi 工具的真实权限，它们不是沙箱；
- Terminal/Pi 正文不得进入普通日志、错误、遥测或默认数据库字段；
- 远程 Pi Session 如需业务备份，必须在目标机器侧单独备份；
- 运维处理 Client 重启时，应将无法上报的活动资源视为中断，而不是继续显示为运行。

## 验证与退出条件

通过浏览器刷新重新 attach、Server 重启恢复、Client Socket 重连、Client 进程重启、Terminal snapshot/慢消费者、Pi SSE 丢失后重新同步，以及日志/数据库无正文测试验证。

需要服务端永久保存正文、跨 Client 迁移活跃会话、全文检索、合规录屏或独立会话存储服务时，应创建新 ADR，明确加密、授权、保留、删除和迁移策略。
